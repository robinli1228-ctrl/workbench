/** The node kind is reported explicitly by the deployment config; older Workers fall back to a platform-based default for compatibility. */
export function resolveNodeKind(value, systemPlatform) {
  if (value === 'local' || value === 'cloud') return value;
  return systemPlatform === 'linux' ? 'cloud' : 'local';
}
