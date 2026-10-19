/** Reuse the existing raw-file server; do not send WSL file:// URLs to Windows Chrome. */
export function toBrowserUrl(input: string, base: string): string {
  const url = new URL(input, base);
  if (url.protocol !== "file:") return url.href;
  if (url.hostname && url.hostname !== "localhost") {
    throw new Error("请通过打开所在文件夹访问其他主机的文件。");
  }
  let filePath = decodeURIComponent(url.pathname);
  // file:///C:/... is a Windows drive path; local WSL links normally use /home/...
  if (/^\/[a-z]:\//i.test(filePath))
    filePath = `/mnt/${filePath[1]!.toLowerCase()}${filePath.slice(3)}`;
  if (!filePath.startsWith("/") || filePath.includes("\0"))
    throw new Error("无效的本地文件链接。");
  const target = new URL(
    `/@fs${filePath.split("/").map(encodeURIComponent).join("/")}`,
    base,
  );
  target.hash = url.hash;
  target.search = url.search;
  return target.href;
}

export function openBrowserLink(input: string): void {
  const url = toBrowserUrl(input, window.location.href);
  // Some requests arrive after async work has consumed the click activation.
  // Keep a real Window handle to detect blocking; noopener would always return null.
  const tab = window.open("about:blank", "_blank");
  if (!tab) {
    window.location.assign(url);
    return;
  }
  tab.opener = null;
  const referrer = tab.document.createElement("meta");
  referrer.name = "referrer";
  referrer.content = "no-referrer";
  tab.document.head.append(referrer);
  tab.location.replace(url);
}
