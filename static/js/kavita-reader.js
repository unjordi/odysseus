// Kavita Library / Reader — #31 Slice 2b
//
// Front-end visor de EPUB que delega el rendering a Kavita (paridad visual).
// El backend (routes/kavita_routes.py) ya expone:
//   GET /api/kavita/libraries
//   GET /api/kavita/series?libraryId=
//   GET /api/kavita/series/{seriesId}/volumes
//   GET /api/kavita/progress?chapterId=
//   GET /api/kavita/book/{chapterId}/info
//   GET /api/kavita/book/{chapterId}/toc
//   GET /api/kavita/book/{chapterId}/page?page=N
//   GET /api/kavita/book/{chapterId}/resource?file=<path>
//
// Patrón del shell: modal #kavita-modal (mismo estilo que #memory-modal),
// botón en la sidebar (#tool-kavita-btn), fetch con credentials same-origin.
//
// ESCRIBIR progreso es el Slice 2c — NO se hace aquí.

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
  page: 0,
  totalPages: null,
  toc: [],
  loading: false,
};

// ── DOM refs ───────────────────────────────────────────────────────────────

let modal, closeBtn, backBtn, titleEl, breadcrumbEl;
let browserPane, errorEl, loadingEl, listEl;
let readerPane, prevBtn, nextBtn, pageIndicator, tocToggle, tocEl, pageEl;

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
  readerPane = _el('kavita-reader');
  prevBtn = _el('kavita-prev');
  nextBtn = _el('kavita-next');
  pageIndicator = _el('kavita-page-indicator');
  tocToggle = _el('kavita-toc-toggle');
  tocEl = _el('kavita-toc');
  pageEl = _el('kavita-page');
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

function _showBrowser() {
  if (browserPane) browserPane.classList.remove('hidden');
  if (readerPane) readerPane.classList.add('hidden');
  if (backBtn) backBtn.style.display = state.view === 'libraries' ? 'none' : '';
}

function _showReader() {
  if (browserPane) browserPane.classList.add('hidden');
  if (readerPane) readerPane.classList.remove('hidden');
  if (backBtn) backBtn.style.display = '';
}

// ── navigation: libraries ──────────────────────────────────────────────────

async function _loadLibraries() {
  _clearError();
  _setLoading(true);
  _setBreadcrumb([]);
  _setTitle('Biblioteca');
  listEl.innerHTML = '';
  try {
    const data = await _fetchJSON(`${API}/libraries`);
    const libs = (data && data.libraries) || [];
    if (!libs.length) {
      listEl.innerHTML = '<div style="opacity:0.6;padding:12px;">No hay bibliotecas en Kavita.</div>';
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
  listEl.innerHTML = '';
  try {
    const data = await _fetchJSON(`${API}/series?libraryId=${encodeURIComponent(libraryId)}`);
    const series = (data && data.series) || [];
    if (!series.length) {
      listEl.innerHTML = '<div style="opacity:0.6;padding:12px;">No hay series en esta biblioteca.</div>';
      return;
    }
    series.forEach((s) => {
      const id = s.id ?? s.seriesId ?? s.series_id;
      const name = s.name || s.title || `Serie ${id}`;
      const row = document.createElement('div');
      row.className = 'kavita-row';
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:8px;cursor:pointer;border:1px solid rgba(128,128,128,0.15);background:rgba(128,128,128,0.04);';
      row.innerHTML = `<span style="font-size:1.05em;">📖</span><span class="grow" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_escapeHtml(name)}</span>`;
      row.addEventListener('click', () => _openSeries(id, name));
      listEl.appendChild(row);
    });
  } catch (e) {
    _showError(_friendlyError(e));
  } finally {
    _setLoading(false);
  }
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
  listEl.innerHTML = '';
  try {
    const data = await _fetchJSON(`${API}/series/${encodeURIComponent(seriesId)}/volumes`);
    const vols = (data && data.volumes) || [];
    if (!vols.length) {
      listEl.innerHTML = '<div style="opacity:0.6;padding:12px;">No hay capítulos/volúmenes en esta serie.</div>';
      return;
    }
    vols.forEach((v) => {
      const id = v.id ?? v.chapterId ?? v.chapter_id ?? v.volumeId ?? v.volume_id;
      const name = v.name || v.title || v.chapterName || `Capítulo ${id}`;
      const row = document.createElement('div');
      row.className = 'kavita-row';
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:8px;cursor:pointer;border:1px solid rgba(128,128,128,0.15);background:rgba(128,128,128,0.04);';
      row.innerHTML = `<span style="font-size:1em;">📄</span><span class="grow" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_escapeHtml(name)}</span>`;
      row.addEventListener('click', () => _openChapter(id, name));
      listEl.appendChild(row);
    });
  } catch (e) {
    _showError(_friendlyError(e));
  } finally {
    _setLoading(false);
  }
}

// ── reader ─────────────────────────────────────────────────────────────────

async function _openChapter(chapterId, chapterName) {
  state.view = 'reader';
  state.chapterId = chapterId;
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

async function _loadPage(pageNum) {
  if (state.loading) return;
  state.loading = true;
  pageEl.innerHTML = '<div style="opacity:0.6;padding:24px;text-align:center;">Cargando…</div>';
  try {
    const html = await _fetchText(`${API}/book/${encodeURIComponent(state.chapterId)}/page?page=${encodeURIComponent(pageNum)}`);
    _injectPageHtml(html);
    state.page = pageNum;
    pageIndicator.textContent = `pág. ${pageNum}`;
    prevBtn.disabled = pageNum <= 0;
    nextBtn.disabled = false;
  } catch (e) {
    // If it's a 404/400 on a high page, treat as end-of-book.
    if (e.status === 404 || e.status === 400) {
      pageEl.innerHTML = '<div style="padding:24px;text-align:center;opacity:0.7;">Fin del libro.</div>';
      nextBtn.disabled = true;
      prevBtn.disabled = state.page <= 0;
      state.loading = false;
      return;
    }
    pageEl.innerHTML = '';
    _showError(_friendlyError(e));
    state.loading = false;
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
      state.page = 0;
      state.toc = [];
      _showBrowser();
      _loadLibraries();
    });
  }

  // Close.
  if (closeBtn && modal) {
    closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  }

  // Back.
  if (backBtn) {
    backBtn.addEventListener('click', () => {
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
        } else {
          _loadLibraries();
        }
      } else if (state.view === 'series') {
        state.view = 'libraries';
        _showBrowser();
        _loadLibraries();
      }
    });
  }

  // Reader nav.
  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      if (state.page > 0) _loadPage(state.page - 1);
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      _loadPage(state.page + 1);
    });
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
      modal.classList.add('hidden');
    } else if (state.view === 'reader') {
      if (e.key === 'ArrowLeft' && state.page > 0) {
        e.preventDefault();
        _loadPage(state.page - 1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        _loadPage(state.page + 1);
      }
    }
  });
}

// ── init ───────────────────────────────────────────────────────────────────

function _init() {
  _initDom();
  _wire();
}

// Run on DOM ready (scripts are type=module so they're deferred anyway).
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _init);
} else {
  _init();
}

export default { open: () => _el('tool-kavita-btn')?.click() };
