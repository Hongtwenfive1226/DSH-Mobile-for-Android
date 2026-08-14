// App.tsx — DSH Mobile v3：侧边栏 + 工作区 + 设置 + 持久化 + 工具卡片 + 审批 + 会话/工作区管理
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { pick, keepLocalCopy, types, isErrorWithCode, errorCodes } from '@react-native-documents/picker';
import { CachesDirectoryPath, readFile as fsReadFile, writeFile as fsWriteFile } from '@dr.pogodin/react-native-fs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DshClient } from './src/dsh/client';
import { saveLocalFile } from './src/fileSave';
import type {
  AgentPresetEntry,
  HostFrame,
  MuxFrame,
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

type ChatItem =
  | { kind: 'msg'; id: string; role: 'user' | 'assistant'; text: string; streaming?: boolean; images?: ImageRef[] }
  | { kind: 'tool'; id: string; name: string; args: string; result?: string; isError?: boolean; done: boolean };

interface PendingApproval {
  rpcId: string;
  sessionId: string;
  approvalId: string;
  toolName: string;
  reason?: string;
}

function extractText(content: any): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('');
}

function extractImageRefs(content: any): ImageRef[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: any) => b?.type === 'image' && typeof b?.attachmentId === 'string')
    .map((b: any) => ({ attachmentId: b.attachmentId, mediaType: b.mediaType || 'image/png' }));
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

async function loadHistory(client: DshClient, sessionId: string): Promise<{ items: ChatItem[]; tokenUsage: any | null }> {
  const r = await client.history(sessionId);
  if (!r.ok) return { items: [], tokenUsage: null };
  const out: ChatItem[] = [];
  for (const entry of r.value.events) {
    const ev = entry.event;
    if (ev.type === 'user/message') {
      const content = ev.data?.content ?? ev.data?.message?.content;
      const text = extractText(content);
      const images = extractImageRefs(content);
      if (text || images.length) out.push({ kind: 'msg', id: `u-${ev.seq}`, role: 'user', text, images: images.length ? images : undefined });
    } else if (ev.type === 'assistant/message') {
      const content = ev.data?.message?.content;
      const text = extractText(content);
      const images = extractImageRefs(content);
      if (text || images.length) out.push({ kind: 'msg', id: `a-${ev.seq}`, role: 'assistant', text, images: images.length ? images : undefined });
    } else if (ev.type === 'tool/call') {
      const d = ev.data;
      out.push({ kind: 'tool', id: `t-${d.callId}`, name: d.name, args: d.arguments ?? '', done: false });
    } else if (ev.type === 'tool/result') {
      const d = ev.data;
      const { text, isError } = extractToolResult(d);
      const callId = d?.message?.content?.[0]?.toolCallId;
      const id = `t-${callId ?? ev.seq}`;
      const item = out.find((x) => x.kind === 'tool' && x.id === id);
      if (item && item.kind === 'tool') {
        item.result = text;
        item.isError = isError;
        item.done = true;
      } else {
        out.push({ kind: 'tool', id, name: '工具', args: '', result: text, isError, done: true });
      }
    }
  }
  const tokenUsage = (r.value as any)?.projections?.values?.tokenUsage ?? null;
  return { items: out, tokenUsage };
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

  // UI
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [view, setView] = useState<'chat' | 'settings'>('chat');
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [actionTarget, setActionTarget] = useState<
    { kind: 'session'; s: SessionSummary } | { kind: 'workspace'; w: WorkspaceView } | null
  >(null);
  const [renameText, setRenameText] = useState('');
  const [newWsOpen, setNewWsOpen] = useState(false);
  const [newWsPath, setNewWsPath] = useState('');
  const [renameOpen, setRenameOpen] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [downloadPath, setDownloadPath] = useState('');

  const clientRef = useRef<DshClient | null>(null);
  const sessionRef = useRef<string | null>(null);
  const streamRef = useRef<{ id: string } | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const listRef = useRef<FlatList<ChatItem>>(null);
  const restoreSessionRef = useRef<string | null>(null);

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
      JSON.stringify({ serverUrl: appliedUrl, selectedPreset, activeWorkspaceId, activeSessionId }),
    ).catch(() => {});
  }, [hydrated, appliedUrl, selectedPreset, activeWorkspaceId, activeSessionId]);

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

    const handleFrame = (payload: MuxFrame | HostFrame, rpcId: string) => {
      const p = payload as any;
      if (p.type === 'approval/requested') {
        setPendingApproval({
          rpcId,
          sessionId: p.sessionId,
          approvalId: p.approvalId,
          toolName: p.toolName,
          reason: p.reason,
        });
        return;
      }
      if (p.type === 'approval/resolved') {
        setPendingApproval((cur) => (cur && cur.approvalId === p.approvalId ? null : cur));
        return;
      }
      if (p.type === 'session/projection' && p.sessionId === sessionRef.current && p.key === 'tokenUsage') {
        setTokenUsage(p.value);
        return;
      }
      if (p.type !== 'session/event') return;
      const ev = p.event;
      if (!ev || p.sessionId !== sessionRef.current) return;

      if (ev.type === 'assistant/chunk') {
        const chunk = ev.data?.chunk;
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          if (!streamRef.current) {
            const id = `a-${ev.seq}`;
            streamRef.current = { id };
            setItems((prev) => [...prev, { kind: 'msg', id, role: 'assistant', text: '', streaming: true }]);
          }
          const sid = streamRef.current.id;
          setItems((prev) => prev.map((m) => (m.kind === 'msg' && m.id === sid ? { ...m, text: m.text + chunk.text } : m)));
        }
      } else if (ev.type === 'assistant/message') {
        const content = ev.data?.message?.content;
        const text = extractText(content);
        const images = extractImageRefs(content);
        if (streamRef.current) {
          const sid = streamRef.current.id;
          setItems((prev) => prev.map((m) => (m.kind === 'msg' && m.id === sid ? { ...m, text: text || m.text, streaming: false, images: images.length ? images : m.images } : m)));
          streamRef.current = null;
        } else if (text || images.length) {
          setItems((prev) => [...prev, { kind: 'msg', id: `a-${ev.seq}`, role: 'assistant', text, images: images.length ? images : undefined }]);
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

    (async () => {
      const d = await client.describe();
      if (!mounted) return;
      if (d.ok) {
        setHostLine(`${d.value.model ?? ''} @ ${d.value.cwd}`);
        setStatus('已连接');
      } else {
        setStatus('连接失败: ' + d.error.code);
        return;
      }
      const [w, s, pr] = await Promise.all([
        client.listWorkspaces(),
        client.listSessions(),
        client.listAgentPresets(),
      ]);
      if (!mounted) return;
      if (w.ok) { setWorkspaces(w.value.items); setArchivedSessionIds(w.value.archivedSessionIds); }
      if (s.ok) setSessions(s.value.items);
      if (pr.ok) {
        setPresets(pr.value.presets);
        setSelectedPreset((old) => old ?? pr.value.presets.find((x) => x.isDefault)?.id ?? null);
      }
      const list = s.ok ? s.value.items : [];
      const restore = restoreSessionRef.current;
      const target = (restore && list.find((x) => x.sessionId === restore)) || list.find((x) => !x.blank) || list[0];
      restoreSessionRef.current = null;
      if (target) {
        sessionRef.current = target.sessionId;
        setActiveSessionId(target.sessionId);
        const res = await loadHistory(client, target.sessionId);
        setItems(res.items);
        if (res.tokenUsage) setTokenUsage(res.tokenUsage);
      }
    })();

    stopRef.current = client.openStream('events.mux', handleFrame, (open) => {
      if (open) setStatus((s) => (s.startsWith('连接失败') ? s : '已连接'));
    });

    return () => {
      mounted = false;
      stopRef.current?.();
    };
  }, [hydrated, appliedUrl]);

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
    const [w, s] = await Promise.all([c.listWorkspaces(), c.listSessions()]);
    if (w.ok) { setWorkspaces(w.value.items); setArchivedSessionIds(w.value.archivedSessionIds); }
    if (s.ok) setSessions(s.value.items);
  }, []);

  const openSession = useCallback(async (sid: string) => {
    const c = clientRef.current;
    if (!c) return;
    sessionRef.current = sid;
    setActiveSessionId(sid);
    setItems([]);
    setBusy(false);
    setTokenUsage(null);
    setSidebarOpen(false);
    const res = await loadHistory(c, sid);
    setItems(res.items);
    if (res.tokenUsage) setTokenUsage(res.tokenUsage);
  }, []);

  const createNewSession = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    const r = await c.createSession({
      workspaceId: activeWorkspaceId ?? undefined,
      agentPreset: selectedPreset ?? undefined,
    });
    if (r.ok) {
      sessionRef.current = r.value.sessionId;
      setActiveSessionId(r.value.sessionId);
      setItems([]);
      setBusy(false);
      setSidebarOpen(false);
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
    const sid = sessionRef.current;
    if (!c || !sid) return;
    const r = await c.getSessionModels(sid);
    if (r.ok) setModels(r.value);
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
    const attachment = r.value.attachment;
    const actualMediaType = attachment.mediaType || mediaType;
    const ext = actualMediaType.split('/')[1] || 'png';
    const fallbackName = `dsh-download-${Date.now()}.${ext}`;
    const path = `${CachesDirectoryPath}/${fallbackName}`;
    try {
      await fsWriteFile(path, r.value.data, 'base64');
      const outcome = await saveLocalFile(path, attachment.name || fallbackName, actualMediaType);
      setStatus(outcome === 'saved' ? '已保存文件' : '已弹出分享');
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
      const outcome = await saveLocalFile(local, f.name);
      setStatus(outcome === 'saved' ? '已保存文件' : '已弹出分享');
    } catch {
      setStatus('下载失败');
    }
  }, [appliedUrl]);

  const respondApproval = useCallback(async (outcome: 'allowed-once' | 'rejected') => {
    if (!pendingApproval) return;
    const { rpcId, sessionId, approvalId } = pendingApproval;
    setPendingApproval(null);
    try {
      await clientRef.current?.respond(rpcId, { sessionId, approvalId, outcome });
    } catch {
      setStatus('审批应答失败');
    }
  }, [pendingApproval]);

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

  // 手动键盘监听：键盘弹出时把底部内容顶上去（零依赖，规避 RN edge-to-edge 下 adjustResize 失效）
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s1 = Keyboard.addListener(showEvent, (e: any) => setKbHeight(e.endCoordinates?.height ?? 0));
    const s2 = Keyboard.addListener(hideEvent, () => setKbHeight(0));
    return () => { s1.remove(); s2.remove(); };
  }, []);

  return (
    <SafeAreaProvider>
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
          <FlatList
            ref={listRef}
            style={styles.list}
            data={items}
            keyExtractor={(m) => m.id}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            renderItem={({ item }) =>
              item.kind === 'msg' ? (
                <View style={[styles.bubble, item.role === 'user' ? styles.userBubble : styles.assistantBubble]}>
                  <Text style={[styles.bubbleText, item.role === 'user' && styles.userText]}>
                    {renderPathText(item.text, downloadByPath)}
                    {item.streaming ? '▍' : ''}
                  </Text>
                  {item.images?.map((im, i) => (
                    <TouchableOpacity
                      key={i}
                      style={styles.imageDownloadBtn}
                      onPress={() => downloadImage(im.attachmentId, im.mediaType)}
                    >
                      <Text style={styles.imageDownloadText}>🖼 下载图片</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : (
                <View style={styles.toolCard}>
                  <View style={styles.toolHeader}>
                    <Text style={styles.toolName}>{item.done ? (item.isError ? '✗ ' : '✓ ') : '⏳ '}{item.name}</Text>
                    {!item.done && <ActivityIndicator size="small" color="#3964fe" />}
                  </View>
                  {item.args ? (
                    <Text style={styles.toolArgs} numberOfLines={3}>{item.args}</Text>
                  ) : null}
                  {item.done && item.result ? (
                    <Text style={[styles.toolResult, item.isError && styles.toolResultError]} numberOfLines={6}>
                      {item.result}
                    </Text>
                  ) : null}
                </View>
              )
            }
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyText}>
                  {activeSessionId ? '开始对话吧' : '还没有会话，点左上角 ☰ 新建一个'}
                </Text>
              </View>
            }
          />

          <View style={styles.inputRow}>
            <TouchableOpacity style={styles.attachBtn} onPress={pickFile} disabled={!activeSessionId || busy}>
              <Text style={styles.attachBtnText}>📎</Text>
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
      </SafeAreaView>
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
  list: { flex: 1, padding: 12 },
  bubble: { maxWidth: '86%', padding: 10, borderRadius: 14, marginVertical: 4 },
  userBubble: { alignSelf: 'flex-end', backgroundColor: '#3964fe' },
  assistantBubble: { alignSelf: 'flex-start', backgroundColor: '#fff' },
  bubbleText: { fontSize: 15, lineHeight: 21, color: '#111' },
  userText: { color: '#fff' },
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
