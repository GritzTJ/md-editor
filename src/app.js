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
 * ------------------------------------------------------------------------- */

import { EditorState, Compartment } from "@codemirror/state";
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
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  syntaxHighlighting,
  HighlightStyle,
  indentOnInput,
  bracketMatching,
} from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";
import { marked } from "marked";
import DOMPurify from "dompurify";

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
  split: "mdedit.split",
  autosave: "mdedit.autosave",
  draft: "mdedit.draft",
  draftName: "mdedit.draftName",
};

// localStorage peut lever (mode prive, file:// verrouille, quota). Jamais
// d'exception propagee : l'editeur doit fonctionner meme sans stockage.
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
      return true;
    } catch {
      return false;
    }
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

/* ===========================================================================
 * Rendu Markdown -> HTML assaini
 * ======================================================================== */

marked.use({ gfm: true, breaks: false, pedantic: false });

// Les liens du document sont ouverts dans un nouvel onglet sans referrer :
// le site cible ne doit rien apprendre du document en cours d'edition.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.hasAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const PURIFY_CONFIG = {
  // <style> injecterait des regles dans toute la page, <form>/<input> donnent
  // l'illusion d'un formulaire legitime : ni l'un ni l'autre n'a sa place dans
  // un apercu de document.
  FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select"],
  FORBID_ATTR: ["srcset", "ping", "formaction"],
  ALLOW_DATA_ATTR: false,
};

function renderMarkdown(src) {
  let html;
  try {
    html = marked.parse(src, { async: false });
  } catch (err) {
    const p = document.createElement("p");
    p.textContent = "Erreur d'analyse Markdown : " + err.message;
    return p.outerHTML;
  }
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}

/* ===========================================================================
 * Coloration syntaxique
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
  // Blocs de code delimites : lang-markdown delegue au parseur du langage.
  { tag: t.keyword, class: "cm-md-heading" },
  { tag: t.string, class: "cm-md-url" },
  { tag: t.comment, class: "cm-md-quote" },
  { tag: t.number, class: "cm-md-code" },
]);

// Les couleurs de l'editeur suivent les variables CSS du document, donc le
// theme bascule sans reconstruire l'EditorView.
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
};

const SAMPLE = `# Editeur Markdown local

Tout se passe **dans cet onglet**. Le serveur qui a livre cette page ne recoit
jamais le contenu que vous tapez : il n'y a aucun appel reseau dans le code, et
la politique de securite du document (\`connect-src 'none'\`) l'interdit au
niveau du navigateur.

## Ce que vous pouvez faire

- Ouvrir et enregistrer de vrais fichiers \`.md\` depuis votre disque
- Basculer entre edition, apercu et vue partagee
- Exporter le rendu en HTML autonome
- Telecharger l'application elle-meme pour l'utiliser hors ligne

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

1. Editez ce texte
2. Regardez l'apercu se mettre a jour
3. Enregistrez sur votre disque
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

function button(label, title, onclick) {
  return el("button", { type: "button", title, onclick, text: label });
}

// --- barre d'outils ---------------------------------------------------------

const btnOpen = button("Ouvrir", "Ouvrir un fichier Markdown (Ctrl+O)", doOpen);
const btnSave = button("Enregistrer", "Enregistrer (Ctrl+S)", doSave);
const btnSaveAs = button("Enregistrer sous", "Enregistrer sous (Ctrl+Maj+S)", doSaveAs);
const btnNew = button("Nouveau", "Vider l'editeur", doNew);

const viewButtons = {
  editor: button("Editeur", "Afficher uniquement l'editeur", () => setView("editor")),
  split: button("Partage", "Afficher l'editeur et l'apercu", () => setView("split")),
  preview: button("Apercu", "Afficher uniquement l'apercu", () => setView("preview")),
};
const segView = el("div", { class: "seg", role: "group", "aria-label": "Mode d'affichage" },
  viewButtons.editor, viewButtons.split, viewButtons.preview);

const btnExport = button("Exporter HTML", "Enregistrer le rendu en HTML autonome", doExportHtml);
const btnStandalone = button("Telecharger l'app", "Enregistrer cette application en un fichier HTML utilisable hors ligne", doDownloadApp);
const btnTheme = button("Theme", "Basculer clair / sombre", toggleTheme);
const btnAbout = button("?", "Securite et fonctionnement", showAbout);

const chkAutosaveInput = el("input", { type: "checkbox" });
chkAutosaveInput.checked = state.autosave;
chkAutosaveInput.addEventListener("change", onAutosaveToggle);
const chkAutosave = el("label", {
  class: "chk",
  title: "Conserver un brouillon dans ce navigateur pour survivre a un rechargement.\nDesactive par defaut : le brouillon est stocke en clair sur ce poste.",
}, chkAutosaveInput, el("span", { text: "Brouillon local" }));

const btnClearDraft = button("Effacer le brouillon", "Supprimer le brouillon conserve dans ce navigateur", doClearDraft);
btnClearDraft.classList.add("hidden");

const toolbar = el("header", { class: "tb" },
  btnOpen, btnSave, btnSaveAs,
  el("div", { class: "tb-sep" }),
  btnNew,
  el("div", { class: "tb-sep" }),
  segView,
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

// --- panneaux ---------------------------------------------------------------

const editorHost = el("div", { class: "pane pane-editor" });
const preview = el("article", { class: "md", id: "preview" });
const previewHost = el("section", { class: "pane pane-preview" }, preview);
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

app.append(toolbar, panes, statusbar, fileInput);

/* ===========================================================================
 * Editeur CodeMirror
 * ======================================================================== */

const renderScheduler = { timer: 0 };

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
        if (u.docChanged) scheduleRender();
      }),
    ],
  }),
});

function text() {
  return view.state.doc.toString();
}

function initialDoc() {
  if (state.autosave) {
    const draft = store.get(KEY.draft);
    if (draft !== null) {
      state.fileName = store.get(KEY.draftName) || state.fileName;
      state.savedText = " "; // force l'etat « modifie » : le disque ne contient pas ce texte
      return draft;
    }
  }
  state.savedText = SAMPLE;
  return SAMPLE;
}

/* ===========================================================================
 * Rendu et etat visuel
 * ======================================================================== */

function scheduleRender() {
  clearTimeout(renderScheduler.timer);
  renderScheduler.timer = setTimeout(render, 120);
}

function render() {
  const src = text();
  preview.innerHTML = renderMarkdown(src);
  updateStatus(src);
  if (state.autosave) persistDraft(src);
}

function updateStatus(src = text()) {
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

/* ===========================================================================
 * Mode d'affichage, theme, redimensionnement
 * ======================================================================== */

function setView(mode) {
  panes.dataset.view = mode;
  for (const [k, b] of Object.entries(viewButtons)) {
    b.setAttribute("aria-pressed", String(k === mode));
  }
  store.set(KEY.view, mode);
  sbMode.textContent = { editor: "Editeur", split: "Vue partagee", preview: "Apercu" }[mode];
  if (mode !== "preview") view.requestMeasure();
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
let syncing = false;
function linkScroll(from, to) {
  from.addEventListener("scroll", () => {
    if (syncing || panes.dataset.view !== "split") return;
    const fromMax = from.scrollHeight - from.clientHeight;
    const toMax = to.scrollHeight - to.clientHeight;
    if (fromMax <= 0 || toMax <= 0) return;
    syncing = true;
    to.scrollTop = (from.scrollTop / fromMax) * toMax;
    requestAnimationFrame(() => { syncing = false; });
  }, { passive: true });
}
linkScroll(view.scrollDOM, preview);
linkScroll(preview, view.scrollDOM);

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
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: content },
    selection: { anchor: 0 },
  });
  if (name) state.fileName = name;
  state.savedText = content;
  view.scrollDOM.scrollTop = 0;
  render();
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
  const content = text();

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
  const content = text();

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
  view.focus();
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
  if (text() === state.savedText) return true;
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
  const body = renderMarkdown(text());
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
    persistDraft(text());
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

    <h3>Stockage</h3>
    <p>Par defaut, <b>rien</b> n'est conserve : ni brouillon, ni historique. La
    case <b>Brouillon local</b> ecrit le document en clair dans le
    <code>localStorage</code> de ce navigateur &mdash; pratique sur un poste
    personnel, a eviter sur une machine partagee.</p>

    <h3>Raccourcis</h3>
    <ul>
      <li><code>Ctrl</code>+<code>O</code> ouvrir &mdash; <code>Ctrl</code>+<code>S</code> enregistrer &mdash; <code>Ctrl</code>+<code>Maj</code>+<code>S</code> enregistrer sous</li>
      <li><code>Ctrl</code>+<code>Z</code> / <code>Ctrl</code>+<code>Y</code> annuler et retablir</li>
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
render();
view.focus();

if (!hasFSA) {
  flash("Ce navigateur n'a pas l'API fichier : l'enregistrement passe par un telechargement");
}
