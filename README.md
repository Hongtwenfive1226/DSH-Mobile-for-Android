# DSH Mobile

DeepSeek Harness（DSH）的移动端客户端，基于 React Native（Android）。通过 Tailscale 安全访问运行在桌面端的 DSH，在手机上完成对话、工作区管理、工具审批、任意文件上传/下载等操作，并在**对话中途切换 Agent 模式**。

> 配套的桌面端增强（会话中途切换模式按钮）见 [`desktop-plugin/`](desktop-plugin/)；Windows 上的 **Git Bash 版极简模式**预设见 [`presets/minimal-bash/`](presets/minimal-bash/)。

---

## 功能亮点

- 🔄 **对话中更换模式**：默认以「极简模式」开始，对话进行到任意时刻（首次回复结束后）都能切换成标准/代码/创造等其它预设——手机端侧边栏「切换模式」、桌面端会话头部「切换模式」按钮，两条路共用同一后端能力。
- 🐧 **Git Bash 版极简模式**：Windows 上不用装 WSL，也能让极简模式跑在 Git Bash(MSYS2) 上；手机端默认优先选它。
- 📜 会话历史与桌面端完全同步：上滑可一路翻到第一条（分页 + 主机端 `compact` 瘦身，一页从 MB 级降到 KB 级）。
- 💭 思维链输出：助手回复可展开查看完整推理过程（历史与流式都支持）。
- 🛠 工具调用卡片 + 审批弹窗（允许/拒绝）
- 📎 任意文件上传到宿主机 / 下载到手机（文件桥），🖼 图片附件下载
- ⏹ 停止当前对话、📊 Token 实时显示（输入/输出/缓存命中）
- ⚙️ 设置：服务器地址、Agent 预设、模型选择（本地持久化）

## 架构

```
手机（RN App）
   │  HTTP POST /api/<namespace>/<method>（payload = { args: { … } }）
   │  + 一条 WebSocket /api/remote.mux（逻辑流：$events / session/control /
   │    workspace/follow / session/follow）
   ▼
转发器 poc/forwarder.mjs（监听 Tailscale IP，如 100.x.x.x:8787）
   │  转发到 127.0.0.1:19387（自动探测端口）
   │  └─ 用 ~/.dsh/.credentials.yaml 里的密钥自行签发浏览器会话 cookie，
   │     Host 重写为 loopback：同时满足 0.2.0 的 trust-fence 与 cookie audience
   │  └─ 附带文件桥：POST /files 上传、GET /files?path= 下载、GET /healthz 探活
   ▼
DSH 0.2.0-rc.1（官方 Electron 桌面版，127.0.0.1:19387）
```

DSH 0.2.0 的 `/api` 是类型化 RPC：endpoint 形如 `<namespace>/<method>`，payload 恰好一个字段
`args`（具名参数），每个方法与 WebSocket 都需要浏览器会话 cookie。协议细节（含实测记录）见
[`poc/protocol.md`](poc/protocol.md)、[`docs/api-streams.md`](../../dsh-mobile-poc/docs/api-streams.md)，
公网安全接入方案见 [`poc/P2-public-access.md`](poc/P2-public-access.md)。

## 目录结构

```
App.tsx、src/dsh/             RN 应用（DSH 协议客户端 client.ts + 类型 types.ts）
android/、ios/                原生工程
build-android.cmd             Windows 一键构建脚本（自动定位 JDK17 + Android SDK）
poc/                          转发器 forwarder.mjs、协议参考、协议探针
desktop-plugin/dsh-mode-switcher/  桌面端「会话中途切换模式」插件（可选安装）
presets/minimal-bash/         Git Bash 版极简模式预设（复制到 DSH 预设目录即可用）
.github/workflows/            GitHub Actions 自动构建 release
```

---

## 安装部署

### 0. 前置条件

- 桌面端：Node.js ≥ 22（仅转发器需要）、**DSH 0.2.0-rc.1 桌面版**已安装并配置好模型
- Windows 桌面端：已安装 [Git for Windows](https://git-scm.com/download/win)（提供 Git Bash）
- 桌面与手机都安装 [Tailscale](https://tailscale.com/) 并登录**同一账号**
- 构建 APK：JDK 17 + Android SDK（推荐 Android Studio）

### 1. 桌面端运行 DSH

直接启动 **DeepSeek Harness 桌面版**（0.2.0-rc.1）。它会在 `127.0.0.1` 上随机/固定端口提供
Web GUI 与 `/api`（当前实测为 **19387**）；转发器会自动探测这个端口，无需手工配置。

> 0.1.x 时代的 `dsh web`（3080）已不再适用：新版每个请求都要浏览器会话 cookie。

### 2. 创建 Git Bash 版极简模式（可选，但手机端默认会优先选它）

DSH 官方预设（`standard`/`code`/`minimal`/`cordis`）只读，需复制一份到用户预设目录再改：

1. 把本仓库 [`presets/minimal-bash/`](presets/minimal-bash/) 整个目录复制到
   - Windows：`C:\Users\<你>\.dsh\.agent-presets\minimal-bash\`
   - Linux/macOS：`~/.dsh/.agent-presets/minimal-bash/`
2. 若你的 Git Bash 不在 `C:\Program Files\Git\bin\bash.exe`，改 `agent.cordis.yml` 里 `terminal-bash` 的 `shellPath`。
3. 重启 DSH，预设列表里会出现「极简模式 (Git Bash)」。

> 这个预设 = 官方 `minimal`（固定人设 + `bash` + `str_replace_editor` 双工具），只是把 shell 换成 Git Bash。手机端 `App.tsx` 里的默认预设选择顺序：`minimal-bash` → `minimal` → 系统默认。

### 3. 主机端 patch（DSH 0.2.0 起已不再需要源码补丁）

- **历史分页**：0.2.0 的 `session/page` 原生就是「按消息分页」的接口，不再返回逐 token 的
  `assistant/chunk`，所以 0.1.x 时代给 `session.history` 打的 `compact` 补丁**已经不需要了**
  （`poc/patch-dsh.mjs` 只对 0.1.x 的 npm 安装有效，对 0.2.0 的 Electron 打包版无效）。
- **鉴权**：0.2.0 的每个 `/api` 与 WebSocket 都要浏览器会话 cookie，而启动令牌是进程内随机值、
  外部拿不到。转发器改用 `~/.dsh/.credentials.yaml` 里 `client-connection/browser-session`
  记录的签名密钥**自行签发 cookie**，因此手机侧不需要任何额外配置。
- **对话中切换模式**：0.2.0 仍然禁止在会话开始后切换预设
  （宿主报 `agent-preset/locked`）。手机端的「切换模式」按钮此时会显示该错误；
  如需真正解锁，需要在 DSH 的 profile 补丁层（`$DSH_HOME/profiles/desktop/cordis.patch.yml`）
  里插一个主机插件改写这个检查（本项目后续提供）。

### 4. （可选）桌面端也加「切换模式」按钮

让电脑浏览器里的 DSH 会话头部也有切换按钮（与手机端共用同一后端能力）：

1. 把 [`desktop-plugin/dsh-mode-switcher/`](desktop-plugin/dsh-mode-switcher/) 复制到
   `$DSH_HOME/profiles/web/node_modules/dsh-mode-switcher/`
   （Windows：`C:\Users\<你>\.dsh\profiles\web\node_modules\dsh-mode-switcher\`）
2. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里插入一行：

   ```yaml
   - insert:
       - id: mode-switcher
         name: dsh-mode-switcher
   ```

3. 重启 DSH，刷新浏览器页面即可。

### 5. 启动转发器

```bash
cd poc
node forwarder.mjs
# 默认监听 YOUR_TAILSCALE_IP:8787；用环境变量覆盖：
#   LISTEN_HOST=<你的 Tailscale IP>  LISTEN_PORT=8787  FILE_ROOT=<工作区根目录>
```

`FILE_ROOT` 是文件桥可读写的根目录，上传的文件落在 `FILE_ROOT/shared-files/`。**只绑 Tailscale IP**，不暴露给局域网/公网。

### 6. 构建并安装 APK

```bash
npm install
build-android.cmd assembleRelease -PreactNativeArchitectures=arm64-v8a
# 产物：android/app/build/outputs/apk/release/app-release.apk
```

> 国内 Gradle 下载慢已处理：`android/gradle/wrapper/gradle-wrapper.properties` 默认用腾讯镜像。

把 APK 传到手机安装；或直接下载 GitHub Release 里的预构建 APK（见下）。

### 7. 配置

| 位置 | 说明 |
|---|---|
| `App.tsx` 的 `DEFAULT_BASE_URL` | 转发器地址（Tailscale IP + 端口），也可在 App 内「设置」里改 |
| `poc/forwarder.mjs` 的 `FILE_ROOT` | 文件桥根目录，上传落 `shared-files/` |
| 明文 HTTP | 已放行（Tailscale 内自带 WireGuard 端到端加密） |

---

## 对话中更换模式（说明）

- **默认极简，随时可换**：新会话默认用极简模式（优先 `minimal-bash`）；首次对话结束、回复完成后，即可在手机端侧边栏或桌面端会话头部点击「切换模式」换成任意预设。
- **原理**：切换走 DSH 既有的 `agentPreset.select` RPC，调 `agentPresets.recompose()` 把该会话重新挂到目标预设的常驻组合上，并写入 `agent-preset/selected` 事件（历史与模型可见性一致）。
- **前置**：必须完成上面「步骤 3」的主机 patch，否则对话开始后切换会被拒绝。

## Git Bash 版极简模式（说明）

- 解决 Windows 上没有 WSL 时极简模式的持久化 shell 不可用的问题：用 Git Bash(MSYS2) 作为 `bash` 后端。
- 与官方 `minimal` 完全等价的能力（固定人设、`bash`、`str_replace_editor`），仅 `shellPath`/`shellArgs` 不同。
- 手机端 `App.tsx` 默认预设选择顺序优先 `minimal-bash`，因此装上即自动用上。

## 文件桥（任意文件上传/下载）

DSH 原生附件域只支持图片，任意文件走旁路「文件桥」：

- **上传**：输入框 📎（黑色回形针）选任意文件 → 传到宿主机 `shared-files/` → 路径自动填入输入框 → 发送后 agent 即可读取
- **下载**：聊天里点击 `D:\...` 路径，或侧边栏「下载宿主机文件」手动输入路径
- 实现：`poc/forwarder.mjs` 的 `POST /files` / `GET /files?path=`（限制在工作区内，文件名穿越清洗，单文件上限 100MB）

## GitHub Actions 自动构建 release

`.github/workflows/build-release.yml` 在**推送 `v*` 标签**时自动构建 arm64-v8a release APK 并创建 GitHub Release 附带 APK；也可在 Actions 页面手动触发（`workflow_dispatch`）。

发布一个新版本：

```bash
git tag v1.4.0
git push origin v1.4.0
```

## 版本历史

见 [`CHANGELOG.md`](CHANGELOG.md)。

## 已知限制

- DSH 原生附件域仅支持图片（png/jpeg/webp/gif）；任意文件走文件桥（旁路，不参与 DSH 附件/导出体系）
- 明文 HTTP（Tailscale 内已有 WireGuard 端到端加密，但应用层无 TLS；正式化应加 `wss://` + 认证）
- 当前按 `arm64-v8a` 单架构打包，老机型需改 `-PreactNativeArchitectures`
- 桌面能力（`host.openPath`、`host.pickDirectory` native）在手机不可用
- 「对话中切换模式」与「compact 历史」两处主机 patch 位于 DSH 的 node_modules 内，`npm update dsh` 后需重新打

## 协议

[`poc/protocol.md`](poc/protocol.md) 是从 DSH 源码提取的 `/api` wire 协议完整参考；[`poc/spike-client.mjs`](poc/spike-client.mjs) 是非浏览器客户端最小探针（`describe`/`list`/`stream`/`prompt`），可用于验证宿主连通性与协议。

## License

MIT
