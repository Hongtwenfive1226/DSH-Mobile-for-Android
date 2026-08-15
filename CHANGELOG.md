# 更新日志

本项目的版本号（`versionCode` / `versionName`）与 APK 的 Android 版本信息一致。所有版本均可通过文件桥或 GitHub Release 下载。

## v1.4（versionCode 5）— 2026-08-15

**历史分页修复 + 黑色回形针图标**

- 🐛 修复「上滑到顶部不加载更早记录」：
  - 触发点由单一 `onScroll` 阈值改为 `onScroll` / `onScrollEndDrag` / `onMomentumScrollEnd` 三重触发，阈值放宽。
  - 顶部新增「正在加载更早的记录…」加载指示器。
  - 切换会话时增加防串页守卫。
- ⚡ 主机端 `session.history` 新增 `compact` 标志：只返回消息/工具等表层事件，跳过逐 token 的 `assistant/chunk`，一页历史从约 8 MB 降到约 50 KB（需重启 DSH 生效，未重启时降级为慢速全量）。
- 🎨 附件回形针图标由 emoji 📎 换成纯黑色矢量图（`react-native-svg`，Material Design `attach_file` 路径）。

## v1.3（versionCode 4）— 2026-08-15

**历史分页 + 思维链**

- ✨ 会话历史分页：上滑到顶部自动加载更早一页，可一路翻到第一条（`session.history` 的 `beforeSeq` 游标 + `maintainVisibleContentPosition`）。
- ✨ 思维链输出：助手回复新增可折叠的「💭 思维链」区域，支持历史消息与流式增量（`reasoning-delta`）两种来源。

## v1.2（versionCode 3）— 2026-08-15

**滚动体验修复**

- 🐛 修复「上滑查看历史被强制回滚到底端」：只在用户贴着底部时才自动跟随新内容，上滑回看时保持位置不动；切换/新建会话时重置滚动到最新。

## v1.1（versionCode 2）— 首个发布版

**基础功能完备**

- 📱 多会话、工作区切换、会话历史（与桌面端一致）
- 🔄 对话中切换 Agent 预设（手机端侧边栏「切换模式」按钮；需桌面端主机 patch）
- 🛠 工具调用卡片 + 审批弹窗（允许/拒绝）
- 📎 任意文件上传/下载（文件桥）+ 🖼 图片附件下载
- ⏹ 停止当前对话、📊 Token 实时显示、⚙️ 设置本地持久化
- 🐧 Git Bash 版极简模式（`minimal-bash` 预设）优先选择
- 🔵 DeepSeek 鲸鱼启动图标
- 🛠 键盘遮挡适配（edge-to-edge）、Android 构建脚本、国内 Gradle 镜像
