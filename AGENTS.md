# codex-web 项目约定

- 文档入口：[docs/README.md](docs/README.md)。开始修改前按主题读开发手册或文件访问手册。
- 用户环境为 WSL Ubuntu 后端 + Windows 浏览器。日常文件操作使用网页，或明确可用的 Windows 工具；不引入依赖 Linux GUI 的用户流程。
- 源码在 `src/`；解包上游位于 `scratch/asar/`。上游行为修改必须有 `patches/` 补丁并接入 `scripts/prepare_asar`，不能只改 scratch。
- 改文件打开路径时运行 `npm run test:files` 和前后端构建；上游升级时同步复核补丁中的生成文件名和服务符号。
- 本机 `codex-web.service` 包含 Codex app-server。重启会中断由它启动的活动会话；先完成落盘与检查，由用户选择安全时机重启。
- 不提交 scratch、编译产物、运行状态或其他会话已有改动。按文件/补丁块做 scoped commit；仓库 origin 是上游项目，未确认目标前不推送上游。
- Mem0 项目池为 `codex-web`；文档事实写回主题手册，经验按全局 Mem0 纪律检索和保存。
