# Windows 文件定位验证

检查日期：2026-10-19。此记录取代 `c46eaf1` 中自建网页查看器的验证；此前 8 项 HTTP/预览检查不能作为当前 Explorer 行为的证明。

## 已验证

- 当前 WSL 进程没有 `WSL_DISTRO_NAME`/`WSL_INTEROP` 环境变量，`/proc/version` 包含 WSL 标识；bridge 能识别该环境。
- 实际 `wslpath -w` 返回包含重复反斜杠的 UNC 路径；规范化后由 Explorer 使用。发行版名称来自 wslpath，不根据“Ubuntu”描述猜测。
- 真实 Windows 检查：Explorer 定位本地生成的 `scratch/windows-file-check/中文 空格 # %,test.html`，PowerShell 通过 `Shell.Application.Windows()` 查询目标目录窗口及 SelectedItems，得到 `folderMatched=true`、`unicodeHtmlSelected=true`。证明带中文、空格、#、%、逗号的原始 HTML 文件被选中，不只依据 Node 的 spawn 事件。样例为本地临时产物，不入库。
- 自动回归 `npm run test:files` 覆盖 8 组测试：UNC/盘符规范化；文件和目录 argv；Open/Reveal 调用；URI/原始文件名；缺失和设备文件拒绝；转换/启动错误；上游默认、fileManager、systemDefault 路由，以及显式编辑器/远程主机保留。
- 前后端构建、上游主进程 JS 语法检查、新补丁反向 dry-run，交付前检查通过。

## 切换后验收

正式 8214 实例需由用户在活动任务安全结束后重启并刷新浏览器。操作见 [开发手册](development.md)。本会话未自行重启，因为服务包含本会话的 Codex app-server。

1. 文件点击仍使用原侧栏预览/Ctrl+P，不再出现新增的“主机文件预览”弹窗。
2. 对 HTML 或 CSV 使用“打开”/“打开所在文件夹”，Explorer 应显示原文件并选中。
3. 在 Explorer 中选择 Windows 浏览器、Excel、VSCode 等应用，按实际文件验证所需效果。

未声称修复内置 HTML 浏览器或新增 CSV 表格查看能力。明确选择 Windows 编辑器的自动应用集成、各 Windows 应用的 WSL UNC 支持需按具体应用验证。

## HTML 点击回归（2026-10-19）

用户提供的实际文件：`/home/sean/projects/3d/.production-runs/blender-h3-handoff-factorial-2026-10-19/h01-v003-eight-seed-extension/review/combined-v002/index.html`。

- 当前正式实例已重启加载 Explorer bridge。通过真实浏览器的 openIn RPC 与侧栏菜单验证，Windows Shell 确认该路径的目录已打开且选中 index.html；用户后续确认此前只是 Explorer 不在前台。本次没有更改 Explorer 行为或尝试强制抢前台。
- 复现 file:// 外链时报 `Not allowed to load local resource`；改用已有 /@fs 访问。实际页面标题为 `H01 blind individual playback`，有 64 个 video，首个相对视频请求返回 206 和正确 Content-Range。
- 原有 Ctrl+P 输入上述精确路径后回车，HTML 出现在现有侧栏 role=tabpanel 内的 iframe，标题、64 个 video 均正确。iframe 实测约 528×638，未增加浏览器标签或独立预览弹窗。
- 普通 Markdown 文件链接点击也已通过真实界面验证，显示同一 HTML 及 64 个视频，标签仍在内部侧栏。
- 普通 HTML 无行号且无显式外部目标时进入侧栏；显式 fileManager/编辑器、远程路径和源码行号继续绕过 HTML 预览分支。自动测试直接执行实际 renderer 补丁的分支验证此边界。
- 回归测试共 11 项通过，前后端构建、renderer JS 语法和新补丁反向 dry-run 通过。/@fs 特殊文件名由本地 HTTP 注入覆盖，正式进程要在下一次安全重启后加载该后端补强；当前实际用户页面不含此类字符，已经由运行实例成功提供。

本节更新前文“未修复内置 HTML”的限制：现已支持本地 HTML 在内部侧栏直接渲染，仍未新增 CSV 表格查看器或完整 Electron 浏览器引擎。
