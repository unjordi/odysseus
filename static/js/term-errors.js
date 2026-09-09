// static/js/term-errors.js — clasificación PURA de los errores/cierres del canal de Terminal (PTY por
// WebSocket y el runner one-shot por SSE). Sin DOM, sin WebSocket real: solo texto entra, texto sale — se
// puede probar offline (`tests/test_term_errors_js.py`, corrido bajo Node).
//
// POR QUÉ EXISTE (hallazgo A-2 de la auditoría de coherencia, 2026-09): el broker de terminal (repo axon,
// `src/server/term-host-broker.ts` + `term-session.ts`) tiene DOS techos independientes —
//   · PTYs concurrentes (`/pty`, WS): rechaza el HANDSHAKE con `503`.
//   · sesiones de shell (`/run`, one-shot SSE): rechaza con `event: error` + texto `SESSION_LIMIT: …`.
// Antes de este archivo, el cliente mostraba el MISMO texto genérico ("broker inalcanzable"/"[error]
// desconocido") para "se llegó al techo" que para "no hay broker" — dos causas OPUESTAS (una se arregla
// cerrando una terminal propia, la otra revisando el servicio) indistinguibles para quien las lee.
//
// CONTRATO REAL verificado en axon (rama `feat/broker-conciliar-axon-cortex`, no inventado):
//   · Techo de PTYs — term-host-broker.ts `handlePtyUpgrade`: `rejectWebSocket(socket, 503, "too many pty
//     sessions (N/M) - AXON_TERM_BROKER_MAX_PTYS")`. Esos números viajaban SOLO en la REASON PHRASE http del
//     rechazo, y `wsConnect()` (ws.ts) se quedaba solo con `res.statusCode` — un "HTTP 503" pelón, sin
//     números. **Cerrado del lado del servidor (2026-09-08, mismo día):** `wsConnect()` ahora lee
//     `res.statusMessage` y lo pega al error: `"WS upgrade rechazado: HTTP 503 — too many pty sessions
//     (7/8) - AXON_TERM_BROKER_MAX_PTYS"`. Los números SÍ llegan al cliente — se extraen con
//     `PTY_LIMIT_PATTERN` de abajo. Probado del lado del servidor con un rechazo real
//     (`probe-ws-keepalive.ts`, bloque h, 21/21).
//   · Techo de sesiones de shell — term-session.ts `ShellSessionPool.run()`: `onDone(null, "SESSION_LIMIT:
//     el broker ya tiene N sesiones de shell abiertas (tope M). Cierra alguna terminal, o sube
//     AXON_TERM_BROKER_MAX_SESSIONS si de verdad necesitas más.")`. Ese texto viaja INTACTO (pipe byte-a-
//     byte de `forwardTermToHostBroker`) hasta `payload.error` del SSE — con sus números — así que aquí SÍ
//     se reusa tal cual.
//   · Presión de buffer — ws.ts `checkBackpressure()`: cierra la conexión con código `1013` y una razón que
//     YA trae los bytes: "cliente no drena: <N> B pendientes sobre el techo de <M> B".
//   · Cierre RELEVADO (axon↔broker → navegador) — `relayWsToWs()` (term-pty-bridge.ts) antes re-cerraba el
//     otro lado con un `1000`/`1011` fijo, así que un `1013` del salto de allá llegaba al navegador como
//     "peer closed" genérico: el mismo síntoma de A-2, en un tercer sitio. **También cerrado del lado del
//     servidor**: ahora propaga el código real (salvo `1005`/`1006`, que el RFC prohíbe reenviar) con la
//     razón prefijada `peer: <razón original>` (o `peer: cierre sin motivo` si no traía razón); un error de
//     socket del relevo (no un cierre) llega como `1011` con razón `peer error: <mensaje>`. El código
//     sigue siendo la señal fuerte (un 1013 relevado es backpressure igual que uno directo); el prefijo
//     `peer(?: error)?: ` se pela antes de mostrarlo, para no anidar el texto.
//   · Cualquier otro cierre: se muestra el código + la razón que el servidor haya mandado, nunca se tragan.

/** Código de cierre WS que ws.ts usa para la válvula dura de backpressure (ver el comentario de arriba). */
export const BUFFER_PRESSURE_CLOSE_CODE = 1013;

/** Cierre "normal" (RFC 6455) — no amerita un mensaje de error, solo el aviso de desconexión de siempre. */
export const NORMAL_CLOSE_CODE = 1000;

// Patrón LITERAL de `rejectWebSocket(socket, 503, "too many pty sessions (N/M) - AXON_TERM_BROKER_MAX_PTYS")`
// (term-host-broker.ts). Se busca en cualquier parte del texto —no se asume que el string TERMINE en el
// código ni en el patrón—, porque `wsConnect()` antepone `WS upgrade rechazado: HTTP 503 — ` y
// `brokerUnreachableMsg()` puede además ANEXAR su propia pista después. Ancla en el texto exacto
// "too many pty sessions", no en el número de estado 503 (que en teoría podría reusarse para otra cosa).
const PTY_LIMIT_PATTERN = /too many pty sessions \((\d+)\/(\d+)\)/;
// Fallback defensivo si el 503 llegara algún día SIN el detalle (p. ej. un proxy intermedio que recorta la
// reason phrase): sigue siendo un techo, solo que sin números que mostrar.
const PTY_LIMIT_MARKER_SIN_NUMEROS = 'HTTP 503';
const SESSION_LIMIT_MARKER = 'SESSION_LIMIT:';
// Prefijo LITERAL de `brokerUnreachableMsg()` (axon, http-server.ts) — el ÚNICO lugar donde el servidor arma
// este texto es el catch de "no se pudo abrir/mantener el canal al broker host-side" (handleTermPtyUpgrade
// y forwardTermToHostBroker). Es la única señal segura de "no hay broker / no responde": otros `o.error`
// (p. ej. un PTY que no pudo spawnear DENTRO del contenedor, `pty-session.ts` `child.on("error", …)`, o un
// `MISSING_ARG` del one-shot) NO tienen nada que ver con el broker y no deben etiquetarse como tal.
const BROKER_UNREACHABLE_MARKER = 'term broker inalcanzable';

/**
 * Clasifica el texto de error que manda el servidor — `o.error` del WS del PTY (`{type:'error',error}`) o
 * `payload.error` del SSE one-shot — en un caso ACCIONABLE. Nunca fabrica números que el texto no traiga, y
 * nunca le atribuye al broker un error que no es suyo: si el texto no calza con ninguno de los patrones
 * verificados contra el servidor, se muestra TAL CUAL (mismo comportamiento que antes de este archivo).
 *
 * @param {unknown} raw El texto de error tal cual llegó (se tolera cualquier cosa; solo se usa si es string).
 * @returns {{ kind: 'limit'|'unreachable'|'other', message: string }}
 */
export function classifyTermErrorText(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { kind: 'other', message: 'desconocido' };

  if (text.includes(SESSION_LIMIT_MARKER)) {
    // El servidor YA manda los números en un texto claro — se reusa completo, solo se le quita el prefijo
    // técnico del código.
    const detail = text.slice(text.indexOf(SESSION_LIMIT_MARKER) + SESSION_LIMIT_MARKER.length).trim();
    return { kind: 'limit', message: `Se alcanzó el límite de terminales del host. ${detail || text}` };
  }

  const ptyLimit = text.match(PTY_LIMIT_PATTERN);
  if (ptyLimit) {
    const [, live, max] = ptyLimit;
    return {
      kind: 'limit',
      message: `Se alcanzó el límite de terminales simultáneas del host (${live}/${max}). Cierra una terminal que no estés usando e inténtalo de nuevo.`,
    };
  }

  if (text.includes(BROKER_UNREACHABLE_MARKER)) {
    if (text.includes(PTY_LIMIT_MARKER_SIN_NUMEROS)) {
      // Mismo caso de arriba pero sin los números (ver el comentario del fallback): un 503 sigue siendo un
      // techo, solo que esta vez el detalle no llegó completo. No se inventan cifras.
      return {
        kind: 'limit',
        message: 'Se alcanzó el límite de terminales simultáneas del host. Cierra una terminal que no estés usando e inténtalo de nuevo.',
      };
    }
    return { kind: 'unreachable', message: `El servicio de terminal del host no está disponible: ${text}` };
  }

  return { kind: 'other', message: text };
}

/** Prefijo que `relayWsToWs()` antepone a la razón original al re-cerrar el otro lado del relevo. */
const RELAY_REASON_PREFIX = /^peer(?: error)?:\s*/;

/**
 * Clasifica un cierre de WebSocket (`CloseEvent.code`/`.reason`) en el mismo vocabulario. A diferencia de
 * `classifyTermErrorText`, aquí el código SÍ es una señal fuerte (1013 es inequívoco) y domina sobre el
 * texto de la razón — incluido un 1013 RELEVADO desde el hop axon↔broker (`relayWsToWs` ya propaga el
 * código real; ver el comentario del contrato arriba), que se clasifica como presión de buffer igual que
 * uno directo. El prefijo `peer: `/`peer error: ` que el relevo antepone se pela antes de mostrar la razón,
 * para no anidar el texto ("peer: cliente no drena…" → "cliente no drena…").
 *
 * `message` es un FRAGMENTO en minúsculas, sin punto final, pensado para embeberse en algo como
 * `[desconectado: ${message} — reabre la terminal para reconectar]` — nunca un mensaje completo por sí
 * solo (por eso `normal` devuelve `''`: un cierre 1000 no amerita explicación).
 *
 * @param {number} code
 * @param {unknown} reason
 * @returns {{ kind: 'buffer'|'normal'|'generic', message: string }}
 */
export function classifyTermCloseEvent(code, reason) {
  const raw = typeof reason === 'string' ? reason.trim() : '';
  const text = raw.replace(RELAY_REASON_PREFIX, '').trim();

  if (code === BUFFER_PRESSURE_CLOSE_CODE) {
    return {
      kind: 'buffer',
      message: `no se pudo mantener el ritmo de datos, tu conexión no drenaba a tiempo${text ? ` (${text})` : ''}`,
    };
  }
  if (code === NORMAL_CLOSE_CODE) {
    return { kind: 'normal', message: '' };
  }
  return { kind: 'generic', message: `código ${code}${text ? `: ${text}` : ''}` };
}
