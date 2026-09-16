# El estado del shell del workspace

> Cimiento del ítem **#29** del roadmap de axon (*"El SHELL del workspace: un estado, no N
> localStorage sueltos"*). Este documento describe lo que YA está construido en el fork, no un plan.

## El problema que resuelve

El workspace no tenía modelo de estado. Cada widget persistía su pedacito con su propia llave de
`localStorage`, y **nada sabía qué módulos estaban abiertos ni dónde**. De ahí que un reload perdiera
el workspace, que el modo full/compact fuera un truco privado del host stats, y que cada feature nueva
(tiling, rail como proyección, regiones reservadas por borde) tuviera que inventarse su octava llave.

### Inventario del desperdigado (medido, 2026-09-07)

Estado de UI que vivía —y en varios casos sigue viviendo— en `localStorage`, por archivo:

| qué recuerda | llave | dónde |
|---|---|---|
| modo full↔compact del host stats | `odysseus.hostStats.viewMode.v1` | `static/js/hostStats.js` → **migrado al shell state** |
| lado dockeado por modal | `odysseus-modal-remembered-dock-<id>` | `static/js/modalManager.js` → **espejeado al shell state** |
| chips minimizados + posición del dock | `odysseus.mobileDockState.v1` | `static/js/modalManager.js` |
| ancho del dock lateral | `odysseus-edge-dock-width:<lado>:<id>` | `static/js/modalSnap.js` |
| ancho del split email/documento | `odysseus-email-doc-split-width` | `static/js/modalSnap.js` |
| tamaño de una ventana (opcional, por tool) | el `storageKey` que le pasen | `static/js/windowResize.js` |
| modo del sidebar (full/rail) | `odysseus-sidebar-mode` | `static/js/sidebar-layout.js` |
| ancho/colapso del sidebar de settings | `odysseus-settings-sidebar-width`, `…-collapsed` | `static/js/settings/sidebar.js` |
| posición de la ventana de la biblioteca | `doclib-pos` | `static/js/documentLibrary.js` |
| panel de documento abierto/minimizado por sesión | `odysseus-doc-open-<sid>`, `odysseus-doc-minimized-<sid>` | `static/js/document.js`, `static/app.js` |
| tamaño de fuente del documento | `odysseus-doc-fontsize` | `static/js/document.js` |
| ancho del panel derecho del editor | `ge-right-panel-width` | `static/js/editor/build/right-panel.js` |
| posición del popover de atajos | `ge-shortcuts-pos` | `static/js/editor/shortcuts-popover.js` |
| secciones colapsadas de skills | `skillsSectionsCollapsed` | `static/js/skills.js` |
| vista de notas (lista/grid) | `odysseus-notes-view` | `static/js/notes.js` |
| filtros/inicio de semana/altura del calendario | `cal-filters-collapsed`, `cal-week-start`, `cal-wk-hour-px`, `odysseus.cal.detailH` | `static/js/calendar.js` |
| escala de UI | `odysseus-ui-scale` | `static/js/theme.js` |
| colapso del sidebar y orden de secciones | `sidebar-collapsed`, `sidebar-width`, `sidebar-section-order` | `static/js/storage.js` (constantes) |
| **qué módulos estaban abiertos** | **no existía** | — |
| **posición/tamaño de una ventana abierta** | **un `Map` en memoria; moría en el reload** | `static/js/modalManager.js` |

Las dos últimas filas son el agujero: **el shell no sabía qué tenía abierto.**

## Dónde vive el estado, y por qué NO en `localStorage`

En el **servidor**, bajo `/api/prefs/workspace-state` — por **usuario**, no por navegador.

No es preferencia de arquitectura, lo fuerza el requisito: el workspace tiene que sobrevivir a un
**signout/signin**, y el propio producto **borra `localStorage` al salir**, a propósito y por
seguridad:

- `static/js/settings.js` — el botón de Logout vacía todo `localStorage` (salvo `odysseus-last-user`)
  para que la siguiente cuenta no herede sesión, modelo ni listas de la anterior.
- `static/js/init.js` — si el usuario autenticado difiere del cacheado, hace el mismo barrido.

Es decir: cualquier cosa guardada sólo en `localStorage` se borra **justo en el momento** en que
haría falta restaurarla. `localStorage` se queda como **caché optimista** (primer pintado síncrono y
degradación digna si el endpoint no responde), nunca como fuente de verdad.

`/api/prefs` ya era per-usuario y guarda JSON arbitrario (`routes/prefs_routes.py`, particionado por
`owner` en `_users`), así que **no hizo falta tabla ni endpoint nuevo**: cero cambios de backend.

## Piezas

| archivo | rol |
|---|---|
| `static/js/workspaceState.js` | el estado: lectura síncrona de caché, merge con el servidor por registro, escritura debounced, migración de las llaves viejas |
| `static/js/workspaceRestore.js` | el pase de arranque: reabre lo que estaba abierto y **arma** el tracking |
| `static/js/modalManager.js` | reporta al estado (abrir/minimizar/cerrar/dock) con **un solo barrido** de visibilidad |
| `static/js/hostStats.js` | primer consumidor: su modo full/compact ya es del shell, no suyo |
| `static/app.js` | dispara `restoreWorkspace()` tras el route opener |
| `tests/workspace_state.test.mjs` | fija el contrato (`node --test`) |

### Forma del estado (v1)

```jsonc
{
  "v": 1, "updatedAt": 0, "migrated": true,
  "modules": {
    "<instanceId>": {
      "module": "hoststats-modal",   // QUÉ es (tipo)
      "open": true, "minimized": false,
      "mode": "full",                // full | compact | null
      "dock": "right",               // left | right | null
      "geom": null,                  // { x, y, w, h } — reservado, ver abajo
      "openedAt": 0, "updatedAt": 0
    }
  }
}
```

La **llave** del registro es un id de instancia y `module` es su tipo. Hoy son la misma cadena (el id
del modal) porque cada tool es singleton; están separados para que **#29(a)** —varias terminales a la
vez— entre sin migrar el esquema.

### Cómo lo consume un módulo

```js
import WorkspaceState from './workspaceState.js';

// Arranque: la caché contesta síncrono, sin esperar red.
const mode = WorkspaceState.get('mi-modal')?.mode || 'full';

// Y cuando llega lo del servidor (otro dispositivo, o vuelta de un signout):
WorkspaceState.ready().then(() => { /* re-aplicar si cambió */ });

// Al cambiar algo:
WorkspaceState.setMode('mi-modal', 'compact');
```

Abrir/minimizar/cerrar **no se reporta a mano**: lo deriva el barrido de `modalManager`.

### Por qué un barrido y no N llamadas

Los ~20 tools se abren de 20 maneras distintas (unos alternan `.hidden`, otros `display`, otros
reconstruyen el nodo). Pedirle a cada uno que reporte significaría editar cada módulo y olvidar los
que vengan después. El escaneo de `modalManager` ya corría cada segundo para inyectar el botón de
minimizar, así que leer visibilidad en la misma pasada sale gratis y cubre solo por estar en
`_AUTO_WIRE`.

Dos detalles que lo hacen no-tonto:

- **Armado del tracking.** Al cargar la página no hay nada abierto todavía; un barrido sin armar
  escribiría `open: false` sobre todo lo que el usuario dejó abierto — borraría justo lo que se va a
  restaurar. `workspaceRestore` arma el tracking cuando termina su pase.
- **Nodo ausente ≠ cerrado, salvo que lo hayamos visto abierto.** Varios tools (gallery, calendar,
  notas) construyen su modal al abrir y lo **quitan del DOM** al cerrar. Sólo se marca cerrado un
  módulo cuyo nodo vimos vivo en esta sesión; si no, un tool lento en aparecer borraría su propio
  registro.

## Migración de lo que ya estaba guardado

`workspaceState` **rellena huecos** con las llaves viejas (modo del host stats, lado dockeado por
modal) para que nadie pierda su layout al desplegar. Reglas:

- **Sólo rellena** campos que el estado no define; nunca pisa.
- Corre **dos veces**: una síncrona contra la caché (con marca de tiempo antigua a propósito, para que
  el servidor siempre gane el merge) y otra tras el merge del servidor.
- **No borra las llaves viejas.** Este release se puede revertir y los widgets siguen encontrando lo
  suyo.

## Qué NO hace todavía (siguiente slice, a propósito)

- **Geometría.** `geom` está en el esquema y `setGeometry()` existe, pero nadie la escribe ni la
  restaura: reponer posición/tamaño en ~20 ventanas con modelos de overflow y dock distintos es su
  propio pase, con su QA visual. Media restauración es peor que ninguna. El **tiling estilo Rectangle**
  (#29d) es el consumidor natural de ese campo: necesita la geometría de **todas** las ventanas a la vez.
- **Chips minimizados.** El flag `minimized` sí se persiste, pero reponer un chip exige abrir el modal
  y luego minimizarlo — un parpadeo en cada carga. Se restaura lo que estaba **visible**.
- **Módulos sin lanzador** (`email-lib-modal` no tiene botón en `_AUTO_WIRE`): se recuerdan pero no se
  pueden reabrir todavía.
- `ge-shortcuts-modal` y `custom-preset-modal` están excluidos del pase: son popovers efímeros.
