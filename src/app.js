/* ---------------------------------------------------------------------------
 * md-editor -- a Markdown editor that runs entirely in the browser.
 *
 * Hard rule for this file: NO network access. No fetch, no XMLHttpRequest, no
 * WebSocket, no remote <img>, no web font. The document's CSP
 * (`default-src 'none'; connect-src 'none'`) turns that rule into a guarantee
 * the browser enforces: even if this script were swapped for a malicious one,
 * it could not move the document out of the tab.
 *
 * The whole interface is built in JS so the HTML shell stays an empty
 * skeleton -- which is what makes rebuilding the standalone file (the
 * "Download app" button) trivial and unable to leak the user's document.
 *
 * The document is edited two ways: as source in CodeMirror, and as rendered
 * output in ProseMirror. The CodeMirror text is always authoritative, and the
 * two surfaces are never on screen together -- see "Synchronisation".
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
 * Local preferences
 *
 * Only display preferences are written unprompted: they hold no user data.
 * The document draft is stored only if the user explicitly ticks "Local draft".
 * ======================================================================== */

const KEY = {
  theme: "mdedit.theme",
  editing: "mdedit.editing",
  split: "mdedit.split",
  autosave: "mdedit.autosave",
  draft: "mdedit.draft",
  draftName: "mdedit.draftName",
};

// localStorage can throw (private mode, locked file://, quota). Never let that
// propagate: the editor must work without any storage at all.
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
 * Source pane syntax highlighting
 *
 * Colours are not hard-coded here but delegated to CSS classes, so the
 * light/dark theme in the stylesheet drives them.
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
 * Application state
 * ======================================================================== */

const state = {
  fileHandle: null, // FileSystemFileHandle when the API is available
  fileName: "untitled.md",
  savedText: "", // reference content for the "modified" indicator
  autosave: store.get(KEY.autosave) === "1",
  editing: store.get(KEY.editing) === "1", // editing the rendered document
};

const SAMPLE = `# Local Markdown editor

Everything happens **in this tab**. The server that delivered this page never
receives what you type: there is no network call anywhere in the code, and the
document's security policy (\`connect-src 'none'\`) forbids one at the browser
level.

## Two ways to edit

- [x] The source, on the left, with syntax highlighting
- [x] The preview, on the right — turn on **Edit preview** to write in it
- [ ] Both stay ~~mostly~~ always in sync

> For a document holding secrets, the safest route is still: download the app
> once, then open it from \`file://\`.

| Shortcut | Action |
| --- | --- |
| \`Ctrl\`+\`O\` | Open |
| \`Ctrl\`+\`S\` | Save |
| \`Ctrl\`+\`Shift\`+\`S\` | Save as |

\`\`\`js
// Code blocks are highlighted in the editor and in the preview alike.
const secret = process.env.API_TOKEN;
\`\`\`
`;

/* ===========================================================================
 * Building the interface
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

// --- main toolbar -----------------------------------------------------------

const btnOpen = button("Open", "Open a Markdown file (Ctrl+O)", doOpen);
const btnSave = button("Save", "Save (Ctrl+S)", doSave);
const btnSaveAs = button("Save as", "Save under a different name (Ctrl+Shift+S)", doSaveAs);
const btnNew = button("New", "Empty the editor", doNew);

// There is no layout control any more. Source and live preview are always side
// by side; the only other state is editing the rendered document, and that
// takes the full width. One button, two states, no way for a layout choice and
// a mode choice to contradict each other.
const btnEdit = button("Edit preview", "Write directly in the rendered document", toggleEditing);

const btnExport = button("Export HTML", "Save the rendered document as standalone HTML", doExportHtml);
const btnStandalone = button("Download app",
  "Save this application as a single HTML file usable offline", doDownloadApp);
const btnTheme = button("Theme", "Switch light / dark", toggleTheme);
const btnAbout = button("?", "Security and behaviour", showAbout);

const chkAutosaveInput = el("input", { type: "checkbox" });
chkAutosaveInput.checked = state.autosave;
chkAutosaveInput.addEventListener("change", onAutosaveToggle);
const chkAutosave = el("label", {
  class: "chk",
  title: "Keep a draft in this browser so it survives a reload.\nOff by default: the draft is stored in clear text on this machine.",
}, chkAutosaveInput, el("span", { text: "Local draft" }));

const btnClearDraft = button("Clear draft", "Delete the draft kept in this browser", doClearDraft);
btnClearDraft.classList.add("hidden");

const toolbar = el("header", { class: "tb" },
  btnOpen, btnSave, btnSaveAs,
  el("div", { class: "tb-sep" }),
  btnNew,
  el("div", { class: "tb-sep" }),
  btnEdit,
  el("div", { class: "tb-sep" }),
  btnExport, btnStandalone,
  el("div", { class: "tb-spacer" }),
  chkAutosave, btnClearDraft, btnTheme, btnAbout);

// Fallback for browsers without the File System Access API.
const fileInput = el("input", {
  type: "file",
  class: "hidden",
  accept: ".md,.markdown,.mdown,.txt,text/markdown,text/plain",
  onchange: onFileInputChange,
});

// --- formatting ribbon ------------------------------------------------------

const blockSelect = el("select", {
  class: "rb-select",
  title: "Paragraph style",
  onchange: () => {
    const v = blockSelect.value;
    if (v === "p") rich.commands.paragraph();
    else if (v === "code") rich.commands.codeBlock();
    else rich.commands.heading(Number(v.slice(1)));
  },
});
for (const [value, label] of [
  ["p", "Paragraph"], ["h1", "Heading 1"], ["h2", "Heading 2"], ["h3", "Heading 3"],
  ["h4", "Heading 4"], ["h5", "Heading 5"], ["h6", "Heading 6"], ["code", "Code block"],
]) {
  blockSelect.append(el("option", { value, text: label }));
}

const rb = {};
const rbButton = (key, label, title, action, cls = "rb-btn") => {
  const b = button(label, title, action, cls);
  rb[key] = b;
  return b;
};

// Word labels rather than pictograms: the CSP forbids external fonts, and
// symbols outside the basic multilingual plane (link, image emoji) render as
// empty boxes on systems without an emoji font.
const ribbon = el("div", { class: "rb", role: "toolbar", "aria-label": "Formatting" },
  rbButton("undo", "Undo", "Undo (Ctrl+Z)", () => rich.commands.undo()),
  rbButton("redo", "Redo", "Redo (Ctrl+Y)", () => rich.commands.redo()),
  el("div", { class: "tb-sep" }),
  blockSelect,
  el("div", { class: "tb-sep" }),
  rbButton("strong", "B", "Bold (Ctrl+B)", () => rich.commands.strong(), "rb-btn rb-bold"),
  rbButton("em", "I", "Italic (Ctrl+I)", () => rich.commands.em(), "rb-btn rb-italic"),
  rbButton("strikethrough", "S", "Strikethrough (Ctrl+Shift+X)", () => rich.commands.strikethrough(), "rb-btn rb-strike"),
  rbButton("code", "</>", "Code (Ctrl+E)", () => rich.commands.code(), "rb-btn rb-mono"),
  rbButton("highlight", "Mark", "Highlight (Ctrl+Shift+H)", () => rich.commands.highlight()),
  rbButton("subscript", "Sub", "Subscript (Ctrl+,)", () => rich.commands.subscript()),
  rbButton("superscript", "Sup", "Superscript (Ctrl+.)", () => rich.commands.superscript()),
  el("div", { class: "tb-sep" }),
  rbButton("bullet_list", "Bullets", "Bulleted list", () => rich.commands.bulletList()),
  rbButton("ordered_list", "Numbers", "Numbered list", () => rich.commands.orderedList()),
  rbButton("task", "Tasks", "Task list", () => rich.commands.taskList()),
  rbButton("outdent", "Outdent", "Decrease indentation", () => rich.commands.outdent()),
  el("div", { class: "tb-sep" }),
  rbButton("blockquote", "Quote", "Block quote", () => rich.commands.blockquote()),
  rbButton("hr", "Divider", "Horizontal rule", () => rich.commands.horizontalRule()),
  el("div", { class: "tb-sep" }),
  rbButton("link", "Link", "Insert a link (Ctrl+K)", () => rich.commands.link()),
  rbButton("image", "Image", "Insert an image", () => rich.commands.image()),
  rbButton("table", "Table", "Insert a table", () => rich.commands.table()),
);

// Table operations only appear when the cursor is inside a table, to avoid a
// ribbon cluttered with inert commands.
const tableTools = el("span", { class: "rb-group hidden" },
  el("div", { class: "tb-sep" }),
  button("+Col", "Add a column", () => rich.commands.addColumn(), "rb-btn"),
  button("+Row", "Add a row", () => rich.commands.addRow(), "rb-btn"),
  button("−Col", "Delete the column", () => rich.commands.deleteColumn(), "rb-btn"),
  button("−Row", "Delete the row", () => rich.commands.deleteRow(), "rb-btn"),
  button("×", "Delete the table", () => rich.commands.deleteTable(), "rb-btn"),
);
ribbon.append(tableTools);

// --- panes ------------------------------------------------------------------

const editorHost = el("div", { class: "pane pane-editor" });
const preview = el("article", { class: "md", id: "preview" });
const richHost = el("div", { class: "md md-rich hidden", id: "rich" });
const previewHost = el("section", { class: "pane pane-preview" }, preview, richHost);
const divider = el("div", { class: "divider", role: "separator", "aria-orientation": "vertical" });
const panes = el("main", { class: "panes" }, editorHost, divider, previewHost);

// --- status bar -------------------------------------------------------------

const sbName = el("b", { text: state.fileName });
const sbDirty = el("span", { text: "" });
const sbCounts = el("span", { text: "" });
const sbMsg = el("span", { text: "" });

const statusbar = el("footer", { class: "sb" },
  sbName, sbDirty,
  el("span", { class: "sb-spacer" }),
  sbMsg, sbCounts);

app.append(toolbar, ribbon, panes, statusbar, fileInput);

/* ===========================================================================
 * Source pane (CodeMirror)
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

/** Text of the source pane. Triggers no synchronisation. */
function text() {
  return view.state.doc.toString();
}

function initialDoc() {
  if (state.autosave) {
    const draft = store.get(KEY.draft);
    if (draft !== null) {
      state.fileName = store.get(KEY.draftName) || state.fileName;
      state.savedText = " "; // force "modified": the disk does not hold this text
      return draft;
    }
  }
  state.savedText = SAMPLE;
  return SAMPLE;
}

/* ===========================================================================
 * Preview pane (ProseMirror)
 * ======================================================================== */

const rich = createRichEditor({
  parent: richHost,
  onChange: onRichChanged,
  onState: updateRibbon,
});

/* ===========================================================================
 * Synchronisation
 *
 * The CodeMirror text is authoritative: it is what gets saved, exported, and
 * compared to decide whether the document is modified.
 *
 * The two surfaces are never visible at the same time -- editing the rendered
 * document takes the full width -- so there is no bidirectional sync to
 * arbitrate. The source flows into the rich editor when that mode opens, and
 * back out while it is open. Nothing else writes the source in the meantime,
 * which removes the whole class of races that a live split would create.
 * ======================================================================== */

let pullTimer = 0;
let renderTimer = 0;

function onSourceChanged() {
  updateStatus();

  // While the rendered document is being edited, the source pane is hidden and
  // the only thing writing to it is pullFromRich, which does its own
  // bookkeeping.
  if (state.editing) return;

  if (state.autosave) persistDraft(text());
  scheduleRender();
}

// The draft and the word count should not wait for the user to leave edit
// mode, so the rendered document is serialised as it is typed. This direction
// is one-way and cannot clobber anything: the source pane is not on screen.
function onRichChanged() {
  clearTimeout(pullTimer);
  pullTimer = setTimeout(pullFromRich, 300);
}

/** Source -> rendered document. Only when entering edit mode. */
function pushToRich() {
  rich.setMarkdown(text());
}

/**
 * Rendered document -> source. Called while editing, when leaving edit mode,
 * and before anything that reads the document: save, export, tab close.
 */
function pullFromRich() {
  clearTimeout(pullTimer);
  if (!state.editing) return;

  const markdown = rich.getMarkdown();
  if (markdown === text()) return;

  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: markdown } });
  updateStatus();
  if (state.autosave) persistDraft(markdown);
}

/** Canonical document content, rendered editor included. */
function documentText() {
  pullFromRich();
  return text();
}

/* ===========================================================================
 * Rendering and visual state
 * ======================================================================== */

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 120);
}

function render() {
  if (state.editing) return; // the read-only pane is hidden
  preview.innerHTML = renderMarkdown(text());
}

function updateStatus() {
  const src = text();
  const words = (src.match(/\S+/g) || []).length;
  sbCounts.textContent = `${words} word${words === 1 ? "" : "s"} · ${src.length} chars · ${view.state.doc.lines} lines`;

  const dirty = src !== state.savedText;
  sbDirty.textContent = dirty ? "— modified" : "";
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
  }, 5000);
}

function persistDraft(src) {
  const ok = store.set(KEY.draft, src);
  store.set(KEY.draftName, state.fileName);
  if (!ok) flash("Draft not saved (storage unavailable or full)", "dirty");
}

/** Mirror the rich editor's cursor context in the ribbon. */
function updateRibbon(status = rich.status()) {
  if (!state.editing) return;

  blockSelect.value = status.block;
  for (const key of ["strong", "em", "strikethrough", "highlight", "subscript",
                     "superscript", "code", "link",
                     "bullet_list", "ordered_list", "task", "blockquote"]) {
    if (rb[key]) rb[key].setAttribute("aria-pressed", String(Boolean(status[key])));
  }
  rb.undo.disabled = !status.canUndo;
  rb.redo.disabled = !status.canRedo;
  rb.outdent.disabled = !status.inList;
  tableTools.classList.toggle("hidden", !status.inTable);
}

/* ===========================================================================
 * Layout, editing mode, theme, resizing
 * ======================================================================== */

function toggleEditing() {
  setEditing(!state.editing);
}

/**
 * Switch between the split view and editing the rendered document.
 *
 * These are the only two states. Editing takes the full width because a
 * formatting ribbon over a half-width column is cramped -- and because keeping
 * the two surfaces apart is what makes the synchronisation a pair of
 * transitions rather than a live negotiation.
 */
function setEditing(on) {
  if (on === state.editing) return;

  // Leaving without pushing the changes down would lose them.
  if (!on) pullFromRich();

  state.editing = on;
  store.set(KEY.editing, on ? "1" : "0");

  panes.classList.toggle("editing", on);
  preview.classList.toggle("hidden", on);
  richHost.classList.toggle("hidden", !on);
  ribbon.classList.toggle("hidden", !on);

  btnEdit.textContent = on ? "Back to split" : "Edit preview";
  btnEdit.title = on
    ? "Return to the source and live preview"
    : "Write directly in the rendered document";
  btnEdit.setAttribute("aria-pressed", String(on));

  if (on) {
    pushToRich();
    updateRibbon();
    rich.focus();
  } else {
    render();
    view.requestMeasure();
    view.focus();
  }
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  store.set(KEY.theme, theme);
}

function toggleTheme() {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
}

// Draggable split between the two panes.
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

// Proportional scroll sync between the source and the live preview. The flag
// prevents a feedback loop. Nothing is needed for the rendered editor: it is
// alone on screen, so there is no second pane to follow.
let scrollSyncing = false;
function linkScroll(from, to) {
  from.addEventListener("scroll", () => {
    if (scrollSyncing) return;
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

/* ===========================================================================
 * File input / output
 *
 * Preferred path: the File System Access API (Chrome/Edge), which lets Ctrl+S
 * rewrite the original file. Universal fallback: <input type=file> to open, a
 * Blob download to save.
 *
 * That API only exists in a *secure context*. Served over plain HTTP on an IP
 * address it is absent entirely, so both Save and Save as fall back -- which is
 * why the fallback has to stay genuinely usable rather than silently reusing
 * the current name.
 * ======================================================================== */

const hasFSA = typeof window.showOpenFilePicker === "function";
const FILE_TYPES = [{
  description: "Markdown document",
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

  // Whichever surface is on screen has to be refreshed: `onSourceChanged`
  // steps aside while editing, and the rendered editor is not fed by it.
  if (state.editing) pushToRich();
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
    flash("File opened");
  } catch (err) {
    if (err.name !== "AbortError") flash("Could not open: " + err.message, "dirty");
  }
}

async function onFileInputChange() {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  state.fileHandle = null;
  setDoc(await file.text(), file.name);
  fileInput.value = "";
  flash("File loaded");
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
      flash("Saved to " + state.fileName);
      return;
    } catch (err) {
      flash("Could not save: " + err.message, "dirty");
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
      flash("Saved to " + state.fileName);
      return;
    } catch (err) {
      if (err.name !== "AbortError") flash("Could not save: " + err.message, "dirty");
      return;
    }
  }

  // No file picker available. Ask for a name anyway -- otherwise "Save as"
  // would be indistinguishable from "Save", which is exactly how it felt.
  const name = window.prompt("Save as — file name:", state.fileName);
  if (name === null) return;

  const trimmed = name.trim();
  if (!trimmed) {
    flash("Empty name: nothing saved", "dirty");
    return;
  }

  state.fileName = trimmed;
  download(content, "text/markdown;charset=utf-8", trimmed);
  state.savedText = content;
  updateStatus();
  flash("Downloaded as " + trimmed);
}

async function doNew() {
  if (!(await confirmDiscard())) return;
  state.fileHandle = null;
  state.fileName = "untitled.md";
  setDoc("", state.fileName);
  (state.editing ? rich : view).focus();
}

// Downloads go through a local Blob: no network request, so nothing the CSP
// needs to allow.
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
  return window.confirm("The document has unsaved changes. Continue and lose them?");
}

/* ===========================================================================
 * Exports
 * ======================================================================== */

function baseName() {
  return state.fileName.replace(/\.(md|markdown|mdown|txt)$/i, "") || "document";
}

// The exported HTML carries its own locked-down CSP: the resulting document can
// neither load nor contact anything, even opened elsewhere.
function doExportHtml() {
  const title = baseName();
  const body = renderMarkdown(documentText());
  const css = document.getElementById("app-css").textContent;
  const theme = document.documentElement.dataset.theme || "light";

  const html = `<!doctype html>
<html lang="en" data-theme="${theme}">
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
  flash("Rendered document exported");
}

/* ---------------------------------------------------------------------------
 * Downloading the application itself.
 *
 * The file is rebuilt from the document's original nodes -- <style> and
 * <script> are raw-text elements, so their textContent returns exactly the
 * bytes that were delivered, script execution included. Two consequences: the
 * CSP's SHA-256 digest stays valid, and the user's typed content cannot end up
 * in the produced file.
 * ------------------------------------------------------------------------ */
function standaloneHtml() {
  const csp = document
    .querySelector('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute("content");
  const css = document.getElementById("app-css").textContent;
  const js = document.getElementById("app-js").textContent;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, "&quot;")}">
<meta name="referrer" content="no-referrer">
<title>Markdown editor</title>
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
  flash("Application downloaded — open it from file:// to drop the server entirely");
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/* ===========================================================================
 * Local draft
 * ======================================================================== */

function onAutosaveToggle() {
  state.autosave = chkAutosaveInput.checked;
  store.set(KEY.autosave, state.autosave ? "1" : "0");

  if (state.autosave) {
    persistDraft(documentText());
    flash("Local draft on — the content is written in clear text on this machine", "dirty");
  } else {
    store.del(KEY.draft);
    store.del(KEY.draftName);
    flash("Local draft turned off and erased");
  }
  refreshDraftUi();
}

function doClearDraft() {
  store.del(KEY.draft);
  store.del(KEY.draftName);
  flash("Draft erased");
  refreshDraftUi();
}

function refreshDraftUi() {
  btnClearDraft.classList.toggle("hidden", store.get(KEY.draft) === null);
}

/* ===========================================================================
 * About dialog
 * ======================================================================== */

function showAbout() {
  const close = () => sheet.remove();
  const box = el("div", { class: "sheet-box" });

  const fileAccess = hasFSA
    ? `<p>This browser exposes the File System Access API, so <b>Save</b> writes
       straight back into the file you opened.</p>`
    : `<p><b>Saving downloads a copy</b> instead of writing back to the original
       file. ${window.isSecureContext
         ? "This browser does not implement the File System Access API (Firefox and Safari do not)."
         : "That API only exists in a <em>secure context</em>, and this page was served over plain HTTP on an IP address. Reach it over <code>https://</code>, or via <code>localhost</code>, to write files directly."}</p>`;

  box.innerHTML = `
    <h2>Where does your data go?</h2>
    <p>Nowhere. This document makes no network request, and its
    <code>Content-Security-Policy</code> tells the browser to block any
    attempt:</p>
    <ul>
      <li><code>default-src 'none'</code> &mdash; nothing loads by default</li>
      <li><code>connect-src 'none'</code> &mdash; no <code>fetch</code>, no WebSocket, no <code>&lt;a ping&gt;</code></li>
      <li><code>img-src data: blob:</code> &mdash; remote images are refused, including those referenced in your Markdown</li>
      <li><code>script-src 'sha256-&hellip;'</code> &mdash; only the script shipped with this page may run</li>
    </ul>

    <h3>The limit worth knowing</h3>
    <p>A compromised server can serve a <em>different</em> page, with a
    permissive CSP. The guarantees above hold for the page you actually
    received, not for the server. For a sensitive document, the only solid
    answer is to stop depending on the server:</p>
    <ul>
      <li>click <b>Download app</b> once;</li>
      <li>open the resulting <code>md-editor.html</code> from <code>file://</code>;</li>
      <li>compare its SHA-256 digest with the one published for that version.</li>
    </ul>

    <h3>The two editing modes</h3>
    <p><b>Edit preview</b> replaces the split view with the rendered document
    alone, directly editable, with a formatting ribbon. The source text is then
    <em>regenerated</em> from the document: the formatting is preserved, but
    your writing conventions are normalised (<code>*</code> becomes
    <code>-</code>, underlined headings become <code>#</code>). As long as you
    leave that mode off, the source stays byte-for-byte intact.</p>
    <p>Raw HTML inside the Markdown is kept verbatim, but is not editable in the
    preview: edit it in the source pane.</p>

    <h3>Files</h3>
    ${fileAccess}

    <h3>Storage</h3>
    <p>By default <b>nothing</b> is kept: no draft, no history. The <b>Local
    draft</b> checkbox writes the document in clear text into this browser's
    <code>localStorage</code> &mdash; handy on a personal machine, best avoided
    on a shared one.</p>

    <h3>Shortcuts</h3>
    <ul>
      <li><code>Ctrl</code>+<code>O</code> open &mdash; <code>Ctrl</code>+<code>S</code> save &mdash; <code>Ctrl</code>+<code>Shift</code>+<code>S</code> save as</li>
      <li>In the preview: <code>Ctrl</code>+<code>B</code> bold, <code>Ctrl</code>+<code>I</code> italic, <code>Ctrl</code>+<code>K</code> link, <code>Tab</code> next cell</li>
    </ul>
  `;
  const ok = button("Close", "Close", close);
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
 * Global shortcuts and close guard
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
  pullFromRich();
  if (text() !== state.savedText && !state.autosave) {
    e.preventDefault();
    e.returnValue = "";
  }
});

/* ===========================================================================
 * Start-up
 * ======================================================================== */

setTheme(
  store.get(KEY.theme) ||
  (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
);
const savedSplit = store.get(KEY.split);
if (savedSplit) panes.style.setProperty("--split", savedSplit);

refreshDraftUi();
updateStatus();
render();

// `setEditing` compares against the current state, so start from the split
// view and let the stored preference be applied for real.
if (state.editing) {
  state.editing = false;
  setEditing(true);
} else {
  btnEdit.setAttribute("aria-pressed", "false");
  ribbon.classList.add("hidden");
  view.focus();
}

// Worth saying explicitly rather than letting the user discover that "Save"
// only ever downloads: the cause is almost always the insecure origin.
if (!hasFSA) {
  flash(window.isSecureContext
    ? "This browser has no file API: saving downloads a copy"
    : "Insecure origin: saving downloads a copy. Use https:// or localhost to write files directly",
    "dirty");
}
