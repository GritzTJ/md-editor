/* ---------------------------------------------------------------------------
 * Building md-editor.
 *
 * The output is a single file, `dist/index.html`, holding everything: CSS,
 * JavaScript, dependencies. No external resource is referenced, so the page
 * behaves identically served over HTTP or opened from `file://` after a plain
 * copy -- which is what lets a user drop the server entirely.
 *
 * The inline script is allowed by the CSP through its SHA-256 digest, computed
 * here over the exact bytes that will be written into the page. Change one byte
 * afterwards and the browser refuses to run it.
 *
 *   node build.mjs           build dist/
 *   node build.mjs --serve   build, then serve dist/ on :8080 with the same
 *                            headers as the production container
 * ------------------------------------------------------------------------- */

import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, "dist");
const serve = process.argv.includes("--serve");

/* --- 0. Build identity ---------------------------------------------------
 *
 * Version and commit are baked into the page so a user can tell which release
 * they are running and compare it with the published digest.
 *
 * Note what is *not* here: a build timestamp. Two builds of the same commit
 * must produce the same bytes, or the digest published with a release proves
 * nothing -- nobody could reproduce it. Identity therefore comes only from
 * inputs that are themselves part of the source.
 *
 * `.git` is excluded from the Docker build context, so the image build passes
 * the commit in through MD_EDITOR_COMMIT instead of reading it from git.
 * ---------------------------------------------------------------------- */

const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

function buildCommit() {
  const fromEnv = (process.env.MD_EDITOR_COMMIT || "").trim();
  if (fromEnv) return fromEnv.slice(0, 12);
  try {
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const sha = git("rev-parse", "--short=12", "HEAD");
    // A build made from an edited tree is not the commit it claims to be, and
    // its digest will match nothing. Say so rather than let it pass as clean.
    const dirty = git("status", "--porcelain") !== "";
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}

const version = pkg.version;
const commit = buildCommit();

/* --- 1. JavaScript bundle ------------------------------------------------ */

const bundle = await esbuild.build({
  entryPoints: [resolve(root, "src/app.js")],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2021"],
  charset: "utf8",
  legalComments: "eof", // dependency MIT licences stay in the file
  write: false,
  logLevel: "info",
  define: {
    __BUILD_VERSION__: JSON.stringify(version),
    __BUILD_COMMIT__: JSON.stringify(commit),
  },
  // katex publishes a CommonJS build and an ES module build of the same code,
  // and its `exports` map hands out whichever matches the caller: markdown.js
  // imports it, @vscode/markdown-it-katex requires it, and esbuild bundled both
  // files -- 260 kB of duplicate. The alias forces one resolution for everyone.
  alias: {
    katex: resolve(root, "node_modules/katex/dist/katex.mjs"),
  },
});

// `</script` can only appear in valid JavaScript inside a string, a regular
// expression or a comment, so escaping it never changes the semantics -- and it
// stops the HTML parser from closing the tag in the middle of the bundle.
const js = bundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

/* --- 1b. KaTeX stylesheet, fonts included --------------------------------
 *
 * KaTeX's stylesheet points at twenty font files. Left alone, every formula
 * would trigger a request the CSP refuses outright (`font-src data:`), and the
 * maths would fall back to a system serif whose metrics KaTeX's layout does not
 * expect -- visibly wrong, not merely plainer.
 *
 * So the faces are read at build time and inlined as `data:` URIs. Only woff2
 * is kept: the woff and truetype copies would add roughly 800 kB for browsers
 * that have all supported woff2 since 2016.
 * ---------------------------------------------------------------------- */

async function katexCss() {
  const dir = resolve(root, "node_modules/katex/dist");
  const source = await readFile(resolve(dir, "katex.min.css"), "utf8");

  const encoded = new Map();
  for (const [, name] of source.matchAll(/url\(fonts\/([\w-]+)\.woff2\)/g)) {
    if (encoded.has(name)) continue;
    const bytes = await readFile(resolve(dir, "fonts", `${name}.woff2`));
    encoded.set(name, bytes.toString("base64"));
  }

  // Each `src:` list collapses to its single woff2 entry, now a data: URI.
  const out = source.replace(
    /src:\s*url\(fonts\/([\w-]+)\.woff2\)\s*format\("woff2"\)[^;}]*/g,
    (whole, name) => {
      const data = encoded.get(name);
      if (!data) throw new Error(`no woff2 read for ${name}`);
      return `src:url(data:font/woff2;base64,${data}) format("woff2")`;
    },
  );

  const left = out.match(/url\(fonts\//g);
  if (left) throw new Error(`${left.length} KaTeX font reference(s) left unresolved`);

  console.log(`  katex             ${encoded.size} fonts inlined`);
  return out;
}

const css = `${await katexCss()}\n${await readFile(resolve(root, "src/styles.css"), "utf8")}`;

// The stylesheet is inlined raw, so a literal `</style` anywhere in it would
// close the tag early and spill CSS into the document.
if (/<\/style/i.test(css)) throw new Error("the stylesheet contains a literal </style");

/* --- 2. Content Security Policy ------------------------------------------ */

const scriptHash = createHash("sha256").update(js, "utf8").digest("base64");

// `frame-ancestors` is ignored inside a <meta> tag: it only takes effect as an
// HTTP header, hence the generated csp.conf for nginx. The rest is duplicated
// in the document so the protection travels with the downloaded file.
const CSP_DIRECTIVES = [
  "default-src 'none'",
  `script-src 'sha256-${scriptHash}'`,
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
];

const cspMeta = CSP_DIRECTIVES.join("; ");

// No `sandbox` directive here: it would add almost nothing on top of
// `default-src 'none'` and would break the File System Access API, which direct
// file saving relies on.
const cspHeader = [...CSP_DIRECTIVES, "frame-ancestors 'none'"].join("; ");

/* --- 3. Final document --------------------------------------------------- */

// `data-theme` is deliberately absent: the stylesheet then follows
// `prefers-color-scheme`, and the script sets the attribute as soon as it runs.
//
// The <body> holds nothing but an empty container: the whole interface is built
// by the script. That is what makes rebuilding the standalone file from the DOM
// faithful to the original, with no risk of embedding the user's document.
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${cspMeta}">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<meta name="description" content="A Markdown editor that runs entirely in the browser.">
<title>Markdown editor</title>
<style id="app-css">${css}</style>
</head>
<body>
<div id="app"></div>
<script id="app-js">${js}</script>
</body>
</html>
`;

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await writeFile(resolve(dist, "index.html"), html, "utf8");

// Fragment included by nginx: keeps the header and the document perfectly in
// step, script digest included.
await writeFile(
  resolve(dist, "csp.conf"),
  `# Generated by build.mjs -- do not edit by hand.\n` +
  `add_header Content-Security-Policy "${cspHeader}" always;\n`,
  "utf8",
);

// Digest of the delivered file: the value to publish with each release so a
// user can verify the page they were actually served.
const fileHash = createHash("sha256").update(html, "utf8").digest("hex");
await writeFile(resolve(dist, "index.html.sha256"), `${fileHash}  index.html\n`, "utf8");

const kb = (n) => (n / 1024).toFixed(1) + " kB";
console.log(`\n  build             ${version} (${commit})`);
console.log(`  dist/index.html   ${kb(Buffer.byteLength(html))}  (js ${kb(Buffer.byteLength(js))}, css ${kb(Buffer.byteLength(css))})`);
console.log(`  sha256            ${fileHash}`);
console.log(`  script-src        'sha256-${scriptHash}'\n`);

/* --- 4. Development server ----------------------------------------------- */

if (serve) {
  const port = Number(process.env.PORT || 8080);
  const body = Buffer.from(html, "utf8");

  createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": body.length,
      "Content-Security-Policy": cspHeader,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "geolocation=(), microphone=(), camera=(), interest-cohort=()",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  }).listen(port, () => {
    console.log(`  Development server: http://localhost:${port}\n`);
  });
}
