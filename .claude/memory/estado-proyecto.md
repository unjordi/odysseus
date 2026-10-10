# odysseus (fork) — estado del proyecto

> Pendientes del fork que construye axon-master. Movidos el 2026-10-10 desde el ROADMAP de axon
> (`~/code/axon/docs/ROADMAP.md`); el detalle de cada uno va abajo, copiado verbatim de `roadmap-detalle.md`.
> Lo durable por módulo vive en `widget-<módulo>/estado.md`.

## Pendientes

- **#30** Conector Microsoft To-Do · 🔨 conector mergeado al fork (PR #70) · falta cablear sus rutas (gate de seguridad #30b) y el client_id de Azure · módulo: [widget-mstodo](widget-mstodo/estado.md)
- **#30b** Conector MS To-Do: requisitos de seguridad y sync antes de exponer rutas · ⬜ gate duro al cablear · módulo: [widget-mstodo](widget-mstodo/estado.md)
- **#30c** `secret_storage`: decrypt fail-soft y doble cifrado · 🔵 contrato · módulo: [widget-mstodo](widget-mstodo/estado.md)
- **#31** Biblioteca + lectura en voz alta (Kavita/Calibre + TTS + "dónde me quedé") (fila NUEVA, unjordi 2026-09-07) · ⏸️ mecánica completa y desplegada (fork #76–#93) · UX en pausa desde 2026-09-19 · módulo: [widget-biblioteca](widget-biblioteca/estado.md)
- **#32b** `stt_clean_enabled` sin superficie en Settings · ⬜
- **#26d-1** Resize del PTY: ACK en el frontend del fork · ⬜
- **#26g-1** Odysseus vivo lee datos de `~/code/ajenos/odysseus/data` · 🔵 decidir intencional vs drift
- **#19q** Gate del chat axon en Odysseus: aceptar bearer `ody_` además de cookie · ⬜

## Detalle

## #30 · Conector Microsoft To-Do (módulo propio + sync Graph; calendario de fábrica, Keep fuera) · 🌍 P2 · fila NUEVA (unjordi, 2026-09-07)

**Qué pidió:** *"sincronizar las notas de Odysseus con Google Keep"* · *"sincronizar los tasks con Google Tasks o
Microsoft To-Do"* · *"sincronizar el calendar con Google"*. Van juntas porque comparten **el mismo mecanismo**:
auth de un tercero (OAuth + refresh), un mapeo de identidades local↔remoto, y una **reconciliación bidireccional**
con su política de conflictos y sus *tombstones* de borrado. Lo que NO comparten es qué tan viable es cada una — y
ahí es donde este ítem se gana el sueldo antes de escribir código.

**El mecanismo YA está construido en el repo, dos veces, y hay que reusarlo:**
- **OAuth de Google, probado en producción** (correo, XOAUTH2): `routes/email_helpers.py:53-150` —
  `make_oauth_state`/`verify_oauth_state` (state firmado con HMAC), `_refresh_google_token` contra
  `oauth2.googleapis.com/token`, y los tokens **cifrados** en la DB (`_enc`/`_dec` sobre las columnas
  `oauth_access_token`/`oauth_refresh_token` de `EmailAccount`, `core/database.py:386-429`). Esta es la plantilla.
- **Reconciliación bidireccional, también probada** (calendario, CalDAV): `src/caldav_sync.py` + el push tras
  commit local (`routes/calendar_routes.py:151-168`) con **tombstones** para los borrados (`:181-194`), y quirks
  reales de proveedor ya resueltos (Google CalDAV en sus dos formas, `caldav_sync.py:185-227`).

**Por eso los tres NO están al mismo nivel — el estado real, medido:**
- **Calendario (idea 3): ya sincroniza con Google, por CalDAV**, bidireccional, con auth básica / contraseña de
  aplicación, no OAuth. ⇒ La pregunta que abre este ítem no es "cómo sincronizamos el calendario" sino
  **¿qué le falta a lo que ya hay?** (¿la cuenta de unjordi no está configurada? ¿quiere la Google Calendar API con
  OAuth en vez de CalDAV, para no depender de una app-password?). Esa respuesta define si esto es media tarde o un
  conector nuevo.
- **Tasks (idea 2): el módulo `Tasks` de Odysseus NO es una lista de pendientes.** Es un **scheduler de prompts
  LLM recurrentes** (`static/js/tasks.js:1-3`, tabla `ScheduledTask`, `core/database.py:730`). Sincronizarlo con
  Google Tasks / Microsoft To-Do no significa nada tal cual. ⇒ Decisión previa: **¿qué se sincroniza?** Un módulo
  de to-dos que no existe, o las notas tipo checklist (`Note.note_type = "checklist"`, `core/database.py:1808`)
  que sí son listas de pendientes. Y si es Microsoft: **no hay OAuth de Microsoft en el repo** — solo la detección
  del host para explicar que basic-auth ya no funciona (`email_helpers.py:200-217`); el flujo de Azure/Graph se
  construiría desde cero, a diferencia del de Google que ya está.
- **Keep (idea 1): no hay API de consumo.** La única API oficial de Google Keep es **de empresa** (Workspace, con
  aprobación del administrador, pensada para que TI administre notas); las cuentas personales no tienen API, y la
  petición de abrirla lleva años sin respuesta. ⇒ Las salidas son: (a) un cliente NO oficial (ingeniería inversa,
  se rompe cuando Google mueve algo — deuda que se paga sola), o (b) que Keep sea el que se queda fuera y las
  notas se sincronicen por una vía que sí tenga contrato (Drive, Markdown en una carpeta, otro servicio). **No se
  elige aquí:** es de unjordi, y hay que decírselo antes de que espere Keep.

**Por qué P2:** ninguna desbloquea el harness ni la UI; son comodidad personal real, pero la #29 y la #32 se pagan
más veces al día. Y el orden natural es **calendario → to-dos → notas**: el primero puede ser afinar lo que ya
corre, el último todavía no tiene contrato del otro lado.

### ⚠️ Corrección de unjordi (2026-09-07): el módulo de **To-Do hay que CONSTRUIRLO**

Mi lectura fue que había que "decidir qué se sincroniza con lo que ya existe". Su respuesta: *"hay que construir un módulo de To-Do"*.

Así que el ítem tiene **dos slices, en este orden**:

1. **Un módulo de to-dos propio en Odysseus** — que hoy no existe. Su `Tasks` es un **scheduler de prompts LLM recurrentes** (`ScheduledTask`): comparte nombre y nada más. Tareas con título, estado, fecha, listas, y su modelo de datos pensado ya para reconciliar con un servicio externo (ids estables, marca de última modificación, tombstones).
2. **La sincronización** con Microsoft To-Do (proveedor decidido 2026-09-17, creds por-usuario en la GUI), encima de ese modelo. Techo real: en el repo **no hay OAuth de Microsoft** (solo el mensaje de error de basic-auth), así que implica Azure/Graph desde cero.

Construir el módulo primero **no es andamiaje desechable**: es el modelo de datos sobre el que la sincronización se apoya.

**Estado (2026-09-17):** el **módulo** (slice 1) vive en **axon** `src/todo/` (`todo-defs.ts` + `reconcile.ts`) — el módulo To-Do NO terminó en el fork como decía el párrafo de arriba; ese texto quedó superado por el hecho. De la **sincronización** (slice 2) ya está construido el **mapeo puro Graph↔RemoteTodo** (`src/todo/ms-graph-map.ts`, probe-ms-graph-map 31/31): la parte que no depende del OAuth ni de Azure. Queda por construir el I/O del conector — fetch `/me/todo`, OAuth Azure/Graph desde cero, token-store por-usuario en la GUI del fork — y **una decisión abierta: dónde se INVOCA el conector** (axon-side vs fork-side, y cómo cruzan los tokens fork↔axon). Ese I/O necesita registro de Azure (client_id) para el QA end-to-end.

---

## #30b · Conector MS To-Do: requisitos de seguridad y sync antes de exponer rutas · ⬜ gate duro al cablear · inciso de #30
- Dormido: `get_valid_ms_token`/`refresh_ms_token` siguen sin callers (verificado 2026-10-10).
- `services/mstodo_auth.py`: C1 verificar `owner` (IDOR) · A1 TTL del state OAuth · A2 persistir el refresh rotado antes de devolver · A3 no loguear `str(e)` crudo · M1 lock por cuenta · M2 fail-fast de vars · M3 errores de red · B3 `response_mode=form_post`.
- `services/mstodo_sync.py`: comparar timestamps parseados (gemelo del fix de axon #317) · tombstones remotos/delta query para no resucitar borradas · default seguro de `updatedAt` y validación de `id`.
- Origen: `estado-proyecto.md` (texto completo archivado en `.claude/memory/dev-historial-sesiones.md` § "Estado-proyecto al 2026-10-10"). Verificado vigente 2026-10-10 contra el código.

## #30c · `secret_storage`: decrypt fail-soft y doble cifrado · 🔵 contrato · inciso de #30
- `src/secret_storage.py`: `decrypt` devuelve "" ante clave mala/corrupción (indistinguible de "sin token"); `encrypt` no chequea `is_encrypted`. Cambiar el contrato puede romper callers (correo/Google ya lo usan).
- Origen: `estado-proyecto.md` (texto completo archivado en `.claude/memory/dev-historial-sesiones.md` § "Estado-proyecto al 2026-10-10"). Verificado vigente 2026-10-10 contra el código.

## #31 · Biblioteca + lectura en voz alta (Kavita/Calibre + TTS + dónde me quedé) · 🌍 P2 · fila NUEVA (unjordi, 2026-09-07)

> **Estado 2026-10-03 — 🔨, mecánica COMPLETA:** las tres piezas existen y están desplegadas en el fork (#76–#93): conector Kavita + rutas `/api/kavita/*` + visor del HTML que renderiza Kavita + TTS del libro + pestaña Biblioteca en ajustes + **write-back del progreso a Kavita** (por usuario) + voz/velocidad en la barra + cuadrícula con portadas + navegación por autor. Arquitectura y pendientes: `~/code/odysseus/.claude/memory/widget-biblioteca/estado.md`. **Falta:** el UX (proyecto de ~1 mes, en pausa desde 2026-09-19) y QA visual. Ejemplares de prueba: `scratch/epub_rank.py` (ranking de 2044 epubs). El texto que sigue es el diagnóstico original (cuando solo existía el TTS).

**Qué pidió, textual:** *"un connector a Kavita o Calibre para poder leer en Odysseus y usar su TTS para que lea
los libros en voz alta, y que recuerde siempre dónde se quedó, por usuario"*. Es un conector como los de
[#30](#30), pero de otra naturaleza: no reconcilia dos copias de un dato, **consume una biblioteca ajena** y le
agrega una experiencia (leer + escuchar + retomar).

**Tres piezas, y solo una existe hoy:**
1. **El conector.** Kavita expone una API REST completa (`/swagger`) además de OPDS v1 + Page Streaming, y —esto
   es lo importante— **lleva el progreso de lectura POR USUARIO como feature de primera clase**: sus clientes
   (incluida su web) retoman en la página exacta desde cualquier dispositivo. Calibre es una biblioteca de
   archivos + servidor de contenido, sin esa noción por usuario. ⇒ **Con Kavita, el progreso NO se duplica: se
   delega** (nuestra DB guarda a lo sumo la referencia); con Calibre habría que llevarlo nosotros. Eso hace de
   Kavita el primer objetivo, y de Calibre un segundo backend con menos garantías.
2. **El lector.** **No existe**: no hay visor de EPUB ni concepto de progreso de lectura en el fork (las búsquedas
   de `epub`, `reading_position`, `last_read` y `bookmark` no devuelven nada). Lo más cercano es el editor de
   documentos (`static/js/document.js`, formularios/anotación de PDF) y el RAG de `services/docs/service.py`,
   ninguno con noción de "por dónde voy". Es la pieza que hay que construir de verdad.
3. **El TTS.** **Ya está**, y es multi-proveedor: `services/tts/tts_service.py` (`browser` Web Speech ·
   `kokoro` en sidecar Docker · Kokoro-82M en proceso · endpoint OpenAI-compatible), rutas en
   `routes/tts_routes.py`, cliente `static/js/tts-ai.js` con cola de auto-play y segmentación por oración. Hoy
   **solo lee mensajes de chat**. Leer un libro es alimentarlo con otra fuente: capítulo → segmentos → cola, y el
   avance del audio **es** el progreso de lectura que la pieza 1 persiste. Nada que reinventar.

**Y el "por usuario" ya es real:** el multi-usuario del fork no es decorativo (`core/auth.py` con bcrypt + 2FA,
columna `owner` indexada en casi toda tabla de `core/database.py`) — el progreso cuelga de ahí, igual que las
notas o el correo.

**Por qué P2:** es la primera pieza de este roadmap que no sirve para construir axon sino para **usarlo como
producto** — vale, pero después de que el shell ([#29](#29)) sostenga el estado por usuario que esto también
necesita.

### Paso 0 — inventario en vivo (2026-09-18, unjordi dio el go de arranque)

**Lo que corre en la Cachy (medido, `docker ps`):** `kavita` (`lscr.io/linuxserver/kavita`, expone `5000/tcp`)
y `calibre` (`lscr.io/linuxserver/calibre`, `8181->8081`). Bibliotecas mapeadas al Drive del SSD "Steam and files".
**ALCANCE (unjordi 2026-09-18): SOLO Kavita — Calibre FUERA** (*"si kavita tiene todo, olvida calibre"*). Kavita
lleva el progreso por-usuario de primera clase, que es justo lo que #31 necesita; no hay razón para el 2º backend.

**Hallazgo de infra que ORDENA el Slice 1 (requisito, no bloqueo del código):** `kavita` vive en su propia red
docker **`kavitanet`** (172.19.0.3) y **NO publica :5000 al host**; el stack de odysseus vive en **`odysseus_default`**
(odysseus, axon, ollama, tts, …). **No comparten red** → el conector NO alcanza a Kavita tal cual. Se resuelve sin
tocar el código de Kavita: el conector toma la URL de **`KAVITA_URL` (env, default `http://kavita:5000`)** y al
desplegar se puentea con `docker network connect odysseus_default kavita` (reversible) — o se publica Kavita al host
y se apunta a `host.docker.internal`. Decisión de deploy, se documenta; el conector queda agnóstico.

### Plan de SLICES (cada uno = PR con probe offline; todo en el FORK odysseus, su casa de backlog es axon)

1. **Slice 1 — Conector Kavita read-only + progreso DELEGADO. ✅ EN DEVELOP DEL FORK (PR #76, 2026-09-18):**
   `services/kavita_client.py` (defensivo/never-throws, auth por apiKey) + `services/kavita_library.py` (bibliotecas/
   series/volúmenes + progreso leído delegado + stream EPUB) + 46 tests con API mockeada (verdes en contenedor).
   Falta E2E con una apiKey real de Kavita (input de unjordi, como el client_id de #30). ORIGINAL:
   Backend Python en el fork (como los de #30 pero
   consume API ajena): auth contra Kavita (JWT `/api/Account/login` con apiKey, o API key), listar biblioteca/series,
   stream/descarga del EPUB, y **LEER** el progreso por-usuario de Kavita (`/api/Reader/progress`) — NO se duplica.
   El "por usuario" cuelga del `owner` del fork (auth+2FA ya real). Probe con la API de Kavita **mockeada**, never-throws.
2. **Slice 2 — Lector EPUB en el front** (la pieza que NO existe): visor de EPUB en Odysseus con noción de posición;
   **escribe** el progreso de vuelta a Kavita (delegar el estado, no llevarlo).
3. **Slice 3 — TTS del libro:** alimentar el TTS existente (`static/js/tts-ai.js` + `services/tts/tts_service.py`,
   ya multi-proveedor, hoy solo lee chat) con capítulo→segmentos→cola; **el avance del audio ES el progreso** que el
   Slice 2 persiste. Nada que reinventar en el TTS.
4. **Slice 4 — CONFIG del lector/voz en la PESTAÑA SETTINGS de Odysseus (REQUISITO DURO de unjordi 2026-09-18).**
   Textual: *"no quiero tener que pedirte chamba sólo porque la voz habla muy lento o porque no tengo un selector de
   modelos de voz"*. Todo lo parametrizable del lector va en la GUI, NO hardcoded → **velocidad/rate de la voz**,
   **selector de modelo/proveedor de voz** (el TTS ya es multi-proveedor: browser/kokoro/OpenAI-compat — hay que
   EXPONERLO), y los **params de Kavita** (p. ej. `KAVITA_URL`, y a futuro la apiKey por-usuario en la GUI). Encaja
   con [#32](#32) (fuente única de config en las settings). El gap real: el TTS ya tiene los knobs por dentro pero
   NO están en la GUI. Este slice los cablea a la pestaña Settings. NO dejar ningún parámetro que exija pedir chamba.

⚰️ **Calibre — DESCARTADO del alcance** (unjordi 2026-09-18: *"si kavita tiene todo, olvida calibre"*). Era un
posible 2º backend sin progreso por-usuario; con Kavita cubriendo todo, no se construye.

**Siguiente al retomar:** Slice 1 — obtener la API REST exacta de Kavita (su `/swagger`, alcanzable una vez puenteada
la red) y construir el conector con `KAVITA_URL` configurable.

---

## #32b · `stt_clean_enabled` sin superficie en Settings · ⬜ · inciso de #32
- El limpiador de dictado no aparece en `static/`; apagarlo exige editar `data/settings.json` a mano.
- Origen: `estado-proyecto.md` (texto completo archivado en `.claude/memory/dev-historial-sesiones.md` § "Estado-proyecto al 2026-10-10"). Verificado vigente 2026-10-10 contra el código.

## #26d-1 · Resize del PTY: ACK en el frontend del fork · ⬜ · inciso de #26d
- `createPtySizeReconciler` (`static/js/term-geometry.js`) marca `sent = next` en cuanto `ws.send()` no lanza, sin ACK: si los reintentos del PTY se agotan, el frontend cree aplicado un tamaño que no lo está.
- Origen: `estado-proyecto.md` (texto completo archivado en `.claude/memory/dev-historial-sesiones.md` § "Estado-proyecto al 2026-10-10"). Verificado vigente 2026-10-10 contra el código.

## #26g-1 · Odysseus vivo lee datos de `~/code/ajenos/odysseus/data` · 🔵 decidir intencional vs drift · inciso de #26g
- `~/code/odysseus/.env:10` fija `APP_DATA_DIR=/home/unjordi/code/ajenos/odysseus/data`: la instancia viva sirve datos del checkout de terceros, no del fork. Sin documentar.
- Origen: `estado-proyecto.md` (texto completo archivado en `.claude/memory/dev-historial-sesiones.md` § "Estado-proyecto al 2026-10-10"). Verificado vigente 2026-10-10 contra el código.

## #19q · Gate del chat axon en Odysseus: aceptar bearer `ody_` además de cookie · ⬜ · inciso de #19
- Hoy cookie-only: un cliente API/paired con bearer que pida model=axon por :7001 queda fuera. Se resuelve junto con la autenticación del CLI de `axon chat` (A bearer `ody_` · B socket unix).
- Origen: `estado-proyecto.md` (texto completo archivado en `.claude/memory/dev-historial-sesiones.md` § "Estado-proyecto al 2026-10-10"). Verificado vigente 2026-10-10 contra el código.
