# Stack unificado: Odysseus + axon + Ollama en un solo `docker compose` (#26g)

> **Regla:** el stack se levanta y se actualiza con **`./levantar-stack.sh`**. No con un `docker compose up`
> a mano — el `-f` correcto son cuatro archivos y la imagen de axon tiene que salir de `origin/develop`.

## Por qué existe esto

No es comodidad. Es el antídoto a un drift **medido**:

- **2026-09-07** — se mergearon 12 PRs a `develop` y el axon en vivo seguía **12 commits atrás**. El gate
  de entregabilidad, el router por rol y el fix de input-stripping estaban integrados y **no corriendo**,
  sin que nada lo señalara.
- La misma facilidad de "tocar en caliente" hizo que el frontend de la terminal se parcheara con
  `docker cp` **4 veces en un día** → drift que hubo que rescatar a mano.

El contenedor no es empaquetado bonito: es el **mecanismo que hace imposible el atajo**. Y el mismo
principio se extiende a todo lo que corría nativo: **lo que vive fuera del stack, driftea.**

## Qué hay en el stack (proyecto de compose `odysseus`)

| servicio | qué es | de dónde sale |
|---|---|---|
| `odysseus` | la app | `build:` del repo (este fork) |
| `searxng` `chromadb` `ntfy` | plomería de Odysseus | imágenes upstream |
| `tts` | sidecar Kokoro (read-aloud) | `docker/gpu.tts.yml` |
| `ollama` | motor de inferencia | `docker/ollama.yml` — **antes nativo** |
| `axon` | main car (puerta + cerebro) | `docker/axon.yml` — **antes nativo** |

Los archivos del `-f`: `docker-compose.gpu-nvidia.yml` + `docker/gpu.tts.yml` + `docker/ollama.yml` +
`docker/axon.yml` + `docker/axon.ollama.yml` (este último SOLO cuando axon y ollama están los dos —
lleva únicamente la arista `axon depends_on ollama`; el porqué está en § Orden de arranque). Siempre con
`-p odysseus` (el nombre del proyecto es lo que ata los volúmenes `odysseus_*` existentes: cambiarlo
estrenaría volúmenes vacíos).

## El candado anti-drift: axon **dice qué commit sirve**

1. `axon/scripts/publish-axon.sh` (la herramienta oficial de release) buildea desde **`origin/develop`**
   vía un worktree temporal limpio — no desde el árbol de trabajo, que suele estar en otra rama y sucio.
2. Ese build **hornea el commit** en la imagen (`--build-arg AXON_BUILD_COMMIT/REF/TIME` → `ENV`).
3. El servicio `axon` **no tiene `build:`** a propósito: consume la imagen ya construida, con el **sha
   corto de develop como tag**. La única forma de cambiar lo que sirve es publicar una imagen nueva.
4. En runtime, axon lo reporta por dos vías: el **banner de arranque** (`docker logs`) y
   **`GET /api/axon/version`** (sin auth, sin tocar el modelo — también es su healthcheck).

Chequeo de drift, en una línea:

```bash
curl -sk https://127.0.0.1:7001/api/axon/version          # lo que CORRE
git -C ~/code/axon rev-parse --short origin/develop        # lo que está INTEGRADO
```

Si difieren, `./levantar-stack.sh` los iguala. Antes de esto, esa pregunta no tenía respuesta.

## El CD de axon entra **por este script**, no por un contenedor suelto

El repo de axon tiene un CD (`axon/.github/workflows/deploy-axon.yml`) que dispara en cada push a
`develop`: un job en runner cloud buildea y publica la imagen en Docker Hub, y un segundo job, en el
runner self-hosted de la Cachy, actualiza lo que corre aquí.

**Lo que hacía antes** (y por qué se cambió): ese segundo job corría `axon/scripts/run-maincar-docker.sh`,
un `docker run -d --name axon-maincar -p 7001:7001 --network odysseus_default …`. Un contenedor **fuera
del proyecto de compose**: no sale en `docker compose ps`, no lo recrea `levantar-stack.sh`, y **pelea
por `:7001`** con el servicio `axon` de este stack. En cuanto el stack unificado entró a `develop`, los
dos no podían coexistir — y el job murió cuatro corridas seguidas con
`failed to bind host port 0.0.0.0:7001/tcp: address already in use`, exit 125.

**Lo que hace ahora:** el job llama a `axon/scripts/deploy-al-stack.sh`, que es un envoltorio delgado
sobre **este** script:

```bash
AXON_IMAGE_TAG=<sha-corto> ./levantar-stack.sh --sin-publicar
```

La única bandera que usa el CD, y por qué existe:

| bandera | qué hace | por qué |
|---|---|---|
| `--sin-publicar` | salta el paso 1/2 (`publish-axon.sh`) y consume el `AXON_IMAGE_TAG` que le den | el job de cloud **ya** buildeó esa imagen desde el commit que disparó el deploy. Re-buildear aquí duplicaría minutos en la máquina que además sirve el stack y —peor— construiría desde el `origin/develop` de *este* host, que puede no estar fetcheado y ser **otro commit** |

Sin `--sin-publicar`, `AXON_IMAGE_TAG` se sigue calculando como siempre (el sha corto de `origin/develop`
que deja `publish-axon.sh`): **el uso manual de `./levantar-stack.sh` no cambia en nada.**

### El CD levanta el stack COMPLETO — ya no hay un modo que toque solo a axon

Hubo una segunda bandera, `--solo-axon` (`up -d --no-deps axon` sobre un stack ya arriba), con su propio
preflight —que exigía el stack en pie y si no, paraba diciendo qué correr—, su reporte acotado a un
servicio y su exit code propio. **Se eliminó el 2026-09-07**, por decisión explícita de unjordi:

> *"nel, quítalo. el cómputo local es gratis. prefiero que SIEMPRE recompile todo y lo vuelva a levantar,
> así también te cacho con mal manejo de ramas"*

El argumento viejo era que un push de código no debe provisionar infraestructura a espaldas del operador
(arrancar Ollama con 34 GB de pesos, masquear el `ollama.service` nativo, liberar `:11434`). El argumento
que gana es que **un despliegue parcial es justamente donde se esconde el drift**: deja al resto del stack
sirviendo lo de anteayer sin que nada lo diga, y encima tapa el mal manejo de ramas —si el `develop` del
fork trae algo que ni compila, un CD que no reconstruye Odysseus jamás se entera—. Es la misma dirección
en la que murió `--sin-build` el mismo día, después de que un QA entero se hiciera sobre una imagen rancia.
El cómputo local no se cobra; una tarde de QA sobre código viejo, sí.

**Consecuencia querida y explícita: un push a `develop` de axon reconstruye el stack ENTERO de Odysseus**,
no solo el servicio `axon`. No es un descuido ni algo que "optimizar" de vuelta dentro de tres meses.

De ahí se siguen dos cosas que antes se le perdonaban al modo CD y ahora aplican a todos:

- **Los preflight de Ollama valen siempre.** Si el `ollama.service` NATIVO tiene tomado `:11434`, el
  despliegue **para** con el comando exacto (`pkexec systemctl mask --now ollama.service`) en vez de dejar
  medio stack en pie. El escape sigue siendo del operador y explícito: `./levantar-stack.sh --sin-ollama`.
- **Los dos smokes caros (síntesis real del TTS, búsqueda JSON real de SearXNG) se corren siempre.** Con el
  stack recreándose entero ya no existe un servicio "que no se tocó".

### Dos cosas más que cambiaron en el reporte

- **El chequeo de drift compara contra el tag desplegado**, no contra el `origin/develop` de este host.
  En modo normal son el mismo valor por construcción, así que no se pierde nada; en modo CD el
  `origin/develop` local puede estar sin fetchear y reportaría un **drift falso** en cada corrida. De
  paso, comparar contra el tag caza algo que la otra comparación no: que el contenedor **de verdad se
  recreó** con la imagen nueva.
- **El script sale con código ≠ 0 si algún servicio no quedó verde — una sola semántica, para los dos
  lectores.** Hubo dos: `exit 0` siempre en modo interactivo (para no agregarle ruido al humano que está
  leyendo la tabla) y `exit 1` solo en el modo CD. Sin `--solo-axon` el script ya no sabe quién lo invoca,
  y tener dos semánticas exigiría re-inventar una bandera de "soy el CD" — el mismo atajo que se acaba de
  eliminar. Tampoco hace falta: el ≠0 le sirve a GitHub Actions, que necesita ponerse **rojo** cuando el
  despliegue no quedó (un job verde sobre un stack a medias es el drift invisible con un ✅ encima), y no
  le estorba al humano, que ve la MISMA tabla de siempre — la salida en pantalla no cambia ni una línea.
  De pilón, un `./levantar-stack.sh && algo` ahora se detiene en vez de encadenar sobre un stack enfermo.

### El contenedor viejo `axon-maincar` ahora **para** el despliegue

El preflight ya avisaba de él; ahora distingue: **parado** es basura (aviso), **corriendo** es un fatal
con el comando exacto (`docker rm -f axon-maincar`). Es el fallo que tumbó las cuatro corridas del CD, y
el error crudo de Docker (`address already in use`) no dice ni qué lo ocupa ni qué borrar.

## Red: quién alcanza a quién

- **axon → Odysseus:** `http://odysseus:7000`, por la red interna del proyecto. **Es la única vía**:
  Odysseus publica su puerto solo en `127.0.0.1` del host, así que `host.docker.internal` **no** lo
  alcanza. Estar en el mismo proyecto de compose es lo que la da gratis (antes se resolvía uniendo un
  `docker run` a `--network odysseus_default` y apuntando al nombre de contenedor).
- **axon → Ollama:** `AXON_OLLAMA_URL=http://ollama:11434` (API nativa, sin sufijo).
- **Odysseus → Ollama:** `OLLAMA_BASE_URL=http://ollama:11434/v1` (API OpenAI-compat — **el `/v1` importa**;
  son dos contratos distintos contra el mismo motor).
- **axon → host** (FreeToken `:7090`, y el Ollama nativo si se corre sin el overlay):
  `host.docker.internal:host-gateway`. Funciona porque **esos bindean `0.0.0.0`**.
- **axon → broker de terminal:** **socket unix**,
  `AXON_TERM_BROKER_URL=unix:/run/axon-term/term-broker.sock` (el volumen se monta por DIRECTORIO, no por
  archivo). **No** va por `host.docker.internal:8799` — corregido el 2026-09-07: en Linux `host-gateway`
  resuelve a la IP del host en `docker0` (172.17.0.1), no a loopback, y el broker bindea loopback ⇒ nunca
  fue alcanzable (timeout en cada comando; FreeToken sí funcionaba, y esa fue la contraprueba). Tampoco se
  resolvió abriendo el puerto: el broker ejecuta **comandos arbitrarios como el usuario**, sin whitelist.
  Detalle: `axon/docs/terminal.md` § "Cómo alcanza el maincar CONTENERIZADO al broker del host".
- El puerto **11434 se sigue publicando en el host** con el mismo bind `0.0.0.0` → todo lo que hoy habla
  con `localhost:11434` (el CLI `ollama`, axon nativo, scripts sueltos) sigue funcionando sin cambios.

## Orden de arranque y salud: qué significa **listo** para cada quien

> Un `docker compose up -d` vuelve cuando los contenedores están **creados**, no cuando los servicios
> **sirven**. Todo lo de esta sección existe para cerrar esa brecha: que el stack levante en orden, que
> cada servicio declare su propia condición de estar listo, y que `levantar-stack.sh` lo **diga** en vez
> de dejarte haciendo `docker ps`.

La regla que gobierna todo lo de abajo: **`healthy` significa algo distinto en cada servicio.** No hay un
`curl -f /` repetido siete veces. Tres de los siete tienen un modo de fallo en el que el contenedor está
perfectamente arriba y el servicio no sirve — y el healthcheck de cada uno está escrito para esos casos.

### La tabla: qué comprueba cada uno y por qué

| servicio | "listo" significa | comando | por qué ESE y no otro |
|---|---|---|---|
| `odysseus` | **uvicorn acepta requests** | `curl -fsS /api/health` | `GET /` da **302** al login (verificado) → exigir 200 lo dejaría enfermo para siempre. `/api/health` está en `AUTH_EXEMPT_EXACT` (app.py) → 200 sin sesión, y solo devuelve un dict con timestamp: cero I/O |
| `axon` | **el server responde y dice qué commit sirve** | `GET https://…:7001/api/axon/version` | sin auth a propósito (el handler lo dice: "es el endpoint que consulta el HEALTHCHECK"), va antes del proxy, no toca el modelo. **`https`, no `http`** — ver abajo |
| `ollama` | **VE los modelos** | `ollama list \| tail -n +2 \| grep -q .` | `ollama list` a secas sale con 0 **aunque la lista esté vacía** — y la lista vacía (si `OLLAMA_MODELS` no toma) es el fallo real: un stack roto que parece sano |
| `searxng` | **arrancó y parseó su `settings.yml`** | `GET /` (sin cambios) | su fallo documentado es *crashear al boot* (`KeyError: 'default_doi_resolver'`, tag 2026.6.2). Ya estaba bien tuneado; no se toca por tocarlo |
| `chromadb` | **su heartbeat contesta** | `bash -c` + `/dev/tcp` → `/api/v2/heartbeat` | la imagen **no trae curl, wget, nc ni python** (verificado adentro): solo bash. Y `/dev/tcp` es de **bash**, no de sh — el `sh` de esa imagen es dash y falla → por eso `["CMD","bash",…]`, nunca `CMD-SHELL` |
| `ntfy` | **su `/v1/health` dice `healthy:true`** | `wget … \| grep -q '"healthy":true'` | se comprueba el **contenido**, no el 200: ntfy responde 200 a rutas que no prueban nada. Imagen busybox → wget, no curl |
| `tts` | **el paquete de voces cargó** | `GET /v1/audio/voices` **y la lista no vacía** | `/health` solo dice que FastAPI contesta; un Kokoro sin voces es un TTS mudo que se ve sano. 785 B, 13 ms, sin síntesis |

**Los tres "arriba pero inútil"** que estos healthchecks atrapan y un `curl /` no: Ollama con **0 modelos**,
Kokoro **sin voces**, y ntfy respondiendo 200 **sin estar sano**.

### El bug que esto destapó: el healthcheck de axon nunca habría pasado

El `command:` de `docker/axon.yml` pasa `--tls-cert/--tls-key`. Con TLS, `createChatServer` devuelve un
`createHttpsServer` **en lugar del** `http.createServer` (`src/server/http-server.ts:1229-1245`): hay **un
solo listener** en `:7001` y habla TLS. El healthcheck que había hacía un `GET` en **http plano** contra él
→ jamás 200 → `unhealthy` **para siempre**. No lo delataba nadie porque, con el grafo anterior, nada
dependía de axon.

Corregido a `https` con `rejectUnauthorized:false` — que aquí no afloja nada: el cert es el wildcard
`*.pisa.mx` y el probe pega a `127.0.0.1`, así que la validación fallaría por el **nombre**, no por
confianza; es un probe local contra el propio proceso, dentro del contenedor.

> **Regla que queda escrita en el archivo:** el `--tls-cert/--tls-key` del `command:` y el esquema del
> `test:` son **la misma decisión**. Si un día se quita el TLS, se cambia `https` por `http` ahí mismo.

### El grafo de dependencias, arista por arista

```
  searxng ──(healthy)──┐
                       ├──▶  odysseus ──(healthy)──┐
  chromadb ─(started)──┤                           ├──▶  axon
                       │                           │
  ollama ───(started)──┘        ollama ──(healthy)─┘

  tts   ·  ntfy   →  SIN aristas (nadie los espera, nadie se cae por ellos)
```

| arista | condición | por qué |
|---|---|---|
| `odysseus` → `searxng` | **healthy** | *(pre-existente, se conserva)* la búsqueda es de primera clase y searxng tiene un fallo de *crash al boot*; "arriba" no lo distingue de "sirviendo". Precio aceptado y deliberado: un searxng que no sana bloquea la app |
| `odysseus` → `chromadb` | **started** | tentador subirlo a `healthy` ahora que chromadb tiene healthcheck, y sería un **`depends_on` de más**: `src/rag_singleton.py` es lazy **con reintento** → la carrera **se cura sola**. `healthy` cambiaría un degradado temporal por un SPOF (chroma enfermo ⇒ ni correo ni tareas ni galería) |
| `odysseus` → `ollama` | **started** *(bajado de `healthy`)* | Odysseus consulta Ollama **perezosamente, por request**; no hay one-shot de arranque que perder. Sus propios logs muestran el degradado limpio (`Failed to probe …: Connection refused` y sigue arrancando). `healthy` habría hecho del motor de inferencia un SPOF de **toda** la app |
| `axon` → `odysseus` | **healthy** *(subido de `started`)* | el impedimento de antes ("odysseus no tiene healthcheck") **ya no existe**. axon es la **puerta**: todo lo que no es `/api/chat_stream` se proxea. Arrancar antes ⇒ el primer page-load da **502**. Cuesta ~4 s medidos, una vez |
| `axon` → `ollama` | **healthy** | `docker/axon.yml` **pinea** `--model qwen3.8:27b`, y con `--model` explícito `buildSession` pone `hasLocal = true` **sin preguntarle a Ollama** → sin el gate, axon arranca anunciando un cerebro que quizá no está, y el fallo aparece en el primer chat del usuario, no en el `up` |
| `tts`, `ntfy` | **ninguna** | son opcionales de verdad. Un `depends_on` aquí convertiría "no hay read-aloud" en "el stack no levanta". Su healthcheck existe para que `docker compose ps` diga la verdad, no para bloquear a nadie |

**Dónde vive la arista `axon → ollama`, y por qué importa.** En su propio archivo,
**`docker/axon.ollama.yml`**. `levantar-stack.sh` tiene dos interruptores independientes (`--sin-axon`,
`--sin-ollama`) ⇒ cuatro combinaciones, y un `depends_on` entre dos servicios opcionales no puede vivir en
el overlay de ninguno de los dos: en `axon.yml` deja un `depends_on` a un servicio inexistente con
`--sin-ollama`; en `ollama.yml` deja un `axon:` sin `image:` ni `build:` con `--sin-axon` →
*"service axon has neither an image nor a build context specified"*. **Comprobado con `docker compose
config`, no supuesto.** En su tercer archivo, la arista aparece exactamente cuando existen sus dos
extremos, y **las cuatro combinaciones validan**.

### `start_period`: de dónde sale cada número

`start_period` es la perilla que evita marcar enfermo a un servicio que **todavía está naciendo**. Vale la
pena entender su mecánica antes de discutir cifras: durante el `start_period` los fallos **no cuentan**
contra `retries`, y el **primer probe exitoso lo termina de inmediato y marca `healthy`**. ⇒ **un
`start_period` generoso no cuesta nada cuando el arranque es rápido.** Por eso el criterio no es "el
promedio", es *"¿cuánto puede tardar un arranque lento pero NORMAL?"*.

| servicio | valor | de dónde |
|---|---|---|
| `odysseus` | **60 s** | **MEDIDO**: contenedor `18:50:22.709` → `Uvicorn running on http://0.0.0.0:7000` `18:50:26.202` = **3.5 s** en caliente. Los 60 s cubren el arranque **frío** (imagen recién construida, page cache vacío, FastEmbed, round-trips a chromadb) |
| `tts` | **90 s** *(sin cambio)* | el **primer** boot descarga ~330 MB de pesos desde HuggingFace. Después el volumen `tts_models` los tiene y es lectura local. El contenedor vivo está `healthy` con esta misma cifra |
| `axon` | **45 s** *(de 20)* | antes de `server.listen`, `buildSession` consulta capacidades por HTTP contra Ollama, abre la SQLite de Odysseus y lee cert+key. 20 s dejaba poco aire para eso más un arranque frío de Node. **No medido** |
| `ollama` | **40 s** *(de 20)* | el nativo contesta `/api/tags` en **5 ms**, pero es un daemon caliente. El contenedor paga init del runtime CUDA sobre **dos** GPUs (`count: all`) y el primer recorrido de manifests de un store de 34 GB. **No medido en contenedor** |
| `chromadb` | **30 s** | **no medido** (no se reinició nada). Chroma arranca en segundos; 30 s es margen honesto para un cold start con el sqlite poblado |
| `ntfy` | **10 s** | binario Go que sirve casi de inmediato, y no gatea a nadie |
| `searxng` | **10 s** *(sin cambio)* | ya estaba tuneado para su fallo de boot (`retries: 20` a 5 s = 100 s de gracia). No se toca |

**`interval`, con el mismo criterio.** No es "cada cuánto molesto", es *"¿cuánta latencia de detección me
cuesta?"*. Los que **gatean** a alguien (`searxng`, `chromadb`, `ollama`, `odysseus`) van a **5 s**: cada
segundo de detección es un segundo de arranque del stack, y sus probes cuestan milisegundos. Los que **no
gatean a nadie** (`axon`, `tts`, `ntfy`) van a **30 s**: su salud es informativa.

### Ningún healthcheck cuesta caro — y qué se hace con lo que sí

Un healthcheck corre **cada `interval`, para siempre**. Ninguno de los siete carga un modelo, hace
inferencia ni escribe:

- `ollama list` pega a `GET /api/tags` (leer manifests). **Medido: 5 ms**, y `GET /api/ps` sigue en
  `{"models":[]}` después ⇒ no calienta ni desaloja nada.
- `tts` lista voces (785 B) en vez de sintetizar.
- `odysseus` usa `/api/health`, que devuelve un dict con un timestamp.
- `chromadb` abre un socket y lee la primera línea.

**Los dos chequeos que sí son caros no desaparecen: se hacen UNA vez**, al final de `levantar-stack.sh`,
que es el lugar correcto para un chequeo caro — una vez por despliegue, no cada 30 segundos:

1. **TTS — síntesis real** de una palabra. Es lo **único** que distingue un Kokoro sano de uno que arrancó,
   lista sus voces y **revienta en cada inferencia**: el fallo de Blackwell (`sm_120`, *"no kernel image is
   available"*) que documenta `docker/gpu.tts.yml`. **El healthcheck no puede probar eso** — con la imagen
   GPU en una GPU no soportada, `/health` y `/v1/audio/voices` pueden seguir contestando 200 mientras cada
   síntesis falla. Aquí sí se prueba, y si falla el script dice exactamente cómo volver a la imagen CPU.
2. **searxng — una búsqueda JSON real**. Su healthcheck prueba que arrancó y parseó `settings.yml`, pero no
   que devuelve **JSON**, que es la única forma en que Odysseus lo consume. No puede ir en el healthcheck:
   cada consulta sale a los motores upstream de verdad. *(Se evaluó `GET /config` como alternativa barata y
   **no sirve**: verificado en vivo, no expone la clave `formats` — y son 98 KB.)*

### `levantar-stack.sh` ahora reporta

Al terminar el `up`, el script **espera** a que nadie siga en `starting` (tope `ESPERA_MAX`, 180 s por
defecto, derivado del `start_period` mayor) y luego imprime una tabla `servicio · salud · qué significa /
dónde mirar`, con el comando de logs ya escrito para el que esté mal. Después corre las dos verificaciones
de una sola vez de arriba y el **chequeo de drift** (`/api/axon/version` contra el **tag desplegado**,
no contra el `origin/develop` de este host — ver arriba). Si algo quedó en rojo lo dice, **no** declara
nada listo y **sale con código ≠ 0**.

Un servicio **sin** healthcheck declarado se reporta como `➖ corriendo, SIN healthcheck` — no se disfraza
de sano. Hoy no debería salir ninguno (los siete tienen el suyo); si aparece uno, es que se agregó un
servicio y se olvidó su healthcheck.

## Ollama: los pesos **no** se re-descargan

El store nativo (`/var/lib/ollama-models`, 34 GB, f2fs) se **monta en su sitio** con `OLLAMA_MODELS=/models`.
El layout `blobs/` + `manifests/` es el mismo que la imagen oficial espera: es el mismo binario
`ollama serve`, empaquetado. Cero copia, cero migración.

- **El pin en RAM sobrevive.** `ollama-ram-pin.service` hace `mlock` sobre los blobs (~18 GB). El pin es
  sobre el **page cache de esos inodos**, no sobre el proceso que los lee: un bind-mount es el mismo
  inodo, así que el contenedor lee páginas ya pinneadas. El servicio se queda en el host tal cual.
- **Se MASCARA, no se deshabilita.** `ollama-ram-pin.service` declara `Wants=ollama.service`, y un
  `Wants=` puede re-arrancar una unidad meramente deshabilitada → volvería el conflicto por `:11434`.
  ```bash
  pkexec systemctl mask --now ollama.service
  ```
- **Es reversible.** Se desmasca y el daemon nativo vuelve a leer los mismos archivos. Único detalle: los
  blobs nuevos que baje el contenedor quedan `root:root`; para revertir del todo,
  `pkexec chown -R ollama:ollama /var/lib/ollama-models` una vez.

## La terminal del widget: el broker se queda en el HOST — y es de **cortex**

`axon-term-broker.service` da una terminal **de la computadora**: `zsh` real, como `unjordi`, con su
entorno, sus claves y sus repos. Dentro de un contenedor daría el shell **del contenedor** — otra cosa, y
menos útil. Las tres opciones y su precio:

| opción | qué pasa | precio |
|---|---|---|
| **A. broker en el host (elegida)** | axon del contenedor le reenvía por **socket unix** con token (antes se documentó `host.docker.internal:8799`, que en Linux nunca funcionó — ver abajo) | queda una pieza nativa — **resuelto**: no es de axon, es de `cortex` (abajo) |
| **B. broker dentro del contenedor** | shell del contenedor | **rompe la terminal en uso**: sin las herramientas del host, sin `~/code`, sin credenciales |
| **C. contenedor con acceso al host** (`--pid=host`, `/` montado, docker.sock) | terminal "casi" del host | el contenedor deja de ser un límite: cualquier bug de axon es root en la máquina. **No** |

Se implementó **A** — y la pregunta de "¿y entonces queda una pieza nativa suelta?" tiene respuesta:
esa pieza **tiene dueño, y no es axon** (ver abajo). El compose pasa `AXON_TERM_BROKER_URL`/`_TOKEN`;
**sin token, axon degrada solo** al shell del contenedor, sin fallar. La terminal en uso **no se toca**.

### El broker es una pieza de **cortex**, no una excepción de axon (resuelto 2026-09-07)

La opción A dejaba una incomodidad: *"queda UNA pieza nativa y hay que decirlo en voz alta"*. La salida no
era ninguna de las tres — era **de quién es el broker**. Un shell de la máquina anfitriona no es una pieza
del harness: es **infraestructura per-máquina**. Y quien ya gestiona la infraestructura per-máquina de esta
compu (hooks globales, servicios de usuario, config que no viaja por el git de un proyecto) es **cortex**
(`~/code/cortex`). Deja de ser "la excepción incómoda del stack de axon" y pasa a ser **un servicio de
cortex** con su propio dueño, que es su naturaleza real.

**Contrato, ya limpio:** axon-en-contenedor es un **cliente**. Habla por el **socket unix** del broker
(`AXON_TERM_BROKER_URL=unix:/run/axon-term/term-broker.sock` + `AXON_TERM_BROKER_TOKEN`) y **degrada solo**
al shell del contenedor si el token no está. axon no instala, no arranca y no es dueño del broker.

> **Corrección del 2026-09-07 (esto decía `host.docker.internal:8799` y la terminal estaba muerta).** Dos
> cosas que este documento afirmaba y no eran ciertas:
> 1. **El transporte.** En Linux `host-gateway` resuelve a la IP del host en `docker0` (172.17.0.1), no a
>    loopback; el broker bindeaba `127.0.0.1` ⇒ timeout en cada comando. Bindear a la gateway tampoco
>    alcanza: `ufw` está activo y descarta el tráfico contenedor→host. Y abrir el puerto sería exponer
>    ejecución de comandos arbitrarios como el usuario. El transporte real es un **socket unix**, montado
>    como volumen **por directorio** (un bind-mount de archivo se ata al inodo y muere al reiniciar el
>    broker). Requiere una línea de `volumes:` — o sea que **sí cambia el compose**, contra lo que decía
>    la frase anterior ("nada del compose cambia").
> 2. **La degradación.** "Degrada solo al shell del contenedor" vale **sin token** (el usuario nunca pidió
>    modo host). **Con** token y broker caído NO degrada: falla explícito, y el badge del widget lo dice
>    (`host-down`). Caer al contenedor ahí sería correr los comandos en **otra máquina** en silencio.
>
> El porqué completo, con las mediciones: `axon/docs/terminal.md` § "Cómo alcanza el maincar CONTENERIZADO
> al broker del host".

**¿Cabe en cortex? Sí, y el patrón ya existe** (verificado leyendo `~/code/cortex`):

| lo que el broker necesita | lo que cortex ya hace |
|---|---|
| unidad systemd de usuario | `src/systemd/*.service` → `install.sh` los instala en `~/.config/systemd/user/` (`install -D -m 0644`, `daemon-reload`, `enable --now`), y `uninstall.sh` los retira |
| un ejecutable en el PATH | `bin/*.js` → `~/.local/bin/` con `install -D -m 0755` (ya hay ejecutables de Node ahí: `chats-extract.js`, `session-*.js`) |
| **un secreto per-máquina (el token)** | **ya existe la convención**: `EnvironmentFile=-%h/.config/cortex/limits.env`, sembrado por el instalador si falta. El token del broker es exactamente ese tipo de archivo |
| instalación opcional | `install.sh` ya tiene banderas de este tipo (`--no-plasmoid`, `--no-ccusage`) |

Y el traslado es más barato de lo que parece: **el broker y sus tres dependencias
(`term-host-broker.ts` + `term-session.ts` + `term-pty-bridge.ts` + `ws.ts`) son 860 líneas con CERO
dependencias de npm** — solo builtins de `node:` (más el `script` de util-linux, ya presente). No hay
`npm ci` que empaquetar.

**Las cuatro cosas que la rebanada tiene que resolver** (no son impedimentos, son el trabajo real):

1. **Cortex no tiene todavía ningún daemon long-running.** Su único servicio es `Type=oneshot` disparado
   por un `.timer`; el broker es `Type=simple` + `Restart=on-failure`, vivo 24/7 y con PTYs hijos (hoy
   3.4 GB de RSS, pico de 56 GB según systemd, porque adentro corren sesiones reales). Es una **capacidad
   nueva** para cortex, no un choque — pero cambia su perfil de "recolector periódico" a "host de procesos".
2. **Cortex es multi-OS; el broker es Linux-only** (usa `script -qfec`, `zsh`, `wl-copy`). Va **opt-in y
   gated por OS**, como ya se hace con `--no-plasmoid` — nunca en el camino por defecto de un `install.sh`
   en una Mac.
3. **Cortex es clonable por terceros.** Un servicio que abre shell de la máquina en un puerto local
   pesa distinto en un repo público: opt-in, documentado, y con el **token GENERADO por el instalador**
   (jamás uno por defecto ni horneado).
4. **Qué se lleva y qué se queda.** Se lleva el **servidor** (los 4 archivos + la unidad); se queda en axon
   el **cliente** (el reenvío desde `http-server.ts` cuando hay `AXON_TERM_BROKER_TOKEN`) y el fallback al
   shell del contenedor. Hay que decidir si el código viaja como copia en cortex o si cortex instala un
   artefacto que axon publica — la copia duplica 860 líneas; el artefacto acopla los releases. **Esa es la
   pregunta de diseño de esa rebanada**, no de esta.

> **PENDIENTE (rebanada aparte, repo `cortex`):** mover `term-host-broker` + sus 3 módulos a
> `cortex/src/`, con unidad en `cortex/src/systemd/axon-term-broker.service` (`%h`, no rutas absolutas),
> instalación **opt-in** (`install.sh --con-term-broker`, gated a Linux), token **generado** por el
> instalador en `~/.config/cortex/term-broker.env` y leído por `EnvironmentFile=`, retiro en
> `uninstall.sh`, y decisión copia-vs-artefacto para los 4 archivos. En axon queda **solo el cliente**.
> Mientras no se haga, `axon-term-broker.service` sigue corriendo desde `~/code/axon-run` tal como hoy:
> el compose no lo toca y la terminal en uso no se entera.

## FreeToken: **parqueado**, con la razón técnica

Hoy: venv de uv (`freetoken==0.1.2`, torch 2.11, flashinfer, cuda-toolkit 13.0.2), `ft serve` con
`gpt-oss-120b`, `systemd --user`, **`disabled` e inactivo** — se levanta a mano cuando se necesita.

**No se contenerizó en esta rebanada**, y no por comodidad:

1. **El drift que motivó todo esto no aplica.** El bug es *"nuestro código mergeado no está corriendo"*.
   FreeToken es un paquete de terceros **pinneado por versión** en un venv: no hay `develop` que se le
   adelante. Su riesgo es otro (arranque lento, RAM), y ese no lo arregla un contenedor.
2. **Riesgo real de kernels CUDA, con precedente en este mismo repo.** El pool de expertos vive en RAM
   del host **pinneada para DMA** (~60 GB con gpt-oss-120b MXFP4; la VRAM es cache LRU) y las GPUs son
   **Blackwell (sm_120)**. `docker/gpu.tts.yml` ya documenta exactamente este golpe: la imagen GPU de
   Kokoro revienta en sm_120 con *"no kernel image is available for execution on the device"*. Una imagen
   nueva de FreeToken traería **otro** set de wheels que el venv que hoy funciona → la probabilidad de
   reproducir ese fallo no es teórica.
3. **`memlock` es el detalle que lo hunde en silencio.** El ulimit por defecto de un contenedor es
   64 KiB: sin `ulimits: memlock: -1`, la reserva de host memory pinneada falla y FreeToken **cae al
   camino puro-CPU lentísimo sin decir nada**. Es un modo de fallo silencioso, y no se puede verificar
   sin levantarlo (fuera del alcance de esta rebanada, que es no-destructiva).
4. **No debe ser always-on.** 60 GB de RAM de 123 GB totales, ~50 s de carga, y durante esa carga
   `/v1/models` ya responde pero toda completion da 503. Un servicio del stack que arranca con el `up`
   sería peor que lo de hoy.

**Cómo entra cuando entre** (rebanada propia, ya diseñada — que quede corriendo, no que "esté declarada"):

```yaml
# docker/freetoken.yml — BOCETO, no está en el -f de levantar-stack.sh
services:
  freetoken:
    profiles: ["freetoken"]        # NO arranca con el `up` normal: `--profile freetoken up -d freetoken`
    build: { context: ./docker/freetoken }   # nvidia/cuda:13.0-runtime + uv + freetoken==0.1.2
    command: ["ft","serve","--model","openai/gpt-oss-120b","--served-model-name","gpt-oss-120b",
              "--host","0.0.0.0","--port","7090","--moe-backend","auto",
              "--tool-call-parser","gpt_oss","--reasoning-parser","gpt_oss"]
    ulimits: { memlock: -1 }       # ← SIN esto, DMA pinning falla y cae al fallback CPU en silencio
    shm_size: "8gb"
    volumes: [ "${HF_HOME:-/home/unjordi/.cache/huggingface}:/hf" ]  # 161 GB — jamás re-descargar
    environment: [ "HF_HOME=/hf" ]
    deploy: { resources: { reservations: { devices: [{driver: nvidia, count: all, capabilities: [gpu]}] } } }
```

Criterio de aceptación de esa rebanada: `ft serve` en contenedor alcanza **el mismo tok/s** que el venv
nativo (si no, es que no pudo pinnear y se está midiendo el fallback CPU).

**Mientras tanto**: `AXON_FREETOKEN_URL=http://host.docker.internal:7090`. **Ausente es el caso normal** —
axon lo detecta por `/v1/models` y degrada al carril Ollama sin ruido (`src/freetoken-capabilities.ts`).

## `odysseus-tts-1` deja de ser huérfano

`tts` se creó desde `/tmp/claude-1000/ody-deploy` con overlays que el compose de `~/code/odysseus` no
tenía en su `-f` → compose lo veía **huérfano**, y un `--remove-orphans` reflejo lo mataba.

**La trampa se quita de raíz:** `docker/gpu.tts.yml` **ya está en este fork** (idéntico, verificado con
`diff`) y ahora entra en el `-f` de `levantar-stack.sh`. Con eso `tts` es un servicio **declarado** del
proyecto: sale en `docker compose ps`, se recrea con el stack y `--remove-orphans` deja de ser una mina.
El volumen `odysseus_tts_models` (los ~330 MB de pesos Kokoro) se conserva: mismo proyecto, mismo nombre.

Aun así, `levantar-stack.sh` **nunca** pasa `--remove-orphans`: la disciplina es mirar primero
`docker ps -a --filter label=com.docker.compose.project=odysseus`.

## Configuración: **una sola copia del `.env`**

Antes: `--env-file /home/unjordi/code/ajenos/odysseus/.env` — la config en el clon canónico y el compose
en el fork. Dos árboles que se desincronizan sin que nada avise: el mismo drift, con cara de config.

Ahora: **`odysseus/.env`**, en el project dir, que compose carga **solo por estar ahí** (sin flags), y
`APP_DATA_DIR`/`APP_LOGS_DIR` viven adentro en vez de exportarse a mano en el comando. El catálogo
comentado de las variables nuevas está en **`.env.stack.example`** (versionado; el `.env` real no).

- El `.env` viejo tenía **3 asignaciones**, ninguna secreta (`LLM_HOST`, `OLLAMA_BASE_URL`,
  `SEARXNG_INSTANCE`); las tres están portadas.
- **Los datos no se mueven:** `APP_DATA_DIR` sigue apuntando a
  `/home/unjordi/code/ajenos/odysseus/data` (donde vive `app.db`). Cambiar esa ruta **no migra nada** —
  Odysseus arrancaría con una base vacía.
- El `.env` del clon canónico queda **huérfano a propósito**; bórralo cuando el stack nuevo esté validado
  (borrar es tuyo, no mío).

## Estado persistente de axon

Todo lo que el harness escribe vive bajo `$HOME`, que es **`/home/node`** — el home del uid 1000 (`node`)
en `node:22-slim`, ya creado y con ese dueño por la imagen base. El compose lo declara explícito
(`HOME=/home/node` en `environment:`) para que los destinos de `volumes:` y el `$HOME` que axon consulta
sean una sola decisión legible.

> ⚠️ **Esto decía `/axon-home` y era FALSO** (corregido 2026-09-07). El Dockerfile de axon no crea ese
> directorio, no setea `ENV HOME`, y no tiene los `ARG AXON_UID/AXON_GID` que esta doc y el compose
> afirmaban: `/axon-home` lo creaba Docker solo, `root:root`, como target del bind. El `$HOME` real lo
> fijaba `/etc/passwd` de la imagen base ⇒ **los binds de estado estaban MUERTOS**: montados pero jamás
> leídos, con axon escribiendo a `/home/node/...` en el overlay efímero. Medido en el contenedor vivo:
> `HOME=/home/node`, `/home/node/.cache/axon` en dev=172 (overlay) y el bind del host colgando sin
> lectores en `/axon-home/.cache/axon` (dev=33). El estado que esta tabla promete se perdía en cada
> recreate, en silencio.

| ruta en el contenedor | qué es | ¿sobrevive? |
|---|---|---|
| `/home/node/.axon/runs/*.json` | run records de `axon ps` (hoy 1.8 MB de historia) | **sí** — bind a `~/.axon` |
| `/home/node/.axon/plugins/` | plugins locales opt-in (#16) | **sí** — mismo bind |
| `/home/node/.axon/*.db` | **la BD SQLite de la bitácora de prompting** (rebanada aparte) | **sí** — el compose ya la contempla |
| `/home/node/.cache/axon/routes.jsonl` | route-log (append-only) | **sí** — bind a `~/.cache/axon` |
| `/odysseus-data/app.db` | sesiones compartidas con el SPA | **sí** — el mismo `data/` de Odysseus |
| `/tmp/axon-delegate-*` | worktrees efímeros de los subagentes | **no, y está bien**: se crean y se borran dentro de una corrida; su valor queda en el repo montado |

**Son binds al host, no volúmenes nombrados, a propósito:** también se corre `axon` nativo desde la
terminal, y un volumen nombrado partiría la historia en dos (el `axon ps` del contenedor no vería lo del
host). Con el bind, contenedor y CLI comparten **un solo corpus**, y el que ya existe no se pierde al
contenerizar. Concurrencia: un archivo por run (sin contención), route-log append-only, y SQLite sobre un
bind local maneja sus propios locks.

## `/workspace` es **escribible** (y por eso el contenedor corre como uid 1000)

Los subagentes de axon hacen `git worktree add` (`src/agents/subagent.ts` → `src/git/ops.ts`), lo que
**escribe en `/workspace/.git/worktrees/`**. Verificado en el diseño:

- el bind de `/workspace` es **rw** (no lleva `:ro`);
- el contenedor corre con **`user: "${PUID:-1000}:${PGID:-1000}"`** — el mismo par que ya usa Odysseus.
  Corriendo como root también escribiría (root ignora permisos), pero dejaría `.git/worktrees/...`
  **`root:root`** y el humano no podría podarlos ni operar el repo sin `pkexec`. Con uid 1000, los
  archivos quedan del usuario del host, como si los hubiera creado él;
- mismo motivo para `app.db` (0600 del uid 1000): como root se abre, pero cualquier journal `-wal`/`-shm`
  quedaría root-owned y **Odysseus** (que corre como `PUID/PGID`) fallaría al escribirlo después;
- el worktree en sí se crea bajo `os.tmpdir()` → **dentro** del contenedor, efímero: aislamiento gratis.

## Hallazgos abiertos (encontrados al diseñar los healthchecks — NO son parte de esta rebanada)

Salieron de leer los servicios en vivo para escribir sus healthchecks. **No se arreglaron aquí**: uno exige
recrear un contenedor (no se levantó nada) y el otro es un cambio en el código de Odysseus. Quedan escritos
para que no se pierdan.

### 🔴 ALTO — `chromadb` NO está persistiendo: el volumen está montado donde el proceso no escribe

Verificado dentro del contenedor vivo:

```
volumen odysseus_chromadb-data  →  /chroma/chroma     ... VACÍO
el proceso escribe en           →  /data              ... chroma.sqlite3 (1.1 MB) + 2 colecciones
```

El log de arranque de chroma lo dice él mismo: `Saving data to: /data` / `persist_path: "/data"`. La imagen
`chromadb/chroma:latest` **cambió su ruta de persistencia** y el `volumes:` del compose se quedó en la vieja.
⇒ **Todo el vector store (RAG + memorias) vive en la capa escribible del contenedor**: un
`docker compose down` o cualquier recreate **lo borra**.

- **Arreglo** (una línea): montar el volumen en `/data` — o fijar la ruta con la env var que corresponda a
  la versión de la imagen.
- **⚠️ No es un cambio inocente:** al remontar, el volumen `odysseus_chromadb-data` (vacío) taparía `/data`
  y Chroma arrancaría **con una base vacía**. Los datos actuales hay que **copiarlos fuera primero**
  (`docker cp odysseus-chromadb-1:/data …`) y sembrarlos en el volumen. Es rebanada propia, con respaldo.
- Mitiga el susto, pero no lo arregla: `src/rag_singleton.py` re-crea las colecciones vacías al arrancar,
  así que la pérdida se ve como *"el RAG se quedó sin documentos"*, no como un error.

### 🟡 MEDIO — `/api/ready` existe, es la readiness que queríamos, y no se puede usar

`GET /api/ready` (app.py:1002 → `src/readiness.py`) comprueba exactamente lo correcto (DB alcanzable, data
dir presente y **escribible**) y devuelve 503 si algo falta — la semántica ideal de un readiness probe. No
se usa como healthcheck por **dos** razones independientes:

1. **Está detrás del middleware de auth**: devuelve **401** (verificado en vivo). No está en
   `AUTH_EXEMPT_EXACT`, donde sí están `/api/health` y `/api/version`.
2. **Escribe**: crea y borra un archivo probe en `DATA_DIR` en **cada** llamada (`readiness.py:39-42`). Un
   healthcheck que corre cada `interval` para siempre no debe escribir.

Para usarlo haría falta exentarlo de auth **y** darle un modo no-escribiente (p. ej. `os.access(W_OK)` en
lugar del archivo). Mientras tanto el healthcheck es `/api/health` y la comprobación profunda no se hace.

## Lo que NO está verificado (porque no se levantó nada)

Todo lo de abajo es diseño validado con `docker compose config`, `tsc`, las probes, y —lo nuevo de esta
pasada— **ejecutando cada comando de healthcheck contra los contenedores que YA corrían** (`docker exec`,
solo lectura). Lo que **no** se probó es un `up` completo: el orden de arranque real, los tiempos en frío y
los servicios que hoy no están arriba.

**Verificado en vivo** (comando de healthcheck ejecutado, `exit=0`): `odysseus` (`/api/health` 200 y `/` 302),
`chromadb` (`bash`+`/dev/tcp` → heartbeat; y que su `sh` es dash y **no** sirve), `ntfy` (`healthy:true`),
`tts` (voces no vacías), `searxng` (200), `ollama` (formato de `ollama list` contra el binario nativo, 5 ms,
sin cargar modelos). Las **seis** combinaciones de overlays validan con `docker compose config`.

**Sin verificar, en orden de riesgo — mirar esto al primer `up`:**

1. **El healthcheck de `axon`.** Es el único que se **corrigió a ciegas** (de `http` a `https`): el
   contenedor de axon no está corriendo, así que la corrección está probada por lectura del código
   (`http-server.ts:1229-1245`: con TLS se devuelve un `createHttpsServer` en lugar del server plano), no
   por ejecución. Si sale `unhealthy`, mirar primero si el `command:` sigue pasando `--tls-cert`.
2. **`ollama` en contenedor ve los modelos** — es la premisa del healthcheck nuevo *y* de la arista dura
   `axon → ollama`. Si `OLLAMA_MODELS` no toma, ahora el stack **se planta ahí a propósito** en vez de
   arrancar un axon con un cerebro fantasma. Comprobar: `docker compose -p odysseus exec ollama ollama list`.
3. **Los `start_period` no medidos** (`ollama` 40 s, `axon` 45 s, `chromadb` 30 s). Elegidos por el lado
   seguro; no cuestan cuando el arranque es rápido. Ajustarlos **con evidencia** del primer `up` real:
   `docker inspect <ctr> --format '{{.State.StartedAt}}'` contra la primera línea útil de `docker logs -t`.
4. **El fallo de Blackwell del TTS** — el smoke de síntesis de `levantar-stack.sh` está escrito pero no
   ejercitado contra la imagen **GPU** (el stack corre la CPU por default, y esa sí sintetiza hoy).
5. **El reporte de salud de `levantar-stack.sh`** — `bash -n` limpio y los `docker compose ps --format`
   son los documentados, pero la tabla no se ha impreso nunca de verdad.
6. **axon como uid 1000** — sigue siendo el cambio de mayor riesgo (antes corría como root). Un `EACCES`
   claro en `docker logs odysseus-axon-1`. Escape: quitar la línea `user:` de `docker/axon.yml`.
7. **`git worktree add` desde el contenedor** — probar un `delegate` real; confirma que `/workspace/.git`
   es escribible con ese uid.
8. **Que `/api/axon/version` reporte el sha de develop**, no `desconocido` (ahora lo compara el script solo).
9. **La terminal del widget** sigue dando shell del host. Requiere `AXON_TERM_BROKER_TOKEN` en el `.env`
   **y** —desde el fix del 2026-09-07— un broker reiniciado con el socket unix y el directorio del socket
   montado en el contenedor (`AXON_TERM_SOCKET_DIR`). Verde: el badge dice `host` (no `host-down`) y un
   `whoami` devuelve el usuario del host, no `root`.
10. **El CD entero (`--sin-publicar`)**, y esto solo se prueba de una forma: **con un push a `develop` de
    axon**. Lo que sí está comprobado sin mutar nada es que las combinaciones de banderas que quedan
    siguen resolviendo con `docker compose config`, y que el modo CD resuelve
    `image: potenciaindustrial/axon:<tag>` (única línea que cambia contra el modo normal). Lo que **no**
    se ha ejercitado nunca: el `up -d --build` disparado por el CD (que desde el 2026-09-07 reconstruye el
    stack ENTERO, no solo axon), la tabla de salud impresa de verdad y el exit≠0 pintando el job de rojo.
