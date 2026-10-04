/** Saving a role only reuses the target Runtime's recent report, to avoid re-probing every CLI. */
export function runtimeReportFresh(worker, runtimeType, now = Date.now(), maxAge = 600000) {
  if (!worker?.capabilities?.runtimeDiscovery || typeof runtimeType !== 'string') return false;
  const runtime = worker.runtimes?.find(item => item?.type === runtimeType);
  const checkedAt = Date.parse(runtime?.checkedAt || '');
  return Number.isFinite(checkedAt) && now - checkedAt >= 0 && now - checkedAt < maxAge;
}
