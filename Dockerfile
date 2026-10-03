# syntax=docker/dockerfile:1
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Sicurezza dell'immagine base (la scansione Trivy segnalava vulnerabilità HIGH/CRITICAL):
#  - apk upgrade: porta i pacchetti di Alpine alle versioni corrette già pubblicate;
#  - npm: quello incluso in node:20-alpine porta con sé un `tar` vulnerabile; si usa npm 11
#    (supporta Node 20) e si pulisce la cache. L'app non usa npm a runtime per scaricare
#    nulla, ma i comandi di gestione (`npm run backup`, `npm run diag`…) lo richiedono.
# git: usato per l'aggiornamento in-app (Impostazioni → Aggiorna) quando il repo
# è montato su /repo. Innocuo quando non usato.
RUN apk upgrade --no-cache \
 && apk add --no-cache git \
 && npm install -g npm@11 \
 && npm cache clean --force

# Install production dependencies first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Versione corrente mostrata in Impostazioni (fallback quando /repo non è montato).
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA

# Backups are written here; the directory is a mount point in compose.
RUN mkdir -p /app/backups && chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
