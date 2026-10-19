/** Open host files inside the current tab; no popup or OS association required. */
export function localFileUrl(
  input: string,
  line?: number,
  fromLink = false,
): string | null {
  let filePath = input;
  if (filePath.startsWith("/@fs/")) {
    filePath = filePath.slice(4);
    if (!fromLink) filePath = decodeURIComponent(filePath);
  }
  const isLocal =
    /^(?:file:|[a-z]:[\\/]|\\\\(?:wsl\$|wsl\.localhost)\\|\/)/i.test(filePath);
  if (
    !isLocal ||
    /^\/(?:$|__backend(?:\/|$)|thread(?:\/|$)|local(?:\/|$)|remote(?:\/|$)|automations(?:\/|$)|skills(?:\/|$)|plugins(?:\/|$)|apps(?:\/|$)|library(?:\/|$)|search(?:\/|$)|auth(?:\/|$)|space(?:\/|$)|settings(?:\/|$)|assets(?:\/|$)|share(?:\/|$))/.test(
      filePath,
    )
  )
    return null;
  // Absolute Markdown file links may carry either :line[:column] or #Lline.
  const location = fromLink
    ? filePath.match(/(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?)$/)
    : null;
  if (location) {
    line ??= Number(location[1] ?? location[2]);
    filePath = filePath.slice(0, location.index);
  }
  if (fromLink && !/^file:/i.test(filePath)) {
    try {
      filePath = decodeURIComponent(filePath);
    } catch {
      /* Literal percent in a filename. */
    }
  }
  const params = new URLSearchParams({ path: filePath });
  if (line && Number.isSafeInteger(line) && line > 0)
    params.set("line", String(line));
  return `/__backend/files/view?${params}${line ? `#L${line}` : ""}`;
}

export function openLocalFile(
  input: string,
  line?: number,
  fromLink = false,
): boolean {
  const url = localFileUrl(input, line, fromLink);
  if (!url) return false;
  const existing = document.getElementById(
    "codex-web-file-viewer",
  ) as HTMLDialogElement | null;
  existing?.close();
  const dialog = document.createElement("dialog");
  dialog.id = "codex-web-file-viewer";
  dialog.setAttribute("aria-label", "主机文件预览");
  Object.assign(dialog.style, {
    width: "min(1200px, 94vw)",
    height: "90vh",
    padding: "12px",
    border: "1px solid #888",
    borderRadius: "12px",
    background: "Canvas",
    color: "CanvasText",
  });
  const close = document.createElement("button");
  close.textContent = "关闭预览";
  close.style.cssText = "float:right;padding:6px 12px;margin-bottom:8px";
  close.onclick = () => dialog.close();
  const frame = document.createElement("iframe");
  frame.title = "文件和目录";
  frame.src = url;
  frame.style.cssText =
    "width:100%;height:calc(100% - 45px);border:0;display:block";
  dialog.append(close, frame);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
  return true;
}

export function installLocalFileLinks(): void {
  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const anchor =
        event.target instanceof Element
          ? event.target.closest("a[href]")
          : null;
      const href = anchor?.getAttribute("href");
      if (!href) return;
      try {
        if (!localFileUrl(href, undefined, true)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        openLocalFile(href, undefined, true);
      } catch (error) {
        console.error("Failed to open local file", error);
      }
    },
    true,
  );
}
