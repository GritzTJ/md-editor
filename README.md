# md-editor

Éditeur et visualiseur Markdown qui s'exécute **entièrement dans le navigateur**.
Le serveur livre un fichier HTML et n'entend plus jamais parler du document :
aucune requête réseau n'est émise après le chargement de la page, et la politique
de sécurité du document demande au navigateur d'en bloquer toute tentative.

L'application tient en un seul fichier de ~600 Ko (~200 Ko compressés), sans
dépendance externe à l'exécution.

---

## Ce que le serveur peut et ne peut pas voir

C'est le cœur du projet, donc autant être précis.

**Ce qui est garanti**, pour la page telle qu'elle a été reçue :

| Directive CSP | Effet |
| --- | --- |
| `default-src 'none'` | rien ne se charge par défaut |
| `connect-src 'none'` | ni `fetch`, ni `XMLHttpRequest`, ni WebSocket, ni `sendBeacon` |
| `img-src data: blob:` | aucune image distante, y compris celles écrites dans votre Markdown |
| `script-src 'sha256-…'` | seul le script livré avec la page peut s'exécuter |
| `form-action 'none'` | aucune soumission de formulaire |
| `base-uri 'none'` | impossible de détourner les URL relatives |
| `frame-ancestors 'none'` | la page ne peut pas être encadrée par un tiers |

Le script est autorisé par son **condensat SHA-256**, calculé à la construction
sur les octets exacts du fichier. Un octet modifié après coup et le navigateur
refuse purement et simplement de l'exécuter.

**La limite, qu'il faut connaître :** un serveur compromis peut servir une
*autre* page, avec une autre CSP. Les garanties ci-dessus portent sur le
document reçu, pas sur le serveur. Tant que vous rechargez la page depuis le
serveur, vous lui faites confiance à chaque visite.

**La parade :** cliquez une fois sur **Télécharger l'app**, puis travaillez
sur le fichier `md-editor.html` obtenu, ouvert en `file://`. Le serveur sort
alors définitivement de la boucle. Le condensat du fichier livré est publié à
chaque construction (`dist/index.html.sha256`, et dans le résumé du workflow),
ce qui permet de vérifier que vous avez bien reçu la version attendue :

```bash
curl -s https://votre-instance/ | sha256sum
curl -s https://votre-instance/index.html.sha256
```

---

## Démarrage

```bash
docker run --rm -p 8080:8080 ghcr.io/OWNER/md-editor:latest
```

Puis <http://localhost:8080>.

Avec Docker Compose — le conteneur tourne en lecture seule, sans privilèges et
sans aucun volume, puisqu'il n'a rien à persister :

```bash
docker compose up -d
```

L'image est publiée pour `linux/amd64` et `linux/arm64`. Elle expose le port
**8080** et tourne en **uid 101**, sans root.

### Vérifier l'origine de l'image

```bash
gh attestation verify oci://ghcr.io/OWNER/md-editor:latest --repo OWNER/md-editor
```

---

## Fonctionnalités

- **Édition** : CodeMirror 6, coloration syntaxique du Markdown, blocs de code
  colorés selon leur langage, prolongement automatique des listes, numéros de
  ligne, annuler/rétablir.
- **Aperçu en direct** : rendu GFM (tableaux, listes de tâches, barré) assaini
  par DOMPurify, défilement synchronisé, séparateur ajustable.
- **Trois modes** : éditeur seul, vue partagée, aperçu seul.
- **Fichiers locaux** : `Ouvrir` / `Enregistrer` écrivent de vrais fichiers `.md`
  via l'API File System Access (Chrome, Edge). Sur Firefox et Safari, repli
  automatique sur import de fichier et téléchargement.
- **Exports** : le rendu en HTML autonome, ou l'application elle-même.
- **Thème clair / sombre**, suivant le réglage système par défaut.

### Raccourcis

| Raccourci | Action |
| --- | --- |
| `Ctrl`+`O` | Ouvrir un fichier |
| `Ctrl`+`S` | Enregistrer |
| `Ctrl`+`Maj`+`S` | Enregistrer sous |
| `Ctrl`+`Z` / `Ctrl`+`Y` | Annuler / rétablir |

---

## Stockage

**Par défaut, rien n'est conservé.** Ni brouillon, ni historique, ni
préférence de contenu — seuls le thème et le mode d'affichage sont mémorisés.

La case **Brouillon local** écrit le document dans le `localStorage` du
navigateur pour qu'il survive à un rechargement. Elle est décochée par défaut,
volontairement : le contenu est alors stocké **en clair sur le poste**. Le
décochage efface immédiatement le brouillon, et un bouton dédié permet de le
supprimer à tout moment.

---

## Limites connues

- **Les images distantes ne s'affichent pas.** `![](https://…)` est bloqué par
  `img-src`. C'est délibéré : autoriser les images distantes rouvrirait un canal
  de sortie vers un tiers. Les images en `data:` fonctionnent.
- **`Ctrl`+`S` n'écrase le fichier d'origine que sur Chrome et Edge**, seuls à
  implémenter l'API File System Access. Ailleurs, l'enregistrement produit un
  téléchargement.
- **Pas de mode hors ligne automatique** (pas de service worker). Le fichier
  autonome téléchargeable joue ce rôle, de façon plus vérifiable.

---

## Développement

```bash
npm install
npm run build     # produit dist/index.html
npm run dev       # construit puis sert sur :8080 avec les en-têtes de production
node verify.mjs   # vérifie le fichier construit
```

`verify.mjs` contrôle le fichier réellement produit, pas les sources : validité
du script une fois extrait du HTML, correspondance du condensat CSP, absence de
ressource externe et absence de primitive réseau dans le bundle. Il est rejoué
pendant la construction de l'image, de sorte qu'aucune image ne peut être
produite si l'un de ces points casse.

### Tests navigateur

```bash
npm run dev &
npm install --no-save puppeteer
node test/browser.mjs
```

47 tests dans un vrai Chrome, contre l'application servie. Ils vérifient
notamment que le navigateur bloque effectivement `fetch`, WebSocket,
`sendBeacon`, les images distantes et les imports dynamiques ; que l'aperçu
neutralise scripts, `onerror`, `javascript:`, iframes et formulaires ; et que le
fichier autonome démarre en `file://` sans emporter le document en cours.

`puppeteer` n'est pas une dépendance du projet — il téléchargerait un Chrome
complet à chaque `npm install`. Pour tester l'image plutôt que le build local :

```bash
docker run -d -p 8080:8080 ghcr.io/OWNER/md-editor:latest
TARGET=http://localhost:8080/ node test/browser.mjs
```

### Organisation

```
src/app.js          application (interface, rendu, E/S fichier)
src/styles.css      thème clair/sombre, styles de l'aperçu
build.mjs           bundle esbuild -> fichier HTML unique + CSP + condensats
verify.mjs          contrôles sur le fichier produit
nginx/default.conf  en-têtes de sécurité, méthodes GET/HEAD uniquement
Dockerfile          construction multi-étapes -> nginx non privilégié
```

Le `<body>` livré ne contient qu'un conteneur vide : toute l'interface est
construite en JavaScript. C'est ce qui permet au bouton « Télécharger l'app » de
reconstituer fidèlement le fichier d'origine depuis le DOM, sans risquer d'y
embarquer le document en cours d'édition.

---

## Licence

MIT.
