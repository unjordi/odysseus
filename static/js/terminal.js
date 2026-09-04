// static/js/terminal.js — widget de Terminal INTERACTIVA (PTY real) del panel de Odysseus.
//
// EVOLUCIÓN: antes era un runner ONE-SHOT (input + Run → <pre> con texto crudo, sin ANSI, sin interactivos:
// los REPL recibían EOF y salían). Ahora es una TERMINAL DE VERDAD: xterm.js (emulador ANSI + teclado) sobre
// un PTY bidireccional servido por axon en `WS /api/axon/term/pty` — corre `claude`/vim/python/top/ssh en TU
// HOST (vía el broker host-side) o en el contenedor, según el modo (badge honesto vía GET /api/axon/term/mode).
//
// TRANSPORTE: WebSocket same-origin (el navegador manda la cookie de sesión de Odysseus sola → el handshake
// de axon la valida; NADA de PTY sin auth). Protocolo (ver term-pty-bridge.ts del repo axon):
//   cliente→servidor: frame BINARY = stdin (keystrokes; Ctrl-C=\x03 viaja como byte) · TEXT = {"type":"resize",cols,rows}
//   servidor→cliente: frame BINARY = salida cruda del PTY (→ term.write) · TEXT = {"type":"exit"|"error",...}
//
// DEGRADACIÓN: si el PTY no está disponible (WS no conecta, o xterm.js no cargó), cae al modo ONE-SHOT
// clásico (input + <pre>, POST /api/axon/term) — que sigue INTACTO en el backend. El badge y el botón Clear
// se conservan en ambos modos.

import { makeWindowDraggable } from './windowDrag.js';

let _wired = false;
let _badgeFetched = false;

// PTY (modo interactivo)
let _term = null;         // instancia de xterm.js
let _fit = null;          // FitAddon
let _ws = null;           // WebSocket del PTY
let _ptyConnected = false;
let _ptyReady = false;    // ya intentamos abrir PTY al menos una vez este open()
let _gotOutput = false;   // ¿el PTY emitió algo? (para degradar si muere instantáneo, p. ej. sin `script`)
let _ptyOpenedAt = 0;
let _resizeObs = null;

// `session` id estable por pestaña (mantenido por compatibilidad con el modo one-shot; el PTY es por-conexión).
const _session = (() => {
  const mk = () => 'term-' + ((globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2));
  try {
    let s = sessionStorage.getItem('axon-term-session');
    if (!s) { s = mk(); sessionStorage.setItem('axon-term-session', s); }
    return s;
  } catch { return mk(); }
})();

function _els() {
  return {
    modal: document.getElementById('term-modal'),
    badge: document.getElementById('term-scope-badge'),
    xterm: document.getElementById('term-xterm'),   // contenedor del emulador (modo PTY)
    oneshot: document.getElementById('term-oneshot'), // contenedor del modo degradado (input + <pre>)
    output: document.getElementById('term-output'),
    input: document.getElementById('term-input'),
    runBtn: document.getElementById('term-run-btn'),
    stopBtn: document.getElementById('term-stop-btn'),
    clearBtn: document.getElementById('term-clear-btn'),
  };
}

/** Badge host/container — idéntico al del modo one-shot (fail-safe a "container"). */
async function _refreshBadge() {
  if (_badgeFetched) return;
  const { badge } = _els();
  if (!badge) return;
  let mode = 'container', ok = false;
  try {
    const res = await fetch('/api/axon/term/mode', { credentials: 'same-origin' });
    if (res.ok) { const d = await res.json(); if (d && (d.mode === 'host' || d.mode === 'container')) { ok = true; if (d.mode === 'host') mode = 'host'; } }
  } catch { /* deja container */ }
  if (ok) _badgeFetched = true;
  badge.textContent = mode;
  badge.classList.toggle('host', mode === 'host');
  badge.classList.toggle('container', mode !== 'host');
  badge.title = mode === 'host'
    ? 'Corre en tu HOST (vía el broker de axon), como tú — ver docs/terminal.md'
    : 'Corre dentro del contenedor de axon (cwd del maincar), no en tu host — ver docs/terminal.md';
}

// ─────────────────────────────── modo PTY (xterm.js + WebSocket) ───────────────────────────────

/** ¿xterm.js está cargado como global? (lo carga index.html vía /static/lib/xterm.js UMD → globalThis.Terminal). */
function _xtermAvailable() {
  return typeof globalThis.Terminal === 'function';
}

function _wsUrl(cols, rows) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/axon/term/pty?cols=${cols}&rows=${rows}`;
}

/** Crea (una vez) la instancia de xterm y la monta en #term-xterm. */
function _ensureTerm() {
  if (_term) return _term;
  const { xterm } = _els();
  if (!xterm || !_xtermAvailable()) return null;
  const term = new globalThis.Terminal({
    cursorBlink: true,
    fontFamily: '"FiraCode", "Fira Code", Menlo, Consolas, monospace',
    fontSize: 13,
    scrollback: 5000,
    theme: { background: '#1e1e2e', foreground: '#cdd6f4' },
  });
  try {
    if (globalThis.FitAddon && globalThis.FitAddon.FitAddon) {
      _fit = new globalThis.FitAddon.FitAddon();
      term.loadAddon(_fit);
    }
  } catch { _fit = null; }
  term.open(xterm);
  // teclado del usuario → stdin del PTY (bytes crudos; xterm ya traduce Enter/Ctrl-C/flechas a las secuencias).
  term.onData((data) => {
    if (_ws && _ptyConnected) { try { _ws.send(new TextEncoder().encode(data)); } catch { /* ws cerrado */ } }
  });
  // resize del emulador → avisa al PTY (SIGWINCH real en el host).
  term.onResize(({ cols, rows }) => {
    if (_ws && _ptyConnected) { try { _ws.send(JSON.stringify({ type: 'resize', cols, rows })); } catch { /* */ } }
  });
  _term = term;
  return term;
}

function _fitNow() {
  if (_fit) { try { _fit.fit(); } catch { /* contenedor sin tamaño aún */ } }
}

/** Abre el PTY: monta xterm, hace fit, conecta el WS con las dims medidas. Devuelve true si arrancó el intento. */
function _openPty() {
  const term = _ensureTerm();
  if (!term) return false;
  // fit tras un tick (el modal ya es visible) para medir el contenedor.
  _fitNow();
  const cols = term.cols || 80, rows = term.rows || 24;
  let ws;
  try { ws = new WebSocket(_wsUrl(cols, rows)); } catch { return false; }
  ws.binaryType = 'arraybuffer';
  _ws = ws;
  ws.onopen = () => {
    _ptyConnected = true;
    _gotOutput = false;
    _ptyOpenedAt = Date.now();
    _showMode('pty');
    _fitNow(); // re-fit ahora que es visible; onResize mandará las dims exactas
    term.focus();
  };
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      _gotOutput = true;
      term.write(new Uint8Array(ev.data));          // salida cruda del PTY
    } else if (typeof ev.data === 'string') {
      try {
        const o = JSON.parse(ev.data);
        // PTY murió instantáneo SIN emitir nada (p. ej. `script` no está en el contenedor) → degrada a one-shot
        // en vez de dejar al usuario atorado en un xterm con solo un [error].
        if ((o.type === 'error' || o.type === 'exit') && !_gotOutput && (Date.now() - _ptyOpenedAt) < 2500) {
          _ptyConnected = false;
          try { ws.close(); } catch { /* */ }
          _showMode('oneshot');
          const { output, input } = _els();
          if (output) _appendLine(output, '[terminal interactiva no disponible aquí — modo comando]\n', 'term-exit');
          if (input) input.focus();
          return;
        }
        if (o.type === 'error') term.write(`\r\n\x1b[31m[error] ${o.error || 'desconocido'}\x1b[0m\r\n`);
        else if (o.type === 'exit') term.write(`\r\n\x1b[90m[sesión terminada (exit ${o.code})]\x1b[0m\r\n`);
      } catch { /* control ilegible */ }
    }
  };
  ws.onclose = () => {
    _ptyConnected = false;
    if (_term) { try { _term.write('\r\n\x1b[90m[desconectado — reabre la terminal para reconectar]\x1b[0m\r\n'); } catch { /* */ } }
  };
  ws.onerror = () => {
    // Si NUNCA llegó a abrir, degradamos a one-shot. Si ya estaba abierto, onclose maneja el cierre.
    if (!_ptyConnected && !_ptyReady) { _showMode('oneshot'); }
  };
  _ptyReady = true;
  return true;
}

// ─────────────────────────────── modo ONE-SHOT (degradado) ───────────────────────────────
// Fallback fiel al comportamiento previo: POST /api/axon/term con SSE, texto crudo en <pre>. Solo se usa si el
// PTY no está disponible. (Se mantiene simple; sin ANSI.)

let _running = false, _controller = null;

function _appendLine(output, text, cls) {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  output.appendChild(span);
  output.scrollTop = output.scrollHeight;
}
function _setRunning(running) {
  _running = running;
  const { input, runBtn, stopBtn } = _els();
  if (input) input.disabled = running;
  if (runBtn) runBtn.disabled = running;
  if (stopBtn) stopBtn.classList.toggle('hidden', !running);
  if (!running && input) input.focus();
}
function _parseRecord(record) {
  const lines = record.split('\n');
  let isError = false, dataLine = null;
  for (const line of lines) {
    if (line.startsWith('event: error')) isError = true;
    else if (line.startsWith('data:')) dataLine = line.slice(5).trim();
  }
  if (dataLine == null) return null;
  if (dataLine === '[DONE]') return { done: true };
  try { return { isError, payload: JSON.parse(dataLine) }; } catch { return null; }
}
async function _runCommandOneShot(cmd) {
  const { output } = _els();
  if (!output) return;
  _appendLine(output, `\n$ ${cmd}\n`, 'term-cmd');
  _setRunning(true);
  _controller = new AbortController();
  try {
    const res = await fetch('/api/axon/term', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd, session: _session }), signal: _controller.signal,
    });
    if (!res.ok || !res.body) { _appendLine(output, `[error] HTTP ${res.status}\n`, 'term-stderr'); return; }
    const reader = res.body.getReader(); const decoder = new TextDecoder(); let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const record = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const parsed = _parseRecord(record);
        if (!parsed || parsed.done) continue;
        const { isError, payload } = parsed;
        if (isError) _appendLine(output, `[error] ${(payload && payload.error) || 'unknown error'}\n`, 'term-stderr');
        else if (payload && payload.type === 'stdout') _appendLine(output, payload.chunk, null);
        else if (payload && payload.type === 'stderr') _appendLine(output, payload.chunk, 'term-stderr');
        else if (payload && payload.type === 'exit') _appendLine(output, `[exit ${payload.code}]\n`, 'term-exit');
      }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') _appendLine(output, '[detenido]\n', 'term-exit');
    else _appendLine(output, `[error] ${(e && e.message) || String(e)}\n`, 'term-stderr');
  } finally { _controller = null; _setRunning(false); }
}

// ─────────────────────────────── UI ───────────────────────────────

/** Muestra el modo activo: 'pty' (xterm visible, input oculto) o 'oneshot' (input visible, xterm oculto). */
function _showMode(mode) {
  const { xterm, oneshot } = _els();
  if (xterm) xterm.classList.toggle('hidden', mode !== 'pty');
  if (oneshot) oneshot.classList.toggle('hidden', mode === 'pty');
}

function _clear() {
  if (_ptyConnected && _term) { try { _term.clear(); } catch { /* */ } return; }
  const { output, input } = _els();
  if (output) output.textContent = '';
  if (input) input.focus();
}

function _wire() {
  if (_wired) return;
  const { modal, input, runBtn, stopBtn, clearBtn } = _els();
  if (!modal) return;
  _wired = true;

  const content = modal.querySelector('.modal-content');
  const header = modal.querySelector('.modal-header');
  if (content && header) makeWindowDraggable(modal, { content, header, skipSelector: 'button, input, select' });

  // one-shot submit
  const submit = () => {
    if (_running) return;
    const cmd = (input && input.value || '').trim();
    if (!cmd) return;
    input.value = '';
    _runCommandOneShot(cmd);
  };
  if (runBtn) runBtn.addEventListener('click', submit);
  if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  if (stopBtn) stopBtn.addEventListener('click', () => { if (_controller) _controller.abort(); });
  if (clearBtn) clearBtn.addEventListener('click', _clear);

  // re-fit el PTY cuando el modal cambia de tamaño (drag-resize del window).
  if (typeof ResizeObserver === 'function') {
    const { xterm } = _els();
    if (xterm) { _resizeObs = new ResizeObserver(() => { if (_ptyConnected) _fitNow(); }); _resizeObs.observe(xterm); }
  }
  window.addEventListener('resize', () => { if (_ptyConnected) _fitNow(); });
}

function open() {
  _wire();
  const { modal, input } = _els();
  if (!modal) return;
  modal.classList.remove('hidden');
  void _refreshBadge();

  // Intenta PTY. Si ya hay uno conectado (reabrir el modal sin cerrarlo), solo re-fit + focus.
  if (_ptyConnected) { _showMode('pty'); setTimeout(() => { _fitNow(); if (_term) _term.focus(); }, 0); return; }

  // Reset del flag por-apertura y arranca el intento tras un tick (el modal ya es visible → el contenedor mide).
  _ptyReady = false;
  setTimeout(() => {
    const started = _xtermAvailable() && _openPty();
    if (!started) { _showMode('oneshot'); if (input) input.focus(); }
  }, 0);
}

const terminalModule = { open };
export default terminalModule;
