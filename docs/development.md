# 本地开发与架构

## 组件和数据流

Windows 浏览器 → WSL Fastify HTTP/WebSocket 服务 → Electron 主进程 shim → 解包的上游 Codex Desktop → Codex CLI app-server。

这是桌面应用的浏览器适配层。源码主要集中在少数 shim 文件，上游应用经补丁复用；不应在 `scratch/asar` 里单独修改后把它当作持久实现。

| 入口 | 职责 |
| --- | --- |
| `src/server/main.ts` | Fastify、静态资源、上传、IPC/MessagePort WebSocket 桥、加载上游主进程 |
| `src/server/electron/index.ts` | Electron 主进程 API 模拟，窗口和 IPC |
| `src/server/electron/shell.ts` | WSL/Windows 路径转换与 Explorer 文件定位 |
| `src/server/module.ts` | Electron 模块别名 |
| `src/browser/shim.ts` | preload 适配、WebSocket、Electron bridge、浏览器消息分流 |
| `src/browser/files.ts` | 浏览器选择文件后上传到 WSL 临时目录 |
| `src/browser/workspace-root-dialog.tsx` | 选择 WSL 主机项目目录；与 Windows 文件上传选择器用途不同 |
| `patches/` + `scripts/prepare_asar` | 上游应用的可重复适配补丁及应用顺序 |
| `vite.browser.config.ts` | 浏览器 preload 构建及开发代理 |

应用服务 RPC 经 MessagePort 在 WebSocket 上传输。普通旧消息仍经 Electron IPC。文件点击、侧栏预览和 Ctrl+P 使用上游流程；openIn 服务的本地默认/文件管理器打开经 `app-host-windows-files.patch` 交给 Electron shell bridge，启动 Windows Explorer 并选中文件。没有自建文件查看器或文件目录 API。

## 构建和检查

已有 `scratch/asar` 和依赖时：

```bash
npm run build:server
npm run build:browser
npm run test:files
```

`build:server` 在源码旁输出 JS、声明和 source map，Git 忽略它们。浏览器构建更新 `scratch/asar/webview/assets/preload.js`。文件测试覆盖路径规范化、Explorer argv、启动失败和上游 openIn 路由；测试使用 mock 启动器，不弹出 Windows 窗口，fixture 在临时目录，结束清理。

首次准备或升级应用时，按 [UPGRADING](../UPGRADING.md) 准备应用包和 `HOSTED_CODEX_APP_ZIP`，再执行 `npm run build`。它会重新解包并应用补丁，不能拿来保留 scratch 中的手工实验。不要为普通 TypeScript 改动重新下载应用包。

开发模式：先启动 WSL 后端，再 `npm run dev:browser`；Vite 默认监听 4173，代理 `/__backend/ipc`、`/__backend/upload` 到 8214。

## 本机运行和切换

当前本机由用户级 `codex-web.service` 启动，在 WSL 的 `127.0.0.1:8214` 监听，工作目录为本仓库。Windows 浏览器访问同一 HTTP 地址。此信息来自 2026-10-19 本机 `systemctl --user show`，其他安装应独立核实。

```bash
systemctl --user status codex-web.service
journalctl --user -u codex-web.service -n 60 --no-pager
```

浏览器构建文件可立即被现有进程读取，但后端 TypeScript 和上游主进程补丁需要重启加载。因此应一起切换并刷新网页。

**当前服务把 Codex app-server 放在同一进程树，KillMode 为 control-group。重启会中断活动任务，包括从这个服务发起的当前 Codex 会话。** 先让任务停在可恢复点并确认切换时机，再执行：

```bash
systemctl --user restart codex-web.service
```

随后在 Windows 浏览器刷新。长任务不中断的独立 app-server 方案见根 README 中的 proxying 章节；当前本机尚未验证该部署切换。

## 提交边界

只提交源码、补丁、测试和文档。`scratch/`、编译产物、模型、会话状态、上传文件和 node_modules 留在本地。仓库可能有其他未提交改动，提交前检查并按文件或补丁块选择范围。`.codegraph/` 存在时优先用 codegraph 理解代码；新增接口字符串和解包生成文件可直接定位。
