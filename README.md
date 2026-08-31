# Soldi 💸

Web app per tenere traccia delle **spese** e delle **entrate** personali: categorie,
riepiloghi **giornalieri, settimanali e mensili**, grafici, account con password e
**backup automatico settimanale in CSV** con ripristino.

Funziona da smartphone e da desktop (interfaccia responsive), gira interamente con
**Docker Compose**. Backend in **Node.js** (Express), database **PostgreSQL**.

---

## Indice

- [Caratteristiche](#caratteristiche)
- [Avvio rapido](#avvio-rapido)
- [Deploy su un server (Debian)](#deploy-su-un-server-debian)
- [Configurazione (.env)](#configurazione-env)
- [Uso](#uso)
- [Backup automatico](#backup-automatico)
- [Ripristino di emergenza](#ripristino-di-emergenza-disaster-recovery)
- [Architettura](#architettura)
- [API](#api)
- [Sviluppo locale](#sviluppo-locale)

---

## Caratteristiche

| | |
|---|---|
| 👤 **Account** | Registrazione con email + password (hash `bcrypt`), sessione via cookie firmato `httpOnly`. Rate limiting sui tentativi di login. |
| 💰 **Movimenti** | Entrate e uscite con importo, data, nota e categoria. Modifica ed eliminazione. |
| 🏷️ **Categorie** | Personalizzabili per colore e tipo (spesa/entrata). 11 categorie predefinite alla registrazione. |
| 📊 **Riepiloghi** | Totali entrate / uscite / saldo per **giorno**, **settimana** (lun–dom) e **mese**, con navigazione avanti/indietro. |
| 📈 **Grafici** | Donut per categoria e barre entrate/uscite (SVG originali, nessuna libreria esterna). |
| 🗄️ **Backup** | CSV automatico ogni settimana + backup manuale on‑demand dall'interfaccia. |
| ♻️ **Ripristino** | Comando singolo che ricarica i dati da un backup CSV. |
| 🎨 **UI** | Design moderno, tema chiaro/scuro automatico, elementi grafici originali. |

---

## Avvio rapido

Prerequisito: **Docker Desktop** (o Docker Engine + plugin Compose).
Su macOS: `brew install --cask docker`, poi avvia Docker Desktop.

```bash
# 1. clona il repository
git clone https://github.com/mydohome/soldi.git
cd soldi

# 2. crea il file di configurazione
cp .env.example .env

# 3. genera un segreto per i cookie e mettilo nel .env
#    (macOS/Linux)
sed -i '' "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" .env   # macOS
# sed -i    "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" .env  # Linux

# 4. avvia
docker compose up -d --build
```

Apri **http://localhost:3000**, crea un account e inizia.

Per fermare: `docker compose down` (i dati restano nel volume `db-data`).

---

## Deploy su un server (Debian)

Su un server Debian con Docker già installato, per pubblicare sulla **porta 3010**:

```bash
# 1. codice
git clone https://github.com/mydohome/soldi.git
cd soldi

# 2. configurazione
cp .env.example .env
sed -i "s/^HOST_PORT=.*/HOST_PORT=3010/" .env
sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" .env
sed -i "s/^PGPASSWORD=.*/PGPASSWORD=$(openssl rand -hex 16)/" .env   # password DB robusta

# 3. avvio
docker compose up -d --build

# 4. verifica
curl -s http://localhost:3010/api/health      # {"status":"ok"}
docker compose ps
```

L'app risponde su `http://IP_DEL_SERVER:3010`. Apri la porta nel firewall se necessario
(`ufw allow 3010/tcp`).

**Aggiornamenti:**

```bash
cd soldi && git pull && docker compose up -d --build
```

Lo schema del database viene applicato automaticamente a ogni avvio (idempotente).

**HTTP diretto** (`http://IP_SERVER:3010`): lascia `HTTPS_ENABLED=false` (default).

**HTTPS / dominio:** metti l'app dietro un reverse proxy (nginx, Caddy, Traefik) che
gestisce il certificato e inoltra a `127.0.0.1:3010`. In quel caso, nel `.env`:

```
HTTPS_ENABLED=true
```

**Backup fuori dal server:** la cartella `./backups` contiene i CSV settimanali.
Sincronizzala altrove, es. con cron:

```bash
0 4 * * 0  rsync -a /percorso/soldi/backups/ utente@altro-host:/backup/soldi/
```

**Avvio automatico al boot:** i servizi hanno `restart: unless-stopped`, quindi
Docker li riavvia da solo se il server si riavvia (basta che il servizio `docker` sia abilitato:
`systemctl enable docker`).

---

## Configurazione (.env)

| Variabile | Default | Descrizione |
|---|---|---|
| `HOST_PORT` | `3000` | Porta pubblicata sull'host (es. `3010` su un server). L'app nel container resta sempre sulla 3000. |
| `JWT_SECRET` | — (**obbligatorio**) | Segreto per firmare i cookie di sessione. Usa `openssl rand -hex 32`. |
| `HTTPS_ENABLED` | `false` | `true` **solo** se l'app è raggiunta via HTTPS. Attiva HSTS, `upgrade-insecure-requests` e cookie `Secure`. In HTTP puro lascialo `false`, altrimenti la pagina resta bloccata su «Carico Soldi…». |
| `TZ` | `Europe/Rome` | Fuso orario del container (influenza l'orario del backup). |
| `PGUSER` / `PGPASSWORD` / `PGDATABASE` | `soldi` | Credenziali PostgreSQL. |
| `BACKUP_ENABLED` | `true` | Abilita lo scheduler del backup automatico. |
| `BACKUP_CRON` | `0 3 * * 0` | Quando eseguire il backup (domenica 03:00). |
| `BACKUP_KEEP` | `8` | Quanti backup conservare prima di eliminare i più vecchi. |

---

## Uso

- **Dashboard** — scegli il periodo (Giorno / Settimana / Mese) e naviga con le frecce.
  Vedi entrate, uscite, saldo, ripartizione per categoria e andamento.
- **Movimenti** — elenco completo con filtri per mese, tipo e categoria; pulsante **+** per aggiungere.
- **Categorie** — crea, rinomina, cambia colore o elimina. Eliminando una categoria i movimenti
  collegati **restano** (diventano «senza categoria»).
- **Backup** — elenco dei backup disponibili e pulsante **Crea backup adesso**.

---

## Backup automatico

Ogni settimana (default: **domenica alle 03:00**, fuso `TZ`) l'app scrive un backup in:

```
/app/backups/soldi-backup-<AAAA-MM-GG_hh-mm-ss>/
├── users.csv
├── categories.csv
├── transactions.csv
└── manifest.json
```

Questa cartella è montata sul tuo computer in **`./backups`** (vedi `docker-compose.yml`),
quindi i file CSV sono subito accessibili e copiabili altrove (disco esterno, cloud…).

Vengono conservati gli ultimi `BACKUP_KEEP` backup; i più vecchi sono eliminati automaticamente.

**Backup manuale** da terminale:

```bash
docker compose exec web npm run backup
```

o dal pulsante **Crea backup adesso** nella sezione *Backup* dell'app.

> Consiglio: copia periodicamente l'intera cartella `./backups` fuori dalla macchina.
> Il backup CSV è indipendente dal volume del database: se perdi il volume, i CSV bastano
> a ricostruire tutto.

---

## Ripristino di emergenza (disaster recovery)

> ⚠️ Il ripristino **cancella e sostituisce** tutti i dati presenti nel database con
> quelli del backup scelto. Fai prima un backup dello stato attuale se ha senso.

### Scenario A — l'app non parte più / dati corrotti, ma il volume del DB esiste

```bash
# ripristina il backup più recente presente in ./backups
docker compose run --rm web npm run restore -- --latest --yes
```

### Scenario B — hai perso tutto (volume incluso), hai solo la cartella ./backups

```bash
# 1. parti da zero: rimuovi anche i volumi
docker compose down -v

# 2. assicurati che ./backups contenga le cartelle soldi-backup-*
ls backups/

# 3. avvia solo il database e attendi che sia pronto
docker compose up -d db

# 4. crea lo schema e ripristina un backup specifico
docker compose run --rm web npm run migrate
docker compose run --rm web npm run restore -- /app/backups/soldi-backup-2026-01-05_03-00-00 --yes

# 5. avvia l'app
docker compose up -d web
```

### Scenario C — ripristino su un'altra macchina

1. Installa Docker, clona il repo, crea `.env` (riusa lo **stesso** `JWT_SECRET` se vuoi
   che le sessioni esistenti restino valide; altrimenti basta rifare il login).
2. Copia le cartelle `soldi-backup-*` dentro `./backups`.
3. Esegui i passi 3–5 dello **Scenario B**.

### Verifica dopo il ripristino

```bash
docker compose exec db psql -U soldi -d soldi -c \
  "SELECT (SELECT count(*) FROM users) AS utenti,
          (SELECT count(*) FROM categories) AS categorie,
          (SELECT count(*) FROM transactions) AS movimenti;"
```

I numeri devono coincidere con quelli nel `manifest.json` del backup.

### Note

- Il ripristino è **idempotente**: puoi rieseguirlo, riparte sempre da `TRUNCATE`.
- Le sequenze degli ID vengono riallineate automaticamente dopo l'import.
- Senza `--yes` il comando chiede conferma interattiva (digita `yes`).
- Il formato è CSV standard: in caso estremo puoi importare i file a mano con `psql \copy`.

---

## Architettura

```
soldi/
├── docker-compose.yml      # web (Node) + db (PostgreSQL) + volume backup
├── Dockerfile
├── src/
│   ├── server.js           # Express, sicurezza (helmet), rotte, SPA fallback
│   ├── db/
│   │   ├── pool.js          # pool pg condiviso + helper transazioni
│   │   ├── schema.sql       # schema idempotente
│   │   └── migrate.js       # applica lo schema all'avvio
│   ├── auth/                # hashing password, token di sessione, middleware
│   ├── routes/              # auth, transactions, categories, summary, backups
│   └── backup/
│       ├── backup-core.js   # scrittura CSV + pruning
│       ├── scheduler.js     # cron settimanale
│       └── restore.js       # ripristino da CSV
└── public/                  # SPA vanilla JS (nessun build step)
    ├── index.html
    ├── css/styles.css
    └── js/{app,api,charts,icons}.js
```

**Perché PostgreSQL:** relazionale, veloce sotto carico, indici su `(user_id, occurred_on)`
per i riepiloghi, e scala verticalmente/orizzontalmente (replica, connection pooling) senza
cambiare codice — la connessione arriva da `DATABASE_URL` o dalle variabili `PG*`.

**Sicurezza:** password con `bcrypt` (cost 12), cookie `httpOnly` + `SameSite=Lax`,
header di sicurezza con `helmet` (CSP restrittiva), rate limiting globale e sulle rotte di auth,
validazione input con `zod`, query sempre parametrizzate.

---

## API

Tutte sotto `/api`, JSON, autenticazione via cookie di sessione.

| Metodo | Endpoint | Descrizione |
|---|---|---|
| `POST` | `/api/auth/register` | Crea account (`email`, `password`, `displayName?`) |
| `POST` | `/api/auth/login` | Login |
| `POST` | `/api/auth/logout` | Logout |
| `GET`  | `/api/auth/me` | Utente corrente |
| `GET`  | `/api/transactions` | Lista (filtri: `from`, `to`, `type`, `categoryId`, `limit`, `offset`) |
| `POST` | `/api/transactions` | Crea movimento |
| `PATCH`| `/api/transactions/:id` | Modifica |
| `DELETE`| `/api/transactions/:id` | Elimina |
| `GET`/`POST`/`PATCH`/`DELETE` | `/api/categories` | Gestione categorie |
| `GET`  | `/api/summary/overview?anchor=YYYY-MM-DD` | Riepiloghi giorno/settimana/mese + grafici |
| `GET`  | `/api/summary/range?from&to&group=day\|week\|month` | Serie temporale aggregata |
| `GET`  | `/api/backups` | Elenco backup |
| `POST` | `/api/backups` | Crea backup adesso |
| `GET`  | `/api/health` | Stato servizio |

---

## Sviluppo locale

Serve Node.js 20+ e un PostgreSQL in ascolto.

```bash
npm install
cp .env.example .env      # imposta PGHOST=localhost e JWT_SECRET
npm run migrate
npm run dev                # http://localhost:3000, riavvio automatico
```

Comandi utili:

```bash
npm run backup             # backup CSV immediato
npm run restore -- --latest --yes
```

---

## Licenza

MIT — vedi [LICENSE](LICENSE).
