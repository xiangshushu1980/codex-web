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
