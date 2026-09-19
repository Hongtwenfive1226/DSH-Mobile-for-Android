// Markdown.tsx — 把 Markdown（LLM 回复）渲染成 React Native 组件
//
// 用 markdown-it 做解析（token 流），自己映射到 RN 组件：
//  · 支持 标题 / 段落 / 粗体 / 斜体 / 删除线 / 行内代码 / 围栏代码块 /
//    有序·无序列表（含嵌套）/ 引用块 / 分隔线 / 表格 / 链接 / 图片链接
//  · 复用 App 的「宿主路径可点击下载」：普通文本里的 Windows 盘符路径仍可点
//  · 纯 JS 实现，无原生依赖

import React from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import MarkdownIt from 'markdown-it';

// 与 App.tsx 一致：Windows 盘符路径
const PATH_RE = /[A-Za-z]:[\\/][^\s"'<>|，。；：()\[\]]+/g;

/** markdown-it 的 token 最小结构（避免依赖 @types 的具体导出形态） */
interface MdToken {
  type: string;
  tag: string;
  nesting: number;
  level: number;
  content: string;
  info: string;
  markup: string;
  children: MdToken[] | null;
  attrGet(name: string): string | null;
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

interface Ctx {
  onPath?: (p: string) => void;
}

/* ------------------------------- 行内渲染 ------------------------------- */

// 把普通文本里的宿主路径切成可点击片段
function textWithPaths(text: string, keyPrefix: string, ctx: Ctx): React.ReactNode[] {
  if (!ctx.onPath) return [<Text key={keyPrefix}>{text}</Text>];
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(<Text key={`${keyPrefix}s${k++}`}>{text.slice(last, m.index)}</Text>);
    let p = m[0];
    while (p && /[.,;:!?、)]$/.test(p)) p = p.slice(0, -1);
    const target = p;
    nodes.push(
      <Text key={`${keyPrefix}p${k++}`} style={styles.pathLink} onPress={() => ctx.onPath?.(target)}>
        {target}
      </Text>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(<Text key={`${keyPrefix}e`}>{text.slice(last)}</Text>);
  return nodes;
}

/** 找到与 tokens[start] 配对的闭合 token，返回内部区间与闭合后的下标 */
function collect(tokens: MdToken[], start: number): { inner: MdToken[]; next: number } {
  const open = tokens[start].type;
  const close = open.replace(/_open$/, '_close');
  let depth = 0;
  for (let j = start; j < tokens.length; j += 1) {
    const t = tokens[j].type;
    if (t === open) depth += 1;
    else if (t === close) {
      depth -= 1;
      if (depth === 0) return { inner: tokens.slice(start + 1, j), next: j + 1 };
    }
  }
  return { inner: tokens.slice(start + 1), next: tokens.length };
}

function inlineNodes(tokens: MdToken[] | null, keyPrefix: string, ctx: Ctx): React.ReactNode[] {
  if (!tokens || tokens.length === 0) return [];
  const out: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < tokens.length) {
    const prev = i;
    const t = tokens[i];
    if (t.type === 'text') {
      out.push(...textWithPaths(t.content, `${keyPrefix}t${k++}`, ctx));
      i += 1;
    } else if (t.type === 'code_inline') {
      out.push(
        <Text key={`${keyPrefix}c${k++}`} style={styles.codeInline}>
          {t.content}
        </Text>,
      );
      i += 1;
    } else if (t.type === 'softbreak') {
      out.push(<Text key={`${keyPrefix}sb${k++}`}>{'\n'}</Text>);
      i += 1;
    } else if (t.type === 'hardbreak') {
      out.push(<Text key={`${keyPrefix}hb${k++}`}>{'\n'}</Text>);
      i += 1;
    } else if (t.type === 'strong_open') {
      const { inner, next } = collect(tokens, i);
      out.push(
        <Text key={`${keyPrefix}b${k++}`} style={styles.strong}>
          {inlineNodes(inner, `${keyPrefix}b${k}`, ctx)}
        </Text>,
      );
      i = next;
    } else if (t.type === 'em_open') {
      const { inner, next } = collect(tokens, i);
      out.push(
        <Text key={`${keyPrefix}e${k++}`} style={styles.em}>
          {inlineNodes(inner, `${keyPrefix}e${k}`, ctx)}
        </Text>,
      );
      i = next;
    } else if (t.type === 's_open') {
      const { inner, next } = collect(tokens, i);
      out.push(
        <Text key={`${keyPrefix}d${k++}`} style={styles.del}>
          {inlineNodes(inner, `${keyPrefix}d${k}`, ctx)}
        </Text>,
      );
      i = next;
    } else if (t.type === 'link_open') {
      const href = t.attrGet('href') ?? '';
      const { inner, next } = collect(tokens, i);
      out.push(
        <Text
          key={`${keyPrefix}l${k++}`}
          style={styles.link}
          onPress={() => {
            if (href) Linking.openURL(href).catch(() => {});
          }}
        >
          {inlineNodes(inner, `${keyPrefix}l${k}`, ctx)}
        </Text>,
      );
      i = next;
    } else if (t.type === 'image') {
      const src = t.attrGet('src') ?? '';
      out.push(
        <Text
          key={`${keyPrefix}i${k++}`}
          style={styles.link}
          onPress={() => {
            if (src) Linking.openURL(src).catch(() => {});
          }}
        >
          {`🖼 ${t.content || '图片'}`}
        </Text>,
      );
      i += 1;
    } else {
      i += 1;
    }
    // 保险：任何分支都必须让下标前进，避免死循环卡死 JS 线程
    if (i <= prev) i = prev + 1;
  }
  return out;
}

/* ------------------------------- 块级渲染 ------------------------------- */

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  return (
    <View style={styles.codeBlock}>
      {lang ? <Text style={styles.codeLang}>{lang}</Text> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text style={styles.codeText}>{code.replace(/\n$/, '')}</Text>
      </ScrollView>
    </View>
  );
}

/** 渲染一个列表（bullet/ordered），支持嵌套 */
function renderList(tokens: MdToken[], start: number, ctx: Ctx, keyPrefix: string): { node: React.ReactNode; next: number } {
  const ordered = tokens[start].type === 'ordered_list_open';
  const startAttr = Number(tokens[start].attrGet('start') ?? '1');
  const { inner, next } = collect(tokens, start);

  const items: React.ReactNode[] = [];
  let i = 0;
  let n = 0;
  while (i < inner.length) {
    const prev = i;
    if (inner[i].type !== 'list_item_open') {
      i += 1;
      continue;
    }
    const item = collect(inner, i);
    // 列表项内容：去掉最外层 paragraph 包装，交给块级渲染（可含嵌套列表）
    const marker = ordered ? `${startAttr + n}.` : '•';
    items.push(
      <View key={`${keyPrefix}li${n}`} style={styles.listItem}>
        <Text style={styles.listMarker}>{marker}</Text>
        <View style={styles.listItemBody}>{blockNodes(item.inner, `${keyPrefix}li${n}`, ctx)}</View>
      </View>,
    );
    n += 1;
    i = item.next;
    // 保险：任何分支都必须让下标前进，避免死循环卡死 JS 线程
    if (i <= prev) i = prev + 1;
  }
  return { node: <View key={keyPrefix}>{items}</View>, next };
}

function renderTable(tokens: MdToken[], start: number, ctx: Ctx, keyPrefix: string): { node: React.ReactNode; next: number } {
  const { inner, next } = collect(tokens, start);
  const rows: { header: boolean; cells: MdToken[][] }[] = [];
  let header = false;
  let i = 0;
  while (i < inner.length) {
    const prev = i;
    const t = inner[i];
    if (t.type === 'thead_open') {
      header = true;
      i += 1;
    } else if (t.type === 'thead_close') {
      header = false;
      i += 1;
    } else if (t.type === 'tr_open') {
      const row = collect(inner, i);
      const cells: MdToken[][] = [];
      let j = 0;
      while (j < row.inner.length) {
        const prevJ = j;
        if (row.inner[j].type === 'th_open' || row.inner[j].type === 'td_open') {
          const cell = collect(row.inner, j);
          const inline = cell.inner.find((c) => c.type === 'inline');
          cells.push(inline?.children ?? []);
          j = cell.next;
        } else {
          j += 1;
        }
        // 保险：任何分支都必须让下标前进，避免死循环卡死 JS 线程
        if (j <= prevJ) j = prevJ + 1;
      }
      rows.push({ header, cells });
      i = row.next;
    } else {
      i += 1;
    }
    if (i <= prev) i = prev + 1;
  }

  return {
    node: (
      <View key={keyPrefix} style={styles.table}>
        {rows.map((row, r) => (
          <View key={`${keyPrefix}r${r}`} style={[styles.tableRow, row.header && styles.tableHeadRow]}>
            {row.cells.map((cell, c) => (
              <View key={`${keyPrefix}r${r}c${c}`} style={styles.tableCell}>
                <Text style={[styles.tableCellText, row.header && styles.strong]}>
                  {inlineNodes(cell, `${keyPrefix}r${r}c${c}`, ctx)}
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    ),
    next,
  };
}

function blockNodes(tokens: MdToken[], keyPrefix: string, ctx: Ctx): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < tokens.length) {
    const prev = i;
    const t = tokens[i];
    switch (t.type) {
      case 'heading_open': {
        const level = Math.min(6, Math.max(1, Number(t.tag.slice(1)) || 1));
        const inline = tokens[i + 1];
        const headingStyle = level === 1 ? styles.h1 : level === 2 ? styles.h2 : level === 3 ? styles.h3 : styles.h4;
        out.push(
          <Text key={`${keyPrefix}h${k++}`} style={headingStyle}>
            {inlineNodes(inline?.children ?? null, `${keyPrefix}h${k}`, ctx)}
          </Text>,
        );
        i += 3;
        break;
      }
      case 'paragraph_open': {
        const inline = tokens[i + 1];
        out.push(
          <Text key={`${keyPrefix}p${k++}`} style={styles.para}>
            {inlineNodes(inline?.children ?? null, `${keyPrefix}p${k}`, ctx)}
          </Text>,
        );
        i += 3;
        break;
      }
      case 'fence':
      case 'code_block': {
        out.push(<CodeBlock key={`${keyPrefix}cb${k++}`} code={t.content} lang={(t.info || '').trim().split(/\s+/)[0]} />);
        i += 1;
        break;
      }
      case 'hr': {
        out.push(<View key={`${keyPrefix}hr${k++}`} style={styles.hr} />);
        i += 1;
        break;
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        const { node, next } = renderList(tokens, i, ctx, `${keyPrefix}ul${k++}`);
        out.push(node);
        i = next;
        break;
      }
      case 'blockquote_open': {
        const { inner, next } = collect(tokens, i);
        out.push(
          <View key={`${keyPrefix}q${k++}`} style={styles.quote}>
            {blockNodes(inner, `${keyPrefix}q${k}`, ctx)}
          </View>,
        );
        i = next;
        break;
      }
      case 'table_open': {
        const { node, next } = renderTable(tokens, i, ctx, `${keyPrefix}tb${k++}`);
        out.push(node);
        i = next;
        break;
      }
      case 'inline': {
        out.push(
          <Text key={`${keyPrefix}i${k++}`} style={styles.para}>
            {inlineNodes(t.children, `${keyPrefix}i${k}`, ctx)}
          </Text>,
        );
        i += 1;
        break;
      }
      default:
        i += 1;
    }
    // 保险：任何分支都必须让下标前进，避免死循环卡死 JS 线程
    if (i <= prev) i = prev + 1;
  }
  return out;
}

/* -------------------------------- 组件 -------------------------------- */

export interface MarkdownProps {
  text: string;
  onPath?: (p: string) => void;
}

/**
 * 单条消息的 Markdown 兜底：解析或渲染失败时退化为纯文本，
 * 而不是把整个列表（甚至整个界面）带崩。release 包里没有红屏，这一层很有用。
 */
class MarkdownBoundary extends React.Component<{ text: string; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error('[DSHMobile] markdown render failed, falling back to plain text', error);
  }
  render() {
    if (this.state.failed) return <Text style={styles.para}>{this.props.text}</Text>;
    return this.props.children;
  }
}

const Markdown = React.memo(function Markdown({ text, onPath }: MarkdownProps) {
  const nodes = React.useMemo(() => {
    try {
      const tokens = md.parse(text ?? '', {}) as unknown as MdToken[];
      return blockNodes(tokens, 'md', { onPath });
    } catch (error) {
      console.error('[DSHMobile] markdown parse failed, falling back to plain text', error);
      return null;
    }
  }, [text, onPath]);
  if (nodes === null) return <Text style={styles.para}>{text}</Text>;
  return (
    <MarkdownBoundary text={text}>
      <View>{nodes}</View>
    </MarkdownBoundary>
  );
});

export default Markdown;

const MONO = 'monospace';

const styles = StyleSheet.create({
  para: { fontSize: 15, lineHeight: 22, color: '#111' },
  h1: { fontSize: 20, lineHeight: 28, fontWeight: '700', color: '#111', marginTop: 8, marginBottom: 4 },
  h2: { fontSize: 18, lineHeight: 26, fontWeight: '700', color: '#111', marginTop: 8, marginBottom: 4 },
  h3: { fontSize: 16, lineHeight: 24, fontWeight: '700', color: '#111', marginTop: 6, marginBottom: 3 },
  h4: { fontSize: 15, lineHeight: 22, fontWeight: '700', color: '#111', marginTop: 6, marginBottom: 3 },
  strong: { fontWeight: '700' },
  em: { fontStyle: 'italic' },
  del: { textDecorationLine: 'line-through' },
  link: { color: '#3964fe', textDecorationLine: 'underline' },
  pathLink: { color: '#3964fe', textDecorationLine: 'underline' },
  codeInline: {
    fontFamily: MONO,
    fontSize: 13,
    color: '#c7254e',
    backgroundColor: 'rgba(0,0,0,0.05)',
  },
  codeBlock: {
    backgroundColor: '#f5f6f8',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e6e8ec',
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginVertical: 6,
  },
  codeLang: { fontSize: 11, color: '#98a2b3', marginBottom: 4 },
  codeText: { fontFamily: MONO, fontSize: 13, lineHeight: 19, color: '#24292f' },
  hr: { height: 1, backgroundColor: '#e3e6ea', marginVertical: 10 },
  quote: { borderLeftWidth: 3, borderLeftColor: '#d0d5dd', paddingLeft: 10, marginVertical: 6, opacity: 0.9 },
  listItem: { flexDirection: 'row', marginVertical: 2 },
  listMarker: { fontSize: 15, lineHeight: 22, color: '#111', minWidth: 18 },
  listItemBody: { flex: 1 },
  table: { borderWidth: 1, borderColor: '#e3e6ea', borderRadius: 6, marginVertical: 6, overflow: 'hidden' },
  tableRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#eef0f3' },
  tableHeadRow: { backgroundColor: '#f5f6f8' },
  tableCell: { flex: 1, paddingHorizontal: 8, paddingVertical: 5, borderRightWidth: 1, borderRightColor: '#eef0f3' },
  tableCellText: { fontSize: 13, lineHeight: 19, color: '#111' },
});
