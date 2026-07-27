/* ---------------------------------------------------------------------------
 * Verifications post-build.
 *
 * Ces controles portent sur le fichier reellement livre, pas sur les sources :
 * ils attrapent les regressions que seul l'assemblage peut introduire (script
 * tronque par une balise fermante, condensat CSP desynchronise, dependance
 * ayant reintroduit un appel reseau).
 *
 *   node verify.mjs
 * ------------------------------------------------------------------------- */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const html = await readFile(resolve(root, "dist/index.html"), "utf8");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? " -- " + detail : ""}`);
  if (!ok) failures++;
};

/* --- extraction des blocs bruts ----------------------------------------- */

const scriptMatch = html.match(/<script id="app-js">([\s\S]*?)<\/script>/);
const styleMatch = html.match(/<style id="app-css">([\s\S]*?)<\/style>/);
const cspMatch = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/);

check("le script inline est delimite proprement", Boolean(scriptMatch));
check("la feuille de style inline est delimitee proprement", Boolean(styleMatch));
check("la CSP est presente dans le document", Boolean(cspMatch));
if (!scriptMatch || !styleMatch || !cspMatch) process.exit(1);

const js = scriptMatch[1];
const css = styleMatch[1];
const csp = cspMatch[1];

/* --- 1. Le script embarque est du JavaScript valide et complet ----------- */

// Un `</script` non echappe dans le bundle couperait le script en plein vol :
// le fichier resterait un HTML valide, mais l'application serait cassee. On
// verifie donc la syntaxe du fragment tel qu'il est extrait du document.
const tmp = join(mkdtempSync(join(tmpdir(), "mdverify-")), "app.js");
writeFileSync(tmp, js.replace(/<\\\/script/gi, "</script"), "utf8");
let syntaxOk = true;
let syntaxErr = "";
try {
  execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
} catch (e) {
  syntaxOk = false;
  syntaxErr = String(e.stderr).split("\n").slice(0, 3).join(" ");
}
check("le script extrait du HTML est syntaxiquement valide", syntaxOk, syntaxErr);
check("aucun '</script' non echappe dans le bundle", !/<\/script/i.test(js));
check("aucun '</style' dans la feuille de style", !/<\/style/i.test(css));

/* --- 2. Le condensat de la CSP correspond au script livre ---------------- */

const declared = (csp.match(/script-src 'sha256-([^']+)'/) || [])[1];
const actual = createHash("sha256").update(js, "utf8").digest("base64");
check("le condensat script-src correspond aux octets du script", declared === actual,
  declared === actual ? "" : `declare ${declared}, calcule ${actual}`);

/* --- 3. La CSP interdit bien toute sortie reseau -------------------------- */

for (const directive of [
  "default-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
]) {
  check(`CSP: ${directive}`, csp.includes(directive));
}
check("CSP: img-src n'autorise aucun schema distant", /img-src (?:data:|blob:|\s)+(?:;|$)/.test(csp));
check("CSP: aucune source http(s) autorisee", !/https?:/.test(csp));

/* --- 4. Le document ne reference aucune ressource externe ---------------- */

// Une seule URL absolue oubliee (police, CDN, favicon) suffirait a signaler au
// reseau qu'un document est ouvert. La CSP la bloquerait, mais autant qu'elle
// n'existe pas.
const externals = [...html.matchAll(/\b(?:src|href)\s*=\s*"(https?:)?\/\/[^"]*"/gi)].map((m) => m[0]);
check("aucune ressource externe referencee dans le document", externals.length === 0, externals.join(", "));

/* --- 5. Aucune primitive reseau dans le bundle --------------------------- */

// On cible les sites d'appel plutot que les simples mentions : le texte de la
// fenetre « A propos » parle de ces API pour les expliquer, et ne doit pas
// declencher l'alerte. Si l'un de ces motifs apparait un jour, c'est qu'une
// dependance a change de comportement et cela merite une relecture.
const netPatterns = [
  ["fetch()", /\bfetch\s*\(/],
  ["new XMLHttpRequest()", /new\s+XMLHttpRequest|XMLHttpRequest\s*\(/],
  ["new WebSocket()", /new\s+WebSocket\s*\(/],
  ["new EventSource()", /new\s+EventSource\s*\(/],
  ["navigator.sendBeacon()", /sendBeacon\s*\(/],
  ["importScripts()", /importScripts\s*\(/],
  ["navigator.serviceWorker", /serviceWorker\s*\./],
  ["RTCPeerConnection", /new\s+RTC\w*PeerConnection/],
];
for (const [label, re] of netPatterns) {
  check(`le bundle n'appelle pas ${label}`, !re.test(js));
}

/* --- 6. La reconstruction du fichier autonome reste valide --------------- */

// Reproduit ce que fait doDownloadApp() dans le navigateur : si le condensat
// survit a l'aller-retour, le fichier telecharge s'executera bien.
const rebuilt = `<style id="app-css">${css}</style>` + `<script id="app-js">${js}</script>`;
const rebuiltJs = rebuilt.match(/<script id="app-js">([\s\S]*?)<\/script>/)[1];
check("le fichier autonome reconstruit conserve un condensat valide",
  createHash("sha256").update(rebuiltJs, "utf8").digest("base64") === declared);

/* --- 7. Le body livre ne contient aucun contenu ------------------------- */

const body = html.match(/<body>([\s\S]*?)<div id="app">/);
check("le conteneur applicatif est livre vide", Boolean(body) && html.includes('<div id="app"></div>'));

console.log();
if (failures) {
  console.error(`  ${failures} verification(s) en echec\n`);
  process.exit(1);
}
console.log("  toutes les verifications passent\n");
