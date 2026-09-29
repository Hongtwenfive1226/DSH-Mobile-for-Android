// client.ts — DSH /api 传输客户端（React Native 版，等价于 spike-client.mjs）
// 只用 RN 全局的 fetch + WebSocket，零额外依赖。RN 无 crypto.randomUUID，用自实现 uuid。

import {
  AgentPresetListValue,
  ClientRequest,
  ModelCatalogValue,
  ModelSelection,
  RpcResult,
  ServerResponse,
  SessionAttachmentValue,
  SessionCreateValue,
  SessionListValue,
  SessionPageValue,
  SessionPromptRequest,
  SessionPromptValue,
  WorkspaceView,
} from './types';

export function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class DshClient {
  readonly baseUrl: string;
  private timeoutMs: number;

  constructor(baseUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  private wsBase(): string {
    return this.baseUrl.replace(/^http/, 'ws');
  }

  // 单工 RPC：POST /api/<namespace>/<method>，四象限信封 client-request / server-response
  // DSH 0.2.0：endpoint 是 `<namespace>/<method>`（斜杠，不再是 `session.history` 这种点号），
  // 且 payload 必须是恰好一个字段 { args: { <具名参数> } }（dsh-api-gateway 的
  // remoteRequest 校验：恰好一个 plain-object 字段且名为 args）。
  async callUnary<T>(endpoint: string, args: Record<string, unknown> = {}): Promise<RpcResult<T>> {
    const rpcId = uuid();
    const message: ClientRequest = { type: 'client-request', rpcId, method: endpoint, payload: { args } };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${endpoint}`);
      const full = (await res.json()) as ServerResponse;
      if (full.type !== 'server-response' || full.rpcId !== rpcId) {
        throw new Error(`bad envelope for ${endpoint}`);
      }
      return full.result as RpcResult<T>;
    } finally {
      clearTimeout(timer);
    }
  }

  // 说明：0.1.x 的 openStream('events.mux') / POST /api/respond 在 0.2.0 已不存在。
  // 实时通道与审批应答分别由 ./live.ts（remote.mux 逻辑流）和下面的 answerEvent 负责。

  // ---- 高层 API（DSH 0.2.0：endpoint 为 `<namespace>/<method>`）----
  // 0.2.0 没有 host 命名空间；连接状态改由 App 用 session/list + llm/listProviders 组合
  listSessions() {
    return this.callUnary<SessionListValue>('session/list', { _request: {} });
  }
  createSession(payload: { workspaceId?: string; agentPreset?: string; cwd?: string } = {}) {
    return this.callUnary<SessionCreateValue>('session/create', { request: payload });
  }
  prompt(req: SessionPromptRequest) {
    // requestId 是 0.2.0 新增的必填字段
    return this.callUnary<SessionPromptValue>('session/prompt', { request: { requestId: uuid(), ...req } });
  }
  /**
   * 会话历史一页。0.2.0 用 `session/page`：
   *   request = { address:{kind:'session',sessionId}, throughSeq, beforeSeq?, maxMessages?, turnWindow? }
   *   value   = { records:[{type:'event', event:{type,seq,time,data}}], hasMore? }
   * throughSeq 是「看到哪个序号为止」，首次取本会话 projections.asOfSeq，翻页时沿用同一个值。
   */
  page(sessionId: string, opts: { throughSeq: number; beforeSeq?: number; maxMessages?: number }) {
    return this.callUnary<SessionPageValue>('session/page', {
      request: { address: { kind: 'session', sessionId }, ...opts },
    });
  }
  cancel(sessionId: string) {
    return this.callUnary<{ accepted: true }>('session/cancel', { request: { sessionId } });
  }
  sessionProjections(sessionId: string) {
    return this.callUnary<{ asOfSeq: number; values: Record<string, unknown> }>('session/projections', { request: { sessionId } });
  }
  getAttachment(sessionId: string, attachmentId: string) {
    return this.callUnary<SessionAttachmentValue>('session/attachment', { request: { sessionId, attachmentId } });
  }
  renameSession(sessionId: string, title: string) {
    return this.callUnary<{ title: string; seq: number }>('session/rename', { request: { sessionId, title } });
  }
  listAgentPresets() {
    return this.callUnary<AgentPresetListValue>('agentPresets/list', {});
  }
  selectAgentPreset(agentId: string, agentPreset: string) {
    return this.callUnary<{ agentPreset: string }>('agentPresets/select', { agentId, agentPreset });
  }
  // 0.2.0 的模型目录是进程级（不针对单个会话），返回 { default, routableProviders, groups }
  getModelCatalog() {
    return this.callUnary<ModelCatalogValue>('session/modelCatalog', {});
  }
  selectModel(sessionId: string, provider: string, model: string, reasoningEffort?: string) {
    return this.callUnary<{ selected: ModelSelection }>('session/selectModel', {
      request: { sessionId, provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) },
    });
  }
  // 归档会话（DSH 无真正删除，归档即隐藏）
  archiveSession(sessionId: string) {
    return this.callUnary<{ archivedSessionIds: string[] }>('workspace/archiveSession', { request: { sessionId } });
  }
  createWorkspace(path: string) {
    return this.callUnary<{ workspace: WorkspaceView; created: boolean }>('workspace/create', { request: { path } });
  }
  renameWorkspace(workspaceId: string, title: string) {
    return this.callUnary<{ workspace: WorkspaceView }>('workspace/rename', { request: { workspaceId, title } });
  }
  deleteWorkspace(workspaceId: string) {
    return this.callUnary<{ deleted: true }>('workspace/delete', { request: { workspaceId } });
  }
  /**
   * 应答一个「转发事件」（审批 approval/request、AI 提问 user-questions/request）。
   * 0.2.0 把它做成一元 endpoint：POST /api/$events/result，
   * args = { clientId, eventId, outcome:{ kind:'result', value } | { kind:'rejected', error } }。
   * 审批的 value 是结果词表里的字符串（'allowed-once' | 'rejected' | …）；
   * AI 提问的 value 是 { answers:[{ id, selected, custom? }] }。
   */
  answerEvent(
    clientId: string,
    eventId: string,
    outcome: { kind: 'result'; value?: unknown } | { kind: 'rejected'; error?: unknown },
  ) {
    return this.callUnary<{ accepted?: true }>('$events/result', { clientId, eventId, outcome });
  }
}
