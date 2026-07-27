# -----------------------------------------------------------------------------
# md-editor -- image de distribution.
#
# L'image ne contient qu'un fichier HTML et un nginx pour le servir. Elle n'a
# ni base de donnees, ni etat, ni ecriture disque : le contenu edite ne quitte
# jamais le navigateur, il n'y a donc rien a persister cote serveur.
# -----------------------------------------------------------------------------

# --- etape 1 : construction ---------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /src

# Les manifestes d'abord : cette couche est mise en cache tant que les
# dependances ne bougent pas.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY build.mjs verify.mjs ./
COPY src ./src

# La verification fait partie du build : une image ne peut pas etre produite
# avec un condensat CSP desynchronise ou un appel reseau introduit par une
# dependance.
RUN npm run build && node verify.mjs

# --- etape 2 : execution ------------------------------------------------------
# Image non privilegiee : nginx tourne en uid 101, ecoute sur 8080, et n'a
# besoin d'aucune capacite particuliere.
FROM nginxinc/nginx-unprivileged:1.29-alpine

LABEL org.opencontainers.image.title="md-editor" \
      org.opencontainers.image.description="Editeur Markdown fonctionnant entierement dans le navigateur : le serveur ne voit jamais le contenu." \
      org.opencontainers.image.licenses="MIT"

COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist/csp.conf /etc/nginx/csp.conf
COPY --from=build /src/dist/index.html /src/dist/index.html.sha256 /usr/share/nginx/html/

USER 101

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=3s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
