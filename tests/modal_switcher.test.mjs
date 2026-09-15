// Tests del núcleo PURO del switcher de modales (#29f, modo teléfono) —
// ver static/js/modalSwitcher.js.
//
// El módulo es puro a propósito: recibe la lista de instancias abiertas (el
// shape de workspaceState.openInstances()), un mapa de etiquetas inyectado y el
// id activo, y devuelve la vista del switcher + navegación next/prev con wrap,
// sin tocar el DOM, sin leer `window`, sin suscribirse y sin lanzar. Eso permite
// fijar aquí lo que a través del DOM no se puede afirmar: el orden se conserva,
// la etiqueta cae a module→id cuando falta, `active` marca solo el id activo,
// varias instancias del MISMO tipo (#29a) se listan por separado, la navegación
// hace wrap en ambos sentidos, un currentId ausente arranca en el extremo
// correcto, y una entrada inválida no lanza ni fabrica filas.
//
// Corre sin DOM y sin reloj: `node --test tests/modal_switcher.test.mjs`.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSwitcher,
  selectSwitchableWindows,
  indiceDe,
  nextInSwitcher,
  prevInSwitcher,
} from '../static/js/modalSwitcher.js';

// Instancias abiertas con el SHAPE real de workspaceState.openInstances().
const abiertas = [
  { id: 'cookbook-modal', module: 'cookbook-modal', open: true, minimized: false, openedAt: 10 },
  { id: 'term#1',         module: 'term-modal',      open: true, minimized: true,  openedAt: 20 },
  { id: 'term#2',         module: 'term-modal',      open: true, minimized: false, openedAt: 30 },
];
const labels = { 'cookbook-modal': 'Cookbook', 'term-modal': 'Terminal' };

test('buildSwitcher: conserva el orden y resuelve etiquetas', () => {
  const v = buildSwitcher(abiertas, labels, 'term#2');
  assert.equal(v.length, 3);
  assert.deepEqual(v.map((x) => x.id), ['cookbook-modal', 'term#1', 'term#2']);
  assert.deepEqual(v.map((x) => x.label), ['Cookbook', 'Terminal', 'Terminal']);
});

test('buildSwitcher: varias instancias del MISMO tipo se listan por separado (#29a)', () => {
  const v = buildSwitcher(abiertas, labels, null);
  const terms = v.filter((x) => x.moduleId === 'term-modal');
  assert.equal(terms.length, 2);
  assert.deepEqual(terms.map((x) => x.id), ['term#1', 'term#2']);
});

test('buildSwitcher: active marca SOLO el id activo; minimized refleja el registro', () => {
  const v = buildSwitcher(abiertas, labels, 'term#2');
  assert.deepEqual(v.map((x) => x.active), [false, false, true]);
  assert.deepEqual(v.map((x) => x.minimized), [false, true, false]);
});

test('buildSwitcher: sin activeId, ninguno es active', () => {
  const v = buildSwitcher(abiertas, labels, null);
  assert.equal(v.some((x) => x.active), false);
});

test('buildSwitcher: etiqueta ausente cae a module y luego a id', () => {
  const list = [
    { id: 'notes-panel', module: 'notes-panel', open: true, minimized: false },
    { id: 'x#9',         open: true, minimized: false }, // sin module
  ];
  const v = buildSwitcher(list, {}, null);
  assert.equal(v[0].label, 'notes-panel'); // no hay etiqueta → module
  assert.equal(v[1].moduleId, 'x#9');      // sin module → id
  assert.equal(v[1].label, 'x#9');
});

test('buildSwitcher: entradas inválidas se omiten sin lanzar', () => {
  assert.deepEqual(buildSwitcher(null, labels, null), []);
  assert.deepEqual(buildSwitcher('nope', labels, null), []);
  const v = buildSwitcher([null, {}, { id: '' }, { id: 'ok', module: 'ok', open: true }], null, null);
  assert.equal(v.length, 1);
  assert.equal(v[0].id, 'ok');
});

test('indiceDe: encuentra o devuelve -1', () => {
  const v = buildSwitcher(abiertas, labels, null);
  assert.equal(indiceDe(v, 'term#1'), 1);
  assert.equal(indiceDe(v, 'no-existe'), -1);
  assert.equal(indiceDe(null, 'x'), -1);
});

test('nextInSwitcher: avanza con wrap; ausente → primero', () => {
  const v = buildSwitcher(abiertas, labels, null);
  assert.equal(nextInSwitcher(v, 'cookbook-modal'), 'term#1');
  assert.equal(nextInSwitcher(v, 'term#2'), 'cookbook-modal'); // wrap
  assert.equal(nextInSwitcher(v, null), 'cookbook-modal');     // ausente → primero
  assert.equal(nextInSwitcher([], 'x'), null);
});

test('prevInSwitcher: retrocede con wrap; ausente → último', () => {
  const v = buildSwitcher(abiertas, labels, null);
  assert.equal(prevInSwitcher(v, 'term#1'), 'cookbook-modal');
  assert.equal(prevInSwitcher(v, 'cookbook-modal'), 'term#2'); // wrap
  assert.equal(prevInSwitcher(v, null), 'term#2');             // ausente → último
  assert.equal(prevInSwitcher([], 'x'), null);
});

test('un solo modal abierto: next/prev devuelven el mismo (wrap sobre 1)', () => {
  const v = buildSwitcher([{ id: 'solo', module: 'solo', open: true }], {}, 'solo');
  assert.equal(nextInSwitcher(v, 'solo'), 'solo');
  assert.equal(prevInSwitcher(v, 'solo'), 'solo');
});

// ── selectSwitchableWindows: el REGISTRO de "ventanas switcheables" (#29f) ──
// El bug: el switcher listaba las ventanas EQUIVOCADAS ("Document" + "Host Stats")
// y OMITÍA las abiertas de verdad (Cortex, Terminal), porque leía la PERSISTENCIA
// (workspaceState.openInstances) en vez del DOM vivo. selectSwitchableWindows es
// el filtro PURO que consume los descriptores del DOM (modalManager.openToolWindows)
// y devuelve exactamente las ventanas-herramienta abiertas o minimizadas.
//
// Descriptor: { id, module, isToolWindow, hidden, minimized, display, z }.

// Escena del bug reportado: Cortex + Terminal tileadas al frente; la barra docked
// de Host Stats visible; un diálogo de confirmación abierto; y varias ventanas
// cerradas (hidden) que la persistencia mostraba como fantasmas.
const escena = [
  { id: 'cortex-modal',   module: 'cortex-modal', isToolWindow: true,  hidden: false, minimized: false, display: 'block', z: 120 },
  { id: 'term-modal--2',  module: 'term-modal',   isToolWindow: true,  hidden: false, minimized: false, display: 'block', z: 130 },
  { id: 'hoststats-modal',module: 'hoststats-modal', isToolWindow: true, hidden: false, minimized: false, display: 'block', z: 40 },
  // Diálogo de confirmación: es `.modal` pero NO ventana-herramienta → fuera.
  { id: 'confirm-dialog', module: 'confirm-dialog', isToolWindow: false, hidden: false, minimized: false, display: 'block', z: 999 },
  // Ventana cerrada (oculta y no minimizada) → fuera (antes fantasma de persistencia).
  { id: 'gallery-modal',  module: 'gallery-modal', isToolWindow: true,  hidden: true,  minimized: false, display: 'none',  z: 10 },
];

test('selectSwitchableWindows: incluye solo ventanas-herramienta abiertas/minimizadas', () => {
  const v = selectSwitchableWindows(escena);
  // Ordenadas por z ASCENDENTE: hoststats(40) < cortex(120) < term(130).
  assert.deepEqual(v.map((x) => x.id), ['hoststats-modal', 'cortex-modal', 'term-modal--2']);
  // El diálogo de confirmación y la ventana cerrada NO aparecen.
  assert.equal(v.some((x) => x.id === 'confirm-dialog'), false);
  assert.equal(v.some((x) => x.id === 'gallery-modal'), false);
});

test('selectSwitchableWindows: Cortex y Terminal (las abiertas reales) SÍ están listadas', () => {
  const v = selectSwitchableWindows(escena);
  assert.ok(v.some((x) => x.id === 'cortex-modal'), 'Cortex debe aparecer');
  assert.ok(v.some((x) => x.id === 'term-modal--2'), 'Terminal debe aparecer');
  // Y el módulo del clon de terminal es su TIPO (lo provee el caller ya derivado).
  assert.equal(v.find((x) => x.id === 'term-modal--2').module, 'term-modal');
});

test('selectSwitchableWindows: el fantasma de persistencia NO se cuela (fuente = DOM)', () => {
  // "Document" venía del id virtual doc-panel con open:true heredado. Al leer del
  // DOM, si no hay elemento no hay descriptor → nunca entra. Aquí simplemente no
  // está en la entrada, y el resultado no lo fabrica.
  const v = selectSwitchableWindows(escena);
  assert.equal(v.some((x) => x.id === 'doc-panel'), false);
  assert.equal(v.some((x) => x.module === 'doc-panel'), false);
});

test('selectSwitchableWindows: una ventana MINIMIZADA se lista (para restaurarla)', () => {
  const v = selectSwitchableWindows([
    { id: 'notes-panel', module: 'notes-panel', isToolWindow: true, hidden: true, minimized: true, display: 'none', z: 5 },
  ]);
  assert.equal(v.length, 1);
  assert.equal(v[0].id, 'notes-panel');
  assert.equal(v[0].minimized, true); // minimized gana sobre hidden
});

test('selectSwitchableWindows: display:none cuenta como oculta (cerrada)', () => {
  const v = selectSwitchableWindows([
    { id: 'x-modal', module: 'x-modal', isToolWindow: true, hidden: false, minimized: false, display: 'none', z: 1 },
  ]);
  assert.deepEqual(v, []);
});

test('selectSwitchableWindows: module cae al id cuando falta', () => {
  const v = selectSwitchableWindows([
    { id: 'lone-modal', isToolWindow: true, hidden: false, minimized: false, display: 'block', z: 1 },
  ]);
  assert.equal(v[0].module, 'lone-modal');
});

test('selectSwitchableWindows: entradas inválidas/no-array se manejan sin lanzar', () => {
  assert.deepEqual(selectSwitchableWindows(null), []);
  assert.deepEqual(selectSwitchableWindows('nope'), []);
  const v = selectSwitchableWindows([
    null,
    {},
    { id: '' },
    { id: 'no-tool', isToolWindow: false, hidden: false, display: 'block' },
    { id: 'ok', module: 'ok', isToolWindow: true, hidden: false, minimized: false, display: 'block', z: 1 },
  ]);
  assert.equal(v.length, 1);
  assert.equal(v[0].id, 'ok');
});

test('selectSwitchableWindows: orden estable para z iguales (terminales, #29a)', () => {
  const v = selectSwitchableWindows([
    { id: 'term-modal',    module: 'term-modal', isToolWindow: true, hidden: false, minimized: false, display: 'block', z: 100 },
    { id: 'term-modal--2', module: 'term-modal', isToolWindow: true, hidden: false, minimized: false, display: 'block', z: 100 },
    { id: 'term-modal--3', module: 'term-modal', isToolWindow: true, hidden: false, minimized: false, display: 'block', z: 100 },
  ]);
  assert.deepEqual(v.map((x) => x.id), ['term-modal', 'term-modal--2', 'term-modal--3']);
});

test('integración: selectSwitchableWindows → buildSwitcher lista SOLO las reales', () => {
  const open = selectSwitchableWindows(escena);
  const labels = { 'cortex-modal': 'Cortex', 'term-modal': 'Terminal', 'hoststats-modal': 'Host Stats' };
  const view = buildSwitcher(open, labels, 'term-modal--2');
  assert.deepEqual(view.map((x) => x.label), ['Host Stats', 'Cortex', 'Terminal']);
  assert.deepEqual(view.map((x) => x.active), [false, false, true]);
});
