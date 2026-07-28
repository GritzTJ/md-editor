/* ---------------------------------------------------------------------------
 * Post-build checks.
 *
 * These run against the file actually delivered, not the sources: they catch
 * the regressions only assembly can introduce (a script cut short by a closing
 * tag, a CSP digest out of step, a dependency that reintroduced a network
 * call).
 *
 *   node verify.mjs
 * ------------------------------------------------------------------------- */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const html = await readFile(resolve(root, "dist/index.html"), "utf8");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? " -- " + detail : ""}`);
  if (!ok) failures++;
};

/* --- extracting the raw blocks ------------------------------------------- */

const scriptMatch = html.match(/<script id="app-js">([\s\S]*?)<\/script>/);
const styleMatch = html.match(/<style id="app-css">([\s\S]*?)<\/style>/);
const cspMatch = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/);

check("the inline script is cleanly delimited", Boolean(scriptMatch));
check("the inline stylesheet is cleanly delimited", Boolean(styleMatch));
check("the CSP is present in the document", Boolean(cspMatch));
if (!scriptMatch || !styleMatch || !cspMatch) process.exit(1);

const js = scriptMatch[1];
const css = styleMatch[1];
const csp = cspMatch[1];

/* --- 1. the embedded script is valid, complete JavaScript ---------------- */

// An unescaped `</script` in the bundle would cut the script off mid-flight:
// the file would still be valid HTML, but the application would be broken. So
// check the syntax of the fragment exactly as extracted from the document.
const tmp = join(mkdtempSync(join(tmpdir(), "mdverify-")), "app.js");
writeFileSync(tmp, js.replace(/<\\\/script/gi, "</script"), "utf8");
let syntaxOk = true;
let syntaxErr = "";
try {
  execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
} catch (e) {
  syntaxOk = false;
  syntaxErr = String(e.stderr).split("\n").slice(0, 3).join(" ");
}
check("the script extracted from the HTML is syntactically valid", syntaxOk, syntaxErr);
check("no unescaped '</script' in the bundle", !/<\/script/i.test(js));
check("no '</style' in the stylesheet", !/<\/style/i.test(css));

/* --- 2. the CSP digest matches the delivered script ---------------------- */

const declared = (csp.match(/script-src 'sha256-([^']+)'/) || [])[1];
const actual = createHash("sha256").update(js, "utf8").digest("base64");
check("the script-src digest matches the script bytes", declared === actual,
  declared === actual ? "" : `declared ${declared}, computed ${actual}`);

/* --- 3. the CSP really forbids any network egress ------------------------ */

for (const directive of [
  "default-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
]) {
  check(`CSP: ${directive}`, csp.includes(directive));
}
check("CSP: img-src allows no remote scheme", /img-src (?:data:|blob:|\s)+(?:;|$)/.test(csp));
check("CSP: no http(s) source allowed", !/https?:/.test(csp));

/* --- 4. the document references no external resource --------------------- */

// A single forgotten absolute URL (font, CDN, favicon) would be enough to tell
// the network that a document is open. The CSP would block it, but it is better
// for it not to exist at all.
const externals = [...html.matchAll(/\b(?:src|href)\s*=\s*"(https?:)?\/\/[^"]*"/gi)].map((m) => m[0]);
check("no external resource referenced in the document", externals.length === 0, externals.join(", "));

/* --- 5. no network primitive in the bundle ------------------------------- */

// Call sites are targeted rather than plain mentions: the About dialog explains
// these APIs by name and must not trip the alarm. If one of these patterns ever
// shows up, a dependency has changed behaviour and deserves a read.
const netPatterns = [
  // `fetch` is the awkward one: KaTeX's TeX parser has a `fetch()` method that
  // returns the next token, so the bundle is full of `r.fetch()` call sites and
  // one `fetch(){...}` method definition, none of which touch the network. The
  // pattern therefore wants a bare `fetch(` -- no `.` or identifier character
  // before it, ruling out a method call -- that is also passed an argument,
  // ruling out the definition. The qualified global forms are matched
  // separately, since those do have a dot in front.
  ["fetch()", /(?<![.\w$])fetch\s*\(\s*(?!\)\s*\{)/],
  ["window.fetch()", /\b(?:window|globalThis|self)\s*\.\s*fetch\s*\(/],
  ["new XMLHttpRequest()", /new\s+XMLHttpRequest|XMLHttpRequest\s*\(/],
  ["new WebSocket()", /new\s+WebSocket\s*\(/],
  ["new EventSource()", /new\s+EventSource\s*\(/],
  ["navigator.sendBeacon()", /sendBeacon\s*\(/],
  ["importScripts()", /importScripts\s*\(/],
  ["navigator.serviceWorker", /serviceWorker\s*\./],
  ["RTCPeerConnection", /new\s+RTC\w*PeerConnection/],
];
for (const [label, re] of netPatterns) {
  check(`the bundle does not call ${label}`, !re.test(js));
}

/* --- 6. rebuilding the standalone file stays valid ----------------------- */

// Reproduces what doDownloadApp() does in the browser: if the digest survives
// the round trip, the downloaded file will run.
const rebuilt = `<style id="app-css">${css}</style>` + `<script id="app-js">${js}</script>`;
const rebuiltJs = rebuilt.match(/<script id="app-js">([\s\S]*?)<\/script>/)[1];
check("the rebuilt standalone file keeps a valid digest",
  createHash("sha256").update(rebuiltJs, "utf8").digest("base64") === declared);

/* --- 7. the delivered body holds no content ------------------------------ */

const body = html.match(/<body>([\s\S]*?)<div id="app">/);
check("the application container ships empty", Boolean(body) && html.includes('<div id="app"></div>'));

console.log();
if (failures) {
  console.error(`  ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log("  all checks pass\n");
