# WSL 与 Windows 文件访问

## 当前行为

用户环境是 WSL 服务端和 Windows 浏览器。文件点击使用现有内部侧栏和 Ctrl+P；HTML 在进入外部打开前路由到侧栏，不增加独立查看器、目录浏览或文件下载接口。

| 操作 | 行为 |
| --- | --- |
| 普通 HTML 链接、Ctrl+P 中打开 HTML | 现有内部浏览器标签，复用原工具栏；简易预览保底 |
| 其他普通文件链接、内部侧栏、Ctrl+P | 沿用上游浏览和预览流程 |
| 默认“打开”、系统默认目标 | 在 Windows Explorer 打开所在目录并选中文件 |
| “打开所在文件夹”/文件管理器目标 | 文件：Explorer 定位并选中；目录：Explorer 打开该目录 |
| 设置中打开 config.toml | 由上游创建文件后，Explorer 定位并选中 |
| 明确选择编辑器，例如 VSCode | 沿用上游指定应用的打开流程，未承诺自动转换为 Windows 编辑器 |
| HTTP/HTTPS 外链 | 浏览器新标签页 |
| SSH/cloud 远程主机文件 | 沿用上游远程处理，不当成本机文件启动 Explorer |

在 Explorer 选中文件后，可通过“打开方式”选择 Windows 浏览器、VSCode、Excel 等应用。它操作原文件，不复制到下载目录。

HTML 默认使用原有浏览器侧栏及工具栏，支持刷新、前进后退、外部浏览器打开和元素批注。“简易预览”按钮可随时切回之前已工作的 iframe 显示。网页由当前浏览器渲染：使用 Chrome 访问时就是 Chrome，不会另外启动 Electron 的 Chromium。

“为此页面添加批注”进入元素选择模式，点击元素后填写要求，选择“加入输入框”。文件路径、选择器、文字和 HTML 片段会加入当前聊天草稿，用户确认后自行发送。此适配使用文本上下文，不生成原桌面版截图附件；元素选择要求页面与 Codex Web 同源，本地 /@fs 页面满足条件。外部网站可能因跨域或禁止 iframe 而无法选择或显示，应使用外部浏览器入口。截图和设备模拟入口已关闭。

不做文件文本解析，不新增独立弹窗或目录浏览。源码行号链接、显式“打开”目标、远程主机沿用各自流程；CSV 仍可通过 Explorer 选择 Windows 表格工具。

## 路径与实现

`src/server/electron/shell.ts` 提供 Electron 的 `openPath` 与 `showItemInFolder`。两者在 WSL 都调用 Explorer，文件使用 `/select,`，目录直接打开。`patches/app-host-windows-files.patch` 在 openIn 服务已经根据 cwd 解析路径后，将本地默认/系统默认/文件管理器打开转交此 bridge；普通 HTML 点击由 `webview-html-sidebar.patch` 在进入外部 openIn 服务前交给现有侧栏 tab 系统，显式文件管理器操作仍进入 shell。`src/browser/native-browser.ts` 将原生 browserHost 与 webview 桥接到 iframe，`webview-browser-adapter.patch` 接入原组件，`webview-browser-capabilities.patch` 关闭不可用的截图和设备模拟。

- Linux 路径由 `wslpath -w` 转为 Windows 盘符或 WSL UNC 路径，支持自定义 Windows 挂载点。
- Windows 盘符、UNC 和 `file:///` URI 输入先转换回主机路径以检查存在性；URI 只在 URI 边界解码，普通文件名不额外解码。
- 先压缩重复反斜杠并保留两个起始反斜杠，再使用 `path.win32.normalize` 规范化路径；不手工猜测发行版名称。
- 通过可执行文件和独立 argv 启动 Explorer，不拼 shell 命令；支持中文、空格、#、%、逗号等文件名。
- Explorer 的工作目录设为 Windows 挂载盘根目录，避免把 Linux UNC 作为启动工作目录。
- 先检查普通文件或目录；缺失路径、设备文件、路径转换和启动错误返回错误，不报告成功。

Electron `openPath` 的空字符串表示启动请求已交给 Explorer，不能单靠它证明窗口已选中文件。验证记录另有 Windows Shell 的实际选中状态检查。`showItemInFolder` 遵循 Electron 的 void 接口，异步错误记录到服务日志。

## 浏览器文件地址

`src/browser/browser-links.ts` 将 `open-in-browser` 中的本地 file:// URL 转为已有 `/@fs/` HTTP 地址，避免 Windows 浏览器拒绝服务端文件 URI。被浏览器阻止新窗口时在当前页跳转，可后退返回。普通 HTML 点击使用内部侧栏，不走这个外链入口。

`src/server/host-files.ts` 保留已有 `/@fs/*` 地址、MIME、文件流与 Range 支持，通过现有静态插件的 sendFile 发送原文件。路径在路由处完整解码一次，修复静态通配入口对 #、逗号等编码字符的处理；没有新建查看器或内容 API。相对视频/图片/脚本仍沿同一目录解析。

## 部署与排障

HTML 侧栏补丁和 preload 修改刷新网页即可加载。后端 /@fs 编码补强、Electron bridge 和上游主进程补丁需要重启。按 [开发手册](development.md) 在活动任务结束后由用户重启本实例。

1. 还出现“主机文件预览”弹窗：浏览器仍加载旧 preload，请在重启服务后刷新。
2. 点击后没窗口：查看 `journalctl --user -u codex-web.service -n 60 --no-pager`，检查文件存在、`wslpath` 可用、Windows 盘已挂载、WSL Windows 可执行程序互操作正常。
3. Explorer 能定位但 Windows 软件打不开：先用资源管理器“打开方式”选择应用；部分应用对 WSL UNC 支持不同，需要按具体应用继续排查。
4. HTML 在浏览器中缺少资源：确认相对引用文件存在；浏览器对 file:// 的脚本、模块和网络请求有限制，复杂网页可能需要项目自身的 HTTP 开发服务器。

本项目仍沿用根 README 的可信网络和服务访问权限边界。验证范围见 [验证记录](validation.md)。
