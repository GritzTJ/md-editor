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
import markPlugin from "markdown-it-mark";
import subPlugin from "markdown-it-sub";
import supPlugin from "markdown-it-sup";
import deflistPlugin from "markdown-it-deflist";
import footnotePlugin from "markdown-it-footnote";
import { full as emojiPlugin } from "markdown-it-emoji";
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

/**
 * Turn heading text into an anchor, the way GitHub does: lower case, keep
 * letters and digits from any alphabet, drop punctuation, spaces become
 * hyphens. Accented characters are kept, so `Fonctionnalités étendues` stays
 * `fonctionnalités-étendues` and matches the link a document would already
 * contain.
 */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Plain text of an inline token, markers stripped. */
function inlineText(token) {
  let out = "";
  for (const child of token.children || []) {
    if (child.type === "text" || child.type === "code_inline") out += child.content;
  }
  return out;
}

/**
 * Heading identifiers, explicit and automatic.
 *
 * Explicit is `### Heading {#custom-id}`. Handled by hand rather than with a
 * general attributes plugin, which would accept arbitrary `{key=value}` pairs
 * on any element: DOMPurify would strip the dangerous ones, but a rule that
 * only ever sets `id`, and only on a heading, leaves nothing to strip.
 *
 * Automatic is what GitHub, GitLab, Pandoc and the static site generators all
 * do: derive an anchor from the heading text so a table of contents works
 * without the author writing anything. Those tools are one-way converters and
 * never touch the source, which is why the distinction below matters here and
 * not for them -- see the `autoId` flag, and how the parser reads it.
 */
function headingIdsPlugin(md) {
  const EXPLICIT = /\s*\{#([A-Za-z0-9_-]+)\}\s*$/;

  md.core.ruler.after("inline", "heading_ids", (state) => {
    const tokens = state.tokens;
    const used = new Map();

    for (let i = 0; i < tokens.length - 1; i++) {
      if (tokens[i].type !== "heading_open") continue;

      const inline = tokens[i + 1];
      if (!inline || inline.type !== "inline") continue;

      const explicit = EXPLICIT.exec(inline.content);
      let id;

      if (explicit) {
        id = explicit[1];
        inline.content = inline.content.replace(EXPLICIT, "");

        // The heading text is already split into child tokens, so the marker
        // has to be removed from the last one as well or it would still render.
        const kids = inline.children || [];
        for (let j = kids.length - 1; j >= 0; j--) {
          if (kids[j].type === "text") {
            kids[j].content = kids[j].content.replace(EXPLICIT, "");
            break;
          }
        }
      } else {
        id = slugify(inlineText(inline));
        if (!id) continue;
      }

      // Two headings with the same text would otherwise share an anchor and
      // every link would land on the first. Explicit identifiers take part in
      // the same count, so they cannot be shadowed either.
      const seen = used.get(id) || 0;
      used.set(id, seen + 1);

      tokens[i].attrSet("id", seen ? `${id}-${seen}` : id);
      tokens[i].meta = { ...(tokens[i].meta || null), autoId: !explicit };
    }
    return true;
  });
}

/**
 * Turn emoji tokens into plain text.
 *
 * The plugin already resolved `:tent:` to the character; keeping a distinct
 * token type would mean carrying a node through the whole ProseMirror schema
 * for something that is, in the end, just text. The cost is that the shortcode
 * is not restored when the source is regenerated -- the character stays.
 */
function emojiAsTextPlugin(md) {
  md.core.ruler.push("emoji_as_text", (state) => {
    for (const token of state.tokens) {
      if (token.type !== "inline" || !token.children) continue;
      for (const child of token.children) {
        if (child.type === "emoji") child.type = "text";
      }
    }
    return true;
  });
}

// `html: true` preserves the original behaviour: raw HTML written in the
// Markdown is interpreted, then sanitised by DOMPurify. Turning it off would
// simplify life but break existing documents.
//
// `linkify` turns a bare URL into a link, as the guide documents. It reads the
// text already in the document and adds no request of its own: an anchor is
// only followed if the user clicks it, and then with no referrer.
export const md = MarkdownIt("default", {
  html: true,
  linkify: true,
  typographer: false,
  breaks: false,
})
  .use(taskListPlugin)
  .use(headingIdsPlugin)
  .use(markPlugin)
  .use(subPlugin)
  .use(supPlugin)
  .use(deflistPlugin)
  .use(footnotePlugin)
  .use(emojiPlugin)
  .use(emojiAsTextPlugin);

/* ===========================================================================
 * 2. HTML rendering for the read-only preview
 * ======================================================================== */

// Links open in a new tab with no referrer: the target site must learn nothing
// about the document being edited.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName !== "A" || !node.hasAttribute("href")) return;

  // Except in-document anchors -- footnote references and their back-links.
  // Sending those to a new tab would be nonsense, and there is no third party
  // to keep in the dark.
  if (node.getAttribute("href").startsWith("#")) return;

  node.setAttribute("target", "_blank");
  node.setAttribute("rel", "noopener noreferrer");
});

/**
 * Keep the identifier on headings.
 *
 * DOMPurify drops any `id` whose value names an existing property of
 * `document` -- a defence against DOM clobbering. It applies that test whatever
 * the element, so an ordinary `# Images` heading lost its anchor because
 * `document.images` exists, and the table of contents pointing at it went dead.
 *
 * Only `embed`, `form`, `iframe`, `img` and `object` can contribute named
 * properties to `document`; a heading cannot clobber anything. The exception is
 * therefore limited to h1-h6, and the protection stays in force everywhere
 * else. The values are safe by construction: `slugify` emits nothing but
 * letters, digits and hyphens, and an explicit identifier is matched against
 * the same restricted set.
 */
DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
  if (data.attrName === "id" && /^H[1-6]$/.test(node.tagName)) {
    data.forceKeepAttr = true;
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

/* --- definition lists ---------------------------------------------------- */

const definitionList = {
  group: "block",
  content: "(definition_term | definition_description)+",
  parseDOM: [{ tag: "dl" }],
  toDOM: () => ["dl", 0],
};

const definitionTerm = {
  content: "inline*",
  defining: true,
  parseDOM: [{ tag: "dt" }],
  toDOM: () => ["dt", 0],
};

const definitionDescription = {
  content: "block+",
  defining: true,
  parseDOM: [{ tag: "dd" }],
  toDOM: () => ["dd", 0],
};

/* --- footnotes ------------------------------------------------------------
 * A reference is an inline atom, and each definition is a block that lands at
 * the end of the document -- which is where Markdown puts them anyway, so the
 * two serialise back into place without any bookkeeping.
 * ---------------------------------------------------------------------- */

const footnoteRef = {
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  attrs: { label: { default: "1" } },
  toDOM: (node) => ["sup", {
    class: "footnote-ref",
    title: `Footnote ${node.attrs.label}`,
  }, `[${node.attrs.label}]`],
  parseDOM: [{
    tag: "sup.footnote-ref",
    getAttrs: (dom) => ({ label: (dom.textContent || "").replace(/[[\]]/g, "") || "1" }),
  }],
};

const footnoteDefinition = {
  group: "block",
  content: "block+",
  defining: true,
  attrs: { label: { default: "1" } },
  toDOM: (node) => ["div", { class: "footnote-def", "data-label": node.attrs.label },
    ["span", { class: "footnote-def-label", contenteditable: "false" }, `[^${node.attrs.label}]:`],
    ["div", { class: "footnote-def-body" }, 0],
  ],
  parseDOM: [{
    tag: "div.footnote-def",
    getAttrs: (dom) => ({ label: dom.getAttribute("data-label") || "1" }),
    contentElement: ".footnote-def-body",
  }],
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
  .addToEnd("highlight", {
    parseDOM: [{ tag: "mark" }],
    toDOM: () => ["mark", 0],
  })
  .addToEnd("subscript", {
    parseDOM: [{ tag: "sub" }],
    toDOM: () => ["sub", 0],
    excludes: "superscript",
  })
  .addToEnd("superscript", {
    parseDOM: [{ tag: "sup" }],
    toDOM: () => ["sup", 0],
    excludes: "subscript",
  })
  .addToStart("link", baseSchema.spec.marks.get("link"));

// `id` holds only what the author wrote as `{#custom-id}`. An anchor is still
// rendered for every heading, derived from its text at display time -- the same
// split the preview makes, and the reason editing never adds identifiers to the
// source.
const heading = {
  ...baseSchema.spec.nodes.get("heading"),
  attrs: { level: { default: 1 }, id: { default: null } },
  toDOM(node) {
    const id = node.attrs.id || slugify(node.textContent);
    return [`h${node.attrs.level}`, id ? { id } : {}, 0];
  },
  parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
    tag: `h${level}`,
    getAttrs: (dom) => ({ level, id: dom.getAttribute("id") || null }),
  })),
};

export const schema = new Schema({
  nodes: baseSchema.spec.nodes
    .update("heading", heading)
    .update("list_item", listItem)
    .append(tables)
    .addToEnd("definition_list", definitionList)
    .addToEnd("definition_term", definitionTerm)
    .addToEnd("definition_description", definitionDescription)
    .addToEnd("footnote_ref", footnoteRef)
    .addToEnd("footnote_definition", footnoteDefinition)
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
  heading: {
    block: "heading",
    getAttrs: (tok) => ({
      level: +tok.tag.slice(1),
      // Only an identifier the author actually wrote is kept in the model.
      // Storing a generated one would write `{#slug}` into every heading the
      // first time the rendered document is edited -- text nobody typed.
      id: tok.meta && tok.meta.autoId ? null : tok.attrGet("id"),
    }),
  },
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
  mark: { mark: "highlight" },
  sub: { mark: "subscript" },
  sup: { mark: "superscript" },
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

  dl: { block: "definition_list" },
  dt: { block: "definition_term" },
  dd: { block: "definition_description" },

  // The block wrapper carries nothing: dropping it leaves each definition as a
  // top-level block at the end of the document, which is where the serialiser
  // needs them anyway. The anchor is the generated back-link, not content.
  footnote_block: { ignore: true },
  footnote_anchor: { ignore: true, noCloseToken: true },
  footnote_ref: { node: "footnote_ref", getAttrs: (tok) => ({ label: tok.meta.label }) },
  footnote: { block: "footnote_definition", getAttrs: (tok) => ({ label: tok.meta.label }) },

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

/**
 * `Term` on its own line, then `: description`.
 *
 * Written by hand like the table serialiser: the term is a bare line with no
 * marker, which the generic block machinery has no way to express.
 */
function serializeDefinitionList(state, node) {
  state.flushClose();

  node.forEach((child, _offset, index) => {
    if (child.type === schema.nodes.definition_term) {
      // A term following a description opens a new group, which Markdown
      // separates with a blank line -- without it the term is read back as more
      // of the previous definition. Consecutive terms sharing one definition
      // need no separation, and get none: `flushClose` only writes when a block
      // was actually closed, which a term never does.
      if (index) state.flushClose(2);
      state.write("");
      state.renderInline(child);
      state.ensureNewLine();
    } else {
      state.wrapBlock("  ", ": ", child, () => state.renderContent(child));
    }
  });

  state.closeBlock(node);
}

export const serializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,

    heading(state, node) {
      state.write(state.repeat("#", node.attrs.level) + " ");
      state.renderInline(node, false);
      if (node.attrs.id) state.text(` {#${node.attrs.id}}`, false);
      state.closeBlock(node);
    },

    definition_list: serializeDefinitionList,
    // Terms and descriptions are handled entirely by serializeDefinitionList.
    definition_term: () => {},
    definition_description: () => {},

    footnote_ref(state, node) {
      state.text(`[^${node.attrs.label}]`, false);
    },

    footnote_definition(state, node) {
      state.wrapBlock("    ", `[^${node.attrs.label}]: `, node,
        () => state.renderContent(node));
    },

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
    highlight: {
      open: "==",
      close: "==",
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    // No `expelEnclosingWhitespace` on these two: `H~2~O` has no space to
    // expel, and the delimiters are single characters that must stay tight
    // against the text or the parser will not see them.
    subscript: { open: "~", close: "~", mixable: true },
    superscript: { open: "^", close: "^", mixable: true },
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
