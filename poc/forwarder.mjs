// forwarder.mjs — DSH 公网(Tailscale)安全接入转发器（零依赖）
//
// 背景：DSH web 目前只能绑定 127.0.0.1，且 /api 有 trust-fence（非 loopback Host 一律 403）。
// 本转发器监听 Tailscale 网卡地址，把 HTTP 与 WebSocket 转发到 127.0.0.1:3080，
// 并把 Host 头重写为 loopback，使 fence 放行；只绑 Tailscale IP，不暴露给局域网。
//
// 额外提供「文件桥」：
//   POST /files           {name, data(base64)}  → 存到 FILE_ROOT/shared-files/<name>，返回 {path}
//   GET  /files?path=…    读 FILE_ROOT 内的文件，返回 {name, data(base64)}
//
// 用法：
//   node forwarder.mjs                          # 默认监听 YOUR_TAILSCALE_IP:8787
//   LISTEN_HOST=YOUR_TAILSCALE_IP LISTEN_PORT=8787 FILE_ROOT=/path/to/workspace node forwarder.mjs
//
// 安全：仅绑定 LISTEN_HOST（Tailscale IP）；文件读写限制在 FILE_ROOT 范围内。

import { createServer, request as httpRequest } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LISTEN_HOST = process.env.LISTEN_HOST ?? 'YOUR_TAILSCALE_IP';
const LISTEN_PORT = Number(process.env.LISTEN_PORT ?? 8787);
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 3080;
const UPSTREAM_AUTHORITY = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
const FILE_ROOT = process.env.FILE_ROOT ?? (process.platform === 'win32' ? 'D:\\your-workspace' : '/home/user/workspace');
const INBOX_DIR = path.join(FILE_ROOT, 'shared-files');
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100MB

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

// 关键：把 Host 头重写为 loopback，并抹掉浏览器标记(Origin/Sec-Fetch-*)，
// 统一按"无标记客户端"处理，让 DSH 的 /api trust-fence 对手机浏览器和原生 App 都放行。
function rewriteHeaders(headers) {
  const out = { ...headers };
  out.host = UPSTREAM_AUTHORITY;
  delete out['x-forwarded-host'];
  delete out.origin;
  delete out.referer;
  delete out['sec-fetch-site'];
  delete out['sec-fetch-mode'];
  delete out['sec-fetch-dest'];
  delete out['sec-fetch-user'];
  return out;
}

// 文件名清洗：只保留 basename，拒绝路径穿越
function safeName(name) {
  const base = path.basename(String(name ?? 'file'));
  if (!base || base === '.' || base === '..') throw new Error('invalid filename');
  return base;
}

// 把请求的路径解析到 FILE_ROOT 内（绝对路径或相对路径均可），越界即拒绝
function resolveWithinRoot(requested) {
  const abs = path.isAbsolute(requested) ? path.normalize(requested) : path.resolve(FILE_ROOT, requested);
  const root = path.resolve(FILE_ROOT);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('path outside workspace');
  return abs;
}

// 文件桥路由；返回 true 表示已处理（含错误响应），false 表示交给 DSH 代理
async function handleFiles(req, res) {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/files') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return true; }
    try {
      const name = safeName(payload.name);
      if (typeof payload.data !== 'string') { res.writeHead(400); res.end('missing data'); return true; }
      const buf = Buffer.from(payload.data, 'base64');
      if (buf.length > MAX_FILE_BYTES) { res.writeHead(413); res.end('file too large'); return true; }
      await mkdir(INBOX_DIR, { recursive: true });
      const dest = path.join(INBOX_DIR, name);
      await writeFile(dest, buf);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: dest, name, bytes: buf.length }));
      log('UPLOAD', name, buf.length, 'bytes ->', dest);
    } catch (e) {
      res.writeHead(400); res.end(String(e?.message ?? e));
    }
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/files') {
    const p = url.searchParams.get('path');
    if (!p) { res.writeHead(400); res.end('missing ?path='); return true; }
    try {
      const abs = resolveWithinRoot(p);
      const buf = await readFile(abs);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: path.basename(abs), data: buf.toString('base64'), bytes: buf.length }));
      log('DOWNLOAD', p, '->', buf.length, 'bytes');
    } catch (e) {
      res.writeHead(404); res.end(String(e?.message ?? e));
    }
    return true;
  }
  return false;
}

const server = createServer(async (req, res) => {
  if (await handleFiles(req, res)) return;
  log(req.method, req.url, '<-', req.socket.remoteAddress);
  const proxy = httpRequest(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      path: req.url,
      method: req.method,
      headers: rewriteHeaders(req.headers),
    },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  proxy.on('error', () => { res.writeHead(502); res.end('bad gateway'); });
  req.pipe(proxy);
});

server.on('upgrade', (req, socket, head) => {
  log('UPGRADE', req.url, '<-', socket.remoteAddress);
  const proxy = httpRequest({
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    path: req.url,
    method: req.method,
    headers: rewriteHeaders(req.headers),
  });
  proxy.on('upgrade', (upRes, upSocket, upHead) => {
    const hdrs = Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${hdrs}\r\n\r\n`);
    if (upHead && upHead.length) upSocket.unshift(upHead);
    if (head && head.length) upSocket.write(head);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    socket.on('error', () => upSocket.destroy());
    upSocket.on('error', () => socket.destroy());
  });
  proxy.on('error', () => socket.destroy());
  proxy.end();
});

server.on('error', (e) => { console.error('forwarder error:', e.message); process.exit(1); });

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`listening on ${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM_AUTHORITY} (file root: ${FILE_ROOT})`);
});
