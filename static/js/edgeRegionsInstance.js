/**
 * Instancia ÚNICA del registro de regiones reservadas por borde del shell (#29c).
 *
 * `edgeRegions.js` es el núcleo PURO (sin DOM): aquí se inyecta el sink de IO real
 * —escribir la variable CSS `--reserved-<edge>` en <body>— y se exporta el singleton
 * que todos los widgets del shell comparten. N widgets acoplados al MISMO borde se
 * APILAN (el total por borde = suma), así el chat y el tiling leen un solo número por
 * borde en vez de que cada widget publique su propia variable.
 *
 * Lectores del resultado:
 *  - `style.css` (`.chat-input-bar`) consume `var(--reserved-bottom, …)`.
 *  - `tileShortcuts.js:_areaUtil()` resta `--reserved-<edge>` del área tileable (H1).
 */
import { createEdgeRegions } from './edgeRegions.js';

export const edgeRegions = createEdgeRegions({
  setVar: (name, val) => document.body.style.setProperty(name, val),
});

export default edgeRegions;
