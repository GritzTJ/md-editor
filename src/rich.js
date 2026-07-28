/* ---------------------------------------------------------------------------
 * Rich editor: the rendered document becomes the editing surface.
 *
 * ProseMirror is used here not for how it looks but for what it forbids: the
 * document it manipulates is a tree that is valid against the Markdown schema.
 * No state that fails to serialise can be reached, even by accident --
 * unlike a `contenteditable`, where the browser produces arbitrary DOM that has
 * to be guessed at afterwards.
 * ------------------------------------------------------------------------- */

import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import {
  baseKeymap,
  chainCommands,
  exitCode,
  lift,
  setBlockType,
  toggleMark,
  wrapIn,
} from "prosemirror-commands";
import { history, undo, redo, undoDepth, redoDepth } from "prosemirror-history";
import { wrapInList, splitListItem, liftListItem, sinkListItem } from "prosemirror-schema-list";
import {
  inputRules,
  wrappingInputRule,
  textblockTypeInputRule,
  InputRule,
} from "prosemirror-inputrules";
import { gapCursor } from "prosemirror-gapcursor";
import {
  tableEditing,
  goToNextCell,
  addColumnAfter,
  addRowAfter,
  deleteColumn,
  deleteRow,
  deleteTable,
  isInTable,
} from "prosemirror-tables";

import { schema, toDoc, toMarkdown } from "./markdown.js";

const nodes = schema.nodes;
const marks = schema.marks;

/* ===========================================================================
 * Inspecting the current state
 * ======================================================================== */

function markActive(state, type) {
  const { from, $from, to, empty } = state.selection;
  return empty
    ? Boolean(type.isInSet(state.storedMarks || $from.marks()))
    : state.doc.rangeHasMark(from, to, type);
}

function blockActive(state, type, attrs = {}) {
  const { $from, to, node } = state.selection;
  if (node) return node.hasMarkup(type, attrs);
  return to <= $from.end() && $from.parent.hasMarkup(type, attrs);
}

/** Walk up to the nearest ancestor of the requested type. */
function findAncestor(state, type) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === type) return { node: $from.node(d), pos: $from.before(d) };
  }
  return null;
}

function inList(state) {
  return Boolean(findAncestor(state, nodes.bullet_list) || findAncestor(state, nodes.ordered_list));
}

function taskActive(state) {
  const item = findAncestor(state, nodes.list_item);
  return Boolean(item && item.node.attrs.checked !== null);
}

/* ===========================================================================
 * Commands
 * ======================================================================== */

/** Every list item touched by the selection, collapsed cursor included. */
function listItemsInSelection(state) {
  const { from, to } = state.selection;
  const items = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === nodes.list_item) items.push({ node, pos });
  });
  return items;
}

/**
 * Toggle between plain bullets and checkboxes.
 *
 * A task is not a distinct list type in Markdown: it is a bullet whose content
 * starts with `[ ]`. So the toggle acts on the items' attribute, creating the
 * list first when needed.
 *
 * It works across the whole selection rather than on the ancestor of the
 * cursor: with several lines selected, only looking at `$from` left every other
 * item as a plain bullet -- and with a text selection inside a single paragraph
 * it found no list item at all, so the checkbox was silently never applied.
 */
function toggleTaskList(state, dispatch, view) {
  const items = listItemsInSelection(state);

  if (!items.length) {
    // Not in a list yet: wrap first, then tick whatever items that produced.
    return wrapInList(nodes.bullet_list)(state, (tr) => {
      if (!dispatch) return;
      dispatch(tr);

      const next = view.state;
      const created = listItemsInSelection(next);
      if (!created.length) return;

      // setNodeMarkup never changes the document size, so the positions
      // gathered above stay valid across the whole loop.
      const ticked = next.tr;
      for (const { node, pos } of created) {
        ticked.setNodeMarkup(pos, null, { ...node.attrs, checked: false });
      }
      view.dispatch(ticked);
    }, view);
  }

  if (dispatch) {
    // Mixed selection counts as "not yet tasks": one click makes it uniform.
    const makeTask = items.some((i) => i.node.attrs.checked === null);
    const tr = state.tr;
    for (const { node, pos } of items) {
      tr.setNodeMarkup(pos, null, { ...node.attrs, checked: makeTask ? false : null });
    }
    dispatch(tr);
  }
  return true;
}

/** Tick or untick the task under the cursor. */
function toggleChecked(state, dispatch) {
  const item = findAncestor(state, nodes.list_item);
  if (!item || item.node.attrs.checked === null) return false;
  if (dispatch) {
    dispatch(state.tr.setNodeMarkup(item.pos, null, {
      ...item.node.attrs,
      checked: !item.node.attrs.checked,
    }));
  }
  return true;
}

function insertNode(type, attrs) {
  return (state, dispatch) => {
    const node = type.createAndFill(attrs);
    if (!node) return false;
    if (dispatch) dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
    return true;
  };
}

/** A 3x3 table with a header row, the way a word processor inserts one. */
function insertTable(rows = 3, cols = 3) {
  return (state, dispatch) => {
    const headerCells = [];
    const bodyRows = [];
    for (let c = 0; c < cols; c++) headerCells.push(nodes.table_header.createAndFill());
    for (let r = 1; r < rows; r++) {
      const cells = [];
      for (let c = 0; c < cols; c++) cells.push(nodes.table_cell.createAndFill());
      bodyRows.push(nodes.table_row.create(null, cells));
    }
    const table = nodes.table.create(null, [
      nodes.table_row.create(null, headerCells),
      ...bodyRows,
    ]);

    if (dispatch) {
      const tr = state.tr.replaceSelectionWith(table);
      // Put the cursor in the first cell rather than making the user click in.
      const pos = tr.selection.from - table.nodeSize + 3;
      dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(pos))).scrollIntoView());
    }
    return true;
  };
}

function setLink(state, dispatch) {
  if (markActive(state, marks.link)) {
    return toggleMark(marks.link)(state, dispatch);
  }
  const href = window.prompt("Link URL:", "https://");
  if (!href) return false;

  const { from, to, empty } = state.selection;
  if (dispatch) {
    if (empty) {
      // With no selection, insert the URL as the link text.
      const text = schema.text(href, [marks.link.create({ href })]);
      dispatch(state.tr.replaceSelectionWith(text, false).scrollIntoView());
    } else {
      dispatch(state.tr.addMark(from, to, marks.link.create({ href })).scrollIntoView());
    }
  }
  return true;
}

function insertImage(state, dispatch) {
  // Say it up front: `img-src data: blob:` blocks every remote or relative
  // source, so any other URL is written into the Markdown but shows as a broken
  // image here. Better to state that than let the user find out.
  const src = window.prompt(
    "Image URL — only data: URIs display here, remote images are blocked by the " +
    "security policy. To use a local file, paste or drop it into the document instead:",
    "");
  if (!src) return false;
  const alt = window.prompt("Alternative text:", "") || null;
  return insertNode(nodes.image, { src, alt })(state, dispatch);
}

/* --- maths ---------------------------------------------------------------
 * A formula is an atom: its TeX lives in an attribute, not as editable text,
 * so what is rendered can never drift from what will be serialised. Editing it
 * therefore goes through a prompt, the same route as a link URL.
 * ---------------------------------------------------------------------- */

function promptMath(initial, display) {
  return window.prompt(
    display
      ? "Display maths — TeX, written as $$ … $$ in the source:"
      : "Inline maths — TeX, written as $ … $ in the source:",
    initial);
}

function insertMath(display) {
  return (state, dispatch) => {
    const tex = promptMath("", display);
    if (!tex || !tex.trim()) return false;
    return display
      ? insertNode(nodes.math_block, { tex: tex.trim() })(state, dispatch)
      : insertNode(nodes.math_inline, { tex: tex.trim(), display: false })(state, dispatch);
  };
}

/** Image files carried by a paste or a drop, in the order given. */
function imageFilesFrom(transfer) {
  if (!transfer) return [];
  return Array.from(transfer.files || []).filter((f) => f.type.startsWith("image/"));
}

/**
 * Place pasted or dropped images.
 *
 * `embed` belongs to the application: it owns the size warnings and the status
 * messages. This only puts what it returns where the user aimed. Each insert
 * reads `view.state` afresh rather than reusing a position captured before the
 * await -- the document may well have moved on while the file was being read.
 */
function handleImageFiles(view, embed, files, dropPos) {
  (async () => {
    if (dropPos != null) {
      const $pos = view.state.doc.resolve(dropPos);
      view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)));
    }
    for (const file of files) {
      const image = await embed(file);
      if (!image) continue;
      const node = nodes.image.create({ src: image.src, alt: image.alt });
      view.dispatch(view.state.tr.replaceSelectionWith(node, false).scrollIntoView());
    }
    view.focus();
  })();
}

/* ===========================================================================
 * Input rules
 *
 * Typing `##` or `-` produces the matching structure directly: that is what
 * lets you keep writing Markdown without leaving the rich mode.
 * ======================================================================== */

function buildInputRules() {
  const rules = [
    // > block quote
    wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
    // 1. numbered list
    wrappingInputRule(
      /^(\d+)\.\s$/,
      nodes.ordered_list,
      (match) => ({ order: +match[1] }),
      (match, node) => node.childCount + node.attrs.order === +match[1],
    ),
    // - bulleted list
    wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list),
    // ``` code block
    textblockTypeInputRule(/^```(\S*)\s$/, nodes.code_block, (match) => ({ params: match[1] || "" })),
    // # heading
    textblockTypeInputRule(/^(#{1,6})\s$/, nodes.heading, (match) => ({ level: match[1].length })),
    // --- horizontal rule
    new InputRule(/^(?:---|___|\*\*\*)\s$/, (state, match, start, end) =>
      state.tr.replaceRangeWith(start, end, nodes.horizontal_rule.create())),
  ];

  // - [ ] task: the bullet comes from the rule above, this one ticks the item
  // once the marker has been typed.
  rules.push(new InputRule(/^\[([ xX])\]\s$/, (state, match, start, end) => {
    const item = findAncestor(state, nodes.list_item);
    if (!item) return null;
    return state.tr
      .delete(start, end)
      .setNodeMarkup(item.pos, null, {
        ...item.node.attrs,
        checked: match[1] !== " ",
      });
  }));

  return inputRules({ rules });
}

/* ===========================================================================
 * Building the editor
 * ======================================================================== */

/**
 * @param {object} options
 * @param {HTMLElement} options.parent   host container
 * @param {Function} options.onChange    called on every document change
 * @param {Function} options.onState     called when the button states change
 * @param {Function} [options.embedImage] file -> Promise<{src, alt} | null>
 */
export function createRichEditor({ parent, onChange, onState, embedImage }) {
  const keys = {
    "Mod-b": toggleMark(marks.strong),
    "Mod-i": toggleMark(marks.em),
    "Mod-Shift-x": toggleMark(marks.strikethrough),
    "Mod-Shift-h": toggleMark(marks.highlight),
    "Mod-,": toggleMark(marks.subscript),
    "Mod-.": toggleMark(marks.superscript),
    "Mod-e": toggleMark(marks.code),
    "Mod-k": setLink,
    "Mod-z": undo,
    "Mod-y": redo,
    "Mod-Shift-z": redo,
    "Mod-Enter": chainCommands(exitCode, insertNode(nodes.hard_break)),
    "Shift-Enter": chainCommands(exitCode, insertNode(nodes.hard_break)),
    "Enter": splitListItem(nodes.list_item),
    "Mod-[": liftListItem(nodes.list_item),
    "Mod-]": sinkListItem(nodes.list_item),
    "Mod-Shift-8": wrapInList(nodes.bullet_list),
    "Mod-Shift-9": wrapInList(nodes.ordered_list),
    "Mod-Shift-7": toggleTaskList,
    "Mod-Shift-.": wrapIn(nodes.blockquote),
    "Mod-Shift-0": setBlockType(nodes.paragraph),
  };

  for (let level = 1; level <= 6; level++) {
    keys[`Mod-Shift-${level}`] = setBlockType(nodes.heading, { level });
  }

  // Tab moves between table cells, and otherwise nests the list item: the
  // expected behaviour in both contexts.
  keys["Tab"] = chainCommands(
    (state, dispatch, view) => (isInTable(state) ? goToNextCell(1)(state, dispatch, view) : false),
    sinkListItem(nodes.list_item),
  );
  keys["Shift-Tab"] = chainCommands(
    (state, dispatch, view) => (isInTable(state) ? goToNextCell(-1)(state, dispatch, view) : false),
    liftListItem(nodes.list_item),
  );

  const plugins = [
    buildInputRules(),
    keymap(keys),
    keymap(baseKeymap),
    history(),
    gapCursor(),
    tableEditing(),
  ];

  const view = new EditorView(parent, {
    state: EditorState.create({ doc: toDoc(""), plugins }),

    dispatchTransaction(tr) {
      const next = view.state.apply(tr);
      view.updateState(next);
      if (tr.docChanged) onChange();
      onState(status());
    },

    // Image files are embedded; everything else falls through to ProseMirror's
    // own paste and drop handling, which knows how to turn pasted HTML into
    // schema-valid nodes.
    handlePaste(v, event) {
      if (!embedImage) return false;
      const files = imageFilesFrom(event.clipboardData);
      if (!files.length) return false;
      handleImageFiles(v, embedImage, files, null);
      return true;
    },

    handleDrop(v, event) {
      if (!embedImage) return false;
      const files = imageFilesFrom(event.dataTransfer);
      if (!files.length) return false;
      const at = v.posAtCoords({ left: event.clientX, top: event.clientY });
      handleImageFiles(v, embedImage, files, at ? at.pos : null);
      return true;
    },

    // Clicking a formula opens its TeX. `handleClickOn` hands over the node and
    // its position directly, which beats working them back out of the DOM.
    handleClickOn(v, pos, node, nodePos) {
      if (node.type !== nodes.math_inline && node.type !== nodes.math_block) return false;

      const display = node.type === nodes.math_block || node.attrs.display;
      const tex = promptMath(node.attrs.tex, display);
      if (tex === null) return true; // cancelled: the click is still consumed

      // Emptying the box deletes the formula, which is the only way to get rid
      // of one that no longer parses.
      v.dispatch(tex.trim()
        ? v.state.tr.setNodeMarkup(nodePos, null, { ...node.attrs, tex: tex.trim() })
        : v.state.tr.delete(nodePos, nodePos + node.nodeSize));
      return true;
    },

    handleDOMEvents: {
      // Click on a task checkbox. The node is contenteditable=false, so the
      // event never reaches ProseMirror's selection machinery: catch it here.
      mousedown(view, event) {
        const target = event.target;
        if (!(target instanceof HTMLElement) || !target.classList.contains("task-check")) {
          return false;
        }
        const pos = view.posAtDOM(target, 0);
        const $pos = view.state.doc.resolve(pos);
        for (let d = $pos.depth; d > 0; d--) {
          const node = $pos.node(d);
          if (node.type === nodes.list_item && node.attrs.checked !== null) {
            view.dispatch(view.state.tr.setNodeMarkup($pos.before(d), null, {
              ...node.attrs,
              checked: !node.attrs.checked,
            }));
            event.preventDefault();
            return true;
          }
        }
        return false;
      },
    },
  });

  /** Current state, used to mirror the ribbon buttons. */
  function status() {
    const state = view.state;
    const headingLevel = [1, 2, 3, 4, 5, 6]
      .find((l) => blockActive(state, nodes.heading, { level: l }));

    return {
      block: headingLevel ? `h${headingLevel}`
        : blockActive(state, nodes.code_block) ? "code"
        : "p",
      strong: markActive(state, marks.strong),
      em: markActive(state, marks.em),
      strikethrough: markActive(state, marks.strikethrough),
      highlight: markActive(state, marks.highlight),
      subscript: markActive(state, marks.subscript),
      superscript: markActive(state, marks.superscript),
      code: markActive(state, marks.code),
      link: markActive(state, marks.link),
      bullet_list: Boolean(findAncestor(state, nodes.bullet_list)),
      ordered_list: Boolean(findAncestor(state, nodes.ordered_list)),
      task: taskActive(state),
      blockquote: Boolean(findAncestor(state, nodes.blockquote)),
      inTable: isInTable(state),
      inList: inList(state),
      canUndo: undoDepth(state) > 0,
      canRedo: redoDepth(state) > 0,
    };
  }

  /** Run a command and hand focus back to the editor. */
  function run(command) {
    command(view.state, view.dispatch, view);
    view.focus();
  }

  return {
    view,
    status,
    run,
    focus: () => view.focus(),
    hasFocus: () => view.hasFocus(),
    destroy: () => view.destroy(),

    getMarkdown: () => toMarkdown(view.state.doc),

    setMarkdown(markdown) {
      const doc = toDoc(markdown);
      // Replace the document outside a content transaction: the rich editor's
      // history must not fill up with keystrokes made in the source pane.
      view.updateState(EditorState.create({ doc, plugins: view.state.plugins }));
      onState(status());
    },

    commands: {
      undo: () => run(undo),
      redo: () => run(redo),
      paragraph: () => run(setBlockType(nodes.paragraph)),
      heading: (level) => run(setBlockType(nodes.heading, { level })),
      codeBlock: () => run(setBlockType(nodes.code_block)),
      strong: () => run(toggleMark(marks.strong)),
      em: () => run(toggleMark(marks.em)),
      strikethrough: () => run(toggleMark(marks.strikethrough)),
      highlight: () => run(toggleMark(marks.highlight)),
      subscript: () => run(toggleMark(marks.subscript)),
      superscript: () => run(toggleMark(marks.superscript)),
      code: () => run(toggleMark(marks.code)),
      link: () => run(setLink),
      image: () => run(insertImage),
      math: () => run(insertMath(false)),
      mathBlock: () => run(insertMath(true)),
      bulletList: () => run(wrapInList(nodes.bullet_list)),
      orderedList: () => run(wrapInList(nodes.ordered_list)),
      taskList: () => run(toggleTaskList),
      toggleChecked: () => run(toggleChecked),
      blockquote: () => run(wrapIn(nodes.blockquote)),

      // Inside a list, plain `lift` pulls the item out of the list entirely
      // instead of raising it one level -- so try liftListItem first and keep
      // `lift` only for what is not a list (a block quote, typically).
      outdent: () => run(chainCommands(liftListItem(nodes.list_item), lift)),
      horizontalRule: () => run(insertNode(nodes.horizontal_rule)),
      table: () => run(insertTable()),
      addColumn: () => run(addColumnAfter),
      addRow: () => run(addRowAfter),
      deleteColumn: () => run(deleteColumn),
      deleteRow: () => run(deleteRow),
      deleteTable: () => run(deleteTable),
    },
  };
}
