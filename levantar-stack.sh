#!/usr/bin/env bash
# levantar-stack.sh — LA herramienta para levantar/actualizar el stack COMPLETO (#26g).
#
# Un solo proyecto de compose (`odysseus`) con TODO adentro: odysseus · searxng · chromadb · ntfy · tts ·
# ollama · axon (main car). Levantan y se actualizan JUNTOS — esa es la razón de que este script exista.
#
#   ./levantar-stack.sh              # publica la imagen de axon desde origin/develop + up del stack
#   ./levantar-stack.sh --config     # NO levanta nada: imprime el compose RESUELTO (validación)
#   ./levantar-stack.sh --sin-axon   # el stack sin el main car (debug de Odysseus a pelo, :7000)
#   ./levantar-stack.sh --sin-ollama # deja el Ollama NATIVO del host (no levanta el del stack)
#   ./levantar-stack.sh --sin-build  # no re-buildea la imagen de Odysseus (up rápido)
#
# POR QUÉ ES UN SCRIPT Y NO UN `docker compose up` a mano: el `-f` correcto son CUATRO archivos, y la
# imagen de axon tiene que construirse DESDE `origin/develop` (no desde el árbol de trabajo) para que lo
# desplegado sea lo INTEGRADO. Un comando a mano se equivoca en cualquiera de las dos cosas — y ya pasó:
# 12 PRs mergeadas corriendo en ninguna parte (2026-09-07).
set -euo pipefail
cd "$(dirname "$0")"   # el project dir del compose ES este directorio (las rutas relativas dependen de él)

AXON_REPO="${AXON_REPO:-$HOME/code/axon}"
CON_AXON=1; CON_OLLAMA=1; BUILD_ARG="--build"; SOLO_CONFIG=0
for a in "$@"; do
  case "$a" in
    --config)     SOLO_CONFIG=1 ;;
    --sin-axon)   CON_AXON=0 ;;
    --sin-ollama) CON_OLLAMA=0 ;;
    --sin-build)  BUILD_ARG="" ;;
    *) echo "✗ opción desconocida: $a" >&2; exit 2 ;;
  esac
done

# ── el `-f`: base probada + overlays. `docker-compose.gpu-nvidia.yml` es el standalone que YA levanta el
#    stack en vivo (equivale a docker-compose.yml + docker/gpu.nvidia.yml); no se cambia para no recrear
#    todo por un cambio de forma. Los overlays SUMAN servicios; ninguno redefine lo de Odysseus.
FILES=(-f docker-compose.gpu-nvidia.yml -f docker/gpu.tts.yml)
[ "$CON_OLLAMA" = 1 ] && FILES+=(-f docker/ollama.yml)
[ "$CON_AXON"   = 1 ] && FILES+=(-f docker/axon.yml)

# Sin el overlay de ollama NO existe el host `ollama` en la red: axon tiene que salir por el host o se
# queda sin motor. Se fija aquí (no en el .env) para que la variable siga al modo de arranque, no al revés.
if [ "$CON_OLLAMA" = 0 ]; then export AXON_OLLAMA_URL="${AXON_OLLAMA_URL:-http://host.docker.internal:11434}"; fi

# ── PREFLIGHT: solo LEE. Nada de arrancar a ciegas para que reviente a la mitad. ─────────────────────
fatal() { echo "✗ $*" >&2; exit 1; }
aviso() { echo "⚠ $*" >&2; }

[ -f .env ] || fatal ".env no existe en $(pwd). Cópialo de .env.example y pon tus valores
   (el stack ya NO usa --env-file apuntando a otro clon: una sola copia, aquí)."

if [ "$CON_AXON" = 1 ]; then
  [ -d "$AXON_REPO/.git" ] || fatal "no encuentro el repo de axon en $AXON_REPO (override: AXON_REPO=…)"
  [ -x "$AXON_REPO/scripts/publish-axon.sh" ] || fatal "falta $AXON_REPO/scripts/publish-axon.sh"
  for f in "${AXON_TLS_CERT:-$HOME/.ssl/pisa.mx.fullchain.crt}" "${AXON_TLS_KEY:-$HOME/.ssl/pisa.mx.key}"; do
    [ -r "$f" ] || fatal "no puedo leer el cert TLS $f (axon sirve HTTPS nativo en :7001)"
  done
  # El contenedor viejo `axon-maincar` (del `docker run` suelto de antes) NO es parte del proyecto: si
  # sigue existiendo, es exactamente la pieza fuera del stack que estamos eliminando.
  if docker ps -a --format '{{.Names}}' | grep -qx axon-maincar; then
    aviso "existe el contenedor VIEJO 'axon-maincar' (fuera del stack). Bórralo antes:  docker rm -f axon-maincar"
  fi
  # El main car nativo y el del stack pelean por :7001.
  if [ "$SOLO_CONFIG" = 0 ] && systemctl --user is-active --quiet axon-maincar.service 2>/dev/null; then
    fatal "axon-maincar.service (NATIVO) está corriendo y ocupa :7001. Retíralo:
     systemctl --user disable --now axon-maincar.service"
  fi
fi

if [ "$CON_OLLAMA" = 1 ]; then
  # Ollama nativo y el del stack pelean por :11434. `mask` y no `disable`: ollama-ram-pin.service declara
  # `Wants=ollama.service`, y un Wants= puede re-arrancar una unidad meramente deshabilitada.
  if [ "$SOLO_CONFIG" = 0 ] && systemctl is-active --quiet ollama.service 2>/dev/null; then
    fatal "ollama.service (NATIVO) está corriendo y ocupa :11434. Retíralo ANTES del up:
     pkexec systemctl mask --now ollama.service
   Los pesos NO se tocan: /var/lib/ollama-models se monta tal cual en el contenedor (34 GB, sin copia).
   El pin en RAM (ollama-ram-pin.service) se queda y sigue sirviendo: mlock es sobre el page cache de
   esos inodos, y el bind-mount es el mismo inodo.
   Para levantar HOY sin tocar el Ollama nativo:  ./levantar-stack.sh --sin-ollama"
  fi
  [ -d "${OLLAMA_MODELS_DIR:-/var/lib/ollama-models}" ] || fatal "no existe el store de modelos ${OLLAMA_MODELS_DIR:-/var/lib/ollama-models}"
fi

# ── --config: valida y RESUELVE el compose sin construir ni levantar NADA ────────────────────────────
if [ "$SOLO_CONFIG" = 1 ]; then
  echo "═══ compose RESUELTO (no se construye ni se levanta nada) ═══" >&2
  exec docker compose "${FILES[@]}" -p odysseus config
fi

# ── 1/2 · imagen de axon DESDE origin/develop (lo INTEGRADO, no el árbol checked-out) ────────────────
if [ "$CON_AXON" = 1 ]; then
  echo "═══ 1/2 · imagen de axon desde origin/develop (herramienta oficial: publish-axon.sh) ═══"
  SHA_FILE="$(mktemp)"; trap 'rm -f "$SHA_FILE"' EXIT
  # SKIP_PUSH: el `up` consume la imagen LOCAL recién construida; no hace falta la vuelta por Docker Hub.
  # Ponle AXON_PUBLISH=1 para además publicarla (cuando quieras que otra máquina la jale).
  AXON_PUBLISH_SHA_FILE="$SHA_FILE" \
  AXON_PUBLISH_SKIP_PUSH="${AXON_PUBLISH_SKIP_PUSH:-$([ "${AXON_PUBLISH:-0}" = 1 ] && echo 0 || echo 1)}" \
    bash "$AXON_REPO/scripts/publish-axon.sh"
  AXON_IMAGE_TAG="$(cat "$SHA_FILE")"
  [ -n "$AXON_IMAGE_TAG" ] || fatal "publish-axon.sh no dejó el sha — no despliego un tag que no puedo probar"
  export AXON_IMAGE_TAG
  echo "   → el stack va a servir axon ${AXON_IMAGE_TAG} (verifícalo después: curl -sk https://127.0.0.1:7001/api/axon/version)"
fi

# ── 2/2 · el stack ──────────────────────────────────────────────────────────────────────────────────
echo "═══ 2/2 · up del stack (proyecto 'odysseus') ═══"
# SIN --remove-orphans, JAMÁS por reflejo: hoy `tts` viene de docker/gpu.tts.yml (ya en el -f de arriba),
# pero cualquier servicio que alguien haya creado desde otro directorio moriría sin aviso. Si de verdad
# quieres podar, mira primero `docker ps -a --filter label=com.docker.compose.project=odysseus`.
docker compose "${FILES[@]}" -p odysseus up -d ${BUILD_ARG}

echo
echo "✅ stack arriba. Qué está sirviendo axon:"
echo "   curl -sk https://127.0.0.1:7001/api/axon/version"
echo "   (compáralo con: git -C $AXON_REPO rev-parse --short origin/develop)"
