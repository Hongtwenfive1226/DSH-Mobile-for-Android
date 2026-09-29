/**
 * DSH 0.2.0 协议层回归测试。
 *
 * 这一层是从 0.1.x 迁移过来的核心风险面，全部依据实测确认的线上契约：
 *   endpoint        = `<namespace>/<method>`（斜杠），POST /api/<endpoint>
 *   payload         = { args: { <具名参数> } }        ← gateway 校验「恰好一个名为 args 的 plain-object 字段」
 *   session/page    = { request: { address, throughSeq, beforeSeq?, maxMessages? } } → { records, hasMore }
 *   实时通道         = WS /api/remote.mux，{type:'open',streamId,endpoint,payload} →
 *                     {type:'item'|'end'|'error', streamId, …}
 *   $events         = 首帧 {type:'ready',clientId}，其后 {type:'emit'|'waterfall',eventId,event,args|request}
 *   应答            = POST /api/$events/result，args={ clientId, eventId, outcome }
 */
import { DshClient } from '../src/dsh/client';
import { DshLive } from '../src/dsh/live';
import { sessionAddress } from '../App';

const post = (url: string, init: any) => ({ url, body: JSON.parse(init.body) });

describe('callUnary：0.2.0 的 endpoint 与 args 包装', () => {
  const calls: { url: string; body: any }[] = [];

  beforeEach(() => {
    calls.length = 0;
    (global as any).fetch = async (url: string, init: any) => {
      calls.push(post(url, init));
      const body = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { echo: true } } }),
      };
    };
  });

  test('session/list 用 {_request:{}}，URL 是斜杠形式', async () => {
    const c = new DshClient('http://host:8787');
    const r = await c.listSessions();
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe('http://host:8787/api/session/list');
    expect(calls[0].body.method).toBe('session/list');
    expect(calls[0].body.payload).toEqual({ args: { _request: {} } });
  });

  test('session/page 用 {request:{address,throughSeq}}，address 是会话地址', async () => {
    const c = new DshClient('http://host:8787');
    await c.page('session-abc', { throughSeq: 42, maxMessages: 50 });
    expect(calls[0].url).toBe('http://host:8787/api/session/page');
    expect(calls[0].body.payload.args.request).toEqual({
      address: { kind: 'session', sessionId: 'session-abc' },
      throughSeq: 42,
      maxMessages: 50,
    });
  });

  test('session/prompt 自动补 requestId（0.2.0 必填）', async () => {
    const c = new DshClient('http://host:8787');
    await c.prompt({ sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: '你好' }] });
    const req = calls[0].body.payload.args.request;
    expect(typeof req.requestId).toBe('string');
    expect(req.requestId.length).toBeGreaterThan(10);
    expect(req.sessionId).toBe('s1');
  });

  test('agentPresets/select 的具名参数是 agentId + agentPreset', async () => {
    const c = new DshClient('http://host:8787');
    await c.selectAgentPreset('session-abc', 'cordis');
    expect(calls[0].url).toBe('http://host:8787/api/agentPresets/select');
    expect(calls[0].body.payload.args).toEqual({ agentId: 'session-abc', agentPreset: 'cordis' });
  });

  test('answerEvent 打到 $events/result 并带 clientId/eventId/outcome', async () => {
    const c = new DshClient('http://host:8787');
    await c.answerEvent('client-1', 'evt-9', { kind: 'result', value: 'allowed-once' });
    expect(calls[0].url).toBe('http://host:8787/api/$events/result');
    expect(calls[0].body.payload.args).toEqual({
      clientId: 'client-1',
      eventId: 'evt-9',
      outcome: { kind: 'result', value: 'allowed-once' },
    });
  });
});

describe('sessionAddress：普通会话与子代理会话', () => {
  test('普通会话', () => {
    expect(sessionAddress({ sessionId: 's1' } as any)).toEqual({ kind: 'session', sessionId: 's1' });
  });

  test('子代理会话带上父会话与模式', () => {
    expect(sessionAddress({ sessionId: 'c1', origin: 'subagent', parentSessionId: 'p1' } as any)).toEqual({
      kind: 'subagent',
      parentSessionId: 'p1',
      childSessionId: 'c1',
      mode: 'continuable',
    });
  });
});

describe('DshLive：remote.mux 帧分发', () => {
  class FakeWS {
    static last: FakeWS;
    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    sent: any[] = [];
    constructor(public url: string) {
      FakeWS.last = this;
    }
    send(text: string) {
      this.sent.push(JSON.parse(text));
    }
    close() {
      this.onclose?.();
    }
    /** 模拟主机发帧 */
    emit(frame: unknown) {
      this.onmessage?.({ data: JSON.stringify(frame) });
    }
  }

  const setup = () => {
    (global as any).WebSocket = FakeWS as any;
    const control: any[] = [];
    const session: any[] = [];
    const events: any[] = [];
    const live = new DshLive('http://host:8787', {
      onControl: (i) => control.push(i),
      onSession: (i) => session.push(i),
      onEvent: (f) => events.push(f),
    });
    live.connect();
    const ws = FakeWS.last;
    ws.onopen?.();
    return { live, ws, control, session, events };
  };

  test('连接后自动订阅 $events，并用 args 包装的 payload 订阅逻辑流', () => {
    const { live, ws } = setup();
    const eventsOpen = ws.sent.find((m) => m.endpoint === '$events');
    expect(eventsOpen).toMatchObject({ type: 'open', payload: { args: {} } });
    live.subscribe('control', 'session/control', {});
    expect(ws.sent.some((m) => m.type === 'open' && m.endpoint === 'session/control' && m.payload.args)).toBe(true);
    live.close();
  });

  test('session/follow 用 request 具名参数，assistantStream 打开', () => {
    const { live, ws } = setup();
    live.followSession({ kind: 'session', sessionId: 's1' });
    const open = ws.sent.find((m) => m.endpoint === 'session/follow');
    expect(open.payload.args).toEqual({
      request: { address: { kind: 'session', sessionId: 's1' }, assistantStream: true },
    });
    live.close();
  });

  test('item 帧按 streamId 分发到对应处理器（事件 vs 会话流）', () => {
    const { live, ws, control, session } = setup();
    live.subscribe('control', 'session/control', {});
    live.followSession({ kind: 'session', sessionId: 's1' });
    const controlId = ws.sent.find((m) => m.endpoint === 'session/control').streamId;
    const followId = ws.sent.find((m) => m.endpoint === 'session/follow').streamId;

    ws.emit({ type: 'item', streamId: controlId, value: { type: 'projection', sessionId: 's1', key: 'tokenUsage', value: { outputTokens: 5 }, seq: 3 } });
    ws.emit({ type: 'item', streamId: followId, value: { type: 'event', event: { type: 'assistant/message', seq: 4, time: 0, data: {} } } });
    expect(control).toHaveLength(1);
    expect(session).toHaveLength(1);
    expect(session[0].event.type).toBe('assistant/message');
    live.close();
  });

  test('$events：ready 记住 clientId，waterfall/emit 变成转发事件', () => {
    const { live, ws, events } = setup();
    const eventsId = ws.sent.find((m) => m.endpoint === '$events').streamId;
    ws.emit({ type: 'item', streamId: eventsId, value: { type: 'ready', clientId: 'client-7', host: { home: 'C:\\Users\\x' } } });
    expect(live.currentClientId()).toBe('client-7');

    ws.emit({
      type: 'item',
      streamId: eventsId,
      value: { type: 'waterfall', eventId: 'evt-1', event: 'user-questions/request', request: { questions: [{ id: 'q1', question: '选哪个？' }] } },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'waterfall', event: 'user-questions/request', eventId: 'evt-1', clientId: 'client-7' });
    expect(events[0].request.questions[0].id).toBe('q1');
    live.close();
  });

  test('error 帧把错误交给 onStreamError', () => {
    (global as any).WebSocket = FakeWS as any;
    const seen: any[] = [];
    const live = new DshLive('http://host:8787', { onStreamError: (endpoint, error) => seen.push([endpoint, error]) });
    live.connect();
    FakeWS.last.onopen?.();
    live.subscribe('session', 'session/follow', { request: {} });
    const id = FakeWS.last.sent.find((m) => m.endpoint === 'session/follow').streamId;
    FakeWS.last.emit({ type: 'error', streamId: id, error: { code: 'gateway/arguments-invalid', message: 'x', details: {} } });
    expect(seen[0][0]).toBe('session/follow');
    expect(seen[0][1].code).toBe('gateway/arguments-invalid');
    live.close();
  });
});
