/* ---------------------------------------------------------------------------
 * Compliance with the Markdown Guide.
 *
 * Every construct documented at markdownguide.org/basic-syntax and
 * /extended-syntax, checked on the two axes that matter here:
 *
 *   RENDER     does the preview produce the element the guide describes?
 *   ROUND TRIP does the construct survive being edited in the rendered view?
 *              Editing regenerates the source from the model, so a construct
 *              can render perfectly and still be destroyed on the way back.
 *
 * A construct the engine does not implement is reported as such rather than as
 * a failure: the point is an honest map of what is and is not supported.
 *
 *   npm install --no-save puppeteer
 *   node test/syntax.mjs
 * ------------------------------------------------------------------------- */

import * as esbuild from "esbuild";
import puppeteer from "puppeteer";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* --- The catalogue -------------------------------------------------------
 * [section, name, source, expected]
 * `expected` is a predicate over the rendered HTML.
 * ---------------------------------------------------------------------- */

const has = (re) => (html) => re.test(html);

const CASES = [
  // ---------------------------------------------------------------- basic
  ["basic", "heading, hash levels 1-6",
    "# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n",
    has(/<h1[^>]*>One<\/h1>[\s\S]*<h6[^>]*>Six<\/h6>/)],
  ["basic", "heading, setext level 1", "One\n===\n", has(/<h1[^>]*>One<\/h1>/)],
  ["basic", "heading, setext level 2", "Two\n---\n", has(/<h2[^>]*>Two<\/h2>/)],
  ["basic", "paragraphs", "First.\n\nSecond.\n", has(/<p>First\.<\/p>\s*<p>Second\.<\/p>/)],
  ["basic", "line break, two trailing spaces", "one  \ntwo\n", has(/one<br>\s*two/)],
  ["basic", "line break, <br> tag", "one<br>\ntwo\n", has(/one<br>/)],
  ["basic", "line break, trailing backslash", "one\\\ntwo\n", has(/one<br>\s*two/)],
  ["basic", "bold, asterisks", "**bold**", has(/<strong>bold<\/strong>/)],
  ["basic", "bold, underscores", "__bold__", has(/<strong>bold<\/strong>/)],
  ["basic", "italic, asterisks", "*italic*", has(/<em>italic<\/em>/)],
  ["basic", "italic, underscores", "_italic_", has(/<em>italic<\/em>/)],
  ["basic", "bold and italic, asterisks", "***both***", has(/<em><strong>both<\/strong><\/em>|<strong><em>both<\/em><\/strong>/)],
  ["basic", "bold and italic, underscores", "___both___", has(/<em><strong>both<\/strong><\/em>|<strong><em>both<\/em><\/strong>/)],
  ["basic", "blockquote", "> quoted\n", has(/<blockquote>\s*<p>quoted<\/p>/)],
  ["basic", "blockquote, several paragraphs", "> one\n>\n> two\n",
    has(/<blockquote>[\s\S]*<p>one<\/p>[\s\S]*<p>two<\/p>[\s\S]*<\/blockquote>/)],
  ["basic", "blockquote, nested", "> outer\n>\n>> inner\n",
    has(/<blockquote>[\s\S]*<blockquote>[\s\S]*inner/)],
  ["basic", "blockquote with other elements", "> ### Heading\n>\n> - item\n",
    has(/<blockquote>[\s\S]*<h3[^>]*>Heading<\/h3>[\s\S]*<li>item<\/li>/)],
  ["basic", "ordered list", "1. one\n2. two\n", has(/<ol>[\s\S]*<li>one<\/li>[\s\S]*<li>two<\/li>/)],
  ["basic", "ordered list, non-sequential numbers", "1. one\n1. two\n1. three\n",
    has(/<ol>[\s\S]*<li>one<\/li>[\s\S]*<li>three<\/li>/)],
  ["basic", "ordered list, offset start", "5. five\n6. six\n", has(/<ol start="5">/)],
  ["basic", "unordered list, dash", "- one\n- two\n", has(/<ul>[\s\S]*<li>one<\/li>/)],
  ["basic", "unordered list, asterisk", "* one\n* two\n", has(/<ul>[\s\S]*<li>one<\/li>/)],
  ["basic", "unordered list, plus", "+ one\n+ two\n", has(/<ul>[\s\S]*<li>one<\/li>/)],
  ["basic", "nested list", "- one\n  - nested\n", has(/<li>one[\s\S]*<ul>[\s\S]*<li>nested<\/li>/)],
  ["basic", "paragraph inside a list item", "- one\n\n  second paragraph\n",
    has(/<li>[\s\S]*<p>one<\/p>[\s\S]*<p>second paragraph<\/p>/)],
  ["basic", "inline code", "use `code` here", has(/<code>code<\/code>/)],
  ["basic", "inline code containing a backtick", "``a ` b``", has(/<code>a ` b<\/code>/)],
  ["basic", "indented code block", "    indented\n", has(/<pre><code>indented/)],
  ["basic", "horizontal rule, asterisks", "a\n\n***\n\nb\n", has(/<hr>/)],
  ["basic", "horizontal rule, dashes", "a\n\n---\n\nb\n", has(/<hr>/)],
  ["basic", "horizontal rule, underscores", "a\n\n___\n\nb\n", has(/<hr>/)],
  ["basic", "link, inline", "[text](https://example.com)", has(/<a href="https:\/\/example\.com"[^>]*>text<\/a>/)],
  ["basic", "link, with title", '[text](https://example.com "Title")', has(/title="Title"/)],
  ["basic", "URL in angle brackets", "<https://example.com>", has(/<a href="https:\/\/example\.com"[^>]*>https:\/\/example\.com<\/a>/)],
  ["basic", "email in angle brackets", "<a@example.com>", has(/<a href="mailto:a@example\.com"/)],
  ["basic", "formatted link text", "[**bold** link](https://example.com)", has(/<a [^>]*><strong>bold<\/strong> link<\/a>/)],
  ["basic", "reference-style link", "[text][ref]\n\n[ref]: https://example.com\n",
    has(/<a href="https:\/\/example\.com"[^>]*>text<\/a>/)],
  ["basic", "image", "![alt](img.png)", has(/<img src="img\.png" alt="alt">/)],
  ["basic", "image, with title", '![alt](img.png "Title")', has(/title="Title"/)],
  ["basic", "linked image", "[![alt](img.png)](https://example.com)", has(/<a [^>]*><img [^>]*><\/a>/)],
  ["basic", "escaped characters", "\\*not italic\\*", has(/\*not italic\*/)],
  ["basic", "inline HTML", "a <kbd>Ctrl</kbd> b", has(/<kbd>Ctrl<\/kbd>/)],
  ["basic", "block HTML", "<div>\nraw\n</div>\n", has(/<div>[\s\S]*raw/)],

  // ------------------------------------------------------------- extended
  ["extended", "table", "| a | b |\n| --- | --- |\n| 1 | 2 |\n",
    has(/<table>[\s\S]*<th>a<\/th>[\s\S]*<td>1<\/td>/)],
  ["extended", "table alignment", "| l | c | r |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |\n",
    has(/text-align:left[\s\S]*text-align:center[\s\S]*text-align:right/)],
  ["extended", "fenced code block", "```\ncode\n```\n", has(/<pre><code>code/)],
  ["extended", "fenced code block with language", "```json\n{}\n```\n", has(/class="language-json"/)],
  ["extended", "footnote", "Text.[^1]\n\n[^1]: The note.\n", has(/<sup|footnote/i)],
  ["extended", "heading ID", "### Heading {#custom-id}\n", has(/<h3 id="custom-id">/)],
  ["extended", "automatic heading ID", "### My Great Heading\n", has(/<h3 id="my-great-heading">/)],
  ["extended", "linking to a heading ID", "# Heading IDs\n\n[go](#heading-ids)\n",
    has(/<h1 id="heading-ids">[\s\S]*href="#heading-ids"/)],
  // DOMPurify drops ids that name a property of `document`, as a defence
  // against DOM clobbering. A heading cannot clobber, so the anchor must
  // survive -- `# Images` losing its id made a table of contents go dead.
  ["extended", "heading ID that names a DOM property", "# Images\n", has(/<h1 id="images">/)],
  ["extended", "duplicate headings get distinct IDs", "# Same\n\n# Same\n",
    has(/<h1 id="same">[\s\S]*<h1 id="same-1">/)],
  ["extended", "definition list", "Term\n: Definition\n", has(/<dl>[\s\S]*<dt>Term<\/dt>[\s\S]*<dd>Definition<\/dd>/)],
  ["extended", "strikethrough", "~~struck~~", has(/<s>struck<\/s>|<del>struck<\/del>/)],
  ["extended", "task list", "- [x] done\n- [ ] to do\n", has(/task-item[\s\S]*task-check/)],
  ["extended", "emoji shortcode", "camping :tent:", has(/⛺|<img[^>]*emoji/)],
  ["extended", "highlight", "==important==", has(/<mark>important<\/mark>/)],
  ["extended", "subscript", "H~2~O", has(/H<sub>2<\/sub>O/)],
  ["extended", "superscript", "X^2^", has(/X<sup>2<\/sup>/)],
  ["extended", "automatic URL linking", "https://example.com", has(/<a href="https:\/\/example\.com"/)],
  ["extended", "automatic linking disabled by code span", "`https://example.com`",
    has(/<code>https:\/\/example\.com<\/code>/)],
];

/* --- Run the engine in a browser ---------------------------------------- */

const entry = `
import { renderMarkdown, toDoc, toMarkdown } from ${JSON.stringify(resolve(root, "src/markdown.js"))};
window.__render = renderMarkdown;
window.__trip = (src) => {
  try { return { ok: true, out: toMarkdown(toDoc(src)) }; }
  catch (e) { return { ok: false, out: String(e && e.message || e) }; }
};
`;

const built = await esbuild.build({
  stdin: { contents: entry, resolveDir: root, loader: "js" },
  bundle: true, format: "iife", target: ["es2021"], charset: "utf8",
  write: false, logLevel: "error",
});

const html = `<!doctype html><meta charset="utf-8"><body><script>${
  built.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")
}</script></body>`;

const browser = await puppeteer.launch({
  headless: "shell",
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const tab = await browser.newPage();
await tab.setContent(html, { waitUntil: "domcontentloaded" });

/* --- Evaluate ------------------------------------------------------------ */

const norm = (h) => h.replace(/\s+/g, " ").trim();
const rows = [];

for (const [section, name, src, expected] of CASES) {
  const rendered = await tab.evaluate((s) => window.__render(s), src);
  const renders = expected(rendered);

  const trip = await tab.evaluate((s) => window.__trip(s), src);
  let roundtrip;
  if (!trip.ok) {
    roundtrip = "THROWS";
  } else {
    const after = await tab.evaluate((s) => window.__render(s), trip.out);
    roundtrip = norm(after) === norm(rendered) ? "kept" : "changed";
  }

  rows.push({ section, name, renders, roundtrip, rendered, regenerated: trip.out });
}

await browser.close();

/* --- Report -------------------------------------------------------------- */

const pad = (s, n) => String(s).padEnd(n);
let unsupported = 0, lost = 0;

for (const section of ["basic", "extended"]) {
  console.log(`\n--- ${section} syntax ---\n`);
  console.log(`  ${pad("construct", 44)} ${pad("renders", 9)} round trip`);
  console.log(`  ${"-".repeat(44)} ${"-".repeat(9)} ----------`);

  for (const r of rows.filter((x) => x.section === section)) {
    if (!r.renders) unsupported++;
    if (r.renders && r.roundtrip !== "kept") lost++;
    console.log(`  ${pad(r.name, 44)} ${pad(r.renders ? "yes" : "NO", 9)} ${r.renders ? r.roundtrip : "-"}`);
  }
}

console.log("\n--- detail for anything not rendered as documented ---\n");
for (const r of rows.filter((x) => !x.renders)) {
  console.log(`  ${r.name}`);
  console.log(`      produced: ${norm(r.rendered).slice(0, 110)}`);
}

console.log("\n--- detail for anything the round trip changes ---\n");
for (const r of rows.filter((x) => x.renders && x.roundtrip !== "kept")) {
  console.log(`  ${r.name}  [${r.roundtrip}]`);
  console.log(`      regenerated source: ${JSON.stringify(r.regenerated).slice(0, 110)}`);
}

console.log(`\n  ${rows.length} constructs -- ${unsupported} not implemented, ${lost} altered by the round trip\n`);
