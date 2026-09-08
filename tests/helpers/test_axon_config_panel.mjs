// Smoke funcional del panel Settings › Axon (#32) — static/js/axonConfig.js.
//
// Carga el módulo REAL en un contexto `vm` con un DOM falso mínimo y un `fetch`
// falso; no toca la red, ni el stack, ni un navegador. Mismo patrón que
// test_settings_shell_coordinator.mjs, que ya corre el grafo ESM real así.
//
// POR QUÉ EXISTE: el panel se pinta ENTERO desde el schema que publica axon
// (~120 perillas, 19 grupos) — no hay controles escritos a mano que revisar de
// un vistazo. Sin esta prueba, la única verificación del renderer sería
// `node --check`, que solo dice que el archivo parsea.
//
// Lo que blinda, en orden de importancia:
//   • LOS TRES ESTADOS DE GUARDADO. El widget viejo MENTÍA: cambiabas algo,
//     "aplicaba" en memoria y se perdía al reiniciar sin avisar. Aquí se
//     verifica que `applied` / `requiresRestart` / `persisted:false` produzcan
//     tres mensajes DISTINTOS, y que nunca salga un "✓ aplicado" pelón para
//     algo que solo se persistió.
//   • Que una perilla `scope:"despliegue"` se renderice en SOLO LECTURA y que
//     un `secret` nunca muestre su valor.
//   • Que el buscador filtre, esconda grupos vacíos y destape una avanzada que
//     hace match (el mecanismo que hace usables 120 perillas en una pestaña).
//   • Que `Restaurar` mande `{reset:[key]}` y el guardado mande `{set:{…}}`.
//   • Que un 404 pinte el motivo y no un formulario muerto.
//
// Uso:  node --experimental-vm-modules tests/helpers/test_axon_config_panel.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ── DOM falso ── */
const byId = new Map();

class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...c) { c.forEach(x => this.set.add(x)); }
  remove(...c) { c.forEach(x => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
  get value() { return [...this.set].join(' '); }
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.classList = new ClassList(this);
    this.dataset = {};
    this.attrs = {};
    this.style = {};
    this._text = '';
    this._listeners = new Map();
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.open = false;
  }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return this.classList.value; }
  set id(v) { this.attrs.id = v; byId.set(v, this); }
  get id() { return this.attrs.id || ''; }
  set htmlFor(v) { this.attrs.for = v; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() {
    return this._text + this.children.map(c => c.textContent).join('');
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') byId.set(v, this); }
  getAttribute(k) { return this.attrs[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    c.parentNode = this;
    const i = this.children.indexOf(ref);
    this.children.splice(i < 0 ? 0 : i, 0, c);
    return c;
  }
  get firstChild() { return this.children[0] || null; }
  addEventListener(t, fn) {
    if (!this._listeners.has(t)) this._listeners.set(t, []);
    this._listeners.get(t).push(fn);
  }
  dispatch(t) { (this._listeners.get(t) || []).forEach(fn => fn({ target: this })); }
  descendants(out = []) {
    for (const c of this.children) { out.push(c); c.descendants(out); }
    return out;
  }
  matches(sel) { return matchCompound(this, sel); }
  querySelectorAll(sel) {
    return sel.split(',').map(s => s.trim()).flatMap(s => this.descendants().filter(el => matchSelector(el, s, this)));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

function matchCompound(el, compound) {
  // p.ej. details.axoncfg-advanced  ·  .axoncfg-knob:not(.axoncfg-hidden)  ·  [data-settings-tab="axon"]
  let rest = compound;
  const not = [];
  rest = rest.replace(/:not\(([^)]+)\)/g, (_, inner) => { not.push(inner.trim()); return ''; });
  const parts = rest.match(/^[a-zA-Z]+|\.[-\w]+|#[-\w]+|\[[^\]]+\]/g) || [];
  for (const p of parts) {
    if (p.startsWith('.')) { if (!el.classList.contains(p.slice(1))) return false; }
    else if (p.startsWith('#')) { if (el.id !== p.slice(1)) return false; }
    else if (p.startsWith('[')) {
      const m = p.match(/^\[([-\w]+)(?:="([^"]*)")?\]$/);
      if (!m) return false;
      const name = m[1];
      const key = name.startsWith('data-')
        ? name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())
        : null;
      const have = key ? el.dataset[key] : el.attrs[name];
      if (have === undefined) return false;
      if (m[2] !== undefined && String(have) !== m[2]) return false;
    } else if (el.tagName !== p.toUpperCase()) return false;
  }
  return not.every(n => !matchCompound(el, n));
}

function matchSelector(el, sel, root) {
  const parts = sel.split(/\s+/).filter(Boolean);
  const last = parts.pop();
  if (!matchCompound(el, last)) return false;
  let node = el.parentNode;
  for (let i = parts.length - 1; i >= 0; i--) {
    let found = false;
    while (node && node !== root.parentNode) {
      if (matchCompound(node, parts[i])) { found = true; node = node.parentNode; break; }
      node = node.parentNode;
    }
    if (!found) return false;
  }
  return true;
}

const document = new El('document');
document.readyState = 'complete';
document.createElement = tag => new El(tag);
document.getElementById = id => byId.get(id) || null;
document.addEventListener = () => {};

const settingsModal = document.appendChild(new El('div'));
settingsModal.id = 'settings-modal';
const axonPanel = settingsModal.appendChild(new El('div'));
axonPanel.setAttribute('data-settings-panel', 'axon');
axonPanel.dataset.settingsPanel = 'axon';
const toolBtn = document.appendChild(new El('div'));
toolBtn.id = 'tool-axoncfg-btn';

/* ── Snapshot sintético ── */
const SNAP = {
  cerebro: 'qwen3.8:27b',
  hasLocal: true,
  useFrontier: false,
  mode: 'build',
  ollamaUp: true,
  models: [
    { name: 'qwen3.8:27b', params: 27, sizeBytes: 18e9, fits: true, runnable: true, engine: 'ollama' },
    { name: 'gpt-oss:120b', params: 120, sizeBytes: 65e9, fits: false, runnable: true, engine: 'ollama' },
    { name: 'huge:400b', params: 400, sizeBytes: 240e9, fits: false, runnable: false, engine: 'ollama' },
  ],
  schema: {
    groups: [
      { id: 'cerebro', label: 'Cerebro y ruteo', help: 'Qué modelo planea.' },
      { id: 'motores', label: 'Motores' },
    ],
    knobs: [
      { key: 'cerebro', env: null, kind: 'enum', group: 'cerebro', label: 'Cerebro', help: 'Modelo local.', def: null, scope: 'usuario', readAt: 'call', hot: true, advanced: false, options: [] },
      { key: 'modo', env: null, kind: 'enum', group: 'cerebro', label: 'Modo', help: 'build/plan.', def: 'build', scope: 'usuario', readAt: 'call', hot: true, advanced: false, options: ['build', 'plan'] },
      { key: 'num-ctx', env: 'AXON_NUM_CTX', kind: 'integer', group: 'motores', label: 'num_ctx del planner', help: 'Ventana.', def: '32768', scope: 'usuario', readAt: 'load', hot: false, advanced: false, site: 'src/loop/local-planner.ts:24' },
      { key: 'verbose', env: 'AXON_VERBOSE', kind: 'boolean', group: 'motores', label: 'Verbose', help: 'Logs.', def: '0', scope: 'usuario', readAt: 'load', hot: false, advanced: true },
      { key: 'ollama-url', env: 'AXON_OLLAMA_URL', kind: 'url', group: 'motores', label: 'URL de ollama', help: 'Endpoint.', def: 'http://localhost:11434', scope: 'despliegue', readAt: 'load', hot: false, advanced: false },
      { key: 'api-key', env: 'AXON_API_KEY', kind: 'string', group: 'motores', label: 'API key', help: 'Secreta.', def: null, scope: 'usuario', readAt: 'load', hot: false, advanced: true, secret: true },
      { key: 'tools-json', env: null, kind: 'json', group: 'motores', label: 'Tools extra', help: 'JSON.', def: '[]', scope: 'usuario', readAt: 'load', hot: false, advanced: true },
    ],
  },
  effective: {
    cerebro: { value: 'qwen3.8:27b', source: 'persistido' },
    modo: { value: 'build', source: 'default' },
    'num-ctx': { value: '32768', source: 'entorno' },
    verbose: { value: null, source: 'default' },
    'ollama-url': { value: 'http://ollama:11434', source: 'entorno' },
    'api-key': { value: null, source: 'default', set: false },
    'tools-json': { value: '[]', source: 'default' },
  },
  persist: {
    path: '/home/node/.axon/config.json',
    exists: true,
    updatedAt: '2026-09-07T21:00:00.000Z',
    error: null,
  },
};

const posted = [];
let postReply = null;

const context = {
  document,
  window: {},
  console,
  setTimeout,
  clearTimeout,
  Date,
  Math,
  JSON,
  Object,
  Array,
  Map,
  Set,
  String,
  Number,
  Boolean,
  isFinite,
  async fetch(url, opts) {
    if (opts && opts.method === 'POST') {
      posted.push(JSON.parse(opts.body));
      return { ok: true, json: async () => (postReply || { ...SNAP, ok: true, applied: [], requiresRestart: [], persisted: true }) };
    }
    return { ok: true, json: async () => JSON.parse(JSON.stringify(SNAP)) };
  },
};
context.globalThis = context;
vm.createContext(context);

const src = fs.readFileSync(path.join(REPO, 'static/js/axonConfig.js'), 'utf8');
const mod = new vm.SourceTextModule(src, { context, identifier: 'axonConfig.js' });
await mod.link(() => { throw new Error('no imports expected'); });
await mod.evaluate();
const api = mod.namespace.default;

const fails = [];
const check = (name, cond, detail = '') => {
  if (!cond) fails.push(name + (detail ? ' :: ' + detail : ''));
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : ' :: ' + detail));
};

/* 1 · carga y render */
api.onPanelActivated();
await new Promise(r => setTimeout(r, 10));

const groups = axonPanel.querySelectorAll('.axoncfg-group');
const knobs = axonPanel.querySelectorAll('.axoncfg-knob');
check('renderiza un section por grupo del schema', groups.length === 2, 'groups=' + groups.length);
check('renderiza las 7 perillas', knobs.length === 7, 'knobs=' + knobs.length);
check('banner de persistencia con la ruta',
  axonPanel.textContent.includes('/home/node/.axon/config.json'));
check('las avanzadas van en un <details>',
  axonPanel.querySelectorAll('details.axoncfg-advanced').length === 1);
check('el <details> cuenta 3 avanzadas',
  axonPanel.querySelector('details.axoncfg-advanced').textContent.includes('Avanzadas (3)'));

/* 2 · cerebro poblado con los modelos, el que no cabe deshabilitado */
const cerebroSel = document.getElementById('axoncfg-f-cerebro');
check('el cerebro sale de snap.models', cerebroSel && cerebroSel.children.length === 3,
  'opts=' + (cerebroSel ? cerebroSel.children.length : 'null'));
check('el modelo que no cabe queda deshabilitado',
  cerebroSel.children[2].disabled === true);
check('la etiqueta del modelo trae params y tamaño',
  cerebroSel.children[0].textContent.includes('27B') && cerebroSel.children[0].textContent.includes('GB'),
  cerebroSel.children[0].textContent);
check('offload se anota en el que no cabe pero es ejecutable',
  cerebroSel.children[1].textContent.includes('offload'), cerebroSel.children[1].textContent);

/* 3 · scope despliegue = solo lectura */
const roInput = document.getElementById('axoncfg-f-ollama-url');
check('la perilla de despliegue va deshabilitada', roInput && roInput.disabled === true);

/* 4 · secreto: nunca el valor, solo puesta/no puesta */
const secretInput = document.getElementById('axoncfg-f-api-key');
check('el secreto va en un input password y vacío',
  secretInput && secretInput.type === 'password' && secretInput.value === '');
check('el secreto muestra "no puesta"', axonPanel.textContent.includes('no puesta'));

/* 5 · procedencia y "Restaurar" solo en lo persistido */
check('chip de procedencia persistido', axonPanel.textContent.includes('persistido'));
check('chip de procedencia entorno', axonPanel.textContent.includes('entorno'));
check('un solo botón Restaurar (la única persistida)',
  axonPanel.querySelectorAll('.axoncfg-btn-ghost').filter(b => b.textContent === 'Restaurar').length === 1);

/* 6 · búsqueda viva */
const search = document.getElementById('axoncfg-search');
search.value = 'num_ctx';
search.dispatch('input');
const visible = axonPanel.querySelectorAll('.axoncfg-knob').filter(k => !k.classList.contains('axoncfg-hidden'));
check('la búsqueda deja solo la perilla que hace match', visible.length === 1,
  'visibles=' + visible.length);
check('el grupo sin matches se esconde',
  axonPanel.querySelectorAll('.axoncfg-group').filter(g => g.classList.contains('axoncfg-hidden')).length === 1);

search.value = 'AXON_VERBOSE';
search.dispatch('input');
const det = axonPanel.querySelector('details.axoncfg-advanced');
check('una avanzada que hace match se REVELA (details abierto)', det.open === true);

search.value = '';
search.dispatch('input');
check('al limpiar la búsqueda vuelven las 7',
  axonPanel.querySelectorAll('.axoncfg-knob').filter(k => !k.classList.contains('axoncfg-hidden')).length === 7);

/* 7 · dirty + guardar (no-hot) */
const numCtx = document.getElementById('axoncfg-f-num-ctx');
numCtx.value = '65536';
numCtx.dispatch('change');
check('marcar dirty enciende el contador',
  document.querySelector('.axoncfg-dirty-count').textContent === '1 sin guardar',
  document.querySelector('.axoncfg-dirty-count').textContent);

postReply = { ...SNAP, ok: true, applied: [], requiresRestart: ['num-ctx'], persisted: true };
document.getElementById('axoncfg-save').dispatch('click');
await new Promise(r => setTimeout(r, 10));
check('el POST manda {set:{...}}',
  posted.length === 1 && posted[0].set && posted[0].set['num-ctx'] === '65536',
  JSON.stringify(posted[0]));
check('estado (b): guardado + REINICIAR, nunca un "aplicado" pelón',
  document.getElementById('axoncfg-status').textContent.includes('REINICIAR')
  && !document.getElementById('axoncfg-status').textContent.startsWith('✓ aplicado'),
  document.getElementById('axoncfg-status').textContent);
check('la perilla queda con chip de pendiente de reinicio',
  axonPanel.textContent.includes('pendiente de reinicio'));

/* 8 · hot aplica al vuelo */
posted.length = 0;
postReply = { ...SNAP, ok: true, applied: ['cerebro'], requiresRestart: [], persisted: true };
const cerebro2 = document.getElementById('axoncfg-f-cerebro');
cerebro2.value = 'gpt-oss:120b';
cerebro2.dispatch('change');
await new Promise(r => setTimeout(r, 10));
check('la perilla hot postea sola al cambiar',
  posted.length === 1 && posted[0].set.cerebro === 'gpt-oss:120b', JSON.stringify(posted[0]));
check('estado (a): aplicado ahora',
  document.getElementById('axoncfg-status').textContent.includes('aplicado ahora'),
  document.getElementById('axoncfg-status').textContent);

/* 9 · persisted:false = ERROR, no éxito */
posted.length = 0;
postReply = { ...SNAP, ok: true, applied: [], requiresRestart: ['num-ctx'], persisted: false, error: 'EACCES' };
const numCtx2 = document.getElementById('axoncfg-f-num-ctx');
numCtx2.value = '1024';
numCtx2.dispatch('change');
document.getElementById('axoncfg-save').dispatch('click');
await new Promise(r => setTimeout(r, 10));
const st = document.getElementById('axoncfg-status');
check('estado (c): NO se guardó = error',
  st.textContent.includes('NO se guardó') && st.classList.contains('axoncfg-status-error'),
  st.textContent);

/* 10 · reset */
posted.length = 0;
postReply = { ...SNAP, ok: true, applied: [], requiresRestart: [], persisted: true };
const restore = axonPanel.querySelectorAll('.axoncfg-btn-ghost').find(b => b.textContent === 'Restaurar');
restore.dispatch('click');
await new Promise(r => setTimeout(r, 10));
check('Restaurar manda {reset:[key]}',
  posted.length === 1 && Array.isArray(posted[0].reset) && posted[0].reset[0] === 'cerebro',
  JSON.stringify(posted[0]));

/* 11 · endpoint caído: degradar honesto */
context.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: 'config API no disponible' }) });
await api.refresh();
check('404 pinta el motivo y NO un formulario muerto',
  axonPanel.textContent.includes('config API no disponible')
  && axonPanel.querySelectorAll('.axoncfg-knob').length === 0,
  axonPanel.textContent.slice(0, 120));

console.log('\nFALLOS: ' + fails.length);
if (fails.length) { fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
