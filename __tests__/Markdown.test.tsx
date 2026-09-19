/**
 * Markdown 渲染回归测试
 *
 * 重点复现并防止 v1.6 的严重 bug：表格渲染循环里 thead_open/thead_close 分支
 * 没有推进下标，导致死循环、JS 线程被锁死（对话加载不出来、按钮点不动）。
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import Markdown from '../src/ui/Markdown';

/** 渲染并把整棵树序列化成字符串，便于断言 */
function renderText(text: string, onPath?: (p: string) => void): string {
  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<Markdown text={text} onPath={onPath} />);
  });
  return JSON.stringify(tree?.toJSON());
}

describe('Markdown', () => {
  // 死循环会让本测试挂住（jest 的 timeout 无法中断同步死循环），因此这条用例是核心回归保护
  test('表格可渲染且不会卡死', () => {
    const text = [
      '| 列A | 列B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '| 3 | 4 |',
      '',
      '表格后的段落',
    ].join('\n');
    const out = renderText(text);
    expect(out).toContain('列A');
    expect(out).toContain('列B');
    expect(out).toContain('表格后的段落');
  });

  test('标题/粗体/斜体/行内代码/删除线', () => {
    const out = renderText(['# 一级标题', '', '**粗体** *斜体* `代码` ~~删~~'].join('\n'));
    expect(out).toContain('一级标题');
    expect(out).toContain('粗体');
    expect(out).toContain('斜体');
    expect(out).toContain('代码');
    expect(out).toContain('删');
  });

  test('围栏代码块带语言标签', () => {
    const out = renderText(['```js', 'const a = 1;', '```'].join('\n'));
    expect(out).toContain('js');
    expect(out).toContain('const a = 1;');
  });

  test('有序/无序列表与嵌套', () => {
    const out = renderText(['- 甲', '- 乙', '  - 乙一', '', '1. 第一', '2. 第二'].join('\n'));
    expect(out).toContain('甲');
    expect(out).toContain('乙一');
    expect(out).toContain('第一');
  });

  test('引用块与分隔线', () => {
    const out = renderText(['> 引用文字', '', '---', '', '结尾'].join('\n'));
    expect(out).toContain('引用文字');
    expect(out).toContain('结尾');
  });

  test('链接与宿主路径都可点击', () => {
    const out = renderText('[示例](https://example.com) 以及 D:\\AutoDS\\shared-files\\a.apk', () => {});
    expect(out).toContain('示例');
    expect(out).toContain('a.apk');
  });

  test('空文本不报错', () => {
    expect(() => renderText('')).not.toThrow();
  });

  test('原始 HTML 标签按纯文本处理（不解析）', () => {
    const out = renderText('<div>原始标签</div>\n\n<br>\n\n与 **粗体**');
    expect(out).toContain('原始标签');
    expect(out).toContain('粗体');
  });

  test('混合长文档不卡死且元素齐全', () => {
    const text = [
      '# 报告',
      '',
      '引言段落，含 **重点** 与 `code`。',
      '',
      '## 数据',
      '',
      '| 项目 | 数值 |',
      '| --- | --- |',
      '| 甲 | 1 |',
      '| 乙 | 2 |',
      '',
      '## 步骤',
      '',
      '1. 第一步',
      '   - 子项 A',
      '   - 子项 B',
      '2. 第二步',
      '',
      '> 注意事项',
      '',
      '```python',
      'print("hi")',
      '```',
      '',
      '参考 [文档](https://example.com)。',
      '',
      '路径 D:\\AutoDS\\out.bin',
    ].join('\n');
    const out = renderText(text, () => {});
    for (const expect_ of ['报告', '数据', '甲', '第一步', '子项 A', '注意事项', 'print', '文档', 'out.bin']) {
      expect(out).toContain(expect_);
    }
  });
});
