# 暂时停用被上游挑战拦截的功能

状态：临时生效，待上游接口恢复后复核。记录日期：2026-10-21。

## 依据与边界

本机 Codex Desktop `26.1007.30912` 的 Codex WebView 请求，在 2026-10-20 的服务日志中有 2,237 个去重请求 ID 返回 403，涉及 16 个路径；所有已记录的失败都被客户端归类为 `cloudflare_challenge`。最新一次页面载入前 40 秒内有 26 个 403 请求 ID，覆盖 12 个路径，其中包括 `/backend-api/transcribe`。

这证明请求被上游边缘检查拒绝，不证明接口已被官方永久下线。以下本地门控是为避免用户进入已失败的功能并减少重复请求；上游恢复后应移除，不把它们作为长期产品能力删除。

统计来自 `journalctl --user -u codex-web.service -b`，按 `requestId` 去重；同一路径的重复启动、重试和轮询均计入次数。初始盘点的各路径次数如下：

| 路径 | 403 次数 | 功能 |
| --- | ---: | --- |
| `/ces/v1/rgstr` | 367 | 客户端事件分析注册/上报 |
| `/backend-api/settings/user` | 333 | 用户设置与启动偏好 |
| `/backend-api/automations` | 322 | 自动化与定时任务 |
| `/backend-api/pets` | 267 | 宠物目录 |
| `/backend-api/accounts/optimized/check` | 162 | 账户/工作区访问状态 |
| `/backend-api/referrals/invite/eligibility` | 161 | 邀请奖励资格 |
| `/backend-api/subscriptions` | 132 | 订阅状态 |
| `/backend-api/gift-credits/senders/eligibility` | 103 | 赠送额度资格 |
| `/backend-api/subscriptions/auto_top_up/settings` | 94 | 自动充值配置 |
| `/backend-api/payments/payment_methods` | 93 | 付款方式 |
| `/backend-api/checkout_pricing_config/configs/USD` | 84 | 结账价格配置 |
| `/backend-api/ps/connectors/by-template` | 41 | 连接器模板目录 |
| `/backend-api/beacons/home` | 33 | 首页提示、引导与动态横幅 |
| `/ces/statsc/flush` | 30 | Statsig 遥测批量上报 |
| `/backend-api/sentinel/heartbeat` | 14 | Sentinel 心跳 |
| `/backend-api/transcribe` | 1 | 语音转写 |

## 当前本地处理

补丁：[`webview-temporary-api-gates.patch`](../../patches/webview-temporary-api-gates.patch)，由 [`prepare_asar`](../../scripts/prepare_asar) 在其他上游补丁之后应用。

- **语音/听写**：关闭 composer、ChatGPT、全局和 workspace dictation 能力，因此不显示入口，也不再进入录音后必失败的转写流程。额外移除 `rml()` 启动时的 `Qpl()` 调用；该调用会预取开始、停止和错误提示音，其中 `dictation-start-*.wav` 即使未使用听写也会在启动时请求。
- **自动化**：关闭云端、本地和定时任务能力；关闭相关自动化列表查询及每分钟轮询。
- **宠物**：从设置导航移除宠物页，禁用宠物目录查询。
- **连接器模板**：停止 GitHub/GitLab 模板目录查询，并从设置导航移除 Plugins 页面；既有连接器详情查询仍保留。
- **邀请与赠送额度**：停用邀请资格查询，并从 composer 的入口清单移除赠送额度入口。
- **首页动态提示**：`/beacons/home` 查询改为返回空 beacon，不再显示该接口提供的动态横幅、引导和提示。
- **计费入口**：从设置导航移除单独的 Billing 页面，并从 Usage 页面隐藏自动充值控制项；停用自动充值配置和付款方式查询。保留 Usage 页面及用量功能。
- **分析遥测**：暂停 CES 注册与 Statsig flush，避免持续失败的非用户功能请求。
- **继续保留**：`/settings/user`、`/accounts/optimized/check` 和 `/sentinel/heartbeat` 相关流程。设置与账户状态接口影响启动/账户行为；Sentinel 属于安全心跳，不因 403 删除。

## 复核与还原

恢复前，用新日志确认相关路径不再因 `cloudflare_challenge` 返回 403；特别确认转写、自动化、宠物、连接器目录、自动充值、付款方式与邀请资格接口。`/subscriptions` 和结账价格配置仍被其他计费状态流程使用，目前未在补丁中屏蔽。然后：

1. 从 `scripts/prepare_asar` 删除 `patches/webview-temporary-api-gates.patch` 的应用行。
2. 重新准备 `scratch/asar`，以未应用此门控补丁的上游 bundle 恢复入口和查询。准备脚本会重建 `scratch/`，先确保其中没有需要保留的手工实验。
3. 删除该补丁文件，更新本记录状态和验证证据，然后刷新 Windows 浏览器。

恢复后重点检查麦克风按钮能正常转写；自动化页停止报错且只在需要时轮询；宠物/Plugins/Billing 和 Auto top-up 入口恢复；邀请、赠送额度和首页提示不再因资格请求失败而消失；CES/Statsig 遥测恢复。无需为此重启 `codex-web.service`，除非后续改动涉及后端代码。
