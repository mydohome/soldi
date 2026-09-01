# syntax=docker/dockerfile:1
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# git: usato per l'aggiornamento in-app (Impostazioni → Aggiorna) quando il repo
# è montato su /repo. Innocuo quando non usato.
RUN apk add --no-cache git

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
