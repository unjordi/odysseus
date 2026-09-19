// Kavita Library / Reader — #31 Slices 2b + 3 + 2c
//
// Front-end visor de EPUB que delega el rendering a Kavita (paridad visual),
// lo lee en voz alta (Slice 3) y escribe el progreso de vuelta (Slice 2c).
// El backend (routes/kavita_routes.py) expone:
//   GET  /api/kavita/libraries
//   GET  /api/kavita/series?libraryId=
//   GET  /api/kavita/series/{seriesId}/volumes
//   GET  /api/kavita/progress?chapterId=      (lee progreso DELEGADO)
//   POST /api/kavita/progress                 (escribe progreso DELEGADO — Slice 2c)
//   GET  /api/kavita/book/{chapterId}/info
//   GET  /api/kavita/book/{chapterId}/toc
//   GET  /api/kavita/book/{chapterId}/page?page=N
//   GET  /api/kavita/book/{chapterId}/resource?file=<path>
//
// Patrón del shell: modal #kavita-modal (mismo estilo que #memory-modal),
// botón en la sidebar (#tool-kavita-btn), fetch con credentials same-origin.
//
// Progreso: Kavita es la FUENTE DE VERDAD. El visor lo LEE al abrir (para
// reanudar) y lo ESCRIBE al cambiar de página / avanzar por TTS (best-effort).

const API = '/api/kavita';

// ── helpers ────────────────────────────────────────────────────────────────

async function _fetchJSON(url, opts = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...opts });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = await res.json();
      if (body && body.detail) {
        detail = typeof body.detail === 'string' ? body.detail : (body.detail.message || JSON.stringify(body.detail));
      }
    } catch (_) { /* ignore */ }
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function _fetchText(url, opts = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...opts });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = await res.json();
      if (body && body.detail) {
        detail = typeof body.detail === 'string' ? body.detail : (body.detail.message || JSON.stringify(body.detail));
      }
    } catch (_) { /* ignore */ }
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

function _el(id) { return document.getElementById(id); }

function _escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── state ──────────────────────────────────────────────────────────────────

const state = {
  view: 'libraries',       // 'libraries' | 'series' | 'chapters' | 'reader'
  libraryId: null,
  seriesId: null,
  chapterId: null,
  authorId: null,           // si venimos de la vista "por autor" (para el back)
  authorName: null,
  series: [],               // series de la biblioteca actual (para re-render list/grid)
  volumeId: null,          // para escribir progreso de vuelta a Kavita (Slice 2c)
  page: 0,
  totalPages: null,
  toc: [],
  loading: false,
  loadGen: 0,   // token de generación de cargas de página (anti "Cargando" trabado)
};

// ── DOM refs ───────────────────────────────────────────────────────────────

let modal, closeBtn, backBtn, titleEl, breadcrumbEl;
let browserPane, errorEl, loadingEl, listEl, filterEl;
let readerPane, prevBtn, nextBtn, pageIndicator, tocToggle, tocEl, pageEl;
let ttsVoiceEl, ttsSpeedEl;
let viewToggleEl, viewListBtn, viewGridBtn;

// Vista del navegador de series: 'list' | 'grid'. Persistida por usuario (local).
const BROWSE_VIEW_KEY = 'odysseus.kavita.browseView';
function _getBrowseView() {
  try { const v = localStorage.getItem(BROWSE_VIEW_KEY); if (v === 'grid' || v === 'list') return v; } catch (_) {}
  return 'list';
}
function _setBrowseViewPref(v) { try { localStorage.setItem(BROWSE_VIEW_KEY, v); } catch (_) {} }

// Eje del nivel superior: 'library' (bibliotecas) | 'author' (autores). Persistido.
const BROWSE_MODE_KEY = 'odysseus.kavita.browseMode';
function _getBrowseMode() {
  try { const v = localStorage.getItem(BROWSE_MODE_KEY); if (v === 'author' || v === 'library') return v; } catch (_) {}
  return 'library';
}
function _setBrowseModePref(v) { try { localStorage.setItem(BROWSE_MODE_KEY, v); } catch (_) {} }

function _initDom() {
  modal = _el('kavita-modal');
  closeBtn = _el('close-kavita-modal');
  backBtn = _el('kavita-back');
  titleEl = _el('kavita-title');
  breadcrumbEl = _el('kavita-breadcrumb');
  browserPane = _el('kavita-browser');
  errorEl = _el('kavita-error');
  loadingEl = _el('kavita-loading');
  listEl = _el('kavita-list');
  filterEl = _el('kavita-filter');
  readerPane = _el('kavita-reader');
  prevBtn = _el('kavita-prev');
  nextBtn = _el('kavita-next');
  pageIndicator = _el('kavita-page-indicator');
  tocToggle = _el('kavita-toc-toggle');
  tocEl = _el('kavita-toc');
  pageEl = _el('kavita-page');
  ttsVoiceEl = _el('kavita-tts-voice');
  ttsSpeedEl = _el('kavita-tts-speed');
  viewToggleEl = _el('kavita-view-toggle');
  viewListBtn = _el('kavita-view-list');
  viewGridBtn = _el('kavita-view-grid');
}

// ── UI helpers ─────────────────────────────────────────────────────────────

function _showError(msg) {
  if (!errorEl) return;
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}

function _clearError() {
  if (!errorEl) return;
  errorEl.textContent = '';
  errorEl.classList.add('hidden');
}

function _setLoading(on) {
  if (!loadingEl) return;
  loadingEl.style.display = on ? '' : 'none';
  state.loading = on;
}

function _setBreadcrumb(parts) {
  if (!breadcrumbEl) return;
  breadcrumbEl.textContent = parts.filter(Boolean).join('  ›  ');
}

function _setTitle(t) {
  if (titleEl) titleEl.textContent = t;
}

// El panel del lector tiene `display:flex` INLINE, y `.hidden {display:none}`
// (sin !important, style.css:3924) NO puede sobrescribir un inline → hay que
// prender/apagar el display por JS. Si no, el panel del libro queda SIEMPRE
// visible (vacío al no haber libro) y sus botones ◀▶ disparan /book/null.
function _showBrowser() {
  if (browserPane) { browserPane.classList.remove('hidden'); browserPane.style.display = ''; }
  if (readerPane) { readerPane.classList.add('hidden'); readerPane.style.display = 'none'; }
  if (backBtn) backBtn.style.display = state.view === 'libraries' ? 'none' : '';
}

function _showReader() {
  if (browserPane) { browserPane.classList.add('hidden'); browserPane.style.display = 'none'; }
  if (readerPane) { readerPane.classList.remove('hidden'); readerPane.style.display = 'flex'; }
  if (backBtn) backBtn.style.display = '';
  // Reflejar la voz/velocidad reales en los knobs de la barra (never-throws).
  _syncTtsControls().catch(() => {});
}

// ── filtro/búsqueda del navegador (client-side sobre la lista actual) ────────
function _resetFilter() {
  if (filterEl) filterEl.value = '';
}

function _applyFilter() {
  if (!filterEl || !listEl) return;
  const q = filterEl.value.trim().toLowerCase();
  listEl.querySelectorAll('.kavita-row').forEach((row) => {
    const txt = (row.textContent || '').toLowerCase();
    row.style.display = (!q || txt.includes(q)) ? '' : 'none';
  });
}

// ── navigation: libraries ──────────────────────────────────────────────────

// Entrada del nivel superior: bifurca por el eje elegido (bibliotecas / autores).
function _loadTop() {
  if (_getBrowseMode() === 'author') _loadAuthors();
  else _loadLibraries();
}

// Barra "📚 Bibliotecas / ✍️ Autores" — se prepende al listado del nivel superior.
// Cambiar de eje recarga el nivel superior en el nuevo modo.
function _renderTopModeBar() {
  const mode = _getBrowseMode();
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:6px;margin-bottom:8px;';
  const mk = (m, label) => {
    const b = document.createElement('button');
    b.className = 'memory-toolbar-btn';
    b.textContent = label;
    b.style.cssText = 'flex:1;padding:6px 8px;' + (mode === m ? 'background:rgba(255,214,10,0.22);' : '');
    b.addEventListener('click', () => {
      if (_getBrowseMode() === m) return;
      _setBrowseModePref(m);
      _loadTop();
    });
    return b;
  };
  bar.appendChild(mk('library', '📚 Bibliotecas'));
  bar.appendChild(mk('author', '✍️ Autores'));
  listEl.appendChild(bar);
}

// Vista "por autor": lista de personas (writers). Clic → sus libros (field 17).
async function _loadAuthors() {
  _clearError();
  _setLoading(true);
  _setBreadcrumb([]);
  _setTitle('Autores');
  _resetFilter();
  _resetListLayout();
  state.authorId = null;
  state.view = 'libraries';   // nivel superior (reusa el slot del back)
  listEl.innerHTML = '';
  _renderTopModeBar();
  try {
    const data = await _fetchJSON(`${API}/people`);
    const people = ((data && data.people) || [])
      .filter((p) => p && (p.name || '').trim())
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (!people.length) {
      listEl.insertAdjacentHTML('beforeend', '<div style="opacity:0.6;padding:12px;">No hay autores en Kavita.</div>');
      return;
    }
    people.forEach((p) => {
      const id = p.id ?? p.personId;
      const name = p.name || `Autor ${id}`;
      const row = document.createElement('div');
      row.className = 'kavita-row';
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:8px;cursor:pointer;border:1px solid rgba(128,128,128,0.15);background:rgba(128,128,128,0.04);';
      row.innerHTML = `<span style="font-size:1.05em;">✍️</span><span class="grow" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_escapeHtml(name)}</span>`;
      row.addEventListener('click', () => _openAuthor(id, name));
      listEl.appendChild(row);
    });
  } catch (e) {
    _showError(_friendlyError(e));
  } finally {
    _setLoading(false);
  }
}

// Los libros de un autor (writer). Reusa _renderSeries (list/grid + portadas).
async function _openAuthor(personId, personName) {
  state.view = 'series';
  state.libraryId = null;
  state.authorId = personId;
  state.authorName = personName;
  state.seriesId = null;
  _showBrowser();
  _clearError();
  _setLoading(true);
  _setBreadcrumb([personName]);
  _setTitle(personName);
  _resetFilter();
  listEl.innerHTML = '';
  try {
    const data = await _fetchJSON(`${API}/people/${encodeURIComponent(personId)}/series`);
    const series = (data && data.series) || [];
    if (!series.length) {
      listEl.innerHTML = '<div style="opacity:0.6;padding:12px;">Este autor no tiene libros como escritor.</div>';
      return;
    }
    state.series = series;
    if (viewToggleEl) { viewToggleEl.classList.remove('hidden'); viewToggleEl.style.display = 'flex'; }
    _renderSeries();
  } catch (e) {
    _showError(_friendlyError(e));
  } finally {
    _setLoading(false);
  }
}

async function _loadLibraries() {
  _clearError();
  _setLoading(true);
  _setBreadcrumb([]);
  _setTitle('Biblioteca');
  _resetFilter();
  _resetListLayout();
  state.authorId = null;
  listEl.innerHTML = '';
  _renderTopModeBar();
  try {
    const data = await _fetchJSON(`${API}/libraries`);
    const libs = (data && data.libraries) || [];
    if (!libs.length) {
      listEl.insertAdjacentHTML('beforeend', '<div style="opacity:0.6;padding:12px;">No hay bibliotecas en Kavita.</div>');
      return;
    }
    libs.forEach((lib) => {
      const id = lib.id ?? lib.libraryId ?? lib.library_id;
      const name = lib.name || lib.title || `Biblioteca ${id}`;
      const count = lib.seriesCount ?? lib.series_count ?? lib.count ?? null;
      const row = document.createElement('div');
      row.className = 'kavita-row';
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:8px;cursor:pointer;border:1px solid rgba(128,128,128,0.15);background:rgba(128,128,128,0.04);';
      row.innerHTML = `<span style="font-size:1.1em;">📚</span><span class="grow" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_escapeHtml(name)}</span>${count != null ? `<span style="opacity:0.5;font-size:0.8em;">${count} series</span>` : ''}`;
      row.addEventListener('click', () => _openLibrary(id, name));
      listEl.appendChild(row);
    });
  } catch (e) {
    _showError(_friendlyError(e));
  } finally {
    _setLoading(false);
  }
}

// ── navigation: series ─────────────────────────────────────────────────────

async function _openLibrary(libraryId, libraryName) {
  state.view = 'series';
  state.libraryId = libraryId;
  state.seriesId = null;
  _showBrowser();
  _clearError();
  _setLoading(true);
  _setBreadcrumb([libraryName]);
  _setTitle(libraryName);
  _resetFilter();
  listEl.innerHTML = '';
  try {
    const data = await _fetchJSON(`${API}/series?libraryId=${encodeURIComponent(libraryId)}`);
    const series = (data && data.series) || [];
    if (!series.length) {
      listEl.innerHTML = '<div style="opacity:0.6;padding:12px;">No hay series en esta biblioteca.</div>';
      return;
    }
    // La lista de series es la única vista con cuadrícula (portadas). El toggle
    // se muestra aquí y se recuerda la preferencia; libraries/chapters son lista.
    state.series = series;
    if (viewToggleEl) { viewToggleEl.classList.remove('hidden'); viewToggleEl.style.display = 'flex'; }
    _renderSeries();
  } catch (e) {
    _showError(_friendlyError(e));
  } finally {
    _setLoading(false);
  }
}

// Renderiza state.series como LISTA o CUADRÍCULA según la preferencia. La
// cuadrícula usa portadas (proxy /api/kavita/series/{id}/cover) con loading=lazy
// para no pedir 3558 imágenes de golpe. Ambas filas llevan .kavita-row para que
// el filtro (que busca por textContent) siga funcionando en las dos vistas.
function _renderSeries() {
  if (!listEl) return;
  const series = state.series || [];
  const grid = _getBrowseView() === 'grid';
  _applyViewButtons(grid);
  listEl.innerHTML = '';
  if (grid) {
    listEl.style.display = 'grid';
    listEl.style.gridTemplateColumns = 'repeat(auto-fill, minmax(120px, 1fr))';
    listEl.style.gap = '12px';
  } else {
    listEl.style.display = 'flex';
    listEl.style.flexDirection = 'column';
    listEl.style.gap = '6px';
  }
  series.forEach((s) => {
    const id = s.id ?? s.seriesId ?? s.series_id;
    const name = s.name || s.title || `Serie ${id}`;
    const el = document.createElement('div');
    el.className = 'kavita-row';
    if (grid) {
      el.style.cssText = 'display:flex;flex-direction:column;gap:6px;cursor:pointer;border-radius:8px;overflow:hidden;border:1px solid rgba(128,128,128,0.15);background:rgba(128,128,128,0.04);padding:6px;';
      el.innerHTML =
        `<div style="aspect-ratio:2/3;width:100%;background:rgba(128,128,128,0.12);border-radius:5px;overflow:hidden;display:flex;align-items:center;justify-content:center;">`
        + `<img loading="lazy" src="${API}/series/${encodeURIComponent(id)}/cover" alt="" `
        + `style="width:100%;height:100%;object-fit:cover;" `
        + `onerror="this.style.display='none';this.parentNode.textContent='📖';this.parentNode.style.fontSize='2em';"></div>`
        + `<span style="font-size:0.8em;line-height:1.25;max-height:3.1em;overflow:hidden;">${_escapeHtml(name)}</span>`;
    } else {
      el.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:8px;cursor:pointer;border:1px solid rgba(128,128,128,0.15);background:rgba(128,128,128,0.04);';
      el.innerHTML = `<span style="font-size:1.05em;">📖</span><span class="grow" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_escapeHtml(name)}</span>`;
    }
    el.addEventListener('click', () => _openSeries(id, name));
    listEl.appendChild(el);
  });
  _applyFilter();
}

function _applyViewButtons(grid) {
  const active = 'rgba(255,214,10,0.22)';
  if (viewListBtn) viewListBtn.style.background = grid ? '' : active;
  if (viewGridBtn) viewGridBtn.style.background = grid ? active : '';
}

function _setBrowseView(v) {
  _setBrowseViewPref(v);
  if (state.view === 'series') _renderSeries();
}

// Deja #kavita-list en modo lista (libraries/chapters no tienen cuadrícula) y
// oculta el toggle. Se llama al entrar a esas vistas.
function _resetListLayout() {
  if (listEl) {
    listEl.style.display = 'flex';
    listEl.style.flexDirection = 'column';
    listEl.style.gap = '6px';
  }
  if (viewToggleEl) { viewToggleEl.classList.add('hidden'); viewToggleEl.style.display = 'none'; }
}

// Etiqueta legible de un volumen. Kavita usa un `name` SENTINELA (número puro,
// p.ej. "-100000") para el volumen suelto de un libro de un solo tomo →
// mostrarlo como título era una "cosa rara" (el lector decía "-100000"). Orden:
// nombre real del volumen (no numérico) → título del capítulo → nombre de la
// serie (que ES el título del libro) → fallback.
function _volumeLabel(v, seriesName) {
  const ch0 = (v.chapters && v.chapters[0]) || {};
  const cands = [v.name, v.title, v.chapterName, ch0.title, ch0.titleName];
  for (const c of cands) {
    const s = (c == null ? '' : String(c)).trim();
    if (s && !/^-?\d+(\.\d+)?$/.test(s)) return s;   // descarta sentinelas numéricos
  }
  return seriesName || 'Capítulo';
}

// ── navigation: chapters ───────────────────────────────────────────────────

async function _openSeries(seriesId, seriesName) {
  state.view = 'chapters';
  state.seriesId = seriesId;
  state.chapterId = null;
  _showBrowser();
  _clearError();
  _setLoading(true);
  _setBreadcrumb([seriesName]);
  _setTitle(seriesName);
  _resetFilter();
  _resetListLayout();
  listEl.innerHTML = '';
  try {
    const data = await _fetchJSON(`${API}/series/${encodeURIComponent(seriesId)}/volumes`);
    const vols = (data && data.volumes) || [];
    if (!vols.length) {
      listEl.innerHTML = '<div style="opacity:0.6;padding:12px;">No hay capítulos/volúmenes en esta serie.</div>';
      return;
    }
    vols.forEach((v) => {
      // Kavita devuelve VOLÚMENES que contienen capítulos. El capítulo real
      // (chapters[0].id) es lo que leemos y con lo que escribimos progreso; el
      // volumeId (v.id) también viaja en el ProgressDto. Fallbacks para formas
      // en que la fila ya sea un capítulo suelto.
      const volumeId = v.id ?? v.volumeId ?? v.volume_id ?? null;
      const chapterId = (v.chapters && v.chapters[0] && v.chapters[0].id)
        ?? v.chapterId ?? v.chapter_id ?? v.id;
      const name = _volumeLabel(v, seriesName);
      const row = document.createElement('div');
      row.className = 'kavita-row';
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:8px;cursor:pointer;border:1px solid rgba(128,128,128,0.15);background:rgba(128,128,128,0.04);';
      row.innerHTML = `<span style="font-size:1em;">📄</span><span class="grow" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_escapeHtml(name)}</span>`;
      row.addEventListener('click', () => _openChapter(chapterId, name, volumeId));
      listEl.appendChild(row);
    });
  } catch (e) {
    _showError(_friendlyError(e));
  } finally {
    _setLoading(false);
  }
}

// ── reader ─────────────────────────────────────────────────────────────────

async function _openChapter(chapterId, chapterName, volumeId) {
  // Guard: nunca abrir el lector con un id inválido (evita fetch /book/null y
  // el 422 críptico que veía el usuario). Mensaje accionable, no traceback.
  if (chapterId == null || chapterId === 'null' || chapterId === '') {
    _showError('No se pudo abrir el libro: Kavita no devolvió un id de capítulo para este título.');
    return;
  }
  state.view = 'reader';
  state.chapterId = chapterId;
  state.volumeId = volumeId ?? null;
  state.page = 0;
  state.toc = [];
  _showReader();
  _clearError();
  _setBreadcrumb([chapterName]);
  _setTitle(chapterName);
  pageEl.innerHTML = '<div style="opacity:0.6;padding:24px;text-align:center;">Cargando página…</div>';
  tocEl.innerHTML = '';
  tocEl.classList.add('hidden');
  pageIndicator.textContent = '—';

  // Fetch progress (delegated, read-only) to jump to the last page.
  let startPage = 0;
  try {
    const prog = await _fetchJSON(`${API}/progress?chapterId=${encodeURIComponent(chapterId)}`);
    const p = prog && (prog.pageNum ?? prog.page ?? prog.currentPage);
    if (typeof p === 'number' && p > 0) startPage = p;
  } catch (_) { /* no progress — start at 0 */ }

  await _loadPage(startPage);
  _loadToc();
}

// Escribe el progreso de lectura de vuelta a Kavita (DELEGADO — Kavita es la
// fuente de verdad). Best-effort: un fallo JAMÁS interrumpe la lectura ni el TTS
// (fire-and-forget, se traga el error). Slice 2c.
function _saveProgress(pageNum) {
  if (state.chapterId == null) return;
  try {
    fetch(`${API}/progress`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chapterId: state.chapterId,
        page: pageNum,
        seriesId: state.seriesId || 0,
        volumeId: state.volumeId || 0,
        libraryId: state.libraryId || 0,
      }),
    }).catch(() => { /* best-effort: no rompe la lectura */ });
  } catch (_) { /* ignore */ }
}

// Devuelve true si cargó una página real; false si fue fin-de-libro o error
// (lo usa el lector en voz alta para saber si auto-avanzar o detenerse).
async function _loadPage(pageNum) {
  // Token de generación: cada carga se numera; una carga MÁS NUEVA supersede a la
  // vieja. Antes un guard `if (state.loading) return` dejaba, cuando un load en
  // vuelo del TTS quedaba huérfano al DETENER la lectura, state.loading=true, y
  // BLOQUEABA toda navegación posterior → el lector se trababa en "Cargando".
  // Con el token: un load nuevo siempre procede, y solo el ÚLTIMO pinta/libera.
  const myGen = ++state.loadGen;
  state.loading = true;
  pageEl.innerHTML = '<div style="opacity:0.6;padding:24px;text-align:center;">Cargando…</div>';
  try {
    const html = await _fetchText(`${API}/book/${encodeURIComponent(state.chapterId)}/page?page=${encodeURIComponent(pageNum)}`);
    if (myGen !== state.loadGen) return false;   // superado por una carga más nueva → descartar
    _injectPageHtml(html);
    state.page = pageNum;
    pageIndicator.textContent = `pág. ${pageNum}`;
    prevBtn.disabled = pageNum <= 0;
    nextBtn.disabled = false;
    _saveProgress(pageNum);   // write-back DELEGADO a Kavita (best-effort, Slice 2c)
    return true;
  } catch (e) {
    if (myGen !== state.loadGen) return false;   // superado → no pintar error viejo
    // If it's a 404/400 on a high page, treat as end-of-book.
    if (e.status === 404 || e.status === 400) {
      pageEl.innerHTML = '<div style="padding:24px;text-align:center;opacity:0.7;">Fin del libro.</div>';
      nextBtn.disabled = true;
      prevBtn.disabled = state.page <= 0;
      return false;
    }
    pageEl.innerHTML = '';
    _showError(_friendlyError(e));
    return false;
  } finally {
    // Solo la carga MÁS NUEVA libera el candado (una vieja superada no lo toca).
    if (myGen === state.loadGen) state.loading = false;
  }
}

function _injectPageHtml(html) {
  // Rewrite relative img/css URLs to the resource proxy.
  const chapterId = state.chapterId;
  const resourceBase = `${API}/book/${encodeURIComponent(chapterId)}/resource?file=`;

  // Rewrite src="..." and href="..." that are relative (not http/https/data/#).
  const rewritten = html
    .replace(/\bsrc\s*=\s*["']([^"'#]+)["']/gi, (m, url) => {
      if (/^(https?:|data:|blob:)/i.test(url)) return m;
      return `src="${resourceBase + encodeURIComponent(url)}"`;
    })
    .replace(/\bhref\s*=\s*["']([^"'#]+)\.(css|CSS)["']/gi, (m, url) => {
      if (/^(https?:|data:|blob:)/i.test(url)) return m;
      return `href="${resourceBase + encodeURIComponent(url)}"`;
    });

  pageEl.innerHTML = rewritten;
}

async function _loadToc() {
  try {
    const data = await _fetchJSON(`${API}/book/${encodeURIComponent(state.chapterId)}/toc`);
    const toc = (data && data.toc) || [];
    state.toc = toc;
    tocEl.innerHTML = '';
    if (!toc.length) {
      tocEl.innerHTML = '<div style="opacity:0.5;padding:8px;">Sin índice.</div>';
      return;
    }
    _renderTocEntries(toc, tocEl);
  } catch (_) {
    tocEl.innerHTML = '<div style="opacity:0.5;padding:8px;">Índice no disponible.</div>';
  }
}

function _renderTocEntries(entries, container) {
  entries.forEach((entry) => {
    const title = entry.title || entry.name || entry.part || '—';
    const page = entry.page ?? entry.pageNum ?? entry.page_number ?? null;
    const item = document.createElement('div');
    item.style.cssText = 'padding:6px 8px;border-radius:6px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    item.textContent = title;
    if (page != null) {
      item.title = `Ir a página ${page}`;
      item.addEventListener('click', () => {
        bookTTS.stop();
        _loadPage(page);
        tocEl.classList.add('hidden');
      });
    } else {
      item.style.cursor = 'default';
      item.style.opacity = '0.6';
    }
    container.appendChild(item);
    if (entry.children && entry.children.length) {
      const sub = document.createElement('div');
      sub.style.cssText = 'margin-left:12px;';
      _renderTocEntries(entry.children, sub);
      container.appendChild(sub);
    }
  });
}

// ── error mapping ──────────────────────────────────────────────────────────

function _friendlyError(e) {
  const status = e && e.status;
  const msg = (e && e.message) || 'Error desconocido';
  if (status === 503) return `Kavita no disponible: ${msg}`;
  if (status === 401) return `Kavita rechazó la autenticación: ${msg}`;
  if (status === 502) return `Error de Kavita: ${msg}`;
  if (status === 404) return `No encontrado: ${msg}`;
  return msg;
}

// ── lectura en voz alta del libro (Slice 3) ─────────────────────────────────
//
// Reutiliza el TTS multi-provider del fork (POST /api/tts/synthesize, con caché
// server-side + config de proveedor/voz/velocidad en Ajustes → Voz), y el
// fallback de navegador (Web Speech API) cuando el proveedor es "browser".
// El PROGRESO DE AUDIO ES EL PROGRESO DE LECTURA: cada segmento hablado se
// resalta y se centra; al terminar la página, auto-avanza a la siguiente.

const bookTTS = {
  active: false,
  segments: [],
  idx: 0,
  audio: null,
  provider: 'disabled',
  browser: false,
  voice: '',
  speed: 1,
  cache: new Map(),   // texto → objectURL (caché de audio del cliente)

  async _loadStats() {
    try {
      const s = await _fetchJSON('/api/tts/stats');
      this.provider = s.provider || 'disabled';
      this.voice = s.voice || '';
      this.speed = s.speed || 1;
      this.browser = this.provider === 'browser';
      if (this.browser) return 'speechSynthesis' in window;
      return !!(s.available && s.ready);
    } catch (_) {
      return false;
    }
  },

  // Segmenta el HTML renderizado por Kavita en bloques de texto legibles.
  _collectSegments() {
    const out = [];
    const blocks = pageEl.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, dt');
    if (!blocks.length) {
      const t = (pageEl.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) out.push({ el: pageEl, text: t });
      return out;
    }
    blocks.forEach((el) => {
      // Evita duplicar: si el bloque contiene otros bloques que también recolectamos.
      if (el.querySelector('p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, dt')) return;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) out.push({ el, text });
    });
    return out;
  },

  async toggle() {
    if (this.active) { this.stop(); return; }
    _clearError();
    const ok = await this._loadStats();
    if (!ok) {
      _showError('Lectura en voz alta no disponible: actívala en Ajustes → Voz (proveedor de TTS).');
      return;
    }
    this.active = true;
    _ttsBtnState(true);
    this.segments = this._collectSegments();
    this.idx = 0;
    if (!this.segments.length) {
      // Página sin texto (portada/imagen): intenta avanzar hasta hallar texto.
      const advanced = await this._nextPage();
      if (!advanced) { _showError('No hay texto que leer en esta página.'); this.stop(); return; }
    }
    this._playLoop();
  },

  stop() {
    this.active = false;
    if (this.audio) { try { this.audio.pause(); } catch (_) {} this.audio = null; }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    this._clearHighlight();
    _ttsBtnState(false);
  },

  _clearHighlight() {
    pageEl.querySelectorAll('.kavita-tts-active').forEach((el) => el.classList.remove('kavita-tts-active'));
  },

  async _playLoop() {
    while (this.active) {
      if (this.idx >= this.segments.length) {
        const advanced = await this._nextPage();
        if (!advanced) { this.stop(); return; }
        continue;
      }
      const seg = this.segments[this.idx];
      this._clearHighlight();
      if (seg.el && seg.el.classList) {
        seg.el.classList.add('kavita-tts-active');
        try { seg.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
      }
      try {
        await this._speak(seg.text);
      } catch (e) {
        // Detener la lectura ABORTA el play() en vuelo (pause/quitar el <audio>):
        // eso NO es un error real, es el stop del usuario → no lo mostramos.
        const msg = (e && e.message) ? e.message : String(e);
        const interrupted = /interrupt|removed from the document|abort|pause/i.test(msg);
        if (this.active && !interrupted) _showError('Error de lectura en voz alta: ' + msg);
        this.stop();
        return;
      }
      if (!this.active) return;
      this.idx += 1;
    }
  },

  async _nextPage() {
    const ok = await _loadPage(state.page + 1);
    if (!ok || !this.active) return false;
    this.segments = this._collectSegments();
    this.idx = 0;
    // Salta páginas sin texto (imágenes) sin abortar la lectura.
    if (!this.segments.length) return this._nextPage();
    return true;
  },

  async _speak(text) {
    if (this.browser) {
      return new Promise((resolve, reject) => {
        const u = new SpeechSynthesisUtterance(text);
        const v = this._browserVoice();
        if (v) u.voice = v;
        u.rate = this.speed || 1;
        u.onend = () => resolve();
        u.onerror = (e) => reject(new Error('TTS del navegador: ' + (e && e.error ? e.error : 'fallo')));
        window.speechSynthesis.speak(u);
      });
    }
    const url = await this._audioUrl(text);
    return new Promise((resolve, reject) => {
      const audio = new Audio(url);
      // El proveedor local no aplica velocidad server-side → la aplica el reproductor.
      if (this.provider === 'local' && this.speed !== 1) audio.playbackRate = this.speed;
      this.audio = audio;
      audio.onended = () => { if (this.audio === audio) this.audio = null; resolve(); };
      audio.onerror = () => reject(new Error('fallo al reproducir el audio'));
      // play() se RECHAZA con AbortError cuando detenemos (stop() llama pause()).
      // Eso NO es un fallo: es el stop del usuario → resolver limpio, para no
      // filtrar un "Uncaught AbortError" crudo a la consola (el _playLoop ya sale
      // solo porque this.active pasó a false). Cualquier otro error sí propaga.
      audio.play().catch((e) => {
        if (e && (e.name === 'AbortError' || /interrupt|abort|pause/i.test(e.message || ''))) {
          resolve();
        } else {
          reject(e);
        }
      });
    });
  },

  async _audioUrl(text) {
    if (this.cache.has(text)) return this.cache.get(text);
    const res = await fetch('/api/tts/synthesize', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 5000), format: 'audio' }),
    });
    if (!res.ok) {
      let msg = 'la síntesis de voz falló';
      try { const b = await res.json(); msg = (b.detail && b.detail.message) || msg; } catch (_) {}
      throw new Error(msg);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    this.cache.set(text, url);
    return url;
  },

  _browserVoice() {
    if (!this.voice) return null;
    const vs = window.speechSynthesis.getVoices();
    const t = this.voice.toLowerCase();
    return vs.find((v) => v.name.toLowerCase() === t) ||
           vs.find((v) => v.name.toLowerCase().includes(t)) || null;
  },
};

function _ttsBtnState(on) {
  const btn = _el('kavita-tts-btn');
  if (!btn) return;
  btn.textContent = on ? '⏹ Detener' : '🔊 Leer';
  btn.style.background = on ? 'rgba(255,214,10,0.22)' : '';
  btn.title = on ? 'Detener la lectura en voz alta' : 'Leer el libro en voz alta';
}

// ── Controles de voz + velocidad EN LA BARRA DEL LECTOR ──────────────────────
// Los knobs viven también en Ajustes → Voz, pero enterrados; aquí quedan a la
// mano mientras se lee. Espejan la MISMA lista de voces de settings.js y guardan
// por el MISMO endpoint (POST /api/auth/settings), luego limpian la caché de
// audio (cliente + server) para que el cambio se oiga de inmediato.
const _KOKORO_VOICE_GROUPS = [
  ['Español', [['ef_dora', 'Dora (♀ es)'], ['em_alex', 'Alex (♂ es)'], ['em_santa', 'Santa (♂ es)']]],
  ['English (US)', [['af_heart', 'Heart (♀)'], ['af_bella', 'Bella (♀)'], ['af_nicole', 'Nicole (♀)'], ['af_sarah', 'Sarah (♀)'], ['am_michael', 'Michael (♂)'], ['am_adam', 'Adam (♂)']]],
  ['English (UK)', [['bf_emma', 'Emma (♀)'], ['bf_isabella', 'Isabella (♀)'], ['bm_george', 'George (♂)'], ['bm_lewis', 'Lewis (♂)']]],
];
const _OPENAI_VOICES = [['alloy', 'Alloy'], ['ash', 'Ash'], ['coral', 'Coral'], ['echo', 'Echo'], ['fable', 'Fable'], ['nova', 'Nova'], ['onyx', 'Onyx'], ['sage', 'Sage'], ['shimmer', 'Shimmer']];

function _populateVoiceSelect(provider, current) {
  if (!ttsVoiceEl) return;
  ttsVoiceEl.innerHTML = '';
  const isKokoro = provider === 'kokoro' || provider === 'local';
  if (isKokoro) {
    _KOKORO_VOICE_GROUPS.forEach(([label, voices]) => {
      const og = document.createElement('optgroup');
      og.label = label;
      voices.forEach(([val, txt]) => {
        const o = document.createElement('option');
        o.value = val; o.textContent = txt; og.appendChild(o);
      });
      ttsVoiceEl.appendChild(og);
    });
  } else {
    _OPENAI_VOICES.forEach(([val, txt]) => {
      const o = document.createElement('option');
      o.value = val; o.textContent = txt; ttsVoiceEl.appendChild(o);
    });
  }
  // Si la voz actual no está en la lista (voz libre / provider raro), añádela.
  if (current && !ttsVoiceEl.querySelector('option[value="' + current.replace(/"/g, '') + '"]')) {
    const o = document.createElement('option');
    o.value = current; o.textContent = current; ttsVoiceEl.appendChild(o);
  }
  if (current) ttsVoiceEl.value = current;
}

async function _saveTtsSetting(body) {
  try {
    await fetch('/api/auth/settings', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch (_) { /* fire-and-forget */ }
  // Cambió la voz/velocidad → la caché anterior ya no aplica.
  bookTTS.cache.clear();
  fetch('/api/tts/clear-cache', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
}

// Sincroniza los selects con el estado real del TTS. En proveedor "browser" el
// TTS usa voces del SO (no de esta lista) → se ocultan los knobs. Never-throws.
async function _syncTtsControls() {
  if (!ttsVoiceEl || !ttsSpeedEl) return;
  await bookTTS._loadStats();
  const prov = bookTTS.provider || 'disabled';
  if (prov === 'disabled' || prov === 'browser') {
    ttsVoiceEl.style.display = 'none';
    ttsSpeedEl.style.display = 'none';
    return;
  }
  _populateVoiceSelect(prov, bookTTS.voice || '');
  ttsSpeedEl.value = String(bookTTS.speed || 1);
  ttsVoiceEl.style.display = '';
  ttsSpeedEl.style.display = '';
}

function _wireTtsControls() {
  if (ttsVoiceEl) {
    ttsVoiceEl.addEventListener('change', async () => {
      const v = ttsVoiceEl.value;
      bookTTS.voice = v;
      await _saveTtsSetting({ tts_voice: v });
    });
  }
  if (ttsSpeedEl) {
    ttsSpeedEl.addEventListener('change', async () => {
      const s = ttsSpeedEl.value;
      bookTTS.speed = Number(s) || 1;
      await _saveTtsSetting({ tts_speed: s });
    });
  }
}

// ── wiring ─────────────────────────────────────────────────────────────────

function _wire() {
  // Open from sidebar button.
  const openBtn = _el('tool-kavita-btn');
  if (openBtn && modal) {
    openBtn.addEventListener('click', () => {
      modal.classList.remove('hidden');
      // Reset to libraries view each time we open.
      state.view = 'libraries';
      state.libraryId = null;
      state.seriesId = null;
      state.chapterId = null;
      state.authorId = null;
      state.page = 0;
      state.toc = [];
      _showBrowser();
      _loadTop();
    });
  }

  // Close.
  if (closeBtn && modal) {
    closeBtn.addEventListener('click', () => { bookTTS.stop(); modal.classList.add('hidden'); });
  }

  // Back.
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      bookTTS.stop();
      if (state.view === 'reader') {
        // Go back to chapters.
        state.view = 'chapters';
        _showBrowser();
        if (state.seriesId != null) {
          _openSeries(state.seriesId, 'Serie');
        } else {
          _loadLibraries();
        }
      } else if (state.view === 'chapters') {
        state.view = 'series';
        _showBrowser();
        if (state.libraryId != null) {
          _openLibrary(state.libraryId, 'Biblioteca');
        } else if (state.authorId != null) {
          _openAuthor(state.authorId, state.authorName || 'Autor');
        } else {
          _loadTop();
        }
      } else if (state.view === 'series') {
        state.view = 'libraries';
        _showBrowser();
        _loadTop();
      }
    });
  }

  // Reader nav. La navegación MANUAL detiene la lectura en voz alta (evita
  // que el resaltado/audio se desincronice de la página que el usuario eligió).
  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      bookTTS.stop();
      if (state.page > 0) _loadPage(state.page - 1);
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      bookTTS.stop();
      _loadPage(state.page + 1);
    });
  }

  // Lectura en voz alta (toggle).
  const ttsBtn = _el('kavita-tts-btn');
  if (ttsBtn) {
    ttsBtn.addEventListener('click', () => bookTTS.toggle());
  }

  // Knobs de voz + velocidad en la barra del lector.
  _wireTtsControls();

  // Toggle lista/cuadrícula del navegador de series.
  if (viewListBtn) viewListBtn.addEventListener('click', () => _setBrowseView('list'));
  if (viewGridBtn) viewGridBtn.addEventListener('click', () => _setBrowseView('grid'));

  // Filtro/búsqueda de la lista actual (bibliotecas/series/capítulos).
  if (filterEl) {
    filterEl.addEventListener('input', _applyFilter);
  }

  // TOC toggle.
  if (tocToggle && tocEl) {
    tocToggle.addEventListener('click', () => {
      tocEl.classList.toggle('hidden');
    });
  }

  // Keyboard: Esc closes, arrows navigate.
  document.addEventListener('keydown', (e) => {
    if (!modal || modal.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      bookTTS.stop();
      modal.classList.add('hidden');
    } else if (state.view === 'reader') {
      if (e.key === 'ArrowLeft' && state.page > 0) {
        e.preventDefault();
        bookTTS.stop();
        _loadPage(state.page - 1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        bookTTS.stop();
        _loadPage(state.page + 1);
      }
    }
  });
}

// ── init ───────────────────────────────────────────────────────────────────

function _injectTtsStyle() {
  if (document.getElementById('kavita-tts-style')) return;
  const st = document.createElement('style');
  st.id = 'kavita-tts-style';
  st.textContent =
    '.kavita-tts-active{background:rgba(255,214,10,0.35)!important;' +
    'border-radius:3px;box-shadow:0 0 0 3px rgba(255,214,10,0.25);' +
    'transition:background .2s;}';
  document.head.appendChild(st);
}

function _init() {
  _initDom();
  _injectTtsStyle();
  _wire();
}

// Run on DOM ready (scripts are type=module so they're deferred anyway).
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _init);
} else {
  _init();
}

export default { open: () => _el('tool-kavita-btn')?.click() };
