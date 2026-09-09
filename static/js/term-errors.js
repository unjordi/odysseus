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
//     sessions (N/M) - AXON_TERM_BROKER_MAX_PTYS")`. Esos números viven en la REASON PHRASE http del
//     rechazo — pero `wsConnect()` (ws.ts) solo captura `res.statusCode` en su `Error`, nunca el body ni el
//     `statusMessage`. Por el hop axon→broker, lo único que sobrevive hasta el mensaje que llega al
//     navegador es el texto `HTTP 503` embebido en `brokerUnreachableMsg()` (http-server.ts). Los números
//     NO llegan al cliente — no se pueden inventar aquí, y por eso el mensaje de este caso es genérico.
//   · Techo de sesiones de shell — term-session.ts `ShellSessionPool.run()`: `onDone(null, "SESSION_LIMIT:
//     el broker ya tiene N sesiones de shell abiertas (tope M). Cierra alguna terminal, o sube
//     AXON_TERM_BROKER_MAX_SESSIONS si de verdad necesitas más.")`. Ese texto viaja INTACTO (pipe byte-a-
//     byte de `forwardTermToHostBroker`) hasta `payload.error` del SSE — con sus números — así que aquí SÍ
//     se reusa tal cual.
//   · Presión de buffer — ws.ts `checkBackpressure()`: cierra la conexión del PTY con código `1013` y una
//     razón que YA trae los bytes: "cliente no drena: <N> B pendientes sobre el techo de <M> B".
//   · Cualquier otro cierre: se muestra el código + la razón que el servidor haya mandado, nunca se tragan.

/** Código de cierre WS que ws.ts usa para la válvula dura de backpressure (ver el comentario de arriba). */
export const BUFFER_PRESSURE_CLOSE_CODE = 1013;

/** Cierre "normal" (RFC 6455) — no amerita un mensaje de error, solo el aviso de desconexión de siempre. */
export const NORMAL_CLOSE_CODE = 1000;

const PTY_LIMIT_MARKER = 'HTTP 503';
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
 * nunca le atribuye al broker un error que no es suyo: si el texto no calza con ninguno de los DOS patrones
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

  if (text.includes(BROKER_UNREACHABLE_MARKER)) {
    if (text.includes(PTY_LIMIT_MARKER)) {
      // El techo SÍ se distingue (es un 503), pero el broker NO manda los números hasta el cliente — ver
      // el comentario del contrato arriba. No se inventan.
      return {
        kind: 'limit',
        message: 'Se alcanzó el límite de terminales simultáneas del host. Cierra una terminal que no estés usando e inténtalo de nuevo.',
      };
    }
    return { kind: 'unreachable', message: `El servicio de terminal del host no está disponible: ${text}` };
  }

  return { kind: 'other', message: text };
}

/**
 * Clasifica un cierre de WebSocket (`CloseEvent.code`/`.reason`) en el mismo vocabulario. A diferencia de
 * `classifyTermErrorText`, aquí el código SÍ es una señal fuerte (1013 es inequívoco), así que domina sobre
 * el texto de la razón.
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
  const text = typeof reason === 'string' ? reason.trim() : '';

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
