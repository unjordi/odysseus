// static/js/i18n.js
// Minimal, dependency-free UI localization for the SPA.
//
// Design notes:
// - Keys ARE the English source strings (gettext-style). A missing translation
//   falls back to the key, so an untranslated string always renders as English
//   instead of breaking. This also means new English copy needs no key bureaucracy.
// - Catalogs are plain JSON served as static assets from static/locales/<lang>.json
//   (LOCALES_DIR in src/constants.py; SUPPORTED_UI_LANGUAGES is the source of truth).
// - The resolved language and loaded catalog are stashed on window
//   (__odysseusLang / __i18nCatalog / __i18nReady) so a page's sync inline
//   bootstrap and this module share ONE fetch and ONE catalog object. login.html
//   mirrors a tiny piece of this inline for the same first-paint reason the theme
//   bootstrap does — this module stays the canonical engine for the main app.

import { KEYS } from './storage.js';

export const SUPPORTED_LANGUAGES = ['en', 'es'];
export const DEFAULT_LANGUAGE = 'en';

const COOKIE_NAME = 'odysseus_lang';

let _catalog = (typeof window !== 'undefined' && window.__i18nCatalog) || {};
let _lang = (typeof window !== 'undefined' && window.__odysseusLang) || DEFAULT_LANGUAGE;

/** Narrow any input to a supported language code (e.g. "es-MX" -> "es"). */
function normalizeLang(value) {
  const code = String(value || '').toLowerCase().split('-')[0];
  return SUPPORTED_LANGUAGES.includes(code) ? code : null;
}

/**
 * Resolve the active UI language, in priority order:
 * server-seeded <html lang> / window.__odysseusLang -> saved preference ->
 * browser language -> DEFAULT_LANGUAGE.
 */
export function resolveLanguage() {
  if (typeof document !== 'undefined') {
    const fromHtml = normalizeLang(document.documentElement.getAttribute('lang'));
    if (fromHtml) return fromHtml;
  }
  if (typeof window !== 'undefined' && window.__odysseusLang) {
    const fromWindow = normalizeLang(window.__odysseusLang);
    if (fromWindow) return fromWindow;
  }
  try {
    const saved = normalizeLang(localStorage.getItem(KEYS.UI_LANGUAGE));
    if (saved) return saved;
  } catch (e) { /* localStorage unavailable */ }
  if (typeof navigator !== 'undefined') {
    const fromNav = normalizeLang(navigator.language);
    if (fromNav) return fromNav;
  }
  return DEFAULT_LANGUAGE;
}

export function getLanguage() {
  return _lang;
}

/** Fetch and cache a language catalog. English needs no file (keys are English). */
export async function loadCatalog(lang) {
  const code = normalizeLang(lang) || DEFAULT_LANGUAGE;
  if (code === DEFAULT_LANGUAGE) {
    _catalog = {};
  } else {
    try {
      const res = await fetch(`/static/locales/${code}.json`, { credentials: 'same-origin' });
      _catalog = res.ok ? await res.json() : {};
    } catch (e) {
      _catalog = {};
    }
  }
  _lang = code;
  if (typeof window !== 'undefined') {
    window.__i18nCatalog = _catalog;
    window.__odysseusLang = _lang;
  }
  return _catalog;
}

/**
 * Translate a key (an English source string). Interpolates {name} placeholders
 * from params. Unknown keys fall back to the key itself.
 */
export function t(key, params) {
  let out = (_catalog && Object.prototype.hasOwnProperty.call(_catalog, key)) ? _catalog[key] : key;
  if (params) {
    for (const k of Object.keys(params)) {
      out = out.replace(new RegExp('\\{' + k + '\\}', 'g'), String(params[k]));
    }
  }
  return out;
}

/**
 * Apply translations to a DOM subtree. Two hooks:
 * - data-i18n="Key"            -> element.textContent = t("Key")
 * - data-i18n-<attr>="Key"     -> element.setAttribute(<attr>, t("Key"))
 *   e.g. data-i18n-placeholder, data-i18n-title, data-i18n-aria-label
 */
export function applyTranslations(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  scope.querySelectorAll('*').forEach((el) => {
    // Snapshot attributes: setAttribute below can add a new one (e.g. title),
    // which would mutate the live NamedNodeMap mid-iteration.
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('data-i18n-')) {
        const target = attr.name.slice('data-i18n-'.length);
        el.setAttribute(target, t(attr.value));
      }
    }
  });
}

/**
 * Persist a language choice and re-render. Sets both localStorage (client source
 * of truth) and the odysseus_lang cookie so the server can seed <html lang> on
 * the next full page load (avoiding an English flash). The language selector
 * (PR-2) calls this.
 */
export async function setLanguage(lang) {
  const code = normalizeLang(lang) || DEFAULT_LANGUAGE;
  try { localStorage.setItem(KEYS.UI_LANGUAGE, code); } catch (e) { /* ignore */ }
  try {
    document.cookie = `${COOKIE_NAME}=${code}; path=/; max-age=31536000; samesite=lax`;
  } catch (e) { /* ignore */ }
  await loadCatalog(code);
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('lang', code);
    applyTranslations(document);
  }
  return code;
}

/**
 * Boot the i18n runtime: pick the language, load its catalog (reusing a catalog
 * a page's inline bootstrap may have already started fetching), and translate
 * the current document once the DOM is ready.
 */
export async function initI18n() {
  const lang = resolveLanguage();
  if (typeof window !== 'undefined' && window.__i18nReady) {
    // A page bootstrap already kicked off the fetch — reuse it.
    try { _catalog = (await window.__i18nReady) || {}; } catch (e) { _catalog = {}; }
    _lang = lang;
    window.__i18nCatalog = _catalog;
  } else {
    await loadCatalog(lang);
  }
  const run = () => applyTranslations(document);
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run, { once: true });
    } else {
      run();
    }
  }
  return _lang;
}

// Expose a small global surface for classic (non-module) inline scripts that
// cannot import ESM (e.g. login.html's auth handler runs before modules).
if (typeof window !== 'undefined') {
  window.__i18n = { t, applyTranslations, setLanguage, getLanguage, initI18n };
  if (typeof window.t !== 'function') window.t = t;
}
