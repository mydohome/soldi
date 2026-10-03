# Soldi — gestione operativa (runbook)

Gli strumenti sono in `ops/`. Servono a una cosa: **non perdere i dati** e rendere
semplici e ripetibili backup, ripristino, aggiornamento e diagnosi. Si usano da
terminale, tramite un unico comando `soldi`.

> **Indice** — [Strumenti](#strumenti) · [Cosa viene salvato](#cosa-viene-salvato-e-dove) ·
> [Backup giornaliero](#backup-giornaliero) · [Copia fuori macchina](#copia-fuori-macchina-cifrata-restic) ·
> [Controllo dei backup](#controllo-dei-backup) · [Notifiche](#notifiche-telegram) ·
> [Prova di ripristino](#prova-di-ripristino) · [Aggiornamento](#aggiornamento-con-rollback) ·
> [Ripristino](#ripristino-guidato) · [Sorveglianza](#sorveglianza-e-avvisi-di-guasto) ·
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

## Segreti da conservare fuori macchina

| Segreto | Dove sta | Se lo perdi |
|---|---|---|
| **`.env`** (`JWT_SECRET`, `SECRETS_KEY`, `PGPASSWORD`) | cartella di deploy; **nella copia restic** | senza `SECRETS_KEY` le credenziali Telegram salvate nel database non sono più leggibili (vanno reimpostate); senza `JWT_SECRET` tutti gli utenti devono rifare il login |
| **password di restic** | `RESTIC_PASSWORD_FILE` | **la copia fuori macchina è irrecuperabile**: conservala anche in un password manager |
| **`ops.env`** | cartella di deploy (permessi 600) | si ricrea (token del bot, credenziali del backend, URL di ping), ma servono i valori originali di restic per leggere la copia |
