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
- [Dietro un reverse proxy (Nginx Proxy Manager)](#dietro-un-reverse-proxy-nginx-proxy-manager)
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
| 💰 **Movimenti** | Entrate e uscite con importo, data, descrizione, categoria, **conto** e **ambito** (personale / casa). Ricerca testo, filtri, **annulla** dopo l'eliminazione. |
| ✨ **Suggerimenti** | Inserendo un movimento l'app propone descrizione, categoria e conto in base allo storico (nessun servizio esterno). |
| 🏷️ **Categorie** | Personalizzabili per colore, tipo (spesa/entrata) e **ambito (Personale/Casa)** — separate nella schermata Categorie e nei filtri dei form. 11 categorie predefinite alla registrazione. |
| 🏦 **Conti** | Contanti, conto corrente, carta… da associare ai movimenti come le categorie. 3 conti predefiniti alla registrazione. |
| 🏠 **Personale / Casa** | Ogni movimento ha un ambito; la dashboard mostra Personale, Casa e Totale affiancati, e c'è un filtro dedicato. |
| 🔁 **Spese fisse** | Regole ricorrenti (mutuo, finanziamento, addebiti, stipendio…), **mensili o una volta l'anno**, con **durata opzionale** (es. finanziamento a 12 rate → poi si disattiva). Generano un movimento vero finché sono attive. Recupero automatico dopo downtime. |
| 🎯 **Previsioni** | Voci di budget mensili/annuali → previsione delle spese dell'anno, proiezione a fine anno, **budget mensile necessario** e **risparmio potenziale**. Non tocca i grafici della Dashboard. |
| 🐖 **Risparmio** | In base ai mesi passati stima quanto puoi destinare, in percentuale sulle entrate, a un **fondo sicurezza** e a un **fondo risparmio**. |
| 📱 **Installabile** | PWA: da iPhone/Android *Aggiungi a Home* e si apre a tutto schermo con icona propria. |
| 📊 **Riepiloghi** | Totali entrate / uscite / saldo per **giorno**, **settimana** (lun–dom) e **mese**, con navigazione avanti/indietro. Tocca un box per l'elenco dei movimenti di quel periodo. |
| 📈 **Grafici** | Donut per categoria (con confronto ▲▼ rispetto alla media di 3 mesi) e barre entrate/uscite. SVG originali, nessuna libreria esterna. |
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
solo il remote, quindi non serve nessuna credenziale git sul server.

Se hai installato scaricando lo **ZIP** invece di `git clone`, la cartella non è un
repository git: al primo avvio `./scripts/update.sh` la aggancia da solo a GitHub
(`.env`, `backups/` e i dati del database non vengono toccati). Da lì in poi gli
aggiornamenti — anche quelli da **Impostazioni → Aggiorna** — funzionano normalmente.

Se un `git pull` manuale ti chiede utente/password (per un clone fatto quando il repo era privato):

```bash
git remote set-url origin https://github.com/mydohome/soldi.git
git config --unset-all credential.helper 2>/dev/null || true
git -c credential.helper= pull --ff-only    # d'ora in poi funziona anche a mano
```

Lo schema del database viene applicato automaticamente a ogni avvio (idempotente).
Non serve `docker compose down -v` (cancellerebbe i dati).

**Aggiornare dall'app:** metti `SELF_UPDATE_ENABLED=true` nel `.env` e riavvia una volta.
Poi da **Impostazioni → Aggiorna** l'app fa `git pull` + riavvio da sola. Vanno bene le
modifiche a codice e schema DB; le modifiche a `Dockerfile`, dipendenze o
`docker-compose.yml` richiedono comunque `./scripts/update.sh`. Il processo nel container
deve poter scrivere nel checkout git montato in `/repo` (vedi lo scenario B della sezione
reverse proxy per `PUID`/`PGID`).

**HTTP diretto** (`http://IP_SERVER:3010`): lascia `HTTPS_ENABLED=false` (default).

**HTTPS / dominio:** vedi la sezione [Dietro un reverse proxy](#dietro-un-reverse-proxy-nginx-proxy-manager) qui sotto.

**Backup fuori dal server:** la cartella `./backups` contiene i CSV settimanali.
Sincronizzala altrove, es. con cron:

```bash
0 4 * * 0  rsync -a /percorso/soldi/backups/ utente@altro-host:/backup/soldi/
```

**Avvio automatico al boot:** i servizi hanno `restart: unless-stopped`, quindi
Docker li riavvia da solo se il server si riavvia (basta che il servizio `docker` sia abilitato:
`systemctl enable docker`).

---

## Dietro un reverse proxy (Nginx Proxy Manager)

Il proxy termina il TLS e inoltra ad app in HTTP. In tutti e tre i casi, nel `.env`:

```
HTTPS_ENABLED=true     # il proxy serve l'app in HTTPS → HSTS + cookie Secure
COOKIE_SECURE=true
TRUST_PROXY=1          # 1 = un solo proxy davanti (client IP e cookie Secure corretti)
```

In NPM (*Proxy Hosts → Add*): *Websockets Support* ON, *Block Common Exploits* ON,
scheda **SSL** con certificato + *Force SSL* + *HTTP/2*. Cambia solo **Forward
Hostname/Port** a seconda dello scenario.

### A. Proxy sullo stesso host di Soldi

Usa `docker-compose.yml`. Pubblica la porta **solo in locale** così l'app è
raggiungibile unicamente dal proxy. Nel `.env`:

```
BIND_ADDR=127.0.0.1
HOST_PORT=3010
```

In NPM: **Forward Hostname** `127.0.0.1`, **Forward Port** `3010`.

### B. Proxy sullo stesso host, su rete Docker, nessuna porta pubblicata *(più isolato)*

Usa `docker-compose.npm.yml`: `soldi-web` sta sulla rete del proxy, **non pubblica
alcuna porta**, e il database resta su una rete `internal` irraggiungibile da
proxy e Internet.

```bash
# la rete del proxy dev'essere già esistente ed "external"
docker network ls | grep -i npm            # es. "npm_default"
# se il nome è diverso da "proxy-net", scommenta e adegua "name:" in
# docker-compose.npm.yml (networks → proxy-net), oppure crea la rete:
#   docker network create proxy-net

cp .env.example .env
sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" .env
sed -i "s/^PGPASSWORD=.*/PGPASSWORD=$(openssl rand -hex 16)/" .env
sed -i "s/^HTTPS_ENABLED=.*/HTTPS_ENABLED=true/" .env
sed -i "s/^COOKIE_SECURE=.*/COOKIE_SECURE=true/" .env

docker compose -f docker-compose.npm.yml up -d --build
```

In NPM: **Forward Hostname** `soldi-web`, **Forward Port** `3000`.

Per gli aggiornamenti da riga di comando indica il file compose:

```bash
COMPOSE_FILE=docker-compose.npm.yml ./scripts/update.sh
```

L'**aggiornamento dall'app** richiede che il processo possa scrivere in `/repo`:
in `docker-compose.npm.yml` il container gira come `${PUID}:${PGID}`. Ricava gli
id sull'host e mettili nel `.env`:

```bash
echo "PUID=$(id -u)"                              >> .env
echo "PGID=$(getent group docker | cut -d: -f3)"  >> .env
```

### C. Proxy su un altro host della rete (es. NPM su una macchina dedicata)

NPM su un'altra macchina **non** può raggiungere la rete Docker di Soldi: l'app
deve pubblicare la porta sulla LAN e NPM la inoltra all'IP del server.

Usa `docker-compose.yml`. Nel `.env` del server Soldi:

```
BIND_ADDR=0.0.0.0        # raggiungibile dalla LAN (non 127.0.0.1)
HOST_PORT=3010
```

Chiudi la porta a tutti tranne l'host di NPM:

```bash
sudo ufw allow from <IP_HOST_NPM> to any port 3010 proto tcp
sudo ufw deny 3010/tcp
```

In NPM: **Forward Hostname** `<IP_DEL_SERVER_SOLDI>`, **Forward Port** `3010`,
*Scheme* `http`. Il TLS (Let's Encrypt) lo gestisce NPM sul suo host.

> In tutti i casi l'app resta **HTTP tra proxy e Soldi**: è il proxy a parlare
> HTTPS col browser. `HTTPS_ENABLED=true` serve solo a dire all'app che il client
> è su HTTPS (per HSTS e cookie `Secure`) — non fa ascoltare l'app in TLS.

---

## Configurazione (.env)

| Variabile | Default | Descrizione |
|---|---|---|
| `HOST_PORT` | `3000` | Porta pubblicata sull'host (es. `3010` su un server). L'app nel container resta sempre sulla 3000. Ignorata con `docker-compose.npm.yml`. |
| `BIND_ADDR` | `0.0.0.0` | Indirizzo host a cui è legata la porta. `127.0.0.1` se un reverse proxy gira sullo stesso host (l'app diventa raggiungibile solo tramite il proxy). |
| `JWT_SECRET` | — (**obbligatorio**) | Segreto per firmare i cookie di sessione. Usa `openssl rand -hex 32`. |
| `HTTPS_ENABLED` | `false` | `true` **solo** se l'app è raggiunta via HTTPS. Attiva HSTS, `upgrade-insecure-requests` e cookie `Secure`. In HTTP puro lascialo `false`, altrimenti la pagina resta bloccata su «Carico Soldi…». |
| `COOKIE_SECURE` | `false` | Forza il flag `Secure` sul cookie di sessione a prescindere da `HTTPS_ENABLED`. Di norma tienilo uguale a `HTTPS_ENABLED`. |
| `TRUST_PROXY` | `1` | Numero di reverse proxy davanti all'app (Express *trust proxy*). `1` = un proxy (NPM, nginx…). `0` se l'app è esposta direttamente. |
| `ALLOW_REGISTRATION` | `true` | `false` = niente registrazione di nuovi utenti dalla schermata di login (resta possibile finché non esiste alcun utente, per il primo account). |
| `TZ` | `Europe/Rome` | Fuso orario del container (influenza l'orario del backup). |
| `PGUSER` / `PGPASSWORD` / `PGDATABASE` | `soldi` | Credenziali PostgreSQL. |
| `BACKUP_ENABLED` | `true` | Abilita lo scheduler del backup automatico. |
| `BACKUP_CRON` | `0 3 * * 0` | Quando eseguire il backup (domenica 03:00). |
| `BACKUP_KEEP` | `8` | Quanti backup conservare prima di eliminare i più vecchi. |
| `RECURRING_ENABLED` | `true` | Abilita la generazione automatica delle spese fisse. |
| `RECURRING_CRON` | `5 6 * * *` | Quando controllare le spese fisse dovute (+ sempre all'avvio). |
| `SELF_UPDATE_ENABLED` | `false` | `true` = il pulsante **Aggiorna** in Impostazioni fa `git pull` + riavvio del container (senza rebuild). Le modifiche a `Dockerfile`, dipendenze o `docker-compose.yml` richiedono comunque `./scripts/update.sh`. |
| `PUID` / `PGID` | `1000` | Solo `docker-compose.npm.yml`: uid/gid con cui gira il container, così l'aggiornamento dall'app può scrivere nel checkout git. Vedi lo scenario B della sezione reverse proxy. |
| `SECRETS_KEY` | — (facoltativa) | Chiave di cifratura per segreti applicativi (oggi: le credenziali Telegram, vedi [Gestione utenti](#gestione-utenti)). Serve solo a `npm run user:telegram`. Genera con `openssl rand -hex 32`. |

---

## Uso

- **Dashboard** — scegli il periodo (Giorno / Settimana / Mese) e l'ambito (Tutti / Personale / Casa),
  naviga con le frecce. Vedi entrate, uscite, saldo, ripartizione per categoria e per conto,
  split Personale/Casa e andamento. **Tocca il box Entrate o Uscite** per l'elenco dei
  movimenti di quel tipo nel periodo mostrato. Nella legenda "Spese per categoria" ogni voce
  ha un indicatore **▲/▼** rispetto alla media dei 3 mesi precedenti.
- **Movimenti** — elenco completo con **ricerca testo** (descrizione o categoria), filtro di
  periodo (Tutto / Ultimi 3 mesi / Quest'anno / singoli mesi) e per tipo, categoria, conto,
  ambito; pulsante **+** per aggiungere. Il form parte dalla **Descrizione** e propone
  categoria e conto in base allo storico; si può **creare una categoria al volo**
  (pulsante `+` accanto al menu Categoria). Eliminando un movimento c'è **5 secondi per
  annullare**.
- **Previsioni** — voci di budget: importo **mensile** o **una volta l'anno** (con il mese),
  categoria e ambito. La pagina mostra, per l'anno scelto, il **totale previsto**, lo **speso**
  reale, la **proiezione a fine anno** (mesi passati = reale, futuri = previsto), il **budget
  mensile necessario** e il **risparmio potenziale al mese**, oltre al confronto
  previsto/speso per mese e per categoria. Con un interruttore includi anche le **spese fisse**.
  Le voci previste **non creano movimenti e non influenzano i grafici della Dashboard**: sono
  solo un'ipotesi di budget.
- **Risparmio** — quando ci sono almeno 3 mesi completi di dati, stima entrate e uscite
  "necessarie" previste, calcola il margine mensile e propone come dividerlo tra **fondo
  sicurezza** (obiettivo in mensilità di spesa) e **fondo risparmio**, in € e in % delle
  entrate. Due cursori regolano l'obiettivo del fondo sicurezza e la priorità durante
  l'accumulo. È solo statistica sui tuoi dati, nessun servizio esterno.
- **Spese fisse** — regole ricorrenti (mutuo, rata, abbonamento, stipendio…), **ogni mese oppure
  una volta l'anno** in un mese scelto, con **durata opzionale**: attivando "Durata limitata"
  imposti il numero di rate/occorrenze e, raggiunto il limite, la regola si disattiva da sola
  (la lista mostra l'avanzamento, es. `3/12 rate`). A differenza delle voci previste, creano
  un **movimento vero**, il giorno scelto, finché la regola è **attiva**. Lo switch nella lista
  la disattiva senza toccare lo storico; «Esegui adesso» forza il controllo. I movimenti
  generati hanno il badge «fissa» e restano modificabili. All'avvio l'app recupera i
  mesi/anni arretrati (utile dopo un fermo del server); riattivando una regola **non** si
  recuperano i periodi in cui era spenta.
- **Categorie** — crea, rinomina, cambia colore, tipo o **ambito**, oppure elimina. Le categorie
  **Personali** e **Casa** sono separate: nella schermata Categorie appaiono in liste distinte,
  e nei form (Movimento, Spesa fissa, Voce prevista) il menu Categoria mostra solo quelle
  dell'ambito selezionato con lo switch Personale/Casa. Eliminando una categoria i movimenti
  collegati **restano** (diventano «senza categoria»).
- **Conti** — stessa cosa per i conti (contanti, conto corrente, carta…). Eliminando un conto
  i movimenti collegati restano «senza conto».
- **Impostazioni** — versione installata e **aggiornamento dall'app** (controlla / installa
  l'ultima versione da git, se `SELF_UPDATE_ENABLED=true`); **backup** (elenco, «Crea backup
  adesso», istruzioni di ripristino); sezione **Account** con il pulsante **Esci**.

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

> Se usi `docker-compose.npm.yml`, premetti a ogni comando
> `COMPOSE_FILE=docker-compose.npm.yml` (oppure aggiungi `-f docker-compose.npm.yml`).

Ogni utente ha i propri movimenti, categorie e conti, completamente separati.

Altri comandi:

```bash
docker compose exec web npm run user:list                 # elenco utenti
docker compose exec web npm run user:password             # reimposta una password (prompt)
docker compose exec web npm run user:password -- mario@esempio.it 'nuova-password'
```

> In alternativa puoi riattivare temporaneamente la registrazione: `ALLOW_REGISTRATION=true`
> nel `.env` → `./scripts/update.sh` → registri → rimetti `false` → `./scripts/update.sh`.

### Configurazione Telegram (bot token + chat id)

Serve per una futura funzione di invio del backup su Telegram. Bot token e chat id
sono **cifrati nel database** (chiave `SECRETS_KEY` nel `.env`, vedi
[Configurazione](#configurazione-env)) e gestiti **solo da qui**: non esiste
alcuna schermata web né rotta API che li legge o li scrive, quindi servono
accesso al server per configurarli.

```bash
# genera la chiave una sola volta, se non l'hai già fatto
echo "SECRETS_KEY=$(openssl rand -hex 32)" >> .env
docker compose up -d web        # o ./scripts/update.sh, per ricaricare il .env

docker compose exec web npm run user:telegram -- mario@esempio.it set '<bot_token>' '<chat_id>'
docker compose exec web npm run user:telegram -- mario@esempio.it show     # stato (chat id mascherato)
docker compose exec web npm run user:telegram -- mario@esempio.it remove  # rimuove la configurazione
```

> ⚠️ Se `SECRETS_KEY` cambia (es. rigenerata per errore, o persa e ricreata in un
> disastro), le credenziali Telegram già salvate non sono più decifrabili:
> vanno reimpostate con `set`. Conserva `SECRETS_KEY` insieme a `JWT_SECRET`,
> **fuori** dalla cartella `./backups` (i backup contengono le credenziali
> cifrate, ma senza la chiave restano inutilizzabili anche a te).

---

## Installare come app su iPhone/Android

L'app è una **PWA**: si aggiunge alla schermata Home e si apre a tutto schermo con la sua icona.

- **iPhone/iPad (Safari):** apri l'app → pulsante **Condividi** → **Aggiungi a Home**.
- **Android (Chrome):** menu ⋮ → **Installa app** / **Aggiungi a schermata Home**.

Non serve un app store e non c'è funzionamento offline: i dati restano sul server, quindi
serve la connessione al server per caricare o salvare movimenti.

> Su HTTP puro l'installazione funziona; alcuni browser mostrano il prompt "Installa" solo
> in HTTPS — in quel caso usa comunque *Aggiungi a Home* dal menu Condividi.

**Dopo un aggiornamento del server:** il codice della web app è servito con
`Cache-Control: no-store`, quindi basta **chiudere e riaprire** l'app dalla Home per
avere la versione nuova. (Solo la primissima volta, se l'app era già installata da prima
di questa modifica, serve una ricarica forzata: apri l'app in Safari/Chrome normale e
ricarica, oppure togli e riaggiungi l'icona alla Home.)

---

## Backup automatico

Ogni settimana (default: **domenica alle 03:00**, fuso `TZ`) l'app scrive un backup in:

```
/app/backups/soldi-backup-<AAAA-MM-GG_hh-mm-ss>/
├── users.csv
├── categories.csv
├── accounts.csv
├── recurring_rules.csv
├── planned_expenses.csv
├── transactions.csv
├── savings_settings.csv
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

Per gli scenari B e D c'è uno script che fa da solo schema + ripristino + avvio +
verifica: `./scripts/disaster-recovery.sh`. Vedi i dettagli più sotto.

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

# 3. schema + ripristino + avvio, in un solo comando
./scripts/disaster-recovery.sh --latest
```

<details>
<summary>Passo-passo manuale (equivalente allo script, se preferisci i comandi singoli)</summary>

```bash
docker compose up -d db
docker compose run --rm web npm run migrate
docker compose run --rm web npm run restore -- /app/backups/soldi-backup-2026-01-05_03-00-00 --yes
docker compose up -d web
```

</details>

### Scenario C — ripristino su un'altra macchina (dati persi, app ancora installata altrove)

1. Installa Docker, clona il repo, crea `.env` (riusa lo **stesso** `JWT_SECRET` se vuoi
   che le sessioni esistenti restino valide; altrimenti basta rifare il login).
2. Copia le cartelle `soldi-backup-*` dentro `./backups`.
3. Esegui il passo 3 dello **Scenario B** (`./scripts/disaster-recovery.sh --latest`).

### Scenario D — disastro completo: reinstallazione da zero della app

Il server stesso non esiste più (disco rotto, VM persa, provider cambiato…): si
riparte da un sistema vuoto e si ricostruisce tutto, dati inclusi. Presuppone che
tu abbia una copia di `./backups` fatta prima del disastro, conservata altrove
(vedi il consiglio in [Backup automatico](#backup-automatico)).

1. **Prepara la macchina**: installa Docker + il plugin Docker Compose.
2. **Clona il repository**:
   ```bash
   git clone https://github.com/mydohome/soldi.git
   cd soldi
   ```
3. **Ricrea `.env`** da `.env.example` (vedi [Configurazione](#configurazione-env)).
   Genera un nuovo `JWT_SECRET` con `openssl rand -hex 32` (riusa quello vecchio
   solo se vuoi che le sessioni già aperte restino valide). Scegli lo scenario di
   rete che ti serve — accesso diretto, o uno dei tre in
   [Dietro un reverse proxy](#dietro-un-reverse-proxy-nginx-proxy-manager) —
   e imposta `BIND_ADDR`/`HOST_PORT` (o `docker-compose.npm.yml`) di conseguenza.
4. **Recupera i backup**: copia le cartelle `soldi-backup-*` salvate altrove
   dentro `./backups`.
5. **Ripristina tutto**:
   ```bash
   ./scripts/disaster-recovery.sh --latest
   ```
   Crea lo schema, ripristina i dati, avvia l'app e ne verifica la salute — vedi
   [`scripts/disaster-recovery.sh`](scripts/disaster-recovery.sh).
6. Se eri dietro NPM, ricrea il **Proxy Host** (dominio, forward, certificato):
   la configurazione di NPM non fa parte del backup di Soldi.

### Verifica dopo il ripristino

Lo script `disaster-recovery.sh` la stampa già in automatico; a mano:

```bash
docker compose exec db psql -U soldi -d soldi -c \
  "SELECT (SELECT count(*) FROM users) AS utenti,
          (SELECT count(*) FROM categories) AS categorie,
          (SELECT count(*) FROM accounts) AS conti,
          (SELECT count(*) FROM recurring_rules) AS spese_fisse,
          (SELECT count(*) FROM transactions) AS movimenti;"
```

I numeri devono coincidere con quelli nel `manifest.json` del backup.

### Note

- `./scripts/disaster-recovery.sh [--latest|nome-backup]` copre gli scenari B, C e D:
  attende il database, crea lo schema, ripristina i dati, avvia l'app, controlla
  `/api/health` e stampa il riepilogo dei conteggi. Richiede solo `.env` e una
  cartella `./backups` già popolata — non installa Docker né clona il repo.
- Il ripristino è **idempotente**: puoi rieseguirlo, riparte sempre da `TRUNCATE`.
- Le sequenze degli ID vengono riallineate automaticamente dopo l'import.
- Senza `--yes` il comando `npm run restore` chiede conferma interattiva (digita `yes`).
- Il formato è CSV standard: in caso estremo puoi importare i file a mano con `psql \copy`.

---

## Architettura

```
soldi/
├── docker-compose.yml      # web (Node) + db (PostgreSQL) + volume backup — porta pubblicata
├── docker-compose.npm.yml  # variante dietro reverse proxy su rete Docker (nessuna porta)
├── Dockerfile
├── scripts/update.sh       # backup → git pull anonimo → rebuild → verifica
├── src/
│   ├── server.js           # Express, sicurezza (helmet), rotte, SPA fallback, no-store sul codice client
│   ├── db/
│   │   ├── pool.js          # pool pg condiviso + helper transazioni
│   │   ├── schema.sql       # schema idempotente (+ ALTER additivi per DB esistenti)
│   │   └── migrate.js       # applica lo schema all'avvio
│   ├── auth/                # hashing password, token di sessione, middleware, config Telegram
│   ├── crypto/secrets.js    # cifratura AES-256-GCM per segreti salvati nel DB (SECRETS_KEY)
│   ├── scripts/             # CLI: user:create/password/list/telegram (docker compose exec web npm run …)
│   ├── routes/              # auth, transactions, categories, accounts, recurring, planned, summary, savings, backups, settings
│   ├── recurring/           # generate.js (movimenti dovuti) + scheduler.js (catch-up all'avvio + cron)
│   ├── summary/savings.js   # modello del piano di risparmio (statistica pura)
│   ├── transactions/suggest.js  # suggerimenti descrizione/categoria/conto dallo storico
│   └── backup/              # backup-core.js (CSV + pruning), scheduler.js (cron settimanale), restore.js
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
| `GET`  | `/api/transactions` | Lista (filtri: `q`, `from`, `to`, `type`, `categoryId`, `accountId`, `scope`, `limit`, `offset`) |
| `POST` | `/api/transactions` | Crea movimento (`accountId`, `scope` opzionali) |
| `PATCH`| `/api/transactions/:id` | Modifica |
| `DELETE`| `/api/transactions/:id` | Elimina |
| `GET`  | `/api/transactions/suggest?note&type&scope` | Suggerimenti (descrizione, categoria, conto) dallo storico |
| `GET`/`POST`/`PATCH`/`DELETE` | `/api/categories` | Gestione categorie (`kind`, `scope`: personal\|home) |
| `GET`/`POST`/`PATCH`/`DELETE` | `/api/accounts` | Gestione conti |
| `GET`/`POST`/`PATCH`/`DELETE` | `/api/recurring` | Gestione spese fisse (`cadence`: monthly\|yearly + `month`; `totalOccurrences` per la durata limitata; `DELETE ?keepMovimenti=true` tiene i movimenti già generati) |
| `POST` | `/api/recurring/run` | Genera subito i movimenti fissi dovuti |
| `GET`/`POST`/`PATCH`/`DELETE` | `/api/planned` | Gestione voci di budget (spese previste) |
| `GET`  | `/api/planned/summary?year=YYYY&includeRecurring=true\|false&scope=` | Previsione annuale: totali, proiezione, budget mensile necessario, risparmio potenziale, per mese/categoria/ambito |
| `GET`  | `/api/savings` | Piano di risparmio: entrate/uscite previste, margine, % consigliate per fondo sicurezza e fondo risparmio |
| `PATCH`| `/api/savings` | Aggiorna `emergencyMonths` / `emergencySplit` |
| `GET`  | `/api/summary/overview?anchor=YYYY-MM-DD&scope=personal\|home` | Riepiloghi giorno/settimana/mese, ripartizione per categoria (con media 3 mesi) e per conto, split Personale/Casa |
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
