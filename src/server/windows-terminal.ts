import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);
const windowsSystem = "/mnt/c/Windows/System32";

export async function openWindowsTerminal(cwd: unknown): Promise<void> {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || cwd.includes("\0"))
    throw new Error("无法确定当前对话的本地工作目录。");
  if (!(await fs.stat(cwd)).isDirectory()) throw new Error("工作目录不是文件夹。");
  const { stdout } = await run("wslpath", ["-w", "/"], { timeout: 5000 });
  const distro = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\/i.exec(stdout.trim())?.[1];
  if (!distro) throw new Error("无法确定当前 WSL 发行版。");
  // Embed data as base64, never as PowerShell or cmd source text.
  const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");
  const script = `$ErrorActionPreference='Stop'; $d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encode(distro)}')); $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encode(cwd)}')); & wt.exe -w 0 new-tab wsl.exe -d $d --cd $p; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`;
  await run(path.join(windowsSystem, "WindowsPowerShell/v1.0/powershell.exe"), [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
  ], { timeout: 15000, windowsHide: true });
}

export function registerWindowsTerminalRoute(app: FastifyInstance): void {
  app.post<{ Body: { cwd?: unknown } }>("/__backend/windows-terminal", async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin || origin !== `${request.protocol}://${request.headers.host}`)
      return reply.code(403).send({ error: "请求来源不匹配。" });
    try {
      await openWindowsTerminal(request.body?.cwd);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ error: `无法打开 Windows Terminal：${message}` });
    }
  });
}
