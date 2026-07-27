/* ---------------------------------------------------------------------------
 * Shared Markdown engine.
 *
 * A single parser (markdown-it) serves both the read-only preview and the rich
 * editor: what is displayed and what is edited come from the same tree, so they
 * cannot drift apart.
 *
 * The hard part here is the round trip. Editing in rich mode regenerates the
 * source from the model, so anything the schema cannot represent would be lost
 * silently. Hence three additions to prosemirror-markdown's base schema, which
 * only covers CommonMark:
 *
 *   - tables, task checkboxes and strikethrough (what the preview already
 *     displayed);
 *   - html_block / html_inline, which keep raw HTML verbatim rather than
 *     letting it vanish on the first round trip.
 * ------------------------------------------------------------------------- */

import MarkdownIt from "markdown-it";
import { Schema } from "prosemirror-model";
import {
  schema as baseSchema,
  MarkdownParser,
  MarkdownSerializer,
  defaultMarkdownSerializer,
} from "prosemirror-markdown";
import { tableNodes } from "prosemirror-tables";
import DOMPurify from "dompurify";

/* ===========================================================================
 * 1. markdown-it parser
 * ======================================================================== */

/**
 * Recognise GFM task checkboxes (`- [ ]` / `- [x]`).
 *
 * markdown-it does not handle them out of the box. Rather than injecting HTML
 * into the token stream -- which would then have to be re-parsed for the rich
 * editor -- we tag the `list_item_open` token with an attribute and strip the
 * marker from the text. Preview and ProseMirror then read the same fact from
 * the same place.
 */
function taskListPlugin(md) {
  const MARKER = /^\[([ xX])\]\s+/;

  md.core.ruler.after("inline", "task_lists", (state) => {
    const tokens = state.tokens;

    for (let i = 0; i < tokens.length - 2; i++) {
      if (tokens[i].type !== "list_item_open") continue;
      if (tokens[i + 1].type !== "paragraph_open") continue;

      const inline = tokens[i + 2];
      if (inline.type !== "inline") continue;

      const match = MARKER.exec(inline.content);
      if (!match) continue;

      tokens[i].attrSet("data-checked", match[1] === " " ? "false" : "true");
      inline.content = inline.content.slice(match[0].length);

      // The content is already split into child tokens: stripping the marker
      // from `inline.content` alone would not affect rendering.
      const first = inline.children && inline.children[0];
      if (first && first.type === "text") {
        first.content = first.content.replace(MARKER, "");
      }
    }
    return true;
  });

  // The box is drawn in CSS rather than with an <input>, which avoids having to
  // allow a form tag through sanitisation. The <span> marker is emitted here so
  // that preview and rich editor share exactly the same structure, and
  // therefore the same style rules.
  md.renderer.rules.list_item_open = (tokens, idx, options, env, self) => {
    const checked = tokens[idx].attrGet("data-checked");
    if (checked === null) return self.renderToken(tokens, idx, options);

    tokens[idx].attrJoin("class", "task-item");
    return self.renderToken(tokens, idx, options) + '<span class="task-check"></span>';
  };
}

// `html: true` preserves the original behaviour: raw HTML written in the
// Markdown is interpreted, then sanitised by DOMPurify. Turning it off would
// simplify life but break existing documents.
export const md = MarkdownIt("default", {
  html: true,
  linkify: false,
  typographer: false,
  breaks: false,
}).use(taskListPlugin);

/* ===========================================================================
 * 2. HTML rendering for the read-only preview
 * ======================================================================== */

// Links open in a new tab with no referrer: the target site must learn nothing
// about the document being edited.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.hasAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const PURIFY_CONFIG = {
  // <style> would inject rules into the whole page, and a form gives the
  // illusion of a legitimate input: neither belongs in a document preview.
  FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select"],
  FORBID_ATTR: ["srcset", "ping", "formaction"],
  ALLOW_DATA_ATTR: true, // required by data-checked on task items
};

export function renderMarkdown(src) {
  let html;
  try {
    html = md.render(src);
  } catch (err) {
    const p = document.createElement("p");
    p.textContent = "Markdown parse error: " + err.message;
    return p.outerHTML;
  }
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}

/* ===========================================================================
 * 3. ProseMirror schema
 * ======================================================================== */

// Cells hold inline content, not blocks: a GFM cell cannot contain multiple
// paragraphs anyway.
const tables = tableNodes({
  tableGroup: "block",
  cellContent: "inline*",
  cellAttributes: {
    align: {
      default: null,
      getFromDOM: (dom) => dom.style.textAlign || null,
      setDOMAttr: (value, attrs) => {
        if (value) attrs.style = `text-align:${value}`;
      },
    },
  },
});

// `checked` is null for a plain bullet, false or true for a task. The body is
// wrapped so the drawn checkbox stays outside the editable flow, where the
// cursor could otherwise land.
const listItem = {
  content: "block+",
  defining: true,
  attrs: { checked: { default: null } },
  parseDOM: [{
    tag: "li",
    getAttrs: (dom) => {
      const raw = dom.getAttribute("data-checked");
      return { checked: raw === null ? null : raw === "true" };
    },
  }],
  toDOM(node) {
    if (node.attrs.checked === null) return ["li", 0];
    return ["li",
      { class: "task-item", "data-checked": String(node.attrs.checked) },
      ["span", { class: "task-check", contenteditable: "false" }],
      ["div", { class: "task-body" }, 0],
    ];
  },
};

// Raw HTML is kept word for word inside an atomic node. It is not editable in
// rich mode -- making it editable would mean building an HTML editor -- but it
// survives the round trip intact, which is the point.
const htmlBlock = {
  group: "block",
  atom: true,
  selectable: true,
  attrs: { content: { default: "" } },
  toDOM: (node) => ["pre", {
    class: "raw-html",
    title: "Raw HTML: kept verbatim, not editable here",
  }, node.attrs.content],
  parseDOM: [{ tag: "pre.raw-html", getAttrs: (dom) => ({ content: dom.textContent }) }],
};

const htmlInline = {
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  attrs: { content: { default: "" } },
  toDOM: (node) => ["span", {
    class: "raw-html-inline",
    title: "Raw HTML: kept verbatim, not editable here",
  }, node.attrs.content],
  parseDOM: [{ tag: "span.raw-html-inline", getAttrs: (dom) => ({ content: dom.textContent }) }],
};

// Mark order decides nesting when marks overlap: the earliest in the schema is
// the outermost. The base order puts `strong` before `link`, which turns
// `[**bold** text](url)` into two separate links -- the bold part wrapping its
// own link, then a second link for the rest. Moving `link` to the front keeps
// it outside, so a partially emphasised link stays one link.
const marks = baseSchema.spec.marks
  .addToEnd("strikethrough", {
    parseDOM: [{ tag: "s" }, { tag: "del" }, { tag: "strike" }],
    toDOM: () => ["s", 0],
  })
  .addToStart("link", baseSchema.spec.marks.get("link"));

export const schema = new Schema({
  nodes: baseSchema.spec.nodes
    .update("list_item", listItem)
    .append(tables)
    .addToEnd("html_block", htmlBlock)
    .addToEnd("html_inline", htmlInline),
  marks,
});

/* ===========================================================================
 * 4. Markdown -> ProseMirror
 * ======================================================================== */

function alignOf(token) {
  const style = token.attrGet("style") || "";
  const match = /text-align:\s*(left|center|right)/.exec(style);
  return match ? match[1] : null;
}

function listIsTight(tokens, i) {
  while (++i < tokens.length) {
    if (tokens[i].type !== "list_item_open") return tokens[i].hidden;
  }
  return false;
}

export const parser = new MarkdownParser(schema, md, {
  blockquote: { block: "blockquote" },
  paragraph: { block: "paragraph" },
  list_item: {
    block: "list_item",
    getAttrs: (tok) => {
      const raw = tok.attrGet("data-checked");
      return { checked: raw === null ? null : raw === "true" };
    },
  },
  bullet_list: { block: "bullet_list", getAttrs: (_, tokens, i) => ({ tight: listIsTight(tokens, i) }) },
  ordered_list: {
    block: "ordered_list",
    getAttrs: (tok, tokens, i) => ({
      order: +tok.attrGet("start") || 1,
      tight: listIsTight(tokens, i),
    }),
  },
  heading: { block: "heading", getAttrs: (tok) => ({ level: +tok.tag.slice(1) }) },
  code_block: { block: "code_block", noCloseToken: true },
  fence: { block: "code_block", getAttrs: (tok) => ({ params: tok.info || "" }), noCloseToken: true },
  hr: { node: "horizontal_rule" },
  image: {
    node: "image",
    getAttrs: (tok) => ({
      src: tok.attrGet("src"),
      title: tok.attrGet("title") || null,
      alt: (tok.children[0] && tok.children[0].content) || null,
    }),
  },
  hardbreak: { node: "hard_break" },

  em: { mark: "em" },
  strong: { mark: "strong" },
  s: { mark: "strikethrough" },
  link: {
    mark: "link",
    getAttrs: (tok) => ({ href: tok.attrGet("href"), title: tok.attrGet("title") || null }),
  },
  code_inline: { mark: "code", noCloseToken: true },

  // markdown-it wraps rows in thead/tbody, which ProseMirror's schema knows
  // nothing about: there, a table holds its rows directly.
  table: { block: "table" },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: "table_row" },
  th: { block: "table_header", getAttrs: (tok) => ({ align: alignOf(tok) }) },
  td: { block: "table_cell", getAttrs: (tok) => ({ align: alignOf(tok) }) },

  html_block: { node: "html_block", getAttrs: (tok) => ({ content: tok.content }) },
  html_inline: { node: "html_inline", getAttrs: (tok) => ({ content: tok.content }) },
});

/* ===========================================================================
 * 5. ProseMirror -> Markdown
 * ======================================================================== */

/**
 * Serialise a cell's inline content.
 *
 * The serialiser exposes no isolated render, so we write into its buffer and
 * rewind. Pipes are escaped and newlines flattened, without which the cell
 * would break the GFM table.
 *
 * The current delimiter is neutralised for the duration: inside a block quote
 * or a list it would otherwise be copied to the start of every cell, the
 * serialiser believing it is starting a line.
 */
function cellMarkdown(state, cell) {
  const delim = state.delim;
  state.delim = "";

  const start = state.out.length;
  state.renderInline(cell);
  const text = state.out.slice(start);
  state.out = state.out.slice(0, start);

  state.delim = delim;
  return text.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

const ALIGN_RULE = { left: ":---", center: ":---:", right: "---:", null: "---" };

function serializeTable(state, node) {
  // The separation from the previous block has to be written now: it would
  // otherwise be emitted while rendering the cells, then wiped by
  // `cellMarkdown`'s rewind -- and the table would end up glued to the
  // paragraph or list before it.
  state.flushClose();

  const rows = [];
  node.forEach((row) => {
    const cells = [];
    row.forEach((cell) => cells.push(cellMarkdown(state, cell)));
    rows.push(cells);
  });
  if (!rows.length) return;

  // GFM requires a header row: if the table has none, emit an empty one rather
  // than produce a table nobody can read back.
  const firstRow = node.firstChild;
  const hasHeader = firstRow.firstChild &&
    firstRow.firstChild.type === schema.nodes.table_header;

  const width = Math.max(...rows.map((r) => r.length));
  const pad = (cells) => {
    const out = cells.slice();
    while (out.length < width) out.push("");
    return "| " + out.join(" | ") + " |";
  };

  const aligns = [];
  firstRow.forEach((cell) => aligns.push(ALIGN_RULE[cell.attrs.align] || "---"));
  while (aligns.length < width) aligns.push("---");

  const body = rows.slice(hasHeader ? 1 : 0);
  state.write(pad(hasHeader ? rows[0] : new Array(width).fill("")) + "\n");
  state.write("| " + aligns.join(" | ") + " |\n");
  for (const row of body) state.write(pad(row) + "\n");
  state.closeBlock(node);
}

/** Prefix of a list item, checkbox included. */
function itemPrefix(node, i, bullet) {
  const checked = node.child(i).attrs.checked;
  if (checked === null) return bullet;
  return bullet + (checked ? "[x] " : "[ ] ");
}

export const serializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,

    bullet_list(state, node) {
      state.renderList(node, "  ", (i) =>
        itemPrefix(node, i, (node.attrs.bullet || "-") + " "));
    },

    ordered_list(state, node) {
      const start = node.attrs.order || 1;
      const maxWidth = String(start + node.childCount - 1).length;
      const space = state.repeat(" ", maxWidth + 2);
      state.renderList(node, space, (i) => {
        const label = String(start + i);
        const nStr = state.repeat(" ", maxWidth - label.length) + label;
        return itemPrefix(node, i, nStr + ". ");
      });
    },

    table: serializeTable,
    // Rows and cells are handled entirely by serializeTable; reaching them on
    // their own would signal a bug.
    table_row: () => {},
    table_cell: () => {},
    table_header: () => {},

    html_block(state, node) {
      state.write(node.attrs.content.replace(/\n+$/, ""));
      state.closeBlock(node);
    },

    html_inline(state, node) {
      state.text(node.attrs.content, false);
    },
  },
  {
    ...defaultMarkdownSerializer.marks,
    strikethrough: {
      open: "~~",
      close: "~~",
      mixable: true,
      expelEnclosingWhitespace: true,
    },
  },
);

/** Markdown -> ProseMirror document. */
export function toDoc(markdown) {
  return parser.parse(markdown);
}

/** ProseMirror document -> Markdown. */
export function toMarkdown(doc) {
  return serializer.serialize(doc, { tightLists: true });
}
