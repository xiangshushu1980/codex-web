# 构建、上游升级和版本切换

WSL 后端与 Windows 浏览器共用本机服务。`codex-web.service` 还托管 app-server，停止或重启会中断活动会话。先落盘任务恢复点，再由用户选择切换时间。本手册中的切换步骤不会由构建命令自动执行。

## 准备候选版本

优先复用本地原始应用包，不使用已经打过补丁的 `scratch/asar` 作为升级输入：

```bash
HOSTED_CODEX_APP_ASAR="$PWD/scratch/ChatGPT.app/Contents/Resources/app.asar" npm run build
# 或指定已下载的上游 ZIP：
HOSTED_CODEX_APP_ZIP=/absolute/path/ChatGPT.zip npm run build
npm run release:status
```

`npm run build` 与 `npm run prepare:asar` 均执行完整候选准备：在 `scratch/releases/<唯一ID>/` 解包，预检版本/目标/顺序，格式化，按顺序逐项 dry-run 并应用补丁（禁止 fuzzy 匹配），检查补丁涉及的 JavaScript 语法，构建浏览器与独立后端，再对候选执行启动预算和缓存回归检查。全部通过后才写入 `status: validated`。候选含 `asar/`、`server/`、`release.json` 和 `build.log`；失败保留目录和日志，但不改当前资源或 current 指针。

`release.json` 记录上游版本、源码 commit、工作区 diff 摘要和构建输入逐文件哈希、补丁清单/哈希、诊断开关和前后端所有文件哈希。构建期间输入变化会拒绝验证；dirty 工作区的 commit 不是完整源码身份；本地源文件仍须保留并按范围提交。哈希证明构建产物未变，不证明 UI 或运行行为通过验收。准备和切换串行加锁；候选不要手工修改，修改后应重新构建。

日常 TypeScript 变更同样可用本地原始 ASAR 重新准备候选，无需下载。`npm run build:browser` 和 `npm run build:server` 保留为**旧布局开发命令**：分别原地更新 scratch 浏览器产物和源码旁后端产物，不提供隔离发布保证，不应用于生产升级。`npm run server` 仍启动旧布局；候选服务使用下面的固定版本入口。

首次安装的 `scripts/prepare` 仍可下载指定版本，但只产出候选，不自动启用。网络异常时不要连续重试大包。Nix 打包在隔离 sandbox 内把已验证候选复制到传统包布局；本轮未执行 Nix 构建。

## 补丁维护

`patches/manifest.json` 明确列出适用的上游版本和完整应用顺序。`after` 是顺序约束；其中 optional 项由 `CODEX_WEB_SETTINGS_PRELOAD_BYPASS=1` 启用，默认关闭。当前清单保持历史补丁的串行顺序，不意味着每对相邻补丁都有语义依赖。

升级先核对 `scripts/prepare` 与 `default.nix` 的应用版本和来源，再在新候选目录提取原始文件。更新 manifest 的版本许可、生成文件名、目标文件和补丁定位；不要只改版本许可绕过检查。根据原始内容与预期内容生成 unified diff，避免手填 hunk 计数。`scripts/prepare_asar` 是内部 worker，必须由候选构建入口传入新建的 `CODEX_WEB_STAGE`。它不能直接覆盖运行目录。

预检会报告不支持的版本、缺失目标文件、顺序不一致；逐项 patch dry-run 会指出具体补丁、文件、hunk 和上下文冲突。后续补丁的预检发生在前置补丁应用后，适配共享文件的依赖关系。失败目录可用于定位，修复后重新运行准备命令，不把失败目录改成 validated。

## 首次接入版本入口

现有 `scratch/asar` 和旧后端文件保持原位。首次切换前，保存当前用户服务配置（含现有 drop-in），并记下原始 ExecStart。当前本机原始入口为 `node --max-old-space-size=512 src/server/main.js --host 127.0.0.1 --port 8214`；其他机器须独立核对。

在用户选择的安全窗口停止服务，然后选择候选：

```bash
systemctl --user stop codex-web.service
./scripts/releases activate <候选ID> --service-stopped
```

命令同时要求显式确认和 systemd 返回 inactive/failed；active、activating 或查询异常均拒绝切换。它只原子替换 `scratch/releases/current` 链接，不修改 systemd 或自动启动服务。首次启用时用独立的 `releases.conf` drop-in 替换 ExecStart，保留其他服务配置：

```ini
[Service]
ExecStart=
ExecStart=/home/sean/projects/codex-web/scripts/releases serve --host 127.0.0.1 --port 8214
Environment=NODE_OPTIONS=--max-old-space-size=512
Environment=PATH=/home/sean/.local/share/fnm/node-versions/v24.18.0/installation/bin:/usr/local/bin:/usr/bin:/bin
```

脚本依据自身位置找到仓库。`serve` 校验清单和所有产物后，使用同一候选的后端和 ASAR，启动时将 current 解析成固定路径；后续指针变化不会让已启动后端混读另一份浏览器资源。服务应保持仓库为 WorkingDirectory，保留已有 CODEX_CLI_PATH、认证与环境配置。上面的 PATH 是本机已核对的 Node 路径，其他安装应按自己的原始 ExecStart 配置。Node、共享 node_modules 与 CLI 没有打包到候选；变更这些依赖时还需保留相容的运行环境，资源回退不等于系统依赖回退。

```bash
systemctl --user daemon-reload
systemctl --user start codex-web.service
```

在 Windows 浏览器刷新，检查首页、对话、文件预览和任务侧栏，核对控制台及服务日志。构建通过不替代实际启动和浏览器验收。新版本不适合当前 CLI 时，独立核对 CLI 兼容性；不要同时自动升级 CLI。

## 后续切换和恢复

先停止消费者，运行 `activate <新ID> --service-stopped`，再启动服务并刷新浏览器。原 current 保存到 previous；新候选与前一候选均保留，不自动清理。

```bash
systemctl --user stop codex-web.service
./scripts/releases rollback --service-stopped
systemctl --user start codex-web.service
```

rollback 会交换 current/previous，可恢复刚才的选择。失败或被篡改候选拒绝启用。第一次接入没有 previous 时，移除本次新增的 `releases.conf`（不要删除其他 drop-in），daemon-reload 后按原始 ExecStart 启动；旧 scratch 和源码旁编译文件没有被候选准备覆盖。这是首次迁移恢复路径。

生产版本按前后端一组切换，因此默认按安全停机窗口处理。旧布局纯浏览器资源的原地更新可刷新生效，后端或上游主进程变更必须重启；不可把“刷新生效”扩展到完整候选切换。没有用户确认安全时间，不执行停止/重启/实际切换。

## 可重复检查

```bash
python3 tests/releases.test.py
npm run test:files
npm run test:startup
HOSTED_CODEX_APP_ASAR="$PWD/scratch/ChatGPT.app/Contents/Resources/app.asar" npm run build
```

发布单测覆盖上游版本与目标文件预检、准备失败保留选择、运行中服务拒绝切换、成功切换/恢复、未验证及篡改产物拒绝启用。单测使用临时目录和模拟服务状态，不停止本机服务。完整候选构建验证真实补丁链和前后端编译；当前服务实际切换、重启及浏览器验收单独记录。
