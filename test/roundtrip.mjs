/* ---------------------------------------------------------------------------
 * Tests d'aller-retour Markdown <-> ProseMirror.
 *
 * Editer en mode riche regenere la source depuis le modele : ce qui n'est pas
 * representable dans le schema disparait. Ces tests sont donc la garantie
 * qu'aucune construction supportee par l'apercu n'est detruite en passant par
 * l'editeur riche.
 *
 * Deux proprietes distinctes sont verifiees :
 *
 *   - la CONSERVATION : le contenu semantique survit a un aller-retour ;
 *   - la STABILITE : un second aller-retour ne change plus rien. C'est la
 *     propriete qui compte vraiment. Une normalisation (`*` devenant `-`) est
 *     acceptable ; une source qui derive a chaque passage ne l'est pas.
 *
 * Le code teste manipule le DOM, il tourne donc dans un vrai navigateur.
 *
 *   npm install --no-save puppeteer
 *   node test/roundtrip.mjs
 * ------------------------------------------------------------------------- */

import * as esbuild from "esbuild";
import puppeteer from "puppeteer";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* --- Cas couverts -------------------------------------------------------- */

const CASES = [
  ["titres", "# Un\n\n## Deux\n\n### Trois\n"],
  ["emphase", "Du *italique*, du **gras**, du ***deux***.\n"],
  ["barre", "Du ~~texte barre~~ ici.\n"],
  ["code inline", "Appeler `npm run build` puis `node verify.mjs`.\n"],
  ["liens", "Voir [le site](https://example.com) et [avec titre](https://example.com \"Titre\").\n"],
  ["images", "![texte alternatif](image.png)\n"],
  ["citation", "> Une citation\n>\n> sur deux paragraphes.\n"],
  ["liste a puces", "- alpha\n- beta\n- gamma\n"],
  ["liste numerotee", "1. premier\n2. deuxieme\n3. troisieme\n"],
  ["liste imbriquee", "- alpha\n  - alpha.1\n  - alpha.2\n- beta\n"],
  ["taches", "- [ ] a faire\n- [x] fait\n- puce ordinaire\n"],
  ["taches imbriquees", "- [ ] parent\n  - [x] enfant\n"],
  ["bloc de code", "```js\nconst secret = 42;\n```\n"],
  ["bloc sans langage", "```\ntexte brut\n```\n"],
  ["separateur", "avant\n\n---\n\napres\n"],
  ["tableau simple", "| a | b |\n| --- | --- |\n| 1 | 2 |\n"],
  ["tableau aligne", "| gauche | centre | droite |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |\n"],
  ["tableau avec emphase", "| col |\n| --- |\n| **gras** et `code` |\n"],
  ["tableau avec barre verticale", "| col |\n| --- |\n| a \\| b |\n"],
  ["html bloc", "avant\n\n<details><summary>Plus</summary>\ncache\n</details>\n\napres\n"],
  ["html inline", "Un <kbd>Ctrl</kbd> au milieu.\n"],
  ["melange", "# Titre\n\nTexte **gras**.\n\n- [ ] tache\n- puce\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n> citation\n\n```sh\necho ok\n```\n"],

  // Cas ou le serialiseur travaille avec un delimiteur courant non vide : sans
  // precaution, ce delimiteur se recopie a l'interieur des cellules.
  ["tableau dans citation", "> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n"],
  ["tableau dans liste", "- element\n\n  | a | b |\n  | --- | --- |\n  | 1 | 2 |\n"],
  ["bloc de code dans liste", "- element\n\n  ```js\n  const x = 1;\n  ```\n"],
  ["citation imbriquee", "> niveau un\n>\n> > niveau deux\n"],
  ["liste large", "- premier\n\n- deuxieme\n\n- troisieme\n"],
  ["liste numerotee decalee", "5. cinq\n6. six\n7. sept\n"],
  ["retour a la ligne force", "ligne un\\\nligne deux\n"],
  ["caracteres a echapper", "Un \\* etoile, un \\_ tiret bas, un \\` accent.\n"],
  ["lien dans tableau", "| col |\n| --- |\n| [lien](https://example.com) |\n"],
  ["tache avec emphase", "- [x] tache **importante**\n"],
  ["html dans liste", "- element avec <kbd>Ctrl</kbd>\n"],
];

/* --- Bundle du moteur, execute dans le navigateur ------------------------ */

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

/* --- Execution ----------------------------------------------------------- */

let fails = 0;
const show = (s) => JSON.stringify(s);

console.log("\n--- aller-retour Markdown <-> ProseMirror ---\n");

for (const [name, src] of CASES) {
  let result;
  try {
    result = await tab.evaluate((s) => window.__rt(s), src);
  } catch (err) {
    console.log(`  FAIL  ${name} -- exception : ${String(err).split("\n")[0]}`);
    fails++;
    continue;
  }

  const stable = result.once === result.twice;
  if (!stable) {
    console.log(`  FAIL  ${name} -- instable`);
    console.log(`        passe 1 : ${show(result.once)}`);
    console.log(`        passe 2 : ${show(result.twice)}`);
    fails++;
    continue;
  }

  // Le rendu doit survivre : on compare le HTML produit par la source d'origine
  // a celui produit apres aller-retour. C'est plus exigeant qu'une egalite de
  // texte, et plus proche de ce que l'utilisateur constate.
  const [htmlBefore, htmlAfter] = await tab.evaluate(
    (a, b) => [window.__render(a), window.__render(b)], src, result.once);
  const norm = (h) => h.replace(/\s+/g, " ").trim();

  if (norm(htmlBefore) !== norm(htmlAfter)) {
    console.log(`  FAIL  ${name} -- le rendu change apres aller-retour`);
    console.log(`        avant : ${show(norm(htmlBefore))}`);
    console.log(`        apres : ${show(norm(htmlAfter))}`);
    console.log(`        source regeneree : ${show(result.once)}`);
    fails++;
    continue;
  }

  console.log(`  ok    ${name}`);
}

if (crashes.length) {
  console.log(`\n  erreurs JavaScript : ${crashes.slice(0, 3).join(" | ")}`);
  fails += crashes.length;
}

await browser.close();
console.log();
if (fails) {
  console.error(`  ${fails} cas en echec\n`);
  process.exit(1);
}
console.log("  aucun contenu perdu lors de l'aller-retour\n");
