import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const textLimit = 2 * 1024 * 1024;
const mediaTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
};

export function resolveLocalPath(input: string, cwd = os.homedir()): string {
  let value = input;
  if (/^file:/i.test(value)) {
    const url = new URL(value);
    value = decodeURIComponent(url.pathname);
    if (url.hostname && url.hostname !== "localhost")
      value = `//${url.hostname}${value}`;
    if (/^\/[a-z]:\//i.test(value)) value = value.slice(1);
  }
  // Windows clients may paste drive paths or the UNC path of this WSL distro.
  const unc = value
    .replaceAll("\\", "/")
    .match(/^\/\/(wsl\$|wsl\.localhost)\/([^/]+)(\/.*)?$/i);
  if (unc) {
    if (
      !process.env.WSL_DISTRO_NAME ||
      unc[2]?.toLowerCase() !== process.env.WSL_DISTRO_NAME.toLowerCase()
    ) {
      throw new Error(
        "该路径属于其他 WSL 发行版，请使用当前主机的 Linux 路径。",
      );
    }
    value = unc[3] || "/";
  } else if (process.platform !== "win32" && /^[a-z]:[\\/]/i.test(value)) {
    value = `/mnt/${value[0]!.toLowerCase()}/${value.slice(3).replaceAll("\\", "/")}`;
  } else if (/^[\\/]{2}/.test(value)) {
    throw new Error("不支持远程网络路径，请使用当前主机的文件路径。");
  }
  if (value.includes("\0") || !value)
    throw new Error("文件路径不能为空或包含空字符。");
  if (value === "~") value = os.homedir();
  if (value.startsWith("~/")) value = path.join(os.homedir(), value.slice(2));
  return path.resolve(cwd, value);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}

export function fileViewUrl(filePath: string, line?: string): string {
  return `/__backend/files/view?${new URLSearchParams({ path: filePath, ...(line ? { line } : {}) })}${line ? `#L${encodeURIComponent(line)}` : ""}`;
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>
  :root{color-scheme:light dark;font:14px/1.6 system-ui,sans-serif}body{margin:20px}header{display:flex;gap:16px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #8885;padding-bottom:12px}h1{font-size:16px;overflow-wrap:anywhere;margin:0;flex:1}a{color:light-dark(#175bc1,#8dbbff)}ul{list-style:none;padding:0}li{padding:5px 0}pre{tab-size:4;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.line{display:block;min-height:1.6em}.line:target{background:#e8b32340}.number{display:inline-block;width:5em;text-align:right;margin-right:1em;opacity:.55;user-select:none}img,video{max-width:100%;max-height:80vh}iframe{width:100%;height:80vh;border:0}main{padding-top:16px}form{display:flex;gap:8px;margin:12px 0}input{flex:1;min-width:0;padding:8px}button{padding:8px}p{overflow-wrap:anywhere}</style>${body}</html>`;
}

export function registerLocalFiles(app: FastifyInstance): void {
  app.get<{ Querystring: { path?: string; line?: string } }>(
    "/__backend/files/view",
    async (request, reply) => {
      reply
        .header("Cache-Control", "no-store")
        .header(
          "Content-Security-Policy",
          "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none'",
        )
        .type("text/html; charset=utf-8");
      try {
        const filePath = resolveLocalPath(request.query.path ?? os.homedir());
        const stat = await fs.stat(filePath);
        const parent = path.dirname(filePath);
        const link = (target: string, label: string) =>
          `<a href="${escapeHtml(fileViewUrl(target))}">${escapeHtml(label)}</a>`;
        const header = `<header><h1>${escapeHtml(filePath)}</h1>${link(parent, "上级目录")}</header><form action="/__backend/files/view"><input name="path" aria-label="文件或目录路径" value="${escapeHtml(filePath)}"><button>打开路径</button></form>`;
        if (stat.isDirectory()) {
          const entries = await fs.readdir(filePath, { withFileTypes: true });
          entries.sort(
            (a, b) =>
              Number(b.isDirectory()) - Number(a.isDirectory()) ||
              a.name.localeCompare(b.name),
          );
          return page(
            filePath,
            `${header}<main><ul>${entries.map((entry) => `<li>${link(path.join(filePath, entry.name), `${entry.isDirectory() ? "📁" : "📄"} ${entry.name}`)}</li>`).join("")}</ul>${entries.length ? "" : "<p>空目录</p>"}</main>`,
          );
        }
        if (!stat.isFile())
          return reply
            .code(400)
            .send(page("无法打开", "<p>仅支持普通文件和目录。</p>"));
        const contentUrl = `/__backend/files/content?${new URLSearchParams({ path: filePath })}`;
        const download = `<p><a href="${escapeHtml(contentUrl)}&amp;download=1">下载文件，在 Windows 中打开</a> · ${stat.size.toLocaleString()} 字节</p>`;
        const mime = mediaTypes[path.extname(filePath).toLowerCase()];
        let preview: string;
        if (mime?.startsWith("image/"))
          preview = `<img src="${escapeHtml(contentUrl)}" alt="${escapeHtml(path.basename(filePath))}">`;
        else if (mime?.startsWith("video/"))
          preview = `<video controls src="${escapeHtml(contentUrl)}"></video>`;
        else if (mime?.startsWith("audio/"))
          preview = `<audio controls src="${escapeHtml(contentUrl)}"></audio>`;
        else if (mime === "application/pdf")
          preview = `<iframe title="PDF 预览" sandbox="allow-scripts" src="${escapeHtml(contentUrl)}"></iframe>`;
        else if (stat.size > textLimit)
          preview = "<p>文件超过 2 MiB，请下载查看。</p>";
        else {
          const buffer = await fs.readFile(filePath);
          try {
            if (buffer.includes(0)) throw new Error("binary");
            const text = new TextDecoder("utf-8", { fatal: true }).decode(
              buffer,
            );
            preview = `<pre>${text
              .split("\n")
              .map(
                (line, i) =>
                  `<span class="line" id="L${i + 1}"><a class="number" href="#L${i + 1}">${i + 1}</a>${escapeHtml(line)}</span>`,
              )
              .join("")}</pre>`;
          } catch {
            preview =
              "<p>此格式暂不支持网页预览，请下载后使用 Windows 工具打开。</p>";
          }
        }
        return page(filePath, `${header}${download}<main>${preview}</main>`);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return reply
          .code(
            code === "ENOENT" || code === "ENOTDIR"
              ? 404
              : code === "EACCES"
                ? 403
                : 400,
          )
          .send(
            page(
              "无法打开文件",
              `<h1>无法打开文件</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p><a href="/__backend/files/view">浏览主机文件</a>`,
            ),
          );
      }
    },
  );

  app.get<{ Querystring: { path?: string; download?: string } }>(
    "/__backend/files/content",
    async (request, reply) => {
      reply
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header(
          "Content-Security-Policy",
          "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        );
      try {
        if (!request.query.path)
          return reply.code(400).send({ error: "path is required" });
        const filePath = resolveLocalPath(request.query.path);
        const stat = await fs.stat(filePath);
        if (!stat.isFile())
          return reply.code(400).send({ error: "仅支持普通文件。" });
        const mime = mediaTypes[path.extname(filePath).toLowerCase()];
        const disposition =
          request.query.download === "1" || !mime ? "attachment" : "inline";
        reply.header(
          "Content-Disposition",
          `${disposition}; filename*=UTF-8''${encodeURIComponent(path.basename(filePath)).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
        );
        reply
          .type(mime ?? "application/octet-stream")
          .header("Accept-Ranges", "bytes");
        const range = request.headers.range;
        let start = 0,
          end = stat.size - 1;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!match || (!match[1] && !match[2]))
            return reply
              .code(416)
              .header("Content-Range", `bytes */${stat.size}`)
              .send();
          start = match[1]
            ? Number(match[1])
            : Math.max(0, stat.size - Number(match[2]));
          end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start > end ||
            start >= stat.size
          )
            return reply
              .code(416)
              .header("Content-Range", `bytes */${stat.size}`)
              .send();
          reply
            .code(206)
            .header("Content-Range", `bytes ${start}-${end}/${stat.size}`);
        }
        reply.header("Content-Length", stat.size === 0 ? 0 : end - start + 1);
        return stat.size === 0
          ? reply.send("")
          : reply.send(createReadStream(filePath, { start, end }));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return reply
          .code(
            code === "ENOENT" || code === "ENOTDIR"
              ? 404
              : code === "EACCES"
                ? 403
                : 400,
          )
          .send({
            error: error instanceof Error ? error.message : String(error),
          });
      }
    },
  );
}
