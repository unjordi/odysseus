// scratch/pty-frontend/dom-stub.mjs — el NAVEGADOR DE MENTIRAS con el que se prueba `static/js/terminal.js`
// sin navegador. Lo consume `probe-term-instancias.mjs`.
//
// POR QUÉ EXISTE: la conversión de la terminal de SINGLETON a INSTANCIAS (#29a) no vive en aritmética pura
// —eso es `term-geometry.js`— sino en el ciclo de vida: quién es dueño de qué socket, qué observer se
// desengancha al cerrar, qué reconciliador recibe cuál resize. Eso solo se puede probar EJERCITANDO el
// módulo, y el repo no tiene jsdom (ni una sola dependencia de runtime en package.json). Así que aquí va el
// mínimo DOM que `terminal.js` toca, y nada más.
//
// ES UN STUB, NO UN NAVEGADOR. No hay layout: las medidas (clientWidth, rects) se FIJAN a mano en el test,
// que es justo lo que se quiere — poder decir "esta ventana ahora mide 418 px" y ver a quién le llega el
// resize. Lo que este archivo NO puede atrapar: CSS real, especificidad, focus, y cualquier cosa que dependa
// de que el navegador de verdad pinte. Eso sigue siendo QA en vivo.

// ─────────────────────────────── selectores (los pocos que se usan) ───────────────────────────────
// Soporta: `.clase`, `.a.b`, `tag`, `[id]`, listas separadas por coma y el prefijo `body > ` (hijos directos
// del body) que usa `toolWindowZOrder.js`. Nada más — si un módulo empieza a usar un selector más rico, este
// stub debe crecer a propósito, no adivinar.
function _matchSimple(el, sel) {
  if (sel === '[id]') return !!el.id;
  if (sel.startsWith('.')) return sel.slice(1).split('.').every((c) => el.classList.contains(c));
  return el.tagName === sel.toUpperCase();
}

export class El {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.id = '';
    this.children = [];
    this.parentNode = null;
    this.style = { cssText: '' };
    this.attributes = {};
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.title = '';
    this._listeners = new Map();     // "type|capture" -> Set<fn>
    this._classes = new Set();
    // Medidas: las fija el test (no hay layout).
    this.clientWidth = 0; this.clientHeight = 0;
    this.offsetWidth = 0; this.offsetHeight = 0;
    this._rect = { left: 0, top: 0, width: 0, height: 0 };
    this._focused = false;
    const self = this;
    this.classList = {
      add: (...cs) => cs.forEach((c) => self._classes.add(c)),
      remove: (...cs) => cs.forEach((c) => self._classes.delete(c)),
      contains: (c) => self._classes.has(c),
      toggle: (c, on) => {
        const want = (on === undefined) ? !self._classes.has(c) : !!on;
        if (want) self._classes.add(c); else self._classes.delete(c);
        return want;
      },
      get value() { return [...self._classes].join(' '); },
    };
  }

  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }

  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'id') this.id = String(v);
    if (k === 'class') this.className = v;
  }
  getAttribute(k) { return k === 'id' ? this.id : (this.attributes[k] ?? null); }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  set innerHTML(v) { if (v === '') { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; } }
  get innerHTML() { return ''; }

  contains(other) {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  /** Todos los descendientes, en orden de documento. */
  _descendants(out = []) {
    for (const c of this.children) { out.push(c); c._descendants(out); }
    return out;
  }

  querySelectorAll(sel) {
    const parts = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
    const hit = [];
    for (const part of parts) {
      const direct = part.startsWith('body > ');
      const simple = direct ? part.slice('body > '.length) : part;
      const pool = direct ? this.children.slice() : this._descendants();
      for (const el of pool) if (_matchSimple(el, simple) && !hit.includes(el)) hit.push(el);
    }
    return hit;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }

  cloneNode(deep) {
    const copy = new El(this.tagName);
    copy.id = this.id;
    copy.className = this.className;
    copy.textContent = this.textContent;
    copy.attributes = { ...this.attributes };
    copy.style = { ...this.style };
    copy.clientWidth = this.clientWidth; copy.clientHeight = this.clientHeight;
    copy.offsetWidth = this.offsetWidth; copy.offsetHeight = this.offsetHeight;
    copy._rect = { ...this._rect };
    if (deep) for (const c of this.children) copy.appendChild(c.cloneNode(true));
    return copy;
  }

  // Listeners: se CUENTAN, porque "no queda ninguno colgando" es justo lo que el probe verifica.
  addEventListener(type, fn, capture) {
    const key = `${type}|${!!capture}`;
    if (!this._listeners.has(key)) this._listeners.set(key, new Set());
    this._listeners.get(key).add(fn);
  }
  removeEventListener(type, fn, capture) {
    const key = `${type}|${!!capture}`;
    const set = this._listeners.get(key);
    if (set) set.delete(fn);
  }
  listenerCount(type) {
    let n = 0;
    for (const [key, set] of this._listeners) if (key.split('|')[0] === type) n += set.size;
    return n;
  }
  /** Dispara en ESTE nodo (sin burbujeo: el código bajo prueba no depende de él). */
  dispatch(type, ev = {}) {
    const e = { type, target: this, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...ev };
    for (const [key, set] of this._listeners) {
      if (key.split('|')[0] !== type) continue;
      for (const fn of [...set]) fn(e);
    }
    return e;
  }

  getBoundingClientRect() {
    // Un `<span>` de medición devuelve un ancho proporcional a su texto: es lo que hace
    // `_measurePaintedCellWidth` para calcular el paso pintado (con 8 px por 'W', pintado == declarado).
    if (this.tagName === 'SPAN' && this.textContent) {
      return { left: 0, top: 0, width: this.textContent.length * 8, height: 17 };
    }
    return { ...this._rect };
  }
  focus() { this._focused = true; }
  blur() { this._focused = false; }
}

// ─────────────────────────────── documento / ventana ───────────────────────────────

export function installDom() {
  const doc = new El('document');
  const body = new El('body');
  doc.appendChild(body);
  doc.body = body;
  doc.createElement = (tag) => new El(tag);
  doc.getElementById = (id) => doc._descendants().find((el) => el.id === id) || null;
  doc.readyState = 'complete';
  doc.fonts = { ready: Promise.resolve() };

  const timers = [];
  globalThis.document = doc;
  globalThis.window = globalThis;
  globalThis.innerWidth = 1600;
  globalThis.innerHeight = 900;
  globalThis.addEventListener = doc.addEventListener.bind(doc);   // `window.resize` cae aquí
  globalThis.removeEventListener = doc.removeEventListener.bind(doc);
  globalThis.location = { protocol: 'https:', host: 'stub.test' };
  globalThis.getComputedStyle = (el) => ({
    display: el.classList.contains('hidden') ? 'none' : 'block',
    visibility: 'visible',
    zIndex: el.style.zIndex || 'auto',
    paddingLeft: el.style.paddingLeft || '0px',
    paddingRight: el.style.paddingRight || '0px',
    paddingTop: el.style.paddingTop || '0px',
    paddingBottom: el.style.paddingBottom || '0px',
    fontFamily: 'monospace', fontSize: '13px', fontWeight: '400', fontStyle: 'normal',
    fontKerning: 'auto', letterSpacing: 'normal', wordSpacing: 'normal',
  });
  // rAF síncrono-diferido: basta para que las pasadas de `_scheduleFit` corran, sin simular vsync.
  globalThis.requestAnimationFrame = (fn) => { const t = setTimeout(fn, 1); timers.push(t); return t; };
  globalThis.cancelAnimationFrame = (t) => clearTimeout(t);
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.localStorage = globalThis.sessionStorage;
  return { doc, body };
}

// ─────────────────────────────── ResizeObserver contable ───────────────────────────────

export const observers = { live: new Set(), byTarget: new Map() };

export function installResizeObserver() {
  observers.live.clear();
  observers.byTarget.clear();
  globalThis.ResizeObserver = class {
    constructor(cb) { this.cb = cb; this.targets = new Set(); observers.live.add(this); }
    observe(el) { this.targets.add(el); observers.byTarget.set(el, this); }
    unobserve(el) { this.targets.delete(el); }
    disconnect() { this.targets.clear(); observers.live.delete(this); }
  };
}

/** "El contenedor cambió de tamaño": fija la medida nueva y dispara SU observer (no los demás). */
export function resizeContainer(el, { clientWidth, clientHeight }) {
  if (clientWidth != null) el.clientWidth = clientWidth;
  if (clientHeight != null) el.clientHeight = clientHeight;
  const obs = observers.byTarget.get(el);
  if (obs && observers.live.has(obs)) obs.cb([{ target: el }], obs);
  return !!obs;
}

// ─────────────────────────────── WebSocket contable ───────────────────────────────

export const sockets = [];

export function installWebSocket() {
  sockets.length = 0;
  globalThis.WebSocket = class {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.closed = false;
      this.binaryType = '';
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      sockets.push(this);
      setTimeout(() => { if (!this.closed) { this.readyState = 1; if (this.onopen) this.onopen(); } }, 1);
    }
    send(data) {
      if (this.closed) throw new Error('socket cerrado');
      this.sent.push(data);
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.readyState = 3;
      if (this.onclose) this.onclose();
    }
    /** Frames `{type:'resize'}` que este socket recibió, ya parseados. */
    resizes() {
      return this.sent
        .filter((d) => typeof d === 'string')
        .map((d) => { try { return JSON.parse(d); } catch { return null; } })
        .filter((o) => o && o.type === 'resize');
    }
  };
}

// ─────────────────────────────── xterm.js de mentiras ───────────────────────────────

export const terminals = [];

export function installXterm() {
  terminals.length = 0;
  globalThis.Terminal = class {
    constructor(opts) {
      this.options = opts;
      this.cols = 80; this.rows = 24;
      this.element = null;
      this.textarea = null;
      this.disposed = false;
      this.written = [];
      this._onData = [];
      this._onResize = [];
      // El mínimo de API interna que `_measureGrid`/`_resyncCharMetrics` consultan del bundle real.
      this._core = {
        _charSizeService: { hasValidSize: true, measure() {} },
        _renderService: { dimensions: { css: { cell: { width: 8, height: 17 } } }, handleCharSizeChanged() {} },
      };
      terminals.push(this);
    }
    open(container) {
      const el = new El('div');
      el.className = 'xterm';
      const screen = new El('div'); screen.className = 'xterm-screen';
      const rows = new El('div'); rows.className = 'xterm-rows';
      const viewport = new El('div'); viewport.className = 'xterm-viewport';
      const ta = new El('textarea');
      screen.appendChild(rows);
      el.appendChild(screen); el.appendChild(viewport); el.appendChild(ta);
      container.appendChild(el);
      this.element = el; this.textarea = ta;
      // Sin overflow: `scrollbarWidth` = 0 → manda `minRightGap` (= padLeft), como en macOS.
      viewport.offsetWidth = 0; viewport.clientWidth = 0;
    }
    resize(cols, rows) {
      if (cols === this.cols && rows === this.rows) return;
      this.cols = cols; this.rows = rows;
      this._onResize.forEach((fn) => fn({ cols, rows }));
    }
    onData(fn) { this._onData.push(fn); return { dispose() {} }; }
    onResize(fn) { this._onResize.push(fn); return { dispose() {} }; }
    write(s) { this.written.push(s); }
    clear() { this.written.length = 0; }
    focus() { this.focused = true; }
    dispose() { this.disposed = true; if (this.element) this.element.remove(); }
  };
}

/** Un fetch que solo contesta `/api/axon/term/mode` (lo único que el widget pide al abrir). */
export function installFetch(mode = 'host') {
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/axon/term/mode')) {
      return { ok: true, json: async () => ({ mode, detail: '' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
