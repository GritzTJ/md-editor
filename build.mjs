/* ---------------------------------------------------------------------------
 * Construction de md-editor.
 *
 * La sortie est un fichier unique, `dist/index.html`, qui contient tout : CSS,
 * JavaScript, dependances. Aucune ressource externe n'est referencee, donc la
 * page fonctionne a l'identique servie en HTTP ou ouverte en `file://` apres
 * simple copie -- c'est ce qui permet a l'utilisateur de se passer du serveur.
 *
 * Le script inline est autorise par la CSP via son condensat SHA-256, calcule
 * ici sur les octets exacts qui seront ecrits dans la page. Un seul octet
 * modifie apres coup et le navigateur refuse d'executer le script.
 *
 *   node build.mjs           construit dist/
 *   node build.mjs --serve   construit puis sert dist/ sur :8080 avec les
 *                            memes en-tetes que le conteneur de production
 * ------------------------------------------------------------------------- */

import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, "dist");
const serve = process.argv.includes("--serve");

/* --- 1. Bundle JavaScript ------------------------------------------------ */

const bundle = await esbuild.build({
  entryPoints: [resolve(root, "src/app.js")],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2021"],
  charset: "utf8",
  legalComments: "eof", // les licences MIT des dependances restent dans le fichier
  write: false,
  logLevel: "info",
});

// `</script` ne peut apparaitre dans du JavaScript valide qu'a l'interieur
// d'une chaine, d'une expression reguliere ou d'un commentaire : l'echapper
// est donc toujours sans effet sur la semantique, et evite que le parseur HTML
// referme la balise au milieu du bundle.
const js = bundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const css = await readFile(resolve(root, "src/styles.css"), "utf8");

/* --- 2. Politique de securite ------------------------------------------- */

const scriptHash = createHash("sha256").update(js, "utf8").digest("base64");

// `frame-ancestors` est ignore dans une balise <meta> : la directive n'a d'effet
// que via l'en-tete HTTP, d'ou la generation de csp.conf pour nginx. Le reste
// est duplique dans le document pour que la protection voyage avec le fichier
// telecharge.
const CSP_DIRECTIVES = [
  "default-src 'none'",
  `script-src 'sha256-${scriptHash}'`,
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
];

const cspMeta = CSP_DIRECTIVES.join("; ");

// Pas de directive `sandbox` ici : elle n'apporterait presque rien face a
// `default-src 'none'` et casserait l'API File System Access, sur laquelle
// repose l'enregistrement direct des fichiers.
const cspHeader = [...CSP_DIRECTIVES, "frame-ancestors 'none'"].join("; ");

/* --- 3. Document final --------------------------------------------------- */

// Le <body> ne contient qu'un conteneur vide : toute l'interface est batie par
// le script. C'est ce qui rend la reconstitution du fichier autonome depuis le
// DOM fidele a l'original, sans risque d'y embarquer le document de l'utilisateur.
// `data-theme` est volontairement absent : la feuille de style choisit alors
// selon `prefers-color-scheme`, et le script pose l'attribut des son execution.
const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${cspMeta}">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<meta name="description" content="Editeur Markdown fonctionnant entierement dans le navigateur.">
<title>Editeur Markdown</title>
<style id="app-css">${css}</style>
</head>
<body>
<div id="app"></div>
<script id="app-js">${js}</script>
</body>
</html>
`;

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await writeFile(resolve(dist, "index.html"), html, "utf8");

// Fragment inclus par nginx : garde l'en-tete et le document parfaitement
// synchronises, y compris le condensat du script.
await writeFile(
  resolve(dist, "csp.conf"),
  `# Genere par build.mjs -- ne pas editer a la main.\n` +
  `add_header Content-Security-Policy "${cspHeader}" always;\n`,
  "utf8",
);

// Condensat du fichier livre : c'est la valeur a publier avec chaque release
// pour qu'un utilisateur puisse verifier la page qu'on lui a servie.
const fileHash = createHash("sha256").update(html, "utf8").digest("hex");
await writeFile(resolve(dist, "index.html.sha256"), `${fileHash}  index.html\n`, "utf8");

const kb = (n) => (n / 1024).toFixed(1) + " Ko";
console.log(`\n  dist/index.html   ${kb(Buffer.byteLength(html))}  (js ${kb(Buffer.byteLength(js))}, css ${kb(Buffer.byteLength(css))})`);
console.log(`  sha256            ${fileHash}`);
console.log(`  script-src        'sha256-${scriptHash}'\n`);

/* --- 4. Serveur de developpement ---------------------------------------- */

if (serve) {
  const port = Number(process.env.PORT || 8080);
  const body = Buffer.from(html, "utf8");

  createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": body.length,
      "Content-Security-Policy": cspHeader,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "geolocation=(), microphone=(), camera=(), interest-cohort=()",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  }).listen(port, () => {
    console.log(`  Serveur de developpement : http://localhost:${port}\n`);
  });
}
