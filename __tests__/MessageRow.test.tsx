/**
 * 消息行渲染回归测试。
 *
 * 这一层直接决定「某条消息会不会渲染成一片空白」：
 * 每种条目（用户气泡 / 助手 Markdown / 思维链 / 工具卡片）都必须产出可见文字。
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { MessageRow } from '../App';
import type { ChatItem } from '../App';

const noop = () => {};

function renderRow(item: ChatItem, reasoningOpen = false): string {
  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <MessageRow item={item} reasoningOpen={reasoningOpen} onToggleReasoning={noop} onPath={noop} onImage={noop} />,
    );
  });
  return JSON.stringify(tree?.toJSON()) ?? '';
}

describe('MessageRow', () => {
  test('助手正文渲染出可见文字', () => {
    const out = renderRow({ kind: 'msg', id: 'a1', role: 'assistant', text: '## 结论\n\n可以交付。' });
    expect(out).toContain('结论');
    expect(out).toContain('可以交付');
  });

  test('思维链默认折叠：只有入口文字，展开后才显示内容', () => {
    const item: ChatItem = { kind: 'msg', id: 'a2', role: 'assistant', text: '', reasoning: '内部推理内容' };
    const collapsed = renderRow(item);
    expect(collapsed).toContain('思维链');
    expect(collapsed).not.toContain('内部推理内容');
    expect(renderRow(item, true)).toContain('内部推理内容');
  });

  test('工具卡片：未完成/完成/出错都有文字，不会是空白块', () => {
    expect(renderRow({ kind: 'tool', id: 't1', name: 'pwsh', args: '{"command":"ls"}', done: false })).toContain('pwsh');
    const done = renderRow({ kind: 'tool', id: 't2', name: 'read', args: '{}', result: '文件内容', done: true });
    expect(done).toContain('read');
    expect(done).toContain('文件内容');
    const bad = renderRow({ kind: 'tool', id: 't3', name: 'pwsh', args: '{}', result: '报错了', isError: true, done: true });
    expect(bad).toContain('报错了');
  });

  test('用户气泡渲染出可见文字', () => {
    expect(renderRow({ kind: 'msg', id: 'u1', role: 'user', text: '帮我看看 D:\\AutoDS\\a.txt' })).toContain('帮我看看');
  });

  test('流式中的助手消息至少有一个光标字符（不是空气泡）', () => {
    expect(renderRow({ kind: 'msg', id: 'a3', role: 'assistant', text: '', streaming: true })).toContain('▍');
  });
});
