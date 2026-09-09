/**
 * tests/tile_shortcuts.test.mjs — Lógica PURO de tileShortcuts.js:
 * mapeo atajo→slot y ciclado. Sin DOM (claveDeEvento/slotParaClave/atajoDeEvento
 * solo inspeccionan el evento; el ciclado se prueba contra tileSlots.calcular).
 *
 * Correr: node --test tests/tile_shortcuts.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Importamos SOLO las funciones puras. tileShortcuts.js importa tileManager.js
// (que toca el DOM) — para no arrastrar el DOM al test, probamos la lógica de
// mapeo re-implementando la tabla ATAJOS aquí NO: mejor importamos el módulo
// completo; sus imports de tileManager/workspaceState son nominales y no
// ejecutan código de DOM al importar (solo definen funciones). Si el entorno
// no tiene `document`, las funciones puras siguen siendo testables.
import { claveDeEvento, slotParaClave, atajoDeEvento, ATAJOS } from '../static/js/tileShortcuts.js';
import { calcular, estadoInicial, FRACCIONES } from '../static/js/tileSlots.js';

// ── Mapeo atajo → slot ──

test('Ctrl+Alt+← → left', () => {
  const e = { ctrlKey: true, altKey: true, metaKey: false, key: 'ArrowLeft' };
  assert.equal(atajoDeEvento(e)?.slot, 'left');
});

test('Ctrl+Alt+→ → right', () => {
  const e = { ctrlKey: true, altKey: true, metaKey: false, key: 'ArrowRight' };
  assert.equal(atajoDeEvento(e)?.slot, 'right');
});

test('Ctrl+Alt+↑ → top', () => {
  const e = { ctrlKey: true, altKey: true, metaKey: false, key: 'ArrowUp' };
  assert.equal(atajoDeEvento(e)?.slot, 'top');
});

test('Ctrl+Alt+↓ → bottom', () => {
  const e = { ctrlKey: true, altKey: true, metaKey: false, key: 'ArrowDown' };
  assert.equal(atajoDeEvento(e)?.slot, 'bottom');
});

test('Ctrl+Alt+U/I/J/K → cuartos', () => {
  assert.equal(atajoDeEvento({ ctrlKey: true, altKey: true, metaKey: false, key: 'u' })?.slot, 'top-left');
  assert.equal(atajoDeEvento({ ctrlKey: true, altKey: true, metaKey: false, key: 'i' })?.slot, 'top-right');
  assert.equal(atajoDeEvento({ ctrlKey: true, altKey: true, metaKey: false, key: 'j' })?.slot, 'bottom-left');
  assert.equal(atajoDeEvento({ ctrlKey: true, altKey: true, metaKey: false, key: 'k' })?.slot, 'bottom-right');
});

test('Ctrl+Alt+Enter → maximize', () => {
  assert.equal(atajoDeEvento({ ctrlKey: true, altKey: true, metaKey: false, key: 'Enter' })?.slot, 'maximize');
});

test('Ctrl+Alt+C → center', () => {
  assert.equal(atajoDeEvento({ ctrlKey: true, altKey: true, metaKey: false, key: 'c' })?.slot, 'center');
});

test('Ctrl+Alt+R → restore', () => {
  assert.equal(atajoDeEvento({ ctrlKey: true, altKey: true, metaKey: false, key: 'r' })?.slot, 'restore');
});

// ── No-atajos (deben devolver null) ──

test('sin Ctrl → null', () => {
  assert.equal(atajoDeEvento({ ctrlKey: false, altKey: true, metaKey: false, key: 'ArrowLeft' }), null);
});

test('sin Alt → null', () => {
  assert.equal(atajoDeEvento({ ctrlKey: true, altKey: false, metaKey: false, key: 'ArrowLeft' }), null);
});

test('con Meta (Cmd) → null', () => {
  assert.equal(atajoDeEvento({ ctrlKey: true, altKey: true, metaKey: true, key: 'ArrowLeft' }), null);
});

test('tecla no mapeada → null', () => {
  assert.equal(atajoDeEvento({ ctrlKey: true, altKey: true, metaKey: false, key: 'x' }), null);
});

test('evento nulo → null', () => {
  assert.equal(atajoDeEvento(null), null);
});

// ── Ciclado de mitades (vía tileSlots.calcular, la lógica que el atajo invoca) ──

const AREA = { left: 0, top: 0, width: 1200, height: 800 };
const RECT_LIBRE = { left: 100, top: 100, width: 400, height: 300 };

test('mitad-izq: 1ª vez → 1/2 del ancho', () => {
  const { rect, estado } = calcular(estadoInicial(), 'left', AREA, RECT_LIBRE);
  assert.equal(rect.width, 600);   // 1200 / 2
  assert.equal(rect.left, 0);
  assert.equal(estado.paso, 0);
});

test('mitad-izq: 2ª vez (cicla) → 2/3 del ancho', () => {
  const e1 = calcular(estadoInicial(), 'left', AREA, RECT_LIBRE).estado;
  const { rect, estado } = calcular(e1, 'left', AREA, RECT_LIBRE);
  assert.equal(rect.width, 800);   // 1200 * 2/3
  assert.equal(estado.paso, 1);
});

test('mitad-izq: 3ª vez (cicla) → 1/3 del ancho', () => {
  const e1 = calcular(estadoInicial(), 'left', AREA, RECT_LIBRE).estado;
  const e2 = calcular(e1, 'left', AREA, RECT_LIBRE).estado;
  const { rect, estado } = calcular(e2, 'left', AREA, RECT_LIBRE);
  assert.equal(rect.width, 400);   // 1200 * 1/3
  assert.equal(estado.paso, 2);
});

test('mitad-izq: 4ª vez (cicla) → vuelve a 1/2', () => {
  const e1 = calcular(estadoInicial(), 'left', AREA, RECT_LIBRE).estado;
  const e2 = calcular(e1, 'left', AREA, RECT_LIBRE).estado;
  const e3 = calcular(e2, 'left', AREA, RECT_LIBRE).estado;
  const { rect, estado } = calcular(e3, 'left', AREA, RECT_LIBRE);
  assert.equal(rect.width, 600);
  assert.equal(estado.paso, 0);
});

test('cambiar de slot reinicia el paso a 0', () => {
  const e1 = calcular(estadoInicial(), 'left', AREA, RECT_LIBRE).estado;   // paso 0
  const e2 = calcular(e1, 'left', AREA, RECT_LIBRE).estado;                // paso 1
  const { estado } = calcular(e2, 'right', AREA, RECT_LIBRE);              // slot nuevo
  assert.equal(estado.paso, 0);
});

test('cuartos NO ciclan (siempre 1/2)', () => {
  const e1 = calcular(estadoInicial(), 'top-left', AREA, RECT_LIBRE).estado;
  const { rect, estado } = calcular(e1, 'top-left', AREA, RECT_LIBRE);
  assert.equal(rect.width, 600);   // 1200 / 2
  assert.equal(rect.height, 400);  // 800 / 2
  assert.equal(estado.paso, 0);
});

test('FRACCIONES tiene 3 pasos (1/2, 2/3, 1/3)', () => {
  assert.equal(FRACCIONES.length, 3);
  assert.equal(FRACCIONES[0], 1 / 2);
  assert.equal(FRACCIONES[1], 2 / 3);
  assert.equal(FRACCIONES[2], 1 / 3);
});

test('ATAJOS cubre los 11 atajos documentados', () => {
  const claves = Object.keys(ATAJOS).sort();
  assert.equal(claves.length, 11);
  assert.ok(claves.includes('ctrl+alt+arrowleft'));
  assert.ok(claves.includes('ctrl+alt+enter'));
  assert.ok(claves.includes('ctrl+alt+c'));
});
