// Tests del árbitro del gesto de Escape (ver static/js/escGesture.js).
//
// El módulo es libre de DOM y con reloj inyectado a propósito, igual que
// escMenuStack.js: lo que hay que poder afirmar aquí es que un Escape sostenido
// NO cierra dos cosas y que el auto-repeat del teclado no impide para siempre
// que el hold se cumpla — dos cosas que a través del DOM y con un reloj real
// serían tests lentos y frágiles.
//
// Corre sin DOM y sin reloj: `node --test tests/esc_gesture.test.mjs`.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MS_HOLD_MINIMO,
  MS_HOLD_POR_DEFECTO,
  crearArbitroEsc,
} from '../static/js/escGesture.js';

// Reloj falso: `avanzar(ms)` cumple los temporizadores vencidos, en orden.
function mundoFalso(extra = {}) {
  let t = 0;
  let sig = 1;
  const pendientes = new Map();
  const taps = [];
  const holds = [];
  const mundo = {
    programar(fn, ms) {
      const h = sig++;
      pendientes.set(h, { fn, vence: t + ms });
      return h;
    },
    cancelar(h) { pendientes.delete(h); },
    alTap() { taps.push(t); },
    alHold() { holds.push(t); },
    ...extra,
  };
  return {
    mundo,
    taps,
    holds,
    pendientes,
    avanzar(ms) {
      t += ms;
      for (const [h, p] of [...pendientes.entries()].sort((a, b) => a[1].vence - b[1].vence)) {
        if (p.vence <= t) { pendientes.delete(h); p.fn(); }
      }
    },
  };
}

const ESC = { key: 'Escape' };
const ESC_REPE = { key: 'Escape', repeat: true };

test('un Escape corto es un TAP', () => {
  const f = mundoFalso();
  const a = crearArbitroEsc(f.mundo);
  assert.equal(a.keydown(ESC), true, 'el árbitro debió tomar el keydown de Escape');
  f.avanzar(200);
  assert.equal(a.keyup(ESC), true);
  assert.deepEqual(f.holds, [], 'disparó un hold con un Escape corto');
  assert.equal(f.taps.length, 1, 'no disparó el tap');
  assert.equal(a.estado().abajo, false);
});

test('un Escape sostenido es un HOLD y NO dispara además un tap al soltar', () => {
  const f = mundoFalso();
  const a = crearArbitroEsc(f.mundo);
  a.keydown(ESC);
  f.avanzar(MS_HOLD_POR_DEFECTO);
  assert.equal(f.holds.length, 1, 'el hold no se cumplió al vencer el tiempo');
  assert.equal(a.estado().holdDisparado, true);
  a.keyup(ESC);
  assert.deepEqual(f.taps, [], 'un hold disparó ADEMÁS un tap: cerraría dos cosas');
  assert.equal(f.holds.length, 1, 'el hold se disparó dos veces');
});

test('el auto-repeat del teclado NO reinicia el temporizador', () => {
  const f = mundoFalso();
  const a = crearArbitroEsc(f.mundo);
  a.keydown(ESC);
  // El navegador emite keydown repetidos mientras la tecla sigue apretada.
  for (let i = 0; i < 20; i++) { f.avanzar(50); a.keydown(ESC_REPE); }
  // Han pasado 1000 ms de reloj; el hold aún no toca.
  assert.deepEqual(f.holds, [], 'el hold se cumplió antes de tiempo');
  f.avanzar(MS_HOLD_POR_DEFECTO - 1000);
  assert.equal(f.holds.length, 1,
    'el auto-repeat reprogramó el temporizador: el hold jamás se cumpliría');
});

test('un keydown repetido SIN el flag repeat tampoco reprograma', () => {
  // Algunos entornos no marcan `repeat`; el gesto en curso ya es razón suficiente.
  const f = mundoFalso();
  const a = crearArbitroEsc(f.mundo);
  a.keydown(ESC);
  f.avanzar(1000);
  a.keydown(ESC);
  f.avanzar(MS_HOLD_POR_DEFECTO - 1000);
  assert.equal(f.holds.length, 1, 'un segundo keydown reprogramó el temporizador');
});

test('un keyup SIN su keydown no dispara nada', () => {
  const f = mundoFalso();
  const a = crearArbitroEsc(f.mundo);
  assert.equal(a.keyup(ESC), false, 'tomó un keyup que no era suyo');
  assert.deepEqual(f.taps, []);
  assert.deepEqual(f.holds, []);
});

test('cancelar() olvida el gesto sin disparar nada, ni luego', () => {
  const f = mundoFalso();
  const a = crearArbitroEsc(f.mundo);
  a.keydown(ESC);
  f.avanzar(500);
  a.cancelar();
  f.avanzar(5000);
  assert.deepEqual(f.holds, [], 'el temporizador cancelado igual disparó: cerraría algo fuera de foco');
  assert.equal(a.keyup(ESC), false, 'tras cancelar, el keyup pendiente disparó un tap');
  assert.deepEqual(f.taps, []);
  assert.equal(a.estado().abajo, false);
});

test('las teclas que no son Escape se devuelven al caller', () => {
  const f = mundoFalso();
  const a = crearArbitroEsc(f.mundo);
  for (const ev of [{ key: 'Enter' }, { key: 'a' }, { key: 'Esc' }, { key: '' }]) {
    assert.equal(a.keydown(ev), false, `tomó ${JSON.stringify(ev)}: rompería los demás atajos`);
    assert.equal(a.keyup(ev), false);
  }
  assert.equal(a.estado().abajo, false);
});

test('un ev que no es un evento no lanza y no es del árbitro', () => {
  const f = mundoFalso();
  const a = crearArbitroEsc(f.mundo);
  for (const ev of [null, undefined, 42, 'Escape', {}]) {
    assert.equal(a.keydown(ev), false, `tomó ${JSON.stringify(ev)}`);
    assert.equal(a.keyup(ev), false);
  }
});

test('msHold se respeta cuando es razonable', () => {
  const f = mundoFalso({ msHold: 900 });
  const a = crearArbitroEsc(f.mundo);
  assert.equal(a.estado().msHold, 900);
  a.keydown(ESC);
  f.avanzar(899);
  assert.deepEqual(f.holds, []);
  f.avanzar(1);
  assert.equal(f.holds.length, 1);
});

test('un msHold inusable cae al default, y estado() dice el EFECTIVO', () => {
  for (const malo of [0, -100, 5, NaN, Infinity, null, undefined, 'mil', {}]) {
    const f = mundoFalso({ msHold: malo });
    const a = crearArbitroEsc(f.mundo);
    assert.equal(a.estado().msHold, MS_HOLD_POR_DEFECTO,
      `msHold ${JSON.stringify(malo)} no cayó al default`);
  }
  // Y el piso es el piso: exactamente MS_HOLD_MINIMO sí se acepta.
  const f = mundoFalso({ msHold: MS_HOLD_MINIMO });
  assert.equal(crearArbitroEsc(f.mundo).estado().msHold, MS_HOLD_MINIMO);
});

test('un mundo incompleto o nulo no impide construir el árbitro', () => {
  for (const m of [null, undefined, {}, { programar: null }]) {
    const a = crearArbitroEsc(m);
    assert.equal(typeof a.keydown, 'function', `mundo ${JSON.stringify(m)} no devolvió un árbitro`);
    // Y usarlo no lanza.
    a.keydown(ESC);
    a.keyup(ESC);
    a.cancelar();
    a.estado();
  }
});

test('un callback que LANZA no deja al árbitro creyendo que la tecla sigue abajo', () => {
  const f = mundoFalso({ alTap() { throw new Error('el módulo de arriba explotó'); } });
  const a = crearArbitroEsc(f.mundo);
  a.keydown(ESC);
  a.keyup(ESC);
  assert.equal(a.estado().abajo, false,
    'el árbitro quedó atorado: el Escape dejaría de funcionar en toda la app');
  // Y con alHold: al cumplirse el hold la tecla SIGUE fisicamente abajo, asi que
  // `abajo` es true hasta el keyup — eso es correcto, no un atoron. Lo que hay
  // que comprobar es que la excepcion no impida que el keyup lo cierre ni que el
  // gesto siguiente funcione.
  const f2 = mundoFalso({ alHold() { throw new Error('boom'); } });
  const a2 = crearArbitroEsc(f2.mundo);
  a2.keydown(ESC);
  f2.avanzar(MS_HOLD_POR_DEFECTO);
  assert.equal(f2.holds.length, 0, 'holds solo cuenta los que NO lanzaron');
  a2.keyup(ESC);
  assert.equal(a2.estado().abajo, false, 'tras un alHold que lanzo, el keyup no cerro el gesto');
  a2.keydown(ESC);
  f2.avanzar(MS_HOLD_POR_DEFECTO);
  assert.equal(a2.estado().holdDisparado, true, 'el arbitro no acepto un gesto nuevo tras la excepcion');
});

test('estado() devuelve una COPIA', () => {
  const f = mundoFalso();
  const a = crearArbitroEsc(f.mundo);
  const e = a.estado();
  e.abajo = true;
  e.msHold = 99;
  assert.equal(a.estado().abajo, false, 'mutar lo devuelto por estado() cambió el árbitro');
  assert.equal(a.estado().msHold, MS_HOLD_POR_DEFECTO);
});

test('no se acumulan temporizadores: un solo gesto a la vez', () => {
  const f = mundoFalso();
  const a = crearArbitroEsc(f.mundo);
  a.keydown(ESC);
  a.keydown(ESC_REPE);
  a.keydown(ESC_REPE);
  assert.equal(f.pendientes.size, 1, `quedaron ${f.pendientes.size} temporizadores vivos`);
  f.avanzar(MS_HOLD_POR_DEFECTO);
  assert.equal(f.holds.length, 1, 'el hold se disparó una vez por keydown');
});

test('tap y hold se pueden alternar en gestos sucesivos', () => {
  const f = mundoFalso();
  const a = crearArbitroEsc(f.mundo);
  a.keydown(ESC); f.avanzar(100); a.keyup(ESC);                       // tap
  a.keydown(ESC); f.avanzar(MS_HOLD_POR_DEFECTO); a.keyup(ESC);       // hold
  a.keydown(ESC); f.avanzar(100); a.keyup(ESC);                       // tap
  assert.equal(f.taps.length, 2, `taps: ${f.taps.length}`);
  assert.equal(f.holds.length, 1, `holds: ${f.holds.length}`);
  assert.equal(a.estado().holdDisparado, false, 'el flag del hold no se limpió en el gesto siguiente');
});
