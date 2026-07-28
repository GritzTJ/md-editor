/* ---------------------------------------------------------------------------
 * Exhaustive control coverage.
 *
 * browser.mjs checks that the promise of the project holds; this suite checks
 * something narrower and easier to let rot: that every single button does what
 * its label says. It exists because two of them did not -- "Tasks" produced a
 * plain bullet when text was selected, and "Outdent" pulled an item out of its
 * list instead of raising it one level -- and neither was covered.
 *
 * The File System Access API is removed before the page loads, so the download
 * fallbacks are exercised on every origin. Otherwise the file buttons would
 * open a native picker that a headless browser cannot drive, and coverage would
 * silently depend on whether the test ran against localhost or an IP address.
 *
 *   npm run dev &
 *   npm install --no-save puppeteer
 *   node test/buttons.mjs
 * ------------------------------------------------------------------------- */

import puppeteer from "puppeteer";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TARGET = process.env.TARGET || "http://localhost:8080/";
const DL = mkdtempSync(join(tmpdir(), "md-editor-buttons-"));

// 1x1 transparent PNG: a data: URI is the only image source the CSP allows, so
// it is also the only one that can be checked as actually displaying.
const DATA_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

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
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });

await page.evaluateOnNewDocument(() => {
  delete window.showOpenFilePicker;
  delete window.showSaveFilePicker;
});

const jsErrors = [];
const cspBlocks = [];
page.on("pageerror", (e) => jsErrors.push(String(e)));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const t = m.text();
  // Two browser messages that are not application faults: the CSP refusing a
  // remote image is the documented policy working, and COOP being ignored is
  // the documented consequence of an insecure origin.
  if (/Content Security Policy/i.test(t)) { cspBlocks.push(t); return; }
  if (/Cross-Origin-Opener-Policy/i.test(t)) return;
  jsErrors.push(t);
});

// Answers queued for prompt()/confirm(); undefined means dismiss.
let answers = [];
page.on("dialog", async (d) => {
  const a = answers.shift();
  if (a === undefined) await d.dismiss();
  else await d.accept(typeof a === "string" ? a : "");
});

const cdp = await page.createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL });

await page.goto(TARGET, { waitUntil: "networkidle0" });
await wait(800);

const btn = async (label) => {
  for (const e of await page.$$("button")) {
    if ((await e.evaluate((n) => n.textContent)) === label) return e;
  }
  throw new Error("button not found: " + label);
};
const click = async (label) => { (await btn(label)).click(); await wait(450); };
const src = () => page.$$eval(".cm-line", (ls) => ls.map((l) => l.textContent).join("\n"));
const waitForFile = async (name) => {
  for (let i = 0; i < 25 && !existsSync(join(DL, name)); i++) await wait(200);
  return existsSync(join(DL, name));
};

async function setSource(md) {
  await page.click(".cm-content");
  await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  if (md) await cdp.send("Input.insertText", { text: md });
  await wait(700);
}

async function selectAllRich() {
  await page.click("#rich .ProseMirror");
  await wait(250);
  await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
  await wait(150);
}

/* ========================= toolbar ========================= */
console.log("\n--- toolbar ---");

// No layout control exists: source and live preview are always side by side.
ok("split view by default",
  (await page.$eval(".pane-editor", (e) => getComputedStyle(e).display)) !== "none" &&
  (await page.$eval("#preview", (e) => getComputedStyle(e).display)) !== "none");

const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);
await click("Theme");
ok("Theme", (await page.evaluate(() => document.documentElement.dataset.theme)) !== themeBefore);
await click("Theme");

await click("?");
ok("?", (await page.$(".sheet")) !== null);
await click("Close");
ok("Close", (await page.$(".sheet")) === null);

await setSource("something to discard");
answers = ["confirm"];
await click("New");
ok("New", (await src()) === "", JSON.stringify(await src()));

const opened = join(DL, "opened.md");
writeFileSync(opened, "# Opened from disk\n\ncontent\n", "utf8");
await (await page.$('input[type="file"]')).uploadFile(opened);
await wait(700);
ok("Open", (await src()).includes("# Opened from disk"), JSON.stringify(await src()));

answers = ["by-save.md"];
await click("Save");
ok("Save", await waitForFile("by-save.md"), readdirSync(DL).join(","));

answers = ["by-saveas.md"];
await click("Save as");
ok("Save as", await waitForFile("by-saveas.md"), readdirSync(DL).join(","));

await click("Export HTML");
ok("Export HTML", await waitForFile("by-saveas.html"), readdirSync(DL).join(","));

await click("Download app");
ok("Download app", await waitForFile("md-editor.html"), readdirSync(DL).join(","));

await page.click(".chk input");
await wait(400);
ok("Local draft", (await page.evaluate(() => localStorage.getItem("mdedit.draft"))) !== null);
await click("Clear draft");
ok("Clear draft", (await page.evaluate(() => localStorage.getItem("mdedit.draft"))) === null);
await page.click(".chk input");
await wait(300);

/* ========================= find and replace ========================= */
console.log("\n--- find and replace ---");

await setSource("alpha beta alpha gamma alpha\n");
await click("Find");
ok("Find opens the search panel", (await page.$(".cm-panel.cm-search")) !== null);

await page.type(".cm-panel.cm-search .cm-textfield", "alpha");
await wait(400);
ok("Find highlights every match",
  (await page.$$(".cm-searchMatch")).length >= 3,
  String((await page.$$(".cm-searchMatch")).length));

await page.type('.cm-panel.cm-search [name="replace"]', "delta");
await click("replace all");
const replaced = await src();
ok("replace all", !replaced.includes("alpha") && (replaced.match(/delta/g) || []).length === 3,
  JSON.stringify(replaced));

await page.keyboard.press("Escape");
await wait(300);
ok("Escape closes the search panel", (await page.$(".cm-panel.cm-search")) === null);

/* ========================= outline ========================= */
console.log("\n--- outline ---");

const outlineShown = () => page.$eval(".outline", (e) => getComputedStyle(e).display !== "none");

await setSource("# One\n\ntext\n\n## Two\n\ntext\n\n### Three\n\ntext\n");
await click("Outline");
ok("Outline shows the panel", await outlineShown());

const entries = await page.$$eval(".outline-item", (els) => els.map((e) => e.textContent));
ok("Outline lists every heading", entries.join("|") === "One|Two|Three", JSON.stringify(entries));

const levels = await page.$$eval(".outline-item", (els) =>
  els.map((e) => e.className.match(/outline-l(\d)/)[1]).join(""));
ok("Outline records the heading level", levels === "123", levels);

// Follows whichever surface is on screen, so it has to survive the switch.
await click("Edit preview");
const richEntries = await page.$$eval(".outline-item", (els) => els.map((e) => e.textContent));
ok("Outline follows the rendered editor", richEntries.join("|") === "One|Two|Three",
  JSON.stringify(richEntries));
await click("Back to split");

await click("Outline");
ok("Outline hides again", !(await outlineShown()));

/* ========================= copying a code block ========================= */
console.log("\n--- copying a code block ---");

await browser.defaultBrowserContext().overridePermissions(new URL(TARGET).origin,
  ["clipboard-read", "clipboard-write"]);

const CODE = 'const secret = "value";\nconsole.log(secret);';
await setSource("Text.\n\n```js\n" + CODE + "\n```\n");

const copyButtons = await page.$$("#preview pre .copy-btn");
ok("a copy button is added to the code block", copyButtons.length === 1,
  String(copyButtons.length));

ok("it is hidden until the block is hovered",
  (await page.$eval("#preview pre .copy-btn", (e) => getComputedStyle(e).opacity)) === "0");

await page.click("#preview pre .copy-btn");
await wait(400);
ok("clicking it reports success",
  (await page.$eval("#preview pre .copy-btn", (e) => e.textContent)) === "Copied",
  await page.$eval("#preview pre .copy-btn", (e) => e.textContent));

const clipboard = await page.evaluate(() => navigator.clipboard.readText());
ok("the code block really reaches the clipboard", clipboard === CODE + "\n",
  JSON.stringify(clipboard));

// The secure-context path is gone on `http://<IP>`, exactly as for the File
// System Access API. The button has to keep working there, not vanish.
await page.evaluate(() => {
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
});
await setSource("Text.\n\n```js\n" + CODE + "\n```\n");
await page.click("#preview pre .copy-btn");
await wait(400);
ok("it still works without the Clipboard API",
  (await page.$eval("#preview pre .copy-btn", (e) => e.textContent)) === "Copied",
  await page.$eval("#preview pre .copy-btn", (e) => e.textContent));

// Restore the real API for the rest of the run. Reloading would be the obvious
// way, but the page guards against losing unsaved changes and the confirmation
// dialog blocks the navigation; deleting the own property re-exposes the
// getter on Navigator.prototype and costs nothing.
await page.evaluate(() => { delete navigator.clipboard; });
ok("the Clipboard API is restored for the rest of the run",
  await page.evaluate(() => Boolean(navigator.clipboard)));

/* ========================= pasting an image ========================= */
console.log("\n--- pasting an image ---");

// A real paste cannot be driven from outside the page, so the event is built
// with the same DataTransfer a browser would hand over.
const pasteImage = (selector) => page.evaluate((sel, dataUrl) => {
  const binary = atob(dataUrl.split(",")[1]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], "pixel.png", { type: "image/png" }));
  document.querySelector(sel).dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
}, selector, DATA_IMAGE);

await setSource("");
await page.click(".cm-content");
await pasteImage(".cm-content");
await wait(700);
ok("pasting an image into the source embeds it as a data: URI",
  /!\[pixel\]\(data:image\/png;base64,/.test(await src()), JSON.stringify(await src()));

/* ========================= formatting ribbon ========================= */
console.log("\n--- formatting ribbon ---");

const editing = () => page.$eval(".panes", (e) => e.classList.contains("editing"));

/**
 * Put a document in the source, then open the rendered editor on it.
 *
 * The source pane is hidden while the rendered document is being edited, so
 * anything that writes to it has to happen before switching -- and reading the
 * result means switching back. Every ribbon case therefore exercises both
 * transitions, which is exactly how the feature is used.
 */
async function editRendered(md) {
  if (await editing()) await click("Back to split");
  await setSource(md);
  await click("Edit preview");
}

/** Return to the split view and read the regenerated source. */
async function splitAndRead() {
  await click("Back to split");
  return src();
}

async function selectAllRendered() {
  await page.click("#rich .ProseMirror");
  await wait(250);
  await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
  await wait(150);
}

await click("Edit preview");
ok("Edit preview", (await page.$("#rich .ProseMirror")) !== null &&
  (await page.$eval(".pane-editor", (e) => getComputedStyle(e).display)) === "none");
await click("Back to split");
ok("Back to split", (await page.$eval(".pane-editor", (e) => getComputedStyle(e).display)) !== "none");

// Each case selects the whole paragraph first: acting on a selection rather
// than a bare cursor is what caught the "Tasks" bug.
for (const [label, expected] of [
  ["B", /\*\*plain text\*\*/],
  ["I", /\*plain text\*/],
  ["S", /~~plain text~~/],
  ["</>", /`plain text`/],
  ["Bullets", /^-\s+plain text/m],
  ["Numbers", /^1\.\s+plain text/m],
  ["Tasks", /^-\s+\[ \]\s+plain text/m],
  ["Quote", /^>\s+plain text/m],
]) {
  await editRendered("plain text");
  await selectAllRendered();
  await click(label);
  const s = await splitAndRead();
  ok(label, expected.test(s), JSON.stringify(s));
}

await editRendered("before");
await page.click("#rich .ProseMirror");
await page.keyboard.press("End");
await click("Divider");
ok("Divider", /^(-{3,}|\*{3,}|_{3,})$/m.test(await splitAndRead()), JSON.stringify(await src()));

await editRendered("- alpha\n  - beta");
await page.click("#rich .ProseMirror");
await wait(250);
await page.keyboard.down("Control"); await page.keyboard.press("End"); await page.keyboard.up("Control");
await click("Outdent");
const outdented = await splitAndRead();
ok("Outdent raises one level, it does not leave the list",
  /^-\s+beta/m.test(outdented) && /^-\s+alpha/m.test(outdented), JSON.stringify(outdented));

await editRendered("original");
await selectAllRendered();
await click("B");
await click("Undo");
ok("Undo", !/\*\*/.test(await splitAndRead()), JSON.stringify(await src()));

await editRendered("original");
await selectAllRendered();
await click("B");
await click("Undo");
await click("Redo");
ok("Redo", /\*\*original\*\*/.test(await splitAndRead()), JSON.stringify(await src()));

for (const [value, expected] of [
  ["h1", /^#\s/m], ["h3", /^###\s/m], ["code", /^```/m], ["p", /^heading text$/m],
]) {
  await editRendered("heading text");
  await page.click("#rich .ProseMirror");
  await wait(250);
  await page.select(".rb-select", value);
  await wait(450);
  ok(`style selector: ${value}`, expected.test(await splitAndRead()), JSON.stringify(await src()));
}

await editRendered("anchor");
await selectAllRendered();
answers = ["https://example.com"];
await click("Link");
ok("Link", /\[anchor\]\(https:\/\/example\.com\)/.test(await splitAndRead()), JSON.stringify(await src()));

await editRendered("");
await page.click("#rich .ProseMirror");
answers = [DATA_IMAGE, "alt text"];
await click("Image");
ok("a data: image really displays",
  (await page.$$eval("#rich img", (imgs) => imgs.filter((i) => i.complete && i.naturalWidth > 0).length)) === 1);
ok("Image", (await splitAndRead()).includes("![alt text](data:image/png;base64,"),
  JSON.stringify((await src()).slice(0, 60)));

// --- maths -------------------------------------------------------------
// Both open a prompt for the TeX, the same route as a link URL.

await editRendered("before");
await page.click("#rich .ProseMirror");
await page.keyboard.down("Control"); await page.keyboard.press("End"); await page.keyboard.up("Control");
answers = ["E = mc^2"];
await click("Math");
const inlineMaths = await splitAndRead();
ok("Math", /\$E = mc\^2\$/.test(inlineMaths), JSON.stringify(inlineMaths));

await editRendered("before");
await page.click("#rich .ProseMirror");
await page.keyboard.down("Control"); await page.keyboard.press("End"); await page.keyboard.up("Control");
answers = ["\\int_0^1 x\\,dx"];
await click("Math block");
const blockMaths = await splitAndRead();
ok("Math block", /\$\$\n\\int_0\^1 x\\,dx\n\$\$/.test(blockMaths), JSON.stringify(blockMaths));

// The rendered editor is ProseMirror's DOM, and nothing is injected into it:
// a stray node there is how you get a cursor landing inside a button.
await editRendered("```js\nconst x = 1;\n```");
ok("no copy button is injected into the rendered editor",
  (await page.$$("#rich .copy-btn")).length === 0);
await click("Back to split");

// The formula has to render, not merely serialise.
await editRendered("$E = mc^2$");
ok("a formula renders in the rendered editor",
  (await page.$$("#rich .katex")).length === 1,
  String((await page.$$("#rich .katex")).length));
await click("Back to split");

/* ========================= table tools ========================= */
console.log("\n--- table tools ---");
await editRendered("");
await page.click("#rich .ProseMirror");
await click("Table");

const cols = () => page.$$eval("#rich table tr:first-child > *", (e) => e.length);
const rows = () => page.$$eval("#rich table tr", (e) => e.length);
ok("Table", (await rows()) === 3 && (await cols()) === 3, `${await rows()}x${await cols()}`);

await page.click("#rich table td");
await wait(250);
const c0 = await cols(), r0 = await rows();
await click("+Col");
ok("+Col", (await cols()) === c0 + 1, `${c0} -> ${await cols()}`);
await click("+Row");
ok("+Row", (await rows()) === r0 + 1, `${r0} -> ${await rows()}`);
await click("−Col");
ok("−Col", (await cols()) === c0, `-> ${await cols()}`);
await click("−Row");
ok("−Row", (await rows()) === r0, `-> ${await rows()}`);
await click("×");
ok("× deletes the table", (await page.$("#rich table")) === null);
await click("Back to split");


/* ========================= policy still holds ========================= */
console.log("\n--- the policy is unchanged ---");

// Positive confirmation rather than an absence of noise: a remote image must be
// refused by the browser, and that refusal is a feature.
await setSource("![remote](https://example.test/pixel.png)");
await wait(600);
ok("a remote image is refused by img-src",
  cspBlocks.some((t) => /example\.test\/pixel\.png/.test(t)), cspBlocks.slice(-1).join(""));

ok("no JavaScript error across the whole run", jsErrors.length === 0, jsErrors.slice(0, 3).join(" | "));

await browser.close();
console.log();
if (fails) {
  console.error(`  ${fails} control(s) failing\n`);
  process.exit(1);
}
console.log("  every control works\n");
