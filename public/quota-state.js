export function usableBucket(bucket) {
  return bucket && (bucket.remainingPercent != null || bucket.usedPercent != null);
}

export function remainingPercent(bucket) {
  if (bucket.remainingPercent != null) return Math.max(0, Math.min(100, Number(bucket.remainingPercent)));
  return Math.max(0, Math.min(100, 100 - Number(bucket.usedPercent)));
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

export function parseQuotaResetDate(raw, now = Date.now()) {
  const text = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const date = new Date(text);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  const match = text.match(/^([A-Za-z]{3})\s+(\d{1,2})(?:\s+at\s+|,\s*)(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)$/i);
  if (!match || MONTHS[match[1].toLowerCase()] === undefined || +match[3] < 1 || +match[3] > 12 || +(match[4] || 0) > 59) return null;
  const month = MONTHS[match[1].toLowerCase()] + 1, day = +match[2];
  const hour = +match[3] % 12 + (match[5].toLowerCase() === 'pm' ? 12 : 0), minute = +(match[4] || 0);
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {timeZone:match[6], year:'numeric', month:'numeric', day:'numeric', hour:'numeric', minute:'numeric', second:'numeric', hourCycle:'h23'});
    const parts = time => Object.fromEntries(formatter.formatToParts(time).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
    const year = parts(now).year, candidates = [];
    // Resolve the vendor's wall clock in its own zone, including DST; nearest year handles December/January.
    for (const y of [year - 1, year, year + 1]) {
      const wall = Date.UTC(y, month - 1, day, hour, minute); let time = wall;
      for (let i = 0; i < 3; i++) { const p = parts(time); time += wall - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second); }
      const p = parts(time);
      if (p.year === y && p.month === month && p.day === day && p.hour === hour && p.minute === minute) candidates.push(time);
    }
    candidates.sort((a,b) => Math.abs(a-now) - Math.abs(b-now));
    return candidates.length ? new Date(candidates[0]) : null;
  } catch { return null; }
}

/** Remaining >=50% green; 20-50% (50-80% used) orange; <20% (>80% used) red. On the last day of the weekly quota with >30% remaining, use a green smiley. */
export function quotaTone(pct, { weekly = false, resetsAt } = {}) {
  if (weekly && pct > 30) {
    const reset = parseQuotaResetDate(resetsAt);
    if (reset && reset.getTime() - Date.now() <= 86400000 && reset.getTime() >= Date.now() - 3600000) return 'smile';
  }
  if (pct >= 50) return 'ok';
  if (pct >= 20) return 'mid';
  return 'low';
}

function quotaFromRuntime(runtime) {
  const quota = runtime?.quota;
  if (!quota || typeof quota !== 'object') return null;
  if (!usableBucket(quota.fiveHour) && !usableBucket(quota.weekly) && quota.remainingPercent == null) return null;
  return quota;
}

/** Quota strictly belongs to the role's own CLI; for Agy, it is further chosen by the shared quota group the model belongs to. */
export function quotaForRole(roleRuntime, _worker, modelId = '') {
  const quota = roleRuntime?.quota;
  if (roleRuntime?.type === 'agy' && quota?.groups) {
    const key = /claude|gpt|oss/i.test(modelId) ? 'claudeGpt' : 'gemini';
    const group = quota.groups[key];
    return group ? { ...group, credits: quota.credits || null } : null;
  }
  return quotaFromRuntime(roleRuntime);
}

/** Summarize the saved role-specific snapshot only; never probe a CLI or infer a missing model group. */
export function roleTokenBalance(role, worker) {
  const runtime = worker?.id === role?.nodeId ? worker.runtimes?.find(item => item.type === role.runtime) : null;
  if (!runtime || runtime.quotaStatus !== 'ok' || runtime.quotaStale || !role.model) return '未知';
  if (runtime.type === 'agy' && (!runtime.quota?.groups || !/claude|gpt|oss|gemini/i.test(role.model))) return '未知';
  const quota = quotaForRole(runtime, worker, role.model);
  if (!quota || quota.stale || quota.quotaStale) return '未知';
  const tones = [['fiveHour', false], ['weekly', true]].flatMap(([key, weekly]) => {
    const bucket = quota[key], value = bucket?.remainingPercent ?? bucket?.usedPercent;
    if (bucket?.stale || bucket?.quotaStale || !['number','string'].includes(typeof value) || typeof value === 'string' && !value.trim() || !Number.isFinite(Number(value))) return [];
    return [quotaTone(Math.round(remainingPercent(bucket)), { weekly, resetsAt: bucket.resetsAt })];
  });
  return tones.includes('low') ? '紧张' : tones.includes('mid') ? '标准' : tones.length ? '充足' : '未知';
}
