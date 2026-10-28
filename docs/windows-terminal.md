# Windows Terminal 跳转

本地对话点击右侧“终端”或按 Ctrl+`（部分键盘标作 Ctrl+~） 直接打开 Windows Terminal，不创建网页终端标签。使用上游提供的对话工作目录；远程主机或缺少目录时显示错误。后端校验目录，并从 WSL 根目录的 Windows 路径识别当前发行版，启动 Windows Terminal 的最近窗口新标签；无窗口时由 Windows Terminal 创建窗口。终端运行在服务所在的 Windows/WSL 主机，而非其他访问设备。

入口由 `patches/webview-windows-terminal-action.patch` 接入上游终端动作与浏览器快捷键；`patches/webview-windows-terminal.patch` 为旧终端标签提供回退入口；`src/server/windows-terminal.ts` 实现启动。上游升级时复核组件、host ID 与 cwd 契约。此功能需要部署新的上游资源和后端并在安全时机重启服务；构建成功或启动命令成功不证明 Windows 界面和目录已完成验收。

## 验证记录

2026-10-28：隔离浏览器中，快捷键与右侧终端入口分别触发一次后端启动请求，均返回 200，且未创建网页终端标签。用户确认 Windows Terminal 打开并进入正确项目目录，随后确认正式环境快捷键可用。返回 200 仅表示启动命令完成，不单独证明 Windows 标签位置或目录。
