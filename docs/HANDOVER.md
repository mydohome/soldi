# Soldi — passaggio di consegne per riprendere lo sviluppo

Scopo: ripartire in una nuova chat **senza rileggere tutto il repository**. Questo file dice che cosa
esiste, come si lavora, dove sta ogni cosa e che cosa resta da fare. Aggiornato al 2026-11-01
(`main` include le PR fino alla #71; nessuna PR di funzionalità aperta).

**Regola per risparmiare token:** leggi questo file, poi apri **solo** i file della funzione che tocchi
(mappa al §4). Non leggere per intero `README.md` (~45 KB), `docs/OPERATIONS.md` o
`public/js/app.js` (~3.000 righe): cerca con `grep -n` la funzione che serve e leggi quell'intervallo.

---

## 1. Che cos'è

**Soldi**: gestione di spese ed entrate personali (uso familiare, un solo proprietario).
Node 24 + Express + PostgreSQL 16, SPA in JavaScript puro (nessun build lato client), tutto in
`docker compose`. Repository pubblico: `github.com/mydohome/soldi` (proprietario `mydohome`).
Lingua di interfaccia, commenti, commit e PR: **italiano**.

Funzioni: login (JWT in cookie `httpOnly`), movimenti, categorie, conti, ambito Personale/Casa,
dashboard con grafici SVG fatti a mano, **spese fisse** (ricorrenti, con rate, data di inizio),
**pagamenti programmati «Da pagare»** (bollettini a rate pagati a mano), previsioni annuali,
piano di risparmio, esportazione Excel/CSV, backup/ripristino (globale e per utente), PWA iPhone,
aggiornamento dall'app, strumenti di gestione da terminale (`./soldi`).

Produzione: un server Debian con layout **«repo»** (`~/docker/soldi` è direttamente il checkout git,
senza sottocartella `app/`), HTTP semplice sulla rete di casa, sviluppo su macOS.

## 2. Come lavoriamo (flusso fisso)

1. L'utente chiede una modifica (spesso con un testo lungo di requisiti).
2. Branch dal `main` aggiornato (`git checkout -q main && git pull -q --ff-only && git checkout -b <nome>`).
3. Implementare **con test** (sotto), verificare nel browser per le modifiche di interfaccia
   (desktop e telefono), aggiornare README/guida in-app se cambia il comportamento visibile.
4. Commit in italiano che spiega il perché; in coda la riga `Co-Authored-By: …` indicata dal sistema.
   Push e `gh pr create` con descrizione (cosa, perché, verifiche, cosa fare sul server).
5. Aspettare i controlli di GitHub (devono essere tutti verdi, fino a **6**: `checks`, `docker-build`, `npm-audit`,
   `trivy-image`, `ops-tests`, `ops-integration`; gli ultimi due partono solo se cambiano `ops/`,
   backup, immagine o schema). Riferire all'utente in italiano, breve, senza gergo.
6. **Non unire finché l'utente non lo chiede** («fai merge quando i controlli passano»). Poi:
   `gh pr merge N --squash --delete-branch`, `git checkout main && git pull`, verificare lo stato.
7. Dopo l'unione, dire cosa fare sul server (di solito solo `./soldi update`).

Regole: non toccare cose fuori richiesta; un cambiamento rischioso = PR separata; se un controllo è rosso
per cause esterne, dirlo e proporre il rimedio invece di forzare; mai segreti nei log/argomenti/commit.

## 3. Ambiente locale (macOS)

- PostgreSQL 16 da Homebrew: `brew services start postgresql@16`; utente/password `soldi`/`soldi`,
  database di test `soldi_test` (il nome **deve** contenere «test»: alcuni test svuotano le tabelle).
- `npm test` = controllo di sintassi di tutti i file (`scripts/check.js`, ~60 file, nessun DB).
- `PGHOST=127.0.0.1 npm run test:integration` = ~210 test con il server vero (~35 s).
  Un file solo: `PGHOST=127.0.0.1 node --test --test-concurrency=1 tests/payments.test.js`.
- Script di gestione: `bash ops/tests/run.sh` (stub, senza Docker), `shellcheck` installato.
  `ops/tests/integration.sh` con Docker reale gira **solo in CI** (Docker non c'è sul Mac).
- Prova nel browser: creare `.claude/launch.json` (non committare) che avvia `node src/server.js` con
  `PGDATABASE=soldi_dev PORT=3055 JWT_SECRET=… BACKUP_ENABLED=false RECURRING_ENABLED=false`, creare il DB
  `soldi_dev`, popolarlo con `fetch` dalla console della pagina, poi eliminare DB e `.claude/`.
- Trappole della shell: zsh dà errore sui glob senza corrispondenza; `sed -i ''` su macOS; `timeout`
  non esiste; le catene `sleep` sono bloccate (usare cicli `until`).

## 4. Mappa del codice

| Area | File |
|---|---|
| Avvio, sicurezza HTTP, rotte | `src/server.js` (helmet, CSP, rate limit, `assertSecret()` all'avvio) |
| Schema DB (idempotente, solo ALTER additivi) | `src/db/schema.sql`, `src/db/migrate.js`, `src/db/pool.js` |
| Auth | `src/routes/auth.js` (limite per IP **e per account**), `src/auth/{tokens,users,admin,middleware,telegram}.js` |
| Validazione | `src/http/validate.js` (`handler`, `httpError`, `isoDate`, **`patchOf`**) |
| Movimenti | `src/routes/transactions.js` (collegamento a rate con `installmentId`), `src/transactions/{filters,suggest}.js` |
| Spese fisse | `src/routes/recurring.js`, `src/recurring/{schedule,generate,rates,scheduler}.js` |
| Pagamenti programmati | `src/routes/payments.js`, `src/payments/schedule.js`, `public/js/payments.js` |
| Dashboard / indicatori | `src/routes/summary.js` (`monthInsights`), `public/js/app.js` (`viewDashboard`, `insightTiles`, `fixedShareBlock`), `public/js/charts.js` |
| Previsioni, risparmio | `src/routes/{planned,savings}.js`, `src/summary/savings.js` |
| Esportazione | `src/routes/export.js` (exceljs a flusso, limite 50.000 righe) |
| Backup / ripristino | `src/backup/*` (`tables.js` elenca le tabelle: **aggiungere qui ogni nuova tabella**), `restore-user.js` rimappa gli id |
| Diagnostica | `src/diag/checks.js`, `scripts/diag.js` (`npm run diag`) |
| Interfaccia | `public/js/app.js` (SPA, router a hash, `modal()`, `choiceModal()`, `txRow`, `openTxModal`), `public/css/styles.css`, `public/js/api.js` |
| Gestione server | `ops/*.sh`, `ops/soldi` (comando `./soldi`), `ops/lib.sh`, `docs/OPERATIONS.md` |
| CI | `.github/workflows/{ci,ops,security}.yml`, `.github/dependabot.yml` |
| Test | `tests/*.test.js` (`tests/helpers.js` = harness), `ops/tests/*_test.sh` |

## 5. Decisioni di progetto da non rompere

- **Importi in centesimi interi** nel DB e nei calcoli; `Math.round(euro*100)` solo ai bordi. Le colonne
  `DATE` tornano come stringhe `YYYY-MM-DD` (parser in `pool.js`): mai `Date` per i giorni.
- **Isolamento tra utenti**: ogni query filtra per `user_id`; i riferimenti a categorie/conti/rate si
  validano come «dell'utente». Esiste un controllo in `diag` e test dedicati (`isolation.test.js`).
- **zod 4**: un `.default()` dentro `.partial()` riempie i campi mancanti → i PATCH usano `patchOf()`.
  Non usare `.partial()` direttamente.
- **Spese fisse**: una regola ha `start_month`, cursore `last_run_month`, `total_occurrences`,
  `skipped_months` (rate saltate: spostano la fine). Cambiare l'inizio sposta i movimenti già generati;
  l'inizio non può essere precedente a 10 anni fa (evita 12.000 movimenti in un colpo). Eliminare il
  movimento di una rata chiede se aggiornare lo stato delle rate. «Fissa» = movimento con `recurring_rule_id`.
- **Pagamenti programmati**: tabelle `payment_plans` e `payment_installments`. **Una rata è pagata se ha un
  movimento collegato** (`transaction_id`, `ON DELETE SET NULL`): eliminando il movimento la rata torna da
  pagare. Il numero di rata non è salvato (ordine per scadenza). Descrizione automatica «<piano> n di N».
  Pop-up all'apertura (una volta per sessione), badge su «Spese fisse», card in Dashboard.
  `PATCH /api/payments/:id` con `installments` = elenco completo delle rate non pagate (id = aggiorna,
  senza id = nuova, non nominate = eliminate), tutto in una transazione.
- **Indicatori dashboard** (`insights` in `/api/summary/overview`): picchi **escludendo le spese fisse**;
  stima di fine mese dal 5° giorno; media dei mesi nel grafico solo sui mesi con movimenti.
- **Sicurezza di sessione**: JWT HS256 (7 giorni, nessuna revoca), cookie `sameSite=lax`; in produzione
  l'app **non parte** con `JWT_SECRET` mancante, corto o di esempio.
- Nessun framework, nessun build lato client, query SQL sempre parametrizzate, `escapeHtml` su ogni dato
  utente messo in HTML.

## 6. Gestione del server (`./soldi`)

Dalla cartella del progetto sul server: `./soldi update` (backup + pull + ricostruzione + verifica +
rollback automatico), `status`, `check`, `backup`, `backup-plan` (pianifica il cron guardando gli altri job
della macchina), `restore-test`, `offsite`, `notify-test`, `logs web`, `diag`. Dettagli in `docs/OPERATIONS.md`.

- Layout «repo»: il link `soldi -> ops/soldi` deve puntare a `ops/soldi` (non `app/ops/soldi`).
- **Permessi (lezione già pagata):** gli script usano `umask 077`, ma `update.sh` esegue git con
  `umask 022`, altrimenti i file nell'immagine sono 600 e un container con `user: 1001:998` non legge
  `/app/package.json` (il backup fallisce con EACCES). Il Dockerfile imposta comunque `go+rX` su `/app`.
- Il container può avere `cap_drop: ALL`: `exec -u root … chmod` non funziona, serve `-u node`.
- Il backup pre-aggiornamento gira nel container **già in esecuzione** (costruito dall'aggiornamento precedente).
- Non ancora configurati in produzione: notifiche **Telegram** (`ops.env`, `./soldi notify-test`) e copia
  fuori macchina **restic** (`./soldi offsite --init`, mai provata su un server reale).
- Immagine: `node:24-alpine`, npm 12, `undici` incorporato in npm sostituito con una versione corretta
  (togliere la sostituzione quando npm ne incorpora una ≥ 6.29.1).

## 7. Sicurezza: stato dopo l'audit del 2026-10-27

Fatto (PR #64–#68): dipendenze corrette (zod 4, npm audit), limite di login per account, segreto di esempio
rifiutato, algoritmo JWT fissato, limite sulla data di inizio delle spese fisse, Node 24, permessi dei file.

Da fare (non urgente, in ordine di valore):
1. Montare `src/`, `public/` e `.:/repo` del compose in sola lettura salvo quando `SELF_UPDATE_ENABLED=true`;
   `cap_drop: [ALL]` e `read_only` come già in `docker-compose.npm.yml`.
2. Revoca delle sessioni (versione del token legata alla password; oggi un cookie rubato vale 7 giorni).
3. Avvisi npm **moderati** residui: `csv-parse` (via backup), `uuid` (via `exceljs`/`node-cron`, non
   raggiungibile), `qs` (via `express`; si può evitare con `overrides` o col parser delle query semplice).
4. HTTPS davanti all'app (reverse proxy): il cookie viaggia in chiaro su HTTP; con proxy `TRUST_PROXY=1`,
   senza proxy **`TRUST_PROXY=0`**.

## 8. Backlog e PR aperte

- Ultima funzione unita: #71 (dashboard, «Spese per categoria» con elenco breve + voce «Altre» cliccabile).
- Dependabot, da valutare una per una (non unire alla cieca): #63 `node` 24→26, #53 `postgres` 16→18
  (**cambio di versione maggiore del database: richiede dump/ripristino, non basta riavviare**),
  #57 `csv-parse` 7 e #59 `node-cron` 4 (cambi maggiori), #55 `helmet` 8, #70 `dotenv` 18, #56
  `csv-stringify`, #62 `actions/setup-node`. #29 è una vecchia PR di README.
- Idee emerse e non fatte: barra «Personale vs Casa» quando Casa è 0 (oggi resta una barra di un solo colore);
  rate non pagate nelle **Previsioni** (seconda fase dei pagamenti programmati); notifiche push iPhone
  (richiede HTTPS, service worker, chiavi VAPID: oggi l'avviso esiste solo con l'app aperta); modifica «a
  blocchi» delle date di un piano (es. spostare tutte le scadenze di una settimana).

## 9. Trappole già incontrate

- Test di integrazione: il server di test limita le **registrazioni a 20 ogni 15 minuti** → riusare pochi
  utenti (vedi `user()` in `tests/payments.test.js`).
- `POSTGRES_PASSWORD` vale solo alla prima creazione del volume: un volume vecchio dà «password authentication
  failed» (`down -v` solo se si accettano di perdere i dati).
- La CSP vieta script inline: tutto il JavaScript sta in file; `HTTPS_ENABLED=true` solo se davvero in HTTPS,
  altrimenti la SPA resta bloccata sul caricamento.
- Cancellare il ramo base di una PR impilata chiude la PR figlia (è successo con #49 → #50).
- Il pulsante «Aggiorna» dell'app fa solo `git pull` + riavvio: **non** installa nuove dipendenze né ricostruisce
  l'immagine; per Dockerfile/pacchetti serve `./soldi update`.
- `[hidden]` è sovrascritto da `display:flex/grid`: nel CSS c'è `[hidden]{display:none!important}`.
- Nei test con date, evitare giorni «di oggi» fissi: usare date relative (`day(offset)`) o mesi passati.

## 10. Memoria dell'assistente

Esiste un file di memoria con la cronologia dettagliata (`soldi-project.md`, ~29 KB) nella cartella di memoria di
Claude Code per questo progetto: **non leggerlo per intero**, usa `grep` per una PR o una decisione precisa.
Questo documento è la versione sintetica e prevale in caso di dubbio.

## 11. Messaggio per ripartire in una nuova chat

> Stiamo sviluppando Soldi (cartella del repository aperta). Leggi `docs/HANDOVER.md` e non rileggere README,
> OPERATIONS né `app.js` per intero: apri solo i file della funzione che tocchiamo. Rispondimi in italiano, breve.
> Segui il flusso del §2 (branch, test, PR; unire solo se te lo chiedo). Oggi voglio: …
