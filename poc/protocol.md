# DeepSeek Harness `/api` 传输协议参考（非浏览器客户端视角）

> 本文从源码实测提取（`@deepseek-ai/dsh-host-apiproxy`、`@deepseek-ai/dsh-client-connection`），
> 供 React Native 等非浏览器客户端实现连接层时参考。版本对应 `0.1.0-rc.6`。

## 1. 总体模型：四象限消息 + 三个物理通道

协议是「谁发起 × 请求/响应」的四象限判别联合，与物理通道解耦：

| 象限 | 方向 | 载体 |
|---|---|---|
| `client-request` | C→S | `POST /api/<method>` body |
| `server-response` | S→C | 上述 POST 的响应 body |
| `server-request` | S→C | 下行 WebSocket 文本帧（`/api/events.mux`、`/api/events.host`） |
| `client-response` | C→S | `POST /api/respond` body（应答审批/提问帧） |

- 上行（命令/应答）走 **HTTP POST**；下行（事件流）走 **两条纯下行 WebSocket**（客户端不向上游发数据）。
- HTTP 状态码只表达传输层；业务成败在 `result` 槽里（`ok:true|false`）。
- 所有 `/api` POST 必须带 `Content-Type: application/json`，否则 415。

## 2. 信封（envelope）JSON 结构

```jsonc
// client-request（发起单工调用时自己 mint rpcId）
{ "type": "client-request", "rpcId": "<uuid>", "method": "session.list", "payload": {} }

// server-response（rpcId 必须回显请求的 rpcId）
{ "type": "server-response", "rpcId": "<uuid>", "result": { "ok": true, "value": { /* 业务值 */ } } }
{ "type": "server-response", "rpcId": "<uuid>", "result": { "ok": false, "error": { "code": "internal", "message": "...", "details": {} } } }

// server-request（下行 WS 每个文本帧是一条完整 JSON，payload 是 MuxFrame / HostFrame）
{ "type": "server-request", "rpcId": "<uuid>", "method": "events.mux", "payload": { "type": "session/event", ... } }

// client-response（应答需要回应的 server-request，rpcId 回显）
{ "type": "client-response", "rpcId": "<uuid>", "result": { "ok": true, "value": { /* 审批/问答应答 */ } } }
```

错误码（`code`）是封闭集合，见 `rpc.schema.js` 的 `rpcErrorSchema`（如 `session-not-found`、`model-unavailable`、`internal`、`bad-request` 等）。

## 3. 端点

| 端点 | 方式 | 说明 |
|---|---|---|
| `/api/<method>` | POST | 单工 RPC（方法名带点号，如 `session.list`、`host.describe`） |
| `/api/respond` | POST | 应答审批/提问帧，返回 `{accepted:true}` 或 `{accepted:false,reason}` |
| `/api/events.mux` | WS 升级 | 会话级事件流（`session/event`、`approval/requested`、`question/requested`、`session/projection` 等） |
| `/api/events.host` | WS 升级 | 宿主级事件流（`host/session-added`、`host/workspace-changed` 等） |
| `/api/session.export` | GET | 会话日志导出 ZIP（`?sessionId=…`） |

WS 文本帧 = 一条 `server-request` 完整 JSON，**没有 SSE 的 `data:`/`\n\n` 分帧**（那是进程内 carrier 专用）。

## 4. readiness 握手（连接建立流程，等价浏览器 ConnectionController）

1. 并发打开 `/api/events.mux` 与 `/api/events.host` 两条 WS；
2. `host.describe`（payload `{}`）成功后，即可认为「已连接」；
3. mux 流会立即推送每个已挂载会话的 `session/subscribed` 基线帧（`{sessionId,lastSeq}`），并回放未决审批/提问/队列/任务基线。

## 5. 关键方法 payload/响应（已实测验证）

| 方法 | payload | 响应 value |
|---|---|---|
| `host.describe` | `{}` | `{version, cwd, provider?, model?, attachedSessions, canOpenPath}` |
| `session.list` | `{cursor?}` | `{items:[{sessionId,updatedAt,running,blank,cwd?,agentPreset?,projections?}]}` |
| `workspace.list` | `{}` | `{items:[{workspaceId,path,title,sessionIds,...}], archivedSessionIds}` |
| `session.create` | `{workspaceId?|cwd?, sessionId?, agentPreset?}` | `{sessionId, agentPreset?}` |
| `session.prompt` | `{sessionId, mode:'queue'|'steer', content:[{type:'text',text}], clientTimeZone?}` | `{accepted:true, command?}` |
| `session.history` | `{sessionId, beforeSeq?, maxMessages?}` | `{events, hasMore, projections?}` |
| `session.cancel` | `{sessionId}` | `{accepted:true}` |
| `llm.models` / `llm.providers` | `{}` | 模型目录 |

完整方法清单见 `AbstractApiClient` 的 `UNARY_VALUE_SCHEMAS` 表（`session.*`、`subagent.*`、`host.*`、`workspace.*`、`skill.list`、`agentPreset.*`、`goal.*`、`settings.*`、`credentials.*`、`llm.*`）。

## 6. 事件帧（MuxFrame / HostFrame，按 `type` 判别）

- 会话流关键帧：`session/event`（`{sessionId,event:{type,seq,time,data},view?}`，`event.type` 含 `turn/start`、`step/start`、`user/message`、`assistant/chunk`(流式)、`assistant/message`、`tool/call`、`tool/result`、`step/end`、`turn/end` 等）、`session/subscribed`、`session/projection`、`session/queue`、`session/jobs`、`approval/requested`、`approval/resolved`、`question/requested`、`question/resolved`、`stream/error`。
- 宿主流关键帧：`host/session-added`、`host/session-removed`、`host/session-status`、`host/workspace-changed`、`host/remote-event` 等。

## 7. trust-fence（/api 安全边界，公网接入的关键）

- 每个 `/api` 请求/WS 升级都必须携带一个 **loopback 或 `trustedHosts` 声明的 Host 头**，否则 403（实测：`127.0.0.1:3080`→200，`192.168.1.50:3080`→403，`evil.example.com`→403）。
- 这是「可达性策略」，**不是认证**。v1 无 TLS、无认证层。
- 非浏览器客户端（Node/RN 的 fetch+WS 不发 `Origin`/`Sec-Fetch-Site`）按「无标记请求」处理，靠 Host 头权威判定。

## 8. React Native 实现要点

- 用 RN 自带 `fetch` + `WebSocket` 即可，等价于本次 PoC 的 Node 实现（都是「非浏览器无标记」姿势，已实测通过）。
- 需要自实现 `AbstractApiClient` 等价物：rpcId mint（`crypto.randomUUID` 在 RN 需 polyfill 或用自造 uuid）、信封 wrap/unwrap、`server-response` 的 rpcId 回显校验、WS 文本帧 JSON 解析、重连/退避（浏览器默认 500ms 起步 ×2 封顶 10s，流打开超时 3s）。
- 30s 单工默认超时；`host.pickDirectory` 等用户节奏调用不用该超时。
- 事件过滤：`session/event` 按 `sessionId` 过滤；`session/projection` 用「高 seq 覆盖」策略。

## 9. 已知边界（对移动端的影响）

- 无协议版本字段；`host.describe` 是唯一的握手点。客户端必须与宿主同版本发布。
- `host.pickDirectory`/`host.openPath`/`host.openDocument` 依赖宿主桌面，移动端需降级（改 `host.listDirectory` browse 后端，或禁用）。
- 图片上限等能力在 `session/projection` 的 `imageLimits` 里发布。
