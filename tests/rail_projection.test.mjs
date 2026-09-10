// Tests de la proyección pura del estado del workspace al rail
// (ver static/js/railProjection.js).
//
// El módulo es puro a propósito: recibe el mapa de estados que devuelve
// `workspaceState.all()` y la lista de items del rail, y devuelve una vista por
// item — open / minimized / instanceCount / active — sin tocar el DOM, sin leer
// `window` y sin suscribirse a nada. Eso es lo que permite probar aquí lo que a
// través del DOM no se puede afirmar: que un módulo abierto no-minimizado
// proyecta active:true, que uno minimizado proyecta active:false, que un módulo
// ausente del estado proyecta todo cerrado, que el ORDEN de salida es el de
// entrada, y que una entrada inválida (railItems no-array, railItem sin id,
// moduleStates no-objeto) no lanza.
//
// Corre sin DOM y sin reloj: `node --test tests/rail_projection.test.mjs`.
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectRail } from '../static/js/railProjection.js';

// Un mapa de estados con el SHAPE real de workspaceState.all() (ver header de
// workspaceState.js, "SHAPE (v1)"): cada módulo trae open/minimized/mode/dock.
function mapa(modulos) {
  return modulos;
}

test('módulo abierto no-minimizado → open:true, active:true, instanceCount:1', () => {
  const estados = mapa({
    'hoststats-modal': { module: 'hoststats-modal', open: true, minimized: false, mode: 'full' },
  });
  const vistas = projectRail(estados, [{ railId: 'rail-hoststats', moduleId: 'hoststats-modal' }]);
  assert.equal(vistas.length, 1);
  assert.equal(vistas[0].open, true);
  assert.equal(vistas[0].minimized, false);
  assert.equal(vistas[0].active, true, 'abierto no-minimizado no proyecta active');
  assert.equal(vistas[0].instanceCount, 1, 'sin campo de instancias, open → 1');
});

test('módulo abierto minimizado → open:true, minimized:true, active:false', () => {
  const estados = mapa({
    'terminal': { module: 'terminal', open: true, minimized: true, mode: 'compact' },
  });
  const vistas = projectRail(estados, [{ railId: 'rail-terminal', moduleId: 'terminal' }]);
  assert.equal(vistas[0].open, true);
  assert.equal(vistas[0].minimized, true, 'minimizado no se proyectó');
  assert.equal(vistas[0].active, false, 'minimizado no puede estar activo');
  assert.equal(vistas[0].instanceCount, 1);
});

test('módulo cerrado (open:false) → todo false, instanceCount:0', () => {
  const estados = mapa({
    'compare': { module: 'compare', open: false, minimized: false },
  });
  const vistas = projectRail(estados, [{ railId: 'rail-compare', moduleId: 'compare' }]);
  assert.equal(vistas[0].open, false);
  assert.equal(vistas[0].minimized, false);
  assert.equal(vistas[0].active, false);
  assert.equal(vistas[0].instanceCount, 0, 'cerrado → 0 instancias');
});

test('módulo AUSENTE del estado → todo false, instanceCount:0 (no lanza)', () => {
  const estados = mapa({ 'otro': { open: true, minimized: false } });
  const vistas = projectRail(estados, [{ railId: 'rail-fantasma', moduleId: 'no-existe' }]);
  assert.equal(vistas.length, 1, 'un railItem válido siempre emite una vista');
  assert.equal(vistas[0].open, false);
  assert.equal(vistas[0].minimized, false);
  assert.equal(vistas[0].active, false);
  assert.equal(vistas[0].instanceCount, 0);
});

test('N instancias del MISMO tipo (keyeadas por instanceId) → instanceCount N, open true (#29a)', () => {
  // workspaceState keyea por INSTANCIA; el `.module` es el TIPO. Con varias
  // terminales, el mapa trae N claves distintas con el MISMO `.module`. La
  // proyección agrupa por `.module`, no por la clave (un lookup directo
  // mapa['terminal'] daría undefined → cerrado, que era el bug ALTO del auditor).
  const estados = mapa({
    'terminal-1': { module: 'terminal', open: true, minimized: false },
    'terminal-2': { module: 'terminal', open: true, minimized: true },
    'terminal-3': { module: 'terminal', open: true, minimized: false },
    'compare':    { module: 'compare', open: true, minimized: false },
  });
  const vistas = projectRail(estados, [{ railId: 'rail-terminal', moduleId: 'terminal' }]);
  assert.equal(vistas[0].open, true, 'con 3 terminales abiertas el rail NO puede decir cerrado');
  assert.equal(vistas[0].instanceCount, 3, 'debe contar las 3 instancias del tipo terminal');
  assert.equal(vistas[0].active, true, 'al menos una terminal no-minimizada → activo');
});

test('N instancias del mismo tipo, TODAS minimizadas → open true pero active false', () => {
  const estados = mapa({
    'terminal-1': { module: 'terminal', open: true, minimized: true },
    'terminal-2': { module: 'terminal', open: true, minimized: true },
  });
  const vistas = projectRail(estados, [{ railId: 'rail-terminal', moduleId: 'terminal' }]);
  assert.equal(vistas[0].open, true);
  assert.equal(vistas[0].instanceCount, 2);
  assert.equal(vistas[0].active, false, 'todas minimizadas → ninguna visible');
  assert.equal(vistas[0].minimized, true, 'abierto pero ninguna visible → minimized (estado del rail)');
});

test('orden de salida == orden de railItems', () => {
  const estados = mapa({
    'a': { open: true, minimized: false },
    'b': { open: false, minimized: false },
    'c': { open: true, minimized: true },
  });
  const railItems = [
    { railId: 'rail-c', moduleId: 'c' },
    { railId: 'rail-a', moduleId: 'a' },
    { railId: 'rail-b', moduleId: 'b' },
  ];
  const vistas = projectRail(estados, railItems);
  assert.deepEqual(
    vistas.map((v) => v.railId),
    ['rail-c', 'rail-a', 'rail-b'],
    'el orden de salida no es el de entrada'
  );
});

test('railItems no-array → []', () => {
  const estados = mapa({ 'a': { open: true, minimized: false } });
  assert.deepEqual(projectRail(estados, null), []);
  assert.deepEqual(projectRail(estados, undefined), []);
  assert.deepEqual(projectRail(estados, 'no-array'), []);
  assert.deepEqual(projectRail(estados, { railId: 'x', moduleId: 'a' }), []);
});

test('railItem inválido (sin railId o sin moduleId, o no-cadena) → se omite, sin lanzar', () => {
  const estados = mapa({ 'a': { open: true, minimized: false } });
  const vistas = projectRail(estados, [
    { railId: 'rail-ok', moduleId: 'a' },
    { moduleId: 'a' },                 // sin railId
    { railId: 'rail-sin-mod' },        // sin moduleId
    { railId: '', moduleId: 'a' },     // railId vacío
    { railId: 'rail-x', moduleId: '' },// moduleId vacío
    { railId: 42, moduleId: 'a' },     // railId no-cadena
    { railId: 'rail-y', moduleId: 7 }, // moduleId no-cadena
    null,                              // item nulo
    'no-objeto',                       // item no-objeto
  ]);
  assert.equal(vistas.length, 1, 'solo el railItem válido debe emitirse');
  assert.equal(vistas[0].railId, 'rail-ok');
  assert.equal(vistas[0].moduleId, 'a');
});

test('moduleStates no-objeto → todo cerrado, pero sigue emitiendo una vista por railItem válido', () => {
  const vistas = projectRail(null, [{ railId: 'rail-a', moduleId: 'a' }]);
  assert.equal(vistas.length, 1);
  assert.equal(vistas[0].open, false);
  assert.equal(vistas[0].minimized, false);
  assert.equal(vistas[0].active, false);
  assert.equal(vistas[0].instanceCount, 0);

  // undefined y no-objeto también se tratan como vacío.
  assert.deepEqual(projectRail(undefined, [{ railId: 'rail-a', moduleId: 'a' }])[0].open, false);
  assert.deepEqual(projectRail('no-objeto', [{ railId: 'rail-a', moduleId: 'a' }])[0].open, false);
});

test('una entrada basura en el mapa (moduleId presente pero no-objeto) → cerrado, no lanza', () => {
  const estados = { 'a': null, 'b': 'basura', 'c': { module: 'c', open: true, minimized: false } };
  const vistas = projectRail(estados, [
    { railId: 'rail-a', moduleId: 'a' },
    { railId: 'rail-b', moduleId: 'b' },
    { railId: 'rail-c', moduleId: 'c' },
  ]);
  assert.equal(vistas[0].open, false, 'null en el mapa no debe proyectar abierto');
  assert.equal(vistas[1].open, false, 'cadena en el mapa no debe proyectar abierto');
  assert.equal(vistas[2].open, true, 'el módulo sano sí proyecta abierto');
});
