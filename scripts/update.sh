#!/usr/bin/env bash
#
# Soldi — aggiornamento in-place. La logica vive in ops/update.sh (backup obbligatorio,
# dump completo del database, rollback automatico, notifiche); questo file resta per
# compatibilità con README, abitudini e documentazione.
#
#   ./scripts/update.sh [--force] [--yes] [--home <cartella>]
#
# Funziona dalla cartella del progetto (layout "repo") e dalla cartella di deploy che
# contiene app/ (layout "deploy"). COMPOSE_FILE=docker-compose.npm.yml è rispettato.
set -euo pipefail
exec "$(cd "$(dirname "$0")/.." && pwd)/ops/update.sh" "$@"
