#!/usr/bin/env bash
# levantar-stack.sh — LA herramienta para levantar/actualizar el stack COMPLETO (#26g).
#
# Un solo proyecto de compose (`odysseus`) con TODO adentro: odysseus · searxng · chromadb · ntfy · tts ·
# ollama · axon (main car). Levantan y se actualizan JUNTOS — esa es la razón de que este script exista.
#
#   ./levantar-stack.sh                # publica la imagen de axon desde origin/develop + up del stack
#   ./levantar-stack.sh --config       # NO levanta nada: imprime el compose RESUELTO (validación)
#   ./levantar-stack.sh --sin-axon     # el stack sin el main car (debug de Odysseus a pelo, :7000)
#   ./levantar-stack.sh --sin-ollama   # deja el Ollama NATIVO del host (no levanta el del stack)
#   ./levantar-stack.sh --sin-publicar # NO publica la imagen: consume el AXON_IMAGE_TAG que ya le den
#
# POR QUÉ ES UN SCRIPT Y NO UN `docker compose up` a mano: el `-f` correcto son CUATRO archivos, y la
# imagen de axon tiene que construirse DESDE `origin/develop` (no desde el árbol de trabajo) para que lo
# desplegado sea lo INTEGRADO. Un comando a mano se equivoca en cualquiera de las dos cosas — y ya pasó:
# 12 PRs mergeadas corriendo en ninguna parte (2026-09-07).
#
# ─────────────────────────────────────────────────────────────────────────────────────────────────────
# EL MODO CD: `--sin-publicar`  (lo usa el workflow deploy-axon de axon)
# ─────────────────────────────────────────────────────────────────────────────────────────────────────
# El CD de axon (`axon/.github/workflows/deploy-axon.yml`) ya buildeó y publicó la imagen en su job de
# cloud; lo único que le falta es que el stack SIRVA esa imagen. Antes hacía un `docker run` suelto con
# `--name axon-maincar -p 7001:7001` — un contenedor FUERA del proyecto de compose, que colisionaba en
# :7001 con el servicio `axon` de este stack (y con el axon nativo). Ese `docker run` se retiró; ahora el
# CD entra POR AQUÍ y el resultado es un servicio más del proyecto `odysseus` — no una pieza suelta que
# nadie ve en `docker compose ps`.
#   AXON_IMAGE_TAG=<sha-corto> ./levantar-stack.sh --sin-publicar
#
# HUBO una segunda bandera, `--solo-axon`, que recreaba SOLO el servicio `axon` (`up -d --no-deps axon`)
# sobre un stack ya arriba, con su propio preflight, su reporte acotado y su exit code. Se ELIMINÓ el
# 2026-09-07 por decisión explícita de unjordi: el cómputo local es GRATIS y este script reconstruye y
# levanta TODO, SIEMPRE. Un despliegue parcial es justamente lo que esconde el drift — deja a los demás
# servicios sirviendo lo de anteayer sin que nada lo diga — y además tapa el mal manejo de ramas: si
# `develop` del fork trae algo que ni compila, un CD que no reconstruye Odysseus nunca se entera. Es la
# misma dirección en la que murió `--sin-build` el mismo día, después de que un QA se hiciera sobre una
# imagen rancia.
# CONSECUENCIA QUERIDA Y EXPLÍCITA: un push a `develop` de AXON reconstruye el stack ENTERO de Odysseus,
# no solo axon. NO es un descuido ni una regresión a "optimizar" dentro de tres meses: es el punto.
set -euo pipefail
cd "$(dirname "$0")"   # el project dir del compose ES este directorio (las rutas relativas dependen de él)

AXON_REPO="${AXON_REPO:-$HOME/code/axon}"
CON_AXON=1; CON_OLLAMA=1; SOLO_CONFIG=0; PUBLICAR=1
for a in "$@"; do
  case "$a" in
    --config)        SOLO_CONFIG=1 ;;
    --sin-axon)      CON_AXON=0 ;;
    --sin-ollama)    CON_OLLAMA=0 ;;
    --sin-publicar)  PUBLICAR=0 ;;
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
  # El repo de axon solo hace falta para PUBLICAR. Con `--sin-publicar` (el modo CD) la imagen ya viene
  # construida de otra máquina: exigir un clon aquí sería exigir algo que el flujo no usa.
  if [ "$PUBLICAR" = 1 ]; then
    [ -d "$AXON_REPO/.git" ] || fatal "no encuentro el repo de axon en $AXON_REPO (override: AXON_REPO=…)"
    [ -x "$AXON_REPO/scripts/publish-axon.sh" ] || fatal "falta $AXON_REPO/scripts/publish-axon.sh"
  else
    # Sin publicar, el tag es la ÚNICA forma de saber qué se va a servir. `latest` es móvil y no prueba
    # nada; vacío haría que el compose cayera a `latest` en silencio — justo el drift invisible que este
    # stack existe para matar. Se exige explícito.
    [ "$SOLO_CONFIG" = 1 ] || [ -n "${AXON_IMAGE_TAG:-}" ] || fatal "--sin-publicar exige AXON_IMAGE_TAG=<sha-corto>
   (el tag que ya publicó quien buildeó la imagen). Sin él no puedo decir QUÉ commit va a servir el stack.
   Se exige solo cuando se va a DESPLEGAR de verdad: con --config no se levanta nada."
  fi
  for f in "${AXON_TLS_CERT:-$HOME/.ssl/pisa.mx.fullchain.crt}" "${AXON_TLS_KEY:-$HOME/.ssl/pisa.mx.key}"; do
    [ -r "$f" ] || fatal "no puedo leer el cert TLS $f (axon sirve HTTPS nativo en :7001)"
  done
  # El contenedor viejo `axon-maincar` (del `docker run` suelto de antes) NO es parte del proyecto: si
  # sigue existiendo, es exactamente la pieza fuera del stack que estamos eliminando. Parado es solo
  # basura (aviso); CORRIENDO tiene :7001 tomado y el `up` de abajo va a morir con un
  # "failed to bind host port 0.0.0.0:7001: address already in use" que no explica nada — así que ahí
  # se para en seco y se dice qué borrar. Es el fallo exacto que tumbó 4 corridas del CD (2026-09-07).
  if docker ps --format '{{.Names}}' | grep -qx axon-maincar; then
    [ "$SOLO_CONFIG" = 1 ] || fatal "el contenedor VIEJO 'axon-maincar' (del \`docker run\` suelto, fuera
   del stack) está CORRIENDO y ocupa :7001. El servicio \`axon\` de este stack no puede publicar ese
   puerto mientras exista. Bórralo:  docker rm -f axon-maincar"
  elif docker ps -a --format '{{.Names}}' | grep -qx axon-maincar; then
    aviso "existe (parado) el contenedor VIEJO 'axon-maincar', fuera del stack. Bórralo:  docker rm -f axon-maincar"
  fi
  # El main car nativo y el del stack pelean por :7001.
  if [ "$SOLO_CONFIG" = 0 ] && systemctl --user is-active --quiet axon-maincar.service 2>/dev/null; then
    fatal "axon-maincar.service (NATIVO) está corriendo y ocupa :7001. Retíralo:
     systemctl --user disable --now axon-maincar.service"
  fi
fi

# Estos dos chequeos son sobre el ARRANQUE del contenedor de ollama, y desde que se eliminó `--solo-axon`
# aplican SIEMPRE que el overlay de ollama esté en el `-f` — también en el CD, que ya no tiene un modo
# que se los salte. Es la consecuencia directa de "se levanta TODO, siempre": si el Ollama NATIVO tiene
# tomado :11434, el despliegue PARA con el comando exacto en vez de dejar medio stack en pie. Antes esta
# condición se le perdonaba al CD para que un push de código no provisionara infraestructura; hoy la
# decisión es la contraria — el push RECONSTRUYE el stack — así que el preflight tiene que valer para
# todos. El escape sigue siendo del operador, explícito:  ./levantar-stack.sh --sin-ollama
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
# `--sin-publicar` SALTA este paso entero. No es un atajo de comodidad: en el CD la imagen ya la
# construyó y publicó el job de cloud a partir del commit que se acaba de mergear, y volver a buildear
# aquí (a) duplica minutos de build en la máquina que además sirve el stack, y (b) construiría desde el
# `origin/develop` de ESTE host, que puede no estar fetcheado y ser OTRO commit que el que disparó el
# despliegue. El tag que nos dan es la prueba de qué se pidió desplegar; se respeta tal cual.
if [ "$CON_AXON" = 1 ] && [ "$PUBLICAR" = 1 ]; then
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
elif [ "$CON_AXON" = 1 ]; then
  export AXON_IMAGE_TAG
  echo "═══ 1/2 · publicación OMITIDA (--sin-publicar): se consume ${AXON_IMAGE:-potenciaindustrial/axon}:${AXON_IMAGE_TAG} ═══"
  # `pull_policy: missing` (docker/axon.yml): si el tag ya está en este dockerd se usa tal cual; si no,
  # compose lo baja del registry. O sea que esta ruta funciona igual con una imagen construida aquí que
  # con una publicada por el CD desde otra máquina.
fi

# ── 2/2 · el stack ──────────────────────────────────────────────────────────────────────────────────
# SIN --remove-orphans, JAMÁS por reflejo: hoy `tts` viene de docker/gpu.tts.yml (ya en el -f de arriba),
# pero cualquier servicio que alguien haya creado desde otro directorio moriría sin aviso. Si de verdad
# quieres podar, mira primero `docker ps -a --filter label=com.docker.compose.project=odysseus`.
# SIEMPRE el stack COMPLETO, con `--build`. No hay un modo que toque un solo servicio: `--build` sobre
# los servicios que tienen `build:` (odysseus) y la imagen ya publicada para los que no (axon, que a
# propósito no tiene `build:`), y compose recrea únicamente lo que cambió. El costo de reconstruir lo
# que no cambió son segundos de caché; el de desplegar una pieza sobre un stack rancio ya costó una
# tarde de QA sobre código viejo.
echo "═══ 2/2 · up del stack COMPLETO (proyecto 'odysseus') ═══"
docker compose "${FILES[@]}" -p odysseus up -d --build

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
#
# Se corren SIEMPRE, también en el CD. Antes se saltaban cuando el despliegue solo tocaba a axon, con el
# argumento de que eran smokes de servicios ajenos; con el stack recreándose entero en cada corrida ya no
# hay tal cosa como un servicio "que no se tocó" — y un tts que arrancó pero no sintetiza es exactamente
# el fallo que este reporte existe para cazar, venga el despliegue de donde venga.
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
  # CONTRA QUÉ SE COMPARA: contra el TAG que acabamos de desplegar, no contra el `origin/develop` de
  # este host. En el modo normal son el MISMO valor por construcción (publish-axon.sh buildea de
  # origin/develop y su sha ES el tag), así que no se pierde nada; y en `--sin-publicar` el
  # `origin/develop` local puede estar sin fetchear y ser otro commit — comparar contra él reportaría un
  # DRIFT falso en cada corrida del CD. Además esta comparación caza algo que la otra no: que el
  # contenedor de verdad se RECREÓ con la imagen nueva (si siguiera el viejo, el tag no coincide).
  # `commit_corto` son 7 chars (build-info.ts: `slice(0,7)`); el tag puede venir de 7 o del sha completo.
  esperado="${AXON_IMAGE_TAG:-}"; esperado="${esperado:0:7}"
  if [ -z "$sirviendo" ]; then
    echo "❌ axon     · no pude leer /api/axon/version (¿TLS? ¿todavía arrancando?)"
    malos=$((malos+1))
  elif [ "${AXON_IMAGE_TAG:-latest}" = "latest" ]; then
    # `:latest` es MÓVIL: no prueba nada. Se dice en voz alta en vez de pintar un ✅ que no significa.
    echo "➖ axon     · sirviendo ${sirviendo}, pero el tag desplegado es ':latest' (móvil): esta corrida"
    echo "             NO puede probar qué commit quedó. Usa un tag = sha (lo hace este script solo)."
  elif [ "$sirviendo" = "$esperado" ]; then
    echo "✅ axon     · sirviendo ${sirviendo} = el tag desplegado (${AXON_IMAGE_TAG}). Sin drift."
  else
    echo "❌ axon     · DRIFT: sirviendo ${sirviendo}, se desplegó ${AXON_IMAGE_TAG}. El contenedor no"
    echo "             tomó la imagen nueva → docker compose -p odysseus logs axon"
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

# ── EXIT CODE: UNA sola semántica para los dos lectores — si algún servicio no llegó a sano (o axon no
#    sirve el commit que se desplegó), el script sale ≠0.
#    Antes había dos: `exit 0` siempre en modo interactivo (para no "agregarle ruido" al humano que ya
#    está leyendo la tabla) y `exit 1` solo en el modo CD. Con `--solo-axon` fuera, el script ya no sabe
#    quién lo invoca, así que tener dos semánticas exigiría re-inventar una bandera de "soy el CD" — el
#    mismo atajo que se acaba de eliminar, y por el mismo motivo: multiplica los modos de fallar.
#    Y no hace falta: el ≠0 le sirve al CD, que necesita ponerse rojo cuando el despliegue no quedó (un
#    job VERDE sobre un despliegue a medias es el drift invisible con un ✅ encima), y no le estorba al
#    humano, que ve la MISMA tabla de siempre — la salida en pantalla no cambia ni una línea. Al
#    contrario: un `./levantar-stack.sh && algo` ahora se detiene cuando el stack no quedó, en vez de
#    encadenar sobre un despliegue enfermo.
if [ "$malos" -gt 0 ]; then
  echo "   (saliendo con código 1: el stack NO quedó verde)"
  exit 1
fi
