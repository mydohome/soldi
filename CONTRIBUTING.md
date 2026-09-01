# Come contribuire

Grazie per l'interesse! Questo progetto è piccolo e le PR sono benvenute.

## Preparare l'ambiente

```bash
npm install
cp .env.example .env      # imposta PGHOST=localhost e un JWT_SECRET qualsiasi
npm run migrate           # richiede un PostgreSQL in ascolto
npm run dev
```

Non hai un PostgreSQL locale? Usa Docker: `docker compose up -d db`.

## Prima di aprire una PR

- `npm test` deve passare (controlla la sintassi di tutti i file sorgente).
- Mantieni lo stile del codice circostante: niente framework, niente step di build
  lato client, query SQL sempre parametrizzate.
- Un commit = un cambiamento coerente. Messaggi in italiano o inglese, va bene entrambi.

## Struttura

Vedi la sezione **Architettura** del [README](README.md).

## Segnalare un problema

Apri una issue descrivendo cosa ti aspettavi e cosa è successo, con i passi per
riprodurlo. Per problemi di sicurezza, scrivi in privato al proprietario del repo.
