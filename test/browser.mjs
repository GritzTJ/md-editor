/* ---------------------------------------------------------------------------
 * Tests de bout en bout dans un vrai navigateur.
 *
 * Ils portent sur le fichier construit, servi comme en production. L'essentiel
 * n'est pas de verifier que les boutons repondent, mais que la promesse du
 * projet tient : le navigateur doit refuser toute sortie reseau, l'apercu doit
 * neutraliser le HTML hostile, et le fichier autonome doit demarrer seul sans
 * emporter le document de l'utilisateur.
 *
 * puppeteer n'est volontairement pas une dependance du projet : il telecharge
 * un Chrome complet, ce qui alourdirait `npm install` et la construction de
 * l'image pour tout le monde.
 *
 *   npm run dev &                      # ou : docker run -p 8080:8080 md-editor
 *   npm install --no-save puppeteer
 *   node test/browser.mjs
 *
 * Variables d'environnement :
 *   TARGET                        URL a tester (defaut http://localhost:8080/)
 *   PUPPETEER_EXECUTABLE_PATH     navigateur a utiliser
 * ------------------------------------------------------------------------- */

import puppeteer from "puppeteer";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TARGET = process.env.TARGET || "http://localhost:8080/";
const DL = mkdtempSync(join(tmpdir(), "md-editor-test-"));
mkdirSync(DL, { recursive: true });

let fails = 0;
const ok = (name, cond, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${detail ? " -- " + detail : ""}`);
  if (!cond) fails++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: "shell",
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

async function newPage() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [], csp = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error") errors.push(t);
    if (/Content Security Policy/i.test(t)) csp.push(t);
  });
  return { page, errors, csp };
}

const { page, errors, csp } = await newPage();
const cdp = await page.createCDPSession();

/** Selectionne un bouton par son libelle exact. */
const btn = async (label) => {
  for (const e of await page.$$("button")) {
    if ((await e.evaluate((n) => n.textContent)) === label) return e;
  }
  throw new Error(`bouton introuvable : ${label}`);
};

async function clearSource() {
  await page.click(".cm-content");
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
}

/** Remplace le contenu du panneau source en simulant une frappe reelle. */
async function retype(content) {
  await clearSource();
  await page.type(".cm-content", content);
  await wait(400);
}

/**
 * Pose un contenu d'un bloc, comme un collage.
 *
 * A utiliser des que la source contient du HTML : lang-markdown delegue les
 * blocs HTML au parseur de @codemirror/lang-html, dont `autoCloseTags` ajoute
 * la balise fermante quand on tape « > ». Frappe caractere par caractere, un
 * fragment deja complet ressortirait donc avec une fermeture en trop.
 */
async function pasteSource(content) {
  await clearSource();
  await cdp.send("Input.insertText", { text: content });
  await wait(500);
}

/* ========================= 1. chargement ========================= */
console.log("\n--- chargement et amorcage ---");
await page.goto(TARGET, { waitUntil: "networkidle0" });
await wait(600);

ok("aucune erreur JavaScript au demarrage", errors.length === 0, errors.slice(0, 3).join(" | "));
ok("aucune violation CSP au demarrage", csp.length === 0, csp.slice(0, 3).join(" | "));
ok("la barre d'outils est rendue", (await page.$(".tb")) !== null);
ok("CodeMirror est monte", (await page.$(".cm-editor .cm-content")) !== null);
ok("l'apercu rend le document d'exemple",
  (await page.$eval("#preview h1", (e) => e.textContent).catch(() => null)) === "Editeur Markdown local");
ok("les tableaux GFM sont rendus", (await page.$$eval("#preview table th", (e) => e.length)) === 2);

/* ========================= 2. edition ========================= */
console.log("\n--- edition et rendu ---");
// markdown() installe markdownKeymap, qui prolonge automatiquement les listes :
// apres « - alpha » + Entree le tiret suivant est deja la. On tape donc comme
// un humain, sans repeter le marqueur.
await retype("# Bonjour\n\nUn **essai** avec `du code`.\n\n- alpha\nbeta");

const lines = await page.$$eval(".cm-line", (ls) => ls.map((l) => l.textContent));
ok("la continuation automatique des listes fonctionne",
  lines.at(-1) === "- beta", JSON.stringify(lines.slice(-2)));
ok("le titre saisi apparait dans l'apercu",
  (await page.$eval("#preview h1", (e) => e.textContent)) === "Bonjour");
ok("le gras est rendu", (await page.$$eval("#preview strong", (e) => e.length)) === 1);
ok("le code inline est rendu", (await page.$$eval("#preview code", (e) => e.length)) === 1);
ok("la liste est rendue", (await page.$$eval("#preview li", (e) => e.length)) === 2);

const sb = await page.$eval(".sb", (e) => e.textContent);
ok("la barre d'etat compte les mots", /\d+ mots/.test(sb), sb.trim());
ok("l'indicateur « modifie » est actif", /modifie/.test(sb));

/* ========================= 3. assainissement ========================= */
console.log("\n--- assainissement du HTML ---");
await page.evaluate(() => { window.__xss = 0; });
await retype([
  "<script>window.__xss=1<\/script>",
  '<img src=x onerror="window.__xss=1">',
  '<a href="javascript:window.__xss=1">lien</a>',
  '<iframe src="https://example.com"></iframe>',
  "<style>body{display:none}</style>",
  '<form action="https://evil.test"><input name="a"></form>',
  "[lien normal](https://example.com)",
].join("\n\n"));

const rendered = await page.$eval("#preview", (e) => e.innerHTML);
ok("aucun script execute", (await page.evaluate(() => window.__xss)) === 0);
ok("aucune balise <script> conservee", !/<script/i.test(rendered));
ok("aucun gestionnaire onerror conserve", !/onerror/i.test(rendered));
ok("aucune URL javascript: conservee", !/javascript:/i.test(rendered));
ok("aucune <iframe> conservee", !/<iframe/i.test(rendered));
ok("aucune <style> conservee", !/<style/i.test(rendered));
ok("aucun <form> conserve", !/<form/i.test(rendered));
ok("les liens legitimes recoivent rel=noopener noreferrer",
  await page.$eval('#preview a[href^="https://example.com"]',
    (a) => a.rel === "noopener noreferrer" && a.target === "_blank").catch(() => false));
ok("l'interface reste intacte apres injection", (await page.$(".tb")) !== null);

/* ========================= 4. etancheite reseau ========================= */
console.log("\n--- etancheite reseau ---");
// La valeur de retour des API reseau ne prouve rien : le constructeur
// WebSocket ne leve pas d'exception synchrone, et sendBeacon() renvoie `true`
// des la mise en file, avant que la CSP n'intervienne. Le seul temoin qui
// fasse autorite est l'evenement `securitypolicyviolation`.
const violations = await page.evaluate(async () => {
  const seen = [];
  document.addEventListener("securitypolicyviolation", (e) =>
    seen.push(e.effectiveDirective + " -> " + e.blockedURI));

  try { await fetch("https://example.test/leak"); } catch {}
  try { new WebSocket("wss://example.test/leak"); } catch {}
  try { navigator.sendBeacon("https://example.test/leak", "secret"); } catch {}
  try { new Image().src = "https://example.test/pixel.png"; } catch {}
  try { await import("https://example.test/mod.js"); } catch {}

  await new Promise((r) => setTimeout(r, 1200));
  return seen;
});
const blocked = (f) => violations.some((v) => v.includes(f));
ok("fetch() est bloque par connect-src",
  blocked("connect-src -> https://example.test/leak"), violations.join(" | "));
ok("WebSocket est bloque par connect-src", blocked("connect-src -> wss://example.test/leak"));
ok("sendBeacon est bloque par connect-src",
  violations.filter((v) => v.includes("connect-src -> https://example.test/leak")).length >= 2);
ok("les images distantes sont bloquees par img-src",
  blocked("img-src -> https://example.test/pixel.png"));
ok("les imports dynamiques distants sont bloques", blocked("https://example.test/mod.js"));

/* ========================= 5. interface ========================= */
console.log("\n--- interface ---");
const display = (sel) => page.$eval(sel, (e) => getComputedStyle(e).display);

await (await btn("Editeur")).click();
ok("mode editeur : l'apercu est masque", (await display(".pane-preview")) === "none");
await (await btn("Apercu")).click();
ok("mode apercu : l'editeur est masque", (await display(".pane-editor")) === "none");
await (await btn("Partage")).click();
ok("mode partage : les deux panneaux sont visibles",
  (await display(".pane-preview")) !== "none" && (await display(".pane-editor")) !== "none");

const t0 = await page.evaluate(() => document.documentElement.dataset.theme);
await (await btn("Theme")).click();
const t1 = await page.evaluate(() => document.documentElement.dataset.theme);
ok("le theme bascule", t0 !== t1, `${t0} -> ${t1}`);
await (await btn("Theme")).click();

await (await btn("?")).click();
ok("la fenetre « A propos » s'ouvre", (await page.$(".sheet")) !== null);
await (await btn("Fermer")).click();
ok("la fenetre « A propos » se ferme", (await page.$(".sheet")) === null);

/* ========================= 6. brouillon local ========================= */
console.log("\n--- brouillon local ---");
const draft = () => page.evaluate(() => localStorage.getItem("mdedit.draft"));
ok("rien n'est stocke par defaut", (await draft()) === null);
await page.click(".chk input");
await wait(300);
ok("le brouillon est ecrit une fois l'option cochee", (await draft()) !== null);
await page.click(".chk input");
await wait(300);
ok("le brouillon est efface au decochage", (await draft()) === null);

/* ========================= 7. application autonome ========================= */
console.log("\n--- fichier autonome telechargeable ---");
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL });

const CANARY = "MON SECRET ABSOLU 4242";
await retype(CANARY);
await (await btn("Telecharger l'app")).click();

const standalonePath = join(DL, "md-editor.html");
for (let i = 0; i < 40 && !existsSync(standalonePath); i++) await wait(200);
ok("le fichier md-editor.html est telecharge", existsSync(standalonePath), readdirSync(DL).join(","));

if (existsSync(standalonePath)) {
  const file = readFileSync(standalonePath, "utf8");
  ok("le fichier autonome ne contient pas le document de l'utilisateur", !file.includes(CANARY));

  const fileJs = file.match(/<script id="app-js">([\s\S]*?)<\/script>/)[1];
  const declared = file.match(/script-src 'sha256-([^']+)'/)[1];
  ok("le condensat du fichier autonome correspond a son script",
    createHash("sha256").update(fileJs, "utf8").digest("base64") === declared);

  // Le test decisif : le fichier telecharge doit demarrer seul, en file://.
  const { page: p2, errors: e2, csp: c2 } = await newPage();
  await p2.goto("file://" + standalonePath, { waitUntil: "networkidle0" });
  await wait(800);
  ok("le fichier autonome demarre en file:// sans erreur", e2.length === 0, e2.slice(0, 2).join(" | "));
  ok("le fichier autonome n'emet aucune violation CSP", c2.length === 0, c2.slice(0, 2).join(" | "));
  ok("le fichier autonome monte CodeMirror", (await p2.$(".cm-editor .cm-content")) !== null);
  ok("le fichier autonome rend l'apercu",
    (await p2.$eval("#preview h1", (e) => e.textContent).catch(() => null)) === "Editeur Markdown local");
  await p2.close();
}

/* ========================= 8. edition dans le rendu ========================= */
console.log("\n--- edition dans le rendu ---");

/** Texte du panneau source, reconstitue depuis les lignes affichees. */
const sourceText = () =>
  page.$$eval(".cm-line", (ls) => ls.map((l) => l.textContent).join("\n"));

/** Vide l'editeur riche et y tape du contenu. */
async function retypeRich(content) {
  await page.click("#rich .ProseMirror");
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  if (content) await page.keyboard.type(content);
  await wait(500);
}

await retype("# Depart\n\nTexte initial.");
await (await btn("Edition")).click();
await wait(400);

ok("le ruban de mise en forme apparait",
  (await page.$eval(".rb", (e) => getComputedStyle(e).display)) !== "none");
ok("l'editeur riche est monte", (await page.$("#rich .ProseMirror")) !== null);
ok("l'apercu en lecture est masque",
  (await page.$eval("#preview", (e) => getComputedStyle(e).display)) === "none");
ok("le rendu reprend le document courant",
  (await page.$eval("#rich h1", (e) => e.textContent).catch(() => null)) === "Depart");

// --- la frappe dans le rendu remonte vers la source ---
await retypeRich("Ecrit dans le rendu");
ok("la frappe dans le rendu met a jour la source",
  (await sourceText()).includes("Ecrit dans le rendu"), await sourceText());

// --- le ruban applique bien du Markdown ---
await page.keyboard.down("Control");
await page.keyboard.press("KeyA");
await page.keyboard.up("Control");
await (await btn("G")).click();
await wait(400);
ok("le bouton Gras produit du **gras** dans la source",
  /\*\*Ecrit dans le rendu\*\*/.test(await sourceText()), await sourceText());

await page.keyboard.down("Control");
await page.keyboard.press("KeyA");
await page.keyboard.up("Control");
await (await btn("G")).click();
await wait(300);

await page.select(".rb-select", "h2");
await wait(400);
ok("le selecteur de style produit un titre de niveau 2",
  /^##\s/.test((await sourceText()).trim()), await sourceText());

await page.select(".rb-select", "p");
await wait(300);

// --- listes et taches ---
await retypeRich("alpha");
await (await btn("Taches")).click();
await wait(400);
ok("le bouton Taches produit une case a cocher",
  /^-\s\[ \]\salpha/.test((await sourceText()).trim()), await sourceText());

await page.click("#rich .task-check");
await wait(400);
ok("cliquer la case coche la tache dans la source",
  /^-\s\[x\]\salpha/.test((await sourceText()).trim()), await sourceText());

ok("la case cochee se reflete dans le rendu",
  (await page.$eval("#rich li.task-item", (e) => e.getAttribute("data-checked"))) === "true");

// --- tableaux ---
await retypeRich("");
await (await btn("Tableau")).click();
await wait(500);
const tableSource = await sourceText();
ok("le bouton Tableau produit une table GFM",
  /\|\s*\|/.test(tableSource) && /\|\s*---\s*\|/.test(tableSource), tableSource.slice(0, 80));
ok("les outils de tableau apparaissent quand le curseur y est",
  (await page.$eval(".rb-group", (e) => getComputedStyle(e).display)) !== "none");
ok("le tableau est rendu dans l'editeur riche",
  (await page.$$eval("#rich table th", (e) => e.length)) === 3);

await (await btn("+Col")).click();
await wait(400);
ok("ajouter une colonne se repercute dans le rendu",
  (await page.$$eval("#rich table th", (e) => e.length)) === 4);

// --- la source reste maitresse : ce qui est tape a gauche descend a droite ---
await retype("## Depuis la source\n\nAvec du *style*.");
await wait(500);
ok("la frappe dans la source met a jour le rendu",
  (await page.$eval("#rich h2", (e) => e.textContent).catch(() => null)) === "Depuis la source");
ok("l'emphase saisie dans la source est rendue",
  (await page.$$eval("#rich em", (e) => e.length)) === 1);

// --- le HTML brut traverse l'aller-retour ---
const HTML_FIXTURE = "Avant\n\n<details><summary>Plus</summary>\ncache\n</details>\n\nApres";
await pasteSource(HTML_FIXTURE);
ok("la source recoit le fragment HTML sans alteration",
  (await sourceText()) === HTML_FIXTURE, await sourceText());
await wait(400);
ok("le HTML brut est signale comme non modifiable dans le rendu",
  (await page.$("#rich .raw-html")) !== null);

// On edite le paragraphe voisin, pas le bloc HTML. Cliquer sur ce dernier le
// selectionnerait comme un noeud atomique -- taper le remplacerait alors, ce
// qui est le comportement normal d'un editeur, mais pas ce qu'on teste ici.
await page.click("#rich p");
await page.keyboard.press("End");
await page.keyboard.type(" !");
await wait(500);
const afterEdit = await sourceText();
ok("le HTML brut survit a une edition ailleurs dans le document",
  afterEdit.includes("<details><summary>Plus</summary>"), afterEdit);
ok("l'edition voisine a bien eu lieu", afterEdit.includes("Avant !"), afterEdit);

// --- sortir du mode riche ne perd rien ---
await retypeRich("Contenu final du rendu");
await (await btn("Edition")).click();
await wait(400);
ok("quitter le mode riche repercute les dernieres modifications",
  (await sourceText()).includes("Contenu final du rendu"), await sourceText());
ok("l'apercu en lecture revient",
  (await page.$eval("#preview", (e) => getComputedStyle(e).display)) !== "none");
ok("le ruban disparait",
  (await page.$eval(".rb", (e) => getComputedStyle(e).display)) === "none");

/* ========================= 9. export du rendu ========================= */
console.log("\n--- export du rendu ---");
await retype("# Rapport\n\nContenu **exporte**.");
await (await btn("Exporter HTML")).click();

const exportPath = join(DL, "sans-titre.html");
for (let i = 0; i < 40 && !existsSync(exportPath); i++) await wait(200);
const exported = existsSync(exportPath) ? readFileSync(exportPath, "utf8") : "";
ok("le rendu est exporte en HTML", exported.length > 0, readdirSync(DL).join(","));
ok("l'export contient le document rendu", /<h1[^>]*>Rapport<\/h1>/.test(exported));
ok("l'export embarque sa propre CSP verrouillee", /default-src 'none'/.test(exported));
ok("l'export ne contient aucun script", !/<script/i.test(exported));

await browser.close();
console.log();
if (fails) {
  console.error(`  ${fails} test(s) en echec\n`);
  process.exit(1);
}
console.log("  tous les tests passent\n");
