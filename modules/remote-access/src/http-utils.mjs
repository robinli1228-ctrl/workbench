/** 仅认证和管理 JSON 请求使用小预算；文件上传通过流式代理，不走此函数。 */
export function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0, done = false;
    const chunks = [];
    const fail = (message, status) => { if (!done) { done = true; chunks.length = 0; reject(Object.assign(new Error(message), { status })); } };
    req.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > limit) { fail('请求内容过大', 413); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        done = true; resolve(value);
      } catch { fail('请求格式错误', 400); }
    });
    req.on('error', () => fail('请求已中断', 400));
    req.on('aborted', () => fail('请求已中断', 400));
  });
}

/** 错误仅返回明确给用户的内容，不输出底层路径、密钥或请求头。 */
export function json(res, status, value, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(JSON.stringify(value));
}
