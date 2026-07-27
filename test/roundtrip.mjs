/* ---------------------------------------------------------------------------
 * Markdown <-> ProseMirror round-trip tests.
 *
 * Editing in rich mode regenerates the source from the model: anything the
 * schema cannot represent disappears. These tests are therefore the guarantee
 * that no construct the preview supports is destroyed by going through the rich
 * editor.
 *
 * Two distinct properties are checked:
 *
 *   - PRESERVATION: the semantic content survives one round trip;
 *   - STABILITY: a second round trip changes nothing further. That is the one
 *     that really matters. Normalisation (`*` becoming `-`) is acceptable; a
 *     source that drifts on every pass is not.
 *
 * The code under test touches the DOM, so it runs in a real browser.
 *
 *   npm install --no-save puppeteer
 *   node test/roundtrip.mjs
 * ------------------------------------------------------------------------- */

import * as esbuild from "esbuild";
import puppeteer from "puppeteer";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* --- Cases covered ------------------------------------------------------- */

const CASES = [
  ["headings", "# One\n\n## Two\n\n### Three\n"],
  ["emphasis", "Some *italic*, some **bold**, some ***both***.\n"],
  ["strikethrough", "Some ~~struck text~~ here.\n"],
  ["inline code", "Run `npm run build` then `node verify.mjs`.\n"],
  ["links", "See [the site](https://example.com) and [with title](https://example.com \"Title\").\n"],
  ["images", "![alternative text](image.png)\n"],
  ["block quote", "> A quote\n>\n> across two paragraphs.\n"],
  ["bulleted list", "- alpha\n- beta\n- gamma\n"],
  ["numbered list", "1. first\n2. second\n3. third\n"],
  ["nested list", "- alpha\n  - alpha.1\n  - alpha.2\n- beta\n"],
  ["tasks", "- [ ] to do\n- [x] done\n- ordinary bullet\n"],
  ["nested tasks", "- [ ] parent\n  - [x] child\n"],
  ["code block", "```js\nconst secret = 42;\n```\n"],
  ["code block without language", "```\nplain text\n```\n"],
  ["horizontal rule", "before\n\n---\n\nafter\n"],
  ["simple table", "| a | b |\n| --- | --- |\n| 1 | 2 |\n"],
  ["aligned table", "| left | centre | right |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |\n"],
  ["table with emphasis", "| col |\n| --- |\n| **bold** and `code` |\n"],
  ["table with a pipe", "| col |\n| --- |\n| a \\| b |\n"],
  ["html block", "before\n\n<details><summary>More</summary>\nhidden\n</details>\n\nafter\n"],
  ["inline html", "A <kbd>Ctrl</kbd> in the middle.\n"],
  ["mixture", "# Title\n\n**Bold** text.\n\n- [ ] task\n- bullet\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n> quote\n\n```sh\necho ok\n```\n"],

  // Cases where the serialiser works with a non-empty current delimiter:
  // without care, that delimiter gets copied inside the cells.
  ["table in a block quote", "> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n"],
  ["table in a list", "- item\n\n  | a | b |\n  | --- | --- |\n  | 1 | 2 |\n"],
  ["code block in a list", "- item\n\n  ```js\n  const x = 1;\n  ```\n"],
  ["nested block quote", "> level one\n>\n> > level two\n"],
  ["loose list", "- first\n\n- second\n\n- third\n"],
  ["numbered list with offset", "5. five\n6. six\n7. seven\n"],
  ["hard line break", "line one\\\nline two\n"],
  ["escaped characters", "A \\* star, a \\_ underscore, a \\` backtick.\n"],
  ["link in a table", "| col |\n| --- |\n| [link](https://example.com) |\n"],
  ["task with emphasis", "- [x] **important** task\n"],
  ["html in a list", "- item with <kbd>Ctrl</kbd>\n"],

  // Overlapping marks: the schema's mark order decides which one wraps the
  // other. With `strong` ahead of `link`, a partially emphasised link came back
  // as two separate links.
  ["partially bold link", "[**bold** and plain](https://example.com)\n"],
  ["partially italic link", "[*em* and plain](https://example.com)\n"],
  ["fully bold link", "[**all bold**](https://example.com)\n"],
  ["code inside a link", "[`code` text](https://example.com)\n"],
  ["struck link", "[~~gone~~ text](https://example.com)\n"],

  // Extended syntax added for Markdown Guide coverage. Each needs a node or a
  // mark in the schema, or editing the rendered document would destroy it.
  ["highlight", "Some ==highlighted== words.\n"],
  ["subscript", "H~2~O and CO~2~\n"],
  ["superscript", "X^2^ plus Y^n^\n"],
  ["heading with an id", "### Heading {#custom-id}\n"],
  ["definition list", "Term\n: The definition.\n"],
  ["definition list, several terms", "First\n: One.\n\nSecond\n: Two.\n"],
  ["definition list, two terms one definition", "First\nSecond\n: Shared.\n"],
  ["definition list, two definitions", "Term\n: One.\n: Two.\n"],
  ["footnote", "Text.[^1]\n\n[^1]: The note.\n"],
  ["footnotes, named labels", "A[^alpha] and B[^beta]\n\n[^alpha]: First.\n\n[^beta]: Second.\n"],
  ["footnote with emphasis", "Text.[^1]\n\n[^1]: A **bold** note.\n"],
  ["emoji", "Camping \u26fa and laughing \ud83d\ude02\n"],
  ["autolinked URL", "See <https://example.com> now.\n"],
  ["highlight inside a list", "- some ==marked== text\n"],
  ["mixed extended", "# T {#top}\n\n==mark== H~2~O X^2^\n\nTerm\n: Def\n\nNote.[^n]\n\n[^n]: Here.\n"],
];

/* --- Bundle the engine, run it in the browser ---------------------------- */

const entry = `
import { toDoc, toMarkdown, renderMarkdown } from ${JSON.stringify(resolve(root, "src/markdown.js"))};
window.__rt = (src) => {
  const once = toMarkdown(toDoc(src));
  const twice = toMarkdown(toDoc(once));
  return { once, twice };
};
window.__render = renderMarkdown;
`;

const built = await esbuild.build({
  stdin: { contents: entry, resolveDir: root, loader: "js" },
  bundle: true,
  format: "iife",
  target: ["es2021"],
  charset: "utf8",
  write: false,
  logLevel: "error",
});

const page = `<!doctype html><meta charset="utf-8"><body><script>${
  built.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")
}</script></body>`;

const browser = await puppeteer.launch({
  headless: "shell",
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const tab = await browser.newPage();
const crashes = [];
tab.on("pageerror", (e) => crashes.push(String(e)));
await tab.setContent(page, { waitUntil: "domcontentloaded" });

/* --- Run ----------------------------------------------------------------- */

let fails = 0;
const show = (s) => JSON.stringify(s);

console.log("\n--- Markdown <-> ProseMirror round trip ---\n");

for (const [name, src] of CASES) {
  let result;
  try {
    result = await tab.evaluate((s) => window.__rt(s), src);
  } catch (err) {
    console.log(`  FAIL  ${name} -- exception: ${String(err).split("\n")[0]}`);
    fails++;
    continue;
  }

  const stable = result.once === result.twice;
  if (!stable) {
    console.log(`  FAIL  ${name} -- unstable`);
    console.log(`        pass 1: ${show(result.once)}`);
    console.log(`        pass 2: ${show(result.twice)}`);
    fails++;
    continue;
  }

  // The rendering must survive: compare the HTML produced by the original
  // source with the HTML produced after the round trip. That is stricter than
  // string equality, and closer to what the user actually sees.
  const [htmlBefore, htmlAfter] = await tab.evaluate(
    (a, b) => [window.__render(a), window.__render(b)], src, result.once);
  const norm = (h) => h.replace(/\s+/g, " ").trim();

  if (norm(htmlBefore) !== norm(htmlAfter)) {
    console.log(`  FAIL  ${name} -- the rendering changes after a round trip`);
    console.log(`        before: ${show(norm(htmlBefore))}`);
    console.log(`        after:  ${show(norm(htmlAfter))}`);
    console.log(`        regenerated source: ${show(result.once)}`);
    fails++;
    continue;
  }

  console.log(`  ok    ${name}`);
}

if (crashes.length) {
  console.log(`\n  JavaScript errors: ${crashes.slice(0, 3).join(" | ")}`);
  fails += crashes.length;
}

await browser.close();
console.log();
if (fails) {
  console.error(`  ${fails} case(s) failed\n`);
  process.exit(1);
}
console.log("  no content lost in the round trip\n");
