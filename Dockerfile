# syntax=docker/dockerfile:1
FROM node:26-alpine

ENV NODE_ENV=production
WORKDIR /app

# Sicurezza dell'immagine base (la scansione Trivy segnalava vulnerabilità HIGH/CRITICAL):
#  - Node 24 (LTS): Node 20 è a fine vita dalla primavera 2026 e non riceve più patch di sicurezza;
#  - apk upgrade: porta i pacchetti di Alpine alle versioni corrette già pubblicate;
#  - npm 12 al posto di quello incluso nella base, che porta con sé dipendenze (tar, brace-expansion…)
#    con vulnerabilità note. npm 12 richiede Node ≥ 22, quindi non era possibile su Node 20;
#  - npm 12 incorpora ancora undici 6.29.0 (HIGH): si sostituisce con la patch già pubblicata della
#    stessa serie e la build fallisce se la sostituzione non è riuscita. Da togliere quando una
#    versione di npm incorpora undici >= 6.29.1.
#    L'app non usa queste librerie a runtime; i comandi di gestione (`npm run backup`,
#    `npm run diag`…) e l'aggiornamento in-app (`npm ci`) richiedono però npm.
# git: usato per l'aggiornamento in-app (Impostazioni → Aggiorna) quando il repo
# è montato su /repo. Innocuo quando non usato.
RUN apk upgrade --no-cache \
 && apk add --no-cache git \
 && npm install -g npm@12 \
 && cd /usr/local/lib/node_modules/npm/node_modules \
 && for spec in undici@6.29.1; do \
      name="${spec%@*}"; want="${spec#*@}"; tmp="$(mktemp -d)"; \
      (cd "$tmp" && npm pack "$spec" --silent >/dev/null) || exit 1; \
      rm -rf "$name"; mkdir "$name"; \
      tar -xzf "$tmp"/*.tgz -C "$name" --strip-components=1 || exit 1; \
      rm -rf "$tmp"; \
      [ "$(node -p "require('./$name/package.json').version")" = "$want" ] || exit 1; \
    done \
 && cd / && npm --version \
 && npm cache clean --force

# Install production dependencies first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Versione corrente mostrata in Impostazioni (fallback quando /repo non è montato).
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA

# Backups are written here; the directory is a mount point in compose.
RUN mkdir -p /app/backups && chown -R node:node /app && chmod -R u+rwX,go+rX /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
