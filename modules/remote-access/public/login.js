const form = document.querySelector('#login-form');
const signedIn = document.querySelector('#signed-in');
const status = document.querySelector('#status');
const password = document.querySelector('#password');
const loginButton = document.querySelector('#login-button');

form.addEventListener('submit', async event => {
  event.preventDefault(); loginButton.disabled = true; status.textContent = '';
  try {
    const response = await fetch('/_access/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: password.value }), cache: 'no-store' });
    const result = await response.json(); password.value = '';
    if (!response.ok) throw new Error(result.error || '登录失败');
    location.replace('/');
  } catch (error) { status.textContent = error.message || '连接失败，请稍后再试'; }
  finally { loginButton.disabled = false; }
});

document.querySelector('#logout-button').addEventListener('click', async () => {
  try {
    const response = await fetch('/_access/logout', { method: 'POST', cache: 'no-store' });
    if (!response.ok && response.status !== 401) throw new Error('退出失败，请重试');
    location.replace('/_access/login');
  } catch (error) { status.textContent = error.message; }
});

fetch('/_access/session', { cache: 'no-store' }).then(async response => {
  if (response.ok && (await response.json()).loggedIn) { form.hidden = true; signedIn.hidden = false; }
}).catch(() => {});
