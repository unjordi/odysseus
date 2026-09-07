# TTS decente para Odysseus — voz natural en español (local-first)

> Rama `feat/tts-decente`. Objetivo: que la voz del asistente suene **natural,
> fluida y bien entonada en español** (aguantando inglés), corriendo **local**
> en la Cachy (GPU NVIDIA), sin APIs de pago.

## TL;DR

- **La causa raíz del "suena robótico" NO era falta de un buen motor** — Odysseus
  ya integra **Kokoro-82M** (excelente prosodia). Estaba **mal cableado**:
  1. El pipeline in-process fijaba `KPipeline(lang_code="a")` (G2P de inglés
     americano) para **todo** — texto español pasado por fonemizador inglés =
     pronunciación y entonación rotas. **Corregido** (ver abajo).
  2. La imagen Docker es **Python 3.14**, pero `kokoro==0.9.4` exige
     `>=3.10,<3.13` → el proveedor `local` **ni siquiera se instala** en el
     contenedor. En Docker la voz caía a `browser` (Web Speech API del SO) = la
     voz robótica que se oía.
- **Solución:** correr el motor TTS como **sidecar con API OpenAI-compatible**
  (`/v1/audio/speech`, overlay `docker/gpu.tts.yml`) y consumirlo desde un
  proveedor **built-in `kokoro`** (default) que apunta al sidecar sobre la red de
  compose (`http://tts:8880/v1`) **sin ModelEndpoint que crear a mano**. También
  se **destapó el panel de TTS** (estaba oculto → por eso "no se veía") y se
  metieron las **voces en español al dropdown**.
- **Motor por defecto:** **Kokoro-FastAPI** (Apache-2.0, ~1-2 GB VRAM, streaming,
  45 ms al primer audio, multilingüe con español). **Upgrade para máxima
  naturalidad en español:** **Chatterbox Multilingual** (MIT, finetune dedicado
  de español latino, clonación de voz).
- **Muestras reales** para tu QA auditivo: `scripts/tts-samples/samples/*.wav`
  (generadas con los mismos pesos Kokoro; español e inglés).

---

## Inventario — qué había antes (Paso 0)

| Pieza | Estado |
|---|---|
| `services/tts/tts_service.py` | Servicio multi-proveedor: `disabled`, `browser`, `local` (Kokoro-82M), `endpoint:<id>` (OpenAI `/audio/speech`). Cache SHA256 en `data/tts_cache/` con evicción por bytes (`ODYSSEUS_TTS_CACHE_MAX_BYTES`, 500 MB). |
| `routes/tts_routes.py` | `/api/tts/stats`, `/api/tts/synthesize` (audio/base64), `/api/tts/clear-cache`. |
| `static/js/tts-ai.js` | Reproducción, cache de object-URL, cola, **streaming frase-por-frase**, fallback a `speechSynthesis`. |
| `static/js/settings.js` | Selector de proveedor/voz/modelo/velocidad + botón Preview. |
| Voz local por defecto | `af_heart` (inglés americano). Sin voces españolas expuestas. |
| Deps | `kokoro==0.9.4` + `soundfile`, solo Python 3.11-3.12 (3.13+ se salta). Imagen = **py3.14** → no instala. |
| `axon` (`~/code/axon`) | **Sin TTS.** Solo ingesta de medios/transcripción (yt-dlp, VTT→texto). No hay nada de síntesis que reusar ahí. |

**Conclusión:** la base es buena y **se construye SOBRE ella**. No se reemplaza el
servicio; se **arregla el cableado de idioma** y se **añade el carril sidecar**
que el contenedor py3.14 sí puede usar.

---

## Comparativa de motores (calidad real, no marketing)

Contexto: 2× GPU NVIDIA de 16 GB. Prioridad = prosodia/entonación **en español**,
fluidez, streaming, licencia usable en self-host, VRAM.

| Motor | Español | Prosodia | VRAM | Latencia (TTFB) | Streaming | Licencia | Clonación | Veredicto |
|---|---|---|---|---|---|---|---|---|
| **Kokoro-82M** (FastAPI) | Buena (3 voces `e*`) | Muy buena p/su tamaño | ~1-2 GB | **~45 ms** | Sí | **Apache-2.0** | No | **Default.** Ligerísimo, rápido, ya integrado, OpenAI-compatible. Español limpio; su punto fuerte es inglés. |
| **Chatterbox Multilingual** | **Excelente** (finetune ES latino) | Excelente, expresiva | ~6-8 GB | ~200-400 ms | Sí (Turbo 350M) | **MIT** | Sí | **Upgrade premium** para el español más natural. Más pesado y nuevo; watermark embebido. |
| **XTTS-v2** (Coqui) | Muy buena (probada) | MOS ~4.1 | ~3-4 GB | ~200-320 ms | Sí | **CPML (no comercial)** | Sí | Maduro y probado, pero Coqui está **descontinuado** y la licencia del modelo es no-comercial. Chatterbox lo supera para ES + MIT. |
| **F5-TTS** | Buena (modelos comunitarios ES) | Muy natural | ~4-6 GB | Alta (difusión) | Parcial | **CC-BY-NC** (no comercial) | Sí | Muy natural pero pesado y no-comercial. Más setup. |
| **Piper** | Voces `es_MX`/`es_ES` | Plana / "robótica" | ~CPU | Muy baja | No real | MIT | No | Rápido y confiable, pero es justo la clase de voz "plana" que se quiere superar. Sirve de baseline CPU. |

**Por qué Kokoro por defecto y Chatterbox como upgrade** (juicio honesto):

- Kokoro resuelve el problema inmediato con **mínima fricción**: ya está en el
  código, es Apache, cabe en cualquier GPU, tiene streaming y su español —bien
  cableado— es **muchísimo** mejor que la voz `browser` robótica. Es la mejora de
  mayor relación valor/riesgo **hoy**.
- Chatterbox es la respuesta si tu oído pide español **más expresivo/humano**:
  tiene un finetune **dedicado de español latino**, es MIT, y se sirve igual
  (OpenAI-compatible) → se enchufa por el mismo carril `endpoint:` sin tocar el
  core. Cuesta más VRAM y latencia.
- XTTS-v2/F5-TTS quedan descartados como default por licencia no-comercial y, en
  XTTS, proyecto descontinuado.

> **Recomendación final:** desplegar **Kokoro-FastAPI** ya (default), generar
> muestras de **ambos** y dejar que **tu QA auditivo** decida si vale la pena
> subir a Chatterbox para el español. La arquitectura soporta los dos a la vez
> (dos sidecars, dos endpoints seleccionables).

---

## Qué se cambió en este branch

1. **`services/tts/tts_service.py` — fix del idioma (la corrección clave).**
   El pipeline Kokoro ahora **enruta por el prefijo de la voz** al G2P correcto
   (`ef_dora` → español `"e"`, `af_heart` → inglés `"a"`, etc.) manteniendo un
   pipeline **por idioma** (lazy, cacheado). Antes todo pasaba por inglés. Además
   ahora **cae a CPU** si no hay CUDA (antes se declaraba no-disponible sin GPU),
   útil para pruebas fuera de Docker.
2. **`docker/gpu.tts.yml` — sidecar OpenAI-compatible** (Kokoro-FastAPI por
   defecto; Chatterbox comentado como alternativa). Overlay al estilo de
   `docker/gpu.nvidia.yml`. Ahora expone `127.0.0.1:8880` para probar con curl.
3. **`services/tts/tts_service.py` + `src/settings.py` — proveedor built-in
   `kokoro`** (la pieza que faltaba para que "se vea"). Habla con el sidecar por
   `http://tts:8880/v1` (override `ODYSSEUS_TTS_SIDECAR_URL`) reusando el mismo
   POST OpenAI-compatible que `endpoint:<id>`. Es el **default** (`tts_provider=
   kokoro`, `tts_voice=ef_dora`) → TTS funciona apenas se levanta el sidecar, sin
   crear un ModelEndpoint a mano.
4. **`static/index.html` — panel de TTS destapado.** Estaba `hidden
   display:none` ("user opted out") → **esa era la razón real de "no lo veo en
   ningún lado"**. Añadida la opción de proveedor "Kokoro (local sidecar)".
5. **`static/js/settings.js` — voces de Kokoro en el dropdown** (español
   primero: `ef_dora`/`em_alex`/`em_santa`, + inglés US/UK) para los proveedores
   `kokoro`/`local`; filtro de endpoints ampliado (`speech`/`voice`/`kokoro`);
   texto del Preview bilingüe ES+EN.
6. **`scripts/tts-samples/`** — generador de muestras (`generate_samples.py`) +
   los `.wav` ya generados para QA.

> **Nada declarado LISTO.** Compila/importa y el cableado es correcto, pero la
> calidad y la ELECCIÓN de la voz son **QA auditivo tuyo** — por eso las muestras
> y por eso todas las voces quedan seleccionables (default `ef_dora`, cámbialo).

---

## Cómo desplegar (el orquestador lo integra; esto es la receta)

### Opción A — Sidecar (RECOMENDADA, funciona en el contenedor py3.14)

```bash
# 1. Levantar Odysseus + GPU + sidecar TTS con el overlay
export COMPOSE_FILE=docker-compose.yml:docker/gpu.nvidia.yml:docker/gpu.tts.yml
docker compose up -d
# (primer arranque del sidecar descarga los pesos Kokoro ~330 MB → data/tts_models/)

# 2. Nada más que hacer: el proveedor built-in "kokoro" ya es el default y apunta
#    al sidecar. Settings → Text to Speech muestra el panel con las voces ES en el
#    dropdown (default ef_dora). Botón Preview: lee la frase en español.
#    (Si un settings.json viejo tenía tts_provider="disabled", basta elegir
#     "Kokoro (local sidecar)" una vez en el panel ahora visible.)
```

Voces Kokoro en español: **`ef_dora`** (F), **`em_alex`** (M), **`em_santa`** (M).
Inglés recomendadas: `af_heart`, `af_bella`, `am_michael`, `bf_emma` (británica).

### Opción B — Proveedor `local` in-process (solo fuera de Docker, py3.11-3.12)

Con el fix, el proveedor `local` ya hace español bien. Requiere un runtime
Python 3.11-3.12 (NO la imagen py3.14):

```bash
pip install -r requirements-optional.txt   # kokoro + soundfile (se saltan en 3.13+)
# Settings → TTS → proveedor "local", voz "ef_dora".
```

### Upgrade a Chatterbox (español premium)

Descomentar el servicio `tts-es` en `docker/gpu.tts.yml`, levantar, y crear un
segundo endpoint apuntando a su URL. Los pesos se descargan al primer arranque
(`data/chatterbox_models/`).

---

## Muestras para QA auditivo

`scripts/tts-samples/samples/`:

| Archivo | Voz | Idioma |
|---|---|---|
| `es_female_dora.wav` | `ef_dora` | Español (10 s) |
| `es_male_alex.wav` | `em_alex` | Español |
| `en_female_heart.wav` | `af_heart` | Inglés |
| `en_male_michael.wav` | `am_michael` | Inglés |

Generadas con `kokoro-onnx` (mismos pesos que el `kokoro` de Odysseus), CPU, sin
tocar el contenedor ni la GPU. Para regenerar o ampliar:

```bash
python scripts/tts-samples/generate_samples.py [out_dir]
```

Ábrelas con `xdg-open scripts/tts-samples/samples/es_female_dora.wav` y juzga la
entonación. Si el español de Kokoro no te convence, ese es el disparador para
probar Chatterbox.

---

## Gotchas (verificados)

- **Python 3.13+ mata a `kokoro` in-process.** La imagen Odysseus es py3.14 → el
  proveedor `local` no instala. Por eso el **sidecar** (contenedor propio con su
  Python) es el carril correcto en Docker. `kokoro-onnx` sí corre en 3.14 (onnx,
  sin torch) — es lo que usan las muestras.
- **`espeak-ng` es obligatorio** para el G2P (fonemización) de Kokoro. En la
  Cachy está en `/usr/share/espeak-ng-data` con `libespeak-ng.so.1`. El wheel
  `espeakng-loader` traía una lib con un data-path de CI baked-in roto
  (`/home/runner/...`) → hay que apuntar a la lib/data del sistema
  (`PHONEMIZER_ESPEAK_LIBRARY`, `ESPEAK_DATA_PATH`). El contenedor Kokoro-FastAPI
  ya trae su propio espeak, así que esto solo afecta la generación local de
  muestras.
- **El G2P se ata por voz, no por request.** Kokoro liga UN idioma por
  `KPipeline`; el fix mantiene un pipeline por idioma y enruta por el prefijo de
  la voz. Si en el futuro se mezcla ES+EN en una misma frase, cada frase debería
  fonemizarse en su idioma (hoy se toma el de la voz seleccionada).
- **El card de TTS estaba oculto** (`hidden display:none` en `index.html`, ver
  `specs/speech.md`) — **era la causa del "no lo veo en ningún lado"**. Ya se
  destapó en este branch. Si vuelve a ocultarse en un merge de upstream, revisar
  ese `<div class="admin-card">` del panel "Text to Speech".
- **Cache global sin partición por dueño** — el audio cacheado (`data/tts_cache/`)
  no distingue usuario. Fuera del alcance de este branch (ya documentado como gap
  en `specs/speech.md`), pero relevante si el despliegue es multi-usuario.
