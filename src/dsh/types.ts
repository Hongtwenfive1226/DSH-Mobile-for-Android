// types.ts — DSH /api 协议的最小 TypeScript 类型（RN 客户端用）
// 依据：protocol.md + dsh-host-apiproxy / dsh-llm 源码实测。

export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details: unknown } };

export interface ClientRequest {
  type: 'client-request';
  rpcId: string;
  method: string;
  payload: unknown;
}
export interface ServerResponse {
  type: 'server-response';
  rpcId: string;
  result: RpcResult<unknown>;
}
export interface ServerRequest {
  type: 'server-request';
  rpcId: string;
  method: string;
  payload: unknown;
}

// ---- 单工方法值 ----
export interface HostDescription {
  version: string;
  cwd: string;
  provider?: string;
  model?: string;
  attachedSessions: number;
  canOpenPath: boolean;
}
export interface SessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  cwd?: string;
  agentPreset?: string;
}
export interface SessionListValue {
  items: SessionSummary[];
}
export interface SessionCreateValue {
  sessionId: string;
  agentPreset?: string;
}
export interface PromptContentPart {
  type: 'text';
  text: string;
}
export interface SessionPromptRequest {
  sessionId: string;
  mode: 'queue' | 'steer';
  content: PromptContentPart[];
  clientTimeZone?: string;
}
export interface SessionPromptValue {
  accepted: true;
  command?: unknown;
}

// ---- 事件 ----
export interface SessionEvent {
  type: string;
  seq: number;
  time: number;
  data: any;
}

export type MuxFrame =
  | { type: 'session/event'; sessionId: string; event: SessionEvent; view?: unknown }
  | { type: 'session/subscribed'; sessionId: string; lastSeq: number }
  | { type: 'session/projection'; sessionId: string; key: string; value: unknown; seq: number }
  | { type: 'approval/requested'; sessionId: string; approvalId: string; toolName: string; callId?: string; reason?: string }
  | { type: 'question/requested'; sessionId: string; questions: AskUserQuestion[] }
  | { type: 'question/resolved'; sessionId: string; questionRpcId: string; outcome: 'answered' | 'cancelled' }
  | { type: 'session/queue'; sessionId: string; items: unknown[] }
  | { type: 'session/jobs'; sessionId: string; jobs: unknown[] }
  | { type: 'stream/error'; error: unknown }
  | { type: string; [k: string]: unknown };

export type HostFrame = { type: string; [k: string]: unknown };

// ---- AI 提问（模型调用 ask_user_question 时下发）----
export interface AskUserQuestionOption {
  label: string;
  description?: string;
}
export interface AskUserQuestionIntent {
  kind: 'plan-review';
  /** intent 为 plan-review 时，options 中代表「同意」的那个 label */
  approve: string;
}
export interface AskUserQuestion {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  options?: AskUserQuestionOption[];
  multiSelect?: boolean;
  intent?: AskUserQuestionIntent;
}
export interface AskUserQuestionAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}
export interface AskUserQuestionAnswer {
  answers: AskUserQuestionAnswerItem[];
}

// ---- 流式块（assistant/chunk 事件的 event.data.chunk）----
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: string; [k: string]: unknown };

export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: unknown }
  | { type: 'finish'; reason: string }
  | { type: string };

// ---- 工作区 ----
export interface WorkspaceView {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}
export interface WorkspaceListValue {
  items: WorkspaceView[];
  archivedSessionIds: string[];
}

// ---- Agent 预设 ----
export interface AgentPresetEntry {
  id: string;
  trust: 'system' | 'user';
  isDefault: boolean;
  name?: string;
  description?: string;
  broken?: string;
}
export interface AgentPresetListValue {
  presets: AgentPresetEntry[];
  authorable: boolean;
  hasDocument: boolean;
}

// ---- 模型选择 ----
export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}
export interface ModelCatalogModel {
  id: string;
  name: string;
  description?: string;
  reasoning?: {
    efforts: { id: string; name: string; description?: string }[];
    defaultEffort?: string;
  };
}
export interface ModelProviderGroup {
  id: string;
  name: string;
  models: ModelCatalogModel[];
}
export interface ModelCatalogFailure {
  id: string;
  name: string;
  message: string;
}
export interface SessionModelsValue {
  current: ModelSelection;
  routable: boolean;
  groups: ModelProviderGroup[];
  failures: ModelCatalogFailure[];
}

// ---- 会话历史 ----
export interface HistoryEntry {
  event: SessionEvent;
  view?: unknown;
}
export interface SessionHistoryValue {
  events: HistoryEntry[];
  hasMore: boolean;
  projections?: unknown;
}

// ---- 图片附件 ----
export interface ImageAttachmentRef {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
}
export interface SessionAttachmentValue {
  attachment: ImageAttachmentRef;
  data: string; // base64
}

// ---- 应答信封（审批 / 提问）----
export type RespondResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: unknown } };
export interface ClientResponse {
  type: 'client-response';
  rpcId: string;
  result: RespondResult;
}
export interface ApprovalResponsePayload {
  sessionId: string;
  approvalId: string;
  outcome: 'allowed-once' | 'rejected';
}
export interface QuestionResponsePayload {
  sessionId: string;
  answer: AskUserQuestionAnswer;
}
export interface RespondReceipt {
  accepted: boolean;
  reason?: 'not-pending' | 'bad-response';
}
