// Tests del cálculo de mosaico estilo Rectangle (ver static/js/tileSlots.js).
//
// El módulo es puro a propósito: recibe el área útil ya medida y devuelve el
// rectángulo destino. Eso es lo que permite probar aquí lo que a través del DOM
// no se puede afirmar — que las dos mitades de una partición SUMAN exactamente
// el ancho, que el ciclado es predecible, y que un área degenerada no produce
// una ventana invisible.
//
// Corre sin DOM y sin reloj: `node --test tests/tile_slots.test.mjs`.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SLOTS,
  FRACCIONES,
  calcular,
  esSlot,
  estadoInicial,
} from '../static/js/tileSlots.js';

// Ancho IMPAR a propósito: es donde se ve el píxel de hueco o de traslape.
const AREA = { left: 100, top: 50, width: 1281, height: 723 };
const LIBRE = { left: 300, top: 200, width: 640, height: 480 };

function esEntero(r, etiqueta) {
  for (const k of ['left', 'top', 'width', 'height']) {
    assert.ok(Number.isInteger(r[k]), `${etiqueta}: ${k} no es entero (${r[k]})`);
  }
}

test('las dos mitades cubren el área sin hueco ni traslape, con ancho impar', () => {
  const izq = calcular(estadoInicial(), 'left', AREA, LIBRE);
  const der = calcular(estadoInicial(), 'right', AREA, LIBRE);

  esEntero(izq.rect, 'left');
  esEntero(der.rect, 'right');
  assert.equal(izq.rect.left, AREA.left);
  assert.equal(izq.rect.width + der.rect.width, AREA.width, 'las dos mitades no suman el ancho');
  assert.equal(der.rect.left, AREA.left + izq.rect.width, 'la mitad derecha no arranca donde acaba la izquierda');
  // Y ocupan todo el alto.
  assert.equal(izq.rect.height, AREA.height);
  assert.equal(der.rect.height, AREA.height);
});

test('arriba y abajo cubren el alto sin hueco ni traslape, con alto impar', () => {
  const arr = calcular(estadoInicial(), 'top', AREA, LIBRE);
  const aba = calcular(estadoInicial(), 'bottom', AREA, LIBRE);
  assert.equal(arr.rect.height + aba.rect.height, AREA.height, 'las dos mitades no suman el alto');
  assert.equal(aba.rect.top, AREA.top + arr.rect.height);
  assert.equal(arr.rect.width, AREA.width);
});

test('repetir el MISMO slot cicla 1/2 -> 2/3 -> 1/3 y vuelve a 1/2', () => {
  let e = estadoInicial();
  const anchos = [];
  for (let i = 0; i < 4; i++) {
    const r = calcular(e, 'left', AREA, LIBRE);
    anchos.push(r.rect.width);
    e = r.estado;
  }
  const esperados = FRACCIONES.map((f) => Math.round(AREA.width * f));
  assert.deepEqual(anchos.slice(0, 3), esperados, 'el ciclado no siguió FRACCIONES');
  assert.equal(anchos[3], esperados[0], 'la cuarta pulsación no volvió a la primera fracción');
});

test('pedir un slot DISTINTO reinicia el ciclo', () => {
  let e = estadoInicial();
  e = calcular(e, 'left', AREA, LIBRE).estado;   // 1/2
  e = calcular(e, 'left', AREA, LIBRE).estado;   // 2/3
  const otro = calcular(e, 'right', AREA, LIBRE);
  assert.equal(otro.estado.paso, 0, 'el paso no se reinició al cambiar de slot');
  assert.equal(otro.rect.width, AREA.width - Math.round(AREA.width * FRACCIONES[0]),
    'la mitad derecha no arrancó en la primera fracción');
});

test('los cuartos no ciclan y los cuatro embaldosan el área exactamente', () => {
  const ti = calcular(estadoInicial(), 'top-left', AREA, LIBRE);
  const td = calcular(estadoInicial(), 'top-right', AREA, LIBRE);
  const bi = calcular(estadoInicial(), 'bottom-left', AREA, LIBRE);
  const bd = calcular(estadoInicial(), 'bottom-right', AREA, LIBRE);

  assert.equal(ti.estado.paso, 0, 'un cuarto no debe avanzar el paso');
  // Repetirlo no lo cambia de tamaño.
  const ti2 = calcular(ti.estado, 'top-left', AREA, LIBRE);
  assert.deepEqual(ti2.rect, ti.rect, 'repetir un cuarto lo cambió de tamaño');

  assert.equal(ti.rect.width + td.rect.width, AREA.width, 'los cuartos no suman el ancho');
  assert.equal(ti.rect.height + bi.rect.height, AREA.height, 'los cuartos no suman el alto');
  assert.equal(td.rect.left, AREA.left + ti.rect.width);
  assert.equal(bi.rect.top, AREA.top + ti.rect.height);
  assert.equal(bd.rect.left + bd.rect.width, AREA.left + AREA.width, 'el cuarto inferior derecho no cierra el área');
  assert.equal(bd.rect.top + bd.rect.height, AREA.top + AREA.height);
});

test('maximize llena el área exactamente', () => {
  const r = calcular(estadoInicial(), 'maximize', AREA, LIBRE);
  assert.deepEqual(r.rect, { left: AREA.left, top: AREA.top, width: AREA.width, height: AREA.height });
});

test('libre se captura en el PRIMER mosaico y no se sobrescribe después', () => {
  const uno = calcular(estadoInicial(), 'left', AREA, LIBRE);
  assert.deepEqual(uno.estado.libre, LIBRE, 'no guardó la geometría libre');

  // La ventana ya está enmosaicada: su rect actual ahora ES el de la mitad.
  const dos = calcular(uno.estado, 'right', AREA, uno.rect);
  assert.deepEqual(dos.estado.libre, LIBRE,
    'sobrescribió libre con la geometría del mosaico anterior — restore devolvería al mosaico, no a lo del usuario');
});

test('restore devuelve la geometría libre y limpia el estado', () => {
  const uno = calcular(estadoInicial(), 'left', AREA, LIBRE);
  const vuelta = calcular(uno.estado, 'restore', AREA, uno.rect);
  assert.deepEqual(vuelta.rect, LIBRE);
  assert.equal(vuelta.estado.slot, null);
  assert.equal(vuelta.estado.paso, 0);
  assert.equal(vuelta.estado.libre, null);
});

test('restore SIN libre guardado no inventa una geometría', () => {
  const e = estadoInicial();
  const r = calcular(e, 'restore', AREA, LIBRE);
  assert.equal(r.rect, null, 'inventó una geometría de restauración');
  assert.deepEqual(r.estado, e, 'tocó el estado sin necesidad');
});

test('center conserva el tamaño actual y lo centra', () => {
  const r = calcular(estadoInicial(), 'center', AREA, LIBRE);
  assert.equal(r.rect.width, LIBRE.width, 'center cambió el ancho');
  assert.equal(r.rect.height, LIBRE.height, 'center cambió el alto');
  // Centrado: el margen de cada lado difiere a lo más en 1 px por el redondeo.
  const izq = r.rect.left - AREA.left;
  const der = (AREA.left + AREA.width) - (r.rect.left + r.rect.width);
  assert.ok(Math.abs(izq - der) <= 1, `no quedó centrado (${izq} vs ${der})`);
});

test('center recorta una ventana más grande que el área', () => {
  const enorme = { left: 0, top: 0, width: AREA.width + 500, height: AREA.height + 500 };
  const r = calcular(estadoInicial(), 'center', AREA, enorme);
  assert.ok(r.rect.width <= AREA.width, 'quedó más ancha que el área: los bordes serían inalcanzables');
  assert.ok(r.rect.height <= AREA.height, 'quedó más alta que el área');
  assert.ok(r.rect.left >= AREA.left && r.rect.top >= AREA.top);
});

test('un área degenerada NO produce una ventana invisible: devuelve null', () => {
  for (const mala of [
    { left: 0, top: 0, width: 0, height: 500 },
    { left: 0, top: 0, width: 800, height: 0 },
    { left: 0, top: 0, width: -10, height: 500 },
    { left: NaN, top: 0, width: 800, height: 500 },
    { left: 0, top: 0, width: Infinity, height: 500 },
    null,
    undefined,
  ]) {
    const e = estadoInicial();
    const r = calcular(e, 'left', mala, LIBRE);
    assert.equal(r.rect, null, `área ${JSON.stringify(mala)} devolvió un rect`);
    assert.deepEqual(r.estado, e, 'tocó el estado con un área inusable');
  }
});

test('un slot desconocido no lanza y no toca el estado', () => {
  for (const malo of ['izquierda', '', null, undefined, 42, {}]) {
    const e = estadoInicial();
    const r = calcular(e, malo, AREA, LIBRE);
    assert.equal(r.rect, null, `el slot ${JSON.stringify(malo)} devolvió un rect`);
    assert.deepEqual(r.estado, e);
  }
});

test('calcular no muta el estado que recibe', () => {
  const e = estadoInicial();
  const copia = JSON.parse(JSON.stringify(e));
  calcular(e, 'left', AREA, LIBRE);
  assert.deepEqual(e, copia, 'mutó el estado de entrada: el render no podría diffear');
});

test('todo lo que sale son enteros', () => {
  // 1281 x 723 es impar en los dos ejes, y 2/3 y 1/3 dan decimales.
  for (const slot of SLOTS) {
    let e = estadoInicial();
    if (slot === 'restore') e = calcular(e, 'left', AREA, LIBRE).estado;
    for (let i = 0; i < 3; i++) {
      const r = calcular(e, slot, AREA, LIBRE);
      if (r.rect) esEntero(r.rect, slot);
      e = r.estado;
      if (slot === 'restore') break;
    }
  }
});

test('esSlot reconoce exactamente los slots del contrato', () => {
  for (const s of SLOTS) assert.ok(esSlot(s), `${s} debería ser slot`);
  for (const s of ['LEFT', 'derecha', '', null, undefined, 0, {}]) {
    assert.equal(esSlot(s), false, `${JSON.stringify(s)} no debería ser slot`);
  }
});

test('el mosaico cabe dentro del área en todos los slots', () => {
  for (const slot of SLOTS) {
    let e = estadoInicial();
    if (slot === 'restore') continue; // restore devuelve lo del usuario, que puede estar fuera
    for (let i = 0; i < 3; i++) {
      const r = calcular(e, slot, AREA, LIBRE);
      if (r.rect) {
        assert.ok(r.rect.left >= AREA.left, `${slot} se salió por la izquierda`);
        assert.ok(r.rect.top >= AREA.top, `${slot} se salió por arriba`);
        assert.ok(r.rect.left + r.rect.width <= AREA.left + AREA.width, `${slot} se salió por la derecha`);
        assert.ok(r.rect.top + r.rect.height <= AREA.top + AREA.height, `${slot} se salió por abajo`);
        assert.ok(r.rect.width > 0 && r.rect.height > 0, `${slot} produjo una ventana invisible`);
      }
      e = r.estado;
    }
  }
});
