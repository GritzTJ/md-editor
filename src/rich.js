/* ---------------------------------------------------------------------------
 * Editeur riche : le document « propre » devient la surface d'edition.
 *
 * L'interet de ProseMirror ici n'est pas l'apparence mais la contrainte : le
 * document manipule est un arbre valide au regard du schema Markdown. On ne
 * peut donc pas produire, meme par accident, un etat qui ne se resérialise
 * pas -- contrairement a un `contenteditable`, ou le navigateur genere un DOM
 * arbitraire qu'il faut ensuite deviner.
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
  smartQuotes,
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
 * Interrogation de l'etat courant
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

/** Remonte jusqu'au premier ancetre du type demande. */
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
 * Commandes
 * ======================================================================== */

/**
 * Bascule entre puce ordinaire et case a cocher.
 *
 * Une tache n'est pas un type de liste distinct en Markdown : c'est une puce
 * dont le contenu commence par `[ ]`. Le basculement agit donc sur l'attribut
 * de l'element, apres avoir cree la liste si besoin.
 */
function toggleTaskList(state, dispatch, view) {
  const item = findAncestor(state, nodes.list_item);

  if (!item) {
    // Pas encore dans une liste : on en cree une, puis on rappelle la commande
    // sur le nouvel etat pour cocher l'element fraichement produit.
    return wrapInList(nodes.bullet_list)(state, (tr) => {
      if (!dispatch) return;
      dispatch(tr);
      const next = view.state;
      const created = findAncestor(next, nodes.list_item);
      if (created) {
        view.dispatch(next.tr.setNodeMarkup(created.pos, null, {
          ...created.node.attrs,
          checked: false,
        }));
      }
    }, view);
  }

  if (dispatch) {
    const checked = item.node.attrs.checked === null ? false : null;
    dispatch(state.tr.setNodeMarkup(item.pos, null, { ...item.node.attrs, checked }));
  }
  return true;
}

/** Coche ou decoche la tache sous le curseur. */
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

/** Tableau 3x3 avec ligne d'en-tete, comme l'insertion d'un traitement de texte. */
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
      // Placer le curseur dans la premiere cellule plutot que d'obliger
      // l'utilisateur a cliquer dedans.
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
  const href = window.prompt("Adresse du lien :", "https://");
  if (!href) return false;

  const { from, to, empty } = state.selection;
  if (dispatch) {
    if (empty) {
      // Sans selection, on insere l'adresse comme texte du lien.
      const text = schema.text(href, [marks.link.create({ href })]);
      dispatch(state.tr.replaceSelectionWith(text, false).scrollIntoView());
    } else {
      dispatch(state.tr.addMark(from, to, marks.link.create({ href })).scrollIntoView());
    }
  }
  return true;
}

function insertImage(state, dispatch) {
  const src = window.prompt("Adresse de l'image :", "");
  if (!src) return false;
  const alt = window.prompt("Texte alternatif :", "") || null;
  return insertNode(nodes.image, { src, alt })(state, dispatch);
}

/* ===========================================================================
 * Raccourcis de frappe
 *
 * Taper « ## » ou « - » produit directement la structure correspondante :
 * c'est ce qui permet de continuer a ecrire en Markdown sans quitter le mode
 * riche.
 * ======================================================================== */

function buildInputRules() {
  const rules = [
    // > citation
    wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
    // 1. liste numerotee
    wrappingInputRule(
      /^(\d+)\.\s$/,
      nodes.ordered_list,
      (match) => ({ order: +match[1] }),
      (match, node) => node.childCount + node.attrs.order === +match[1],
    ),
    // - liste a puces
    wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list),
    // ``` bloc de code
    textblockTypeInputRule(/^```(\S*)\s$/, nodes.code_block, (match) => ({ params: match[1] || "" })),
    // # titre
    textblockTypeInputRule(/^(#{1,6})\s$/, nodes.heading, (match) => ({ level: match[1].length })),
    // --- separateur
    new InputRule(/^(?:---|___|\*\*\*)\s$/, (state, match, start, end) =>
      state.tr.replaceRangeWith(start, end, nodes.horizontal_rule.create())),
  ];

  // - [ ] tache : la puce est creee par la regle ci-dessus, celle-ci coche
  // l'element une fois le marqueur tape.
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
 * Construction de l'editeur
 * ======================================================================== */

/**
 * @param {object} options
 * @param {HTMLElement} options.parent   conteneur d'accueil
 * @param {Function} options.onChange    appele a chaque modification du document
 * @param {Function} options.onState     appele quand l'etat des boutons change
 */
export function createRichEditor({ parent, onChange, onState }) {
  const keys = {
    "Mod-b": toggleMark(marks.strong),
    "Mod-i": toggleMark(marks.em),
    "Mod-Shift-x": toggleMark(marks.strikethrough),
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
    "Backspace": undefined, // laisse baseKeymap operer
  };

  for (let level = 1; level <= 6; level++) {
    keys[`Mod-Shift-${level}`] = setBlockType(nodes.heading, { level });
  }

  // Tab circule entre les cellules d'un tableau, et sinon imbrique la liste :
  // c'est le comportement attendu dans les deux contextes.
  keys["Tab"] = chainCommands(
    (state, dispatch, view) => (isInTable(state) ? goToNextCell(1)(state, dispatch, view) : false),
    sinkListItem(nodes.list_item),
  );
  keys["Shift-Tab"] = chainCommands(
    (state, dispatch, view) => (isInTable(state) ? goToNextCell(-1)(state, dispatch, view) : false),
    liftListItem(nodes.list_item),
  );

  delete keys["Backspace"];

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

    handleDOMEvents: {
      // Clic sur la case a cocher d'une tache. Le noeud etant en
      // contenteditable=false, l'evenement n'atteint pas le systeme de
      // selection de ProseMirror : on l'intercepte ici.
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

  /** Etat courant, pour refleter les boutons du ruban. */
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

  /** Applique une commande et rend le focus a l'editeur. */
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
      // Remplacement du document sans passer par une transaction de contenu :
      // l'historique de l'editeur riche ne doit pas se remplir des frappes
      // faites dans le panneau source.
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
      code: () => run(toggleMark(marks.code)),
      link: () => run(setLink),
      image: () => run(insertImage),
      bulletList: () => run(wrapInList(nodes.bullet_list)),
      orderedList: () => run(wrapInList(nodes.ordered_list)),
      taskList: () => run(toggleTaskList),
      toggleChecked: () => run(toggleChecked),
      blockquote: () => run(wrapIn(nodes.blockquote)),
      lift: () => run(lift),
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
