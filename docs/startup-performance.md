# 首屏启动性能排查

更新日期：2026-10-20。本文记录本机 WSL Codex Web 的启动观测和下一轮优化基线；仅代表当前 Codex 上游构建、当前 Windows 浏览器会话和网络状态。

## 现象与测量口径

用户观察到应用偶尔重启，启动期间图标反复出现后黑屏，首屏约 10 秒或更久。测量日志中至少存在多个 renderer，因此必须通过 `rendererWebContentsId`、窗口可见状态和 `client.performance.span` 关联样本。隐藏 renderer 的路由时间不能当作用户首屏时间；`app_routes_mounted` 与 `first_content_visible` 也不是同一个边界。

本地诊断补丁在 `scripts/prepare_asar` 中接入：

- `webview-startup-trace.patch`：记录 renderer 启动阶段、metadata gate、Statsig 初始化、路由和首屏边界，并收集首屏前长任务与脚本启动信息。
- `webview-statsig-startup-timeout.patch`：将 Statsig 启动 race timeout 由 10 秒调到 4 秒，观察回退行为。
- `webview-settings-preload-gate.patch`：实验性绕过 SettingsPreloadGate；本轮对照后不再默认应用，仅 `CODEX_WEB_SETTINGS_PRELOAD_BYPASS=1` 显式启用。
- `app-host-startup-http-trace.patch`：记录指定 HTTP 请求耗时及 Statsig 响应头。
- `app-host-startup-account-rpc-trace.patch`：拆分账号 RPC 的认证获取和实际账号读取耗时。

这些补丁用于本机诊断/实验。原始诊断阶段尚未证明优化稳定有效；本轮单变量对照、基础回归及保留/撤回结果见后文。Statsig timeout 修改仍存在功能影响可能。日志不采集认证令牌或响应体。

## 已取得的证据

### 2026-10-20 本机重启样本

- 服务 PID `74695` 启动后 `NRestarts=0`，期间观测到内存约 0.94–1.23 GB；之前 192 MB Node heap 限制曾导致 OOM 和服务重启，因此本机 service heap 已调为 512 MB。重启行为和首屏慢需要分开诊断。
- 前台 renderer `webContentsId=5001`：renderer entry 约 1.11 秒，host startup ready 约 1.33 秒，metadata gate 在约 2.14 秒解除，Statsig bootstrap 在约 2.14 秒开始；路由于约 13.30 秒挂载，窗口当时 `visible=true`。本样本缺少该 renderer 的 `first_content_visible` 和完整 app-start span，不能把路由时间直接称作完整首屏时间。
- 两个先启动的隐藏 renderer `2001/3001` 分别在约 15.59/16.78 秒记录 first-content 边界；其长任务累计约 5.81/8.19 秒，最长单任务约 1.82/1.88 秒，脚本最后启动时间约 13.56/13.07 秒。这些数据说明主线程与后续模块加载可能占据明显时间，但它们不是可见主窗口样本。
- 当前前台窗口 Statsig bootstrap HTTP 请求完整耗时约 4.13 秒（200），传输为 chunked 且没有 Content-Length；4 秒 timeout 几乎同时发生，因此 4 秒设置可能把正常但偏慢的成功响应当作超时。之前样本成功响应约 3.35 秒，另有异常响应体迟迟未读完的情况。不要据此继续缩短全局 timeout。
- 在隐藏 renderer 样本中，Statsig async init 最终于约 9.86–10.44 秒完成；失败回退后仍等 `values_updated_ready`。这提示 bootstrap 网络、Statsig async 初始化与 Suspense gate 之间有依赖，但尚未证明哪个步骤单独决定可见首屏。
- `/backend-api/settings/user` 在不同样本返回过 200 和 403；多个其他 403 端点在首屏后仍继续请求。现有证据不支持简单屏蔽这些调用能改善首屏，且屏蔽可能损害功能。

### 账号 RPC 阶段计时

`account/read`、`getAuthStatus` 的 wrapper 计时显示：`getAuth()` 约 0–1 ms，实际 `desktopAccount.read` 约 7–14 ms。app-server 的 response routing 数据另有 `queueWaitMs`，样本最高约 1.97 秒、另有约 0.96 秒。此前观察到约 3.6 秒的“认证调用耗时”不能归因于 token 获取或账号读取本身；队列等待和 renderer 启动排队是更合理的调查方向。不同版本日志字段的计时边界不同，不能直接把 queueWaitMs 与早期 RPC duration 相减。

启动期间同时存在多个 renderer，并重复发出账号状态 RPC；需先查明它们是产品预期的隐藏窗口、旧窗口残留还是本地浏览器适配层重复建窗，再评估其对 app-server 队列和主线程负载的影响。不能只凭重复数目直接删除窗口或合并认证调用。

## 当前判断

启动时长波动很可能是多段等待叠加，而非单个 3.6 秒认证操作：renderer 启动/调度、app-server 排队、Statsig bootstrap 与 async init、晚到模块和数秒 long tasks 均有直接观测。各 renderer 与可见窗口的边界必须分开；目前尚缺足够的干净、单变量、多次对照样本来确定首要瓶颈或量化优化收益。

## 下一轮建议

1. 先固定基线：连续重启多次，记录实际可见窗口 ID、`renderer_entry`、`host_startup_ready`、`settings_ready`、`shell_visible`、`app_routes_mounted`、`first_content_visible` 和完整 `app_start` span；区分冷/热缓存及页面刷新造成的新 renderer。
2. 追多 renderer 的创建和可见时序，并将其与 app-server `queueWaitMs` 对齐；判断正常产品行为和浏览器适配层行为分别贡献多少。
3. 通过 Resource Timing 与受控对照定位 `latestScriptStartMs` 对应模块；把 long task 的调用栈/脚本 URL 映射到功能初始化，优先验证可延后的工作。
4. 单独测试 SettingsPreloadGate 绕过、Statsig timeout 和任何 preload 预取；每次只变一个因素，验证设置、认证、会话和首屏功能，不用一次重启的偶然改善判成功。
5. 只在证明某个请求发生于可见首屏关键路径且等待它会阻塞时，才考虑跳过或延后请求。403 状态本身不是屏蔽依据。
6. 保留观测补丁，实验结束后清理临时诊断日志；上游行为改动必须留在 `patches/` 并由 `scripts/prepare_asar` 应用，不能只改 `scratch/asar`。

## 可见性口径修正与单变量对照

`app-host-browser-windows.patch` 为每个浏览器 WebSocket 连接调用 `createPrimaryWindow({ show: !1 })`；`src/server/main.ts` 在连接关闭后销毁对应窗口。因此多个 renderer 可以来自多个浏览器标签或自动化浏览器，不能仅凭数量判断为重复建窗。更关键的是，宿主 `rendererWindowVisible=false` 不代表浏览器标签不可见：2026-10-20 的隔离页实测 `document.visibilityState=visible`，对应宿主仍为 false。上文旧样本的“隐藏”仅指宿主字段，不能据此排除用户可见页面。

新增 `webview-startup-visibility.patch` 为每条诊断事件补充 `browserVisibility` 与 `navigationStartMs`，并由 `scripts/prepare_asar` 接入。以导航时间戳关联浏览器测量与宿主窗口 ID，再匹配同一 ID 的 `app_start` span；路由挂载、span 完成和 `first_content_visible` 分别保留，不互相替代。该补丁只补测量字段。

本轮对照通过命名 `playwright-cli` 会话 `startup-sol` 的请求替换实现：只替换该页的模块响应，不改共享资源的实验参数。每次先导航到 `about:blank`，重启服务，等 HTTP 就绪后导航首页；固定浏览器进程/存储、保留磁盘缓存，属于服务冷启动、浏览器进程复用的样本，不是全新浏览器或操作系统冷缓存。各组交错执行，分别只改变 Statsig timeout、Settings gate 或 primary 模块预加载。原始三项实验同时启用的状态作为对照起点，不能称为未修改上游基线。

关闭已有自动化页后，首轮冷启动仍发现一个真实后台标签自动重连；用户关闭该页后，重新开始单页样本。受并发影响的首轮数据单独保存，不能混入单页统计。证据与恢复脚本位于 `scratch/startup-performance/remote-abacea33-7f47-48b1-b250-2f466a868f19/`，不提交 Git；运行状态以远程任务为准。

### 单页服务冷启动结果（2026-10-20）

以下每组 3 次；单位为秒，计时为同一可见浏览器导航的 `renderer_entry → first_content_visible`。每次先重启服务、等 HTTP 可访问，再打开首页；因此 13.406 秒是服务重启后的首次页面加载区间，不包含服务启动等待，也不包含页面导航开始到 renderer entry 的时间，不能当作服务启动耗时或普通刷新耗时。每个有效样本都取得同一 renderer 的完整 `app_start` span；宿主 ID 均为每次新服务内的 `2001`，需同时使用 `navigationStartMs` 区分不同启动。primary 预加载固定启用。

| Statsig timeout | Settings gate | 逐次耗时 | 中位数 | bootstrap 成功 |
| --- | --- | --- | --- | --- |
| 4 秒 | 绕过（原实验状态） | 13.538 / 13.152 / 13.786 | 13.538 | 0/3 |
| 10 秒 | 绕过 | 25.318 / 14.205 / 13.364 | 14.205 | 2/3 |
| 10 秒 | 保留 | 22.751 / 17.592 / 13.285 | 17.592 | 2/3 |
| 4 秒 | 保留 | 16.528 / 13.406 / 12.917 | 13.406 | 0/3 |

保留 gate 时，4 秒组相对 10 秒组的样本中位数低约 23.8%，样本最大值低约 27.4%；绕过 gate 时，中位数仅低约 4.7%。这些是小样本描述，网络响应变化明显，不能视为稳定总体收益或单一因素解释全部波动。4 秒组全部超时并转异步初始化，10 秒组各有 2 次正常 bootstrap；收益伴随初始化路径变化，不能称为“无功能风险”。

Settings gate 绕过没有显示稳定收益：在 4 秒条件下，两组中位数差仅约 0.13 秒，恢复 gate 的样本范围反而较大；10 秒条件下恢复 gate 的中位数较高，但同时存在 bootstrap 成败及排队差异。不以这些样本证明 gate 本身耗时，撤回绕过可恢复上游设置就绪语义。

队列等待在不同组仍可达约 2.1–3.3 秒。10 秒超时、保留绕过的慢样本中，bootstrap 在 5.382 秒开始，15.382 秒超时，异步初始化在 22.210 秒就绪，路由及首屏随后完成；这直接解释了为什么缩短 bootstrap 等待有时可减少长尾，但并未消除异步初始化、排队和后续主线程工作的成本。

### 其余实验、补丁取舍与验证边界

- **保留观测补丁**：renderer/HTTP/账号阶段日志及新增的浏览器可见性字段。正式验收后仍可精简临时日志；本轮没有根据 403 状态屏蔽请求。
- **保留既有 4 秒 timeout**：最终配置为 4 秒、保留 Settings gate、保留 primary 预加载。相对同样保留 gate 的 10 秒组，上述样本中位数约降低 4.19 秒；它依赖上游已有的 bootstrap 失败回退，不能保证所有远程功能开关与正常 bootstrap 一致。没有继续缩短 timeout。
- **撤回默认 Settings gate 绕过**：已恢复 scratch 中的上游 `if (Pt())`，prepare 仅在显式实验开关开启时应用绕过补丁。该决定恢复设置就绪语义；不声称恢复 gate 本身带来性能收益。
- **暂保留 primary 预加载**：去预加载的有效探索组固定为 10 秒、绕过 gate，三次为 19.873 / 21.624 / 15.723 秒，中位数 19.873 秒，bootstrap 成功 1/3。该组在修正实验权限后单独重跑，未与有效预加载组交错，不足以量化预加载本身的收益；也未显示值得撤回的性能改善。

去预加载的首轮失败是测试工具造成的：即使不改 HTML 内容，只拦截导航并 `route.fulfill`，Chromium 也会对本地 WebSocket 报 `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`。对测试 context 的 `http://127.0.0.1:8214` 授予 `local-network-access` 后启动恢复。该权限仅用于自动化测试，没有修改系统网络/代理或应用安全策略。无效样本单独标为 `invalid-lna-*`，不能当作移除预加载会破坏产品的证据。

有效单页各组的服务快照均为 `NRestarts=0`，这是每次人工重启后的自动重启计数，不是人工重启次数。最终配置三次服务进程树内存约 638–662 MiB；浏览器 `performance.memory` 返回约 441 MiB 的粗粒度值，不能视为精确 Node heap 或泄漏结论。最终配置首屏前 long task 累计约 2.88 / 2.93 / 5.16 秒，包含 observer buffered 的 renderer entry 前任务；不能把这些值直接从 entry→visible 耗时中相减。

另做一轮独立 Chromium CPU profile（不混入性能对照）：最终配置 entry→visible 约 12.40 秒，采样中 idle 约 8.17 秒、rolldown runtime 匿名初始化约 0.80 秒、GC 约 0.29 秒；`llc`（通知权限初始化）约 0.16 秒、日志 `warn` 约 0.16 秒。没有发现足以单独解释数秒等待的一个业务函数。晚到模块可具体关联到 `header`、`trial-pricing`、`home-thread-app-shell-chrome-content` 等首页/UI 模块；尚未证明延后其中某一个可以安全降低首屏时长。

验证：前后端构建、renderer JS 语法、prepare shell 语法、可见性补丁反向 dry-run 通过。最终运行配置中，设置页能显示常规选项及已保存的简体中文等值；New Chat 可回到可见 composer，模型不再显示 Loading model，项目/最近入口存在；本地 `account/read`、`thread/list` RPC 返回 `errorCode=null`。未发送测试消息、未更改用户设置或退出登录。云端个人资料及部分端点仍有 Cloudflare 403，因而未声称完整验证云端认证、所有功能开关或真实消息收发。

恢复测量时优先使用证据目录中的 `measure.js`，顶部 `config` 明确指定 timeout/gate/preload，并对两种 gate 状态做严格锚点替换。旧 `run-*.js` 为当时实验脚本，部分依赖恢复 gate 之前的输入状态。CPU profile、有效/无效样本及服务快照均保留本地，原有混合改动未整体提交。

## 服务已就绪时的页面加载优化（2026-10-20 补测）

本轮直接访问 `http://codex.localhost/`，保持服务运行，不将服务启动耗时计入页面加载。首次导航 HTML 响应约 5.5 ms，DOMContentLoaded 约 288 ms；必需的 `app-initial-6350d04672d0.js`（约 18.3 MB）却到约 859 ms 才开始请求，renderer entry 约 2.97 秒，metadata gate 约 4.26 秒解除。远程 Statsig bootstrap 约 1.92 秒收到响应头，但未在 4 秒预算内完成，回退 async gate 到导航约 40.92 秒才解除。响应头到达不等于正文读取与初始化完成；本轮尚未将超时归因到网络、正文传输或 RPC 桥的某一个环节。

新增 `webview-preload-initial.patch` 并接入 `prepare_asar`：在 HTML 中 modulepreload 必需的 initial bundle，使其与 shared runtime 并行下载/编译，不提前执行应用、不改变设置和认证门控或功能配置回退。当前服务可直接读取更新后的 HTML，无需重启。

在固定的同一浏览器进程中，每次新建 context（不复用页面缓存/存储），关闭后再开始下个样本，按关闭/开启预加载交错测量各 3 次。两组均用相同 HTML 路由响应和 local-network-access 测试权限；静态资源与 WebSocket 仍访问真实服务。该实验仅比较 metadata gate 之前的本地阶段，不测完整首屏，也不代表 Windows 浏览器实测。

| 指标（导航开始起，毫秒） | 无 initial preload | 有 initial preload |
| --- | --- | --- |
| initial 请求开始 | 808 / 832 / 820 | 6 / 6 / 6 |
| initial 下载结束 | 1003 / 1023 / 1012 | 272 / 265 / 269 |
| renderer entry | 2903 / 2952 / 2897 | 2656 / 2637 / 2669 |
| metadata gate 解除 | 3754 / 3808 / 3742 | 3511 / 3494 / 3532 |

本地阶段中位数减少约 243 ms（6.5%），收益有限；仍有约 2.65 秒的首次脚本解析/执行，远程配置等待仍是更大的波动来源。不能据此声称完整首屏从 10 秒降到某个固定值。复用缓存的探索样本 gate 约 0.71 秒，也不能与新 context 样本混算。测量脚本与原始结果保留在 `scratch/page-load-performance/`，不提交运行产物。

更新 HTML 后的独立完整导航验证：metadata gate 约 0.997 秒解除，Statsig bootstrap 于 1.001 秒开始、5.002 秒超时，async init 于 12.687 秒完成，路由约 17.239 秒挂载，first-content 边界约 17.434 秒，输入框存在。页面仍显示正在加载个人资料；未发送消息、未修改设置。该样本没有完整首屏的成对基线，不能据此量化首屏收益。前后端构建、prepare shell 语法、补丁反向 dry-run 和 diff whitespace 检查通过。本轮遇到远程超时后已请求用户确认只读网络测试；未改代理配置，也未进一步缩短 timeout。

## Bootstrap 正文传输与分段超时（2026-10-20 续测）

用户已澄清网络纪律：下载/安装遇到网络异常或持续低速时才先确认测试；普通服务超时可正常诊断并汇报。上节“等待确认网络测试”属于当时状态，不再构成阻塞。本轮不改代理、不重启服务。

通过隔离页替换模块响应，在 `kxn` 返回 RPC Response 和读取正文时仅记录时间、状态、分块字节数，不记录正文或认证信息。4 秒预算样本中，浏览器在请求开始后约 2.30 秒收到 200 Response，并持续收到正文，直到总预算耗尽后取消；未观察到正文结束。另一个临时 15 秒预算样本完整取得约 7,131,633 字节正文，响应头约 3.10 秒到达、正文另耗约 3.80 秒，随后正常同步初始化。说明这些样本的失败发生于正常传输仍未完成时；不能继续将“响应头很快到达”当作整个请求已完成，也不据此认定桥接死锁。响应头保留 `content-encoding: br`，记录的正文是解压后的字节数。

新增 `webview-statsig-phase-budget.patch`，接在 trace 和 4 秒 timeout 补丁之后：复用 HTTP 客户端已有 `onResponseHeadersReceived`，等待响应头预算仍为 4 秒，第一次收到响应头后重新给予正文最多 4 秒，总等待上限为 8 秒。重复回调不能延长预算，已取消请求不能重启 timer，成功/失败均清理 timer。保留原错误处理、一次 bootstrap 后回退、设置门控和认证语义，不使用伪造配置或跳过功能初始化。代价是已收到头但正文挂起的请求可能比旧策略多等最多 4 秒。

探索性的首页三模块 modulepreload 仅通过自动化页 HTML 替换测试，没有写入运行 HTML 或 prepare。三次预加载样本均停在 async 网络初始化且未在测试期限内出现首屏，无法据此评估模块预加载本身；该方案未采用，也不把失败归因于预加载。分段预算的初次隔离验证正常取得完整配置，bootstrap 约 4.88 秒完成，首屏约 13.43 秒；该单样本不作为稳定收益结论。

自动化对照脚本、原始分块记录与实验模块保留在 `scratch/page-load-performance/`。单元测试入口 `npm run test:startup`，针对 prepare 后的真实 bootstrap 函数验证响应头超时、正文超时、取消、成功与传输错误的 deadline 清理；需先有已准备并应用新补丁的上游资源。

### 分段预算交错样本与结论边界

同一浏览器进程，每次新建 context，关闭 HTTP 缓存，服务保持运行。六次依次为旧总预算/分段预算交错各三次；两组均仅替换 initial 模块响应，保留真实 HTTP/RPC。该轮与三模块预加载实验分开执行；临时网络分块诊断样本单列，不混入此组。结果如下（导航开始起，秒）：

| 策略 | Bootstrap 正常同步初始化 | First-content 边界 | 测量结束时输入框 |
| --- | --- | --- | --- |
| 旧 4 秒总预算 | 否 | 45 秒观察期未记录 | 有 |
| 4 秒响应头 + 4 秒正文 | 是，9.099 | 13.944 | 有 |
| 旧 4 秒总预算 | 否 | 20.342 | 有 |
| 4 秒响应头 + 4 秒正文 | 否 | 19.957 | 有 |
| 旧 4 秒总预算 | 否 | 45 秒观察期未记录 | 有 |
| 4 秒响应头 + 4 秒正文 | 否 | 45 秒观察期未记录 | 无 |

网络波动显著，旧策略正常 bootstrap 为 0/3，分段策略为 1/3。部分样本已有输入框却未记录 first-content 边界，不能把边界超时等同于用户一直看到白屏；也不能只用有限的成功样本计算中位数，声称首屏稳定提速。保留分段策略的依据是完整大响应可在其预算内正常完成，修正旧策略过早取消并再次请求配置的问题；**未证明整体首屏稳定低于 10 秒，网络回退长尾仍未消除**。没有继续放宽预算或改成跳过远程配置。

应用到运行服务读取的静态模块后，移除自动化页全部请求替换做独立回归：响应头约 6.000 秒到达、正文预算于 10.000 秒耗尽，async init 约 11.806 秒就绪，first-content 边界约 16.875 秒；输入框存在，模型没有停在 Loading model，云端个人资料仍在加载。此样本再次表明分段预算不是消除网络慢的方案。未发送消息或修改用户设置。四项 startup 单元测试、前后端构建、模块 JS 语法、prepare shell 语法、补丁正向/反向 dry-run、diff whitespace 检查通过；服务 MainPID 保持 107084，NRestarts=0。浏览器刷新即可加载新策略，无需中断活动会话。

## 功能配置缓存（当前行为）

已接入按本地已认证身份和应用上下文隔离的 IndexedDB 缓存。有效缓存可跳过首屏 bootstrap 网络等待；10 分钟至 1 小时的条目先启动、首屏后刷新。真实命中、后台刷新测试及官方版本标记的边界统一见 [配置缓存](startup-cache.md)。上文未使用缓存的超时对照保留为历史测量，不代表当前每次导航仍必然请求完整配置。

## 页面启动诊断提示

`src/browser/startup-progress.ts` 在浏览器适配脚本加载后显示右下角诊断条，脱离 React 的各级加载占位，持续显示总耗时、当前阶段及该阶段停留时间。复用已有启动 trace 和 Suspense 挂载/清理记录，每 250 ms 更新计时；没有百分比，也不更改就绪门控、重试或网络请求。阶段包括本地状态/设置、账户信息、远程配置请求、正文接收、备用初始化、界面挂载及首屏信号。

“占位出现次数”指 React 加载占位的逻辑挂载次数，不等于肉眼看到图标的次数，也不等于页面刷新。页面加载次数通过本标签页的 sessionStorage 单独计数，距上次加载超过 10 分钟重新从 1 开始；诊断同时记录 Navigation Timing 的 navigate/reload 类型以及连接恢复触发的刷新。这样可区分单次页面启动内的门控切换与真正重载。

首屏就绪后提示自动收起，点开可查看最近阶段并“复制启动诊断”；复制内容包含本次记录及本标签页上次加载记录，无账户正文、令牌或请求体，不上传到服务。当前报告也可从浏览器 `window.__codexStartupReport` 读取。sessionStorage 仅保留上次/当前本次报告，不存完整历史。离开页面或首屏就绪后停止定时采样。若 first-content 信号迟到，诊断会显示“界面已挂载，等待首屏就绪信号”，不能据提示仍在计时判断页面必然不可用。加 `?startup=off` 可在单次导航关闭诊断，用于开销对照。

验证的首个导航只创建一次页面加载，观察到六次逻辑占位挂载，依次涉及启动、本地状态、设置、身份/元数据和功能配置；first-content 约 18.723 秒出现，输入框存在，诊断自动收起。该样本支持“多个图标周期可能来自不同门控”，不能证明用户所见每一次闪烁都对应哪一个门控。刷新后的页面加载计数独立递增。

第二次实页刷新记录为 `navigationType=reload`、加载次数 2、占位挂载 6 次，约 25.229 秒完成，输入框存在；展开后复制按钮反馈“已复制”。关闭诊断的单次导航也已检查。浏览器构建、独立 TypeScript 检查、四项既有 startup 测试及 whitespace 检查通过；没有重启服务。诊断本身并未作为性能优化收益计入，界面正常可用与 first-content 就绪信号仍分别判断。

## 本机运行注意

`codex-web.service` 进程树包含 Codex app-server，会承载由该服务启动的会话。后续重启虽已获用户明确授权，仍应先确保当前改动和可恢复上下文落盘；监控 `NRestarts`、heap OOM 和服务内存，避免把服务重启和 renderer 重载混为同一现象。本轮执行会话已核实位于独立进程组，可在服务重启后继续；其他会话需要分别核对。项目运行与重启细节见 [开发手册](development.md)。
