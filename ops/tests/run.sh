#!/usr/bin/env bash
# Esegue tutti i test degli script di ops/ (senza Docker reale: usano stub).
set -uo pipefail
cd "$(dirname "$0")" || exit 1
rc=0
for t in ./*_test.sh; do
  echo "▸ $t"
  bash "$t" || rc=1
done
[ "$rc" -eq 0 ] && echo "TUTTI I TEST DEGLI SCRIPT OK" || echo "ALCUNI TEST FALLITI"
exit "$rc"
