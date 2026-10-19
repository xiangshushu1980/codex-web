# WSL 与 Windows 文件访问

## 当前约定

WSL 上的 Codex 使用 Linux 路径；Windows 浏览器通过 HTTP 查看这些文件。日常打开操作优先在网页内完成，不依赖浏览器的 `file://` 权限、Linux GUI 或 Windows 文件关联。

- 聊天中指向绝对路径、`file://` 或 `/@fs/` 的文件链接：网页文件对话框。
- openIn 服务的本地主机打开操作：网页预览；选择文件管理器时展示所在目录。
- 设置中的打开 `config.toml`：仍由上游确保文件存在，然后在网页查看。
- 已有代码编辑侧栏：保留上游入口；新增文件预览是只读的。
- HTTP/HTTPS 网页链接：在新标签页打开；同一请求不再重复转交后端。
- 无网页预览的文件：点击“下载文件，在 Windows 中打开”，下载由 Windows 浏览器接收。

目录页提供上级目录、子项和路径输入。也可以直接在地址栏进入 `/__backend/files/view`，从服务进程用户的 home 开始浏览；指定文件示例：`/__backend/files/view?path=%2Fhome%2Fsean%2Fprojects%2Fcodex-web%2FREADME.md`。

## 预览能力

| 类型 | 行为 |
| --- | --- |
| UTF-8 文本、代码、Markdown、HTML | 转义后按文本显示，支持行号和 `#L数字` 定位；HTML 不执行脚本 |
| PNG/JPEG/GIF/WebP/AVIF/SVG/ICO | 浏览器图片预览 |
| MP4/WebM/MOV、MP3/WAV/OGG/M4A | 浏览器原生播放器，是否可播放取决于浏览器编码支持 |
| PDF | 浏览器内嵌 PDF 预览；不可用时下载 |
| Office、压缩包、非 UTF-8、含空字符的二进制 | 下载后使用 Windows 应用 |
| 超过 2 MiB 的非媒体文件 | 提供下载，避免加载大文本 |
| 目录和符号链接 | 目录浏览；符号链接按主机实际目标读取 |

这是当前登录主机文件的查看器，不提供 Office 编辑器或任意格式转换器。上游仍可能有少数直接调用 `shell` 的诊断/下载菜单，它们保留已有 Windows Explorer 回退；网页查看器中的下载按钮是 Windows 下载的确定入口。远程 SSH/cloud 主机路径由上游处理，不错误地当成本机文件。

## 路径规则

服务接受 Linux 绝对路径、`~/`、`file:///` URI、Windows 盘符路径，以及当前发行版的 `\\wsl.localhost\发行版\...` / `\\wsl$\发行版\...`。

Windows 盘符路径在 WSL 映射到 `/mnt/<小写盘符>/`；使用自定义挂载点时请提供实际 Linux 路径。WSL UNC 必须匹配服务环境变量 `WSL_DISTRO_NAME`，其他发行版和远程共享明确报错。相对 API 路径以服务用户 home 为基准；聊天相对链接应通过上游携带 cwd 的 openIn 服务解析，不以网页 URL 推测项目目录。

查询参数使用 URLSearchParams 编码。URI 和链接中的百分号编码在对应边界解码；IPC 发来的真实文件名不额外解码。链接支持 `:行[:列]` 和 `#L行`；查看器定位到行，暂不定位列。文件名本身含 `#`、`%`、中文、空格和问号时，经 API 路径参数原样传入。

## 接口和边界

| 接口 | 用途 |
| --- | --- |
| `GET /__backend/files/view?path=...&line=...` | 自包含 HTML 文件/目录页，可作为独立浏览器标签页打开 |
| `GET /__backend/files/content?path=...` | 媒体内嵌内容，其余内容作为附件 |
| `GET /__backend/files/content?path=...&download=1` | 强制下载 |

内容接口支持单段 `Range`、206/416、UTF-8 下载文件名。普通文件以流发送；拒绝设备、FIFO、目录等非普通文件下载。不存在、无权限和路径输入错误返回对应 HTTP 错误和可见提示。响应不缓存，文本/文件名转义，文件内容附带 nosniff/CSP sandbox；目录页不会执行文件里的 HTML/JS。

权限沿用原项目：能访问此服务的人已能够以服务用户操作主机，不限定到某个项目目录。原有 `/@fs/` 静态入口继续用于上游图片。遵守根 README 的可信网络/外部认证要求，不把文件查看器误认为新增隔离边界。

## 排障

1. 404：确认文件仍存在，路径属于当前 WSL 主机；Windows 文件用对应 `/mnt/c/...` 检查。
2. 403：确认运行服务的 Linux 用户可读文件及父目录。
3. 打开预览却出现聊天首页：后端还没加载文件路由，或代理未转发 `/__backend/files`；完成服务切换并刷新。
4. 旧操作仍打开 Explorer：确认已应用 `app-host-browser-files.patch` 并重启主进程；少数旧 shell 菜单保留原行为。
5. 视频/PDF 无画面：先下载确认文件可用；浏览器格式支持与字节 Range 请求分别排查。

验证范围和未验证环境见 [验证记录](validation.md)。
