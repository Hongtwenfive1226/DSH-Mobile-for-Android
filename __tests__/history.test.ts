/**
 * 历史事件解析：这些行为直接决定「消息会不会变成一片空白」。
 * 真实会话日志里的形状：assistant/message 的 content 是
 * [{type:'reasoning'|'text'|'tool-call'}]，tool/result 的 content 是
 * [{type:'tool-result', toolCallId, content:[{type:'text', text}]}]。
 */
import { parseHistoryEvents } from '../App';
import type { HistoryEntry } from '../src/dsh/types';

const ev = (seq: number, type: string, data: any): HistoryEntry => ({ event: { seq, type, data } } as unknown as HistoryEntry);

const asst = (seq: number, blocks: any[]) => ev(seq, 'assistant/message', { message: { role: 'assistant', content: blocks } });
const call = (seq: number, callId: string, name: string, args: string) => ev(seq, 'tool/call', { callId, name, arguments: args });
const result = (seq: number, callId: string, text: string, isError = false) =>
  ev(seq, 'tool/result', { message: { content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError }] } });

describe('parseHistoryEvents', () => {
  it('正文与思维链都有的消息：两样都保留', () => {
    const items = parseHistoryEvents([asst(1, [{ type: 'reasoning', text: '想想' }, { type: 'text', text: '答案' }])]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'msg', role: 'assistant', text: '答案', reasoning: '想想' });
  });

  it('只有空白的正文不再生成空气泡（这是「空白」的一种来源）', () => {
    expect(parseHistoryEvents([asst(1, [{ type: 'text', text: '\n   \n' }])])).toHaveLength(0);
  });

  it('只有空白正文但有思维链：正文留空、只显示思维链入口', () => {
    const items = parseHistoryEvents([asst(1, [{ type: 'text', text: ' \n ' }, { type: 'reasoning', text: '想了很久' }])]);
    expect(items[0]).toMatchObject({ kind: 'msg', text: '', reasoning: '想了很久' });
  });

  it('只有工具调用的 assistant/message 不生成消息条目（避免空消息）', () => {
    expect(parseHistoryEvents([asst(1, [{ type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{}' }])])).toHaveLength(0);
  });

  it('多段正文用空行拼接，不会粘成一句话', () => {
    const items = parseHistoryEvents([asst(1, [{ type: 'text', text: '先看文件。' }, { type: 'text', text: '结论如下。' }])]);
    expect(items[0]).toMatchObject({ text: '先看文件。\n\n结论如下。' });
  });

  it('超长工具参数被截断（超长文本节点会让 Android 排版/绘制出问题）', () => {
    const items = parseHistoryEvents([call(1, 'c1', 'write', 'x'.repeat(20000))]);
    const tool = items[0] as Extract<(typeof items)[number], { kind: 'tool' }>;
    expect(tool.args.length).toBeLessThan(1000);
    expect(tool.args).toContain('已截断');
    expect(tool.done).toBe(false);
  });

  it('超长工具结果被截断', () => {
    const items = parseHistoryEvents([call(1, 'c1', 'read', '{}'), result(2, 'c1', 'y'.repeat(60000))]);
    const tool = items[0] as Extract<(typeof items)[number], { kind: 'tool' }>;
    expect(tool.result!.length).toBeLessThan(4200);
    expect(tool.result).toContain('已截断');
    expect(tool.done).toBe(true);
  });

  it('tool/call 与 tool/result 按 callId 配对成一张卡片', () => {
    const items = parseHistoryEvents([call(1, 'c1', 'pwsh', '{"command":"ls"}'), result(2, 'c1', '输出')]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'tool', name: 'pwsh', result: '输出', done: true, isError: false });
  });

  it('错误结果会标记 isError', () => {
    const items = parseHistoryEvents([call(1, 'c1', 'pwsh', '{}'), result(2, 'c1', 'boom', true)]);
    expect(items[0]).toMatchObject({ isError: true, done: true });
  });

  it('配不上 call 的结果仍会显示为一张卡片，且名字不为空', () => {
    const items = parseHistoryEvents([result(9, 'missing', '孤儿结果')]);
    expect(items[0]).toMatchObject({ kind: 'tool', name: '工具', result: '孤儿结果' });
  });

  it('tool/call 缺 name 时也有兜底名字（否则卡片会渲染成完全没有文字的空白块）', () => {
    const items = parseHistoryEvents([ev(1, 'tool/call', { callId: 'c1', arguments: '{}' })]);
    expect((items[0] as any).name).toBe('工具');
  });

  it('用户消息保留正文，纯空白用户消息被丢弃', () => {
    const items = parseHistoryEvents([
      ev(1, 'user/message', { content: [{ type: 'text', text: '你好' }] }),
      ev(2, 'user/message', { content: [{ type: 'text', text: '  ' }] }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'msg', role: 'user', text: '你好' });
  });
});
