// static/js/terminal.js — widget de Terminal (rail-term / tool-term-btn → #term-modal).
//
// Corre un comando de shell en axon (POST /api/axon/term, mismo origen — el navegador habla con
// el MAIN CAR de axon en :7001, que sirve la SPA de Odysseus proxeada) y streamea stdout/stderr EN VIVO
// vía fetch+ReadableStream (no EventSource: EventSource solo hace GET, este endpoint es POST).
//
// ⚠️ SCOPE: el comando corre DENTRO del contenedor Docker del maincar de axon (su cwd — normalmente
// /workspace + lo que el compose monte), NO en "tu compu" (el host) a menos que el compose lo extienda
// explícitamente. Ver el caveat completo + cómo extender a host en docs/terminal.md del repo axon.
//
// Simple a propósito (pedido explícito: "NO necesitas xterm.js completo"): un <input> + un <pre> con
// scroll. Sin historial de comandos ni interpretación de secuencias ANSI — texto crudo tal cual llega.

import { makeWindowDraggable } from './windowDrag.js';

let _wired = false;
let _running = false;
let _controller = null;

function _els() {
  return {
    modal: document.getElementById('term-modal'),
    output: document.getElementById('term-output'),
    input: document.getElementById('term-input'),
    runBtn: document.getElementById('term-run-btn'),
    stopBtn: document.getElementById('term-stop-btn'),
  };
}

/** Appendea texto crudo (textContent, NUNCA innerHTML — la salida del comando no es HTML de confianza)
 *  al panel de output, con una clase opcional para el color (stderr/cmd/exit), y auto-scrollea al fondo. */
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

/** Parsea UN registro SSE (todo lo que hay entre dos "\n\n") al wire propio de /api/axon/term:
 *  `data: {"type":"stdout"|"stderr","chunk":...}` / `data: {"type":"exit","code":...}` / `data: [DONE]`,
 *  o `event: error\ndata: {"error":...}` (mismo wire que sseError en axon). Never-throws. */
function _parseRecord(record) {
  const lines = record.split('\n');
  let isError = false;
  let dataLine = null;
  for (const line of lines) {
    if (line.startsWith('event: error')) isError = true;
    else if (line.startsWith('data:')) dataLine = line.slice(5).trim();
  }
  if (dataLine == null) return null;
  if (dataLine === '[DONE]') return { done: true };
  try { return { isError, payload: JSON.parse(dataLine) }; } catch { return null; }
}

async function _runCommand(cmd) {
  const { output } = _els();
  if (!output) return;
  _appendLine(output, `\n$ ${cmd}\n`, 'term-cmd');
  _setRunning(true);
  _controller = new AbortController();
  try {
    const res = await fetch('/api/axon/term', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd }),
      signal: _controller.signal,
    });
    if (!res.ok || !res.body) {
      _appendLine(output, `[error] HTTP ${res.status}\n`, 'term-stderr');
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const record = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const parsed = _parseRecord(record);
        if (!parsed || parsed.done) continue;
        const { isError, payload } = parsed;
        if (isError) {
          _appendLine(output, `[error] ${(payload && payload.error) || 'unknown error'}\n`, 'term-stderr');
        } else if (payload && payload.type === 'stdout') {
          _appendLine(output, payload.chunk, null);
        } else if (payload && payload.type === 'stderr') {
          _appendLine(output, payload.chunk, 'term-stderr');
        } else if (payload && payload.type === 'exit') {
          _appendLine(output, `[exit ${payload.code}]\n`, 'term-exit');
        }
      }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') {
      _appendLine(output, '[detenido]\n', 'term-exit');
    } else {
      _appendLine(output, `[error] ${(e && e.message) || String(e)}\n`, 'term-stderr');
    }
  } finally {
    _controller = null;
    _setRunning(false);
  }
}

function _wire() {
  if (_wired) return;
  const { modal, input, runBtn, stopBtn } = _els();
  if (!modal) return;
  _wired = true;

  const content = modal.querySelector('.modal-content');
  const header = modal.querySelector('.modal-header');
  if (content && header) {
    makeWindowDraggable(modal, { content, header, skipSelector: 'button, input, select' });
  }

  const submit = () => {
    if (_running) return;
    const cmd = (input.value || '').trim();
    if (!cmd) return;
    input.value = '';
    _runCommand(cmd);
  };

  if (runBtn) runBtn.addEventListener('click', submit);
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
  }
  if (stopBtn) {
    stopBtn.addEventListener('click', () => { if (_controller) _controller.abort(); });
  }
}

/** Abre el modal (lo wirea la primera vez que se llama) y enfoca el input. Llamado por app.js desde el
 *  click de `tool-term-btn` (que a su vez `rail-term` dispara vía `_railToolMap`). */
function open() {
  _wire();
  const { modal, input } = _els();
  if (!modal) return;
  modal.classList.remove('hidden');
  if (input) setTimeout(() => input.focus(), 0);
}

const terminalModule = { open };
export default terminalModule;
