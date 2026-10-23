/** 只向设置页暴露已知的安全提示，不透传文件路径等底层异常。 */
export class LifecycleError extends Error {}

/** 配置、启停和临时测试共用一条队列，避免多个设置页交叉操作同一隧道。 */
export function createLifecycle({ tunnel, persistEnabled }) {
  let pending = Promise.resolve(), closing = false, shutdown;
  function enqueue(operation) {
    if (closing) return Promise.reject(new LifecycleError('访问服务正在关闭'));
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }
  async function stop() {
    // 即使磁盘已满也必须先关闭公网连接；保存失败明确报错，不冒充停用状态已持久化。
    await tunnel.stop();
    try { await persistEnabled(false); }
    catch { throw new LifecycleError('连接已停用，但无法保存重启状态；请修复磁盘或权限后重新停用'); }
    return tunnel.status();
  }
  return {
    status: tunnel.status,
    start: () => enqueue(async () => {
      const result = await tunnel.start();
      try { await persistEnabled(true); }
      catch {
        await tunnel.stop();
        throw new LifecycleError('无法保存启用状态，连接已回滚停用');
      }
      return result;
    }),
    stop: () => enqueue(stop),
    test: () => enqueue(() => tunnel.test()),
    configure: save => enqueue(async () => { await stop(); await save(); }),
    restore: () => enqueue(() => tunnel.start()),
    shutdown: () => {
      closing = true;
      // 正常退出保留用户的开关意图；先等已接收操作收尾，再释放自有进程。
      return shutdown ||= pending.then(() => tunnel.stop());
    },
  };
}
