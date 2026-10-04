/**
 * Minimal English/Chinese localisation for the vanilla-JS frontend.
 *
 * - English source text is the key; `locales/zh.js` maps it to Chinese.
 * - `t(text, params)` translates explicit strings and fills `{name}` placeholders.
 * - A DOM walker + MutationObserver translates static HTML and dynamically rendered text/attributes.
 *   The original English is remembered per node, so switching back to English is lossless.
 * - Logic must always compare untranslated English/key values, never displayed (translated) text.
 */
import zh from './locales/zh.js';

export const LANGUAGE_KEY = 'wb.language';
export const LANGUAGES = Object.freeze(['en', 'zh']);
const LANGUAGE_ATTRIBUTES = Object.freeze(['title', 'aria-label', 'placeholder', 'alt', 'aria-description']);
const CJK = /[\u3400-\u9fff\uff00-\uffef]/;
const CONTEXT_SUFFIX = /@@[\w-]+$/;
// Never translate these: markup that is not text, and containers that hold user / model / file content.
const SKIP_SELECTOR = [
  '[translate="no"]', 'script', 'style', 'textarea', 'noscript',
  '.chat-message-text', '.markdown-body', '.run-log-pre', '.history-viewer-content', '.attachment-text',
  '.artifact-code', '.role-card-name', '.project-item-copy > strong', '#file-content', '#document-content'
].join(',');

export function normalizeLanguage(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'en' || text.startsWith('en-')) return 'en';
  if (text === 'zh' || text.startsWith('zh-') || text.startsWith('zh_')) return 'zh';
  return null;
}

function readSaved() {
  try { return normalizeLanguage(localStorage.getItem(LANGUAGE_KEY)); } catch { return null; }
}
function browserLanguage() {
  try { return normalizeLanguage(navigator.language) === 'zh' ? 'zh' : 'en'; } catch { return 'en'; }
}

let language = readSaved() || browserLanguage();
let syncHooks = null;
const listeners = new Set();

// zh -> en lookup, used to restore English for text that was copied from an already translated node.
const reverse = new Map();
for (const [key, value] of Object.entries(zh)) {
  if (typeof value !== 'string' || key.includes('{') || reverse.has(value)) continue;
  reverse.set(value, key.replace(CONTEXT_SUFFIX, ''));
}

export function getLanguage() { return language; }
/** Locale for Intl / toLocaleString calls. */
export function dateLocale() { return language === 'zh' ? 'zh-CN' : 'en-US'; }

function lookup(text) {
  const exact = zh[text];
  if (typeof exact === 'string') return exact;
  const flat = text.replace(/\s+/g, ' ');
  if (flat !== text && typeof zh[flat] === 'string') return zh[flat];
  return undefined;
}

function fill(text, params) {
  return text.replace(/\{(\w+)\}/g, (match, name) => (params && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match));
}

/** Translate an English UI string (optionally with `{name}` placeholders filled from `params`). */
export function t(text, params) {
  if (typeof text !== 'string') return text;
  let out = language === 'zh' ? lookup(text) : undefined;
  if (out === undefined) out = text.includes('@@') ? text.replace(CONTEXT_SUFFIX, '') : text;
  return params ? fill(out, params) : out;
}

/** Translate a whole text/attribute value while preserving surrounding whitespace; returns the input when unknown. */
function translateValue(value) {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(value);
  if (!match || !match[2]) return value;
  const found = lookup(match[2]);
  if (found !== undefined) return match[1] + found + match[3];
  // Safety net for composite labels such as "Running · Parallel": translate each " · " part that is known.
  if (match[2].includes(' · ')) {
    let changed = false;
    const parts = match[2].split(' · ').map(part => { const hit = lookup(part); if (hit !== undefined) changed = true; return hit ?? part; });
    if (changed) return match[1] + parts.join(' · ') + match[3];
  }
  return value;
}
function englishOf(value) {
  if (!CJK.test(value)) return value;
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(value);
  const found = match && reverse.get(match[2]);
  if (found !== undefined) return match[1] + found + match[3];
  if (match && match[2].includes(' · ')) {
    let changed = false;
    const parts = match[2].split(' · ').map(part => { const hit = reverse.get(part); if (hit !== undefined) changed = true; return hit ?? part; });
    if (changed) return match[1] + parts.join(' · ') + match[3];
  }
  return value;
}
function desired(base) {
  return language === 'zh' ? translateValue(base) : base;
}

const textState = new WeakMap(); // Text -> { en, shown }
const attrState = new WeakMap(); // Element -> Map(attr -> { en, shown })

function skipped(element) {
  return !element || Boolean(element.closest?.(SKIP_SELECTOR));
}

function processText(node) {
  if (skipped(node.parentElement)) return;
  const rec = textState.get(node);
  const base = rec && node.data === rec.shown ? rec.en : englishOf(node.data);
  const target = desired(base);
  if (target !== base) textState.set(node, { en: base, shown: target }); else textState.delete(node);
  if (target !== node.data) node.data = target;
}

function processAttribute(element, name) {
  const value = element.getAttribute(name);
  // A textarea's own placeholder/title is UI text; only its value (child text) is user content.
  if (value === null || skipped(element.tagName === 'TEXTAREA' ? element.parentElement : element)) return;
  let states = attrState.get(element);
  const rec = states?.get(name);
  const base = rec && value === rec.shown ? rec.en : englishOf(value);
  const target = desired(base);
  if (target !== base) {
    if (!states) attrState.set(element, states = new Map());
    states.set(name, { en: base, shown: target });
  } else states?.delete(name);
  if (target !== value) element.setAttribute(name, target);
}

function processElement(element) {
  for (const name of LANGUAGE_ATTRIBUTES) if (element.hasAttribute(name)) processAttribute(element, name);
}

/** Translate (or restore English for) every text node and supported attribute below `root`. */
export function applyStaticTranslations(root = document) {
  if (!root) return;
  if (root.nodeType === Node.TEXT_NODE) { processText(root); return; }
  if (root.nodeType === Node.ELEMENT_NODE) {
    if (skipped(root.tagName === 'TEXTAREA' ? root.parentElement : root)) return;
    processElement(root);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName !== 'TEXTAREA' && node.matches(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) processText(node); else processElement(node);
  }
}

let observer = null;
function observe() {
  if (observer || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
  observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'childList') record.addedNodes.forEach(node => { if (node.isConnected) applyStaticTranslations(node); });
      else if (record.type === 'characterData') { if (record.target.isConnected) processText(record.target); }
      else if (record.type === 'attributes' && record.target.isConnected) processAttribute(record.target, record.attributeName);
    }
    // Drop the records caused by our own writes so the observer cannot loop.
    observer.takeRecords();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...LANGUAGE_ATTRIBUTES] });
}

function reflectLanguage() {
  if (typeof document !== 'undefined') document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
}

/** Register a callback fired after the language changed (used to re-render JS-built UI). */
export function onLanguageChange(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * Switch language. Saves to localStorage immediately, updates the DOM, notifies listeners and
 * (unless `sync: false`) pushes the choice to the backend; backend failures are ignored.
 */
export function setLanguage(value, { sync = true, persist = true } = {}) {
  const next = normalizeLanguage(value);
  if (!next) return language;
  const changed = next !== language;
  language = next;
  if (persist) { try { localStorage.setItem(LANGUAGE_KEY, next); } catch { /* storage unavailable: the choice lasts for this page only */ } }
  reflectLanguage();
  if (changed) {
    applyStaticTranslations(document);
    for (const callback of [...listeners]) { try { callback(next); } catch (error) { console.warn('Language listener failed', error); } }
  }
  if (sync && syncHooks?.put) {
    try { Promise.resolve(syncHooks.put(next)).catch(() => {}); } catch { /* backend sync is best effort */ }
  }
  return language;
}

/**
 * Connect the backend copy of the setting. `hooks.get()` resolves to { language } and `hooks.put(language)` stores it.
 * A choice saved in this browser wins and is pushed to the backend when they differ; with nothing saved locally
 * the backend value is adopted (without being written to localStorage). Failures are ignored.
 */
export async function syncLanguageWithBackend(hooks) {
  syncHooks = hooks;
  try {
    const remote = normalizeLanguage((await hooks.get())?.language);
    const saved = readSaved();
    if (saved) {
      if (remote !== saved) await hooks.put(saved);
    } else if (remote && remote !== language) {
      setLanguage(remote, { sync: false, persist: false });
    }
  } catch { /* offline or older backend: localStorage remains the source */ }
}

function patchDialogs() {
  if (typeof window === 'undefined') return;
  for (const name of ['alert', 'confirm', 'prompt']) {
    const original = window[name];
    if (typeof original !== 'function' || original.__i18n) continue;
    const wrapped = (message, ...rest) => original.call(window, typeof message === 'string' ? t(message) : message, ...rest);
    wrapped.__i18n = true;
    window[name] = wrapped;
  }
}

if (typeof document !== 'undefined') {
  reflectLanguage();
  patchDialogs();
  const start = () => { applyStaticTranslations(document); observe(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
  window.addEventListener?.('storage', event => {
    if (event.key === LANGUAGE_KEY) setLanguage(event.newValue || browserLanguage(), { sync: false, persist: false });
  });
}
