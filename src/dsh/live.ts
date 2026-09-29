// live.ts — DSH 0.2.0 的实时通道（/api/remote.mux）
//
// 协议（依据 dsh-api-gateway/lib/client.js，实测通过）：
//   客户端 → 主机：{ type:'open',   streamId, endpoint, payload:{ args:{…} } }
//                  { type:'item',   streamId, value }     // 上行（仅带 uplink 的流）
//                  { type:'end',    streamId }
//                  { type:'cancel', streamId }
//   主机 → 客户端：{ type:'item',  streamId, value }
//                  { type:'end',   streamId }
//                  { type:'error', streamId, error:{ code, message, details } }
//
// 三个逻辑流：
//   $events           → 首帧 {type:'ready', clientId, host}，其后是 {type:'emit'|'waterfall', eventId, event, args|request}
//                        （审批 approval/request、AI 提问 user-questions/request 都从这里来）
//   session/control   → baseline（各会话 projections）+ {type:'projection', sessionId, key, value, seq} 增量
//   workspace/follow  → baseline（工作区列表）+ upsert/remove/order/archived/pinned
//   session/follow    → snapshot + {type:'event', event}（会话事件）+ {type:'assistant-stream', frame}（助手增量）
//
// 应答：POST /api/$events/result，args = { clientId, eventId, outcome:{kind:'result', value} | {kind:'rejected'…} }

export interface RemoteError {
  code: string;
  message: string;
  details: unknown;
}

export interface EventFrame {
  kind: 'emit' | 'waterfall';
  eventId: string;
  event: string;
  clientId: string;
  args: unknown[];
  request?: unknown;
}

export interface LiveHandlers {
  onState?: (open: boolean) => void;
  onReady?: (info: { clientId: string; host: unknown }) => void;
  onEvent?: (frame: EventFrame) => void;
  onControl?: (item: any) => void;
  onWorkspace?: (item: any) => void;
  onSession?: (item: any) => void;
  onStreamError?: (endpoint: string, error: RemoteError) => void;
}

const EVENTS_ENDPOINT = '$events';

export class DshLive {
  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 1000;
  /** streamId → 该逻辑流的处理器 */
  private streams = new Map<string, { endpoint: string; onItem?: (v: any) => void; onEnd?: () => void; onError?: (e: RemoteError) => void }>();
  /** 重连后需要重建的逻辑流（不含 $events） */
  private subscriptions: { endpoint: string; args: Record<string, unknown>; key: string }[] = [];
  private clientId: string | null = null;

  constructor(
    private baseUrl: string,
    private handlers: LiveHandlers,
  ) {}

  private wsUrl(): string {
    return `${this.baseUrl.replace(/^http/, 'ws')}/api/remote.mux`;
  }

  private send(msg: unknown) {
    try {
      this.ws?.send(JSON.stringify(msg));
    } catch {
      /* 断线时忽略 */
    }
  }

  private openStream(endpoint: string, args: Record<string, unknown>, handlers: { onItem?: (v: any) => void; onEnd?: () => void; onError?: (e: RemoteError) => void }): () => void {
    const streamId = `${endpoint}#${Math.random().toString(36).slice(2, 8)}`;
    this.streams.set(streamId, { endpoint, ...handlers });
    this.send({ type: 'open', streamId, endpoint, payload: { args } });
    return () => {
      this.streams.delete(streamId);
      this.send({ type: 'cancel', streamId });
    };
  }

  connect() {
    if (this.closed) return;
    try {
      this.ws = new WebSocket(this.wsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.retryDelay = 1000;
      this.handlers.onState?.(true);
      this.clientId = null;
      // 重建 $events 与所有已订阅的逻辑流
      this.openStream(EVENTS_ENDPOINT, {}, { onItem: (v) => this.handleEventItem(v) });
      for (const sub of this.subscriptions) {
        this.openStream(sub.endpoint, sub.args, this.handlersFor(sub.key));
      }
    };
    this.ws.onmessage = (e: any) => {
      if (typeof e.data !== 'string') return;
      let frame: any;
      try {
        frame = JSON.parse(e.data);
      } catch {
        return;
      }
      this.handleFrame(frame);
    };
    this.ws.onclose = () => {
      this.handlers.onState?.(false);
      this.streams.clear();
      this.scheduleReconnect();
    };
    this.ws.onerror = () => {
      try {
        this.ws?.close();
      } catch {}
    };
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.retryDelay = Math.min(this.retryDelay * 2, 15000);
      this.connect();
    }, this.retryDelay);
  }

  private handleFrame(frame: any) {
    if (frame.type === 'item') {
      const stream = this.streams.get(frame.streamId);
      if (!stream) return;
      if (stream.endpoint === EVENTS_ENDPOINT) this.handleEventItem(frame.value);
      else stream.onItem?.(frame.value);
      return;
    }
    if (frame.type === 'end') {
      const stream = this.streams.get(frame.streamId);
      if (stream) {
        this.streams.delete(frame.streamId);
        stream.onEnd?.();
      }
      return;
    }
    if (frame.type === 'error') {
      const stream = this.streams.get(frame.streamId);
      const endpoint = stream?.endpoint ?? frame.streamId;
      if (stream) this.streams.delete(frame.streamId);
      if (stream?.onError) stream.onError(frame.error);
      else this.handlers.onStreamError?.(endpoint, frame.error);
    }
  }

  private handleEventItem(value: any) {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'ready') {
      this.clientId = value.clientId ?? null;
      this.handlers.onReady?.({ clientId: value.clientId, host: value.host });
      return;
    }
    if (value.type === 'emit' || value.type === 'waterfall') {
      this.handlers.onEvent?.({
        kind: value.type,
        eventId: value.eventId,
        event: value.event,
        clientId: this.clientId ?? '',
        args: Array.isArray(value.args) ? value.args : [],
        request: value.request,
      });
    }
  }

  /** 订阅一条需要长期保持的逻辑流；重连后自动恢复 */
  subscribe(key: string, endpoint: string, args: Record<string, unknown>): () => void {
    this.subscriptions = this.subscriptions.filter((s) => s.key !== key);
    const sub = { key, endpoint, args };
    this.subscriptions.push(sub);
    if (this.ws?.readyState === 1) this.openStream(endpoint, args, this.handlersFor(key));
    return () => {
      this.subscriptions = this.subscriptions.filter((s) => s.key !== key);
    };
  }

  /**
   * 跟随某个会话：session/follow 会推送该会话的事件记录与助手增量帧。
   * address 是 0.2.0 的会话地址：普通会话 { kind:'session', sessionId }，
   * 子代理会话 { kind:'subagent', parentSessionId, childSessionId, mode }。
   */
  followSession(address: Record<string, unknown> | null) {
    if (!address) return;
    this.subscribe('session', 'session/follow', { request: { address, assistantStream: true } });
  }

  private handlersFor(key: string) {
    if (key === 'control') return { onItem: this.handlers.onControl };
    if (key === 'workspace') return { onItem: this.handlers.onWorkspace };
    if (key === 'session') return { onItem: this.handlers.onSession };
    return {};
  }

  /** 当前 $events 的 clientId（应答转发事件时必需） */
  currentClientId(): string | null {
    return this.clientId;
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.streams.clear();
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }
}
