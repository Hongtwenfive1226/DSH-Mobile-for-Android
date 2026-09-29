// forwarder.mjs — DSH 接入转发器（Tailscale 安全接入 + 鉴权 + 文件桥）
//
// 背景（DSH 0.2.0-rc.1 起的变化）：
//   1. DSH 现在是 Electron 桌面版，Web GUI/API 监听 127.0.0.1:<端口>（当前 19387），
//      不再是 `dsh web` 的 3080。
//   2. /api 的每个方法与 WebSocket 都要「浏览器会话 cookie」，缺失即 401；
//      只有 `GET /?token=…` 能换取 cookie，而那个令牌是进程内随机值、外部拿不到。
//      → 本转发器改用本机凭据里的签名密钥**自己签发** cookie（见 dsh-session.mjs），
//        对手机侧完全透明：手机仍然只访问 http://<Tailscale IP>:8787。
//   3. 请求信任栅栏要求 Host 是 loopback 或落在 trustedHosts，因此这里把 Host
//      重写为上游 authority（loopback），同时它也正好匹配 cookie 的 audience。
//
// 文件桥：
//   POST /files           {name, data(base64)}  → 存到 FILE_ROOT/shared-files/<name>，返回 {path}
//   GET  /files?path=…    读 FILE_ROOT 内的文件，返回 {name, data(base64)}
//   GET  /healthz         返回上游状态（端口、鉴权是否就绪）
//
// 用法：
//   node forwarder.mjs
//   LISTEN_HOST=100.103.120.7 LISTEN_PORT=8787 DSH_WEB_PORT=19387 FILE_ROOT=D:\AutoDS node forwarder.mjs

import { createServer, request as httpRequest } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mintCookie, readBrowserSecret, candidatePorts } from './dsh-session.mjs';

const LISTEN_HOST = process.env.LISTEN_HOST ?? '100.103.120.7';
const LISTEN_PORT = Number(process.env.LISTEN_PORT ?? 8787);
const UPSTREAM_HOST = '127.0.0.1';
const FILE_ROOT = process.env.FILE_ROOT ?? 'D:\\AutoDS';
const INBOX_DIR = path.join(FILE_ROOT, 'shared-files');
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100MB

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

// ---------------------------------------------------------------- 上游与鉴权
let upstreamPort = Number(process.env.DSH_WEB_PORT ?? 0) || undefined;
let authority = upstreamPort ? `${UPSTREAM_HOST}:${upstreamPort}` : undefined;
let cookieHeader; // 当前可用的会话 cookie

function refreshCookie() {
  if (!authority) throw new Error('upstream authority unknown');
  cookieHeader = mintCookie(authority).header;
  return cookieHeader;
}

/** 探测上游端口：候选端口上能通过鉴权拿到 200 的就算命中 */
async function discoverUpstream() {
  const ports = upstreamPort ? [upstreamPort] : candidatePorts();
  const secret = readBrowserSecret(); // 先确认凭据可用，否则直接报错退出
  for (const port of ports) {
    const auth = `${UPSTREAM_HOST}:${port}`;
    const cookie = mintCookie(auth, { secret }).header;
    const ok = await probe(auth, cookie);
    if (ok) {
      upstreamPort = port;
      authority = auth;
      cookieHeader = cookie;
      return auth;
    }
  }
  return undefined;
}

function probe(auth, cookie) {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'forwarder-probe', method: 'session/list', payload: { args: { _request: {} } } });
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: UPSTREAM_HOST, port: Number(auth.split(':')[1]), method: 'POST', path: '/api/session/list', headers: { host: auth, cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
    req.end(body);
  });
}

/** 统一的请求头：抹掉浏览器标记、Host 固定为上游 authority，并带上会话 cookie */
function upstreamHeaders(headers, { withCookie = true } = {}) {
  const out = { ...headers };
  out.host = authority;
  delete out['x-forwarded-host'];
  delete out.origin;
  delete out.referer;
  delete out['sec-fetch-site'];
  delete out['sec-fetch-mode'];
  delete out['sec-fetch-dest'];
  delete out['sec-fetch-user'];
  delete out['content-length']; // 让 node 重新计算
  if (withCookie && cookieHeader) out.cookie = cookieHeader;
  return out;
}

// ------------------------------------------------------------------ 文件桥
function safeName(name) {
  const base = path.basename(String(name ?? 'file'));
  if (!base || base === '.' || base === '..') throw new Error('invalid filename');
  return base;
}

function resolveWithinRoot(requested) {
  const abs = path.isAbsolute(requested) ? path.normalize(requested) : path.resolve(FILE_ROOT, requested);
  const root = path.resolve(FILE_ROOT);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('path outside workspace');
  return abs;
}

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
  if (req.method === 'GET' && url.pathname === '/healthz') {
    const body = JSON.stringify({ ok: Boolean(authority && cookieHeader), upstream: authority ?? null, fileRoot: FILE_ROOT });
    res.writeHead(authority && cookieHeader ? 200 : 503, { 'content-type': 'application/json' });
    res.end(body);
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ 代理
async function ensureUpstream() {
  if (authority && cookieHeader) return true;
  const found = await discoverUpstream();
  if (found) log(`upstream ready: ${found}（已签发会话 cookie）`);
  else log('upstream NOT found（等 DSH 起来后自动重试）');
  return Boolean(found);
}

const server = createServer(async (req, res) => {
  if (await handleFiles(req, res)) return;
  if (!(await ensureUpstream())) { res.writeHead(503); res.end('dsh upstream not available'); return; }
  log(req.method, req.url, '<-', req.socket.remoteAddress);

  const pipe = () => {
    const proxy = httpRequest(
      { host: UPSTREAM_HOST, port: upstreamPort, path: req.url, method: req.method, headers: upstreamHeaders(req.headers) },
      (upRes) => {
        // cookie 过期/密钥轮换：重新签发一次再重试
        if (upRes.statusCode === 401) {
          upRes.resume();
          log('401 from upstream — re-minting cookie and retrying');
          try { refreshCookie(); } catch (e) { log('re-mint failed:', e.message); }
          res.writeHead(401, { 'content-type': 'text/plain' });
          res.end('dsh authentication failed');
          return;
        }
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    proxy.on('error', () => { res.writeHead(502); res.end('bad gateway'); });
    req.pipe(proxy);
  };
  pipe();
});

server.on('upgrade', async (req, socket, head) => {
  if (!(await ensureUpstream())) { socket.destroy(); return; }
  log('UPGRADE', req.url, '<-', socket.remoteAddress);
  const proxy = httpRequest({
    host: UPSTREAM_HOST,
    port: upstreamPort,
    path: req.url,
    method: req.method,
    headers: upstreamHeaders(req.headers),
  });
  proxy.on('upgrade', (upRes, upSocket, upHead) => {
    if (upRes.statusCode !== 101) {
      log('upgrade rejected by upstream:', upRes.statusCode);
      socket.destroy();
      upSocket.destroy();
      return;
    }
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

server.listen(LISTEN_PORT, LISTEN_HOST, async () => {
  log(`listening on ${LISTEN_HOST}:${LISTEN_PORT} (file root: ${FILE_ROOT})`);
  await ensureUpstream();
  if (authority) log(`-> upstream ${authority}`);
});
