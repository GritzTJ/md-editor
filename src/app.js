/* ---------------------------------------------------------------------------
 * md-editor -- editeur / visualiseur Markdown entierement cote client.
 *
 * Regle absolue de ce fichier : AUCUN acces reseau. Pas de fetch, pas de
 * XMLHttpRequest, pas de WebSocket, pas de balise <img> distante, pas de
 * police web. La CSP du document (`default-src 'none'; connect-src 'none'`)
 * transforme cette regle en garantie appliquee par le navigateur : meme si ce
 * script etait remplace par une version malveillante, il ne pourrait pas
 * sortir le contenu du document hors de l'onglet.
 *
 * Toute l'interface est construite en JS pour que le document HTML porteur
 * reste un squelette vide -- ce qui rend la reconstruction du fichier autonome
 * (bouton « Telecharger l'app ») triviale et sans risque de fuite de contenu.
 *
 * Le document est edite de deux facons : en source, dans CodeMirror, et en
 * rendu, dans ProseMirror. Le texte de CodeMirror fait toujours foi ; voir la
 * section « Synchronisation » pour le detail.
 * ------------------------------------------------------------------------- */

import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  syntaxHighlighting,
  HighlightStyle,
  indentOnInput,
  bracketMatching,
} from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";

import { renderMarkdown } from "./markdown.js";
import { createRichEditor } from "./rich.js";

/* ===========================================================================
 * Preferences locales
 *
 * Seules les preferences d'affichage sont ecrites d'office : elles ne
 * contiennent aucune donnee utilisateur. Le brouillon du document, lui, n'est
 * ecrit que si l'utilisateur coche explicitement « Brouillon local ».
 * ======================================================================== */

const KEY = {
  theme: "mdedit.theme",
  view: "mdedit.view",
  rich: "mdedit.rich",
  split: "mdedit.split",
  autosave: "mdedit.autosave",
  draft: "mdedit.draft",
  draftName: "mdedit.draftName",
};

// localStorage peut lever (mode prive, file:// verrouille, quota). Jamais
// d'exception propagee : l'editeur doit fonctionner meme sans stockage.
const store = {
  get(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); return true; } catch { return false; }
  },
  del(k) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  },
};

/* ===========================================================================
 * Coloration syntaxique du panneau source
 *
 * Les couleurs ne sont pas fixees ici mais deleguees a des classes CSS, ce qui
 * permet au theme clair/sombre de la feuille de style de les piloter.
 * ======================================================================== */

const mdHighlight = HighlightStyle.define([
  { tag: t.heading, class: "cm-md-heading" },
  { tag: t.processingInstruction, class: "cm-md-mark" },
  { tag: t.strong, class: "cm-md-strong" },
  { tag: t.emphasis, class: "cm-md-emphasis" },
  { tag: t.strikethrough, class: "cm-md-strike" },
  { tag: t.link, class: "cm-md-link" },
  { tag: t.url, class: "cm-md-url" },
  { tag: t.monospace, class: "cm-md-code" },
  { tag: t.quote, class: "cm-md-quote" },
  { tag: t.list, class: "cm-md-list" },
  { tag: t.contentSeparator, class: "cm-md-sep" },
  { tag: t.keyword, class: "cm-md-heading" },
  { tag: t.string, class: "cm-md-url" },
  { tag: t.comment, class: "cm-md-quote" },
  { tag: t.number, class: "cm-md-code" },
]);

const cmTheme = EditorView.theme({
  "&": { color: "var(--fg)", backgroundColor: "var(--bg)", height: "100%" },
  ".cm-content": { caretColor: "var(--accent)", padding: "12px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--bg-inset)" },
  ".cm-gutters": {
    backgroundColor: "var(--bg-alt)",
    color: "var(--fg-muted)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLineGutter": { backgroundColor: "var(--bg-inset)", color: "var(--fg)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--bg-inset) 45%, transparent)" },
  ".cm-scroller": { overflow: "auto" },
});

/* ===========================================================================
 * Etat de l'application
 * ======================================================================== */

const state = {
  fileHandle: null, // FileSystemFileHandle si l'API est disponible
  fileName: "sans-titre.md",
  savedText: "", // contenu de reference pour l'indicateur « modifie »
  autosave: store.get(KEY.autosave) === "1",
  richMode: store.get(KEY.rich) === "1",
};

const SAMPLE = `# Editeur Markdown local

Tout se passe **dans cet onglet**. Le serveur qui a livre cette page ne recoit
jamais le contenu que vous tapez : il n'y a aucun appel reseau dans le code, et
la politique de securite du document (\`connect-src 'none'\`) l'interdit au
niveau du navigateur.

## Deux facons d'editer

- [x] La source, a gauche, avec coloration syntaxique
- [x] Le rendu, a droite : activez **Edition** pour y ecrire directement
- [ ] Les deux reste~~nt~~ toujours synchronises

> Pour un document contenant des secrets, le mode le plus sur reste :
> telecharger l'application une fois, puis l'ouvrir en \`file://\`.

| Raccourci | Action |
| --- | --- |
| \`Ctrl\`+\`O\` | Ouvrir |
| \`Ctrl\`+\`S\` | Enregistrer |
| \`Ctrl\`+\`Maj\`+\`S\` | Enregistrer sous |

\`\`\`js
// Les blocs de code sont colores dans l'editeur comme dans l'apercu.
const secret = process.env.API_TOKEN;
\`\`\`
`;

/* ===========================================================================
 * Construction de l'interface
 * ======================================================================== */

const app = document.getElementById("app");

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function button(label, title, onclick, cls = "") {
  return el("button", { type: "button", class: cls, title, onclick, text: label });
}

// --- barre d'outils principale ---------------------------------------------

const btnOpen = button("Ouvrir", "Ouvrir un fichier Markdown (Ctrl+O)", doOpen);
const btnSave = button("Enregistrer", "Enregistrer (Ctrl+S)", doSave);
const btnSaveAs = button("Enregistrer sous", "Enregistrer sous (Ctrl+Maj+S)", doSaveAs);
const btnNew = button("Nouveau", "Vider l'editeur", doNew);

const viewButtons = {
  editor: button("Editeur", "Afficher uniquement la source", () => setView("editor")),
  split: button("Partage", "Afficher la source et le rendu", () => setView("split")),
  preview: button("Apercu", "Afficher uniquement le rendu", () => setView("preview")),
};
const segView = el("div", { class: "seg", role: "group", "aria-label": "Mode d'affichage" },
  viewButtons.editor, viewButtons.split, viewButtons.preview);

const btnRich = button("Edition", "Ecrire directement dans le document rendu", toggleRich);

const btnExport = button("Exporter HTML", "Enregistrer le rendu en HTML autonome", doExportHtml);
const btnStandalone = button("Telecharger l'app",
  "Enregistrer cette application en un fichier HTML utilisable hors ligne", doDownloadApp);
const btnTheme = button("Theme", "Basculer clair / sombre", toggleTheme);
const btnAbout = button("?", "Securite et fonctionnement", showAbout);

const chkAutosaveInput = el("input", { type: "checkbox" });
chkAutosaveInput.checked = state.autosave;
chkAutosaveInput.addEventListener("change", onAutosaveToggle);
const chkAutosave = el("label", {
  class: "chk",
  title: "Conserver un brouillon dans ce navigateur pour survivre a un rechargement.\nDesactive par defaut : le brouillon est stocke en clair sur ce poste.",
}, chkAutosaveInput, el("span", { text: "Brouillon local" }));

const btnClearDraft = button("Effacer le brouillon",
  "Supprimer le brouillon conserve dans ce navigateur", doClearDraft);
btnClearDraft.classList.add("hidden");

const toolbar = el("header", { class: "tb" },
  btnOpen, btnSave, btnSaveAs,
  el("div", { class: "tb-sep" }),
  btnNew,
  el("div", { class: "tb-sep" }),
  segView, btnRich,
  el("div", { class: "tb-sep" }),
  btnExport, btnStandalone,
  el("div", { class: "tb-spacer" }),
  chkAutosave, btnClearDraft, btnTheme, btnAbout);

// Repli pour les navigateurs sans File System Access API.
const fileInput = el("input", {
  type: "file",
  class: "hidden",
  accept: ".md,.markdown,.mdown,.txt,text/markdown,text/plain",
  onchange: onFileInputChange,
});

// --- ruban de mise en forme -------------------------------------------------

const blockSelect = el("select", {
  class: "rb-select",
  title: "Style du paragraphe",
  onchange: () => {
    const v = blockSelect.value;
    if (v === "p") rich.commands.paragraph();
    else if (v === "code") rich.commands.codeBlock();
    else rich.commands.heading(Number(v.slice(1)));
  },
});
for (const [value, label] of [
  ["p", "Paragraphe"], ["h1", "Titre 1"], ["h2", "Titre 2"], ["h3", "Titre 3"],
  ["h4", "Titre 4"], ["h5", "Titre 5"], ["h6", "Titre 6"], ["code", "Bloc de code"],
]) {
  blockSelect.append(el("option", { value, text: label }));
}

const rb = {};
const rbButton = (key, label, title, action, cls = "rb-btn") => {
  const b = button(label, title, action, cls);
  rb[key] = b;
  return b;
};

// Libelles en toutes lettres plutot qu'en pictogrammes : la CSP interdit toute
// police externe, et les symboles hors du plan multilingue de base (emoji de
// lien, d'image) s'affichent en carre vide sur les systemes sans police emoji.
const ribbon = el("div", { class: "rb", role: "toolbar", "aria-label": "Mise en forme" },
  rbButton("undo", "Annuler", "Annuler (Ctrl+Z)", () => rich.commands.undo()),
  rbButton("redo", "Retablir", "Retablir (Ctrl+Y)", () => rich.commands.redo()),
  el("div", { class: "tb-sep" }),
  blockSelect,
  el("div", { class: "tb-sep" }),
  rbButton("strong", "G", "Gras (Ctrl+B)", () => rich.commands.strong(), "rb-btn rb-bold"),
  rbButton("em", "I", "Italique (Ctrl+I)", () => rich.commands.em(), "rb-btn rb-italic"),
  rbButton("strikethrough", "S", "Barre (Ctrl+Maj+X)", () => rich.commands.strikethrough(), "rb-btn rb-strike"),
  rbButton("code", "</>", "Code (Ctrl+E)", () => rich.commands.code(), "rb-btn rb-mono"),
  el("div", { class: "tb-sep" }),
  rbButton("bullet_list", "Liste", "Liste a puces", () => rich.commands.bulletList()),
  rbButton("ordered_list", "Numeros", "Liste numerotee", () => rich.commands.orderedList()),
  rbButton("task", "Taches", "Liste de taches", () => rich.commands.taskList()),
  rbButton("outdent", "Retrait −", "Diminuer le retrait", () => rich.commands.lift()),
  el("div", { class: "tb-sep" }),
  rbButton("blockquote", "Citation", "Citation", () => rich.commands.blockquote()),
  rbButton("hr", "Separateur", "Ligne de separation", () => rich.commands.horizontalRule()),
  el("div", { class: "tb-sep" }),
  rbButton("link", "Lien", "Inserer un lien (Ctrl+K)", () => rich.commands.link()),
  rbButton("image", "Image", "Inserer une image", () => rich.commands.image()),
  rbButton("table", "Tableau", "Inserer un tableau", () => rich.commands.table()),
);

// Operations de tableau : n'apparaissent que lorsque le curseur y est, pour
// eviter un ruban encombre de commandes inertes.
const tableTools = el("span", { class: "rb-group hidden" },
  el("div", { class: "tb-sep" }),
  button("+Col", "Ajouter une colonne", () => rich.commands.addColumn(), "rb-btn"),
  button("+Lig", "Ajouter une ligne", () => rich.commands.addRow(), "rb-btn"),
  button("−Col", "Supprimer la colonne", () => rich.commands.deleteColumn(), "rb-btn"),
  button("−Lig", "Supprimer la ligne", () => rich.commands.deleteRow(), "rb-btn"),
  button("×", "Supprimer le tableau", () => rich.commands.deleteTable(), "rb-btn"),
);
ribbon.append(tableTools);

// --- panneaux ---------------------------------------------------------------

const editorHost = el("div", { class: "pane pane-editor" });
const preview = el("article", { class: "md", id: "preview" });
const richHost = el("div", { class: "md md-rich hidden", id: "rich" });
const previewHost = el("section", { class: "pane pane-preview" }, preview, richHost);
const divider = el("div", { class: "divider", role: "separator", "aria-orientation": "vertical" });
const panes = el("main", { class: "panes" }, editorHost, divider, previewHost);

// --- barre d'etat -----------------------------------------------------------

const sbName = el("b", { text: state.fileName });
const sbDirty = el("span", { text: "" });
const sbCounts = el("span", { text: "" });
const sbMode = el("span", { text: "" });
const sbMsg = el("span", { text: "" });

const statusbar = el("footer", { class: "sb" },
  sbName, sbDirty,
  el("span", { class: "sb-spacer" }),
  sbMsg, sbCounts, sbMode);

app.append(toolbar, ribbon, panes, statusbar, fileInput);

/* ===========================================================================
 * Panneau source (CodeMirror)
 * ======================================================================== */

const view = new EditorView({
  parent: editorHost,
  state: EditorState.create({
    doc: initialDoc(),
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      bracketMatching(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      syntaxHighlighting(mdHighlight, { fallback: true }),
      markdown({ base: markdownLanguage, codeLanguages: [] }),
      EditorView.lineWrapping,
      cmTheme,
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onSourceChanged();
      }),
    ],
  }),
});

/** Texte du panneau source. Ne declenche aucune synchronisation. */
function text() {
  return view.state.doc.toString();
}

function initialDoc() {
  if (state.autosave) {
    const draft = store.get(KEY.draft);
    if (draft !== null) {
      state.fileName = store.get(KEY.draftName) || state.fileName;
      state.savedText = " "; // force l'etat « modifie » : le disque ne contient pas ce texte
      return draft;
    }
  }
  state.savedText = SAMPLE;
  return SAMPLE;
}

/* ===========================================================================
 * Panneau rendu (ProseMirror)
 * ======================================================================== */

const rich = createRichEditor({
  parent: richHost,
  onChange: onRichChanged,
  onState: updateRibbon,
});

/* ===========================================================================
 * Synchronisation
 *
 * Le texte de CodeMirror fait foi : c'est lui qu'on enregistre, qu'on exporte
 * et qu'on compare pour savoir si le document est modifie. L'editeur riche
 * s'aligne dessus, et lui renvoie ses propres modifications.
 *
 * Deux precautions rendent l'ensemble stable :
 *   - le drapeau `syncing` empeche qu'une mise a jour provoquee par un panneau
 *     ne revienne le modifier en retour ;
 *   - le panneau qui a le focus est celui qui a raison. Sans cette regle, une
 *     source regeneree viendrait ecraser la frappe en cours.
 * ======================================================================== */

let syncing = false;
let toRichTimer = 0;
let toSourceTimer = 0;
let renderTimer = 0;

function onSourceChanged() {
  updateStatus();
  if (syncing) return; // la modification vient de l'editeur riche

  if (state.autosave) persistDraft(text());
  if (state.richMode) {
    if (rich.hasFocus()) return; // l'utilisateur ecrit a droite : ne pas l'ecraser
    clearTimeout(toRichTimer);
    toRichTimer = setTimeout(pushToRich, 200);
  } else {
    scheduleRender();
  }
}

function onRichChanged() {
  clearTimeout(toSourceTimer);
  toSourceTimer = setTimeout(flushRich, 150);
}

function pushToRich() {
  if (!state.richMode || rich.hasFocus()) return;
  syncing = true;
  rich.setMarkdown(text());
  syncing = false;
}

/**
 * Repercute immediatement les modifications de l'editeur riche dans la source.
 * Appelee avant tout ce qui lit le document : enregistrement, export, bascule
 * de mode, fermeture de l'onglet.
 */
function flushRich() {
  clearTimeout(toSourceTimer);
  if (!state.richMode) return;

  const markdown = rich.getMarkdown();
  if (markdown === text()) return;

  syncing = true;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: markdown } });
  syncing = false;

  updateStatus();
  if (state.autosave) persistDraft(markdown);
}

/** Contenu canonique du document, editeur riche compris. */
function documentText() {
  flushRich();
  return text();
}

/* ===========================================================================
 * Rendu et etat visuel
 * ======================================================================== */

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 120);
}

function render() {
  if (state.richMode) return; // le panneau de lecture est masque
  preview.innerHTML = renderMarkdown(text());
}

function updateStatus() {
  const src = text();
  const words = (src.match(/\S+/g) || []).length;
  sbCounts.textContent = `${words} mot${words > 1 ? "s" : ""} - ${src.length} car. - ${view.state.doc.lines} lignes`;

  const dirty = src !== state.savedText;
  sbDirty.textContent = dirty ? "- modifie" : "";
  sbDirty.className = dirty ? "dirty" : "";
  sbName.textContent = state.fileName;
}

let msgTimer = 0;
function flash(message, kind = "ok") {
  clearTimeout(msgTimer);
  sbMsg.textContent = message;
  sbMsg.className = kind;
  msgTimer = setTimeout(() => {
    sbMsg.textContent = "";
    sbMsg.className = "";
  }, 4000);
}

function persistDraft(src) {
  const ok = store.set(KEY.draft, src);
  store.set(KEY.draftName, state.fileName);
  if (!ok) flash("Brouillon non enregistre (stockage indisponible ou plein)", "dirty");
}

/** Reflete dans le ruban l'etat du curseur de l'editeur riche. */
function updateRibbon(status = rich.status()) {
  if (!state.richMode) return;

  blockSelect.value = status.block;
  for (const key of ["strong", "em", "strikethrough", "code", "link",
                     "bullet_list", "ordered_list", "task", "blockquote"]) {
    if (rb[key]) rb[key].setAttribute("aria-pressed", String(Boolean(status[key])));
  }
  rb.undo.disabled = !status.canUndo;
  rb.redo.disabled = !status.canRedo;
  rb.outdent.disabled = !status.inList;
  tableTools.classList.toggle("hidden", !status.inTable);
}

/* ===========================================================================
 * Modes d'affichage, theme, redimensionnement
 * ======================================================================== */

function setView(mode) {
  panes.dataset.view = mode;
  for (const [k, b] of Object.entries(viewButtons)) {
    b.setAttribute("aria-pressed", String(k === mode));
  }
  store.set(KEY.view, mode);
  sbMode.textContent = { editor: "Source", split: "Vue partagee", preview: "Rendu" }[mode];
  if (mode !== "preview") view.requestMeasure();
  if (mode !== "editor" && state.richMode) pushToRich();
}

function toggleRich() {
  setRichMode(!state.richMode);
}

function setRichMode(on) {
  if (on === state.richMode) return;

  // Sortir du mode riche sans repercuter ses modifications les perdrait.
  if (!on) flushRich();

  state.richMode = on;
  store.set(KEY.rich, on ? "1" : "0");

  btnRich.setAttribute("aria-pressed", String(on));
  ribbon.classList.toggle("hidden", !on);
  preview.classList.toggle("hidden", on);
  richHost.classList.toggle("hidden", !on);

  if (on) {
    syncing = true;
    rich.setMarkdown(text());
    syncing = false;
    if (panes.dataset.view === "editor") setView("split");
    rich.focus();
    updateRibbon();
  } else {
    render();
  }

  flash(on
    ? "Edition du rendu active - la source sera regeneree"
    : "Retour a l'apercu en lecture");
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  store.set(KEY.theme, theme);
}

function toggleTheme() {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
}

// Poignee de separation entre les deux panneaux.
divider.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  divider.setPointerCapture(e.pointerId);
  const vertical = window.matchMedia("(max-width: 720px)").matches;

  const onMove = (ev) => {
    const r = panes.getBoundingClientRect();
    const ratio = vertical
      ? (ev.clientY - r.top) / r.height
      : (ev.clientX - r.left) / r.width;
    const clamped = Math.min(0.85, Math.max(0.15, ratio));
    panes.style.setProperty("--split", `${(clamped * 100).toFixed(2)}%`);
  };

  const onUp = () => {
    divider.removeEventListener("pointermove", onMove);
    divider.removeEventListener("pointerup", onUp);
    store.set(KEY.split, panes.style.getPropertyValue("--split"));
    view.requestMeasure();
  };

  divider.addEventListener("pointermove", onMove);
  divider.addEventListener("pointerup", onUp);
});

// Defilement synchronise, proportionnel. Le drapeau evite la boucle de retour
// entre les deux panneaux.
let scrollSyncing = false;
function linkScroll(from, to) {
  from.addEventListener("scroll", () => {
    if (scrollSyncing || panes.dataset.view !== "split") return;
    const fromMax = from.scrollHeight - from.clientHeight;
    const toMax = to.scrollHeight - to.clientHeight;
    if (fromMax <= 0 || toMax <= 0) return;
    scrollSyncing = true;
    to.scrollTop = (from.scrollTop / fromMax) * toMax;
    requestAnimationFrame(() => { scrollSyncing = false; });
  }, { passive: true });
}
linkScroll(view.scrollDOM, preview);
linkScroll(preview, view.scrollDOM);
linkScroll(view.scrollDOM, richHost);
linkScroll(richHost, view.scrollDOM);

/* ===========================================================================
 * Entrees / sorties fichier
 *
 * Chemin privilegie : File System Access API (Chrome/Edge), qui rend « Ctrl+S »
 * capable de reecrire le fichier d'origine. Repli universel : <input type=file>
 * a l'ouverture, telechargement d'un Blob a l'enregistrement.
 * ======================================================================== */

const hasFSA = typeof window.showOpenFilePicker === "function";
const FILE_TYPES = [{
  description: "Document Markdown",
  accept: { "text/markdown": [".md", ".markdown", ".mdown"], "text/plain": [".txt"] },
}];

function setDoc(content, name) {
  syncing = true;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: content },
    selection: { anchor: 0 },
  });
  syncing = false;

  if (name) state.fileName = name;
  state.savedText = content;
  view.scrollDOM.scrollTop = 0;

  if (state.richMode) rich.setMarkdown(content);
  else render();
  updateStatus();
}

async function doOpen() {
  if (!(await confirmDiscard())) return;

  if (!hasFSA) {
    fileInput.click();
    return;
  }
  try {
    const [handle] = await window.showOpenFilePicker({ types: FILE_TYPES, multiple: false });
    const file = await handle.getFile();
    state.fileHandle = handle;
    setDoc(await file.text(), file.name);
    flash("Fichier ouvert");
  } catch (err) {
    if (err.name !== "AbortError") flash("Ouverture impossible : " + err.message, "dirty");
  }
}

async function onFileInputChange() {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  state.fileHandle = null;
  setDoc(await file.text(), file.name);
  fileInput.value = "";
  flash("Fichier charge");
}

async function doSave() {
  const content = documentText();

  if (state.fileHandle) {
    try {
      const writable = await state.fileHandle.createWritable();
      await writable.write(content);
      await writable.close();
      state.savedText = content;
      updateStatus();
      flash("Enregistre dans " + state.fileName);
      return;
    } catch (err) {
      flash("Enregistrement impossible : " + err.message, "dirty");
      return;
    }
  }
  await doSaveAs();
}

async function doSaveAs() {
  const content = documentText();

  if (hasFSA && typeof window.showSaveFilePicker === "function") {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: state.fileName,
        types: FILE_TYPES,
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      state.fileHandle = handle;
      state.fileName = handle.name;
      state.savedText = content;
      updateStatus();
      flash("Enregistre dans " + state.fileName);
      return;
    } catch (err) {
      if (err.name !== "AbortError") flash("Enregistrement impossible : " + err.message, "dirty");
      return;
    }
  }

  download(content, "text/markdown;charset=utf-8", state.fileName);
  state.savedText = content;
  updateStatus();
  flash("Telechargement lance");
}

async function doNew() {
  if (!(await confirmDiscard())) return;
  state.fileHandle = null;
  state.fileName = "sans-titre.md";
  setDoc("", state.fileName);
  (state.richMode ? rich : view).focus();
}

// Le telechargement passe par un Blob local : aucune requete reseau, donc rien
// que la CSP doive autoriser.
function download(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function confirmDiscard() {
  if (documentText() === state.savedText) return true;
  return window.confirm("Le document contient des modifications non enregistrees. Continuer et les perdre ?");
}

/* ===========================================================================
 * Exports
 * ======================================================================== */

function baseName() {
  return state.fileName.replace(/\.(md|markdown|mdown|txt)$/i, "") || "document";
}

// Le HTML exporte embarque sa propre CSP verrouillee : le document produit ne
// peut ni charger ni contacter quoi que ce soit, meme ouvert ailleurs.
function doExportHtml() {
  const title = baseName();
  const body = renderMarkdown(documentText());
  const css = document.getElementById("app-css").textContent;
  const theme = document.documentElement.dataset.theme || "light";

  const html = `<!doctype html>
<html lang="fr" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(title)}</title>
<style>
${css}
body { background: var(--bg); }
.md { max-width: 860px; margin: 0 auto; padding: 40px 24px 80px; }
</style>
</head>
<body>
<article class="md">
${body}
</article>
</body>
</html>
`;
  download(html, "text/html;charset=utf-8", title + ".html");
  flash("Rendu exporte");
}

/* ---------------------------------------------------------------------------
 * Telechargement de l'application elle-meme.
 *
 * Le fichier est reconstruit a partir des noeuds d'origine du document -- le
 * <style> et le <script> sont des elements « raw text », donc leur textContent
 * restitue exactement les octets livres, execution du script comprise. Deux
 * consequences : le condensat SHA-256 de la CSP reste valide, et le contenu
 * tape par l'utilisateur ne peut pas se retrouver dans le fichier produit.
 * ------------------------------------------------------------------------ */
function standaloneHtml() {
  const csp = document
    .querySelector('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute("content");
  const css = document.getElementById("app-css").textContent;
  const js = document.getElementById("app-js").textContent;

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, "&quot;")}">
<meta name="referrer" content="no-referrer">
<title>Editeur Markdown</title>
<style id="app-css">${css}</style>
</head>
<body>
<div id="app"></div>
<script id="app-js">${js}</script>
</body>
</html>
`;
}

function doDownloadApp() {
  download(standaloneHtml(), "text/html;charset=utf-8", "md-editor.html");
  flash("Application telechargee - ouvrez-la en file:// pour vous passer du serveur");
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/* ===========================================================================
 * Brouillon local
 * ======================================================================== */

function onAutosaveToggle() {
  state.autosave = chkAutosaveInput.checked;
  store.set(KEY.autosave, state.autosave ? "1" : "0");

  if (state.autosave) {
    persistDraft(documentText());
    flash("Brouillon local actif - le contenu est ecrit en clair sur ce poste", "dirty");
  } else {
    store.del(KEY.draft);
    store.del(KEY.draftName);
    flash("Brouillon local desactive et efface");
  }
  refreshDraftUi();
}

function doClearDraft() {
  store.del(KEY.draft);
  store.del(KEY.draftName);
  flash("Brouillon efface");
  refreshDraftUi();
}

function refreshDraftUi() {
  btnClearDraft.classList.toggle("hidden", store.get(KEY.draft) === null);
}

/* ===========================================================================
 * A propos
 * ======================================================================== */

function showAbout() {
  const close = () => sheet.remove();
  const box = el("div", { class: "sheet-box" });
  box.innerHTML = `
    <h2>Ou vont vos donnees ?</h2>
    <p>Nulle part. Ce document n'effectue aucune requete reseau, et sa politique
    de securite (<code>Content-Security-Policy</code>) demande au navigateur de
    bloquer toute tentative :</p>
    <ul>
      <li><code>default-src 'none'</code> &mdash; rien ne se charge par defaut</li>
      <li><code>connect-src 'none'</code> &mdash; ni <code>fetch</code>, ni WebSocket, ni balise <code>&lt;a ping&gt;</code></li>
      <li><code>img-src data: blob:</code> &mdash; les images distantes sont refusees, y compris celles referencees dans votre Markdown</li>
      <li><code>script-src 'sha256-&hellip;'</code> &mdash; seul le script livre avec cette page peut s'executer</li>
    </ul>

    <h3>La limite a connaitre</h3>
    <p>Un serveur compromis peut servir une <em>autre</em> page, avec une CSP
    permissive. Les garanties ci-dessus ne valent que pour la page reellement
    recue. Pour un document sensible, la seule parade solide est de ne plus
    dependre du serveur :</p>
    <ul>
      <li>cliquez sur <b>Telecharger l'app</b> une fois ;</li>
      <li>ouvrez le fichier <code>md-editor.html</code> obtenu en <code>file://</code> ;</li>
      <li>comparez son condensat SHA-256 a celui publie pour la version utilisee.</li>
    </ul>

    <h3>Les deux modes d'edition</h3>
    <p>Le bouton <b>Edition</b> rend le document affiche a droite directement
    modifiable, avec un ruban de mise en forme. Le texte source est alors
    <em>regenere</em> a partir du document : la mise en forme est preservee,
    mais vos conventions d'ecriture sont normalisees (<code>*</code> devient
    <code>-</code>, les titres soulignes deviennent des <code>#</code>). Tant
    que vous n'activez pas ce mode, la source reste intacte au caractere pres.</p>
    <p>Le HTML brut place dans le Markdown est conserve tel quel, mais n'est pas
    modifiable dans le rendu : editez-le dans le panneau source.</p>

    <h3>Stockage</h3>
    <p>Par defaut, <b>rien</b> n'est conserve : ni brouillon, ni historique. La
    case <b>Brouillon local</b> ecrit le document en clair dans le
    <code>localStorage</code> de ce navigateur &mdash; pratique sur un poste
    personnel, a eviter sur une machine partagee.</p>

    <h3>Raccourcis</h3>
    <ul>
      <li><code>Ctrl</code>+<code>O</code> ouvrir &mdash; <code>Ctrl</code>+<code>S</code> enregistrer &mdash; <code>Ctrl</code>+<code>Maj</code>+<code>S</code> enregistrer sous</li>
      <li>Dans le rendu : <code>Ctrl</code>+<code>B</code> gras, <code>Ctrl</code>+<code>I</code> italique, <code>Ctrl</code>+<code>K</code> lien, <code>Tab</code> cellule suivante</li>
    </ul>
  `;
  const ok = button("Fermer", "Fermer", close);
  box.append(el("div", { class: "sheet-actions" }, ok));

  const sheet = el("div", {
    class: "sheet",
    role: "dialog",
    "aria-modal": "true",
    onclick: (e) => { if (e.target === sheet) close(); },
  }, box);

  document.body.append(sheet);
  ok.focus();
  sheet.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
}

/* ===========================================================================
 * Raccourcis globaux et garde-fou de fermeture
 * ======================================================================== */

window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === "s") {
    e.preventDefault();
    if (e.shiftKey) doSaveAs(); else doSave();
  } else if (k === "o") {
    e.preventDefault();
    doOpen();
  }
});

window.addEventListener("beforeunload", (e) => {
  flushRich();
  if (text() !== state.savedText && !state.autosave) {
    e.preventDefault();
    e.returnValue = "";
  }
});

/* ===========================================================================
 * Demarrage
 * ======================================================================== */

setTheme(
  store.get(KEY.theme) ||
  (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
);
setView(store.get(KEY.view) || "split");

const savedSplit = store.get(KEY.split);
if (savedSplit) panes.style.setProperty("--split", savedSplit);

refreshDraftUi();
updateStatus();
render();

// `setRichMode` compare a l'etat courant : on part de false pour que la
// preference enregistree soit reellement appliquee.
if (state.richMode) {
  state.richMode = false;
  setRichMode(true);
} else {
  btnRich.setAttribute("aria-pressed", "false");
  ribbon.classList.add("hidden");
  view.focus();
}

if (!hasFSA) {
  flash("Ce navigateur n'a pas l'API fichier : l'enregistrement passe par un telechargement");
}
