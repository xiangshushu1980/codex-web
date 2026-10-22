type Lease = {
  id: string;
  owner?: string;
  resources?: string[];
  kind?: string;
  metadata?: Record<string, unknown>;
  acquiredAt?: string;
  expiresAt?: string;
  heartbeatAt?: string;
};

type Occupancy = {
  leases?: Record<string, Lease>;
  generatedAt?: string;
  error?: string;
};

const PANEL_ID = "codex-web-hive-resource-panel";
const REFRESH_MS = 8_000;

const prompts = {
  acquire: (threadId: string) =>
    `本对话需要使用 GPU/共享资源。请先通过 hive-resource 申请本次工作所需的租约，owner 使用 codex:${threadId}，并在 metadata 中记录 conversationId 和 threadId；只有成功获得租约后才开始调用资源。`,
  retain: (threadId: string) =>
    `本轮测试结束后请暂时保留本对话的资源租约，供我连续进行下一轮测试。完成当前调用后不要释放；如果需要长时间保留，请继续按 hive-resource 规则续租。owner/conversationId 对应本对话 ${threadId}。`,
  release: (threadId: string) =>
    `请检查本对话 ${threadId} 持有的 hive-resource 租约。只有确认相关 GPU/资源调用和后台作业均已结束后才释放；如果仍在运行或无法确认，请先保留租约并告诉我状态。`,
  takeover: (threadId: string) =>
    `我想在本对话 ${threadId} 使用当前被其他对话占用的资源。请先检查租约的 owner，并尝试与持有租约的对话协调：只有对方确认工作结束并释放后，才申请本对话的租约。不要直接强制释放或绕过租约；若无法联系或确认，请说明暂时不能安全接管。`,
};

function conversationId(): string | null {
  const match = location.pathname.match(/^\/(?:thread|local)\/([^/]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function dateLabel(value?: string): string {
  if (!value) return "未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未知" : date.toLocaleString();
}

function metadataConversationId(lease: Lease): string | undefined {
  const metadata = lease.metadata ?? {};
  const candidate = metadata.conversationId ?? metadata.threadId;
  return typeof candidate === "string" ? candidate : undefined;
}

function leaseBelongsTo(lease: Lease, threadId: string): boolean {
  return (
    metadataConversationId(lease) === threadId ||
    lease.owner === threadId ||
    lease.owner === `codex:${threadId}`
  );
}

function visible(element: HTMLElement): boolean {
  return element.getClientRects().length > 0;
}

function findComposer(): HTMLElement | null {
  const selectors = [
    '[data-testid*="composer"] [contenteditable="true"]',
    '[data-testid*="composer"] textarea',
    'form [contenteditable="true"][role="textbox"]',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    '[contenteditable]:not([contenteditable="false"])',
    "textarea",
  ];
  for (const selector of selectors) {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter((element) => visible(element) && !element.closest(`#${PANEL_ID}`));
    if (candidates.length) return candidates[candidates.length - 1];
  }
  return null;
}

function appendToComposer(text: string): boolean {
  const composer = findComposer();
  if (!composer) return false;
  composer.focus();
  const separator = composer.textContent?.trim() ||
    (composer instanceof HTMLTextAreaElement && composer.value.trim())
    ? "\n"
    : "";
  const insertion = `${separator}${text}`;

  if (composer instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(composer, `${composer.value}${insertion}`);
    composer.setSelectionRange(composer.value.length, composer.value.length);
    composer.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: insertion,
    }));
    return true;
  }

  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(composer);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  const inserted = document.execCommand("insertText", false, insertion);
  if (!inserted) return false;
  composer.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertText",
    data: insertion,
  }));
  return true;
}

export function mountResourceLeasePanel(): void {
  if (document.getElementById(PANEL_ID)) return;

  const panel = document.createElement("details");
  panel.id = PANEL_ID;
  Object.assign(panel.style, {
    position: "fixed",
    left: "12px",
    bottom: "12px",
    zIndex: "2147483640",
    width: "min(420px, calc(100vw - 24px))",
    boxSizing: "border-box",
    border: "1px solid #73737388",
    borderRadius: "10px",
    background: "#202123",
    color: "#eee",
    font: "12px/1.5 system-ui, sans-serif",
    boxShadow: "0 3px 16px #0005",
  });

  const summary = document.createElement("summary");
  Object.assign(summary.style, { cursor: "pointer", padding: "8px 10px" });
  const content = document.createElement("div");
  Object.assign(content.style, { padding: "0 10px 10px", maxHeight: "45vh", overflow: "auto" });
  panel.append(summary, content);
  document.body.append(panel);

  let currentThreadId: string | null = null;
  let lastSnapshot: Occupancy | null = null;
  let errorMessage = "";

  function button(label: string, prompt: string): HTMLButtonElement {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = label;
    item.title = "将提示文字加入当前对话输入框；不会自动发送或操作租约";
    Object.assign(item.style, {
      border: "1px solid #666",
      borderRadius: "6px",
      background: "#303136",
      color: "#eee",
      padding: "5px 8px",
      cursor: "pointer",
      font: "inherit",
    });
    item.addEventListener("click", () => {
      const inserted = appendToComposer(prompt);
      status.textContent = inserted
        ? "提示已加入输入框，请检查后手动发送。"
        : "未找到对话输入框，提示已复制到剪贴板。";
      if (!inserted) void navigator.clipboard?.writeText(prompt).catch(() => {});
    });
    return item;
  }

  const status = document.createElement("div");
  Object.assign(status.style, { marginTop: "8px", color: "#a3a3a3" });

  function render(): void {
    currentThreadId = conversationId();
    const leases = Object.values(lastSnapshot?.leases ?? {});
    const mine = currentThreadId
      ? leases.filter((lease) => leaseBelongsTo(lease, currentThreadId!))
      : [];
    summary.textContent = currentThreadId
      ? `Hive 租约 · 本对话 ${mine.length ? `持有 ${mine.length} 项` : "未识别到租约"} · 全局 ${leases.length} 项`
      : `Hive 租约 · 请打开一个对话 · 全局 ${leases.length} 项`;
    content.replaceChildren();

    if (errorMessage) {
      const error = document.createElement("div");
      error.textContent = errorMessage;
      error.style.color = "#fca5a5";
      content.append(error);
    } else if (!lastSnapshot) {
      const loading = document.createElement("div");
      loading.textContent = "正在读取租约状态…";
      content.append(loading);
    }

    const ownHeading = document.createElement("div");
    ownHeading.textContent = currentThreadId
      ? `当前对话：${currentThreadId}`
      : "当前没有打开的对话";
    ownHeading.style.fontWeight = "600";
    content.append(ownHeading);
    if (currentThreadId && mine.length === 0) {
      const none = document.createElement("div");
      none.textContent = "未匹配到本对话租约（租约未记录对话 ID 时会显示为无法确认归属）。";
      none.style.color = "#fbbf24";
      content.append(none);
    }

    for (const lease of leases) {
      const block = document.createElement("div");
      Object.assign(block.style, {
        marginTop: "7px",
        padding: "7px",
        border: "1px solid #ffffff20",
        borderRadius: "7px",
      });
      const heading = document.createElement("div");
      const isMine = !!currentThreadId && leaseBelongsTo(lease, currentThreadId);
      heading.textContent = `${isMine ? "本对话" : "其他/未确认对话"} · ${lease.owner || "未标注持有者"}`;
      heading.style.fontWeight = "600";
      const resources = document.createElement("div");
      const names = lease.resources ?? [];
      resources.textContent = `已锁定：${names.join(", ") || "资源未标注"}${names.includes("gpu:exclusive") ? "（GPU 独占）" : ""}`;
      const expiry = document.createElement("div");
      expiry.textContent = `ID：${lease.id} · 到期：${dateLabel(lease.expiresAt)} · 获取：${dateLabel(lease.acquiredAt)} · 心跳：${dateLabel(lease.heartbeatAt)}`;
      expiry.style.color = "#a3a3a3";
      expiry.style.overflowWrap = "anywhere";
      block.append(heading, resources, expiry);
      content.append(block);
    }

    const actions = document.createElement("div");
    Object.assign(actions.style, {
      display: "flex",
      flexWrap: "wrap",
      gap: "6px",
      marginTop: "9px",
    });
    const threadId = currentThreadId ?? "当前对话";
    actions.append(
      button("申请租约", prompts.acquire(threadId)),
      button("暂时保留", prompts.retain(threadId)),
      button("检查并释放", prompts.release(threadId)),
      button("请求接管", prompts.takeover(threadId)),
    );
    content.append(actions, status);
    const refreshed = document.createElement("div");
    refreshed.textContent = `状态读取时间：${dateLabel(lastSnapshot?.generatedAt)}`;
    refreshed.style.cssText = "margin-top:6px;color:#737373;font-size:11px";
    content.append(refreshed);
  }

  async function refresh(): Promise<void> {
    try {
      const response = await fetch("/__backend/hive-resource/occupancy", {
        cache: "no-store",
      });
      const body = (await response.json()) as Occupancy;
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      lastSnapshot = body;
      errorMessage = "";
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    render();
  }

  render();
  void refresh();
  window.setInterval(() => {
    if (conversationId() !== currentThreadId) render();
  }, 1_000);
  window.setInterval(() => void refresh(), REFRESH_MS);
}
