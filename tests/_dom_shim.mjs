// Shim de DOM para tests de node --test (sin browser).
// Importar ESTE archivo PRIMERO, antes de cualquier módulo que toque document/window.
const _store = new Map();
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: (k) => { _store.delete(k); },
  key: (i) => Array.from(_store.keys())[i] ?? null,
  get length() { return _store.size; },
};
globalThis.window = globalThis;
globalThis.innerWidth = 1280;
globalThis.innerHeight = 800;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.getComputedStyle = () => ({ display: 'block', getPropertyValue: () => '' });
globalThis.requestAnimationFrame = () => 0;
globalThis.MutationObserver = class { observe(){} disconnect(){} takeRecords(){return[];} };
globalThis.cancelAnimationFrame = () => {};
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
globalThis.document = {
  documentElement: { style: {} },
  body: { appendChild: () => {}, removeChild: () => {} },
  createElement: () => ({ style: {}, classList: { add(){}, remove(){}, contains(){ return false; } }, remove(){}, setAttribute(){}, addEventListener(){}, removeEventListener(){}, querySelector(){ return null; }, querySelectorAll(){ return []; } }),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
};
