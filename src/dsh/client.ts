// client.ts — DSH /api 传输客户端（React Native 版，等价于 spike-client.mjs）
// 只用 RN 全局的 fetch + WebSocket，零额外依赖。RN 无 crypto.randomUUID，用自实现 uuid。

import {
  AgentPresetListValue,
  ApprovalResponsePayload,
  ClientRequest,
  ClientResponse,
  HostDescription,
  HostFrame,
  ModelSelection,
  MuxFrame,
  RespondReceipt,
  RpcResult,
  ServerRequest,
  ServerResponse,
  SessionAttachmentValue,
  SessionCreateValue,
  SessionHistoryValue,
  SessionListValue,
  SessionModelsValue,
  SessionPromptRequest,
  SessionPromptValue,
  WorkspaceListValue,
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

  // 单工 RPC：POST /api/<method>，四象限信封 client-request / server-response
  async callUnary<T>(method: string, payload: unknown = {}): Promise<RpcResult<T>> {
    const rpcId = uuid();
    const message: ClientRequest = { type: 'client-request', rpcId, method, payload };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${method}`);
      const full = (await res.json()) as ServerResponse;
      if (full.type !== 'server-response' || full.rpcId !== rpcId) {
        throw new Error(`bad envelope for ${method}`);
      }
      return full.result as RpcResult<T>;
    } finally {
      clearTimeout(timer);
    }
  }

  // 打开一条下行 WS（events.mux / events.host），自动重连。返回关闭函数。
  // onFrame 额外携带 envelope 的 rpcId（审批等可应答帧需要用它回 respond）。
  openStream(
    path: 'events.mux' | 'events.host',
    onFrame: (payload: MuxFrame | HostFrame, rpcId: string) => void,
    onState?: (open: boolean) => void,
  ): () => void {
    let closed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(`${this.wsBase()}/api/${path}`);
      ws.onopen = () => onState?.(true);
      ws.onmessage = (e: any) => {
        if (typeof e.data !== 'string') return; // 忽略二进制帧
        try {
          const full = JSON.parse(e.data) as ServerRequest;
          if (full.type === 'server-request') onFrame(full.payload as MuxFrame | HostFrame, full.rpcId);
        } catch {
          /* 忽略坏帧 */
        }
      };
      ws.onclose = () => {
        onState?.(false);
        if (!closed) reconnectTimer = setTimeout(connect, 1000);
      };
      ws.onerror = () => {
        try { ws?.close(); } catch {}
      };
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ws?.close(); } catch {}
    };
  }

  // 应答审批帧（POST /api/respond）
  async respond(rpcId: string, value: ApprovalResponsePayload): Promise<RespondReceipt> {
    const message: ClientResponse = { type: 'client-response', rpcId, result: { ok: true, value } };
    const res = await fetch(`${this.baseUrl}/api/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for respond`);
    return (await res.json()) as RespondReceipt;
  }

  // ---- 高层 API ----
  describe() {
    return this.callUnary<HostDescription>('host.describe', {});
  }
  listSessions() {
    return this.callUnary<SessionListValue>('session.list', {});
  }
  listWorkspaces() {
    return this.callUnary<WorkspaceListValue>('workspace.list', {});
  }
  createSession(payload: { workspaceId?: string; agentPreset?: string; cwd?: string } = {}) {
    return this.callUnary<SessionCreateValue>('session.create', payload);
  }
  prompt(req: SessionPromptRequest) {
    return this.callUnary<SessionPromptValue>('session.prompt', req);
  }
  history(sessionId: string) {
    return this.callUnary<SessionHistoryValue>('session.history', { sessionId });
  }
  cancel(sessionId: string) {
    return this.callUnary<{ accepted: true }>('session.cancel', { sessionId });
  }
  getAttachment(sessionId: string, attachmentId: string) {
    return this.callUnary<SessionAttachmentValue>('session.attachment', { sessionId, attachmentId });
  }
  renameSession(sessionId: string, title: string) {
    return this.callUnary<{ title: string; seq: number }>('session.rename', { sessionId, title });
  }
  listAgentPresets() {
    return this.callUnary<AgentPresetListValue>('agentPreset.list', {});
  }
  selectAgentPreset(sessionId: string, agentPreset: string) {
    return this.callUnary<{ agentPreset: string }>('agentPreset.select', { sessionId, agentPreset });
  }
  getSessionModels(sessionId: string) {
    return this.callUnary<SessionModelsValue>('session.models', { sessionId });
  }
  selectModel(sessionId: string, provider: string, model: string) {
    return this.callUnary<{ selected: ModelSelection }>('session.selectModel', { sessionId, provider, model });
  }
  // 归档会话（DSH 无真正删除，归档即隐藏）
  archiveSession(sessionId: string) {
    return this.callUnary<{ archivedSessionIds: string[] }>('workspace.archiveSession', { sessionId });
  }
  createWorkspace(path: string) {
    return this.callUnary<{ workspace: WorkspaceView; created: boolean }>('workspace.create', { path });
  }
  renameWorkspace(workspaceId: string, title: string) {
    return this.callUnary<{ workspace: WorkspaceView }>('workspace.rename', { workspaceId, title });
  }
  deleteWorkspace(workspaceId: string) {
    return this.callUnary<{ deleted: true }>('workspace.delete', { workspaceId });
  }
}
