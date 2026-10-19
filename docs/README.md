# 项目文档入口

本地维护基线，检查日期：2026-10-19。项目是 0xcaff/codex-web 的 Hivemind 本地分支，运行环境为 **WSL Ubuntu 服务端 + Windows 浏览器**。

| 需要了解 | 权威正文 |
| --- | --- |
| 项目用途、通用启动、安全边界 | [根 README](../README.md) |
| Electron、浏览器和 WebSocket 的原有架构 | [ARCHITECTURE](../ARCHITECTURE.md) |
| 当前本地架构、源码入口、开发与验证 | [开发手册](development.md) |
| Explorer 文件定位、路径规则和故障处理 | [WSL 文件访问](file-access.md) |
| 为何恢复内置预览并使用 Windows Explorer | [文件访问决策](decisions/browser-file-access.md) |
| 本地分支来源与提交边界 | [HIVEMIND](../HIVEMIND.md) |
| 上游应用升级与补丁维护 | [UPGRADING](../UPGRADING.md) |

文档维护约定：操作和当前行为写回对应主题；设计取舍写入 decisions；验证证据写入 [验证记录](validation.md)。入口只保留导航，运行状态和任务进度以 Task Center 为准。上游版本、文件服务接口或部署方式变化时，复核直接相关文档；生成包和临时运行状态不作为文档正文。
