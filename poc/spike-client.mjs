// spike-client.mjs — DeepSeek Harness 非浏览器客户端最小 PoC
//
// 目的：验证"React Native（无浏览器 Origin / Fetch-Metadata）也能直接驱动 DSH 的 /api RPC + 下行 WebSocket"。
// Node 的 fetch + 全局 WebSocket 与 RN 的 fetch + WebSocket 能力等价（都不是浏览器同源上下文）。
//
// 用法：
//   node spike-client.mjs describe                # 只做 readiness 握手 host.describe
//   node spike-client.mjs list                    # session.list + workspace.list
//   node spike-client.mjs stream [秒]             # 打开两条下行 WS 并打印帧
//   node spike-client.mjs prompt [文本]           # 建会话 + 发消息 + 观察事件流
//
// 环境变量：
//   DSH_BASE  宿主地址，默认 http://127.0.0.1:3080（P2 公网验证时指向隧道域名）

import { randomUUID } from 'node:crypto';

const BASE = (process.env.DSH_BASE ?? 'http://127.0.0.1:3080').replace(/\/+$/, '');

function wsBase() {
  return BASE.replace(/^http/, 'ws');
}

// 单工 RPC：POST /api/<method>，信封四象限里的 client-request
async function callUnary(method, payload = {}) {
  const rpcId = randomUUID();
  const message = { type: 'client-request', rpcId, method, payload };
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${method}`);
  const full = await res.json();
  if (full.type !== 'server-response') throw new Error(`unexpected envelope type ${full.type}`);
  if (full.rpcId !== rpcId) throw new Error(`rpcId mismatch: sent ${rpcId}, got ${full.rpcId}`);
  return full.result; // { ok:true, value } | { ok:false, error }
}

function ok(result, label) {
  if (!result.ok) {
    console.error(`\u2717 ${label}: ${result.error.code}: ${result.error.message}`);
    return null;
  }
  console.log(`\u2713 ${label}:`, JSON.stringify(result.value, undefined, 2));
  return result.value;
}

function printFrame(label, full) {
  const p = full.payload ?? {};
  // 精简打印：session/event 只打印事件类型/seq，其余打印 type
  if (p.type === 'session/event') {
    console.log(`  [${label}] ${p.type} sid=${String(p.sessionId).slice(0, 8)} event=${p.event?.type} seq=${p.event?.seq}`);
  } else if (p.type === 'session/subscribed') {
    console.log(`  [${label}] ${p.type} sid=${String(p.sessionId).slice(0, 8)} lastSeq=${p.lastSeq}`);
  } else {
    console.log(`  [${label}] ${p.type} ${JSON.stringify(p).slice(0, 160)}`);
  }
}

function openDownlink(path, label, seconds) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${wsBase()}/api/${path}`);
    let count = 0;
    socket.addEventListener('open', () => console.log(`\u2713 ws ${label} open  ${path}`));
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') { console.log(`  [${label}] binary frame (ignored)`); return; }
      try { const full = JSON.parse(event.data); count += 1; printFrame(label, full); }
      catch { console.log(`  [${label}] non-JSON frame`); }
    });
    socket.addEventListener('close', () => { console.log(`  [${label}] closed (${count} frames)`); resolve(); });
    socket.addEventListener('error', (e) => { console.log(`  [${label}] error ${e?.message ?? ''}`); resolve(); });
    setTimeout(() => { console.log(`  [${label}] ${count} frames in ${seconds}s`); socket.close(); }, seconds * 1000);
  });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'describe': {
      ok(await callUnary('host.describe', {}), 'host.describe');
      break;
    }
    case 'list': {
      ok(await callUnary('workspace.list', {}), 'workspace.list');
      ok(await callUnary('session.list', {}), 'session.list');
      break;
    }
    case 'stream': {
      const seconds = Number(rest[0]) || 4;
      await Promise.all([
        openDownlink('events.mux', 'mux', seconds),
        openDownlink('events.host', 'host', seconds),
      ]);
      break;
    }
    case 'prompt': {
      const text = rest.join(' ') || 'ping';
      ok(await callUnary('host.describe', {}), 'host.describe');
      const created = ok(await callUnary('session.create', {}), 'session.create');
      if (!created) break;
      const sessionId = created.sessionId;
      console.log('sessionId:', sessionId);

      const socket = new WebSocket(`${wsBase()}/api/events.mux`);
      socket.addEventListener('open', () => {
        // 给基线(subscribed)一点时间，再发 prompt
        setTimeout(async () => {
          const pr = await callUnary('session.prompt', {
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
          });
          ok(pr, 'session.prompt');
        }, 400);
      });
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        const full = JSON.parse(event.data);
        const p = full.payload ?? {};
        if (p.sessionId !== sessionId) return; // 只看我们这个会话
        printFrame('mux', full);
      });
      socket.addEventListener('error', () => console.log('mux error'));
      // 观察一段时间后退出
      setTimeout(() => { console.log('== 观察结束 =='); socket.close(); process.exit(0); }, 30000);
      break;
    }
    default: {
      console.log('usage: node spike-client.mjs <describe|list|stream [s]|prompt [text]>');
      console.log('env:   DSH_BASE (默认 http://127.0.0.1:3080)');
    }
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
