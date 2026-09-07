#!/usr/bin/env node
// patch-dsh.mjs — 重新打上 DSH 主机端两处 dsh-mobile 必需 patch
//
// 背景：DSH 更新（npm update）会覆盖 node_modules，把以下两处定制打回原样：
//   1. agentPreset.select 的「会话开始后禁止换预设」检查（agent-preset-locked）
//      → 删掉该检查，允许对话中切换模式。
//   2. session.history 无 compact 模式（历史页包含所有逐 token 的 assistant/chunk，
//      一页可达 8MB）→ 加 compact 标志，只返回消息/工具等表层事件（约 50KB/页）。
//
// 用法：
//   node poc/patch-dsh.mjs                          # 自动定位 DSH 安装
//   node poc/patch-dsh.mjs <api-proxy lib/index.js> # 显式指定文件
//
// 幂等：已打过的文件会报告 up-to-date，不会重复修改。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const MARKER = 'PATCHED (dsh-mobile)';

function findLib() {
  if (process.argv[2]) return process.argv[2];
  const candidates = [];
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    candidates.push(join(root, '@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js'));
    candidates.push(join(root, '@deepseek-ai/dsh-host-apiproxy/lib/index.js'));
  } catch {}
  if (process.platform === 'win32' && process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js'));
    candidates.push(join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js'));
  }
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error('cannot locate dsh-host-apiproxy/lib/index.js; pass the path as first argument');
}

const lib = findLib();
const source = readFileSync(lib, 'utf8');

if (source.includes(MARKER)) {
  console.log(`up-to-date: ${lib}`);
  process.exit(0);
}

let next = source;
const applied = [];

// ---- Patch 1: sessionHistoryRequestSchema 增加 compact 字段 ----
{
  const from = `const sessionHistoryRequestSchema = z$1.object({
\tsessionId: sessionIdSchema,
\tbeforeSeq: z$1.number().int().nonnegative().optional(),
\tmaxMessages: z$1.number().int().positive().optional()
});`;
  const to = `const sessionHistoryRequestSchema = z$1.object({
\tsessionId: sessionIdSchema,
\tbeforeSeq: z$1.number().int().nonnegative().optional(),
\tmaxMessages: z$1.number().int().positive().optional(),
\tcompact: z$1.boolean().optional()
});`;
  if (!next.includes(from)) throw new Error('patch 1a (schema) did not match; DSH may have changed shape');
  next = next.replace(from, to);
  applied.push('1a session.history schema: +compact');
}

// ---- Patch 1b: COMPACT_SURFACE_TYPES 常量 ----
{
  const anchor = `const MESSAGE_TYPES = new Set(["user/message", "assistant/message"]);`;
  const after = `const MESSAGE_TYPES = new Set(["user/message", "assistant/message"]);

// ${MARKER}: surface-only history filter — drop the per-token
// assistant/chunk and other scaffolding events the mobile client never renders,
// shrinking history pages from megabytes down to kilobytes.
const COMPACT_SURFACE_TYPES = new Set(["user/message", "assistant/message", "tool/call", "tool/result", "compaction/summary"]);`;
  if (!next.includes(anchor)) throw new Error('patch 1b (constant anchor) did not match; DSH may have changed shape');
  next = next.replace(anchor, after);
  applied.push('1b COMPACT_SURFACE_TYPES constant');
}

// ---- Patch 1c: session.history 处理器按 compact 过滤 ----
{
  const from = `\t\t\tasync history(request) {
\t\t\t\tconst { sessionId, beforeSeq, maxMessages } = request.payload;
\t\t\t\ttry {
\t\t\t\t\tconst source = await historySourceFor(sessionId);
\t\t\t\t\tconst scope = await presenterScopeFor(sessionId, sourceSession(source));
\t\t\t\t\tconst cut = historyCutOf(source, beforeSeq === void 0);
\t\t\t\t\tconst page = historyPage(ctx, cut.events, beforeSeq, maxMessages, scope);`;
  const to = `\t\t\tasync history(request) {
\t\t\t\tconst { sessionId, beforeSeq, maxMessages, compact } = request.payload;
\t\t\t\ttry {
\t\t\t\t\tconst source = await historySourceFor(sessionId);
\t\t\t\t\tconst scope = await presenterScopeFor(sessionId, sourceSession(source));
\t\t\t\t\tconst cut = historyCutOf(source, beforeSeq === void 0);
\t\t\t\t\t// ${MARKER}: compact pages keep only the surface events
\t\t\t\t\t// the mobile client renders, so a long streaming history is not
\t\t\t\t\t// downloaded as tens of thousands of chunk deltas.
\t\t\t\t\tconst events = compact ? cut.events.filter((event) => COMPACT_SURFACE_TYPES.has(event.type)) : cut.events;
\t\t\t\t\tconst page = historyPage(ctx, events, beforeSeq, maxMessages, scope);`;
  if (!next.includes(from)) throw new Error('patch 1c (history handler) did not match; DSH may have changed shape');
  next = next.replace(from, to);
  applied.push('1c session.history handler: compact filter');
}

// ---- Patch 2: agentPreset.select 放开「会话开始后禁止换预设」 ----
{
  const re = /(\t+)const swap = async \(\) => \{\s*if \(!sessionBlank\(agent\.session\)\) return err\(request, \{[\s\S]*?\}\);\s*(try \{)/;
  const m = re.exec(next);
  if (!m) throw new Error('patch 2 (agentPreset.select swap) did not match; DSH may have changed shape');
  const tabs = m[1];
  next = next.slice(0, m.index) +
    `${tabs}const swap = async () => {\n${tabs}\t// ${MARKER}: allow preset switching after the session has started.\n${tabs}\t${m[2]}` +
    next.slice(m.index + m[0].length);
  applied.push('2 agentPreset.select: unlock mid-session switch');
}

if (!next.includes(MARKER)) throw new Error('patches applied but marker missing; aborting write');
writeFileSync(lib, next);
console.log('patched:');
for (const a of applied) console.log(`  ✓ ${a}`);
console.log(`file: ${lib}`);
console.log('NOTE: restart DSH (dsh web) for the patches to take effect.');
