# DSH Mobile

DeepSeek Harness（DSH）的移动端客户端，基于 React Native。通过 Tailscale 安全访问桌面端 DSH，在手机上完成对话、工作区管理、工具审批、任意文件上传/下载等操作。

## 特性

- 📱 多会话、工作区切换、会话历史（与桌面端一致）
- 🛠 工具调用卡片 + 审批弹窗（允许/拒绝）
- 📎 任意文件上传到宿主机 / 下载到手机（文件桥）
- 🖼 DSH 原生图片附件下载
- ⏹ 停止当前对话
- 📊 Token 消耗实时显示（输入/输出/缓存命中）
- ⚙️ 设置：服务器地址、Agent 预设、模型选择（本地持久化）
- 🔵 DeepSeek 鲸鱼启动图标

## 架构

```
手机（RN App）
   │  HTTP POST /api/*  +  WebSocket 下行（events.mux / events.host）
   ▼
转发器 poc/forwarder.mjs（监听 Tailscale IP，例如 YOUR_TAILSCALE_IP:8787）
   │  转发到 127.0.0.1:3080，Host 重写为 loopback 以通过 DSH trust-fence
   │  └─ 附带文件桥：POST /files 上传、GET /files?path= 下载
   ▼
DSH web（127.0.0.1:3080，桌面端 dsh web）
```

DSH 的 `/api` 是类型化 RPC（HTTP 上行 + 两条纯下行 WebSocket），协议细节见 [`poc/protocol.md`](poc/protocol.md)。

## 目录结构

- `App.tsx`、`src/dsh/` — RN 应用（DSH 协议客户端 `client.ts` + 类型 `types.ts`）
- `android/`、`ios/` — 原生工程
- `build-android.cmd` — Windows 一键构建脚本（自动定位 JDK17 + Android SDK）
- `poc/` — 转发器、协议参考、协议探针

## 快速开始

### 前置

1. 桌面端运行 DSH：`dsh web`（绑定 `127.0.0.1:3080`）
2. 桌面与手机都安装 Tailscale 并登录**同一账号**
3. 桌面运行转发器：
   ```bash
   node poc/forwarder.mjs
   # 默认监听 YOUR_TAILSCALE_IP:8787，可用环境变量覆盖：
   # LISTEN_HOST / LISTEN_PORT / FILE_ROOT
   ```

### 构建（Android）

1. 安装 JDK 17 + Android SDK（推荐 Android Studio）
2. `npm install`
3. `build-android.cmd assembleRelease`（或 `cd android && ./gradlew.bat assembleRelease`）
4. 产物在 `android/app/build/outputs/apk/release/app-release.apk`，传到手机安装

> 国内网络 Gradle 下载慢：改 `android/gradle/wrapper/gradle-wrapper.properties` 的 `distributionUrl` 为国内镜像（本项目默认已用腾讯镜像）。

### 配置

| 位置 | 说明 |
|---|---|
| `App.tsx` 的 `DEFAULT_BASE_URL` | 转发器地址（Tailscale IP + 端口），也可在 App 内「设置」里改 |
| `poc/forwarder.mjs` 的 `FILE_ROOT` | 文件桥根目录（默认 `D:\AutoDS`），上传落 `shared-files/` |
| 明文 HTTP | 已放行（Android `usesCleartextTraffic`、iOS `NSAllowsArbitraryLoads`） |

## 文件桥（任意文件上传/下载）

DSH 原生附件域只支持图片，因此任意文件走旁路「文件桥」：

- **上传**：输入框 📎 选任意文件 → 传到宿主机 `shared-files/` 收件箱 → 路径自动填入输入框 → 发送后 agent 即可读取
- **下载**：聊天里点击 `D:\...` 路径，或侧边栏「下载宿主机文件」手动输入路径
- 实现：`poc/forwarder.mjs` 的 `POST /files` / `GET /files?path=`（路径限制在工作区内，文件名做穿越清洗，单文件上限 100MB）

## 已知限制

- DSH 原生附件域仅支持图片（png/jpeg/webp/gif）；任意文件走文件桥（旁路，不参与 DSH 附件/导出体系）
- 明文 HTTP（Tailscale 内已有 WireGuard 端到端加密，但应用层无 TLS；正式化应加 `wss://` + 认证）
- 当前按 `arm64-v8a` 单架构打包，老机型需改 `-PreactNativeArchitectures`
- 桌面能力（`host.openPath`、`host.pickDirectory` native）在手机不可用

## 协议

[`poc/protocol.md`](poc/protocol.md) 是从 DSH 源码提取的 `/api` wire 协议完整参考；[`poc/spike-client.mjs`](poc/spike-client.mjs) 是非浏览器客户端最小探针（`describe`/`list`/`stream`/`prompt`），可用于验证宿主连通性与协议。

## License

MIT
