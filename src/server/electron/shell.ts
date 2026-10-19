import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import { promisify } from "node:util";

const runFile = promisify(execFile);

export function normalizeWindowsPath(value: string): string {
  // wslpath may emit repeated separators; Explorer needs a canonical UNC/drive path.
  let input = value.trim().replaceAll("/", "\\");
  const unc = input.startsWith("\\\\");
  input = input.replace(/\\+/g, "\\");
  if (unc) input = "\\" + input;
  const normalized = path.win32.normalize(input);
  if (!path.win32.isAbsolute(normalized) || normalized.includes("\0")) {
    throw new Error("无法转换为 Windows 绝对路径。");
  }
  return normalized;
}

export function explorerArguments(
  windowsPath: string,
  isDirectory: boolean,
): string[] {
  const normalized = normalizeWindowsPath(windowsPath);
  return isDirectory ? [normalized] : ["/select,", normalized];
}

function isWsl(): boolean {
  return (
    process.platform === "linux" &&
    (process.env.WSL_INTEROP != null ||
      process.env.WSL_DISTRO_NAME != null ||
      readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft"))
  );
}

function findExplorer(): string {
  for (const root of [
    "/mnt/c",
    ...readdirSync("/mnt").map((name) => path.join("/mnt", name)),
  ]) {
    const executable = path.join(root, "Windows", "explorer.exe");
    if (existsSync(executable)) return executable;
  }
  throw new Error("找不到 Windows Explorer，请检查 WSL 的 Windows 盘符挂载。");
}

export async function resolveHostPath(input: string): Promise<string> {
  if (typeof input !== "string" || !input || input.includes("\0")) {
    throw new Error("文件路径不能为空或包含空字符。");
  }
  let value = input;
  if (/^file:/i.test(value)) {
    const url = new URL(value);
    value = decodeURIComponent(url.pathname);
    if (url.hostname && url.hostname !== "localhost")
      value = `//${url.hostname}${value}`;
    if (/^\/[a-z]:\//i.test(value)) value = value.slice(1);
  }
  if (
    process.platform !== "win32" &&
    (/^[a-z]:[\\/]/i.test(value) || /^[\\/]{2}[^/]/.test(value))
  ) {
    const { stdout } = await runFile(
      "wslpath",
      ["-u", normalizeWindowsPath(value)],
      { timeout: 5000 },
    );
    value = stdout.trim();
    if (!path.isAbsolute(value)) throw new Error("无法转换为 WSL 文件路径。");
  }
  if (value === "~") value = os.homedir();
  if (value.startsWith("~/")) value = path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function launch(
  command: string,
  args: string[],
  cwd?: string,
): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      ...(cwd ? { cwd } : {}),
    });
    child.once("error", (error) => resolve(error.message));
    child.once("spawn", () => {
      child.unref();
      resolve("");
    });
  });
}

/** Both default Open and Reveal select files in Windows Explorer on WSL. */
export async function revealInFileManager(input: string): Promise<string> {
  try {
    const fullPath = await resolveHostPath(input);
    const stat = await fs.stat(fullPath);
    if (!stat.isFile() && !stat.isDirectory())
      return "只能打开普通文件或目录。";
    if (isWsl()) {
      const explorer = findExplorer();
      const { stdout } = await runFile("wslpath", ["-w", fullPath], {
        timeout: 5000,
      });
      // A Windows cwd avoids exposing a Linux UNC working directory to the launcher.
      return await launch(
        explorer,
        explorerArguments(stdout, stat.isDirectory()),
        path.dirname(path.dirname(explorer)),
      );
    }
    if (process.platform === "win32")
      return await launch(
        "explorer.exe",
        explorerArguments(fullPath, stat.isDirectory()),
      );
    if (process.platform === "darwin")
      return await launch(
        "open",
        stat.isDirectory() ? [fullPath] : ["-R", fullPath],
      );
    return await launch("xdg-open", [
      stat.isDirectory() ? fullPath : path.dirname(fullPath),
    ]);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export const shell = {
  openPath: revealInFileManager,
  showItemInFolder(fullPath: string): void {
    void revealInFileManager(fullPath).then((error) => {
      if (error) console.error("[electron-shell] Failed to reveal file", error);
    });
  },
};
