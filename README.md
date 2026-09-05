# Soldi 💸

[![CI](https://github.com/mydohome/soldi/actions/workflows/ci.yml/badge.svg)](https://github.com/mydohome/soldi/actions/workflows/ci.yml)

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
- [Gestione utenti](#gestione-utenti)
- [Installare come app su iPhone/Android](#installare-come-app-su-iphoneandroid)
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
| 💰 **Movimenti** | Entrate e uscite con importo, data, nota, categoria, **conto** e **ambito** (personale / casa). Modifica ed eliminazione. |
| 🏷️ **Categorie** | Personalizzabili per colore, tipo (spesa/entrata) e **ambito (Personale/Casa)** — separate nella schermata Categorie e nei filtri dei form. 11 categorie predefinite alla registrazione. |
| 🏦 **Conti** | Contanti, conto corrente, carta… da associare ai movimenti come le categorie. 3 conti predefiniti alla registrazione. |
| 🏠 **Personale / Casa** | Ogni movimento ha un ambito; la dashboard mostra Personale, Casa e Totale affiancati, e c'è un filtro dedicato. |
| 🔁 **Spese fisse** | Regole ricorrenti (mutuo, finanziamento, addebiti, stipendio…), **mensili o una volta l'anno**, che generano un movimento vero finché sono attive. Recupero automatico dopo downtime. |
| 🎯 **Previsioni** | Voci di budget mensili/annuali → previsione delle spese dell'anno, proiezione a fine anno, **budget mensile necessario** e **risparmio potenziale**, confronto con lo speso reale per categoria e ambito. Non tocca i grafici della Dashboard. |
| 📱 **Installabile** | PWA: da iPhone/Android *Aggiungi a Home* e si apre a tutto schermo con icona propria. |
| 📊 **Riepiloghi** | Totali entrate / uscite / saldo per **giorno**, **settimana** (lun–dom) e **mese**, con navigazione avanti/indietro. |
| 📈 **Grafici** | Donut per categoria e barre entrate/uscite (SVG originali, nessuna libreria esterna). |
| 🗄️ **Backup** | CSV automatico ogni settimana + backup manuale on‑demand (in **Impostazioni**). |
| ⬆️ **Aggiornamento dall'app** | In **Impostazioni**: controlla e installa l'ultima versione da git (`SELF_UPDATE_ENABLED=true`). |
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

**Aggiornamenti:** uno script fa tutto (backup → aggiorna il codice → rebuild → verifica):

```bash
cd soldi && ./scripts/update.sh
```

Lo script scarica gli aggiornamenti in modo **anonimo** (il repo è pubblico) e sistema da
solo il remote, quindi non serve nessuna credenziale git sul server. Se un `git pull`
manuale ti chiede utente/password (per un clone fatto quando il repo era privato):

```bash
git remote set-url origin https://github.com/mydohome/soldi.git
git config --unset-all credential.helper 2>/dev/null || true
git -c credential.helper= pull --ff-only    # d'ora in poi funziona anche a mano
```

Lo schema del database viene applicato automaticamente a ogni avvio (idempotente).
Non serve `docker compose down -v` (cancellerebbe i dati).

**Aggiornare dall'app:** metti `SELF_UPDATE_ENABLED=true` nel `.env` e riavvia una volta.
Poi da **Impostazioni → Aggiorna** l'app fa `git pull` + riavvio da sola (le modifiche al
`Dockerfile` restano da fare con `./scripts/update.sh`). Il repo sul server dev'essere
di proprietà dell'utente con UID 1000 (di solito il primo utente); altrimenti usa lo script.

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
| `ALLOW_REGISTRATION` | `true` | `false` = niente registrazione di nuovi utenti dalla schermata di login (resta possibile finché non esiste alcun utente, per il primo account). |
| `TZ` | `Europe/Rome` | Fuso orario del container (influenza l'orario del backup). |
| `PGUSER` / `PGPASSWORD` / `PGDATABASE` | `soldi` | Credenziali PostgreSQL. |
| `BACKUP_ENABLED` | `true` | Abilita lo scheduler del backup automatico. |
| `BACKUP_CRON` | `0 3 * * 0` | Quando eseguire il backup (domenica 03:00). |
| `BACKUP_KEEP` | `8` | Quanti backup conservare prima di eliminare i più vecchi. |
| `RECURRING_ENABLED` | `true` | Abilita la generazione automatica delle spese fisse. |
| `RECURRING_CRON` | `5 6 * * *` | Quando controllare le spese fisse dovute (+ sempre all'avvio). |
| `SELF_UPDATE_ENABLED` | `false` | `true` = il pulsante **Aggiorna** in Impostazioni fa `git pull` + riavvio del container (senza rebuild). Le modifiche al `Dockerfile` richiedono comunque `./scripts/update.sh`. |

---

## Uso

- **Dashboard** — scegli il periodo (Giorno / Settimana / Mese) e l'ambito (Tutti / Personale / Casa),
  naviga con le frecce. Vedi entrate, uscite, saldo, ripartizione per categoria e per conto,
  split Personale/Casa e andamento.
- **Movimenti** — elenco completo con filtri per mese, tipo, categoria, conto e ambito;
  pulsante **+** per aggiungere. Ogni movimento ha uno switch **Personale / Casa** e si può
  **creare una categoria al volo** dal form (pulsante `+` accanto al menu Categoria).
- **Previsioni** — voci di budget: importo **mensile** o **una volta l'anno** (con il mese),
  categoria e ambito. La pagina mostra, per l'anno scelto, il **totale previsto**, lo **speso**
  reale, la **proiezione a fine anno** (mesi passati = reale, futuri = previsto), il **budget
  mensile necessario** (spese previste dell'anno spalmate su 12 mesi, comprese quelle annuali)
  e il **risparmio potenziale al mese** (confronto con le entrate reali medie dei mesi già
  trascorsi), oltre al confronto previsto/speso per mese e per categoria. Con un interruttore
  includi anche le **spese fisse** nella previsione. Le voci previste **non creano movimenti e
  non influenzano i grafici della Dashboard**: sono solo un'ipotesi di budget.
- **Spese fisse** — regole ricorrenti (mutuo, rata, abbonamento, stipendio…), **ogni mese oppure
  una volta l'anno** in un mese scelto. A differenza delle voci previste, creano un **movimento
  vero**, il giorno scelto, finché la regola è **attiva**. Lo switch nella lista la disattiva
  senza toccare lo storico; «Esegui adesso» forza il controllo. I movimenti generati hanno il
  badge «fissa» e restano modificabili. All'avvio l'app recupera i mesi/anni arretrati (utile
  dopo un fermo del server); riattivando una regola **non** si recuperano i periodi in cui
  era spenta.
- **Categorie** — crea, rinomina, cambia colore, tipo o **ambito**, oppure elimina. Le categorie
  **Personali** e **Casa** sono separate: nella schermata Categorie appaiono in liste distinte,
  e nei form (Movimento, Spesa fissa, Voce prevista) il menu Categoria mostra solo quelle
  dell'ambito selezionato con lo switch Personale/Casa. Eliminando una categoria i movimenti
  collegati **restano** (diventano «senza categoria»).
- **Conti** — stessa cosa per i conti (contanti, conto corrente, carta…). Eliminando un conto
  i movimenti collegati restano «senza conto».
- **Impostazioni** — versione installata e **aggiornamento dall'app** (controlla / installa
  l'ultima versione da git, se `SELF_UPDATE_ENABLED=true`); **backup** (elenco, «Crea backup
  adesso», istruzioni di ripristino).

---

## Gestione utenti

**Primo utente (installazione nuova):** finché non esiste alcun account la schermata di
login mostra comunque «Crea account», anche con `ALLOW_REGISTRATION=false`. Registra il tuo
account lì.

**Aggiungere altri utenti** (o quando la registrazione è disabilitata) — da terminale sul server:

```bash
docker compose exec web npm run user:create
# oppure senza prompt:
docker compose exec web npm run user:create -- mario@esempio.it 'una-password' 'Mario'
```

Ogni utente ha i propri movimenti, categorie e conti, completamente separati.

Altri comandi:

```bash
docker compose exec web npm run user:list                 # elenco utenti
docker compose exec web npm run user:password             # reimposta una password (prompt)
docker compose exec web npm run user:password -- mario@esempio.it 'nuova-password'
```

> In alternativa puoi riattivare temporaneamente la registrazione: `ALLOW_REGISTRATION=true`
> nel `.env` → `./scripts/update.sh` → registri → rimetti `false` → `./scripts/update.sh`.

---

## Installare come app su iPhone/Android

L'app è una **PWA**: si aggiunge alla schermata Home e si apre a tutto schermo con la sua icona.

- **iPhone/iPad (Safari):** apri l'app → pulsante **Condividi** → **Aggiungi a Home**.
- **Android (Chrome):** menu ⋮ → **Installa app** / **Aggiungi a schermata Home**.

Non serve un app store e non c'è funzionamento offline: i dati restano sul server, quindi
serve la connessione al server per caricare o salvare movimenti.

> Su HTTP puro l'installazione funziona; alcuni browser mostrano il prompt "Installa" solo
> in HTTPS — in quel caso usa comunque *Aggiungi a Home* dal menu Condividi.

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
│   │   ├── schema.sql       # schema idempotente (+ ALTER additivi per DB esistenti)
│   │   └── migrate.js       # applica lo schema all'avvio
│   ├── auth/                # hashing password, token di sessione, middleware
│   ├── routes/              # auth, transactions, categories, accounts, recurring, planned, summary, backups, settings
│   ├── recurring/
│   │   ├── generate.js      # crea i movimenti dovuti dalle regole attive
│   │   └── scheduler.js     # catch-up all'avvio + cron giornaliero
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
| `GET`  | `/api/auth/config` | `{ registrationEnabled }` |
| `POST` | `/api/auth/register` | Crea account (`email`, `password`, `displayName?`) — 403 se disabilitata |
| `POST` | `/api/auth/login` | Login |
| `POST` | `/api/auth/logout` | Logout |
| `GET`  | `/api/auth/me` | Utente corrente |
| `GET`  | `/api/transactions` | Lista (filtri: `from`, `to`, `type`, `categoryId`, `accountId`, `scope`, `limit`, `offset`) |
| `POST` | `/api/transactions` | Crea movimento (`accountId`, `scope` opzionali) |
| `PATCH`| `/api/transactions/:id` | Modifica |
| `DELETE`| `/api/transactions/:id` | Elimina |
| `GET`/`POST`/`PATCH`/`DELETE` | `/api/categories` | Gestione categorie (`kind`, `scope`: personal\|home) |
| `GET`/`POST`/`PATCH`/`DELETE` | `/api/accounts` | Gestione conti |
| `GET`/`POST`/`PATCH`/`DELETE` | `/api/recurring` | Gestione spese fisse (`cadence`: monthly\|yearly + `month`; `DELETE ?keepMovimenti=true` tiene i movimenti già generati) |
| `POST` | `/api/recurring/run` | Genera subito i movimenti fissi dovuti |
| `GET`/`POST`/`PATCH`/`DELETE` | `/api/planned` | Gestione voci di budget (spese previste) |
| `GET`  | `/api/planned/summary?year=YYYY&includeRecurring=true\|false&scope=` | Previsione annuale: totali, proiezione, budget mensile necessario, risparmio potenziale, per mese/categoria/ambito |
| `GET`  | `/api/summary/overview?anchor=YYYY-MM-DD&scope=personal\|home` | Riepiloghi giorno/settimana/mese, split Personale/Casa, ripartizione per conto |
| `GET`  | `/api/summary/range?from&to&group=day\|week\|month&scope=` | Serie temporale aggregata |
| `GET`  | `/api/backups` | Elenco backup |
| `POST` | `/api/backups` | Crea backup adesso |
| `GET`  | `/api/settings/version` | Versione installata (SHA git) |
| `GET`  | `/api/settings/check-update` | Confronta con `origin/main` |
| `POST` | `/api/settings/update` | `git pull` + riavvio (se `SELF_UPDATE_ENABLED=true`) |
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
npm run backup                       # backup CSV immediato
npm run restore -- --latest --yes    # ripristino
npm run user:create                  # crea un utente (prompt)
npm run user:list                    # elenco utenti
npm run user:password -- a@b.it 'x'  # reimposta una password
```

Sul server, davanti a ogni comando: `docker compose exec web …`

---

## Contribuire

Vedi [CONTRIBUTING.md](CONTRIBUTING.md). In breve: `npm test` prima di ogni PR.

## Licenza

MIT — vedi [LICENSE](LICENSE).
