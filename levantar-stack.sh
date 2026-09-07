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
# La arista `axon depends_on ollama (healthy)` solo tiene sentido si los DOS están en el -f. Vive en su
# propio archivo justamente por esto: metida en cualquiera de los dos overlays, la otra combinación deja
# un compose INVÁLIDO (un depends_on a un servicio que no existe, o un `axon:` sin image ni build).
[ "$CON_AXON" = 1 ] && [ "$CON_OLLAMA" = 1 ] && FILES+=(-f docker/axon.ollama.yml)

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

# ── 3/3 · REPORTE DE SALUD. El `up -d` vuelve en cuanto los contenedores están CREADOS, no cuando los
#    servicios sirven: sin esto el script terminaba con un "✅ stack arriba" que solo probaba que docker
#    aceptó el comando, y dejaba al humano haciendo `docker ps` a ver qué pasó. Aquí se espera de verdad
#    y se DICE el estado de cada quien.
echo
echo "═══ 3/3 · esperando a que cada servicio esté SANO ═══"

# Espera a que ningún servicio con healthcheck siga en `starting`. El tope sale de los start_period
# declarados (el mayor es 90 s, el del TTS en su primer boot) + margen para las cadenas de depends_on.
ESPERA_MAX="${ESPERA_MAX:-180}"
t0=$SECONDS
while :; do
  # `--format json` da una línea JSON por servicio. Health vacío = servicio sin healthcheck declarado.
  pendientes="$(docker compose "${FILES[@]}" -p odysseus ps --format json 2>/dev/null \
    | grep -c '"Health":"starting"' || true)"
  [ "${pendientes:-0}" -eq 0 ] && break
  if [ $((SECONDS - t0)) -ge "$ESPERA_MAX" ]; then
    aviso "se acabaron los ${ESPERA_MAX}s de espera con $pendientes servicio(s) todavía en 'starting' — reporto lo que hay"
    break
  fi
  sleep 3
done

echo
printf '%-12s %-10s %s\n' "SERVICIO" "SALUD" "QUÉ SIGNIFICA / DÓNDE MIRAR"
printf '%-12s %-10s %s\n' "────────" "─────" "───────────────────────────"
malos=0
# El `ps` se lee UNA vez y se recorre: dos llamadas podrían ver estados distintos y reportar algo que
# nunca existió a la vez.
snapshot="$(docker compose "${FILES[@]}" -p odysseus ps --format '{{.Service}}\t{{.State}}\t{{.Health}}' 2>/dev/null || true)"
while IFS=$'\t' read -r svc estado salud; do
  [ -n "$svc" ] || continue
  case "$salud" in
    healthy)  icono="✅"; nota="sano" ;;
    starting) icono="⏳"; nota="todavía arrancando (mira: docker compose -p odysseus logs $svc)"; malos=$((malos+1)) ;;
    unhealthy) icono="❌"; nota="ENFERMO → docker compose -p odysseus logs $svc"; malos=$((malos+1)) ;;
    # Sin healthcheck declarado: se dice, no se disfraza de sano. Hoy no debería salir ninguno —
    # los siete servicios tienen el suyo — así que si aparece uno, es que se agregó un servicio y se
    # olvidó su healthcheck.
    ""|*)     if [ "$estado" = "running" ]; then icono="➖"; nota="corriendo, SIN healthcheck declarado (${salud:-sin salud})";
              else icono="❌"; nota="estado=$estado"; malos=$((malos+1)); fi ;;
  esac
  printf '%-12s %-10s %s %s\n' "$svc" "${salud:-—}" "$icono" "$nota"
done <<< "$snapshot"

# ── Los dos chequeos CAROS que un healthcheck no debe hacer cada `interval`, hechos UNA vez ──────────
# Un healthcheck corre para siempre: no puede sintetizar audio ni salir a buscar en internet. Pero esas
# son justo las dos cosas que distinguen "el contenedor está arriba" de "el servicio SIRVE". Aquí, una
# sola vez por despliegue, sí se pueden pagar.
echo
echo "── verificaciones de una sola vez (demasiado caras para un healthcheck) ──"

# TTS: SÍNTESIS REAL. Es lo único que distingue un Kokoro sano de uno que arrancó, lista sus voces y
# revienta en cada inferencia — el fallo de Blackwell (sm_120) que documenta docker/gpu.tts.yml.
if docker compose "${FILES[@]}" -p odysseus ps --status running --services 2>/dev/null | grep -qx tts; then
  if docker compose "${FILES[@]}" -p odysseus exec -T tts python -c \
       "import urllib.request,json,sys; r=urllib.request.urlopen(urllib.request.Request('http://localhost:8880/v1/audio/speech',data=json.dumps({'model':'kokoro','input':'hola','voice':'ef_dora','response_format':'mp3'}).encode(),headers={'Content-Type':'application/json'}),timeout=60); d=r.read(); sys.exit(0 if len(d)>1000 else 1)" >/dev/null 2>&1; then
    echo "✅ tts      · sintetiza audio de verdad (no solo lista voces)"
  else
    echo "❌ tts      · el contenedor está arriba pero NO SINTETIZA. Si cambiaste a la imagen GPU, es"
    echo "             probablemente el fallo sm_120 ('no kernel image available') que documenta"
    echo "             docker/gpu.tts.yml → vuelve a KOKORO_TTS_IMAGE=…kokoro-fastapi-cpu:v0.2.4"
    malos=$((malos+1))
  fi
fi

# searxng: BÚSQUEDA JSON REAL. Su healthcheck comprueba que arrancó y parseó settings.yml (su modo de
# fallo documentado), pero no que devuelve JSON — y JSON es la única forma en que Odysseus lo consume.
# No puede ir en el healthcheck: cada consulta sale a los motores upstream de verdad.
if docker compose "${FILES[@]}" -p odysseus ps --status running --services 2>/dev/null | grep -qx searxng; then
  if docker compose "${FILES[@]}" -p odysseus exec -T searxng python -c \
       "import urllib.request,json,sys; d=json.load(urllib.request.urlopen('http://localhost:8080/search?q=odysseus&format=json',timeout=25)); sys.exit(0 if 'results' in d else 1)" >/dev/null 2>&1; then
    echo "✅ searxng  · devuelve resultados en JSON (que es como Odysseus lo consume)"
  else
    echo "⚠  searxng  · sano para el healthcheck pero la búsqueda JSON no respondió. Puede ser red o"
    echo "             el formato 'json' deshabilitado en settings.yml → config/searxng/settings.yml"
  fi
fi

# ── El chequeo de drift: qué commit sirve axon vs. qué está integrado ────────────────────────────────
if [ "$CON_AXON" = 1 ]; then
  echo
  sirviendo="$(curl -sk --max-time 10 https://127.0.0.1:${AXON_SERVE_PORT:-7001}/api/axon/version 2>/dev/null \
    | sed -n 's/.*"commit_corto":"\([^"]*\)".*/\1/p')"
  integrado="$(git -C "$AXON_REPO" rev-parse --short origin/develop 2>/dev/null || echo '?')"
  if [ -z "$sirviendo" ]; then
    echo "❌ axon     · no pude leer /api/axon/version (¿TLS? ¿todavía arrancando?)"
    malos=$((malos+1))
  elif [ "$sirviendo" = "$integrado" ]; then
    echo "✅ axon     · sirviendo ${sirviendo} = origin/develop. Sin drift."
  else
    echo "❌ axon     · DRIFT: sirviendo ${sirviendo}, integrado ${integrado}. Vuelve a correr este script."
    malos=$((malos+1))
  fi
fi

echo
if [ "$malos" -eq 0 ]; then
  echo "✅ stack arriba y sano. Abre:  https://127.0.0.1:${AXON_SERVE_PORT:-7001}"
else
  echo "⚠  stack arriba con $malos punto(s) a revisar (arriba dice cuál y dónde mirar)."
  echo "   Nada se declara LISTO hasta que eso esté en verde y lo veas tú."
fi
