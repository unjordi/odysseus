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

Los cuatro archivos: `docker-compose.gpu-nvidia.yml` + `docker/gpu.tts.yml` + `docker/ollama.yml` +
`docker/axon.yml`, siempre con `-p odysseus` (el nombre del proyecto es lo que ata los volúmenes
`odysseus_*` existentes: cambiarlo estrenaría volúmenes vacíos).

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

## Red: quién alcanza a quién

- **axon → Odysseus:** `http://odysseus:7000`, por la red interna del proyecto. **Es la única vía**:
  Odysseus publica su puerto solo en `127.0.0.1` del host, así que `host.docker.internal` **no** lo
  alcanza. Estar en el mismo proyecto de compose es lo que la da gratis (antes se resolvía uniendo un
  `docker run` a `--network odysseus_default` y apuntando al nombre de contenedor).
- **axon → Ollama:** `AXON_OLLAMA_URL=http://ollama:11434` (API nativa, sin sufijo).
- **Odysseus → Ollama:** `OLLAMA_BASE_URL=http://ollama:11434/v1` (API OpenAI-compat — **el `/v1` importa**;
  son dos contratos distintos contra el mismo motor).
- **axon → host** (broker de terminal `:8799`, FreeToken `:7090`): `host.docker.internal:host-gateway`.
- El puerto **11434 se sigue publicando en el host** con el mismo bind `0.0.0.0` → todo lo que hoy habla
  con `localhost:11434` (el CLI `ollama`, axon nativo, scripts sueltos) sigue funcionando sin cambios.

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

## La terminal del widget: el broker se queda en el HOST (decisión, no omisión)

`axon-term-broker.service` da una terminal **de la computadora**: `zsh` real, como `unjordi`, con su
entorno, sus claves y sus repos. Dentro de un contenedor daría el shell **del contenedor** — otra cosa, y
menos útil. Las tres opciones y su precio:

| opción | qué pasa | precio |
|---|---|---|
| **A. broker en el host (elegida)** | axon del contenedor le reenvía por `host.docker.internal:8799` con token | el broker sigue siendo una pieza nativa; se documenta y se vigila |
| **B. broker dentro del contenedor** | shell del contenedor | **rompe la terminal en uso**: sin las herramientas del host, sin `~/code`, sin credenciales |
| **C. contenedor con acceso al host** (`--pid=host`, `/` montado, docker.sock) | terminal "casi" del host | el contenedor deja de ser un límite: cualquier bug de axon es root en la máquina. **No** |

Se implementó **A**: el compose pasa `AXON_TERM_BROKER_URL`/`_TOKEN`; **sin token, axon degrada solo** al
shell del contenedor, sin fallar. La terminal en uso **no se toca**.

> ### ❓ PARQUEADO — pregunta para el dueño (sí/no)
> **¿El broker de la terminal se queda como servicio nativo del host (systemd), o lo bajamos también a
> un contenedor con acceso privilegiado al host?**
> Recomendación: **que se quede nativo**. Un contenedor que puede dar shell de la máquina anfitriona no
> es un límite de seguridad, es un disfraz — y ahí sí perderíamos algo real a cambio de uniformidad.
> Si la respuesta es "que se quede", queda **una** pieza nativa y hay que decirlo en voz alta:
> `axon-term-broker.service` es la excepción declarada, no un olvido.

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

Todo lo que el harness escribe vive bajo `$HOME` (que en la imagen es `/axon-home`, ya creado con dueño
`1000:1000` para que un bind no llegue `root:root`):

| ruta en el contenedor | qué es | ¿sobrevive? |
|---|---|---|
| `/axon-home/.axon/runs/*.json` | run records de `axon ps` (hoy 1.8 MB de historia) | **sí** — bind a `~/.axon` |
| `/axon-home/.axon/plugins/` | plugins locales opt-in (#16) | **sí** — mismo bind |
| `/axon-home/.axon/*.db` | **la BD SQLite de la bitácora de prompting** (rebanada aparte) | **sí** — el compose ya la contempla |
| `/axon-home/.cache/axon/routes.jsonl` | route-log (append-only) | **sí** — bind a `~/.cache/axon` |
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

## Lo que NO está verificado (porque no se levantó nada)

Todo lo de abajo es diseño validado con `docker compose config`, `tsc` y las probes — **no** con el stack
corriendo. Al primer `up`, mirar en este orden:

1. **axon como uid 1000** — es el cambio de mayor riesgo (antes corría como root). Si algo revienta será
   un `EACCES` claro en `docker logs odysseus-axon-1`. Escape: quitar la línea `user:` de `docker/axon.yml`.
2. **Ollama en contenedor lee el store** — `docker compose -p odysseus exec ollama ollama list` debe
   devolver los 4 modelos. Si sale vacío, `OLLAMA_MODELS` no tomó.
3. **Ollama ve las dos GPUs** — `docker compose -p odysseus exec ollama nvidia-smi -L`.
4. **`git worktree add` desde el contenedor** — probar un `delegate` real; es lo que confirma que
   `/workspace/.git` es escribible con ese uid.
5. **Que `/api/axon/version` reporte el sha de develop**, no `desconocido`.
6. **La terminal del widget** sigue dando shell del host (requiere `AXON_TERM_BROKER_TOKEN` en el `.env`).
