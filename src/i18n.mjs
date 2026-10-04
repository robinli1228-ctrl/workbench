import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import en from './locales/en.mjs';
import zh from './locales/zh.mjs';

/**
 * Backend language support.
 *
 * - The language is resolved at CALL time, never at import time: `tr()` / `L()` return text for the
 *   language that is current when they run. Modules must therefore not cache translated text in
 *   top-level constants (use functions instead).
 * - Resolution order: per-run override (`runWithLanguage`) > language set at runtime / persisted
 *   in `<data dir>/language.json` > `WB_LANGUAGE` environment variable > 'en'.
 * - Chinese text lives only in `src/locales/zh.mjs`. Elsewhere it may appear only as \uXXXX escapes.
 */
export const LANGUAGES = Object.freeze(['en', 'zh']);
export const DEFAULT_LANGUAGE = 'en';
const CATALOGS = Object.freeze({ en, zh });
const scope = new AsyncLocalStorage();
const store = { file: null, language: null };

/** Accepts 'en', 'zh', 'zh-CN', 'zh_Hans', 'EN-us', ...; returns 'en' | 'zh' | null. */
export function normalizeLanguage(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'en' || /^en[-_]/.test(v)) return 'en';
  if (v === 'zh' || /^zh[-_]/.test(v)) return 'zh';
  return null;
}

/** Initial default: WB_LANGUAGE when valid, otherwise English. */
export function envLanguage() {
  return normalizeLanguage(process.env.WB_LANGUAGE) || DEFAULT_LANGUAGE;
}

/** Points persistence at `<dir>/language.json` and loads a previously saved choice (Home calls this once at startup). */
export function initLanguage(dir) {
  store.file = join(dir, 'language.json');
  try {
    const saved = normalizeLanguage(JSON.parse(readFileSync(store.file, 'utf8'))?.language);
    if (saved) store.language = saved;
  } catch { /* no saved choice yet */ }
  return getLanguage();
}

export function getLanguage() {
  return scope.getStore() || store.language || envLanguage();
}

/** In-memory only (no persistence); Workers use this when Home announces its language. */
export function applyLanguage(lang) {
  const next = normalizeLanguage(lang);
  if (!next) throw invalid(lang);
  store.language = next;
  return next;
}

/** Validates ('en' | 'zh' exactly), applies and (when a data dir is configured) persists the language. Throws an error with code INVALID_LANGUAGE otherwise. */
export function setLanguage(lang) {
  const next = typeof lang === 'string' ? LANGUAGES.find(l => l === lang.trim().toLowerCase()) : null;
  if (!next) throw invalid(lang);
  if (store.file) {
    mkdirSync(join(store.file, '..'), { recursive: true, mode: 0o700 });
    const tmp = `${store.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ language: next }) + '\n', { mode: 0o600 });
    renameSync(tmp, store.file);
  }
  store.language = next;
  return next;
}

function invalid(lang) {
  const e = new Error(tr('i18n.invalidLanguage', { languages: LANGUAGES.join(', ') }));
  e.code = 'INVALID_LANGUAGE';
  e.status = 400;
  return e;
}

/** Runs `fn` (and everything it awaits) with a fixed language, e.g. the language carried by a run payload. */
export function runWithLanguage(lang, fn) {
  const l = normalizeLanguage(lang);
  return l ? scope.run(l, fn) : fn();
}

function fill(text, params) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name) => Object.hasOwn(params, name) ? String(params[name] ?? '') : m);
}

/** Text for `key` in the current language (English fallback, then the key itself), with {name} parameters filled in. */
export function tr(key, params) {
  return trIn(getLanguage(), key, params);
}

export function trIn(lang, key, params) {
  const text = CATALOGS[lang]?.[key] ?? en[key] ?? key;
  return fill(text, params);
}

/** Every language variant of a message (raw, unfilled). Used to recognise stored text regardless of the language it was saved in. */
export function trAll(key) {
  return LANGUAGES.map(l => CATALOGS[l]?.[key]).filter(v => typeof v === 'string');
}

/** True when `text` equals the message `key` in any language. */
export function isMessage(text, key) {
  return typeof text === 'string' && trAll(key).includes(text);
}

/** Inline bilingual text: L({ en: 'Hello', zh: '\u4f60\u597d' }). Chinese must be \u-escaped outside src/locales. */
export function L(texts) {
  return texts?.[getLanguage()] ?? texts?.en ?? '';
}

export const catalogs = CATALOGS;
