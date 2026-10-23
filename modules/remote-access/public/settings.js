const notice = document.querySelector('#notice');
const fragment = new URLSearchParams(location.hash.slice(1));
let key = fragment.get('key');
if (key) { sessionStorage.setItem('relay-admin', key); history.replaceState(null, '', location.pathname); }
else key = sessionStorage.getItem('relay-admin');
let config;
const configDirty = new Set();
document.querySelector('#config').addEventListener('input', event => { if (event.target.name) configDirty.add(event.target.name); });

async function api(route, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(route, { method, cache: 'no-store', headers: { authorization: `Bearer ${key || ''}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败');
  return result;
}

async function refresh() {
  const result = await api('/api/status');
  const names = { stopped: '远程访问已停用', connecting: '正在建立连接', connected: 'SSH 转发已连接', retrying: '等待自动重连', error: '连接配置需要检查' };
  document.querySelector('#state').textContent = names[result.tunnel.phase] || result.tunnel.phase;
  document.querySelector('#detail').textContent = result.tunnel.error || (result.passwordConfigured ? '访问密码已设置。HTTPS 页面须实际打开验证。' : '请先在本机设置访问密码。');
}

async function action(button, callback) {
  button.disabled = true; notice.textContent = '';
  try { await callback(); await refresh(); }
  catch (error) { notice.textContent = error.message; }
  finally { button.disabled = false; }
}

document.querySelector('#config').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  action(form.querySelector('button'), async () => {
    if (!config) throw new Error('配置尚未加载');
    const values = Object.fromEntries(new FormData(form));
    const next = { ...config, publicOrigin: values.publicOrigin, homeUrl: values.homeUrl, tokenFile: values.tokenFile,
      ssh: { host: values.host, port: Number(values.port), user: values.user, keyFile: values.keyFile, remotePort: Number(values.remotePort) } };
    const patch = {}, ssh = {};
    const submitted = [...configDirty];
    for (const name of submitted) {
      if (['publicOrigin','homeUrl','tokenFile'].includes(name)) patch[name] = next[name];
      else if (Object.hasOwn(next.ssh, name)) ssh[name] = next.ssh[name];
    }
    if (Object.keys(ssh).length) patch.ssh = ssh;
    const result = await api('/api/config-patch', patch);
    for (const name of submitted) if (form.elements[name].value === values[name]) configDirty.delete(name);
    config = await api('/api/config'); notice.textContent = result.message;
    for (const [name, value] of Object.entries({ ...config, ...config.ssh })) {
      const input = form.elements.namedItem(name); if (input && !configDirty.has(name)) input.value = value;
    }
    document.querySelector('#visit').href = config.publicOrigin;
  });
});

document.querySelector('#password').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget, input = form.elements.password;
  action(form.querySelector('button'), async () => {
    try { const result = await api('/api/password', { password: input.value }); notice.textContent = result.message; }
    finally { input.value = ''; }
  });
});

for (const name of ['test', 'start', 'stop']) document.querySelector(`#${name}`).addEventListener('click', event => {
  action(event.currentTarget, async () => { const result = await api(`/api/${name}`, undefined, 'POST'); notice.textContent = result.message || '操作已提交'; });
});
document.querySelector('#refresh').addEventListener('click', event => action(event.currentTarget, async () => {}));

api('/api/config').then(async value => {
  config = value;
  for (const [name, field] of Object.entries({ ...config, ...config.ssh })) {
    const input = document.querySelector('#config').elements.namedItem(name); if (input) input.value = field;
  }
  const visit = document.querySelector('#visit'); visit.href = config.publicOrigin; visit.hidden = false;
  await refresh();
}).catch(error => { notice.textContent = error.message; });
