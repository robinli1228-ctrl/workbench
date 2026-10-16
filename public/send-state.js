/**
 * Composer send lifecycle shared by the group chat and the native takeover. A draft keeps its frozen payload (with
 * its client message/turn id) in `pending` and what is known about it in `sendState`:
 * 'sending' (request in flight), 'checking' (outcome unknown), 'offline' (Home unreachable while checking) or
 * 'failed' (Home reachable and the id is not stored). Only 'failed' re-enables Send, and a retry reuses the same id.
 */
export const SEND_LABELS = Object.freeze({ sending: 'Sending…', checking: 'Checking…', offline: 'Waiting for network…', failed: 'Retry send' });

/** Lost connections, timeouts and server errors leave the outcome unknown; a 4xx rejection stored nothing. */
export const uncertainSend = error => Boolean(error?.isNetworkError || !error?.status || error.status >= 500 || error.status === 408);

/** Older drafts restored without a state, or a restored 'sending' with no request in flight, are treated as unknown. */
export function sendStateOf(draft, inFlight = false) {
  if (!draft?.pending) return null;
  if (inFlight) return 'sending';
  return ['failed', 'offline'].includes(draft.sendState) ? draft.sendState : 'checking';
}

/** Send is usable only with no pending payload or after a confirmed absence. */
export const sendLocked = state => Boolean(state && state !== 'failed');
