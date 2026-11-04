const REASONS = new Set(['node_query_timeout', 'media_timeout', 'media_idle', 'media_slow']);
const COOLDOWN = 10 * 60_000;
const RETRY_DELAY = 60_000;
const MIN_RATE = 200_000;

function label(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
}

/** Validate direct and loopback SOCKS routes before transport IO is allowed. */
export function validateTransportConfig(config) {
  if (!config || !Array.isArray(config.devices)) {
    throw new Error('invalid_transport_config');
  }
  const ids = new Set();
  const nodes = new Set();
  const unique = (set, value) => {
    if (set.has(value)) throw new Error('duplicate_transport_config');
    set.add(value);
  };
  for (const device of config.devices) {
    if (!device || !label(device.deviceId) || !label(device.nodeId)
      || device.defaultNode !== 'DIRECT' || !Array.isArray(device.candidates)
      || device.candidates.length < 1 || device.candidates.length > 8) throw new Error('invalid_transport_device');
    unique(ids, device.deviceId);
    unique(nodes, device.nodeId);
    const names = new Set();
    const ports = new Set();
    for (const candidate of device.candidates) {
      if (!candidate || !label(candidate.name)) throw new Error('invalid_transport_candidate');
      unique(names, candidate.name);
      if (candidate.name === 'DIRECT') {
        if (candidate.probePort !== null) throw new Error('invalid_transport_direct');
      } else {
        if (!Number.isInteger(candidate.probePort) || candidate.probePort < 1 || candidate.probePort > 65535) throw new Error('invalid_transport_port');
        unique(ports, candidate.probePort);
      }
    }
    if (!device.candidates.some(candidate => candidate.name === device.defaultNode)) throw new Error('missing_transport_default');
  }
  return config;
}

/** On-demand only. The reconnect owner must run before under its formal idle fence
 * and rollback on reconnect failure; this module never bypasses that fence. */
export class DeviceTransport {
  constructor({ config, enabled = true, clock = Date.now, probe, select, reconnect, change, persist } = {}) {
    this.clock = clock;
    this.probe = probe;
    this.select = select;
    this.reconnect = reconnect;
    this.change = change;
    this.persist = persist;
    this.devices = new Map();
    this.nodes = new Map();
    if (!config) return;
    validateTransportConfig(config);
    if (typeof enabled !== 'boolean') throw new Error('invalid_transport_enabled');
    if (![probe, select, reconnect].every(fn => typeof fn === 'function')) throw new Error('missing_transport_io');
    for (const device of structuredClone(config.devices)) {
      const state = { device, current: device.defaultNode, pending: null, status: enabled ? 'idle' : 'disabled',
        lastProbeAt: null, lastRetryAt: null, error: null, flight: null, revision: 0, enabled };
      this.devices.set(device.deviceId, state);
      this.nodes.set(device.nodeId, state);
    }
  }

  /** SOCKS is always loopback; configuration supplies only a validated port. */
  sshOptions(deviceId, routeName) {
    const state = this.devices.get(deviceId);
    if (!state) return [];
    const candidate = state.device.candidates.find(candidate => candidate.name === (routeName ?? state.current));
    if (!candidate) throw new Error('unknown_transport_candidate');
    return candidate.name === 'DIRECT' ? [] : ['-o', `ProxyCommand=/usr/bin/nc -X 5 -x 127.0.0.1:${candidate.probePort} %h %p`];
  }

  /** Configuration edits must not race a probe or fenced reconnect. */
  busy(deviceId) {
    return Boolean(this.devices.get(deviceId)?.flight);
  }

  /** Disabling stops failover decisions while retaining the actual tunnel route. */
  setEnabled(deviceId, enabled) {
    const state = this.devices.get(deviceId);
    if (!state) return this.view(deviceId);
    if (typeof enabled !== 'boolean') throw new Error('invalid_transport_enabled');
    if (state.flight) throw Object.assign(new Error('transport_busy'), { code: 'transport_busy' });
    state.enabled = enabled;
    if (!enabled) {
      state.pending = null;
      state.status = 'disabled';
    } else state.status = 'idle';
    return this.notify(state);
  }

  /** Record the route actually used by a Home-owned tunnel, including DIRECT. */
  applied(deviceId, name) {
    const state = this.devices.get(deviceId);
    if (!state) return this.view(deviceId);
    if (!state.device.candidates.some(candidate => candidate.name === name)) throw new Error('unknown_transport_candidate');
    state.revision++;
    state.current = name;
    state.pending = null;
    state.status = state.enabled ? 'idle' : 'disabled';
    state.error = null;
    return this.notify(state);
  }

  notify(state) {
    const view = this.view(state.device.deviceId);
    for (const callback of [this.change, this.persist]) {
      if (typeof callback === 'function') {
        try { Promise.resolve(callback({ ...view })).catch(() => {}); } catch { /* private observer failure */ }
      }
    }
    return view;
  }

  /** Return a copy, never mutable configuration or raw transport errors. */
  view(deviceId) {
    const state = this.devices.get(deviceId);
    if (!state) return { deviceId, status: 'disabled', enabled: false, busy: false };
    return { deviceId, nodeId: state.device.nodeId, current: state.current, pending: state.pending,
      status: state.status, lastProbeAt: state.lastProbeAt, lastRetryAt: state.lastRetryAt, error: state.error,
      enabled: state.enabled, busy: Boolean(state.flight) };
  }

  /** Only known transport stalls can initiate a bounded comparison. */
  async stalled(nodeId, reason) {
    const state = this.nodes.get(nodeId);
    if (!state) return { status: 'disabled' };
    if (!state.enabled) return this.view(state.device.deviceId);
    if (!REASONS.has(reason)) return { ...this.view(state.device.deviceId), status: 'ignored' };
    if (state.flight) return state.flight;
    if (state.pending) return this.retryPending(nodeId);
    if (state.lastProbeAt !== null && this.clock() - state.lastProbeAt < COOLDOWN) {
      return { ...this.view(state.device.deviceId), status: 'cooldown' };
    }
    return this.run(state, async () => {
      const revision = state.revision;
      state.lastProbeAt = this.clock();
      state.status = 'probing';
      state.error = null;
      const current = state.device.candidates.find(candidate => candidate.name === state.current);
      const baseline = await this.rate(state, current);
      if (state.revision !== revision) return;
      if (baseline >= MIN_RATE) return this.unchanged(state);
      let winner = null;
      let best = 0;
      for (const candidate of state.device.candidates) {
        if (candidate === current) continue;
        const rate = await this.rate(state, candidate);
        if (state.revision !== revision) return;
        if (rate >= MIN_RATE && rate >= baseline * 2 && rate > best) {
          winner = candidate;
          best = rate;
        }
      }
      if (!winner) return this.unchanged(state);
      const repeatedCurrent = await this.rate(state, current);
      const repeatedWinner = await this.rate(state, winner);
      if (state.revision !== revision) return;
      if (repeatedWinner < MIN_RATE || repeatedWinner < repeatedCurrent * 2) return this.unchanged(state);
      state.pending = winner.name;
      await this.apply(state);
    });
  }

  /** Existing Home events may retry a deferred switch, without another probe. */
  async retryPending(nodeId) {
    const state = this.nodes.get(nodeId);
    if (!state) return { status: 'disabled' };
    if (!state.enabled) return this.view(state.device.deviceId);
    if (state.flight) return state.flight;
    if (!state.pending || (state.lastRetryAt !== null && this.clock() - state.lastRetryAt < RETRY_DELAY)) {
      return this.view(state.device.deviceId);
    }
    return this.run(state, () => this.apply(state));
  }

  async run(state, operation) {
    // Defer execution until flight is assigned, including synchronously injected IO.
    state.flight = Promise.resolve().then(operation).catch(() => {
      state.status = 'error';
      state.error = 'transport_error';
    }).finally(() => { state.flight = null; }).then(() => this.notify(state));
    return state.flight;
  }

  async rate(state, candidate) {
    try {
      const sample = await this.probe(state.device.deviceId, candidate);
      return sample?.complete === true && Number.isFinite(sample.bytes) && sample.bytes >= 0
        && Number.isFinite(sample.seconds) && sample.seconds > 0 ? sample.bytes / sample.seconds : 0;
    } catch { return 0; }
  }

  unchanged(state) {
    state.status = 'unchanged';
  }

  async apply(state) {
    state.lastRetryAt = this.clock();
    const previous = state.current;
    const target = state.pending;
    const revision = state.revision;
    let selected = false;
    let restored = false;
    const rollback = async () => {
      if (selected && !restored) {
        await this.select(state.device.deviceId, previous);
        restored = true;
      }
    };
    try {
      const result = await this.reconnect(state.device.deviceId, {
        before: async () => {
          // Mark first: the route callback may update state before rejecting.
          selected = true;
          await this.select(state.device.deviceId, target);
        },
        rollback,
      });
      if (result?.busy || result?.verified === false || !selected || restored) {
        const error = new Error('transport_busy');
        error.code = 'transport_busy';
        throw error;
      }
      // Tunnel creation may have reported a direct fallback instead of target.
      if (state.revision !== revision) return;
      state.current = target;
      state.pending = null;
      state.status = 'switched';
      state.error = null;
    } catch (error) {
      try { await rollback(); } catch {
        state.pending = null;
        state.status = 'error';
        state.error = 'transport_rollback_failed';
        return;
      }
      if (error?.code === 'transport_busy') {
        state.status = 'pending';
        state.error = null;
      } else {
        state.pending = null;
        state.status = 'error';
        state.error = 'transport_error';
      }
    }
  }
}
