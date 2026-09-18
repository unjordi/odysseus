#!/usr/bin/env bash
# Guard de vocabulario: no INTRODUCIR "telemetría/telemetry" en cambios NUESTROS.
# unjordi 2026-09-18: la palabra está baneada por su connotación de tracking/espionaje, justo de lo que
# este proyecto (self-hosted, privacy-first) huye. El CONCEPTO se queda; cambia el nombre:
#   · observabilidad / Obs*   → la del router (trazas LOCALES, cero red)
#   · métricas del host       → la de hwfit (CPU/GPU/RAM del host)
#   · no phone-home           → el claim "no te espiamos" del marketing
#
# RESPETA lo que ya vive en el repo: solo mira las líneas AÑADIDAS del diff contra la base, así NO pelea
# con upstream ni con las descripciones de código de TERCEROS (manuales de otros harnesses, OpenTelemetry,
# la env-var ANONYMIZED_TELEMETRY de una lib ajena). Vetar lo nuevo, respetar lo heredado.
set -euo pipefail
base="${1:-origin/develop}"
added=$(git diff "$base"...HEAD \
    -- . ':(exclude)*.min.js' ':(exclude)scripts/check-no-telemetria.sh' ':(exclude).github/workflows/no-telemetria.yml' \
  | grep '^+' | grep -v '^+++' \
  | grep -iI "telemetr" \
  | grep -vi "ANONYMIZED_TELEMETRY" \
  | grep -vi "OpenTelemetry" \
  || true)
if [ -n "$added" ]; then
  echo "❌ Este cambio INTRODUCE 'telemetr*' (palabra baneada). Renómbrala:"
  echo "   · router  → 'observabilidad' / Obs*      · hwfit → 'métricas del host'      · marketing → 'no phone-home'"
  echo "--- líneas ofensoras ---"
  echo "$added"
  echo "(Si describes un tercero de nombre propio, exclúyelo explícitamente en este script.)"
  exit 1
fi
echo "✅ el diff contra $base no introduce 'telemetr*' — vocabulario limpio."
