export const TOKEN_KEY = 'agent-workbench.api-token';

/** Reuse this browser's token across launches; migrate the former session-only value. */
export function readApiToken() {
  let token = '';
  try {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved !== null) return saved;
  } catch { /* Try the legacy session if persistent storage cannot be read. */ }
  try {
    token = sessionStorage.getItem(TOKEN_KEY) || '';
    if (token) saveApiToken(token);
  } catch { /* An existing session still works when persistent storage is unavailable. */ }
  return token;
}

/** Call only after Home accepts the candidate; a failed write must not report success. */
export function saveApiToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    throw new Error('Unable to save the token in this browser. Allow site storage and try again.');
  }
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* The persistent value is authoritative. */ }
}
