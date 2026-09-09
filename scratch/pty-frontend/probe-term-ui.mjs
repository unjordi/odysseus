#!/usr/bin/env node
// scratch/pty-frontend/probe-term-ui.mjs — probe OFFLINE de las decisiones puras del widget de Terminal
// (`static/js/term-geometry.js`). Sin navegador, sin DOM, sin red: aritmética y una máquina de estados.
//
//   node scratch/pty-frontend/probe-term-ui.mjs     # exit 0 = todo verde, exit 1 = alguna aserción falló
//
// POR QUÉ EXISTE: la geometría de la terminal se ha roto DOS veces en producción por la misma clase de error
// —una resta de más, una métrica que miente— y ninguna se ve en un build verde. Aquí van los NÚMEROS REALES
// medidos en el navegador, para que la próxima regresión falle en un comando de 100 ms en vez de en el QA.
//
// CÓMO SE MIDIERON LOS NÚMEROS (2026-09-08, Chrome/Linux, modal de terminal a 760 px):
//   se instrumentó `static/index.html` con el CSS y el DOM reales, se instanció xterm.js y se leyó
//   `getBoundingClientRect()` de las filas ya pintadas. De ahí salen `boxWidth: 738`, `scrollbarWidth: 10`
//   (`scrollbar-width: thin` de Chrome, NO los 8 px del `::-webkit-scrollbar`), `cellWidth: 8` y el dato que
//   destapó el bug: cada columna se PINTABA a `8.21875` px.

import {
  computeGrid,
  createPtySizeReconciler,
  shouldSuppressInputEvent,
  shouldIgnoreKeyEvent,
} from '../../static/js/term-geometry.js';

let fallos = 0;
let corridas = 0;

function ok(cond, titulo, detalle) {
  corridas++;
  if (cond) { console.log(`  ✓ ${titulo}`); return true; }
  fallos++;
  console.log(`  ✗ ${titulo}`);
  if (detalle) console.log(`      ${detalle}`);
  return false;
}
const eq = (a, b, titulo) => ok(Object.is(a, b), titulo, `esperado ${b}, obtenido ${a}`);
const seccion = (t) => console.log(`\n${t}`);

/** Ancho que le queda al TEXTO con las mismas reglas que usa `computeGrid` (para chequear el invariante). */
function anchoDisponible(m) {
  const gap = Math.max(0, m.scrollbarWidth || 0, m.minRightGap || 0);
  return m.boxWidth - (m.padLeft || 0) - (m.padRight || 0) - gap;
}

/**
 * EL INVARIANTE DE ANCHO, en una línea: nada de lo que se dibuja puede pasarse del área disponible.
 * Son DOS cosas, no una — y el bug del 2026-09-08 fue creer que eran la misma:
 *   · lo que el navegador PINTA        → cols * paintedCellWidth
 *   · la caja que xterm le da al screen → cols * cellWidth
 * `#term-xterm` va con `overflow: hidden`, así que lo que se pase de ahí no se ve: se RECORTA.
 */
function invarianteDeAncho(m, etiqueta) {
  const g = computeGrid(m);
  if (!g) return ok(false, `${etiqueta}: computeGrid devolvió null`, JSON.stringify(m));
  const avail = anchoDisponible(m);
  const pintado = g.cols * (m.paintedCellWidth || m.cellWidth);
  const caja = g.cols * m.cellWidth;
  const a = ok(pintado <= avail + 1e-9, `${etiqueta}: el texto PINTADO cabe`,
    `cols=${g.cols} × pintado=${m.paintedCellWidth || m.cellWidth} = ${pintado.toFixed(4)} px > disponible=${avail} px (sobra ${(avail - pintado).toFixed(4)})`);
  const b = ok(caja <= avail + 1e-9, `${etiqueta}: la caja cols*cellWidth cabe`,
    `cols=${g.cols} × cellWidth=${m.cellWidth} = ${caja.toFixed(4)} px > disponible=${avail} px`);
  return a && b;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1. EL BUG REPORTADO: "la terminal se come el último par de caracteres de la derecha" (2026-09-08)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Medido en vivo: xterm DECLARA `css.cell.width = 8` px, pero PINTA cada columna a 8.21875 px. La causa está
// en el CSS: `.modal-content` lleva `letter-spacing: -0.015em` (= −0.21 px a 14 px) y eso se hereda hasta el
// contenedor OCULTO con el que xterm mide el glifo; xterm mide la 'W' 0.21 px angosta y "compensa" poniéndole
// `letter-spacing: +0.21875px` INLINE a `.xterm-rows`, que SUSTITUYE al heredado en vez de sumarse.
// El error es POR COLUMNA, así que se acumula: a 90 columnas son 19.7 px ≈ 2.4 celdas fuera del recorte.
//
// Esta sección es la RED: aunque el paso pintado vuelva a divergir (una fuente que carga tarde, otro estilo
// heredado), la rejilla no puede quedar más ancha que la caja.
const BUG_0908 = {
  boxWidth: 738, boxHeight: 500,        // #term-xterm.clientWidth/Height con el modal en 760 px
  padLeft: 8, padRight: 0, padTop: 6, padBottom: 6,
  cellWidth: 8, cellHeight: 17,         // lo que xterm CREE
  paintedCellWidth: 8.21875,            // lo que el navegador PINTA
  scrollbarWidth: 10, minRightGap: 8,
};

seccion('computeGrid · el recorte de la derecha (números medidos en Chrome, 2026-09-08)');
{
  const avail = anchoDisponible(BUG_0908);
  eq(avail, 720, 'ancho disponible para el texto = 738 − 8 pad − 10 carril');
  invarianteDeAncho(BUG_0908, 'métrica pintada ≠ declarada');
  const g = computeGrid(BUG_0908);
  ok(g.cols * BUG_0908.paintedCellWidth <= 720,
    'la rejilla NO se pasa de la caja aunque el paso pintado mienta',
    `cols=${g.cols} pinta ${(g.cols * BUG_0908.paintedCellWidth).toFixed(4)} px`);
  // El déficit reportado por unjordi fue "el último par de caracteres": con la fórmula vieja (dividir entre
  // `cellWidth` ignorando lo pintado) salían 90 columnas y se pintaban 739.6875 px → 19.7 px recortados.
  const colsViejas = Math.floor(720 / BUG_0908.cellWidth);
  eq(colsViejas, 90, 'la fórmula vieja daba 90 columnas');
  ok(90 * BUG_0908.paintedCellWidth - 720 > 2 * BUG_0908.cellWidth,
    'y esas 90 columnas se pasaban por MÁS de dos celdas (el síntoma reportado)',
    `sobrante = ${(90 * BUG_0908.paintedCellWidth - 720).toFixed(4)} px`);
}

seccion('computeGrid · con la métrica ya SANA (el fix de CSS deja pintado == declarado)');
{
  // Con `#term-xterm .xterm { letter-spacing: normal }` la herencia se corta: xterm mide y pinta igual.
  const sano = { ...BUG_0908, paintedCellWidth: 8 };
  const g = computeGrid(sano);
  eq(g.cols, 90, 'no se pierde ninguna columna cuando las métricas coinciden');
  eq(g.rows, 28, 'las filas no las toca el arreglo de ancho');
  invarianteDeAncho(sano, 'métricas coincidentes');
}

seccion('computeGrid · compatibilidad: sin `paintedCellWidth` se comporta como antes');
{
  const sinMedir = { ...BUG_0908 };
  delete sinMedir.paintedCellWidth;
  eq(computeGrid(sinMedir).cols, 90, 'ausente → cae a cellWidth');
  eq(computeGrid({ ...BUG_0908, paintedCellWidth: 0 }).cols, 90, '0 → cae a cellWidth');
  eq(computeGrid({ ...BUG_0908, paintedCellWidth: NaN }).cols, 90, 'NaN → cae a cellWidth');
  eq(computeGrid({ ...BUG_0908, paintedCellWidth: 7.5 }).cols, 90,
    'un paso pintado MENOR que el declarado no ensancha la rejilla (mandaría la caja del screen)');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 2. REGRESIONES YA CERRADAS que no se pueden volver a abrir
// ─────────────────────────────────────────────────────────────────────────────────────────────────
seccion('computeGrid · el margen derecho se reserva UNA vez (regresión de "faltaba una columna")');
{
  // El carril de la scrollbar y el respiro mínimo ocupan el MISMO espacio: se toma el mayor, no la suma.
  const m = { ...BUG_0908, paintedCellWidth: 8 };
  eq(anchoDisponible(m), 720, 'carril(10) y respiro(8) NO se suman: se reserva 10');
  eq(computeGrid(m).cols, 90, 'con el mayor de los dos caben 90 columnas');
  const sumados = 738 - 8 - 0 - (10 + 8);
  ok(Math.floor(sumados / 8) < 90, 'sumarlos costaba columnas (la regresión vieja)',
    `sumados daría ${Math.floor(sumados / 8)} columnas`);
}

seccion('computeGrid · scrollbars OVERLAY (macOS): el carril mide 0 pero el texto no se pega al borde');
{
  const overlay = { ...BUG_0908, paintedCellWidth: 8, scrollbarWidth: 0 };
  eq(anchoDisponible(overlay), 722, 'sin carril, el respiro mínimo (=padLeft) sigue reservado');
  ok(anchoDisponible(overlay) < overlay.boxWidth - overlay.padLeft,
    'NUNCA queda el texto pegado al borde derecho');
  invarianteDeAncho(overlay, 'overlay');
}

seccion('computeGrid · la rejilla no OSCILA al entrar/salir de la alt-screen');
{
  // En alt-screen el CSS pone `overflow-y: hidden`, así que el gutter deja de medir → scrollbarWidth 0.
  const conCarril = { ...BUG_0908, paintedCellWidth: 8, scrollbarWidth: 10 };
  const sinCarril = { ...BUG_0908, paintedCellWidth: 8, scrollbarWidth: 0 };
  eq(computeGrid(conCarril).cols, computeGrid(sinCarril).cols,
    'mismas columnas con y sin carril (vim/top no re-dibujan la rejilla)');
  eq(computeGrid(conCarril).rows, computeGrid(sinCarril).rows, 'mismas filas');
}

seccion('computeGrid · celda FRACCIONARIA (la Nerd Font real, 7.6172 px)');
{
  const nerd = { ...BUG_0908, cellWidth: 7.6172, cellHeight: 17, paintedCellWidth: 7.6172 };
  const g = computeGrid(nerd);
  eq(g.cols, Math.floor(720 / 7.6172), 'floor sobre el ancho disponible');
  invarianteDeAncho(nerd, 'celda fraccionaria');
  // Y con el paso pintado desviado por el redondeo del cache de anchos de xterm (offsetWidth entero):
  const desviada = { ...nerd, paintedCellWidth: 7.625 };
  invarianteDeAncho(desviada, 'celda fraccionaria con paso pintado desviado');
}

seccion('computeGrid · medidas inservibles → null ("no resizees", nunca un default)');
{
  eq(computeGrid(null), null, 'sin medición');
  eq(computeGrid({ ...BUG_0908, cellWidth: 0 }), null, 'celda en 0 (fuente sin medir)');
  eq(computeGrid({ ...BUG_0908, cellHeight: 0 }), null, 'alto de celda en 0');
  eq(computeGrid({ ...BUG_0908, boxWidth: NaN }), null, 'caja sin layout');
  eq(computeGrid({ ...BUG_0908, boxWidth: 10 }), null, 'caja más chica que el margen reservado');
  ok(computeGrid({ ...BUG_0908, boxWidth: 60 }).cols >= 2, 'nunca menos de 2 columnas');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 3. El resto de las decisiones puras que este probe cubre (las cita la cabecera de term-geometry.js)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
seccion('createPtySizeReconciler · el PTY converge al tamaño de la rejilla');
{
  const enviados = [];
  const r = createPtySizeReconciler({ send: (s) => { enviados.push(s); return true; }, schedule: (f) => f() });
  r.born({ cols: 80, rows: 24 });
  eq(enviados.length, 0, 'las dims de la URL cuentan como entregadas: no se manda nada');
  r.reconcile({ cols: 90, rows: 28 });
  eq(enviados.length, 0, 'sin canal abierto no se manda');
  r.opened({ cols: 90, rows: 28 });
  eq(enviados.length, 1, 'al abrir se empuja la rejilla de AHORA');
  r.reconcile({ cols: 90, rows: 28 });
  eq(enviados.length, 1, 'idempotente en estado estable (cero SIGWINCH de más)');
  r.reconcile({ cols: 87, rows: 28 });
  eq(enviados.length, 2, 'un cambio real sí se manda');
  eq(enviados[1].cols, 87, 'y manda el valor nuevo');
}
{
  // La ráfaga de fits al abrir (síncrono + rAF + rAF² + 0 ms + 150 ms) debe salir como UN frame.
  let pendiente = null;
  const enviados = [];
  const r = createPtySizeReconciler({
    send: (s) => { enviados.push(s); return true; },
    schedule: (f) => { pendiente = f; },
  });
  r.born({ cols: 80, rows: 24 });
  r.opened({ cols: 81, rows: 24 });
  r.reconcile({ cols: 88, rows: 28 });
  r.reconcile({ cols: 90, rows: 28 });
  eq(enviados.length, 0, 'la ráfaga aún no manda nada (hay un flush agendado)');
  pendiente();
  eq(enviados.length, 1, 'la ráfaga produce UN solo frame');
  eq(enviados[0].cols, 90, 'y es el ÚLTIMO valor, no uno intermedio');
}
{
  // Un send que falla no se registra: el siguiente fit reintenta solo.
  let vivo = false;
  const enviados = [];
  const r = createPtySizeReconciler({
    send: (s) => { if (!vivo) return false; enviados.push(s); return true; },
    schedule: (f) => f(),
  });
  r.born({ cols: 80, rows: 24 });
  r.opened({ cols: 90, rows: 28 });
  eq(enviados.length, 0, 'send fallido no entrega');
  vivo = true;
  r.reconcile({ cols: 90, rows: 28 });
  eq(enviados.length, 1, 'el siguiente fit reintenta sin ayuda de nadie');
}

seccion('shouldSuppressInputEvent / shouldIgnoreKeyEvent · el acento suelto (`s´í`)');
{
  ok(shouldSuppressInputEvent({ isComposing: true }) === true, 'un input EN composición no llega a xterm');
  ok(shouldSuppressInputEvent({ isComposing: false }) === false, 'tecleo normal intacto');
  ok(shouldSuppressInputEvent({}) === false, 'sin la bandera, intacto');
  ok(shouldSuppressInputEvent(null) === false, 'sin evento, intacto');
  ok(shouldIgnoreKeyEvent({ keyCode: 229 }) === true, 'keydown "en proceso" del IME');
  ok(shouldIgnoreKeyEvent({ key: 'Dead' }) === false, 'la tecla muerta de XKB NO se ignora (rompería acentos)');
}

console.log(`\n${fallos === 0 ? 'VERDE' : 'ROJO'} — ${corridas - fallos}/${corridas} aserciones`);
process.exit(fallos === 0 ? 0 : 1);
