// Tests del registro de regiones reservadas por borde (ver static/js/edgeRegions.js).
//
// El módulo es puro a propósito: recibe el borde, el id del widget y el tamaño,
// y emite el total por borde a través del sink de IO inyectado `setVar`. Eso es
// lo que permite probar aquí lo que a través del DOM no se puede afirmar — que
// dos widgets del MISMO borde SUMAN exactamente el total, que release baja el
// total al del que queda, que reservar dos veces el mismo id REEMPLAZA (no
// acumula), y que una entrada inválida no lanza ni toca los totales.
//
// Corre sin DOM y sin reloj: `node --test tests/edge_regions.test.mjs`.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BORDES,
  esBorde,
  createEdgeRegions,
} from '../static/js/edgeRegions.js';

/**
 * Crea un registro con un sink de IO que registra cada llamada a setVar.
 * Devuelve { api, llamadas } donde llamadas es un array de [nombre, valor].
 */
function conSink() {
  const llamadas = [];
  const api = createEdgeRegions({
    setVar: (nombre, valor) => {
      llamadas.push([nombre, valor]);
    },
  });
  return { api, llamadas };
}

// Último valor emitido para una variable concreta (o null si no se emitió).
function ultimoValor(llamadas, nombre) {
  for (let i = llamadas.length - 1; i >= 0; i--) {
    if (llamadas[i][0] === nombre) return llamadas[i][1];
  }
  return null;
}

test('reservar un widget en un borde emite --reserved-<edge> con su px', () => {
  const { api, llamadas } = conSink();
  api.reserve('bottom', 'hoststats', 120);
  assert.equal(ultimoValor(llamadas, '--reserved-bottom'), '120px');
  assert.equal(api.total('bottom'), 120);
});

test('DOS widgets en el MISMO borde suman; setVar refleja la suma', () => {
  const { api, llamadas } = conSink();
  api.reserve('bottom', 'hoststats', 120);
  api.reserve('bottom', 'otro', 80);
  assert.equal(api.total('bottom'), 200, 'los dos widgets del borde no suman');
  assert.equal(ultimoValor(llamadas, '--reserved-bottom'), '200px');
});

test('release uno baja el total al del que queda', () => {
  const { api, llamadas } = conSink();
  api.reserve('bottom', 'hoststats', 120);
  api.reserve('bottom', 'otro', 80);
  api.release('bottom', 'hoststats');
  assert.equal(api.total('bottom'), 80, 'release no bajó el total al del que queda');
  assert.equal(ultimoValor(llamadas, '--reserved-bottom'), '80px');
});

test('reservar repetido del MISMO id reemplaza, no acumula', () => {
  const { api, llamadas } = conSink();
  api.reserve('bottom', 'hoststats', 120);
  api.reserve('bottom', 'hoststats', 60);
  assert.equal(api.total('bottom'), 60, 'repetir el mismo id acumuló en vez de reemplazar');
  assert.equal(ultimoValor(llamadas, '--reserved-bottom'), '60px');
});

test('edge inválido no lanza ni cambia totales', () => {
  const { api, llamadas } = conSink();
  api.reserve('bottom', 'hoststats', 120);
  const antes = api.total('bottom');
  const ok = api.reserve('diagonal', 'hoststats', 50);
  assert.equal(ok, false, 'reservó con un borde inválido');
  assert.equal(api.total('bottom'), antes, 'un borde inválido tocó el total');
  // release con borde inválido tampoco lanza.
  assert.equal(api.release('diagonal', 'hoststats'), false);
  assert.equal(api.total('bottom'), antes);
});

test('sizePx negativo o NaN no lanza ni cambia totales', () => {
  const { api } = conSink();
  api.reserve('bottom', 'hoststats', 120);
  const antes = api.total('bottom');
  assert.equal(api.reserve('bottom', 'otro', -5), false, 'reservó un tamaño negativo');
  assert.equal(api.reserve('bottom', 'otro', NaN), false, 'reservó un tamaño NaN');
  assert.equal(api.reserve('bottom', 'otro', Infinity), false, 'reservó un tamaño Infinity');
  assert.equal(api.total('bottom'), antes, 'un tamaño inválido tocó el total');
});

test('bordes independientes: reservar en bottom no toca top/left/right', () => {
  const { api, llamadas } = conSink();
  api.reserve('bottom', 'hoststats', 120);
  assert.equal(api.total('top'), 0);
  assert.equal(api.total('left'), 0);
  assert.equal(api.total('right'), 0);
  // Y las variables de los otros bordes se emitieron a 0px, no al valor de bottom.
  assert.equal(ultimoValor(llamadas, '--reserved-top'), '0px');
  assert.equal(ultimoValor(llamadas, '--reserved-left'), '0px');
  assert.equal(ultimoValor(llamadas, '--reserved-right'), '0px');
});

test('release de un id que no existe no lanza ni emite', () => {
  const { api, llamadas } = conSink();
  const n = llamadas.length;
  assert.equal(api.release('bottom', 'inexistente'), false);
  assert.equal(llamadas.length, n, 'emitió variables al release de un id inexistente');
});

test('esBorde acepta los 4 bordes y rechaza el resto', () => {
  for (const b of BORDES) assert.equal(esBorde(b), true, `esBorde rechazó ${b}`);
  assert.equal(esBorde('diagonal'), false);
  assert.equal(esBorde(''), false);
  assert.equal(esBorde(null), false);
});
