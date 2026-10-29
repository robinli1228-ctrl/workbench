/**
 * One thin progress bar across the top of the page while state, chat history or session lists load, whether or not cached
 * content is already on screen. It appears only after a short delay, so fast reads never flash, and stays a moment so a
 * burst of reads reads as one load.
 */
const SHOW_AFTER = 250, HIDE_AFTER = 200;
let pending = 0, showTimer = null, hideTimer = null, bar = null;

function element() {
  if (bar?.isConnected) return bar;
  bar = document.querySelector('#load-bar');
  if (!bar && typeof document !== 'undefined' && document.body) {
    bar = document.createElement('div');bar.id = 'load-bar';bar.setAttribute('aria-hidden', 'true');document.body.prepend(bar);
  }
  return bar;
}

function begin() {
  pending++;
  clearTimeout(hideTimer);hideTimer = null;
  if (pending === 1 && !showTimer && !element()?.classList.contains('is-active')) showTimer = setTimeout(() => { showTimer = null; if (pending) element()?.classList.add('is-active'); }, SHOW_AFTER);
}

function end() {
  pending = Math.max(0, pending - 1);
  if (pending) return;
  clearTimeout(showTimer);showTimer = null;
  hideTimer = setTimeout(() => { hideTimer = null; if (!pending) element()?.classList.remove('is-active'); }, HIDE_AFTER);
}

/** Show the bar for as long as the promise is pending; returns the same promise. */
export function trackLoading(promise) {
  if (typeof document === 'undefined') return promise;
  begin();
  return Promise.resolve(promise).finally(end);
}

/** Whether a tracked load is running (for tests and skeletons). */
export const loadingCount = () => pending;
