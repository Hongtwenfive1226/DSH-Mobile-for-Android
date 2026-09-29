// dsh-session.mjs — 为 DSH 0.2.0 的 /api 生成「浏览器会话 cookie」
//
// 背景（DSH 0.2.0-rc.1 起）：
//   每个进程一个随机启动令牌，只有 `GET /?token=…` 能换取签名 cookie；
//   /api 的每个方法和 WebSocket 都要这个 cookie，缺失即 401。
//   cookie 是 HMAC-SHA256 签名，密钥存在 $DSH_HOME/.credentials.yaml 的
//   `client-connection/browser-session` 记录里 —— 本机进程可以直接用它签发，
//   不需要那个随机令牌。
//
// 依据（dsh-client-connection/lib/index.js，0.2.0-rc.1）：
//   authority     = new URL(`http://${Host}`).host          // 规范化 host:port
//   cookie 名     = "dsh-auth-" + base64url(sha256(authority))
//   cookie 值     = `v1.${body}.${base64url(hmac_sha256(secret, body))}`
//   body          = base64url(JSON({version:1, authority, issuedAt, expiresAt}))
//   校验：authority 必须相同；issuedAt <= now < expiresAt；
//        expiresAt > issuedAt 且 expiresAt-issuedAt <= cookieMaxAgeDays(默认 30 天)
//
// 用法：
//   import { mintCookie, readBrowserSecret, defaultHome } from './dsh-session.mjs'
//   const cookie = mintCookie('127.0.0.1:19387')   // { name, value, header, expiresAt }

import { createHash, createHmac } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_MAX_AGE_DAYS = 30;

/** DSH_HOME：优先环境变量，其次 ~/.dsh */
export function defaultHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** 读 .credentials.yaml 里 browser-session 记录的签名密钥（32 字节） */
export function readBrowserSecret(home = defaultHome()) {
  const file = join(home, '.credentials.yaml');
  if (!existsSync(file)) throw new Error(`credentials file not found: ${file}`);
  const text = readFileSync(file, 'utf8');

  // 只做定向提取：这份文件由 DSH 生成，结构固定
  const blockStart = text.indexOf('client-connection/browser-session:');
  if (blockStart === -1) throw new Error('browser-session record not found in .credentials.yaml');
  const rest = text.slice(blockStart);
  const nextTop = rest.slice(1).search(/\n {2}\S/); // 下一个同级记录（2 空格缩进）
  const block = nextTop === -1 ? rest : rest.slice(0, nextTop + 1);
  const m = /secret:\s*([A-Za-z0-9_-]+)/.exec(block);
  if (!m) throw new Error('secret missing in browser-session record');

  const secret = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  if (secret.byteLength !== 32) throw new Error(`unexpected secret length: ${secret.byteLength}`);
  return secret;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** cookie 名与签名值（authority 必须是 host[:port] 的规范化形式） */
export function mintCookie(authority, { secret, maxAgeDays = DEFAULT_MAX_AGE_DAYS } = {}) {
  const key = secret ?? readBrowserSecret();
  const name = 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest());
  const issuedAt = Date.now();
  const expiresAt = issuedAt + maxAgeDays * 24 * 60 * 60 * 1000;
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'));
  const sig = b64url(createHmac('sha256', key).update(body).digest());
  const value = `v1.${body}.${sig}`;
  return { name, value, header: `${name}=${value}`, authority, expiresAt };
}

/** 候选端口：环境变量优先，其次当前桌面版默认端口与常见端口 */
export function candidatePorts() {
  const fromEnv = (process.env.DSH_WEB_PORT ?? '').split(',').map((s) => Number(s.trim())).filter(Boolean);
  return [...new Set([...fromEnv, 19387, 3080, 3081, 19388, 19389])];
}

/** 探测哪个端口上跑着 DSH（GET / 返回 200/303/401 都算命中的候选） */
export async function discoverPort({ host = '127.0.0.1', ports = candidatePorts(), cookie } = {}) {
  for (const port of ports) {
    const authority = `${host}:${port}`;
    const c = cookie ?? mintCookie(authority).header;
    try {
      const res = await fetch(`http://${authority}/api/session.list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: authority, cookie: c },
        body: JSON.stringify({ type: 'client-request', rpcId: 'discover', method: 'session.list', payload: {} }),
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) return { port, authority };
    } catch {
      /* 端口没开或不是 DSH */
    }
  }
  return undefined;
}

// 直接运行时：做一次自检（发一个只读的 session.list）
if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  const home = defaultHome();
  const secret = readBrowserSecret(home);
  console.log(`DSH_HOME=${home}  secret=${secret.byteLength} bytes`);
  const found = await discoverPort({ cookie: undefined });
  if (!found) {
    console.log('no live DSH found on candidate ports');
    process.exit(1);
  }
  const cookie = mintCookie(found.authority, { secret });
  console.log(`live DSH at ${found.authority}, cookie=${cookie.name.slice(0, 20)}…`);
  const res = await fetch(`http://${found.authority}/api/session.list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: found.authority, cookie: cookie.header },
    body: JSON.stringify({ type: 'client-request', rpcId: 'probe-1', method: 'session.list', payload: {} }),
  });
  const body = await res.text();
  console.log(`session.list -> HTTP ${res.status}`);
  console.log(body.slice(0, 700));
}
