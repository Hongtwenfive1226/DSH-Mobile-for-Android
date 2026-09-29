// App.tsx — DSH Mobile v3：侧边栏 + 工作区 + 设置 + 持久化 + 工具卡片 + 审批 + 会话/工作区管理
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  LayoutChangeEvent,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { pick, keepLocalCopy, types, isErrorWithCode, errorCodes } from '@react-native-documents/picker';
import { CachesDirectoryPath, readFile as fsReadFile, writeFile as fsWriteFile } from '@dr.pogodin/react-native-fs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DshClient } from './src/dsh/client';
import { DshLive } from './src/dsh/live';
import {
  buildQuestionAnswers,
  questionAnswered,
  setCustomDraft,
  toggleOptionDraft,
} from './src/dsh/questions';
import type { QuestionDraft } from './src/dsh/questions';
import Markdown from './src/ui/Markdown';
import ErrorBoundary from './src/ui/ErrorBoundary';
import type {
  AgentPresetEntry,
  AskUserQuestion,
  HistoryEntry,
  SessionEvent,
  SessionModelsValue,
  SessionSummary,
  WorkspaceView,
} from './src/dsh/types';

// TODO: 改成你自己的 Tailscale 转发器地址（也可在 App 内「设置」里改）
const DEFAULT_BASE_URL = 'http://YOUR_TAILSCALE_IP:8787';
const STORE_KEY = 'dsh_mobile_v3';

interface ImageRef {
  attachmentId: string;
  mediaType: string;
}

export type ChatItem =
  | { kind: 'msg'; id: string; role: 'user' | 'assistant'; text: string; reasoning?: string; streaming?: boolean; images?: ImageRef[] }
  | { kind: 'tool'; id: string; name: string; args: string; result?: string; isError?: boolean; done: boolean };

interface PendingApproval {
  clientId: string;
  eventId: string;
  sessionId: string;
  approvalId: string;
  toolName: string;
  reason?: string;
}

/** AI 提问（ask_user_question）：宿主通过 $events 的 user-questions/request 下发 */
interface PendingQuestion {
  clientId: string;
  eventId: string;
  sessionId: string;
  questions: AskUserQuestion[];
}

/** 0.2.0 的会话地址：普通会话 / 子代理会话 */
export function sessionAddress(s: SessionSummary): { kind: 'session'; sessionId: string } | { kind: 'subagent'; parentSessionId: string; childSessionId: string; mode: string } {
  const anyS = s as any;
  if (anyS.origin === 'subagent' && anyS.parentSessionId) {
    const mode = anyS.mode === 'one-shot' || anyS.mode === 'continuable' ? anyS.mode : 'continuable';
    return { kind: 'subagent', parentSessionId: anyS.parentSessionId, childSessionId: s.sessionId, mode };
  }
  return { kind: 'session', sessionId: s.sessionId };
}

// 单条工具参数/结果最多渲染的字符数。
// numberOfLines 只影响「显示几行」，文本节点仍要整段参与 Android 的排版与绘制，
// 实测真实会话里有 2.5 万字的 args、6.5 万字的结果 —— 先截断再渲染，避免超长文本节点。
const MAX_ARGS_CHARS = 800;
const MAX_RESULT_CHARS = 4000;
// 关闭虚拟化后所有已加载消息都真实挂载，因此给「一次会话里最多保留多少条」设一个上限，
// 避免一直往前翻把内存和渲染量堆到卡顿。到顶后停止加载（不裁剪已显示内容，避免视口跳动）。
const MAX_LOADED_ITEMS = 300;

function clipText(s: string, max: number): string {
  if (typeof s !== 'string' || s.length <= max) return s;
  return `${s.slice(0, max)}\n…（共 ${s.length} 字，已截断）`;
}

function extractText(content: any): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n\n');
}

function extractImageRefs(content: any): ImageRef[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: any) => b?.type === 'image' && typeof b?.attachmentId === 'string')
    .map((b: any) => ({ attachmentId: b.attachmentId, mediaType: b.mediaType || 'image/png' }));
}

// 思维链（reasoning）文本：assistant/message 的 content 中 type === 'reasoning' 的块
function extractReasoning(content: any): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b?.type === 'reasoning' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n');
}

function extractToolResult(data: any): { text: string; isError: boolean } {
  const content = data?.message?.content;
  let text = '';
  let isError = !!data?.error;
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0];
    if (typeof first?.content === 'string') text = first.content;
    else if (Array.isArray(first?.content)) text = extractText(first.content);
    else if (first?.content && typeof first?.content === 'object') text = JSON.stringify(first.content).slice(0, 300);
    isError = isError || !!first?.isError;
  }
  return { text, isError };
}

// 把一页历史事件解析成聊天条目（顺序不变，升序）
export function parseHistoryEvents(events: HistoryEntry[]): ChatItem[] {
  const out: ChatItem[] = [];
  for (const entry of events) {
    const ev = entry.event;
    if (ev.type === 'user/message') {
      const content = ev.data?.content ?? ev.data?.message?.content;
      const text = extractText(content);
      const images = extractImageRefs(content);
      if (text.trim() || images.length) out.push({ kind: 'msg', id: `u-${ev.seq}`, role: 'user', text, images: images.length ? images : undefined });
    } else if (ev.type === 'assistant/message') {
      const content = ev.data?.message?.content;
      // 只有空白的 text 不参与渲染：Markdown 解析后是空节点，只会留下一个空气泡（视觉上就是空白）
      const raw = extractText(content);
      const text = raw.trim() ? raw : '';
      const reasoning = extractReasoning(content);
      const images = extractImageRefs(content);
      if (text || reasoning || images.length) out.push({ kind: 'msg', id: `a-${ev.seq}`, role: 'assistant', text, reasoning: reasoning || undefined, images: images.length ? images : undefined });
    } else if (ev.type === 'tool/call') {
      const d = ev.data;
      out.push({ kind: 'tool', id: `t-${d.callId}`, name: d.name ?? '工具', args: clipText(d.arguments ?? '', MAX_ARGS_CHARS), done: false });
    } else if (ev.type === 'tool/result') {
      const d = ev.data;
      const { text, isError } = extractToolResult(d);
      const callId = d?.message?.content?.[0]?.toolCallId;
      const id = `t-${callId ?? ev.seq}`;
      const clipped = clipText(text, MAX_RESULT_CHARS);
      const item = out.find((x) => x.kind === 'tool' && x.id === id);
      if (item && item.kind === 'tool') {
        item.result = clipped;
        item.isError = isError;
        item.done = true;
      } else {
        out.push({ kind: 'tool', id, name: '工具', args: '', result: clipped, isError, done: true });
      }
    }
  }
  return out;
}

// 一页事件里的最小 seq（作为下一页 beforeSeq 的游标）
function minEventSeq(events: HistoryEntry[]): number | undefined {
  let min = Infinity;
  for (const e of events) if (e.event.seq < min) min = e.event.seq;
  return min === Infinity ? undefined : min;
}

/**
 * 打开会话：先取当前序号（throughSeq）与投影，再取一页历史。
 * DSH 0.2.0 把 `session.history` 换成了 `session/page`：
 *   请求 { address:{kind:'session',sessionId}, throughSeq, beforeSeq?, maxMessages? }
 *   返回 { records:[{type:'event', event:{type,seq,time,data}}], hasMore }
 * records 里的事件与旧版 history 同构，因此解析器不用改。
 */
async function loadHistory(
  client: DshClient,
  sessionId: string,
): Promise<{ items: ChatItem[]; tokenUsage: any | null; hasMore: boolean; oldestSeq: number | undefined; throughSeq: number; error?: string }> {
  const proj = await client.sessionProjections(sessionId);
  const throughSeq = proj.ok ? proj.value.asOfSeq : 0;
  const r = await client.page(sessionId, { throughSeq });
  if (!r.ok) {
    const msg = r.error?.code?.includes('not-found') ? '会话不存在' : `加载失败(${r.error?.code ?? 'unknown'})`;
    return { items: [], tokenUsage: null, hasMore: false, oldestSeq: undefined, throughSeq, error: r.error?.message ?? msg };
  }
  const events = r.value.records.map((rec: { event: SessionEvent }) => ({ event: rec.event }));
  const items = parseHistoryEvents(events);
  const tokenUsage = proj.ok ? ((proj.value.values as any)?.tokenUsage ?? null) : null;
  return { items, tokenUsage, hasMore: r.value.hasMore, oldestSeq: minEventSeq(events), throughSeq };
}

function sessionTitle(s: SessionSummary): string {
  const t = (s as any).projections?.values?.title;
  if (typeof t === 'string' && t) return t;
  return s.blank ? '(新会话)' : s.sessionId.slice(0, 8);
}

// 宿主路径识别（Windows 盘符路径；用于聊天里点击下载）
const PATH_RE = /[A-Za-z]:[\\/][^\s"'<>|，。；：()\[\]]+/g;

function renderPathText(text: string, onPath: (p: string) => void): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  PATH_RE.lastIndex = 0;
  let key = 0;
  while ((m = PATH_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(<Text key={`t${key++}`}>{text.slice(last, m.index)}</Text>);
    let p = m[0];
    while (p && /[.,;:!?、)]$/.test(p)) p = p.slice(0, -1);
    nodes.push(
      <Text key={`p${key++}`} style={styles.pathLink} onPress={() => onPath(p)}>
        {p}
      </Text>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(<Text key={`t${key++}`}>{text.slice(last)}</Text>);
  return nodes;
}

// 文件桥：上传到转发器 /files，存 shared-files/ 收件箱
async function uploadFile(baseUrl: string, name: string, data: string): Promise<{ path: string; name: string; bytes: number }> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/files`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, data }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// 文件桥：从转发器 /files 下载宿主文件
async function downloadFile(baseUrl: string, hostPath: string): Promise<{ name: string; data: string; bytes: number }> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/files?path=${encodeURIComponent(hostPath)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ------------------------- 单条消息行（memo 化） ------------------------- */
// 关闭虚拟化后，所有已加载的消息都真实挂载；如果每次流式增量（每个 chunk 都会 setItems）
// 都重建整棵列表，长会话会明显卡顿（表现出来同样是「一片空白 / 没反应」）。
// 这里把每行做成 React.memo：item 对象在流式更新时保持引用不变（setItems 只 map 命中的那一条），
// 回调都是 useCallback 稳定的，所以未变化的消息整棵子树直接跳过。
interface MessageRowProps {
  item: ChatItem;
  reasoningOpen: boolean;
  onToggleReasoning: (id: string) => void;
  onPath: (p: string) => void;
  onImage: (attachmentId: string, mediaType: string) => void;
  /** 设置里打开的排查开关：显示每条消息的下标 / id / 实测高度 */
  debug?: boolean;
  index?: number;
}

export const MessageRow = React.memo(function MessageRowImpl({
  item,
  reasoningOpen: open,
  onToggleReasoning,
  onPath,
  onImage,
  debug,
  index,
}: MessageRowProps) {
  // 只在排查开关打开时才记录高度，正常使用不产生任何额外状态更新
  const [measured, setMeasured] = useState<number | null>(null);
  const onLayout = debug
    ? (e: LayoutChangeEvent) => {
        const h = Math.round(e.nativeEvent.layout.height);
        setMeasured((prev) => (prev === h ? prev : h));
      }
    : undefined;
  const badge = debug ? (
    <Text style={styles.debugBadge}>
      #{index} {item.id} {item.kind === 'tool' ? 'tool' : item.role} h={measured ?? '?'}{' '}
      {item.kind === 'tool' ? `args=${item.args.length} res=${item.result?.length ?? 0}` : `text=${item.text.length} reasoning=${item.reasoning?.length ?? 0}`}
    </Text>
  ) : null;
  if (item.kind !== 'msg') {
    return (
      <View onLayout={onLayout}>
        {badge}
        <View style={styles.toolCard}>
          <View style={styles.toolHeader}>
            <Text style={styles.toolName}>
              {item.done ? (item.isError ? '✗ ' : '✓ ') : '⏳ '}
              {item.name}
            </Text>
            {!item.done && <ActivityIndicator size="small" color="#3964fe" />}
          </View>
          {item.args ? (
            <Text style={styles.toolArgs} numberOfLines={3}>
              {item.args}
            </Text>
          ) : null}
          {item.done && item.result ? (
            <Text style={[styles.toolResult, item.isError && styles.toolResultError]} numberOfLines={6}>
              {item.result}
            </Text>
          ) : null}
        </View>
      </View>
    );
  }
  return (
    <View onLayout={onLayout}>
      {badge}
      <View style={[styles.bubble, item.role === 'user' ? styles.userBubble : styles.assistantBubble]}>
      {item.role === 'assistant' && item.reasoning ? (
        <View style={styles.reasoningWrap}>
          <TouchableOpacity style={styles.reasoningToggle} onPress={() => onToggleReasoning(item.id)}>
            <Text style={styles.reasoningToggleText}>💭 思维链 {open ? '▾' : '▸'}</Text>
          </TouchableOpacity>
          {open ? (
            <Text style={styles.reasoningText}>
              {item.reasoning}
              {item.streaming ? '▍' : ''}
            </Text>
          ) : null}
        </View>
      ) : null}
      {item.role === 'assistant' ? (
        item.text ? (
          <Markdown text={item.streaming ? `${item.text} ▍` : item.text} onPath={onPath} />
        ) : item.streaming ? (
          <Text style={styles.bubbleText}>▍</Text>
        ) : null
      ) : (
        <Text style={[styles.bubbleText, styles.userText]}>
          {renderPathText(item.text, onPath)}
          {item.streaming ? '▍' : ''}
        </Text>
      )}
      {item.images?.map((im, i) => (
        <TouchableOpacity key={i} style={styles.imageDownloadBtn} onPress={() => onImage(im.attachmentId, im.mediaType)}>
          <Text style={styles.imageDownloadText}>🖼 下载图片</Text>
        </TouchableOpacity>
      ))}
      </View>
    </View>
  );
});

// 纯黑色回形针矢量图标（Material Design attach_file 路径）
function PaperclipIcon({ size = 22, color = '#000' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"
        fill={color}
      />
    </Svg>
  );
}

export default function App() {
  // 连接
  const [serverUrl, setServerUrl] = useState(DEFAULT_BASE_URL);
  const [appliedUrl, setAppliedUrl] = useState(DEFAULT_BASE_URL);
  const [status, setStatus] = useState('连接中…');
  const [hostLine, setHostLine] = useState('');
  const [hydrated, setHydrated] = useState(false);

  // 数据
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [presets, setPresets] = useState<AgentPresetEntry[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [models, setModels] = useState<SessionModelsValue | null>(null);
  const [archivedSessionIds, setArchivedSessionIds] = useState<string[]>([]);
  const [showArchived, setShowArchived] = useState(false);

  // 聊天
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<{ uncachedInputTokens: number; outputTokens: number; cacheReadTokens: number } | null>(null);
  const [kbHeight, setKbHeight] = useState(0);
  const [reasoningOpen, setReasoningOpen] = useState<Record<string, boolean>>({});
  const [loadingOlder, setLoadingOlder] = useState(false);
  // 会话历史的加载状态：避免「还在加载」被误看成整片空白
  const [historyStatus, setHistoryStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [historyError, setHistoryError] = useState<string | null>(null);

  // UI
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [view, setView] = useState<'chat' | 'settings'>('chat');
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, QuestionDraft>>({});
  const [questionBusy, setQuestionBusy] = useState(false);
  const [questionError, setQuestionError] = useState<string | null>(null);
  const [actionTarget, setActionTarget] = useState<
    { kind: 'session'; s: SessionSummary } | { kind: 'workspace'; w: WorkspaceView } | null
  >(null);
  const [renameText, setRenameText] = useState('');
  const [newWsOpen, setNewWsOpen] = useState(false);
  const [newWsPath, setNewWsPath] = useState('');
  const [renameOpen, setRenameOpen] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [downloadPath, setDownloadPath] = useState('');
  const [modeOpen, setModeOpen] = useState(false);
  // 排查开关：在每条消息上方显示「下标 / 事件 id / 实测高度 / 字数」。
  // 万一还看到空白，打开它截图就能直接指认是哪一条（id 就是会话日志里的事件 seq）。
  const [layoutDebug, setLayoutDebug] = useState(false);

  const clientRef = useRef<DshClient | null>(null);
  const sessionRef = useRef<string | null>(null);
  const streamRef = useRef<{ id: string } | null>(null);
  // DSH 0.2.0 的实时通道（remote.mux + $events/control/workspace/session 四条流）
  const liveRef = useRef<DshLive | null>(null);
  const liveClientIdRef = useRef<string | null>(null);
  // 刷新列表（供 live 回调里调用，避免定义顺序依赖）
  const refreshListsRef = useRef<(() => Promise<void>) | null>(null);
  const listRef = useRef<FlatList<ChatItem>>(null);
  // 反转列表下「是否停在最新一条」，仅用于展示/后续扩展；滚动定位不再依赖它
  const isAtBottomRef = useRef(true);
  const restoreSessionRef = useRef<string | null>(null);
  // 历史分页游标
  const historyHasMoreRef = useRef(false);
  const historyOldestSeqRef = useRef<number | undefined>(undefined);
  // session/page 需要固定一个 throughSeq（「看到哪个序号为止」），翻页时必须沿用
  const throughSeqRef = useRef(0);
  const loadingOlderRef = useRef(false);
  // 最新的会话/工作区列表（供 useCallback 内部读取，避免把 state 塞进依赖）
  const sessionsRef = useRef<SessionSummary[]>([]);
  const workspacesRef = useRef<WorkspaceView[]>([]);
  // 已加载条数（给 loadOlder 的上限判断用，避免把 items 塞进 useCallback 依赖）
  const itemsCountRef = useRef(0);

  /**
   * 把 session/control 的 projections 合并进会话列表（标题、token 用量等），
   * 并同步当前会话的 token 用量。
   */
  const applyProjections = useCallback((projections: Record<string, { asOfSeq?: number; values?: Record<string, any> }>) => {
    setSessions((prev) =>
      prev.map((s) => {
        const p = projections[s.sessionId];
        if (!p?.values) return s;
        const old = (s as any).projections ?? {};
        return {
          ...s,
          projections: { ...old, asOfSeq: p.asOfSeq ?? old.asOfSeq, values: { ...(old.values ?? {}), ...p.values } },
        } as SessionSummary;
      }),
    );
    const activeId = sessionRef.current;
    if (activeId && projections[activeId]?.values?.tokenUsage) setTokenUsage(projections[activeId].values.tokenUsage);
  }, []);

  useEffect(() => {
    itemsCountRef.current = items.length;
  }, [items]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);

  // 载入持久化设置
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORE_KEY);
        if (raw) {
          const s = JSON.parse(raw);
          if (typeof s.serverUrl === 'string' && s.serverUrl) {
            setServerUrl(s.serverUrl);
            setAppliedUrl(s.serverUrl);
          }
          if (typeof s.selectedPreset === 'string') setSelectedPreset(s.selectedPreset);
          if (typeof s.activeWorkspaceId === 'string') setActiveWorkspaceId(s.activeWorkspaceId);
          if (typeof s.activeSessionId === 'string') restoreSessionRef.current = s.activeSessionId;
          if (s.layoutDebug === true) setLayoutDebug(true);
        }
      } catch {}
      setHydrated(true);
    })();
  }, []);

  // 持久化
  useEffect(() => {
    if (!hydrated) return;
    AsyncStorage.setItem(
      STORE_KEY,
      JSON.stringify({ serverUrl: appliedUrl, selectedPreset, activeWorkspaceId, activeSessionId, layoutDebug }),
    ).catch(() => {});
  }, [hydrated, appliedUrl, selectedPreset, activeWorkspaceId, activeSessionId, layoutDebug]);

  // 连接 / 重连
  useEffect(() => {
    if (!hydrated) return;
    let mounted = true;
    const client = new DshClient(appliedUrl);
    clientRef.current = client;
    sessionRef.current = null;
    streamRef.current = null;
    setActiveSessionId(null);
    setItems([]);
    setModels(null);
    setTokenUsage(null);
    setStatus('连接中…');

    // session/follow 的条目形态（0.2.0）：
    //   {type:'snapshot', header}                                  → 会话快照
    //   {type:'event', event:{type,seq,time,data}}                 → 会话事件（与历史页同构）
    //   {type:'assistant-stream', frame:{type:'chunk', chunk:{…}}}  → 助手增量（块类型与旧版一致）
    const handleSessionItem = (item: any) => {
      if (!item || typeof item !== 'object') return;
      if (item.type === 'assistant-stream') {
        const chunk = item.frame?.chunk;
        if (!chunk) return;
        const ensureStream = () => {
          if (!streamRef.current) {
            const id = `a-${item.frame?.revision ?? Date.now()}`;
            streamRef.current = { id };
            setItems((prev) => [...prev, { kind: 'msg', id, role: 'assistant', text: '', reasoning: '', streaming: true }]);
          }
          return streamRef.current.id;
        };
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          const sid = ensureStream();
          setItems((prev) => prev.map((m) => (m.kind === 'msg' && m.id === sid ? { ...m, text: m.text + chunk.text } : m)));
        } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
          const sid = ensureStream();
          setItems((prev) => prev.map((m) => (m.kind === 'msg' && m.id === sid ? { ...m, reasoning: (m.reasoning ?? '') + chunk.text } : m)));
        }
        return;
      }
      if (item.type !== 'event') return;
      const ev = item.event;
      if (!ev) return;

      if (ev.type === 'assistant/chunk') {
        const chunk = ev.data?.chunk;
        const ensureStream = () => {
          if (!streamRef.current) {
            const id = `a-${ev.seq}`;
            streamRef.current = { id };
            setItems((prev) => [...prev, { kind: 'msg', id, role: 'assistant', text: '', reasoning: '', streaming: true }]);
          }
          return streamRef.current.id;
        };
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          const sid = ensureStream();
          setItems((prev) => prev.map((m) => (m.kind === 'msg' && m.id === sid ? { ...m, text: m.text + chunk.text } : m)));
        } else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
          const sid = ensureStream();
          setItems((prev) => prev.map((m) => (m.kind === 'msg' && m.id === sid ? { ...m, reasoning: (m.reasoning ?? '') + chunk.text } : m)));
        }
      } else if (ev.type === 'assistant/message') {
        const content = ev.data?.message?.content;
        const text = extractText(content);
        const reasoning = extractReasoning(content);
        const images = extractImageRefs(content);
        if (streamRef.current) {
          const sid = streamRef.current.id;
          setItems((prev) => prev.map((m) => (m.kind === 'msg' && m.id === sid ? { ...m, text: text || m.text, reasoning: reasoning || m.reasoning, streaming: false, images: images.length ? images : m.images } : m)));
          streamRef.current = null;
        } else if (text || reasoning || images.length) {
          setItems((prev) => [...prev, { kind: 'msg', id: `a-${ev.seq}`, role: 'assistant', text, reasoning: reasoning || undefined, images: images.length ? images : undefined }]);
        }
      } else if (ev.type === 'tool/call') {
        const d = ev.data;
        setItems((prev) => [...prev, { kind: 'tool', id: `t-${d.callId}`, name: d.name, args: d.arguments ?? '', done: false }]);
      } else if (ev.type === 'tool/result') {
        const d = ev.data;
        const { text, isError } = extractToolResult(d);
        const callId = d?.message?.content?.[0]?.toolCallId;
        const id = `t-${callId ?? ev.seq}`;
        setItems((prev) =>
          prev.map((x) => (x.kind === 'tool' && x.id === id ? { ...x, result: text, isError, done: true } : x)),
        );
      } else if (ev.type === 'turn/end') {
        streamRef.current = null;
        setBusy(false);
      }
    };

    // ---------------- DSH 0.2.0 实时通道 ----------------
    // 四条逻辑流：
    //   $events（DshLive 内部订阅）→ 审批 approval/request、AI 提问 user-questions/request、
    //                               会话增删/状态 api-session/*
    //   session/control            → 各会话 projections（标题、token 用量…）
    //   workspace/follow           → 工作区列表（baseline + 增量）
    //   session/follow             → 当前会话的事件记录 + 助手增量帧
    const live = new DshLive(appliedUrl, {
      onState: (open) => setStatus((s) => (open ? '已连接' : s.startsWith('连接失败') ? s : '连接中…')),
      onReady: (info) => { liveClientIdRef.current = info.clientId; },
      onEvent: (frame) => {
        // waterfall 的载荷在 frame.request，emit 的载荷在 args[0]
        const p: any = (frame as any).request ?? frame.args?.[0] ?? {};
        if (frame.event === 'approval/request') {
          setPendingApproval({
            clientId: frame.clientId,
            eventId: frame.eventId,
            sessionId: p.sessionId ?? p.agent?.sessionId ?? sessionRef.current ?? '',
            approvalId: p.approvalId ?? p.callId ?? '',
            toolName: p.toolName ?? p.tool ?? '工具',
            reason: p.reason ?? p.displayReason,
          });
          return;
        }
        if (frame.event === 'user-questions/request') {
          const questions: AskUserQuestion[] = Array.isArray(p.questions) ? p.questions : [];
          if (questions.length === 0) return;
          setPendingQuestion({
            clientId: frame.clientId,
            eventId: frame.eventId,
            sessionId: p.sessionId ?? sessionRef.current ?? '',
            questions,
          });
          setQuestionDrafts(Object.fromEntries(questions.map((q) => [q.id, { selected: [], custom: '' } as QuestionDraft])));
          setQuestionBusy(false);
          return;
        }
        if (frame.event === 'api-session/added' || frame.event === 'api-session/removed') {
          void refreshListsRef.current?.();
          return;
        }
        if (frame.event === 'api-session/status' || frame.event === 'api-session/activity') {
          const [sid, value] = frame.args as [string, any];
          setSessions((prev) =>
            prev.map((s) =>
              s.sessionId === sid
                ? { ...s, running: frame.event === 'api-session/status' ? Boolean(value) : s.running, updatedAt: frame.event === 'api-session/activity' ? Number(value) : s.updatedAt }
                : s,
            ),
          );
        }
      },
      onControl: (item) => {
        if (!item || typeof item !== 'object') return;
        if (item.type === 'baseline') {
          const projections = item.value?.projections ?? {};
          applyProjections(projections);
          return;
        }
        if (item.type === 'projection' && item.sessionId) {
          applyProjections({ [item.sessionId]: { asOfSeq: item.seq, values: { [item.key]: item.value } } });
        }
      },
      onWorkspace: (item) => {
        if (!item || typeof item !== 'object') return;
        if (item.type === 'baseline') {
          const items = item.value?.items ?? [];
          setWorkspaces(items);
          setArchivedSessionIds(items.flatMap((w: any) => w.archivedSessionIds ?? []));
          return;
        }
        if (item.type === 'upsert') {
          setWorkspaces((prev) => {
            const next = prev.filter((w) => w.workspaceId !== item.workspaceId);
            next.push({ workspaceId: item.workspaceId, path: item.path, title: item.title, sessionIds: item.sessionIds, createdAt: item.createdAt, updatedAt: item.updatedAt });
            return next;
          });
          return;
        }
        if (item.type === 'remove') { setWorkspaces((prev) => prev.filter((w) => w.workspaceId !== item.workspaceId)); return; }
        if (item.type === 'order') {
          setWorkspaces((prev) => {
            const byId = new Map(prev.map((w) => [w.workspaceId, w]));
            const ordered = item.workspaceIds.map((id: string) => byId.get(id)).filter(Boolean) as WorkspaceView[];
            for (const w of prev) if (!item.workspaceIds.includes(w.workspaceId)) ordered.push(w);
            return ordered;
          });
          return;
        }
        if (item.type === 'archived') { setArchivedSessionIds(item.archivedSessionIds ?? []); }
      },
      onSession: (item) => handleSessionItem(item),
      onStreamError: (endpoint, error) => {
        if (endpoint === 'session/follow') setStatus(`会话流中断：${error.code}`);
      },
    });
    liveRef.current = live;

    (async () => {
      const [s, pr, mc] = await Promise.all([client.listSessions(), client.listAgentPresets(), client.getModelCatalog()]);
      if (!mounted) return;
      if (s.ok) { setSessions(s.value.items); setStatus('已连接'); }
      else setStatus('连接失败: ' + s.error.code);
      if (pr.ok) {
        setPresets(pr.value.presets);
        setSelectedPreset((old) => old ?? pr.value.presets.find((x) => x.id === 'minimal-bash')?.id ?? pr.value.presets.find((x) => x.id === 'minimal')?.id ?? pr.value.presets.find((x) => x.isDefault)?.id ?? null);
      }
      if (mc.ok) {
        setModels({ current: mc.value.default, routable: mc.value.routableProviders.length > 0, groups: mc.value.groups, failures: [] });
        setHostLine(`${mc.value.default.provider} · ${mc.value.default.model}`);
      }
      const list = s.ok ? s.value.items : [];
      const restore = restoreSessionRef.current;
      const target = (restore && list.find((x) => x.sessionId === restore)) || list.find((x) => !x.blank) || list[0];
      restoreSessionRef.current = null;
      if (target) {
        sessionRef.current = target.sessionId;
        setActiveSessionId(target.sessionId);
        live.followSession(sessionAddress(target));
        const res = await loadHistory(client, target.sessionId);
        isAtBottomRef.current = true;
        setItems(res.items);
        historyHasMoreRef.current = res.hasMore;
        historyOldestSeqRef.current = res.oldestSeq;
        throughSeqRef.current = res.throughSeq;
        if (res.tokenUsage) setTokenUsage(res.tokenUsage);
      }
    })();

    live.connect();
    live.subscribe('control', 'session/control', {});
    live.subscribe('workspace', 'workspace/follow', {});

    return () => {
      mounted = false;
      live.close();
      liveRef.current = null;
    };
  }, [hydrated, appliedUrl, applyProjections]);

  const visibleSessions = useCallback(() => {
    let list = sessions;
    if (activeWorkspaceId) {
      const ws = workspaces.find((w) => w.workspaceId === activeWorkspaceId);
      list = ws ? sessions.filter((s) => ws.sessionIds.includes(s.sessionId)) : sessions;
    }
    if (!showArchived) list = list.filter((s) => !archivedSessionIds.includes(s.sessionId));
    return list;
  }, [sessions, workspaces, activeWorkspaceId, showArchived, archivedSessionIds]);

  const refreshLists = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    // 工作区列表由 workspace/follow 流维护，这里只刷新会话列表
    const s = await c.listSessions();
    if (s.ok) setSessions(s.value.items);
  }, []);

  useEffect(() => {
    refreshListsRef.current = refreshLists;
  }, [refreshLists]);

  // 滑到「最旧」一端时加载更早的一页历史
  // 反转列表下，更早的消息追加到反转数据的末尾（视觉上方），不会移动当前视口，
  // 因此这里不需要任何滚动位置补偿。
  const loadOlder = useCallback(async () => {
    const c = clientRef.current;
    const sid = sessionRef.current;
    if (!c || !sid) return;
    if (loadingOlderRef.current || !historyHasMoreRef.current) return;
    if (itemsCountRef.current >= MAX_LOADED_ITEMS) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      // 翻页沿用首次取到的 throughSeq（0.2.0 的 page 需要固定同一个「看到哪」的序号）
      const r = await c.page(sid, { throughSeq: throughSeqRef.current, beforeSeq: historyOldestSeqRef.current });
      if (!r.ok || sessionRef.current !== sid) return;
      const events = r.value.records.map((rec: { event: SessionEvent }) => ({ event: rec.event }));
      const older = parseHistoryEvents(events);
      const nextOldest = minEventSeq(events);
      if (older.length > 0) setItems((prev) => [...older, ...prev]);
      if (nextOldest !== undefined) historyOldestSeqRef.current = nextOldest;
      historyHasMoreRef.current = r.value.hasMore;
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, []);

  const toggleReasoning = useCallback((id: string) => {
    setReasoningOpen((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const openSession = useCallback(async (sid: string) => {
    const c = clientRef.current;
    if (!c) return;
    isAtBottomRef.current = true;
    sessionRef.current = sid;
    setActiveSessionId(sid);
    setItems([]);
    setBusy(false);
    setTokenUsage(null);
    setSidebarOpen(false);
    setReasoningOpen({});
    setKbHeight(0);
    historyHasMoreRef.current = false;
    historyOldestSeqRef.current = undefined;
    throughSeqRef.current = 0;
    loadingOlderRef.current = false;
    setHistoryStatus('loading');
    setHistoryError(null);
    // 跟随该会话：事件记录 + 助手增量都从这里来
    const s = sessionsRef.current.find((x) => x.sessionId === sid);
    liveRef.current?.followSession(s ? sessionAddress(s) : { kind: 'session', sessionId: sid });
    const res = await loadHistory(c, sid);
    setItems(res.items);
    historyHasMoreRef.current = res.hasMore;
    historyOldestSeqRef.current = res.oldestSeq;
    throughSeqRef.current = res.throughSeq;
    if (res.tokenUsage) setTokenUsage(res.tokenUsage);
    if (res.error) {
      setHistoryError(res.error);
      setHistoryStatus('error');
    } else {
      setHistoryStatus('ready');
    }
  }, []);

  const createNewSession = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    // 0.2.0 的 session/create 用 cwd（工作区路径）而不是 workspaceId
    const ws = activeWorkspaceId ? workspacesRef.current.find((w) => w.workspaceId === activeWorkspaceId) : undefined;
    const r = await c.createSession({
      cwd: ws?.path,
      agentPreset: selectedPreset ?? undefined,
    });
    if (r.ok) {
      sessionRef.current = r.value.sessionId;
      setActiveSessionId(r.value.sessionId);
      setItems([]);
      isAtBottomRef.current = true;
      setReasoningOpen({});
      historyHasMoreRef.current = false;
      historyOldestSeqRef.current = undefined;
      throughSeqRef.current = 0;
      loadingOlderRef.current = false;
      setHistoryStatus('ready');
      setHistoryError(null);
      setKbHeight(0);
      setBusy(false);
      setSidebarOpen(false);
      liveRef.current?.followSession({ kind: 'session', sessionId: r.value.sessionId });
      refreshLists();
    } else {
      setStatus('建会话失败: ' + r.error.code);
    }
  }, [activeWorkspaceId, selectedPreset, refreshLists]);

  const send = useCallback(async () => {
    const text = input.trim();
    const c = clientRef.current;
    const sid = sessionRef.current;
    if (!text || !c || !sid || busy) return;
    setInput('');
    setBusy(true);
    setItems((prev) => [...prev, { kind: 'msg', id: `u-${Date.now()}`, role: 'user', text }]);
    // 反转列表下偏移 0 即最新一条：发消息后主动回到最新（用户此前可能在上滑回看）
    requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: true }));
    try {
      const r = await c.prompt({ sessionId: sid, mode: 'queue', content: [{ type: 'text', text }] });
      if (!r.ok) {
        setBusy(false);
        setStatus('发送失败: ' + r.error.code);
      }
    } catch (e: any) {
      setBusy(false);
      setStatus('发送异常: ' + (e?.message ?? String(e)));
    }
  }, [input, busy]);

  const stop = useCallback(async () => {
    const c = clientRef.current;
    const sid = sessionRef.current;
    if (!c || !sid) return;
    setBusy(false);
    try {
      await c.cancel(sid);
    } catch {
      setStatus('停止失败');
    }
  }, []);

  const loadModels = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    // 0.2.0 的模型目录是进程级的：session/modelCatalog → { default, routableProviders, groups }
    const r = await c.getModelCatalog();
    if (r.ok) setModels({ current: r.value.default, routable: r.value.routableProviders.length > 0, groups: r.value.groups, failures: [] });
  }, []);

  const selectModel = useCallback(async (provider: string, model: string) => {
    const c = clientRef.current;
    const sid = sessionRef.current;
    if (!c || !sid) return;
    const r = await c.selectModel(sid, provider, model);
    if (r.ok) {
      setStatus('已切换模型: ' + model);
      loadModels();
    } else {
      setStatus('切换模型失败: ' + r.error.code);
    }
  }, [loadModels]);

  const selectPreset = useCallback((id: string) => {
    setSelectedPreset(id);
  }, []);

  // 切换当前会话的模式（Agent 预设）
  const switchMode = useCallback(async (presetId: string) => {
    const c = clientRef.current;
    const sid = sessionRef.current;
    if (!c || !sid) return;
    setModeOpen(false);
    const r = await c.selectAgentPreset(sid, presetId);
    if (r.ok) {
      setStatus('已切换模式: ' + presetId);
      refreshLists();
    } else {
      setStatus('切换模式失败: ' + r.error.code);
    }
  }, [refreshLists]);

  const applyServerUrl = useCallback(() => {
    const url = serverUrl.trim().replace(/\/+$/, '');
    if (!url) return;
    setAppliedUrl(url);
    setView('chat');
  }, [serverUrl]);

  const pickFile = useCallback(async () => {
    try {
      const [file] = await pick({ mode: 'import', type: [types.allFiles] });
      if (!file) return;
      setStatus('上传中…');
      const [copy] = await keepLocalCopy({
        files: [{ uri: file.uri, fileName: file.name ?? 'file' }],
        destination: 'cachesDirectory',
      });
      if (copy.status !== 'success') throw new Error(copy.copyError);
      const base64 = await fsReadFile(copy.localUri, 'base64');
      const up = await uploadFile(appliedUrl, file.name ?? 'file', base64);
      setInput((prev) => (prev ? prev + ' ' : '') + up.path);
      setStatus('已上传: ' + up.path);
    } catch (e) {
      if (!isErrorWithCode(e) || e.code !== errorCodes.OPERATION_CANCELED) setStatus('选择/上传文件失败');
    }
  }, [appliedUrl]);

  const downloadImage = useCallback(async (attachmentId: string, mediaType: string) => {
    const c = clientRef.current;
    const sid = sessionRef.current;
    if (!c || !sid) return;
    setStatus('下载图片中…');
    const r = await c.getAttachment(sid, attachmentId);
    if (!r.ok) {
      setStatus('下载失败: ' + r.error.code);
      return;
    }
    const ext = (r.value.attachment.mediaType || mediaType).split('/')[1] || 'png';
    const path = `${CachesDirectoryPath}/dsh-download-${Date.now()}.${ext}`;
    try {
      await fsWriteFile(path, r.value.data, 'base64');
      await Share.share({ url: 'file://' + path, title: r.value.attachment.name || '下载的文件' });
      setStatus('已弹出保存/分享');
    } catch {
      setStatus('保存失败');
    }
  }, []);

  // 按宿主路径下载任意文件（文件桥）
  const downloadByPath = useCallback(async (hostPath: string) => {
    try {
      setStatus('下载中…');
      const f = await downloadFile(appliedUrl, hostPath);
      const local = `${CachesDirectoryPath}/${f.name}`;
      await fsWriteFile(local, f.data, 'base64');
      await Share.share({ url: 'file://' + local, title: f.name });
      setStatus('已弹出保存/分享');
    } catch {
      setStatus('下载失败');
    }
  }, [appliedUrl]);

  // 审批应答：0.2.0 通过 $events/result 回复「转发事件」，值是结果词表里的字符串
  const respondApproval = useCallback(async (outcome: 'allowed-once' | 'rejected') => {
    if (!pendingApproval) return;
    const { clientId, eventId } = pendingApproval;
    setPendingApproval(null);
    try {
      await clientRef.current?.answerEvent(clientId, eventId, { kind: 'result', value: outcome });
    } catch {
      setStatus('审批应答失败');
    }
  }, [pendingApproval]);

  // 提交 AI 提问的答案
  const submitQuestion = useCallback(async () => {
    if (!pendingQuestion || questionBusy) return;
    if (!questionAnswered(pendingQuestion.questions, questionDrafts)) {
      setQuestionError('请为每个问题选择选项或填写答案');
      return;
    }
    setQuestionBusy(true);
    setQuestionError(null);
    const { clientId, eventId, questions } = pendingQuestion;
    try {
      const r = await clientRef.current?.answerEvent(clientId, eventId, {
        kind: 'result',
        value: { answers: buildQuestionAnswers(questions, questionDrafts) },
      });
      if (r && !r.ok) {
        setQuestionBusy(false);
        setQuestionError(`提交被拒绝（${r.error.code}）`);
        return;
      }
      setPendingQuestion(null);
    } catch (e: any) {
      setQuestionBusy(false);
      setQuestionError(`提交失败：${e?.message ?? String(e)}`);
    }
  }, [pendingQuestion, questionDrafts, questionBusy]);

  // 取消 AI 提问（以 rejected 结算，宿主把该次工具调用判为 cancelled）
  const cancelQuestion = useCallback(async () => {
    if (!pendingQuestion || questionBusy) return;
    setQuestionBusy(true);
    setQuestionError(null);
    const { clientId, eventId } = pendingQuestion;
    try {
      await clientRef.current?.answerEvent(clientId, eventId, {
        kind: 'rejected',
        error: { code: 'cancelled', message: 'the user closed this question request', details: {} },
      });
      setPendingQuestion(null);
    } catch (e: any) {
      setQuestionBusy(false);
      setQuestionError(`取消失败：${e?.message ?? String(e)}`);
    }
  }, [pendingQuestion, questionBusy]);

  // 切换某个问题的某个选项（单选互斥，多选取反）
  const toggleOption = useCallback((question: AskUserQuestion, label: string) => {
    setQuestionError(null);
    setQuestionDrafts((prev) => {
      const cur = prev[question.id] ?? { selected: [], custom: '' };
      return { ...prev, [question.id]: toggleOptionDraft(question, cur, label) };
    });
  }, []);

  const setQuestionCustom = useCallback((question: AskUserQuestion, text: string) => {
    setQuestionError(null);
    setQuestionDrafts((prev) => {
      const cur = prev[question.id] ?? { selected: [], custom: '' };
      return { ...prev, [question.id]: setCustomDraft(question, cur, text) };
    });
  }, []);

  // 会话/工作区操作
  const confirmRename = useCallback(async () => {
    const t = actionTarget;
    const c = clientRef.current;
    const title = renameText.trim();
    if (!t || !c || !title) return;
    if (t.kind === 'session') {
      const r = await c.renameSession(t.s.sessionId, title);
      if (r.ok) setStatus('已重命名: ' + r.value.title);
    } else {
      const r = await c.renameWorkspace(t.w.workspaceId, title);
      if (r.ok) setStatus('工作区已重命名');
    }
    setActionTarget(null);
    setRenameOpen(false);
    setRenameText('');
    refreshLists();
  }, [actionTarget, renameText, refreshLists]);

  const archiveSession = useCallback(async () => {
    const t = actionTarget;
    const c = clientRef.current;
    if (!t || t.kind !== 'session' || !c) return;
    const r = await c.archiveSession(t.s.sessionId);
    setActionTarget(null);
    if (r.ok) {
      setStatus('已归档会话');
      refreshLists();
      if (t.s.sessionId === sessionRef.current) {
        sessionRef.current = null;
        setActiveSessionId(null);
        setItems([]);
      }
    }
  }, [actionTarget, refreshLists]);

  const deleteWorkspace = useCallback(async () => {
    const t = actionTarget;
    const c = clientRef.current;
    if (!t || t.kind !== 'workspace' || !c) return;
    const r = await c.deleteWorkspace(t.w.workspaceId);
    setActionTarget(null);
    if (r.ok) {
      setStatus('已删除工作区');
      if (activeWorkspaceId === t.w.workspaceId) setActiveWorkspaceId(null);
      refreshLists();
    }
  }, [actionTarget, activeWorkspaceId, refreshLists]);

  const createWorkspace = useCallback(async () => {
    const path = newWsPath.trim();
    const c = clientRef.current;
    if (!path || !c) return;
    const r = await c.createWorkspace(path);
    setNewWsOpen(false);
    setNewWsPath('');
    if (r.ok) {
      setStatus(r.value.created ? '已创建工作区' : '工作区已存在');
      refreshLists();
    } else {
      setStatus('创建工作区失败: ' + r.error.code);
    }
  }, [newWsPath, refreshLists]);

  const activeWorkspace = workspaces.find((w) => w.workspaceId === activeWorkspaceId);
  const currentSession = sessions.find((s) => s.sessionId === activeSessionId);

  // 手动键盘监听：键盘弹出时把底部内容顶上去（零依赖，规避 RN edge-to-edge 下 adjustResize 失效）
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const subs = [
      Keyboard.addListener(showEvent, (e: any) => setKbHeight(e.endCoordinates?.height ?? 0)),
      Keyboard.addListener(hideEvent, () => setKbHeight(0)),
    ];
    // 双保险：某些机型/场景只发 will* 或 did*，漏掉任何一个都会残留底部空白
    if (Platform.OS !== 'ios') {
      subs.push(Keyboard.addListener('keyboardWillHide' as any, () => setKbHeight(0)));
      subs.push(Keyboard.addListener('keyboardWillShow' as any, (e: any) => setKbHeight(e?.endCoordinates?.height ?? 0)));
    }
    return () => { for (const s of subs) s.remove(); };
  }, []);

  // 反转列表数据：最新在前（配合 inverted，偏移 0 = 最新一条 = 视觉底部）
  const listData = useMemo(() => (items.length > 1 ? [...items].reverse() : items), [items]);

  return (
    <SafeAreaProvider>
      {/* 最外层兜底：任何未预期的渲染异常都显示成可读的错误面板，而不是整屏白屏 */}
      <ErrorBoundary label="应用">
      <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
        {view === 'chat' ? (
        <>
          <View style={styles.header}>
            <TouchableOpacity onPress={() => setSidebarOpen(true)} style={styles.hamburger}>
              <Text style={styles.hamburgerText}>☰</Text>
            </TouchableOpacity>
            <View style={styles.headerCenter}>
              <Text style={styles.title} numberOfLines={1}>
                {activeWorkspace ? activeWorkspace.title : 'DeepSeek Harness'}
              </Text>
              <Text style={styles.status} numberOfLines={1}>
                {status}
                {hostLine ? ` · ${hostLine}` : ''}
              </Text>
              <Text style={styles.tokenLine} numberOfLines={1}>
                ↑ {tokenUsage?.uncachedInputTokens ?? 0} · ↓ {tokenUsage?.outputTokens ?? 0} · 缓存 {tokenUsage?.cacheReadTokens ?? 0}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => { loadModels(); setView('settings'); }}
              style={styles.gear}
            >
              <Text style={styles.gearText}>⚙</Text>
            </TouchableOpacity>
          </View>

          <View style={[styles.chatBody, { paddingBottom: kbHeight }]}>
          {/* 消息列表单独兜底：某条消息渲染失败也不会带崩整个界面 */}
          <ErrorBoundary
            label="消息列表"
            onRetry={() => {
              const sid = sessionRef.current;
              if (sid) void openSession(sid);
            }}
          >
          <FlatList
            ref={listRef}
            style={styles.list}
            // 反转列表：data 为「最新在前」，滚动偏移 0 就是最新一条（视觉底部）。
            // 好处：打开/切换会话天然落在最新一条，不需要 scrollToEnd，
            // 也不依赖内容高度做滚动补偿。
            data={listData}
            inverted
            keyExtractor={(m) => m.id}
            // Android 上 inverted 与 removeClippedSubviews 同时开启会造成空白，必须关闭
            removeClippedSubviews={false}
            // 【大段空白的真正根因】虚拟化列表在没有 getItemLayout 时，把「渲染窗口之外」
            // 的消息用**平均高度估算**的 spacer 占位（@react-native/virtualized-lists/
            // VirtualizedList.js:1045 `spacerSize`），而且窗口可以不含下标 0；
            // 反转列表的「家」正好是 offset 0 处的内容坐标 0..V —— 也就是下标 0 那一段。
            // 一旦窗口滑走，offset 0 看到的就是这个 spacer：一片什么都没有的空白，
            // 而且它就在滚动范围的最小端，再怎么滑也滑不出内容来（=「滚不到底」）。
            // 聊天页每页只有 50 条，直接关掉虚拟化：窗口永远从 0 开始
            // （VirtualizedList.js:634 `first: 0`），也不再有 spacer（:1020），
            // 每条消息都是真实布局，空白这类问题从结构上不再可能发生。
            disableVirtualization
            initialNumToRender={Math.max(items.length, 1)}
            maxToRenderPerBatch={Math.max(items.length, 1)}
            contentContainerStyle={items.length > 0 ? styles.listContent : styles.listContentEmpty}
            onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
              const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
              // 反转列表：offset 0 = 最新（视觉底部）
              isAtBottomRef.current = contentOffset.y < 40;
              // 滑到另一端（最旧）时加载更早的一页历史
              if (contentOffset.y + layoutMeasurement.height >= contentSize.height - 80 && contentSize.height > layoutMeasurement.height + 40) {
                loadOlder();
              }
            }}
            onScrollEndDrag={(e) => {
              const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
              if (contentOffset.y + layoutMeasurement.height >= contentSize.height - 80) loadOlder();
            }}
            onMomentumScrollEnd={(e) => {
              const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
              if (contentOffset.y + layoutMeasurement.height >= contentSize.height - 80) loadOlder();
            }}
            scrollEventThrottle={16}
            renderItem={({ item, index }) => (
              <MessageRow
                item={item}
                index={index}
                debug={layoutDebug}
                reasoningOpen={!!reasoningOpen[item.id]}
                onToggleReasoning={toggleReasoning}
                onPath={downloadByPath}
                onImage={downloadImage}
              />
            )}
            ListEmptyComponent={
              // 注意：inverted 时 RN 会自动给 ListEmptyComponent 套 inversionStyle 反向翻转
              // （VirtualizedList.js 的 _renderEmptyComponent），这里不要再手动翻转，否则文字上下颠倒。
              <View style={styles.empty}>
                {historyStatus === 'loading' ? (
                  <>
                    <ActivityIndicator size="small" color="#3964fe" />
                    <Text style={styles.emptyText}>正在加载对话…</Text>
                  </>
                ) : historyStatus === 'error' ? (
                  <>
                    <Text style={[styles.emptyText, styles.emptyError]}>加载失败：{historyError}</Text>
                    <TouchableOpacity
                      style={styles.retryBtn}
                      onPress={() => {
                        const sid = sessionRef.current;
                        if (sid) void openSession(sid);
                      }}
                    >
                      <Text style={styles.retryBtnText}>重试</Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <Text style={styles.emptyText}>
                    {activeSessionId ? '开始对话吧' : '还没有会话，点左上角 ☰ 新建一个'}
                  </Text>
                )}
              </View>
            }
          />
          </ErrorBoundary>

          {/* 加载更早历史的提示做成浮层，不占用列表内容高度，避免干扰滚动位置补偿 */}
          {loadingOlder ? (
            <View style={styles.loadingOlderOverlay} pointerEvents="none">
              <ActivityIndicator size="small" color="#3964fe" />
              <Text style={styles.loadingOlderText}>正在加载更早的记录…</Text>
            </View>
          ) : null}

          <View style={styles.inputRow}>
            <TouchableOpacity style={styles.attachBtn} onPress={pickFile} disabled={!activeSessionId || busy}>
              <PaperclipIcon size={22} color="#000" />
            </TouchableOpacity>
            <TextInput
              style={styles.input}
              value={input}
              onChangeText={setInput}
              placeholder={activeSessionId ? '发消息…' : '先新建会话'}
              onSubmitEditing={send}
              returnKeyType="send"
              editable={!!activeSessionId && !busy}
            />
            {busy ? (
              <TouchableOpacity style={[styles.sendBtn, styles.stopBtn]} onPress={stop}>
                <Text style={styles.sendText}>停止</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.sendBtn} onPress={send} disabled={!activeSessionId}>
                <Text style={styles.sendText}>发送</Text>
              </TouchableOpacity>
            )}
          </View>
          </View>
        </>
      ) : (
        <SettingsView
          serverUrl={serverUrl}
          setServerUrl={setServerUrl}
          onApply={applyServerUrl}
          onBack={() => setView('chat')}
          models={models}
          onSelectModel={selectModel}
          presets={presets}
          selectedPreset={selectedPreset}
          onSelectPreset={selectPreset}
          layoutDebug={layoutDebug}
          onToggleLayoutDebug={setLayoutDebug}
        />
      )}

      {/* 侧边栏抽屉 */}
      <Modal visible={sidebarOpen} transparent animationType="fade" onRequestClose={() => setSidebarOpen(false)}>
        <View style={styles.overlay}>
          <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setSidebarOpen(false)} />
          <View style={styles.sidebar}>
            <Text style={styles.sidebarTitle}>DeepSeek Harness</Text>
            <Text style={styles.sidebarStatus} numberOfLines={1}>{status}</Text>

            <TouchableOpacity style={styles.newBtn} onPress={createNewSession}>
              <Text style={styles.newBtnText}>＋ 新建会话</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.newWsBtn} onPress={() => { setNewWsOpen(true); setSidebarOpen(false); }}>
              <Text style={styles.newWsBtnText}>＋ 新建工作区</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.newWsBtn} onPress={() => { setDownloadOpen(true); setSidebarOpen(false); }}>
              <Text style={styles.newWsBtnText}>⬇ 下载宿主机文件</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.newWsBtn}
              onPress={() => { if (currentSession && !currentSession.blank) { setModeOpen(true); setSidebarOpen(false); } }}
              disabled={!currentSession || currentSession.blank}
            >
              <Text style={[styles.newWsBtnText, (!currentSession || currentSession.blank) && { color: '#bbb' }]}>
                🔄 切换模式{(!currentSession || currentSession.blank) ? '（首轮结束后可用）' : ''}
              </Text>
            </TouchableOpacity>

            <ScrollView style={styles.sidebarScroll}>
              <TouchableOpacity
                style={[styles.wsRow, !activeWorkspaceId && styles.wsRowActive]}
                onPress={() => setActiveWorkspaceId(null)}
              >
                <Text style={styles.wsRowText}>全部会话</Text>
              </TouchableOpacity>
              {workspaces.map((w) => (
                <TouchableOpacity
                  key={w.workspaceId}
                  style={[styles.wsRow, activeWorkspaceId === w.workspaceId && styles.wsRowActive]}
                  onPress={() => setActiveWorkspaceId(w.workspaceId)}
                  onLongPress={() => { setActionTarget({ kind: 'workspace', w }); setRenameText(w.title); }}
                >
                  <Text style={styles.wsRowText}>📁 {w.title}</Text>
                </TouchableOpacity>
              ))}

              <TouchableOpacity style={styles.wsRow} onPress={() => setShowArchived((v) => !v)}>
                <Text style={[styles.wsRowText, { color: '#888', fontSize: 13 }]}>
                  {showArchived ? '✓ 正在显示归档会话' : '🗂 查看归档会话'}
                </Text>
              </TouchableOpacity>

              <View style={styles.divider} />

              {visibleSessions().map((s) => (
                <TouchableOpacity
                  key={s.sessionId}
                  style={[styles.sessionRow, s.sessionId === activeSessionId && styles.sessionRowActive]}
                  onPress={() => openSession(s.sessionId)}
                  onLongPress={() => { setActionTarget({ kind: 'session', s }); setRenameText(sessionTitle(s)); }}
                >
                  <Text style={styles.sessionRowText} numberOfLines={1}>
                    {s.running ? '● ' : ''}{sessionTitle(s)}
                    {archivedSessionIds.includes(s.sessionId) ? '（已归档）' : ''}
                  </Text>
                </TouchableOpacity>
              ))}
              {visibleSessions().length === 0 && <Text style={styles.sessionEmpty}>暂无会话</Text>}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* 审批弹窗 */}
      <Modal visible={!!pendingApproval} transparent animationType="fade" onRequestClose={() => setPendingApproval(null)}>
        <View style={styles.centerOverlay}>
          <View style={styles.approvalCard}>
            <Text style={styles.approvalTitle}>审批请求</Text>
            <Text style={styles.approvalLine}>工具：{pendingApproval?.toolName}</Text>
            {!!pendingApproval?.reason && <Text style={styles.approvalLine}>原因：{pendingApproval?.reason}</Text>}
            <View style={styles.approvalBtns}>
              <TouchableOpacity style={[styles.approvalBtn, styles.approveBtn]} onPress={() => respondApproval('allowed-once')}>
                <Text style={styles.approvalBtnText}>允许</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.approvalBtn, styles.rejectBtn]} onPress={() => respondApproval('rejected')}>
                <Text style={styles.approvalBtnText}>拒绝</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* AI 提问弹窗（ask_user_question）——手机上回答 AI 的提问 */}
      <Modal
        visible={!!pendingQuestion}
        transparent
        animationType="fade"
        onRequestClose={() => { void cancelQuestion(); }}
      >
        <View style={styles.centerOverlay}>
          <View style={styles.questionCard}>
            <Text style={styles.questionTitle}>AI 提问</Text>
            <ScrollView style={styles.questionScroll} keyboardShouldPersistTaps="handled">
              {pendingQuestion?.questions.map((q, qi) => {
                const draft = questionDrafts[q.id] ?? { selected: [], custom: '' };
                const isMulti = q.multiSelect === true;
                return (
                  <View key={q.id} style={styles.questionBlock}>
                    {pendingQuestion.questions.length > 1 ? (
                      <Text style={styles.questionIndex}>问题 {qi + 1} / {pendingQuestion.questions.length}</Text>
                    ) : null}
                    {!!q.header && <Text style={styles.questionHeader}>{q.header}</Text>}
                    <Text style={styles.questionText}>{q.question}</Text>
                    {!!q.detail && (
                      <ScrollView style={styles.questionDetailBox} nestedScrollEnabled>
                        <Text style={styles.questionDetail}>{q.detail}</Text>
                      </ScrollView>
                    )}
                    {isMulti ? <Text style={styles.questionHint}>可多选</Text> : null}

                    {q.options?.map((opt) => {
                      const on = draft.selected.includes(opt.label);
                      return (
                        <TouchableOpacity
                          key={opt.label}
                          style={[styles.questionOption, on && styles.questionOptionOn]}
                          onPress={() => toggleOption(q, opt.label)}
                          disabled={questionBusy}
                        >
                          <Text style={[styles.questionOptionMark, on && styles.questionOptionMarkOn]}>
                            {isMulti ? (on ? '☑' : '☐') : on ? '◉' : '○'}
                          </Text>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.questionOptionLabel}>{opt.label}</Text>
                            {!!opt.description && (
                              <Text style={styles.questionOptionDesc}>{opt.description}</Text>
                            )}
                          </View>
                        </TouchableOpacity>
                      );
                    })}

                    <TextInput
                      style={styles.questionCustomInput}
                      value={draft.custom}
                      onChangeText={(t) => setQuestionCustom(q, t)}
                      placeholder={q.options?.length ? '或输入自定义答案…' : '输入你的答案…'}
                      multiline
                      editable={!questionBusy}
                    />
                  </View>
                );
              })}
            </ScrollView>

            {!!questionError && <Text style={styles.questionError}>{questionError}</Text>}

            <View style={styles.approvalBtns}>
              <TouchableOpacity
                style={[styles.approvalBtn, styles.rejectBtn]}
                onPress={() => { void cancelQuestion(); }}
                disabled={questionBusy}
              >
                <Text style={styles.approvalBtnText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.approvalBtn, styles.approveBtn, questionBusy && styles.btnDisabled]}
                onPress={() => { void submitQuestion(); }}
                disabled={questionBusy}
              >
                <Text style={styles.approvalBtnText}>{questionBusy ? '提交中…' : '提交'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 会话/工作区操作菜单 */}
      <Modal visible={!!actionTarget && !renameOpen} transparent animationType="fade" onRequestClose={() => setActionTarget(null)}>
        <View style={styles.centerOverlay}>
          <View style={styles.actionCard}>
            <Text style={styles.actionTitle}>
              {actionTarget?.kind === 'session' ? sessionTitle(actionTarget.s) : actionTarget?.w.title}
            </Text>
            <TouchableOpacity style={styles.actionRow} onPress={() => setRenameOpen(true)}>
              <Text style={styles.actionRowText}>重命名</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionRow, styles.actionDanger]}
              onPress={actionTarget?.kind === 'session' ? archiveSession : deleteWorkspace}
            >
              <Text style={styles.actionDangerText}>{actionTarget?.kind === 'session' ? '归档会话' : '删除工作区'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionRow} onPress={() => setActionTarget(null)}>
              <Text style={styles.actionRowText}>取消</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* 重命名输入弹窗 */}
      <Modal visible={renameOpen} transparent animationType="fade" onRequestClose={() => setRenameOpen(false)}>
        <View style={styles.centerOverlay}>
          <View style={styles.actionCard}>
            <Text style={styles.actionTitle}>重命名</Text>
            <TextInput
              style={styles.dialogInput}
              value={renameText}
              onChangeText={setRenameText}
              autoFocus
              placeholder="输入新名称"
            />
            <TouchableOpacity style={styles.approveBtn} onPress={confirmRename}>
              <Text style={styles.approvalBtnText}>确定</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* 新建工作区弹窗 */}
      <Modal visible={newWsOpen} transparent animationType="fade" onRequestClose={() => setNewWsOpen(false)}>
        <View style={styles.centerOverlay}>
          <View style={styles.actionCard}>
            <Text style={styles.actionTitle}>新建工作区</Text>
            <Text style={styles.actionHint}>输入宿主机上的目录路径（已存在的文件夹）</Text>
            <TextInput
              style={styles.dialogInput}
              value={newWsPath}
              onChangeText={setNewWsPath}
              autoFocus
              placeholder="例如 D:\MyProject"
              autoCapitalize="none"
            />
            <TouchableOpacity style={styles.approveBtn} onPress={createWorkspace}>
              <Text style={styles.approvalBtnText}>创建</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* 下载文件弹窗 */}
      <Modal visible={downloadOpen} transparent animationType="fade" onRequestClose={() => setDownloadOpen(false)}>
        <View style={styles.centerOverlay}>
          <View style={styles.actionCard}>
            <Text style={styles.actionTitle}>下载宿主机文件</Text>
            <Text style={styles.actionHint}>输入工作区内的文件路径</Text>
            <TextInput
              style={styles.dialogInput}
              value={downloadPath}
              onChangeText={setDownloadPath}
              autoFocus
              placeholder="shared-files\xxx.pdf 或 D:\AutoDS\..."
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity
              style={styles.approveBtn}
              onPress={() => { const p = downloadPath.trim(); if (p) downloadByPath(p); setDownloadOpen(false); }}
            >
              <Text style={styles.approvalBtnText}>下载</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* 切换模式弹窗 */}
      <Modal visible={modeOpen} transparent animationType="fade" onRequestClose={() => setModeOpen(false)}>
        <View style={styles.centerOverlay}>
          <View style={styles.actionCard}>
            <Text style={styles.actionTitle}>切换当前会话模式</Text>
            <ScrollView style={{ maxHeight: 420 }}>
              {presets.map((p) => {
                const isCurrent = currentSession?.agentPreset === p.id;
                return (
                  <TouchableOpacity
                    key={p.id}
                    style={[styles.optRow, isCurrent && styles.optRowActive]}
                    onPress={() => switchMode(p.id)}
                  >
                    <Text style={styles.optRowText}>
                      {p.name || p.id}{p.broken ? ' ⚠损坏' : ''}{isCurrent ? '（当前）' : ''}
                    </Text>
                    {isCurrent && <Text style={styles.optCheck}>✓</Text>}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
      </SafeAreaView>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

function SettingsView(props: {
  serverUrl: string;
  setServerUrl: (v: string) => void;
  onApply: () => void;
  onBack: () => void;
  models: SessionModelsValue | null;
  onSelectModel: (provider: string, model: string) => void;
  presets: AgentPresetEntry[];
  selectedPreset: string | null;
  onSelectPreset: (id: string) => void;
  layoutDebug: boolean;
  onToggleLayoutDebug: (v: boolean) => void;
}) {
  const { models, presets, selectedPreset } = props;
  return (
    <View style={styles.settingsWrap}>
      <View style={styles.header}>
        <TouchableOpacity onPress={props.onBack} style={styles.hamburger}>
          <Text style={styles.hamburgerText}>‹</Text>
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.title}>设置</Text>
        </View>
        <View style={styles.gear} />
      </View>

      <ScrollView style={styles.settingsScroll} contentContainerStyle={{ paddingBottom: 40 }}>
        <Text style={styles.sectionTitle}>服务器地址</Text>
        <View style={styles.rowInline}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            value={props.serverUrl}
            onChangeText={props.setServerUrl}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="http://YOUR_TAILSCALE_IP:8787"
          />
          <TouchableOpacity style={styles.applyBtn} onPress={props.onApply}>
            <Text style={styles.applyBtnText}>保存并重连</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.sectionTitle}>排查（消息列表）</Text>
        <TouchableOpacity
          style={[styles.optRow, props.layoutDebug && styles.optRowActive]}
          onPress={() => props.onToggleLayoutDebug(!props.layoutDebug)}
        >
          <Text style={styles.optRowText}>
            显示每条消息的布局信息{props.layoutDebug ? '（已打开）' : '（关闭）'}
            {'\n'}
            <Text style={styles.optRowHint}>下标 / 事件 id / 实测高度 / 字数 —— 看到空白时打开它截图</Text>
          </Text>
          {props.layoutDebug && <Text style={styles.optCheck}>✓</Text>}
        </TouchableOpacity>

        <Text style={styles.sectionTitle}>Agent 预设（新建会话时生效）</Text>
        {presets.map((p) => (
          <TouchableOpacity
            key={p.id}
            style={[styles.optRow, selectedPreset === p.id && styles.optRowActive]}
            onPress={() => props.onSelectPreset(p.id)}
          >
            <Text style={styles.optRowText}>
              {p.name || p.id}{p.isDefault ? '（默认）' : ''}{p.broken ? ' ⚠损坏' : ''}
            </Text>
            {selectedPreset === p.id && <Text style={styles.optCheck}>✓</Text>}
          </TouchableOpacity>
        ))}

        <Text style={styles.sectionTitle}>模型选择</Text>
        {models ? (
          models.groups.map((g) => (
            <View key={g.id}>
              <Text style={styles.groupTitle}>{g.name}</Text>
              {g.models.map((m) => {
                const isCurrent = models.current.provider === g.id && models.current.model === m.id;
                return (
                  <TouchableOpacity
                    key={m.id}
                    style={[styles.optRow, isCurrent && styles.optRowActive]}
                    onPress={() => props.onSelectModel(g.id, m.id)}
                  >
                    <Text style={styles.optRowText}>{m.name || m.id}</Text>
                    {isCurrent && <Text style={styles.optCheck}>✓</Text>}
                  </TouchableOpacity>
                );
              })}
            </View>
          ))
        ) : (
          <Text style={styles.sessionEmpty}>暂无模型信息（需已连接且有会话）</Text>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f5f6f8' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 10,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  hamburger: { width: 40, alignItems: 'center' },
  hamburgerText: { fontSize: 24, color: '#3964fe' },
  headerCenter: { flex: 1, paddingHorizontal: 4 },
  title: { fontSize: 16, fontWeight: '700', color: '#111' },
  status: { fontSize: 12, color: '#666', marginTop: 2 },
  gear: { width: 40, alignItems: 'center' },
  gearText: { fontSize: 20, color: '#3964fe' },
  list: { flex: 1 },
  // 内容内边距放在 contentContainerStyle（style 上的 padding 在 Android 会裁切内容）。
  // 反转列表下内容天然贴底，因此不需要 flexGrow/justifyContent 做贴底对齐。
  listContent: { padding: 12 },
  // 空列表时把提示推到视觉顶部（inverted 下 flex-end 映射到视觉上方）
  listContentEmpty: { padding: 12, flexGrow: 1, justifyContent: 'flex-end' },
  bubble: { maxWidth: '86%', padding: 10, borderRadius: 14, marginVertical: 4 },
  userBubble: { alignSelf: 'flex-end', backgroundColor: '#3964fe' },
  // 助手气泡必须占满可用宽度（与电脑端一致）：Markdown 的表格/列表用了 flex 分配宽度，
  // 若气泡宽度是「按内容自适应」，flex:1 会塌成 0 宽、文字被裁掉 → 整条消息变空白。
  assistantBubble: { alignSelf: 'stretch', maxWidth: '100%', backgroundColor: '#fff' },
  bubbleText: { fontSize: 15, lineHeight: 21, color: '#111' },
  userText: { color: '#fff' },
  reasoningWrap: { marginBottom: 6 },
  reasoningToggle: { paddingVertical: 2 },
  reasoningToggleText: { fontSize: 13, color: '#7a5af8', fontWeight: '600' },
  reasoningText: { fontSize: 13, lineHeight: 19, color: '#888', marginTop: 4, fontStyle: 'italic' },
  loadingOlderOverlay: {
    position: 'absolute',
    top: 8,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.94)',
    zIndex: 10,
    elevation: 4,
  },
  loadingOlderText: { fontSize: 13, color: '#666' },
  toolCard: {
    alignSelf: 'stretch',
    backgroundColor: '#f0f3ff',
    borderRadius: 10,
    padding: 10,
    marginVertical: 4,
    borderLeftWidth: 3,
    borderLeftColor: '#3964fe',
  },
  toolHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  toolName: { fontSize: 13, fontWeight: '700', color: '#3964fe' },
  toolArgs: { fontSize: 12, color: '#555', marginTop: 4, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  toolResult: { fontSize: 12, color: '#333', marginTop: 6 },
  toolResultError: { color: '#c0392b' },
  empty: { alignItems: 'center', marginTop: 60 },
  emptyText: { color: '#999', fontSize: 14 },
  emptyError: { color: '#c0392b', textAlign: 'center', marginBottom: 10, paddingHorizontal: 20 },
  retryBtn: { backgroundColor: '#3964fe', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 20 },
  retryBtnText: { color: '#fff', fontWeight: '600' },
  inputRow: { flexDirection: 'row', padding: 8, backgroundColor: '#fff' },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    fontSize: 15,
    color: '#111',
  },
  sendBtn: {
    marginLeft: 8,
    paddingHorizontal: 16,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#3964fe',
    borderRadius: 20,
    minWidth: 64,
  },
  sendText: { color: '#fff', fontWeight: '600' },
  overlay: { flex: 1, flexDirection: 'row', backgroundColor: 'rgba(0,0,0,0.4)' },
  backdrop: { flex: 1 },
  sidebar: {
    width: '80%',
    backgroundColor: '#fff',
    paddingTop: 50,
    paddingHorizontal: 12,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: '#ddd',
  },
  sidebarTitle: { fontSize: 18, fontWeight: '700', color: '#111' },
  sidebarStatus: { fontSize: 12, color: '#666', marginTop: 4 },
  newBtn: {
    marginTop: 16,
    backgroundColor: '#3964fe',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  newBtnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  newWsBtn: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#3964fe',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  newWsBtnText: { color: '#3964fe', fontWeight: '600', fontSize: 14 },
  sidebarScroll: { flex: 1, marginTop: 12 },
  wsRow: { paddingVertical: 10, paddingHorizontal: 8, borderRadius: 8, marginVertical: 2 },
  wsRowActive: { backgroundColor: '#eef2ff' },
  wsRowText: { fontSize: 15, color: '#111', fontWeight: '600' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: '#ddd', marginVertical: 10 },
  sessionRow: { paddingVertical: 10, paddingHorizontal: 8, borderRadius: 8, marginVertical: 2 },
  sessionRowActive: { backgroundColor: '#eef2ff' },
  sessionRowText: { fontSize: 14, color: '#333' },
  sessionEmpty: { color: '#999', fontSize: 13, padding: 8 },
  settingsWrap: { flex: 1, backgroundColor: '#f5f6f8' },
  settingsScroll: { flex: 1, padding: 16 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#666', marginTop: 20, marginBottom: 8 },
  rowInline: { flexDirection: 'row', alignItems: 'center' },
  applyBtn: {
    marginLeft: 8,
    backgroundColor: '#3964fe',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  applyBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  groupTitle: { fontSize: 12, fontWeight: '700', color: '#888', marginTop: 10, marginBottom: 4 },
  optRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: '#fff',
    borderRadius: 8,
    marginVertical: 3,
  },
  optRowActive: { backgroundColor: '#eef2ff' },
  optRowText: { fontSize: 14, color: '#111', flex: 1 },
  optRowHint: { fontSize: 11, color: '#777' },
  debugBadge: {
    fontSize: 10,
    color: '#8a6d00',
    backgroundColor: '#fff8dc',
    paddingHorizontal: 4,
    paddingVertical: 1,
    alignSelf: 'flex-start',
    marginTop: 2,
  },
  optCheck: { fontSize: 14, color: '#3964fe', fontWeight: '700' },
  centerOverlay: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.4)', padding: 24 },
  approvalCard: { width: '90%', backgroundColor: '#fff', borderRadius: 14, padding: 20 },
  approvalTitle: { fontSize: 16, fontWeight: '700', color: '#111', marginBottom: 10 },
  approvalLine: { fontSize: 14, color: '#333', marginBottom: 6 },
  approvalBtns: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12 },
  approvalBtn: { paddingVertical: 10, paddingHorizontal: 20, borderRadius: 8, marginLeft: 10 },
  approveBtn: { backgroundColor: '#3964fe' },
  rejectBtn: { backgroundColor: '#c0392b' },
  approvalBtnText: { color: '#fff', fontWeight: '600' },
  btnDisabled: { opacity: 0.5 },
  // AI 提问弹窗
  questionCard: { width: '94%', maxHeight: '82%', backgroundColor: '#fff', borderRadius: 14, padding: 16 },
  questionTitle: { fontSize: 16, fontWeight: '700', color: '#111', marginBottom: 8 },
  questionScroll: { flexGrow: 0 },
  questionBlock: { marginBottom: 16 },
  questionIndex: { fontSize: 12, color: '#888', marginBottom: 4 },
  questionHeader: { fontSize: 13, fontWeight: '700', color: '#7a5af8', marginBottom: 2 },
  questionText: { fontSize: 15, lineHeight: 22, color: '#111', marginBottom: 8 },
  questionHint: { fontSize: 12, color: '#888', marginBottom: 4 },
  questionDetailBox: { maxHeight: 160, backgroundColor: '#f6f7f9', borderRadius: 8, padding: 8, marginBottom: 8 },
  questionDetail: { fontSize: 13, lineHeight: 19, color: '#333' },
  questionOption: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: 1,
    borderColor: '#e3e6ea',
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
    backgroundColor: '#fff',
  },
  questionOptionOn: { borderColor: '#3964fe', backgroundColor: '#eef2ff' },
  questionOptionMark: { fontSize: 16, color: '#98a2b3', marginRight: 8, lineHeight: 20 },
  questionOptionMarkOn: { color: '#3964fe' },
  questionOptionLabel: { fontSize: 14, color: '#111' },
  questionOptionDesc: { fontSize: 12, color: '#777', marginTop: 2, lineHeight: 17 },
  questionCustomInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: '#111',
    minHeight: 40,
    maxHeight: 110,
    textAlignVertical: 'top',
  },
  questionError: { fontSize: 12, color: '#c0392b', marginTop: 6 },
  actionCard: { width: '86%', backgroundColor: '#fff', borderRadius: 14, padding: 16 },
  actionTitle: { fontSize: 15, fontWeight: '700', color: '#111', marginBottom: 10 },
  actionHint: { fontSize: 12, color: '#888', marginBottom: 8 },
  actionRow: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#eee' },
  actionRowText: { fontSize: 15, color: '#111' },
  actionDanger: { borderBottomWidth: 0 },
  actionDangerText: { fontSize: 15, color: '#c0392b', fontWeight: '600' },
  dialogInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
    color: '#111',
    marginBottom: 12,
  },
  attachBtn: { paddingHorizontal: 10, justifyContent: 'center' },
  attachBtnText: { fontSize: 22 },
  imagePreviewRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8, backgroundColor: '#fff' },
  imagePreviewText: { flex: 1, fontSize: 13, color: '#333' },
  imagePreviewRemove: { fontSize: 16, color: '#999', padding: 4 },
  imageDownloadBtn: { marginTop: 8, alignSelf: 'flex-start', backgroundColor: '#eef2ff', borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12 },
  imageDownloadText: { fontSize: 13, color: '#3964fe', fontWeight: '600' },
  pathLink: { textDecorationLine: 'underline', fontWeight: '700' },
  chatBody: { flex: 1 },
  stopBtn: { backgroundColor: '#c0392b' },
  tokenLine: { fontSize: 11, color: '#888', marginTop: 1 },
});
