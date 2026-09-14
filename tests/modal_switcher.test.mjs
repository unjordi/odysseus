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
