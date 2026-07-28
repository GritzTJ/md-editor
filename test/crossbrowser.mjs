/* ---------------------------------------------------------------------------
 * The same claims, checked on three engines.
 *
 * Everything the README promises about network containment is enforced by the
 * browser, not by this code -- so a claim verified on one engine is a claim
 * verified on one engine. The other suites drive Chromium through puppeteer;
 * this one drives Blink, Gecko and WebKit through Playwright and asserts the
 * load-bearing behaviour on each.
 *
 * WHAT THIS IS NOT: Safari. Safari only runs on macOS. What runs here is
 * WebKit, the engine underneath it, in Playwright's Linux build. The rendering
 * and security machinery is the same code; the surrounding application is not,
 * and neither is the release cadence. A pass here is strong evidence for
 * Safari, not proof of it. The README says so too.
 *
 * Chromium is included on purpose even though puppeteer already covers it: a
 * check that fails on Gecko and WebKit but passes on Blink is a real
 * difference, and one that fails on all three is usually a bug in this file.
 *
 *   npm run dev &
 *   npm install --no-save playwright && npx playwright install
 *   node test/crossbrowser.mjs
 *   ENGINES=firefox node test/crossbrowser.mjs      # one engine only
 * ------------------------------------------------------------------------- */

import { chromium, firefox, webkit } from "playwright";

const TARGET = process.env.TARGET || "http://localhost:8080/";
const ENGINES = (process.env.ENGINES || "chromium,firefox,webkit").split(",");
const LAUNCHERS = { chromium, firefox, webkit };

// The host the egress probes aim at. Never resolves; the point is only whether
// the browser lets the attempt start.
const PROBE = "https://example.test";

const results = {}; // engine -> [{name, ok, detail}]
let engine = null;

function ok(name, passed, detail = "") {
  results[engine].push({ name, ok: passed, detail });
  console.log(`  ${passed ? "ok  " : "FAIL"}  ${name}${detail ? " -- " + detail : ""}`);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SAMPLE = `# Titre

Du **gras**, de l'*italique* et \`du code\`.

- [x] fait
- [ ] à faire

| a | b |
| --- | --: |
| 1 | 2 |

Inline $E = mc^2$ and:

$$
\\frac{a}{b}
$$

\`\`\`js
const x = 1;
\`\`\`
`;

for (const name of ENGINES) {
  engine = name;
  results[engine] = [];
  console.log(`\n=================== ${name} ===================`);

  const browser = await LAUNCHERS[name].launch();
  const context = await browser.newContext();

  // Recorded before anything loads, so a violation raised during start-up is
  // not missed.
  await context.addInitScript(() => {
    window.__violations = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      window.__violations.push(e.violatedDirective));
  });

  const page = await context.newPage();
  const jsErrors = [];
  page.on("pageerror", (e) => jsErrors.push(String(e).split("\n")[0]));

  // Any request leaving the page is a failure by itself: the document is
  // supposed to be self-contained once delivered.
  //
  // PROBE is excluded because the containment section below deliberately tries
  // to reach it. Those attempts are the test, not the application -- and an
  // engine may well create the request object before the policy kills it, so
  // they show up here either way.
  const offsite = [];
  page.on("request", (r) => {
    const url = r.url();
    if (url.startsWith(PROBE)) return;
    if (!url.startsWith(TARGET) && !url.startsWith("data:") && !url.startsWith("blob:")) {
      offsite.push(url.slice(0, 60));
    }
  });

  console.log(`\n--- ${name}: loading ---`);
  await page.goto(TARGET, { waitUntil: "load" });
  await wait(1200);

  console.log("  version:", browser.version());
  ok("the page loads with no JavaScript error", jsErrors.length === 0, jsErrors.slice(0, 2).join(" | "));
  ok("CodeMirror is mounted", (await page.locator(".cm-editor .cm-content").count()) === 1);
  ok("the toolbar is rendered", (await page.locator(".tb").count()) === 1);
  ok("the preview is rendered", (await page.locator("#preview").count()) === 1);
  ok("no CSP violation at start-up",
    (await page.evaluate(() => window.__violations)).length === 0,
    (await page.evaluate(() => window.__violations)).join(", "));
  ok("the document fetched nothing off-site", offsite.length === 0, offsite.slice(0, 2).join(", "));

  /* --- rendering ------------------------------------------------------- */
  console.log(`\n--- ${name}: rendering ---`);

  const setSource = async (text) => {
    await page.click(".cm-content");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");
    await page.keyboard.insertText(text);
    await wait(900);
  };
  await setSource(SAMPLE);

  ok("headings render", (await page.locator("#preview h1").innerText()) === "Titre");
  ok("bold renders", (await page.locator("#preview strong").count()) === 1);
  ok("tables render", (await page.locator("#preview table tbody tr").count()) === 1);
  ok("task checkboxes render", (await page.locator("#preview li.task-item").count()) === 2);
  ok("code blocks render", (await page.locator("#preview pre").count()) === 1);

  const maths = await page.evaluate(() => ({
    katex: document.querySelectorAll("#preview .katex").length,
    mathml: document.querySelectorAll("#preview .katex-mathml math").length,
  }));
  ok("KaTeX renders inline and display maths", maths.katex === 2, JSON.stringify(maths));
  ok("MathML is emitted for screen readers", maths.mathml === 2, String(maths.mathml));

  // The fonts are data: URIs inside the page; a miss would silently fall back
  // to a serif whose metrics KaTeX does not expect.
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((f) => f.family.startsWith("KaTeX") && f.status === "loaded").length;
  });
  ok("KaTeX fonts load from the document itself", fonts > 0, String(fonts));

  /* --- network containment --------------------------------------------- */
  console.log(`\n--- ${name}: network containment ---`);

  // Each attempt counts as contained if it either failed outright or raised a
  // CSP violation. Both are needed: `fetch` rejects, but `sendBeacon` returns
  // true and is dropped afterwards, so only the violation shows it was refused.
  const egress = await page.evaluate(async (PROBE) => {
    const before = window.__violations.length;
    const out = {};
    const attempt = async (name, fn) => {
      const mark = window.__violations.length;
      let failed = false;
      try { await fn(); } catch { failed = true; }
      await new Promise((r) => setTimeout(r, 250));
      out[name] = { failed, violated: window.__violations.length > mark };
    };

    await attempt("fetch", () => fetch(PROBE + "/x"));
    await attempt("XMLHttpRequest", () => new Promise((res, rej) => {
      const x = new XMLHttpRequest();
      x.onerror = () => rej(new Error("blocked"));
      x.onload = () => res("loaded");
      x.open("GET", PROBE + "/x");
      x.send();
      setTimeout(() => rej(new Error("timeout")), 1500);
    }));
    await attempt("WebSocket", () => new Promise((res, rej) => {
      let s;
      try { s = new WebSocket(PROBE.replace("https", "wss") + "/ws"); } catch { return rej(new Error("threw")); }
      s.onerror = () => rej(new Error("error"));
      s.onopen = () => res("open");
      setTimeout(() => rej(new Error("timeout")), 1500);
    }));
    await attempt("EventSource", () => new Promise((res, rej) => {
      let e;
      try { e = new EventSource(PROBE + "/sse"); } catch { return rej(new Error("threw")); }
      e.onerror = () => { e.close(); rej(new Error("error")); };
      e.onopen = () => res("open");
      setTimeout(() => { e.close(); rej(new Error("timeout")); }, 1500);
    }));
    await attempt("sendBeacon", async () => {
      if (!navigator.sendBeacon) throw new Error("absent");
      if (!navigator.sendBeacon(PROBE + "/b", "x")) throw new Error("refused");
    });
    await attempt("dynamic import", () => import(PROBE + "/m.js"));
    await attempt("remote image", () => new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res("loaded");
      i.onerror = () => rej(new Error("blocked"));
      i.src = PROBE + "/p.png";
      setTimeout(() => rej(new Error("timeout")), 1500);
    }));

    out.__total = window.__violations.length - before;
    return out;
  }, PROBE);

  for (const key of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource",
                     "sendBeacon", "dynamic import", "remote image"]) {
    const r = egress[key];
    ok(`${key} cannot leave the page`, r.failed || r.violated,
      `failed=${r.failed} violation=${r.violated}`);
  }

  /* --- sanitisation ----------------------------------------------------- */
  console.log(`\n--- ${name}: sanitisation ---`);

  await page.evaluate(() => { window.__xss = 0; });
  await setSource([
    "<script>window.__xss = 1;<\/script>",
    '<img src="x" onerror="window.__xss = 2">',
    '<a href="javascript:window.__xss=3" id="jsl">clic</a>',
    "<iframe src=\"https://example.test/\"></iframe>",
  ].join("\n\n"));
  await wait(500);

  ok("an injected script does not run", (await page.evaluate(() => window.__xss)) === 0,
    String(await page.evaluate(() => window.__xss)));
  ok("onerror is stripped", (await page.locator("#preview img[onerror]").count()) === 0);
  ok("a javascript: link is neutralised",
    (await page.locator('#preview a[href^="javascript:"]').count()) === 0);
  ok("an iframe is removed", (await page.locator("#preview iframe").count()) === 0);

  /* --- files ------------------------------------------------------------ */
  console.log(`\n--- ${name}: files ---`);

  const hasFSA = await page.evaluate(() => typeof window.showSaveFilePicker === "function");
  console.log(`  (File System Access API ${hasFSA ? "present" : "absent"} on this engine)`);

  await setSource("# Saved\n\ncontent\n");
  page.on("dialog", (d) => d.accept("cross.md"));
  let downloaded = null;
  if (!hasFSA) {
    const [dl] = await Promise.all([
      page.waitForEvent("download", { timeout: 8000 }).catch(() => null),
      page.locator(".tb button", { hasText: /^Save$/ }).click(),
    ]);
    downloaded = dl;
    ok("without the file API, Save downloads a copy", dl !== null,
      dl ? "suggested name: " + dl.suggestedFilename() : "no download event");
  } else {
    ok("the file API is available, Save writes directly (not exercised here)", true);
  }

  /* --- editing the rendered document ------------------------------------ */
  console.log(`\n--- ${name}: editing the rendered document ---`);

  await setSource("# Round trip\n\nOriginal text.\n");
  await page.locator(".tb button", { hasText: "Edit preview" }).click();
  await wait(800);
  ok("the rendered editor mounts", (await page.locator("#rich .ProseMirror").count()) === 1);

  await page.click("#rich .ProseMirror p");
  await page.keyboard.press("End");
  await page.keyboard.insertText(" Added here.");
  await wait(600);
  await page.locator(".tb button", { hasText: "Back to split" }).click();
  await wait(900);

  const source = await page.evaluate(() =>
    [...document.querySelectorAll(".cm-line")].map((l) => l.textContent).join("\n"));
  ok("an edit in the rendered document reaches the source",
    source.includes("Added here."), JSON.stringify(source.slice(0, 80)));

  /* --- copying a code block --------------------------------------------- */
  console.log(`\n--- ${name}: copying a code block ---`);

  await setSource("```js\nconst secret = 1;\n```\n");
  ok("a copy button is added", (await page.locator("#preview pre .copy-btn").count()) === 1);
  await page.locator("#preview pre .copy-btn").click();
  await wait(600);
  const label = await page.locator("#preview pre .copy-btn").innerText();
  ok("the copy button reports success", label === "Copied", label);

  /* --- printing ---------------------------------------------------------- */
  console.log(`\n--- ${name}: printing ---`);

  await page.emulateMedia({ media: "print" });
  await wait(300);
  const printed = await page.evaluate(() => Object.fromEntries(
    [".tb", ".sb", ".pane-editor", "#preview"].map((s) =>
      [s, getComputedStyle(document.querySelector(s)).display])));
  ok("printing hides the interface",
    printed[".tb"] === "none" && printed[".sb"] === "none" && printed[".pane-editor"] === "none",
    JSON.stringify(printed));
  ok("printing keeps the document", printed["#preview"] !== "none");
  await page.emulateMedia({ media: "screen" });

  ok("no JavaScript error across the whole run", jsErrors.length === 0,
    jsErrors.slice(0, 2).join(" | "));
  ok("nothing was requested off-site across the whole run", offsite.length === 0,
    offsite.slice(0, 3).join(", "));

  await browser.close();
}

/* --- summary -------------------------------------------------------------- */

console.log("\n\n=================== summary ===================\n");

// Rows are matched by name, not by position. The engines do not all run the
// same checks: an engine with the File System Access API takes a different
// branch from one without, and lining the table up by index would print one
// engine's label over another engine's result.
const byName = {};
for (const e of ENGINES) {
  for (const r of results[e]) (byName[r.name] ||= {})[e] = r;
}
const names = Object.keys(byName);
const width = Math.max(...names.map((n) => n.length));

console.log("  " + "check".padEnd(width) + "  " + ENGINES.map((e) => e.padEnd(9)).join(""));
console.log("  " + "-".repeat(width) + "  " + "-".repeat(9 * ENGINES.length));

let failures = 0;
for (const name of names) {
  const row = ENGINES.map((e) => {
    const r = byName[name][e];
    if (!r) return "-".padEnd(9); // not applicable to this engine
    if (!r.ok) failures++;
    return (r.ok ? "ok" : "FAIL").padEnd(9);
  });
  console.log("  " + name.padEnd(width) + "  " + row.join(""));
}
console.log("\n  (« - » = check not applicable to that engine)");

console.log();
for (const e of ENGINES) {
  const bad = results[e].filter((r) => !r.ok);
  console.log(`  ${e.padEnd(9)} ${results[e].length - bad.length}/${results[e].length} pass`);
}

console.log();
if (failures) {
  console.error(`  ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log("  every engine holds every claim\n");
