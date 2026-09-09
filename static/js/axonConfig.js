// ============================================
// AXON CONFIG — TODA la configuración de axon, DENTRO de las Settings
// generales de Odysseus (pestaña "Axon" del grupo Models & AI).
//
// Pedido (#32): "mover axon-config al interior de las settings de odysseus Y
// poner ahí TODA la configuración" — antes era un widget suelto con su propio
// launcher en el rail y solo 2 perillas (cerebro y modo); el resto vivía en
// jsons/env vars por fuera. Ya no: el panel se pinta SOLO desde el schema que
// publica el servidor (GET /api/axon/config → schema.groups + schema.knobs),
// así una perilla nueva en axon aparece aquí sin tocar este archivo.
//
// Endpoint mismo-origen (axon es el MAIN CAR en :7001, no se proxea).
//
// LA REGLA que ordena todo el UX de este panel: antes el widget MENTÍA —
// cambiabas algo, "aplicaba" en memoria y se perdía al reiniciar sin avisar.
// Aquí los tres estados son inconfundibles y salen del propio POST:
//   (a) applied         → aplicado AHORA (perillas hot: cerebro, modo)
//   (b) requiresRestart → guardado en disco, aplica al REINICIAR axon
//   (c) persisted:false → NO se guardó (error de escritura) = estado de ERROR
// Nunca un "✓ aplicado" pelón para algo que solo se persistió.
// ============================================

const PANEL_SEL = '[data-settings-panel="axon"]';
const ENDPOINT = '/api/axon/config';

/* ── Estado del módulo ── */
let _snap = null;                        // último snapshot autoritativo (GET o POST)
const _dirty = new Map();                // key -> valor (string) pendiente de guardar
const _pendingRestart = new Set();       // keys guardadas esperando reinicio de axon
let _query = '';                         // filtro de búsqueda vivo
let _busy = false;                       // hay un GET/POST en vuelo
let _loaded = false;                     // ya cargamos al menos una vez

const $panel = () => document.querySelector(PANEL_SEL);
const $ = (id) => document.getElementById(id);

/* ── Utilidades ── */

function fmtSize(bytes) {
  if (typeof bytes !== 'number' || !isFinite(bytes) || bytes <= 0) return '';
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1e6).toFixed(0)} MB`;
}

// Etiqueta legible de un modelo en el <select> del cerebro: nombre + params +
// tamaño + una nota si NO cabe en VRAM (offload) o no cabe ni con offload.
function modelLabel(m) {
  const bits = [];
  if (m.engine === 'freetoken') bits.push('FreeToken · MoE');
  if (m.params) bits.push(`${m.params}B`);
  const size = fmtSize(m.sizeBytes);
  if (size) bits.push(size);
  if (!m.fits && m.runnable) bits.push('offload');
  if (!m.runnable) bits.push('no cabe');
  return bits.length ? `${m.name} (${bits.join(' · ')})` : m.name;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

function fieldId(key) {
  return 'axoncfg-f-' + String(key).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function isTruthy(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function elt(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/* ── Lectura del snapshot ── */

function effectiveOf(key) {
  const eff = _snap && _snap.effective;
  return (eff && Object.prototype.hasOwnProperty.call(eff, key)) ? (eff[key] || {}) : {};
}

// Valor a mostrar en el control: lo pendiente de guardar si lo hay, si no el
// efectivo del servidor. Cadena vacía = nada puesto (manda el default).
function shownValue(knob) {
  if (_dirty.has(knob.key)) return _dirty.get(knob.key);
  const v = effectiveOf(knob.key).value;
  return v == null ? '' : String(v);
}

function isWritable(knob) {
  return knob.scope !== 'despliegue';
}

// Schema del servidor, o un mini-schema equivalente al panel VIEJO cuando el
// axon de enfrente todavía no publica `schema` (degradar honesto, no romper).
function schemaOf(snap) {
  if (snap && snap.schema && Array.isArray(snap.schema.knobs) && snap.schema.knobs.length) {
    return {
      legacy: false,
      groups: (Array.isArray(snap.schema.groups) && snap.schema.groups.length)
        ? snap.schema.groups
        : [{ id: '_', label: 'Configuración' }],
      knobs: snap.schema.knobs,
    };
  }
  return {
    legacy: true,
    groups: [{
      id: 'cerebro',
      label: 'Cerebro y ruteo',
      help: 'Este axon todavía no publica el schema completo: solo se pueden ver estas dos perillas.',
    }],
    knobs: [
      {
        key: 'cerebro', env: null, kind: 'enum', group: 'cerebro',
        label: 'Cerebro (modelo local)', help: 'Modelo local que planea.',
        scope: 'usuario', hot: true, advanced: false, options: [],
      },
      {
        key: 'modo', env: null, kind: 'enum', group: 'cerebro',
        label: 'Modo', help: 'build = todas las tools · plan = solo lectura.',
        scope: 'usuario', hot: true, advanced: false, options: ['build', 'plan'],
      },
    ],
  };
}

// El snapshot legacy no trae `effective`: derívalo de los campos de siempre.
function effectiveFallback(snap) {
  return {
    cerebro: { value: snap.cerebro == null ? null : String(snap.cerebro), source: 'entorno' },
    modo: { value: snap.mode === 'plan' ? 'plan' : 'build', source: 'entorno' },
  };
}

/* ── Estado / mensajes ── */

function setStatus(msg, kind) {
  const el = $('axoncfg-status');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('axoncfg-status-error', kind === 'error');
  el.classList.toggle('axoncfg-status-warn', kind === 'warn');
  el.classList.toggle('axoncfg-status-ok', kind === 'ok');
}

// Absorbe qué quedó esperando reinicio ANTES de re-pintar, para que la perilla
// salga ya con su chip "pendiente de reinicio" en el render de esta respuesta.
function absorbSaveState(data) {
  (Array.isArray(data.applied) ? data.applied : []).forEach(k => _pendingRestart.delete(k));
  (Array.isArray(data.requiresRestart) ? data.requiresRestart : []).forEach(k => _pendingRestart.add(k));
}

// Los TRES estados, sin ambigüedad, leídos de la respuesta del POST.
function reportSave(data) {
  const applied = Array.isArray(data.applied) ? data.applied : [];
  const restart = Array.isArray(data.requiresRestart) ? data.requiresRestart : [];

  if (data.persisted === false) {
    setStatus(
      '✗ NO se guardó en disco' + (data.error ? ` (${data.error})` : '')
      + ' — el cambio se PERDERÁ cuando axon reinicie.',
      'error',
    );
    return;
  }
  const parts = [];
  if (applied.length) parts.push(`✓ aplicado ahora: ${applied.join(', ')}`);
  if (restart.length) parts.push(`💾 guardado — aplica al REINICIAR axon: ${restart.join(', ')}`);
  if (!parts.length) parts.push('✓ guardado');
  setStatus(parts.join('  ·  '), restart.length ? 'warn' : 'ok');
}

/* ── Red ── */

async function load() {
  if (_busy) return;
  _busy = true;
  // En la primera carga el panel viene vacío: siembra la línea de estado para
  // que "cargando…" tenga dónde salir.
  const panel = $panel();
  if (panel && !$('axoncfg-status')) {
    const seed = elt('div', 'axoncfg-status', '');
    seed.id = 'axoncfg-status';
    panel.appendChild(seed);
  }
  setStatus('cargando…');
  try {
    const r = await fetch(ENDPOINT, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || data.error) {
      throw new Error((data && data.error) || ('HTTP ' + r.status));
    }
    _snap = data;
    _dirty.clear();
    _loaded = true;
    renderPanel();
  } catch (e) {
    _snap = null;
    renderUnavailable((e && e.message) || String(e));
  } finally {
    _busy = false;
  }
}

async function post(body) {
  if (_busy) return null;
  _busy = true;
  setStatus('guardando…');
  const panel = $panel();
  if (panel) panel.classList.add('axoncfg-busy');
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) {
      throw new Error((data && data.error) || ('HTTP ' + r.status));
    }
    // La respuesta ES el snapshot autoritativo: re-pintamos desde ella.
    _snap = data;
    Object.keys((body && body.set) || {}).forEach(k => _dirty.delete(k));
    ((body && body.reset) || []).forEach(k => _dirty.delete(k));
    absorbSaveState(data);
    renderPanel();
    reportSave(data);
    return data;
  } catch (e) {
    setStatus('✗ ' + ((e && e.message) || e), 'error');
    return null;
  } finally {
    _busy = false;
    if (panel) panel.classList.remove('axoncfg-busy');
  }
}

/* ── Fábrica de controles: UNA función por `kind` (no ~110 a mano) ── */

function ctlSelect(knob, options, current) {
  const sel = elt('select', 'settings-select axoncfg-input');
  sel.id = fieldId(knob.key);
  if (!current) {
    const none = elt('option', null, '(sin definir — manda el default)');
    none.value = '';
    sel.appendChild(none);
  }
  for (const opt of options) {
    const o = elt('option', null, opt.label);
    o.value = opt.value;
    if (opt.disabled) o.disabled = true;
    if (opt.value === current) o.selected = true;
    sel.appendChild(o);
  }
  return sel;
}

// El cerebro es la única perilla con opciones DINÁMICAS: sale de snap.models,
// con el formato de siempre (params · tamaño · offload · no cabe).
function ctlCerebro(knob, current) {
  const models = Array.isArray(_snap && _snap.models) ? _snap.models : [];
  if (!models.length) {
    const sel = elt('select', 'settings-select axoncfg-input');
    sel.id = fieldId(knob.key);
    const o = elt('option', null, (_snap && _snap.ollamaUp) ? 'sin modelos instalados' : 'ollama no responde');
    o.value = '';
    sel.appendChild(o);
    sel.disabled = true;
    return sel;
  }
  const opts = models.map(m => ({
    value: m.name,
    label: modelLabel(m),
    disabled: !m.runnable, // no cabe ni con offload: no ofrecerlo como elegible
  }));
  const sel = ctlSelect(knob, opts, current);
  if (_snap && _snap.hasLocal === false && !current) {
    const none = elt('option', null, '(frontier-only — ninguno activo)');
    none.value = '';
    none.selected = true;
    sel.insertBefore(none, sel.firstChild);
  }
  return sel;
}

function ctlBoolean(knob, current) {
  const wrap = elt('label', 'axoncfg-check');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.id = fieldId(knob.key);
  box.className = 'axoncfg-input';
  box.checked = isTruthy(current);
  const state = elt('span', null, box.checked ? 'activado' : 'desactivado');
  box.addEventListener('change', () => {
    state.textContent = box.checked ? 'activado' : 'desactivado';
  });
  wrap.appendChild(box);
  wrap.appendChild(state);
  return wrap;
}

function ctlNumber(knob, current) {
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.className = 'settings-select axoncfg-input';
  inp.id = fieldId(knob.key);
  if (knob.kind === 'integer') inp.step = '1';
  inp.value = current == null ? '' : String(current);
  inp.placeholder = knob.def ? `default: ${knob.def}` : 'sin definir';
  return inp;
}

function ctlText(knob, current) {
  const inp = document.createElement('input');
  inp.type = knob.secret ? 'password' : 'text';
  inp.className = 'settings-select axoncfg-input';
  inp.id = fieldId(knob.key);
  inp.autocomplete = 'off';
  if (knob.secret) {
    // Un secreto JAMÁS se re-pinta: el campo va vacío y solo viaja si el
    // usuario escribe uno nuevo.
    inp.value = '';
    inp.placeholder = '•••••••• (escribe uno nuevo para cambiarlo)';
  } else {
    inp.value = current == null ? '' : String(current);
    inp.placeholder = knob.def ? `default: ${knob.def}` : 'sin definir';
  }
  return inp;
}

function ctlJson(knob, current) {
  const ta = document.createElement('textarea');
  ta.className = 'settings-select axoncfg-input axoncfg-textarea';
  ta.id = fieldId(knob.key);
  ta.rows = 3;
  ta.spellcheck = false;
  ta.value = current == null ? '' : String(current);
  ta.placeholder = knob.def ? `default: ${knob.def}` : 'sin definir (JSON)';
  return ta;
}

// Etiquetas más legibles para las enums que ya tenían texto propio.
const _ENUM_LABELS = {
  modo: { build: 'build — todas las tools', plan: 'plan — solo lectura' },
};

/* ── MODOS DE RUTEO (eje ORTOGONAL al modelo) ──
 * Los 4 modos de axon (src/router/routing-mode.ts → ROUTING_MODES / ROUTING_MODE_DOCS).
 * Son un eje SEPARADO del modelo: el modelo es QUÉ piensa, el modo es QUÉ CARRIL
 * (local / frontera) decide cada paso. El endpoint /api/axon/config aún no los emite
 * (ver DIAGNOSTICO-modos-picker.md); cuando lo haga, este selector los pinta solo.
 * Descripciones espejo de ROUTING_MODE_DOCS (what + when) para no duplicar la fuente.
 */
const ROUTING_MODES = ['local-first', 'local-only', 'frontier-first', 'frontier-only'];
const ROUTING_MODE_DOCS = {
  'local-first': {
    label: 'local-first',
    what: 'local decide cada paso y ESCALA a frontera solo cuando el local no puede (NO_JSON, stuck, stagnation, maxturns). Es el DEFAULT.',
    when: 'el día a día: barato por defecto, con la frontera como TOPE de la escalera y no como piso.',
  },
  'local-only': {
    label: 'local-only',
    what: 'local PURO: $0, sin escalado. Los pasos difíciles NO se van a frontera — se resuelven local o no se resuelven.',
    when: 'quieres costo CERO garantizado, o estás midiendo qué aguanta el carril local sin muletas.',
  },
  'frontier-first': {
    label: 'frontier-first',
    what: 'HÍBRIDO POR FASE: la frontera DELIBERA (los primeros turnos: el juicio, el plan) y el local EJECUTA los turnos mecánicos que siguen. Si la frontera se cae, la corrida SIGUE EN LOCAL (incluido el plan).',
    when: 'la tarea necesita buen juicio al arrancar pero su ejecución es mecánica — gastas lo caro donde rinde y abaratas el resto.',
  },
  'frontier-only': {
    label: 'frontier-only',
    what: 'frontera PURA, sin local en ningún paso. Si la frontera NO está disponible (sin credencial, sin saldo, ventana agotada, red caída), la corrida FALLA con estado `lane-down` — NUNCA cae a local.',
    when: 'necesitas la calidad de la frontera de punta a punta y prefieres un fallo explícito antes que un resultado degradado en silencio.',
  },
};

// ¿El snapshot ya publica los modos de ruteo? (campo `routingModes` del endpoint,
// o un knob `ruteo`/`routingMode` en el schema). Hoy NO: por eso este selector
// degrada a solo-lectura hasta que axon lo emita (ver DIAGNOSTICO-modos-picker.md).
function routingModesFromSnap(snap) {
  if (snap && Array.isArray(snap.routingModes) && snap.routingModes.length) {
    return snap.routingModes.map(m => (typeof m === 'string' ? m : m.mode));
  }
  const knobs = (snap && snap.schema && Array.isArray(snap.schema.knobs)) ? snap.schema.knobs : [];
  const rk = knobs.find(k => k.key === 'ruteo' || k.key === 'routingMode');
  if (rk && Array.isArray(rk.options) && rk.options.length) return rk.options.map(String);
  return null;
}

// El selector de MODO de ruteo: un <select> con los 4 modos + su descripción
// (what · when) como <option> y como <datalist>-style ayuda bajo el control.
// Si el endpoint aún no lo emite, se pinta DESHABILITADO con una nota honesta
// (no un "aplicado" mentiroso): el modo real lo sigue mandando el despliegue.
function ctlRuteo(snap) {
  const modes = routingModesFromSnap(snap) || ROUTING_MODES;
  const published = routingModesFromSnap(snap) != null;
  const current = (snap && (snap.routingMode || (snap.effective && (snap.effective.ruteo || snap.effective.routingMode)))) || '';
  const cur = (current && typeof current === 'object') ? current.value : current;

  const sel = elt('select', 'settings-select axoncfg-input');
  sel.id = 'axoncfg-f-ruteo';
  const none = elt('option', null, '(sin definir — manda el default del despliegue)');
  none.value = '';
  sel.appendChild(none);
  for (const m of modes) {
    const doc = ROUTING_MODE_DOCS[m] || { label: m, what: '', when: '' };
    const o = elt('option', null, doc.label + (doc.what ? ' — ' + doc.what : ''));
    o.value = m;
    o.title = doc.when || '';
    if (m === cur) o.selected = true;
    sel.appendChild(o);
  }
  if (!published) {
    sel.disabled = true;
    sel.classList.add('axoncfg-readonly');
  }

  const wrap = elt('div', 'axoncfg-knob-ctl');
  wrap.appendChild(sel);
  if (!published) {
    wrap.appendChild(elt('div', 'axoncfg-knob-help admin-toggle-sub',
      'Este axon todavía no publica los modos de ruteo en /api/axon/config — el selector queda de solo lectura. ' +
      'El modo real lo fija el despliegue (env AXON_ROUTE / flag --local-only, --frontier-first, --frontier-only). ' +
      'Ver DIAGNOSTICO-modos-picker.md.'));
  }
  return wrap;
}

// Perilla sintética de MODO de ruteo para el grupo "Cerebro y ruteo": se pinta
// con ctlRuteo (no con la fábrica genérica) y se marca hot SOLO si el endpoint
// ya la emite escribible; si no, queda de solo lectura (no mentimos con "aplicado").
function routingKnob(snap) {
  const published = routingModesFromSnap(snap) != null;
  return {
    key: 'ruteo',
    kind: 'enum',
    group: 'cerebro',
    label: 'Modo de ruteo (carril local / frontera)',
    help: 'Qué CARRIL decide cada paso — eje ortogonal al modelo. local-first escala a frontera; local-only es $0 puro; frontier-first deliberación en frontera + ejecución local; frontier-only es frontera pura (falla si no hay).',
    scope: 'usuario',
    hot: published,
    advanced: false,
    options: ROUTING_MODES,
  };
}

function buildControl(knob) {
  const current = shownValue(knob);

  if (knob.key === 'cerebro') return ctlCerebro(knob, current);

  switch (knob.kind) {
    case 'boolean':
      return ctlBoolean(knob, current);
    case 'enum': {
      const labels = _ENUM_LABELS[knob.key] || {};
      const opts = (knob.options || []).map(v => ({ value: String(v), label: labels[v] || String(v) }));
      return ctlSelect(knob, opts, current);
    }
    case 'integer':
    case 'number':
      return ctlNumber(knob, current);
    case 'json':
      return ctlJson(knob, current);
    case 'url':
    case 'path':
    case 'string':
    default:
      return ctlText(knob, current);
  }
}

// Lee el valor que hay AHORA en el control de una perilla, como string.
function readControl(knob) {
  const el = $(fieldId(knob.key));
  if (!el) return null;
  if (el.type === 'checkbox') return el.checked ? '1' : '0';
  return el.value;
}

/* ── Render de una perilla ── */

const _SOURCE_HELP = {
  persistido: 'Guardado en el archivo de config de axon (lo escribe esta UI).',
  entorno: 'Viene de una env var / flag del despliegue.',
  default: 'Nadie lo puso: manda el default del código.',
};

function chip(text, cls, title) {
  const c = elt('span', 'axoncfg-chip' + (cls ? ' ' + cls : ''), text);
  if (title) c.title = title;
  return c;
}

function renderKnob(knob) {
  const row = elt('div', 'axoncfg-knob');
  row.dataset.key = knob.key;
  row.dataset.advanced = knob.advanced ? '1' : '0';
  row.dataset.haystack = [knob.label, knob.key, knob.env || '', knob.help || '', knob.group || '']
    .join(' ').toLowerCase();

  const eff = effectiveOf(knob.key);
  const writable = isWritable(knob);
  const src = eff.source || 'default';

  /* cabecera: etiqueta + chips de procedencia/ámbito */
  const head = elt('div', 'axoncfg-knob-head');
  const lbl = elt('label', 'axoncfg-knob-label', knob.label || knob.key);
  lbl.htmlFor = fieldId(knob.key);
  head.appendChild(lbl);
  head.appendChild(chip(src, 'axoncfg-src-' + src, _SOURCE_HELP[src] || ''));
  if (knob.env) {
    const code = elt('code', 'axoncfg-env', knob.env);
    code.title = 'Variable de entorno equivalente';
    head.appendChild(code);
  }
  if (!writable) head.appendChild(chip('despliegue', 'axoncfg-chip-ro', 'Solo lectura: se cambia en el .env del stack.'));
  if (knob.hot) head.appendChild(chip('en caliente', 'axoncfg-chip-hot', 'Se aplica al instante, sin reiniciar axon.'));
  else if (writable) head.appendChild(chip('requiere reinicio', 'axoncfg-chip-restart', 'Se guarda, pero axon lo lee al arrancar.'));
  if (knob.secret) head.appendChild(chip(eff.set ? 'puesta' : 'no puesta', 'axoncfg-chip-secret', 'Es un secreto: su valor nunca se muestra.'));
  if (_pendingRestart.has(knob.key)) head.appendChild(chip('pendiente de reinicio', 'axoncfg-chip-pending'));
  row.appendChild(head);

  /* control */
  const ctlWrap = elt('div', 'axoncfg-knob-ctl');
  const ctl = buildControl(knob);
  if (!writable) {
    // Nunca un control escribible para una perilla de despliegue: el servidor
    // la rechaza igual, y ofrecerla sería volver a mentir.
    ctl.classList.add('axoncfg-readonly');
    if ('disabled' in ctl) ctl.disabled = true;
    ctl.querySelectorAll('input, select, textarea').forEach(i => { i.disabled = true; });
  }
  ctlWrap.appendChild(ctl);

  if (writable) {
    if (knob.hot) {
      // hot (cerebro, modo): aplica al vuelo, como siempre.
      ctl.addEventListener('change', () => {
        const v = readControl(knob);
        if (v == null) return;
        post({ set: { [knob.key]: v } });
      });
    } else {
      const base = eff.value == null ? '' : String(eff.value);
      const onEdit = () => {
        const v = readControl(knob);
        if (v == null) return;
        if (knob.secret ? v === '' : v === base) _dirty.delete(knob.key);
        else _dirty.set(knob.key, v);
        row.classList.toggle('axoncfg-knob-dirty', _dirty.has(knob.key));
        syncSaveBar();
      };
      ctl.addEventListener('change', onEdit);
      ctl.addEventListener('input', onEdit);
      if (_dirty.has(knob.key)) row.classList.add('axoncfg-knob-dirty');
    }

    // "Restaurar": borra la llave del archivo persistido y devuelve el control
    // al entorno/flag del despliegue. Solo si HAY algo persistido que soltar.
    if (src === 'persistido') {
      const btn = elt('button', 'axoncfg-btn axoncfg-btn-ghost', 'Restaurar');
      btn.type = 'button';
      btn.title = 'Borra esta llave del archivo persistido y devuelve el control al entorno/flag del despliegue.';
      btn.addEventListener('click', () => post({ reset: [knob.key] }));
      ctlWrap.appendChild(btn);
    }
  }
  row.appendChild(ctlWrap);

  /* ayuda */
  const bits = [];
  if (knob.help) bits.push(knob.help);
  if (knob.def) bits.push(`Default: ${knob.def}`);
  if (knob.readAt === 'load') bits.push('se lee al arrancar axon');
  else if (knob.readAt === 'call') bits.push('se lee en cada llamada');
  if (!writable && knob.env) bits.push(`se cambia en el .env del stack (${knob.env})`);
  if (bits.length) row.appendChild(elt('div', 'axoncfg-knob-help admin-toggle-sub', bits.join(' · ')));
  if (knob.site) {
    const s = elt('div', 'axoncfg-knob-site', knob.site);
    s.title = 'Dónde vive en el código de axon';
    row.appendChild(s);
  }

  return row;
}

/* ── Render del panel ── */

function renderUnavailable(reason) {
  const panel = $panel();
  if (!panel) return;
  panel.textContent = '';
  const card = elt('div', 'admin-card axoncfg-unavailable');
  card.appendChild(elt('h2', null, 'Axon'));
  card.appendChild(elt('div', 'admin-toggle-sub',
    'No se pudo leer la configuración de axon. Esta pestaña configura el axon que corre como '
    + 'main car en este mismo origen; si axon no está corriendo, o corre sin la API de config, '
    + 'aquí no hay nada que ajustar.'));
  card.appendChild(elt('div', 'axoncfg-status axoncfg-status-error', 'Motivo: ' + reason));
  const retry = elt('button', 'axoncfg-btn', 'Reintentar');
  retry.type = 'button';
  retry.addEventListener('click', () => load());
  card.appendChild(retry);
  panel.appendChild(card);
}

function renderPersistBanner() {
  const p = (_snap && _snap.persist) || {};
  const card = elt('div', 'admin-card axoncfg-persist');
  card.appendChild(elt('h2', null, 'Dónde se guarda esta configuración'));

  if (p.error) {
    card.appendChild(elt('div', 'axoncfg-status axoncfg-status-error',
      '✗ axon NO puede escribir su archivo de config: ' + p.error
      + ' — lo que cambies aquí se perderá al reiniciar.'));
  }

  const line = elt('div', 'axoncfg-persist-line');
  if (p.path) line.appendChild(elt('code', 'axoncfg-env', p.path));
  else line.appendChild(elt('span', null, 'axon no reportó una ruta de persistencia.'));
  const meta = [p.exists ? 'el archivo existe' : 'todavía no existe (se crea al primer cambio)'];
  if (p.updatedAt) meta.push('última escritura: ' + fmtDate(p.updatedAt));
  line.appendChild(elt('span', 'admin-toggle-sub', meta.join(' · ')));
  card.appendChild(line);

  card.appendChild(elt('div', 'admin-toggle-sub',
    'Las perillas de ámbito "usuario" se guardan aquí y sobreviven al reinicio. '
    + 'Las de "despliegue" son de solo lectura: se cambian en el .env del stack.'));

  if (_snap && _snap.ollamaUp != null) {
    const models = Array.isArray(_snap.models) ? _snap.models : [];
    const ollama = models.filter(m => m.engine !== 'freetoken').length;
    const ft = models.filter(m => m.engine === 'freetoken').length;
    const parts = [_snap.ollamaUp ? `ollama activo · ${ollama} modelo(s)` : 'ollama no responde'];
    if (ft > 0) parts.push(`FreeToken activo · ${ft} modelo(s)`);
    card.appendChild(elt('div', 'axoncfg-ollama', parts.join(' · ')));
  }
  return card;
}

function renderToolbar() {
  const bar = elt('div', 'axoncfg-toolbar');

  const search = document.createElement('input');
  search.type = 'search';
  search.id = 'axoncfg-search';
  search.className = 'settings-select axoncfg-search';
  search.placeholder = 'Buscar perilla, env var o texto de ayuda…';
  search.autocomplete = 'off';
  search.value = _query;
  search.addEventListener('input', () => {
    _query = search.value.trim().toLowerCase();
    applyFilter();
  });
  bar.appendChild(search);

  const actions = elt('div', 'axoncfg-actions');
  actions.appendChild(elt('span', 'axoncfg-dirty-count', ''));

  const save = elt('button', 'axoncfg-btn axoncfg-btn-primary', 'Guardar cambios');
  save.type = 'button';
  save.id = 'axoncfg-save';
  save.addEventListener('click', saveDirty);
  actions.appendChild(save);

  const discard = elt('button', 'axoncfg-btn', 'Descartar');
  discard.type = 'button';
  discard.id = 'axoncfg-discard';
  discard.addEventListener('click', () => {
    _dirty.clear();
    renderPanel();
    setStatus('');
  });
  actions.appendChild(discard);

  const reload = elt('button', 'axoncfg-btn axoncfg-btn-ghost', 'Recargar');
  reload.type = 'button';
  reload.addEventListener('click', () => load());
  actions.appendChild(reload);

  bar.appendChild(actions);
  return bar;
}

function syncSaveBar() {
  const n = _dirty.size;
  const count = document.querySelector('.axoncfg-dirty-count');
  if (count) count.textContent = n ? `${n} sin guardar` : '';
  const save = $('axoncfg-save');
  if (save) save.disabled = n === 0;
  const discard = $('axoncfg-discard');
  if (discard) discard.disabled = n === 0;
}

async function saveDirty() {
  if (!_dirty.size) return;
  const set = {};
  for (const [k, v] of _dirty) set[k] = v;
  await post({ set });
}

function renderPanel() {
  const panel = $panel();
  if (!panel) return;
  if (!_snap) { renderUnavailable('sin datos de axon'); return; }

  const schema = schemaOf(_snap);
  if (!_snap.effective) _snap.effective = effectiveFallback(_snap);

  panel.textContent = '';
  panel.appendChild(renderPersistBanner());
  panel.appendChild(renderToolbar());
  const status = elt('div', 'axoncfg-status', '');
  status.id = 'axoncfg-status';
  panel.appendChild(status);

  const byGroup = new Map();
  for (const k of schema.knobs) {
    const g = k.group || '_';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(k);
  }

  // Orden de despliegue = el orden en que vienen los grupos. Un grupo que solo
  // aparezca en las perillas no se pierde: se agrega al final.
  const groups = schema.groups.slice();
  for (const g of byGroup.keys()) {
    if (!groups.some(x => x.id === g)) groups.push({ id: g, label: g });
  }

  for (const g of groups) {
    const knobs = byGroup.get(g.id) || [];
    if (!knobs.length && g.id !== 'cerebro') continue;

    const sec = elt('section', 'admin-card axoncfg-group');
    sec.dataset.group = g.id;
    sec.appendChild(elt('h2', null, g.label || g.id));
    if (g.help) sec.appendChild(elt('div', 'admin-toggle-sub', g.help));

    // El MODO de RUTEO es un eje ortogonal al modelo: se pinta SIEMPRE junto al
    // grupo "Cerebro y ruteo" (o al primer grupo si no existe), con su selector
    // propio. Si el endpoint aún no lo emite, ctlRuteo lo deja de solo lectura.
    if (g.id === 'cerebro' || (g.id === groups[0].id && !groups.some(x => x.id === 'cerebro'))) {
      const rk = routingKnob(_snap);
      const rrow = elt('div', 'axoncfg-knob');
      rrow.dataset.key = 'ruteo';
      rrow.dataset.advanced = '0';
      rrow.dataset.haystack = ['modo de ruteo', 'ruteo', 'routing', 'local-first', 'local-only', 'frontier-first', 'frontier-only', rk.help || ''].join(' ').toLowerCase();
      const rhead = elt('div', 'axoncfg-knob-head');
      const rlbl = elt('label', 'axoncfg-knob-label', rk.label);
      rlbl.htmlFor = 'axoncfg-f-ruteo';
      rhead.appendChild(rlbl);
      rhead.appendChild(chip(routingModesFromSnap(_snap) != null ? 'en caliente' : 'despliegue',
        routingModesFromSnap(_snap) != null ? 'axoncfg-chip-hot' : 'axoncfg-chip-ro',
        routingModesFromSnap(_snap) != null
          ? 'Se aplica al instante, sin reiniciar axon.'
          : 'Solo lectura: axon aún no lo emite escribible (ver DIAGNOSTICO-modos-picker.md).'));
      rrow.appendChild(rhead);
      rrow.appendChild(ctlRuteo(_snap));
      sec.appendChild(rrow);
    }

    const basic = knobs.filter(k => !k.advanced);
    const advanced = knobs.filter(k => k.advanced);

    if (basic.length) {
      const box = elt('div', 'axoncfg-knobs');
      basic.forEach(k => box.appendChild(renderKnob(k)));
      sec.appendChild(box);
    }
    if (advanced.length) {
      const det = document.createElement('details');
      det.className = 'axoncfg-advanced';
      const sum = document.createElement('summary');
      sum.textContent = `Avanzadas (${advanced.length})`;
      det.appendChild(sum);
      const box = elt('div', 'axoncfg-knobs');
      advanced.forEach(k => box.appendChild(renderKnob(k)));
      det.appendChild(box);
      sec.appendChild(det);
    }
    panel.appendChild(sec);
  }

  syncSaveBar();
  applyFilter();

  if (schema.legacy) {
    setStatus('Este axon todavía no publica el schema completo — solo se muestran las perillas clásicas.', 'warn');
  }
}

/* ── Búsqueda viva: filtra a través de TODOS los grupos ── */

function applyFilter() {
  const panel = $panel();
  if (!panel) return;
  const terms = _query ? _query.split(/\s+/).filter(Boolean) : [];

  panel.querySelectorAll('.axoncfg-group').forEach(sec => {
    let visible = 0;
    sec.querySelectorAll('.axoncfg-knob').forEach(row => {
      const hay = row.dataset.haystack || '';
      const match = !terms.length || terms.every(t => hay.includes(t));
      row.classList.toggle('axoncfg-hidden', !match);
      if (match) visible++;
    });
    // Con búsqueda activa, las avanzadas que hacen match se REVELAN.
    sec.querySelectorAll('details.axoncfg-advanced').forEach(det => {
      const hits = det.querySelectorAll('.axoncfg-knob:not(.axoncfg-hidden)').length;
      det.classList.toggle('axoncfg-hidden', terms.length > 0 && hits === 0);
      if (terms.length) det.open = hits > 0;
    });
    sec.classList.toggle('axoncfg-hidden', visible === 0);
  });
}

/* ── API pública ── */

// La llama settings.js al activar la pestaña "axon" (carga perezosa: no le
// pegamos al endpoint de axon hasta que alguien abre de verdad el panel).
function onPanelActivated() {
  if (!$panel()) return;
  if (!_loaded) load();
  else renderPanel();
}

// "Abrir el axon config" ya no es un modal propio: es abrir Settings en su
// pestaña. Se deja expuesto para no romper a nadie que lo llame.
function open() {
  const mod = window.settingsModule;
  if (mod && typeof mod.open === 'function') {
    mod.open('axon');
    return;
  }
  // Fallback sin el módulo: abre el modal por el DOM y activa la pestaña.
  const modal = $('settings-modal');
  if (modal) modal.classList.remove('hidden');
  const tab = document.querySelector('#settings-modal [data-settings-tab="axon"]');
  if (tab) tab.click();
  else onPanelActivated();
}

function close() {
  const mod = window.settingsModule;
  if (mod && typeof mod.close === 'function') mod.close();
}

function toggle() { open(); }

function init() {
  // Ya no se cablea ningún renglón del rail: ese ítem se retiró (#32). La config de axon se llega
  // por Settings › Axon y nada más — un atajo en el rail a algo que ya tiene su casa en Settings
  // deja dos entradas para una sola config, que es el ítem suelto que #32 venía a eliminar.
  // `window.axonConfig.open()` se conserva: es la vía para abrirla por código (p. ej. un enlace
  // profundo o un botón futuro), y es lo que usa el propio panel de Settings al activarse.
  window.axonConfig = { open, close, toggle, refresh: load, onPanelActivated };
}

if (document.readyState !== 'loading') init();
else document.addEventListener('DOMContentLoaded', init);

export default { open, close, toggle, refresh: load, onPanelActivated };
