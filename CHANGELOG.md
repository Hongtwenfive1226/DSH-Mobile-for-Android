# 更新日志

本项目的版本号（`versionCode` / `versionName`）与 APK 的 Android 版本信息一致。所有版本均可通过文件桥或 GitHub Release 下载。

## v1.13（versionCode 14）— 2026-09-20

**「大段空白」的真正根因：虚拟化列表的估算高度 spacer（已定位到 RN 源码）**

前几版一直在改「滚动位置怎么算」，方向错了：空白不是滚动算错，而是**列表根本没用真实内容占位**。

- 🐛 **根因（可在 RN 源码中逐行核对）**：`@react-native/virtualized-lists/Lists/VirtualizedList.js`
  - `:1045` 渲染窗口之外的消息不渲染真实内容，而是用一个 **spacer** 占位，高度来自
    `getCellMetricsApprox()` = **平均 item 高度估算**（没有 `getItemLayout` 时只能是估算）；
  - `:634` 窗口的起始下标可以**不是 0**；`:1024` 窗口尾部的 spacer 还会被裁到「已测量下标」；
  - 反转列表的「家」（滚动偏移 0 = 最新一条）正好落在**内容坐标 0..V，也就是下标 0 那一段**。
    窗口一旦滑走，偏移 0 处看到的就是这个 spacer：**一片什么都没有的空白**，
    而它位于滚动范围的最小端 —— 再怎么滑也滑不出内容来，这就是「滚不到底」。
  - 本项目的消息高度差异极大（只有「💭 思维链」入口的一行 vs 几千像素的长回复），
    平均高度估算必然错得离谱，所以「只会对部分对话内容触发、一进会话就固定出现」。
- ✅ **修复**：消息列表关闭虚拟化（`disableVirtualization`）。RN 的实现保证窗口永远从下标 0 开始
  （`:634` `first: 0`），且**完全不生成 spacer**（`:1020`）。每页只有 50 条，全部真实布局，
  这类空白从结构上不再可能发生；滚动偏移 0 / 上滑加载更早历史的语义保持不变。
- ⚡ 每行消息抽成 `React.memo` 的 `MessageRow`：关闭虚拟化后所有已加载消息都挂载，
  流式增量（每个 chunk 都会 `setItems`）不再重建整列，只重渲染真正变化的那一条。
- 🛡️ 超长文本节点加固（Android 需要整段参与排版，不只是「显示几行」）：
  工具参数截断到 800 字、工具结果截断到 4000 字并标注「已截断」
  （实测真实会话里有 2.5 万字的参数、6.5 万字的结果）；`tool/call` 缺 `name` 时兜底为「工具」
  （否则卡片会渲染成一个完全没有文字的空白块）。
- 🛡️ 正文只有空白的助手消息不再生成空气泡（解析后是空节点，视觉上就是空白）。
- 🧪 新增 `__tests__/history.test.ts`（12 项解析回归）与 `__tests__/MessageRow.test.tsx`
  （5 项渲染回归：每种条目都必须产出可见文字）。
- 🔎 设置页新增排查开关「显示每条消息的布局信息」：打开后每条消息上方显示
  `下标 / 事件 id / 实测高度 / 字数`。万一还有空白，打开它截图就能直接指认是哪一条
  （id 就是会话日志里的事件 `seq`），不必再猜。默认关闭，不影响正常使用。

## v1.12（versionCode 13）— 2026-09-20

**Markdown 布局塌陷修复（宽度分配）**

- 🐛 助手气泡改为**占满可用宽度**（与电脑端一致）。此前是「按内容自适应宽度」，
  而 Markdown 的表格 / 列表用 `flex` 分配宽度——**`flex: 1` 在宽度不确定的父级里会塌成 0 宽**，
  文字被 `overflow: hidden` 裁掉，整块变成空白。
- 🐛 Markdown 内部块改为**不依赖父级宽度**也能正常渲染：
  - 列表正文 `flex: 1` → `flexShrink: 1`（不再塌成 0）；
  - 表格单元格 `flex: 1` → `flexGrow/flexShrink/flexBasis:'auto'`（宽度不定时不塌，确定时仍均分）；
  - 表格 / 代码块 / 引用块加 `alignSelf: 'stretch'` 占满气泡宽度；
  - 代码块横向 ScrollView 加 `flexGrow: 0`（抵消 ScrollView 自带基础样式，避免纵向撑开）。
- 说明：已用真实会话数据（284 条助手回复）验证过「塌宽」只在极少数情况下发生，
  因此**本次修复不一定是用户所见空白的全部原因**，仍需要截图定位。

## v1.11（versionCode 12）— 2026-09-20

**改用反转列表（inverted）——从根上消除底部空白与滚不到底**

前几版一直在「按内容高度算滚动位置」（`scrollToEnd` / `scrollToOffset` 补偿 / `maintainVisibleContentPosition`），
但**虚拟化列表的内容高度并不可靠**：一旦算错就会落进尚未渲染的区域，表现就是
「反复切换会话后出现大段空白 / 滚不到底」。这一版换成聊天列表的标准架构：

- ♻️ `inverted` 反转列表：`data` 为「最新在前」，**滚动偏移 0 就是最新一条**。
  - 打开/切换会话**天然**落在最新一条 —— 不再需要 `scrollToEnd`，也不依赖内容高度，竞态消失；
  - 上滑加载更早历史 = 追加到反转数据末尾（视觉上方），**视口不会移动**，
    因此彻底删除了 prepend 位置补偿逻辑；
  - 内容天然贴底，最后一条下面不会再有空白。
- 🧹 移除全部脆弱逻辑：`onContentSizeChange` 补偿、`pendingPrependRef`/`prependAnchorRef`/
  `contentHeightRef`/`pendingBottomRef`/`scrollYRef`、`maintainVisibleContentPosition`。
- ⚙️ 配套：`removeClippedSubviews={false}`（Android 上 inverted 与裁剪同开会空白）、
  `ListEmptyComponent` 不手动翻转（RN 已自动反向翻转，手翻会导致文字颠倒）。
- ✨ 顺带改进：会话历史加载中显示「正在加载对话…」，失败显示原因 + **重试按钮**，
  不再让「还在加载/加载失败」看起来像整片空白；发送消息后自动回到最新一条。

## v1.10（versionCode 11）— 2026-09-20

**底部空白与「切会话后滚不到底」修复**

- 🐛 修复「最下方消息下面留大段空白」：
  - `removeClippedSubviews={false}` —— Android 默认开启离屏视图分离，在变高消息列表里会造成大段空白区域；
  - 内容**短于视口时贴底显示**（`contentContainerStyle` 的 `flexGrow + justifyContent:'flex-end'`），与电脑端一致，最后一条下面不再留空；
  - 内边距从 `style` 移到 `contentContainerStyle`（Android 上 `style` 的 padding 会裁切内容）。
- 🐛 修复「切换会话后时不时无法下滚到底部」：根因是首帧的 `onScroll` 会先把
  「在底部」标记冲成 false，导致加载完成那一刻不再自动滚到底。新增独立的
  `pendingBottomRef`（打开/切换/新建会话时置位，强制落底），**用户一旦手动拖动就交还控制权**
  （`onScrollBeginDrag` 清除），不再依赖易被覆盖的标记。
- 🛡 键盘残留高度加固：会话切换时清零 `kbHeight`，并补挂 `keyboardWillShow/WillHide`
  双保险（漏报一个事件会残留一块底部空白）。

## v1.9（versionCode 10）— 2026-09-20

**防白屏与错误可见化（诊断加固）**

- 🛡 新增 `src/ui/ErrorBoundary.tsx`：release 包没有红屏，渲染期一个未捕获异常就会卸载整棵树，
  表现为「全白、点不动」。现在分两层兜底——
  - 最外层（应用级）：未预期异常显示为可读的错误面板（含 message/stack/组件栈）＋「重试」；
  - 消息列表单独一层：某条消息出问题也不会带崩输入框、侧边栏与设置页。
- 🛡 Markdown 渲染加兜底：解析失败或渲染异常时**退化为纯文本**显示该条消息，不再影响整屏。
- 已用真实会话内容（267 条助手回复 / 68800 字，含 15 条表格、14 段代码块、37 个标题）回归验证
  Markdown 渲染器本身无异常；若仍出现白屏，这一版的错误面板会直接显示原因。

## v1.8（versionCode 9）— 2026-09-19

**手机端回答 AI 提问（ask_user_question）**

- ✨ 新增「AI 提问」弹窗：模型调用 `ask_user_question` 时，手机上可直接作答，无需回到电脑。
  - 支持单选题（点选互斥）与多选题（可多选），选项带描述
  - 每题都可填「自定义答案」；单选下选项与自定义答案自动互斥（符合宿主校验规则）
  - 多题一次性展示，逐题作答后统一提交；顶部显示「问题 i / n」
  - `detail`（如 plan-review 的计划正文）以可滚动区域展示
  - 可取消（宿主把该次工具调用判为 `cancelled`）
- 🔌 协议：走 DSH 的 `question/requested` server-request 帧（events.mux 下行），
  作答通过 `POST /api/respond` 的 `client-response` 回传（与审批同一通道）。
- 🧪 新增 `__tests__/questions.test.ts`（17 条）：守住宿主 `matchesQuestions` 的硬规则
  （等长/id 对齐、单选至多一项、custom 与 selected 在单选下互斥、custom 非空等）。

## v1.7（versionCode 8）— 2026-09-19

**紧急修复：Markdown 表格导致 App 卡死**

- 🐛 修复 v1.6 引入的严重 bug：`renderTable` 遍历 token 时，遇到 `thead_open` / `thead_close`
  **只设置标志位、没有推进下标**，形成死循环把 JS 线程锁死 —— 只要会话里出现过 Markdown 表格，
  App 就会表现为「对话一直加载不出来、任何按钮都点不动」。
- 🛡 给 Markdown 渲染器所有 token 遍历循环加上「下标必须前进」的保险，杜绝同类死循环再次锁死界面。
- ✅ 新增 `__tests__/Markdown.test.tsx` 回归测试（9 条）：表格/标题/强调/代码块/嵌套列表/引用/
  链接与宿主路径/原始 HTML/混合长文档，其中表格用例专门守住这次的问题。

## v1.6（versionCode 7）— 2026-09-16

**Markdown 渲染**

- ✨ 助手回复改为真正的 Markdown 渲染（新组件 `src/ui/Markdown.tsx`）：
  - 标题（# ~ ######）、段落、**粗体**、*斜体*、~~删除线~~、`行内代码`
  - 围栏代码块（带语言标签、等宽字体、可横向滚动）
  - 有序 / 无序列表（支持嵌套）、引用块、分隔线
  - 表格（表头高亮、自动等分列）
  - 链接与自动链接（点击用系统浏览器打开）、图片转可点链接
- ♻️ 解析用 `markdown-it`（纯 JS，无原生依赖），token 流自行映射到 RN 组件；
  普通文本里的宿主 `D:\...` 路径仍可点击下载（能力保留）。
- 用户自己发的消息保持纯文本渲染（避免误伤输入内容）。

## v1.5（versionCode 6）— 2026-08-15

**滚动回弹修复**

- 🐛 修复「滑到最下时被弹回历史中段」：移除 `maintainVisibleContentPosition`。
  该 Android 原生实现在上滑读历史时记录了锚点消息，之后任何内容变化（虚拟化补渲染、加载指示器增删）都会把视图拉回该锚点，表现为滚到底部却被弹回中段。
- ♻️ 改为手动补偿：`loadOlder` 前记录滚动位置，`onContentSizeChange` 按内容增高量等量补偿偏移，prepend 更早历史时阅读位置保持不动，且不再影响向下滚动。
- 🎨 顶部「正在加载更早的记录…」由列表头（会改变内容高度、干扰补偿）改为绝对定位浮层。

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
