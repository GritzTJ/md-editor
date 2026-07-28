# -----------------------------------------------------------------------------
# md-editor -- distribution image.
#
# The image holds one HTML file and an nginx to serve it. No database, no state,
# no disk writes: the edited content never leaves the browser, so there is
# nothing to persist server-side.
# -----------------------------------------------------------------------------

# --- stage 1: build -----------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /src

# Manifests first: this layer stays cached as long as dependencies do not move.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY build.mjs verify.mjs ./
COPY src ./src

# `.git` is not in the build context, so the commit is passed in rather than
# read. Declared here, after `npm ci`, so a new commit does not invalidate the
# dependency layer.
ARG COMMIT=unknown
ENV MD_EDITOR_COMMIT=$COMMIT

# Verification is part of the build: no image can be produced with a CSP digest
# out of step, or with a network call introduced by a dependency.
RUN npm run build && node verify.mjs

# --- stage 2: runtime ---------------------------------------------------------
# Unprivileged image: nginx runs as uid 101, listens on 8080, and needs no
# special capability.
FROM nginxinc/nginx-unprivileged:1.29-alpine

LABEL org.opencontainers.image.title="md-editor" \
      org.opencontainers.image.description="A Markdown editor that runs entirely in the browser: the server never sees the content." \
      org.opencontainers.image.licenses="MIT"

COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist/csp.conf /etc/nginx/csp.conf
COPY --from=build /src/dist/index.html /src/dist/index.html.sha256 /usr/share/nginx/html/

USER 101

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=3s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
