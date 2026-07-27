/* ---------------------------------------------------------------------------
 * Moteur Markdown partage.
 *
 * Un seul analyseur (markdown-it) sert a la fois l'apercu en lecture et
 * l'editeur riche : ce qui s'affiche et ce qui s'edite viennent donc du meme
 * arbre, et ne peuvent pas diverger.
 *
 * L'enjeu de ce fichier est l'aller-retour. Editer en mode riche regenere la
 * source depuis le modele ProseMirror ; tout ce que le schema ne sait pas
 * representer serait donc perdu silencieusement. D'ou trois ajouts au schema
 * de base de prosemirror-markdown, qui ne couvre que CommonMark :
 *
 *   - tableaux, cases a cocher et barre (ce que l'apercu affichait deja) ;
 *   - html_block / html_inline, qui conservent le HTML brut tel quel plutot
 *     que de le laisser disparaitre au premier aller-retour.
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
 * 1. Analyseur markdown-it
 * ======================================================================== */

/**
 * Reconnait les cases a cocher GFM (`- [ ]` / `- [x]`).
 *
 * markdown-it ne les gere pas d'origine. Plutot que d'injecter du HTML dans
 * le flux de jetons -- ce qui obligerait ensuite a le re-analyser pour
 * l'editeur riche -- on marque le jeton `list_item_open` d'un attribut et on
 * retire le marqueur du texte. L'apercu et ProseMirror lisent alors la meme
 * information a la source.
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

      // Le contenu est deja decoupe en jetons enfants : retirer le marqueur du
      // seul `inline.content` ne suffirait pas au rendu.
      const first = inline.children && inline.children[0];
      if (first && first.type === "text") {
        first.content = first.content.replace(MARKER, "");
      }
    }
    return true;
  });

  // La case est dessinee en CSS plutot qu'avec un <input> : cela evite
  // d'autoriser une balise de formulaire dans l'assainissement. Le marqueur
  // <span> est emis ici pour que l'apercu et l'editeur riche partagent
  // exactement la meme structure, et donc les memes regles de style.
  md.renderer.rules.list_item_open = (tokens, idx, options, env, self) => {
    const checked = tokens[idx].attrGet("data-checked");
    if (checked === null) return self.renderToken(tokens, idx, options);

    tokens[idx].attrJoin("class", "task-item");
    return self.renderToken(tokens, idx, options) + '<span class="task-check"></span>';
  };
}

// `html: true` conserve le comportement d'origine : le HTML brut ecrit dans le
// Markdown est interprete, puis assaini par DOMPurify. Le desactiver
// simplifierait la vie mais casserait les documents existants.
export const md = MarkdownIt("default", {
  html: true,
  linkify: false,
  typographer: false,
  breaks: false,
}).use(taskListPlugin);

/* ===========================================================================
 * 2. Rendu HTML pour l'apercu en lecture
 * ======================================================================== */

// Les liens du document s'ouvrent dans un nouvel onglet sans referrer : le site
// cible ne doit rien apprendre du document en cours d'edition.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.hasAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const PURIFY_CONFIG = {
  // <style> injecterait des regles dans toute la page, et un formulaire donne
  // l'illusion d'une saisie legitime : ni l'un ni l'autre n'a sa place dans un
  // apercu de document.
  FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select"],
  FORBID_ATTR: ["srcset", "ping", "formaction"],
  ALLOW_DATA_ATTR: true, // requis par data-checked sur les cases a cocher
};

export function renderMarkdown(src) {
  let html;
  try {
    html = md.render(src);
  } catch (err) {
    const p = document.createElement("p");
    p.textContent = "Erreur d'analyse Markdown : " + err.message;
    return p.outerHTML;
  }
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}

/* ===========================================================================
 * 3. Schema ProseMirror
 * ======================================================================== */

// Les cellules contiennent de l'inline et non des blocs : une cellule GFM ne
// peut de toute facon pas accueillir de paragraphes multiples.
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

// `checked` vaut null pour une puce ordinaire, false ou true pour une tache.
// Le corps est enveloppe pour que la case dessinee reste hors du flux
// editable, sans quoi le curseur pourrait s'y placer.
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

// Le HTML brut est conserve mot pour mot dans un noeud atomique. Il n'est pas
// modifiable en mode riche -- le rendre editable reviendrait a reconstruire un
// editeur HTML -- mais il traverse l'aller-retour intact, ce qui est le point
// important.
const htmlBlock = {
  group: "block",
  atom: true,
  selectable: true,
  attrs: { content: { default: "" } },
  toDOM: (node) => ["pre", {
    class: "raw-html",
    title: "HTML brut : conserve tel quel, non modifiable ici",
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
    title: "HTML brut : conserve tel quel, non modifiable ici",
  }, node.attrs.content],
  parseDOM: [{ tag: "span.raw-html-inline", getAttrs: (dom) => ({ content: dom.textContent }) }],
};

export const schema = new Schema({
  nodes: baseSchema.spec.nodes
    .update("list_item", listItem)
    .append(tables)
    .addToEnd("html_block", htmlBlock)
    .addToEnd("html_inline", htmlInline),
  marks: baseSchema.spec.marks.addToEnd("strikethrough", {
    parseDOM: [{ tag: "s" }, { tag: "del" }, { tag: "strike" }],
    toDOM: () => ["s", 0],
  }),
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

  // markdown-it enveloppe les lignes dans thead/tbody, que le schema de
  // ProseMirror ne connait pas : la table y contient directement ses lignes.
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
 * Serialise le contenu inline d'une cellule.
 *
 * Le serialiseur n'expose pas de rendu isole : on ecrit donc dans son tampon
 * puis on le rembobine. Les barres verticales sont echappees et les retours a
 * la ligne aplatis, faute de quoi la cellule romprait la table GFM.
 *
 * Le delimiteur courant est neutralise pendant l'operation : a l'interieur
 * d'une citation ou d'une liste il serait sinon recopie au debut de chaque
 * cellule, le serialiseur croyant commencer une ligne.
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
  // La separation d'avec le bloc precedent doit etre ecrite maintenant : elle
  // serait sinon emise pendant le rendu des cellules, puis effacee par le
  // rembobinage de `cellMarkdown` -- et le tableau viendrait se coller au
  // paragraphe ou a la liste qui le precede.
  state.flushClose();

  const rows = [];
  node.forEach((row) => {
    const cells = [];
    row.forEach((cell) => cells.push(cellMarkdown(state, cell)));
    rows.push(cells);
  });
  if (!rows.length) return;

  // GFM impose une ligne d'en-tete : si le tableau n'en a pas, on en emet une
  // vide plutot que de produire une table que personne ne saura relire.
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

/** Prefixe d'un element de liste, case a cocher comprise. */
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
    // Les lignes et cellules sont entierement prises en charge par
    // serializeTable ; les atteindre isolement signalerait un bug.
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

/** Markdown -> document ProseMirror. */
export function toDoc(markdown) {
  return parser.parse(markdown);
}

/** Document ProseMirror -> Markdown. */
export function toMarkdown(doc) {
  return serializer.serialize(doc, { tightLists: true });
}
