import { t } from './i18n.js';

/** "12s", "3m 12s", "1h 05m": compact enough to sit after a status label. */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
  if (h) return t('{h}h {m}m', { h, m: String(m).padStart(2, '0') });
  if (m) return t('{m}m {s}s', { m, s: String(s).padStart(2, '0') });
  return t('{s}s', { s });
}

/** A span that the shared ticker keeps current; it only exists while a run is actually executing. */
export function elapsedEl(create, startedAt, className = 'elapsed-time') {
  const start = Date.parse(startedAt || '');
  if (!Number.isFinite(start)) return null;
  const el = create('span', className, formatElapsed(Date.now() - start));
  el.dataset.startedAt = String(start);
  el.title = t('Running since {time}', { time: new Date(start).toLocaleTimeString() });
  return el;
}

let timer = 0;
/** One interval for the whole page; it idles while no timer is visible or the tab is hidden. */
export function startElapsedTicker() {
  if (timer) return;
  timer = setInterval(() => {
    if (document.hidden) return;
    for (const el of document.querySelectorAll('[data-started-at]')) el.textContent = formatElapsed(Date.now() - Number(el.dataset.startedAt));
  }, 1000);
}
