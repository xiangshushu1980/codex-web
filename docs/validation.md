# 文件访问改造验证

检查日期：2026-10-19。基于仓库提交 `5bdb7bd2a68b326ef33c69a4e7fa8d2fcb7c0b1e` 上的本次源码改动；本机 Node v24.18.0，WSL Ubuntu。以下记录区分自动检查、隔离浏览器实测与正式实例切换。

## 已通过

- `npm run test:files`：8 项测试全部通过。覆盖 Linux/Windows/file URI/WSL UNC 映射；真实文件名与链接行号的区别；中文、空格、#、%、问号；应用路由不被当作文件链接；文本转义；目录、符号链接和二进制降级；下载字节和文件名；媒体单段/后缀/开放范围、无效范围；空文件、缺失文件和设备文件拒绝。
- 测试直接从本地已打补丁的上游 bundle 提取 `JQ`（openIn 服务）执行，确认相对文件路径按 cwd 解析、事件发给原始 view、文件管理器动作使用父目录。生成名会随上游升级变化，升级时必须同步测试和补丁。
- `npm run build:server`、`npm run build:browser` 通过。
- `node --check scratch/asar/.vite/build/main-CqEoQDOU.js` 通过。
- 对新补丁执行 `patch --dry-run --reverse` 成功，确认当前解包主进程包含补丁；没有重新下载或全量重建上游包。
- Playwright CLI 的隔离 Chromium 实测，连接独立 Fastify 文件测试服务（8215）：点击文件按钮打开单个 dialog，iframe 显示 README 第 5 行；点击绝对路径文件链接也可打开；关闭后 dialog 移除。截图已检查，文本和高亮可见；控制台 0 errors / 0 warnings。测试服务与截图属于本地临时产物，不纳入仓库。

## 正式实例与剩余验收

当前 8214 运行进程尚未重启加载新增后端和主进程补丁。已生成浏览器及服务器产物；**正式生效需要由用户在当前会话安全结束后重启实例，再刷新 Windows 浏览器**。没有把隔离验证标记为正式部署验证。

原因：本会话的执行 shell 的父进程是 `codex app-server`，它属于 `codex-web.service` 进程树；服务 `KillMode=control-group`。在会话中重启会终止当前工作及其他活动任务。操作见 [开发手册](development.md)。

用户在 Windows 浏览器验收：

1. 重启并刷新后，打开聊天中的 Linux 文件链接；应出现网页预览，不启动 Explorer。
2. 打开目录、含中文和空格的文件，并检查行号跳转。
3. 从预览点击下载 Office 或其他二进制文件，确认进入 Windows 浏览器的下载目录并可由 Windows 应用打开。
4. 检查原有代码编辑侧栏与普通网页外链仍正常。

未实测 Windows Chrome/Edge 的实际文件关联、Office 打开，以及真实视频/PDF 的浏览器编码支持；自动测试只证明媒体响应和范围处理。既有 shell 菜单的 Explorer 回退属于本次开始前的工作区改动，未纳入本次提交或 Windows 验证。
