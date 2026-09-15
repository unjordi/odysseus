# Cómo agregar una nueva tool al rail (icon-rail) de Odysseus

> Manual de referencia exhaustivo, basado en el código REAL de este fork (rama `docs/rail-tool-manual`,
> partiendo de `dev` @ `affaee1`). Cada afirmación trae su archivo:línea verificado contra el repo.
> Nace de depurar en vivo el panel **Host Stats** (rama `feat/host-stats-panel`, no mergeada a `dev`):
> el ícono del rail no abría NADA hasta descubrir el mecanismo del paso 3 — commit `cb93a62`.

## Empieza aquí: los 4 pasos MÍNIMOS para que tu tool exista

Si solo lees una sección, que sea esta. Todo lo demás es refinamiento (arrastre, Settings, PWA).

1. **Botón en el rail** — `static/index.html`, dentro de `<div class="icon-rail" id="icon-rail">`:
   añade `<button class="icon-rail-btn" id="rail-TUTOOL" title="…"><svg…></button>`.
2. **Botón en el sidebar** (la lista expandida) — `static/index.html`, dentro de `#tools-section`:
   añade `<div class="list-item" id="tool-TUTOOL-btn">…</div>`.
3. **⭐ REGISTRA el par en `_railToolMap`** — `static/app.js` línea 3739. **Sin esto tu ícono del
   rail no abre NADA** — ver el GOTCHA #1 más abajo, es la sección más importante de este documento.
4. **El handler de apertura real vive en el botón del SIDEBAR** (`tool-TUTOOL-btn`), no en el del
   rail — un `addEventListener('click', …)` en `static/app.js` (patrón en línea 1015-1027) o en el
   módulo propio de tu tool (patrón `hostStats.js`, ver GOTCHA #1).

Con eso el ícono abre tu panel. Todo lo de abajo (arrastre, minimizar/restaurar, Settings, caché
PWA) es lo que separa "abre" de "se comporta como el resto de las tools".

### Checklist final — "para que tu tool SÍ abra"

- [ ] `rail-TUTOOL` existe en `static/index.html` (rail) — paso 1.
- [ ] `tool-TUTOOL-btn` existe en `static/index.html` (sidebar) — paso 2.
- [ ] `'rail-TUTOOL': 'tool-TUTOOL-btn'` está en `_railToolMap` (`static/app.js` ~L3739) — **si falta
      esto, clic en el rail no hace NADA, sin error en consola.**
- [ ] El listener de apertura está enganchado a `tool-TUTOOL-btn` (o a un botón que ese click
      dispara), NUNCA solo a `rail-TUTOOL`.
- [ ] Si tu tool es un modal clásico (`.modal`/`.modal-content`/`.modal-header`): registrada en
      `modalManager.js` (`_AUTO_WIRE` o `register()`) para minimizar/restaurar + chip del dock.
- [ ] Si quieres arrastre/snap: `makeWindowDraggable(modal, { content, header })`.
- [ ] Entrada en `UI_VIS_MAP` (`ui_visibility.js` ~L13) para que aparezca en Settings → Appearance.
- [ ] Si agregaste un `.js` nuevo cargado por `<script type="module" src="…">`: bump `CACHE_NAME`
      en `static/sw.js` (~L10) y agrégalo a la lista `PRECACHE` (~L40).
- [ ] Probado con hard-reload (`Ctrl+Shift+R`), no solo con un refresh normal (ver GOTCHA #9).

---

## 1. El botón del rail (`static/index.html`)

El rail es la barra angosta de íconos a la izquierda (`<div class="icon-rail" id="icon-rail">`,
línea 724 en este fork). Los botones de tools "siempre visibles, alfabético" viven en las líneas
734-745; ejemplo real, Cookbook (línea 737):

```html
<button class="icon-rail-btn" id="rail-cookbook" title="Cookbook"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.7"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg></button>
```

Y el de Host Stats (agregado por `553c87a` en la rama `feat/host-stats-panel`, entre Cookbook y
Deep Research):

```html
<button class="icon-rail-btn" id="rail-hoststats" title="Host Stats"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2 5 4-14 2 9 2-3h4"/></svg></button>
```

Convenciones del `<svg>` (cópialas, no improvises un estilo nuevo):
- `width="16" height="16" viewBox="0 0 24 24"` — SIEMPRE 24x24 de viewBox aunque el render sea 16px.
- `fill="none" stroke="currentColor"` — el ícono hereda el color de texto del botón (así responde a
  hover/tema claro-oscuro sin CSS extra). Nunca un `fill` sólido.
- `stroke-width` entre `1.4` y `2.5` según el grosor visual que quieras (Cookbook usa `1.4` con
  `opacity:0.7` inline porque su trazo es más denso; la mayoría usa `2`).
- `stroke-linecap="round" stroke-linejoin="round"` — esquinas/puntas redondeadas, consistente con
  el resto del set.
- El `id` sigue el patrón `rail-<nombre-corto-en-minúsculas>` (`rail-cookbook`, `rail-hoststats`,
  `rail-calendar`…). Este id es la clave que usarás en `_railToolMap` (paso 3) y opcionalmente en
  `UI_VIS_MAP` / `modalManager.js` `_AUTO_WIRE`.
- `title="…"` es el tooltip nativo del navegador — ponle el nombre visible de la tool (el mismo
  texto que usarás en el `<span class="grow">` del sidebar).

Insértalo en el bloque "Tool launchers — always visible, alphabetical" (línea 734), en orden
alfabético por el texto visible, entre el rail-separator (línea 730) y `<div style="flex:1">`
(línea 746) que empuja `rail-settings` al fondo.

## 2. El botón del sidebar (`tool-TUTOOL-btn`)

El sidebar expandido tiene su propia lista dentro de `#tools-section`. Ejemplo real, Cookbook
(línea 888-898):

```html
<div class="list-item" id="tool-cookbook-btn">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
    style="flex-shrink:0;opacity:0.5;">
    <path d="M12 7v14"/>
    <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>
  </svg>
  <span class="grow">Cookbook</span>
  <span id="cookbook-bg-status" style="display:none;font-size:9px;opacity:0.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-right:12px;flex-shrink:1;min-width:0;position:relative;top:-1px;"></span>
  <span class="cookbook-notif-dot" id="cookbook-notif-dot" style="display:none;margin-left:6px;margin-right:4px;position:relative;top:-1px;left:0px;"></span>
</div>
```

Estructura mínima (sin los extras de estado/notificación de Cookbook):

```html
<div class="list-item" id="tool-TUTOOL-btn">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:0.5;">
    <!-- mismo path-d que el ícono del rail, a 14x14 en vez de 16x16 -->
  </svg>
  <span class="grow">Nombre visible</span>
</div>
```

Notas:
- El SVG aquí es **14x14** (no 16x16 como el del rail) y lleva `opacity:0.5` inline (más discreto
  que el del rail, que va a `opacity:0.7` o sin opacidad).
- Usa el MISMO `path d="…"` que pusiste en el rail — mismo ícono, dos tamaños.
- `id="tool-TUTOOL-btn"` — el sufijo `-btn` es literal y obligatorio: es el que aparece en
  `_railToolMap`, en `_AUTO_WIRE` de `modalManager.js`, y en `UI_VIS_MAP`.
- `class="list-item"` es la clase que le da el layout/hover de fila de la lista — no la omitas.
- El ejemplo de Host Stats (agregado por `6b496ba`) usa un ícono de "pulso/latido" simple:
  `<path d="M3 12h4l2 5 4-14 2 9 2-3h4"/>` — un solo `path`, sin decoraciones extra; usa eso como
  plantilla de "caso simple" si tu ícono es un solo trazo.

## 3. ⭐ EL GOTCHA #1 — `_railToolMap` en `static/app.js` (línea 3739)

**Esta es la lección central de este documento.** El rail **no** abre las tools con un
`addEventListener` propio en cada botón `rail-*`. En vez de eso, `static/app.js` mantiene un mapa
`rail-id → tool-id` y, para CADA entrada, engancha un listener al botón del rail que se limita a
**re-disparar el click del botón del sidebar**:

```js
// static/app.js, líneas 3739-3760
const _railToolMap = {
  'rail-compare':   'tool-compare-btn',
  'rail-research':  'tool-research-btn',
  'rail-cookbook':   'tool-cookbook-btn',
  'rail-archive':   'tool-library-btn',
  'rail-gallery':   'tool-gallery-btn',
  'rail-tasks':     'tool-tasks-btn',
  'rail-calendar':  'tool-calendar-btn',
  'rail-notes':     'tool-notes-btn',
  'rail-memory':    'tool-memory-btn',
  'rail-theme':     'tool-theme-btn',
  'rail-email':     'email-section-title',
};
Object.entries(_railToolMap).forEach(([railId, toolId]) => {
  const railBtn = el(railId);
  if (railBtn) {
    railBtn.addEventListener('click', () => {
      const toolBtn = el(toolId);
      if (toolBtn) toolBtn.click();
    });
  }
});
```

**Consecuencia directa: si tu tool NO tiene una entrada `'rail-TUTOOL': 'tool-TUTOOL-btn'` en este
objeto, el botón del rail existe visualmente, responde al hover, pero el click no hace absolutamente
NADA — sin error en consola, sin excepción, silencio total.** Es la trampa perfecta: todo lo demás
(HTML, CSS, el propio módulo JS de la tool) puede estar perfecto y el ícono sigue "muerto".

### Cómo se descubrió (Host Stats, commit `cb93a62`)

La primera versión del panel (`553c87a`) enganchó el listener de apertura **directamente sobre el
nodo del rail**:

```js
// hostStats.js — VERSIÓN ROTA (no abría nada desde el rail)
const rail = $('rail-hoststats');
if (rail) rail.addEventListener('click', toggle);
```

Esto es exactamente el patrón que uno esperaría en una SPA "normal" (un botón, un listener). Pero en
Odysseus el rail-button real tiene su listener puesto por `_railToolMap` (arriba) — y como ESE
listener SÍ se registró (el rail-id existe como key... no, en este caso ni siquiera existía la key
todavía), el click en `rail-hoststats` no encontraba ninguna entrada en el mapa y no pasaba nada. El
fix (`cb93a62`) fue doble: (a) agregar la entrada al mapa, (b) mover el listener real al botón del
sidebar, que es donde debe vivir según el patrón del resto de las tools:

```js
// static/app.js — el fix, línea 3751
'rail-hoststats': 'tool-hoststats-btn',
```

```js
// hostStats.js — VERSIÓN CORRECTA
// Odysseus opens every tool through its `tool-*-btn`; the icon-rail launcher
// just forwards its click to that button via app.js's `_railToolMap` (where
// `rail-hoststats` → `tool-hoststats-btn` is registered). So wire the tool
// button — NOT the rail node directly, which the rail dispatch bypasses.
const toolBtn = $('tool-hoststats-btn');
if (toolBtn) toolBtn.addEventListener('click', toggle);
```

**Regla operativa:** el botón `rail-*` NUNCA lleva su propio listener de apertura. Solo necesita
existir como key en `_railToolMap` apuntando a su `tool-*-btn`. Todo el comportamiento real
(abrir/cerrar/toggle) se engancha en el botón del SIDEBAR — sea con un `addEventListener` inline en
`app.js` (ver sección 4) o dentro del módulo propio de la tool, como hizo `hostStats.js`.

## 4. El OPEN handler de la tool

El listener real que abre el panel va en el botón del sidebar (`tool-TUTOOL-btn`), no en el del
rail. Dos patrones vistos en el código:

**Patrón A — inline en `app.js`** (la mayoría de las tools "modal clásico"). Ejemplo real, Cookbook
(`static/app.js`, líneas 1015-1027):

```js
// ── Cookbook modal toggle ──
const toolCookbookBtn = el('tool-cookbook-btn');
if (toolCookbookBtn) {
  toolCookbookBtn.addEventListener('click', async () => {
    if (!cookbookModule) return;
    // Try minimized→restore or open→minimize via the manager first
    const Modals = await import('./js/modalManager.js');
    if (!Modals.toggle('cookbook-modal')) {
      // Not registered yet → fresh open
      cookbookModule.open();
    }
  });
}
```

Nota el uso de `Modals.toggle('cookbook-modal')` (de `modalManager.js`, ver sección 5): primero
intenta minimizar/restaurar vía el manager; si el modal no está registrado ahí todavía, cae al
`open()` fresco del módulo propio de la tool.

**Patrón B — dentro del propio módulo de la tool** (como `hostStats.js`, ver sección 3): el módulo
importa nada de `modalManager.js` para el toggle y maneja su propio estado abierto/cerrado con una
función `toggle()`/`close()` local, enganchada directamente al `tool-*-btn`. Es el patrón correcto
cuando la tool es "self-contained" (un solo endpoint, su propio DOM, sin necesidad de que
`app.js` sepa nada de su estado interno) — pero el modal SÍ conviene registrarlo en
`modalManager.js` aparte (sección 5) para que el minimizar/restaurar del dock funcione iguales que
las demás tools.

Elige A si tu tool vive mayormente en `app.js` o es simple; elige B si estás creando un módulo
nuevo dedicado (`static/js/tuTool.js`) con su propio estado.

## 5. `modalManager.js` — minimizar/restaurar y el dock (NO es para abrir)

**Aclaración importante primero: `modalManager.js` NO abre tools.** Su trabajo es exclusivamente
"¿qué pasa cuando minimizas un modal ya abierto?" (lo manda a un chip del dock inferior) y
"¿cómo lo restauras?" (click en el chip, o click de nuevo en el rail/sidebar). Confundir esto con
el mecanismo de apertura (sección 3-4) es el segundo error más común al agregar una tool nueva.

Dos piezas relevantes, ambas alrededor de la línea 1400+:

**a) `_LABELS`** (línea 129) — el texto + ícono que se muestra en el chip del dock cuando la tool
está minimizada:

```js
// static/js/modalManager.js, línea 130
'cookbook-modal':    { label: 'Cookbook',  icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>' },
```

El `icon` acepta dos formas: un string `path d="…"` plano (el renderer del dock lo envuelve en su
propio `<svg>`), o un **SVG completo como string** si necesitas más de un `<path>` — el renderer
detecta esto por la presencia de `<` en el string (ver comentario en línea 136-138, caso `memory-modal`).

**b) `_AUTO_WIRE`** (línea 1404) — asocia el id del modal con sus botones rail/sidebar, para que el
manager sepa a cuál aplicarle el badge de "abierto" y a cuál restaurar:

```js
// static/js/modalManager.js, líneas 1404-1405
const _AUTO_WIRE = {
  'cookbook-modal':       { rail: 'rail-cookbook',  sidebar: 'tool-cookbook-btn' },
  ...
```

El id de la IZQUIERDA (`'cookbook-modal'`) es el `id` del `<div class="modal" id="cookbook-modal">`
en el HTML (sección 6) — **no** el id del botón. Host Stats, tras el fix de `6b496ba`, quedó
registrado así:

```js
'hoststats-modal':      { rail: 'rail-hoststats', sidebar: 'tool-hoststats-btn' },
```

(La primera versión, en `553c87a`, tenía `sidebar: null` porque todavía no existía el botón del
sidebar — otro recordatorio de que los 3 registros — rail, sidebar, `_railToolMap` — deben nacer
JUNTOS, no en tandas separadas.)

Si necesitas comportamiento custom al minimizar/restaurar (rebuild del DOM al restaurar, por
ejemplo), usa `register(id, { restoreFn, closeFn, railBtnId, sidebarBtnId, label, icon })`
(`modalManager.js` línea 1146) en vez de depender solo del auto-wire; `toggle(id)` (línea 1297) es
la función que decide minimizar-si-abierto / restaurar-si-minimizado.

## 6. Estructura del modal (`.modal` / `.modal-content` / `.modal-header`)

El HTML del modal en sí (fuera del rail/sidebar) sigue siempre esta forma, ejemplo real de Host
Stats (`553c87a`, insertado antes de la cadena de `<script type="module">` al final de `index.html`):

```html
<div id="hoststats-modal" class="modal hidden">
  <div class="modal-content hoststats-content" role="dialog" aria-label="Host Stats">
    <div class="modal-header hoststats-header">
      <h4><svg …/>Host Stats</h4>
      <div class="hoststats-header-actions">
        <span class="hoststats-live-dot" id="hoststats-live-dot" title="Live"></span>
        <button class="close-btn" id="close-hoststats-modal" aria-label="Close host stats">✖</button>
      </div>
    </div>
    <div class="modal-body hoststats-body" id="hoststats-body">
      <div class="hoststats-loading">[ CONNECTING… ]</div>
    </div>
  </div>
</div>
<script type="module" src="/static/js/hostStats.js"></script>
```

Reglas de estructura (`static/style.css`, definiciones base):
- `.modal` (línea 5597): `position:fixed; top:0; left:0; width:100%; height:100%;` +
  `display:flex; align-items:center; justify-content:center;` + `pointer-events:none;`. Es el
  overlay de fondo — invisible (`background:none`) y con `pointer-events:none` para no bloquear
  clicks fuera del contenido. Empieza oculto con la clase `.modal.hidden { display:none; }`
  (línea 5610) — tu JS alterna esa clase para abrir/cerrar.
- `.modal-content` (línea 5639): el panel visible de verdad — `background:var(--panel)`,
  `border:1px solid var(--border)`, `width:min(520px, 92vw)`, `border-radius:10px`,
  `box-shadow`, `pointer-events:auto` (contrarresta el `none` del padre `.modal`). Trae la
  animación `modal-enter 0.25s ease-out` al aparecer.
- `.modal-header` (línea 5663): `cursor:grab` + `position:sticky; top:0;` (para que el botón de
  cerrar quede siempre visible aunque el body haga scroll) + `background-color:inherit` (para que
  el header coincida con el fondo que el contenido eligió, `--bg` o `--panel`).
- **Cómo se posiciona realmente cuando arrastras**: por default `.modal` centra `.modal-content`
  vía flexbox (`align-items:center; justify-content:center`). En cuanto el usuario empieza a
  arrastrar el header, `makeWindowDraggable` (sección 7) **pisa ese centrado** poniendo
  `content.style.position = 'fixed'` + `left`/`top` en px absolutos (`windowDrag.js`, líneas
  168-170) — de ahí en adelante el modal ya no depende del flexbox del padre, vive en coordenadas
  de pantalla fijas hasta que se cierre y reabra (momento en que vuelve a centrarse, porque el
  estilo inline no persiste entre aperturas salvo que tu tool lo guarde en localStorage).
- En viewport ≥769px, algunas tools (`#calendar-modal`, `#gallery-modal`, `#tasks-modal`,
  `#memory-modal`, `#doclib-modal`, `#compare-model-overlay`, `#research-overlay`, `#theme-modal`,
  `#settings-modal`, `#email-lib-modal` — línea 5620) se centran en el ÁREA DE CHAT (a la derecha
  del rail+sidebar), no en el viewport completo — vía `left: calc(var(--icon-rail-w)…)`. Si tu
  tool debe compartir ese comportamiento, añade su `#tuTool-modal` a esa lista de selectores.

## 7. `makeWindowDraggable` (`static/js/windowDrag.js`) — arrastre, resize y snap

Import y llamada mínima, patrón usado por Host Stats (`feat/host-stats-panel`, `hostStats.js`):

```js
import { makeWindowDraggable } from './windowDrag.js';
// … dentro de tu init/open():
const modal = document.getElementById('hoststats-modal');
const content = modal.querySelector('.modal-content');
const header = modal.querySelector('.modal-header');
if (content && header) makeWindowDraggable(modal, { content, header });
```

`makeWindowDraggable(modal, options)` (`static/js/windowDrag.js` línea 57) es el helper compartido
que reemplaza el mousedown/mousemove/mouseup + snap-to-top que ANTES estaba copy-pasteado en
`calendar.js`, `tasks.js`, `gallery.js`, `emailLibrary.js`, `documentLibrary.js`, `theme.js`.
`content`/`header` son obligatorios (sin ellos la función retorna sin hacer nada, línea 60); todo lo
demás es opcional:

| Opción | Qué hace | Default |
|---|---|---|
| `fsClass` | clase CSS que representa "fullscreen" | ninguna |
| `onEnterFullscreen` / `onExitFullscreen` | callbacks al hacer snap al borde superior | ninguno |
| `skipSelector` | selector de elementos del header que NO deben iniciar el drag | `'button, input, select'` |
| `mobileSkip` | ancho de viewport bajo el cual se desactiva el drag | `768` |
| `enableDock` | habilita snap a los bordes izquierdo/derecho | `true` |
| `enableLeftDock` | permite explícitamente el dock IZQUIERDO (además del derecho) | `true` |
| `enableResize` | activa resize de bordes/esquinas (vía `windowResize.js`) | `true` |
| `minWidth` / `minHeight` | tamaño mínimo al redimensionar | `MIN_W=320` / `MIN_H=200` (`windowResize.js` líneas 26-27) |
| `resizeStorageKey` | key de localStorage para persistir el tamaño | `'winsize-' + modal.id` |
| `onDragEnd` | callback tras soltar (si no hubo snap) | ninguno |
| `enableTouch` | también cablea touchstart/touchmove/touchend | `true` |

Ningún callsite actual pasa `minWidth`/`minHeight` explícito — los defaults (320×200px) alcanzan
para casi cualquier panel; solo pásalos si tu contenido necesita un piso más alto (p. ej. una tabla
ancha).

Ejemplo con más opciones, Cookbook (`static/js/cookbook.js`, función `_wireCookbookDrag`):

```js
makeWindowDraggable(modal, {
  content, header,
  skipSelector: '.close-btn, .modal-close',
  // Keep only the "close to the edge" dock gesture for Cookbook. The
  // tileManager side snap is suppressed for this modal so there isn't a
  // second, tighter edge state fighting the working one.
  enableDock: true,
});
```

`makeWindowDraggable` internamente también activa el resize de bordes/esquinas (línea 80-93, vía
`makeWindowResizable` de `windowResize.js`) y el snap a los bordes L/R (`makeEdgeDockController` de
`modalSnap.js`, líneas 95-100) — no necesitas cablearlos aparte.

## 8. `ui_visibility.js` `UI_VIS_MAP` — mostrar/ocultar en Settings

`static/js/ui_visibility.js` controla los checkboxes de Settings → Appearance → "Customize UI".
`UI_VIS_MAP` (línea 13) mapea una key lógica a el o los selectores CSS que oculta/muestra; los
pares "tool" agrupan el botón del sidebar CON su launcher del rail en una sola entrada, para que
ocultar la tool la oculte en ambas superficies a la vez:

```js
// static/js/ui_visibility.js, líneas 13-30
export const UI_VIS_MAP = {
  ...
  'tool-calendar':       '#tool-calendar-btn, #rail-calendar',
  'tool-compare':        '#tool-compare-btn, #rail-compare',
  'tool-cookbook':       '#tool-cookbook-btn, #rail-cookbook',
  'tool-research':       '#tool-research-btn, #rail-research',
  'tool-gallery':        '#tool-gallery-btn, #rail-gallery',
  'tool-library':        '#tool-library-btn, #rail-archive',
  'tool-memory':         '#tool-memory-btn, #rail-memory',
  'tool-notes':          '#tool-notes-btn, #rail-notes',
  'tool-tasks':          '#tool-tasks-btn, #rail-tasks',
  'tool-theme':          '#tool-theme-btn, #rail-theme',
  ...
};
```

Tu entrada nueva: `'tool-TUTOOL': '#tool-TUTOOL-btn, #rail-TUTOOL'`. La convención de nombres del
id del rail no siempre calca el nombre de la tool 1:1 (`tool-library` → `#rail-archive`, no
`#rail-library` — mira el id real que le pusiste en el paso 1, no lo adivines).

Nota de estado real de este fork: al momento de escribir este manual, **Host Stats NO tiene entrada
en `UI_VIS_MAP`** — es un hueco real en la rama `feat/host-stats-panel`, no algo intencional que
debas imitar. Si portas Host Stats a `dev` o agregas una tool nueva, sí registra la entrada — sin
ella el usuario no puede ocultar tu tool desde Settings.

Un detalle de `resolveVisibility()` (línea 64-73) que afecta a toda entrada `tool-*`: si el usuario
apaga la key `'tools-section'` (esconde la sección completa de Tools), **todas** las keys que
empiezan con `tool-` se fuerzan a invisibles sin importar su propio valor guardado (línea 69) — no
necesitas replicar esa lógica, ya aplica automáticamente a tu entrada nueva por el prefijo del
nombre.

## 9. Service Worker / PWA (`static/sw.js`) — cachear tu archivo nuevo

Si tu tool agrega un `.js` nuevo cargado con `<script type="module" src="…">` en `index.html`
(patrón normal — ver sección 6), dos cosas:

**a) Bump `CACHE_NAME`** (línea 10) — CUALQUIER cambio al precache o a la lógica del SW exige subir
este string, o los clientes con el Service Worker ya instalado seguirán sirviendo los archivos
viejos desde caché indefinidamente:

```js
// static/sw.js, línea 10 — este fork, HEAD actual:
const CACHE_NAME = 'odysseus-v380-shared-config-image-editor-lazy-katex-mermaid';
// al agregar Host Stats (feat/host-stats-panel), se bumpeó a:
const CACHE_NAME = 'odysseus-v381-hoststats-panel';
```

Convención: `odysseus-v<N+1>-<slug-corto-de-qué-cambió>`.

**b) Agrega tu archivo a la lista `PRECACHE`** (arranca en línea 40) — es la lista que "mirror-ea"
los `<script type="module">` de `index.html` (comentario en línea 29-31). **Gotcha real detectado
en este mismo fork:** la rama `feat/host-stats-panel` bumpeó `CACHE_NAME` pero **nunca agregó
`/static/js/hostStats.js` a `PRECACHE`** — funciona igual mientras el usuario esté online (el
navegador lo pide por red normal), pero rompe el caso "abrir Host Stats estando offline" que
`PRECACHE` existe para cubrir. No repitas ese hueco: si tu script se carga vía `<script
type="module">` en el shell principal, va en `PRECACHE`; si en cambio es un panel que otro módulo
importa solo al primer uso (patrón lazy), va en la lista hermana `PANEL_PRECACHE` (comentario línea
32-36) — ninguna de las dos es opcional, sino que definen DÓNDE va tu archivo, no SI debe ir.

### ⚠️ El gotcha de caché en HTTP inseguro

`navigator.serviceWorker.register(...)` (`static/index.html` línea 2589) es una API de plataforma
restringida a **contextos seguros** (HTTPS, o `localhost`/`127.0.0.1`). **Un usuario accediendo a
Odysseus por HTTP plano en una IP de LAN (`http://192.168.x.x:puerto`, típico de un servidor
casero) simplemente NO TIENE Service Worker registrado — nunca lo tuvo, no es que se le haya roto.**

Consecuencia práctica: si ese usuario reporta "no veo la tool nueva" o "sigo viendo la versión
vieja", **NO le pidas que desregistre el Service Worker ni que limpie el caché del SW** — no tiene
uno que limpiar. El navegador simplemente sirvió su copia normal de HTTP-cache del `index.html`/JS
viejos. El fix correcto en ese caso es un **hard reload** (`Ctrl+Shift+R` / `Cmd+Shift+R`, o abrir
DevTools → click derecho en el botón de recargar → "Empty Cache and Hard Reload"), que ignora la
caché HTTP normal del navegador y vuelve a pedir todo por red.

Para el usuario que SÍ está en HTTPS (o localhost) y SÍ tiene Service Worker activo, el bump de
`CACHE_NAME` (arriba) es lo que fuerza la actualización — el SW detecta el nombre de caché nuevo,
descarga el precache actualizado, y sustituye la versión vieja en el próximo control de vida del SW
(típicamente al recargar la pestaña una vez que el nuevo SW terminó de instalarse en segundo plano).

---

## Resumen — mapa completo de archivo:línea (este fork, rama `docs/rail-tool-manual`)

| Qué | Archivo | Línea aprox. |
|---|---|---|
| Botón del rail (bloque "Tool launchers") | `static/index.html` | 734-745 (ej. Cookbook 737) |
| Botón del sidebar (`#tools-section`) | `static/index.html` | 888-898 (Cookbook) |
| `_railToolMap` | `static/app.js` | 3739-3760 |
| OPEN handler patrón A (inline) | `static/app.js` | 1015-1027 (Cookbook) |
| `_LABELS` (dock chip) | `static/js/modalManager.js` | 129-150 |
| `_AUTO_WIRE` (rail/sidebar↔modal-id) | `static/js/modalManager.js` | 1404-1424 |
| `register()` / `toggle()` | `static/js/modalManager.js` | 1146 / 1297 |
| `.modal` / `.modal-content` / `.modal-header` base | `static/style.css` | 5597 / 5639 / 5663 |
| Centrado en área de chat (≥769px) | `static/style.css` | 5620-5638 |
| `makeWindowDraggable` | `static/js/windowDrag.js` | 57 |
| Posicionamiento `position:fixed` al arrastrar | `static/js/windowDrag.js` | 168-170 |
| `MIN_W` / `MIN_H` default de resize | `static/js/windowResize.js` | 26-27 |
| `UI_VIS_MAP` | `static/js/ui_visibility.js` | 13-46 |
| `resolveVisibility()` (regla `tools-section`) | `static/js/ui_visibility.js` | 64-73 |
| `CACHE_NAME` | `static/sw.js` | 10 |
| `PRECACHE` (lista) | `static/sw.js` | 40+ |
| `serviceWorker.register(...)` | `static/index.html` | 2589 |

## Referencias de commits usados como fuente (rama `feat/host-stats-panel`, no mergeada a `dev`)

- `553c87a` — Add native Host Stats panel (primera versión; rail button + modal + módulo, PERO con
  el bug del GOTCHA #1: listener puesto sobre `rail-hoststats` directo).
- `6b496ba` — compact mode, entrada de sidebar, `makeWindowDraggable`, bump de `CACHE_NAME`.
- `cb93a62` — **el fix del GOTCHA #1**: registra `rail-hoststats → tool-hoststats-btn` en
  `_railToolMap` y mueve el listener de apertura al botón del sidebar.
- `a7d0aad`, `12f269c` — iteraciones de compact mode / docking del panel (fuera del alcance de este
  manual, sobre UX del contenido interno del panel, no del mecanismo de apertura).
