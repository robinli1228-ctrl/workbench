import path from 'node:path';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { ensurePrivateDirectory, readPrivateJson, writePrivateJson } from './private-json.mjs';

const derive = promisify(scrypt);
const lifetime = 15 * 24 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex');

function checkState(value) {
  if (!value || value.version !== 1 || !value.sessions || Array.isArray(value.sessions) || typeof value.sessions !== 'object') throw new Error('认证状态文件格式错误');
  if (value.password !== null && (!/^[a-f0-9]{32}$/.test(value.password?.salt) || !/^[a-f0-9]{128}$/.test(value.password?.hash))) throw new Error('密码校验状态损坏');
  for (const [id, entry] of Object.entries(value.sessions)) {
    if (!/^[a-f0-9]{64}$/.test(id) || !Number.isSafeInteger(entry?.expiresAt)) throw new Error('登录状态损坏');
  }
  return value;
}

/** 密码及登录状态在 Mac 单进程内串行更新，读取不反复落盘。 */
export async function createAuthStore({ stateDir, now = Date.now }) {
  await ensurePrivateDirectory(stateDir);
  const file = path.join(stateDir, 'auth.json');
  let state = checkState(await readPrivateJson(file) ?? { version: 1, password: null, sessions: {} });
  let queue = Promise.resolve(), pending = 0, attempts = [];
  const events = new EventEmitter();

  async function persist(next) {
    await writePrivateJson(file, next);
    state = next;
  }

  function serialize(action) {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  }

  return {
    events,
    configured: () => state.password !== null,
    /** 密码变更在持久化成功后撤销旧会话，不向调用方返回校验值。 */
    async setPassword(password) {
      if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 1024) throw new Error('密码长度须为 12 个字符以上，且不超过 1024 字节');
      return serialize(async () => {
        const salt = randomBytes(16).toString('hex');
        const hash = (await derive(password, salt, 64)).toString('hex');
        await persist({ version: 1, password: { salt, hash }, sessions: {} });
        events.emit('revoke', null);
      });
    },
    /** 校验有全局预算和并发上限，避免公网请求占满密码计算队列。 */
    async login(password) {
      attempts = attempts.filter(at => at > now() - 60000);
      if (attempts.length >= 20 || pending >= 4) {
        const error = new Error('登录尝试过于频繁，请稍后再试'); error.status = 429; throw error;
      }
      attempts.push(now()); pending++;
      try {
        return await serialize(async () => {
          if (!state.password || typeof password !== 'string' || Buffer.byteLength(password) > 1024) return null;
          const candidate = await derive(password, state.password.salt, 64);
          if (!timingSafeEqual(candidate, Buffer.from(state.password.hash, 'hex'))) return null;
          const token = randomBytes(32).toString('base64url'), expiresAt = now() + lifetime;
          const sessions = Object.fromEntries(Object.entries(state.sessions).filter(([, entry]) => entry.expiresAt > now()));
          if (Object.keys(sessions).length >= 100) {
            const error = new Error('有效登录过多，请先退出不用的设备'); error.status = 429; throw error;
          }
          sessions[digest(token)] = { expiresAt };
          await persist({ ...state, sessions });
          return { token, expiresAt };
        });
      } finally { pending--; }
    },
    /** 固定过期时间，只读验证不会滑动续期或产生磁盘写入。 */
    async verify(token) {
      await queue;
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const id = digest(token), entry = state.sessions[id];
      return entry && entry.expiresAt > now() ? { id, expiresAt: entry.expiresAt } : null;
    },
    /** 注销只处理当前凭证，通知网关关闭相关长连接。 */
    async logout(token) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
      return serialize(async () => {
        const id = digest(token);
        if (!state.sessions[id]) return;
        const sessions = { ...state.sessions }; delete sessions[id];
        await persist({ ...state, sessions });
        events.emit('revoke', id);
      });
    },
  };
}
