# Soldi — gestione operativa (runbook)

Gli strumenti sono in `ops/`. Servono a una cosa: **non perdere i dati** e rendere
semplici e ripetibili backup, ripristino, aggiornamento e diagnosi. Si usano da
terminale, tramite un unico comando `soldi`.

> **Indice** — [Strumenti](#strumenti) · [Prima attivazione](#prima-attivazione-in-produzione) ·
> [Procedure periodiche](#procedure-periodiche) · [Obiettivi](#obiettivi-dichiarati) ·
> [Cosa viene salvato](#cosa-viene-salvato-e-dove) · [Backup giornaliero](#backup-giornaliero) ·
> [Copia fuori macchina](#copia-fuori-macchina-cifrata-restic) · [Controllo dei backup](#controllo-dei-backup) ·
> [Notifiche](#notifiche-telegram) · [Prova di ripristino](#prova-di-ripristino) ·
> [Aggiornamento](#aggiornamento-con-rollback) · [Ripristino guidato](#ripristino-guidato) ·
> [Tre scenari di ripristino](#tre-scenari-di-ripristino) · [Sorveglianza](#sorveglianza-e-avvisi-di-guasto) ·
> [Come leggere gli avvisi](#come-leggere-gli-avvisi) · [Diagnostica](#diagnostica) ·
> [Installazione guidata](#installazione-guidata-e-pianificazione) · [Limiti noti](#limiti-noti) ·
> [Segreti](#segreti-da-conservare-fuori-macchina)

## Strumenti

Layout supportati (gli script rilevano da soli quale usi):

| Layout | Com'è fatto |
|---|---|
| **deploy** (produzione) | una cartella `~/docker/soldi/` con `docker-compose.yml`, `.env`, `backups/` e `app/`, che è il checkout git di questo repository. Gli script stanno in `app/ops/` e lavorano sulla cartella superiore. |
| **repo** | `docker-compose.yml` e `.env` nella radice del repository, come nel README. |

`COMPOSE_DIR` è la cartella che contiene `docker-compose.yml` e `.env` (si può forzare con
`--home <cartella>` o con la variabile `SOLDI_HOME`; di default è la cartella corrente, poi si risale
dalla posizione dello script). `APP_DIR` è `$COMPOSE_DIR/app` se è un checkout git, altrimenti
`$COMPOSE_DIR`. Il comando `soldi` si può richiamare con un link simbolico nella cartella di deploy:

```bash
ln -s app/ops/soldi ./soldi
./soldi help
```

| Comando | Che cosa fa |
|---|---|
| `soldi status` | quadro d'insieme: container, versione, età di backup/dump/copia fuori macchina/prova di ripristino, disco, diagnostica, avvisi |
| `soldi setup` | installazione guidata (genera il `.env` con segreti casuali, avvia lo stack) |
| `soldi diag [--json]` | diagnostica del database e della configurazione (sola lettura) |
| `soldi cron print\|install\|remove` | pianificazione di watch, backup, controlli e prova di ripristino |
| `soldi user [list\|create\|password\|telegram\|backup\|restore\|manage]` | gestione utenti (`npm run user:*` nel container web) |
| `soldi backup` | backup completo: applicativo + dump PostgreSQL + copia fuori macchina |
| `soldi check` | controlla che i backup esistano, siano recenti e integri |
| `soldi offsite [--init]` | copia fuori macchina cifrata (restic) |
| `soldi restore-test [--from-offsite]` | prova che l'ultimo backup si ripristina davvero |
| `soldi restore --latest \| --source <nome>` | ripristino guidato sul sistema esistente |
| `soldi dr` | ripristino di emergenza su una macchina nuova |
| `soldi update [--force]` | aggiornamento con backup obbligatorio e rollback automatico |
| `soldi watch` | controllo di salute (di norma da cron; a mano mostra ogni controllo) |
| `soldi notify-test [--simulate-fault]` | prova delle notifiche |
| `soldi logs [-f] [web\|db]` | log dei container |

Tutti gli script: non interattivi quando serve (`--yes` esplicito), codici di uscita **0 ok · 1 errore ·
2 avviso**, stato dell'ultima esecuzione in `ops-state/<job>.json` (formato stabile, vedi sotto). Non
mettono mai segreti nei log né negli argomenti dei comandi.

### Stato dei job: `ops-state/<job>.json`

```json
{"version":1,"job":"backup","ok":true,"status":"ok","startedAt":"2026-10-03T00:30:00Z",
 "finishedAt":"2026-10-03T00:30:41Z","durationMs":41000,"message":"…","details":{}}
```

`ok` è `false` solo per `status: "fail"`; un avviso è `ok: true, status: "warn"`. Il file viene scritto
in modo atomico (permessi 600). `durationMs` ha risoluzione di un secondo.

## Cosa viene salvato e dove

| Cosa | Dove | Note |
|---|---|---|
| Backup applicativo (CSV + `manifest.json`) | `backups/soldi-backup-<timestamp>/` | settimanale dall'app (`BACKUP_CRON`) e a ogni `soldi backup` |
| Dump PostgreSQL completo | `backups/dumps/soldi-AAAAMMGG-hhmmss.sql.gz` | quotidiano, verificato; se ne tengono `DUMP_KEEP` (14) |
| Dump prima di aggiornamento / ripristino | `backups/dumps/pre-update-*`, `pre-restore-*` | ultimi 5 di ciascun tipo |
| Copia fuori macchina | repository restic | cifrata e deduplicata; contiene `backups/`, `.env` e (layout deploy) il `docker-compose.yml` di produzione |
| Stato degli script | `ops-state/` | non va nel repository |

Backup e dump contengono `password_hash` e dati finanziari, il `.env` contiene le chiavi di
cifratura: **non lasciano mai la macchina in chiaro**. L'unica destinazione remota supportata è restic.

## Backup giornaliero

`soldi backup` (`ops/backup.sh`) esegue: backup applicativo (`npm run backup` nel container web) →
`pg_dump --clean --if-exists` compresso → verifica del dump (`gzip -t`, dimensione non nulla, riga finale
`-- PostgreSQL database dump complete`; se fallisce il file viene **cancellato** e il backup risulta
fallito) → retention → copia fuori macchina se configurata → stato, notifica in caso di errore, ping.

**Perché giornaliero.** Il backup applicativo da solo è settimanale: in caso di disastro si possono perdere
fino a 7 giorni di dati. Con il dump quotidiano la **perdita massima diventa 24 ore**.

Da pianificare con cron (vedi la procedura di prima attivazione). Variabile: `DUMP_KEEP` in `ops.env`.

## Copia fuori macchina cifrata (restic)

Un backup sulla stessa macchina non protegge da un guasto del disco, da un furto o da un incendio.
`soldi offsite` salva su un repository **restic** (cifrato, deduplicato) la cartella `backups/` e il `.env`
— con `JWT_SECRET`, `SECRETS_KEY` e `PGPASSWORD`: senza `SECRETS_KEY` le impostazioni Telegram cifrate non si
leggono più dopo un ripristino su un'altra macchina — e, nel layout deploy, il `docker-compose.yml` di
produzione (non è nel repository).

Configurazione in `ops.env` (copia da `ops.env.example`, `chmod 600`):

```
RESTIC_REPOSITORY=sftp:utente@altro-host:/srv/backup/soldi
RESTIC_PASSWORD_FILE=/home/massy/.restic-soldi-password
```

* **`RESTIC_PASSWORD_FILE`**: file con permessi 600, **fuori dal repository**. Conserva la password di restic
  **anche altrove** (password manager, cassaforte): senza non si recupera nulla.
* **Backend consigliati**: **SFTP** verso un altro host raggiungibile in VPN, oppure **S3 compatibile /
  Backblaze B2** (`s3:https://…` con `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in `ops.env`). Non sono
  supportati altri backend.
* Il repository si crea una volta, **esplicitamente**: `soldi offsite --init` (mai in automatico).
* A ogni esecuzione: `restic backup --tag soldi`, poi `forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12`
  (con `--prune` una volta a settimana) e `restic check --read-data-subset=5%` una volta a settimana.
* Se restic o la configurazione mancano, lo script esce con un avviso chiaro («copia fuori macchina NON
  configurata») e stato `warn`: mai un errore silenzioso.

## Controllo dei backup

`soldi check` verifica (0 ok · 2 avviso · 1 errore): ultimo backup applicativo (età ≤ `BACKUP_MAX_AGE_HOURS`,
192, `manifest.json` valido, utenti > 0) · ultimo dump (età ≤ 30 ore e integrità) · ultimo snapshot restic
(età ≤ 30 ore, se configurato) · spazio libero ≥ 15% sul disco dei backup · ultima prova di ripristino
riuscita e più recente di 40 giorni. Notifica solo i cambi di stato (o al massimo una volta ogni 24 ore per
lo stesso problema) e il rientro.

## Notifiche (Telegram)

Gli avvisi di gestione usano un **bot Telegram dedicato**, distinto da quello (cifrato) con cui l'app invia i
backup degli utenti.

1. Su Telegram apri **@BotFather** → `/newbot` → scegli nome e username → copia il **token**.
2. Apri una chat con il tuo bot (oppure aggiungilo a un gruppo) e scrivigli un messaggio.
3. Ricava il **chat id** senza esporre il token negli argomenti di un comando:
   ```bash
   curl -sS -K - <<< 'url = "https://api.telegram.org/botIL_TUO_TOKEN/getUpdates"'
   ```
   cerca `"chat":{"id":123456789` (per un gruppo l'id è negativo).
4. In `ops.env` (non nel `.env`: quello finisce nel container web):
   ```
   ALERT_TG_TOKEN=...
   ALERT_TG_CHAT=123456789
   ```
5. Prova: `soldi notify-test` (un messaggio per livello). Per vedere come si comportano gli avvisi di guasto
   senza fermare nulla: `soldi notify-test --simulate-fault` (avviso, promemoria, ripristinato).

I messaggi contengono nome host, job e livello, mai dati finanziari, email degli utenti o segreti. Il token
viaggia su stdin di curl (`curl -K -`). Se Telegram non è raggiungibile i messaggi restano in
`ops-state/outbox/` e vengono reinviati alla chiamata successiva (massimo 50, scadenza 48 ore).

**Interruttore del «morto».** Un cron fermo non può avvisare di essere fermo. Con un servizio esterno
(es. healthchecks.io) imposta in `ops.env` `HC_PING_URL_BACKUP`, `HC_PING_URL_OFFSITE`,
`HC_PING_URL_RESTORE_TEST` e `HC_PING_URL_WATCH` (o un solo `HC_PING_URL`): gli script fanno il ping
all'inizio e alla fine di ogni job (`/start`, esito positivo, `/fail`); `watch` a ogni esecuzione.

## Prova di ripristino

`soldi restore-test` dimostra che l'ultimo backup si ripristina **davvero**, senza mai toccare il database di
produzione: crea un PostgreSQL temporaneo (`postgres:16-alpine`, dati in tmpfs, nome `soldi-restoretest-<random>`)
su una rete Docker `--internal` usa-e-getta, senza porte pubblicate; con la stessa immagine dell'app esegue
`migrate.js` e `restore.js <ultimo backup> --yes` (backups/ montata in sola lettura); confronta le righe di
ogni tabella con `manifest.json` e, se disponibile, esegue la diagnostica. **Barriere obbligatorie** prima di
ogni operazione distruttiva: `PGHOST` deve essere il container temporaneo, la rete isolata, nessun container
di produzione collegato, nome diverso da quelli di produzione; altrimenti abort. Pulizia garantita (trap) anche
dopo errori o Ctrl+C.

`soldi restore-test --from-offsite` ripristina prima l'ultimo snapshot restic in una cartella temporanea e testa
quello: verifica l'intera catena (copia remota → cifratura → ripristino).

## Aggiornamento con rollback

`soldi update` (`ops/update.sh`; `scripts/update.sh` resta come wrapper):

1. rifiuta se ci sono **modifiche locali non committate** o un altro aggiornamento in corso (lock);
2. **backup obbligatorio**: applicativo + dump completo (`backups/dumps/pre-update-*`); se fallisce
   l'aggiornamento è annullato, a meno di `--force`;
3. `git` solo fast-forward → `docker compose up -d --build` → attesa dello stato sano (HEALTHCHECK del
   container, con sonda di riserva se manca);
4. se non diventa sano: **torna al commit precedente** e rifà il deploy.

Esce **sempre con 1** se l'aggiornamento non è andato a buon fine, anche dopo un rollback riuscito (il servizio
resta attivo con la versione precedente). Notifica successo, fallimento e rollback.

**Limiti.** Il rollback ripristina il *codice*, non il database. Lo schema cresce solo con modifiche additive,
quindi il codice vecchio gira normalmente sul database nuovo; il dump pre-aggiornamento copre i casi
distruttivi. Un nuovo pacchetto npm richiede la ricostruzione dell'immagine (lo fa `update`); il pulsante
«Aggiorna» dell'app fa solo `git pull` e riavvio e **non** installa nuove dipendenze.

## Ripristino guidato

`soldi restore --latest` (o `--source <nome>`) sul sistema esistente: mostra data e righe per tabella, chiede
di **digitare `RIPRISTINA`** (con `--yes` solo insieme a `--source`), fa un **dump di sicurezza** dello stato
attuale, ferma web, esegue `restore.js` in un container usa-e-getta (stessa immagine e reti, `--no-deps`),
riavvia web, attende lo stato sano e lancia la diagnostica. Se un passaggio fallisce stampa il comando esatto
per tornare al dump di sicurezza.

`soldi dr` ricostruisce tutto su una **macchina nuova**: `--source-dir <cartella con backups/ e .env>` oppure
`--restic` (ultimo snapshot o `--snapshot <id>`). Clona il repository in `app/`, ripristina il `.env`
originale (con `--ask-secrets` chiede `JWT_SECRET` e `SECRETS_KEY` originali; con una `SECRETS_KEY` diversa le
impostazioni Telegram cifrate diventano illeggibili), crea `proxy-net` se serve, avvia **solo** il database,
ripristina in un container usa-e-getta, avvia web e lancia la diagnostica. `--dry-run` stampa i passaggi senza
eseguirli; prima di toccare i dati chiede di digitare `RIPRISTINA`.

## Sorveglianza e avvisi di guasto

`soldi watch` gira ogni 5 minuti da cron, è leggero (nessuna scrittura sul database) e controlla: container
`web` e `db` in esecuzione e sani · `pg_isready` · endpoint `/api/health` dall'interno del container · riavvii a
ripetizione (`RestartCount`) · spazio libero su disco dei backup e di Docker (avviso < 15%, errore < 7%) ·
esito degli ultimi job · riavvio dell'host.

Per non essere subissati (macchina a stati in `ops-state/watch.json`): un problema si segnala **solo dopo 2
controlli consecutivi falliti** (~10 minuti, per non allarmarsi durante un aggiornamento); finché dura, un
**promemoria ogni 6 ore**; quando rientra, un messaggio «**ripristinato**» con la durata del guasto. Ogni
messaggio indica il controllo fallito e un suggerimento (es. `soldi logs web`). Con `HC_PING_URL_WATCH` ogni
esecuzione completata fa un ping esterno.

## Prima attivazione in produzione

Nell'ordine, da `~/docker/soldi` (cartella di deploy; `app/` è il checkout git):

1. **Aggiorna il codice e ricostruisci l'immagine** (serve per `npm run diag`):
   ```bash
   cd ~/docker/soldi && git -C app pull --ff-only && docker compose up -d --build
   ln -s app/ops/soldi ./soldi && ./soldi help
   ```
2. **Controlla lo stato**: `./soldi status` (all'inizio vedrai avvisi: mancano ancora dump, copia fuori macchina e prova di ripristino).
3. **Crea `ops.env`** (`cp app/ops.env.example ops.env && chmod 600 ops.env`) con il bot di allerta
   (vedi [Notifiche](#notifiche-telegram)) e **verifica il canale**: `./soldi notify-test` e
   `./soldi notify-test --simulate-fault` (devi ricevere 3 + 3 messaggi su Telegram).
4. **Configura restic** in `ops.env` (`RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE` + credenziali del
   backend), crea il file della password (`openssl rand -base64 24 > ~/.restic-soldi-password && chmod 600 …`),
   **conservala anche altrove**, poi `./soldi offsite --init`.
5. **Primo backup completo**: `./soldi backup` → deve uscire con 0 e fare anche la copia fuori macchina.
   Verifica la copia: `restic snapshots --tag soldi` (con `RESTIC_REPOSITORY`/`RESTIC_PASSWORD_FILE`
   nell'ambiente) oppure `./soldi check`.
6. **Prova di ripristino, prima in locale e poi dalla copia remota**: `./soldi restore-test` e
   `./soldi restore-test --from-offsite`. Entrambe devono riuscire: solo allora la copia fuori macchina è
   dimostrata.
7. **Pianifica**: `./soldi cron install` (watch ogni 5 minuti, backup alle 02:30, controllo alle 08:00,
   prova di ripristino il primo domenica del mese; con restic configurato usa `--from-offsite`).
   Verifica con `crontab -l`.
8. **Controllo finale**: `./soldi check` deve uscire con 0 e `./soldi status` non mostrare avvisi.
   Dopo il primo giro notturno guarda `ops-state/backup.log` e `ops-state/*.json`.
9. Facoltativo ma consigliato: un check esterno (healthchecks.io) con `HC_PING_URL_*` in `ops.env`, per
   sapere anche se si ferma il cron o muore la macchina.

## Procedure periodiche

| Quando | Cosa | Come |
|---|---|---|
| ogni giorno (automatico) | backup completo + dump + copia fuori macchina | cron 02:30 → `ops-state/backup.json` |
| ogni giorno (automatico) | controllo dei backup | cron 08:00 → avviso solo se c'è un problema |
| ogni 5 minuti (automatico) | sorveglianza del servizio | cron → avviso dopo 2 controlli falliti |
| ogni settimana | guarda `./soldi status` e leggi gli avvisi ricevuti | 1 minuto |
| ogni mese (automatico) | prova di ripristino dalla copia remota | cron, primo domenica alle 05:00 |
| ogni mese (a mano) | `./soldi diag` | controlla schema, dati e configurazione |
| prima di ogni aggiornamento | niente: `./soldi update` fa già backup e rollback | |
| una volta l'anno | prova a ripristinare **a mano** su una macchina di prova con `soldi dr --restic` | verifica anche i documenti e i segreti conservati fuori |

## Obiettivi dichiarati

* **Perdita massima di dati (RPO): 24 ore**, grazie al dump quotidiano (02:30) e alla copia fuori macchina
  subito dopo. Il solo backup applicativo, da solo, sarebbe settimanale (fino a 7 giorni).
* **Tempi di ripristino (RTO), stimati** per un database di dimensioni familiari (< 100 MB):
  ripristino guidato sul sistema esistente **5–10 minuti**; ricostruzione su una macchina nuova
  **30–60 minuti** (installazione di Docker e build dell'immagine comprese). La durata reale di un
  ripristino la trovi in `ops-state/restore-test.json` (`durationMs`) dopo ogni prova.
* **Verifica**: un backup non provato non conta. Il controllo (`soldi check`) segnala una prova di
  ripristino più vecchia di 40 giorni.

## Tre scenari di ripristino

**1. Dati corrotti o errore umano** (la macchina funziona):

```bash
./soldi restore --latest                   # oppure: --source soldi-backup-2026-10-01_03-00-00-000
```
Mostra data e righe del backup, chiede di digitare `RIPRISTINA`, fa un dump di sicurezza, ripristina e
verifica. Per tornare a uno stato di **qualche ora fa** (il backup applicativo è più vecchio) usa un dump:
```bash
docker compose stop web
gzip -dc backups/dumps/soldi-AAAAMMGG-hhmmss.sql.gz | docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDATABASE"
docker compose up -d web && ./soldi diag
```
(`$PGUSER`/`$PGDATABASE` sono nel `.env`; il dump è fatto con `--clean --if-exists`.)

**2. Macchina persa** (serve una macchina nuova con Docker, git e restic):

```bash
mkdir -p ~/docker/soldi && cd ~/docker/soldi
git clone https://github.com/mydohome/soldi.git app
# serve solo per leggere la copia remota: repository e file della password di restic
cp app/ops.env.example ops.env && chmod 600 ops.env      # imposta RESTIC_REPOSITORY, RESTIC_PASSWORD_FILE e le credenziali
./app/ops/dr.sh --home ~/docker/soldi --restic --dry-run  # mostra i passaggi senza eseguirli
./app/ops/dr.sh --home ~/docker/soldi --restic            # chiede di digitare RIPRISTINA
```
Ripristina `.env` (con le chiavi originali), `docker-compose.yml` di produzione e backup, avvia il database,
ripristina e avvia l'app. Poi: ricrea `ops.env`, `./soldi cron install`, `./soldi backup`, `./soldi restore-test`.
Da una **cartella locale** (es. un disco con una copia di `backups/` e `.env`): `--source-dir <cartella>`
al posto di `--restic`. Se non hai il `.env`: `--ask-secrets` chiede `JWT_SECRET` e `SECRETS_KEY` originali
(con una chiave diversa le credenziali Telegram salvate diventano illeggibili).

**3. Solo il database è perso** (volume `db-data` cancellato; macchina, `.env` e `backups/` ci sono):

```bash
docker compose up -d                  # il database è nuovo e vuoto; web crea lo schema all'avvio
./soldi restore --latest              # ripristina i dati dall'ultimo backup applicativo
./soldi diag
```
In alternativa un solo comando che rifà tutto: `./soldi dr --source-dir ~/docker/soldi` (usa `backups/`
e `.env` già presenti).

## Come leggere gli avvisi

| Messaggio (inizio) | Chi lo manda | Che cosa significa / che cosa fare |
|---|---|---|
| «Backup NON riuscito: dump PostgreSQL FALLITO» | `backup` | il dump è stato scartato; guarda `ops-state/backup.log`, spesso il container `db` è fermo. Rilancia `soldi backup` |
| «Backup locale ok, ma: copia fuori macchina FALLITA» | `backup` | i dati locali sono salvi, quelli remoti no: `soldi offsite` e leggi l'errore (rete, credenziali, spazio) |
| «Controllo backup: … vecchio di N ore» | `check` | un job non gira più: `crontab -l`, `ops-state/backup.log` |
| «Controllo backup: … prova di ripristino…» | `check` | `soldi restore-test` (e, se fallisce, **non fidarti** dei backup finché non è risolto) |
| «container web NON sano / NON in esecuzione» | `watch` | `soldi logs web`; `docker compose up -d`; se è dopo un aggiornamento valuta `soldi update` di nuovo o il rollback |
| «PostgreSQL non accetta connessioni» | `watch` | `soldi logs db`; spazio disco? |
| «si è riavviato N volte» | `watch` | crash a ripetizione: `soldi logs web` |
| «spazio libero N% sul disco …» | `watch` | `docker system df`, `ls -lh backups/dumps`; abbassa `DUMP_KEEP` |
| «Ultimo esito di "…" FALLITO» | `watch` | un job è fallito e non è riuscito ad avvisare: leggi `ops-state/<job>.json` |
| «Ripristinato: …» | `watch` | il problema è rientrato (con la durata) |
| «Promemoria — il problema dura da …» | `watch` | ogni 6 ore finché non rientra |
| «L'host è stato riavviato» | `watch` | informativo, con lo stato dei servizi |
| «Soldi aggiornato a …» / «Aggiornamento FALLITO» | `update` | vedi [Aggiornamento](#aggiornamento-con-rollback) |
| «(in ritardo)» davanti al messaggio | `notify` | Telegram era irraggiungibile: il messaggio è partito dalla coda |

## Diagnostica

`soldi diag` (`npm run diag` nel container web; `--json` per l'output strutturato, `--data-only` ignora
configurazione e backup) fa controlli in **sola lettura** (transazione `READ ONLY`), con esito
ok/avviso/errore e uscita 0 / 2 / 1; non stampa mai segreti né dati personali:

* **schema**: tabelle, colonne, indici (`uq_tx_rule_month`…) e vincoli attesi; i vincoli `NOT VALID` senza righe
  fuori regola sono segnalati come «convalidabili» (`ALTER TABLE … VALIDATE CONSTRAINT …`), con righe fuori
  regola sono un avviso;
* **dati**: voci annuali senza mese · categoria di tipo diverso da movimento/regola · **riferimenti tra utenti
  diversi** (errore: violazione di isolamento) · spese fisse in ritardo / oltre la fine del piano / con più
  movimenti del previsto · sequenze `IDENTITY` indietro rispetto a `MAX(id)` (errore: tipico dopo un
  ripristino, il prossimo inserimento fallirebbe) · email duplicate ignorando le maiuscole · credenziali
  Telegram decifrabili con la `SECRETS_KEY` corrente;
* **configurazione**: `JWT_SECRET` assente/corto/di esempio, `SECRETS_KEY` assente o non valida, `PGPASSWORD`
  predefinita, `ALLOW_REGISTRATION=true`, `COOKIE_SECURE=false` con `HTTPS_ENABLED=true`;
* **backup**: età dell'ultimo backup applicativo;
* **informazioni**: versione di PostgreSQL, dimensione del database, righe per tabella, SHA dell'app.

Il database è quello delle variabili `PG*`: `restore-test` la usa sul database temporaneo. Poiché
`scripts/diag.js` e lo script npm stanno nell'immagine, la prima volta serve la ricostruzione
(`soldi update`); `soldi status` e `soldi restore` lo segnalano se manca.

## Installazione guidata e pianificazione

`soldi setup` (`ops/setup.sh`) guida una **nuova installazione**: controlla docker, compose v2, git, curl e
openssl; chiede lo scenario tra quelli del README (1 in LAN/locale, 2 dietro proxy sullo stesso host con
porta solo locale, 3 dietro proxy su rete Docker con `docker-compose.npm.yml`, 4 proxy su un altro host);
genera il `.env` dal modello con `JWT_SECRET`, `SECRETS_KEY` (64 caratteri esadecimali, come richiede
`src/crypto/secrets.js`) e `PGPASSWORD` casuali, `HTTPS_ENABLED`/`COOKIE_SECURE`/`TRUST_PROXY` secondo lo
scenario, `ALLOW_REGISTRATION=false`, `TZ`, e per lo scenario 3 anche `PUID`/`PGID` e `COMPOSE_FILE`;
permessi 600. **Non sovrascrive mai un `.env` esistente** senza copia di sicurezza e conferma (i segreti già
presenti restano) e **rifiuta di rigenerare `PGPASSWORD` se il volume `db-data` esiste già**:
`POSTGRES_PASSWORD` vale solo alla prima inizializzazione, cambiarla romperebbe l'accesso al database.
Poi crea `proxy-net` se serve, avvia lo stack, attende lo stato sano e propone di creare il primo utente e,
facoltativamente, `ops.env`.

`soldi cron install` aggiunge (idempotente, tra `# BEGIN soldi` e `# END soldi`) al crontab dell'utente:
watch ogni 5 minuti, backup alle 02:30, controllo dei backup alle 08:00, prova di ripristino il primo
domenica del mese alle 05:00. Ogni riga passa da `ops/cronrun.sh`: un solo esemplare alla volta (`flock`) e
log in `ops-state/<job>.log` con rotazione semplice (oltre 1 MB; si tengono 3 file). `soldi cron print` mostra
le righe, `soldi cron remove` le toglie.

## Limiti noti

* Il rollback dell'aggiornamento ripristina il **codice**, non il database (vedi [sopra](#aggiornamento-con-rollback)).
* Il pulsante «Aggiorna» dell'app non installa nuove dipendenze (il suo `npm ci` usa il `package.json`
  dell'immagine): le versioni che cambiano `package.json` richiedono `soldi update`.
* Il backup applicativo e il dump sono **per tutta l'installazione**: un utente non può ripristinare da
  Impostazioni il backup globale (solo i propri backup personali).
* `durationMs` dei file di stato ha risoluzione di un secondo.
* `soldi watch` vede solo ciò che gira sulla macchina: se muore l'intera macchina o si ferma il cron serve il
  ping esterno (`HC_PING_URL_WATCH`).
* La copia fuori macchina non include `ops.env` (contiene le credenziali per leggere la copia stessa).
* La diagnostica e la prova di ripristino con `diag` richiedono l'immagine ricostruita dopo l'introduzione.
* Compatibilità: script bash testati con bash 3.2 (macOS) e 5.x (Linux); il lock usa `flock` se presente.

## Segreti da conservare fuori macchina

| Segreto | Dove sta | Se lo perdi |
|---|---|---|
| **`.env`** (`JWT_SECRET`, `SECRETS_KEY`, `PGPASSWORD`) | cartella di deploy; **nella copia restic** | senza `SECRETS_KEY` le credenziali Telegram salvate nel database non sono più leggibili (vanno reimpostate); senza `JWT_SECRET` tutti gli utenti devono rifare il login |
| **password di restic** | `RESTIC_PASSWORD_FILE` | **la copia fuori macchina è irrecuperabile**: conservala anche in un password manager |
| **`ops.env`** | cartella di deploy (permessi 600) | si ricrea (token del bot, credenziali del backend, URL di ping), ma servono i valori originali di restic per leggere la copia |
