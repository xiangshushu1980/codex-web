import { updateHeaderStatus } from "./header-status";
import { attachFloatingPanel } from "./floating-panels";
type TokenUsage = {
  totalTokens: number;
  modelContextWindow?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  updatedAt: number;
};
type LimitWindow = { usedPercent: number; resetsAt?: number | string };
type UsageSnapshot = {
  threadUsage?: TokenUsage;
  tokenCount?: TokenUsage;
  firstObserved?: { totalTokens: number; observedAt: number };
  limits?: { fiveHour?: LimitWindow; sevenDay?: LimitWindow };
};

type RecordValue = Record<string, unknown>;
const PANEL_ID = "codex-web-context-usage";
const EVENT_NAME = "codex-web:host-message";
const STORAGE_KEY = "codex-web:usage-snapshots:v5";
const REQUEST_KEY = `${STORAGE_KEY}:thread-resume`;
const RATE_LIMIT_REFRESH_MS = 5 * 60_000;
const USAGE_REQUEST_COOLDOWN_MS = 60_000;
const USAGE_REQUEST_TIMEOUT_MS = 10_000;

declare global {
  interface Window {
    __codexWebReadRateLimits?: () => Promise<unknown>;
    __codexWebRequestThreadUsage?: (threadId: string) => Promise<unknown>;
  }
}

function currentThreadId(): string | null {
  const match = location.pathname.match(/^\/(?:thread|local)\/([^/]+)/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}
function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null;
}
function normalizeId(value: string): string {
  return value.replace(/^(?:(?:codex:)?thread:(?:local|remote):|(?:local|remote):|codex:)/, "");
}
function formatCount(value: number): string {
  return `${new Intl.NumberFormat().format(Math.round(value / 1_000))}K`;
}
function readTokenUsage(
  value: unknown,
  modelContextWindow?: unknown,
  updatedAt = Date.now(),
): TokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const totalTokens = value.total_tokens ?? value.totalTokens;
  if (typeof totalTokens !== "number") return undefined;
  const readNumber = (snakeCase: string, camelCase: string) => {
    const tokenValue = value[snakeCase] ?? value[camelCase];
    return typeof tokenValue === "number" ? tokenValue : undefined;
  };
  return {
    totalTokens,
    modelContextWindow:
      typeof modelContextWindow === "number" ? modelContextWindow : undefined,
    inputTokens: readNumber("input_tokens", "inputTokens"),
    cachedInputTokens: readNumber("cached_input_tokens", "cachedInputTokens"),
    outputTokens: readNumber("output_tokens", "outputTokens"),
    reasoningOutputTokens: readNumber(
      "reasoning_output_tokens",
      "reasoningOutputTokens",
    ),
    updatedAt,
  };
}
function updatedAgo(updatedAt?: number): string {
  if (!updatedAt) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - updatedAt) / 1_000));
  return ` · ${seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`} 前`;
}
function findTokenEvent(value: unknown, depth = 0): RecordValue | null {
  if (!isRecord(value) || depth > 9) return null;
  const method = value.method ?? value.type;
  if (method === "codex/event/token_count" || method === "thread/tokenUsage/updated" || method === "token_count") return value;
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) { const found = findTokenEvent(item, depth + 1); if (found) return found; }
    } else {
      const found = findTokenEvent(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}
function readLimit(value: unknown): LimitWindow | undefined {
  if (!isRecord(value) || typeof (value.used_percent ?? value.usedPercent) !== "number") return undefined;
  const resetsAt = value.resets_at ?? value.resetsAt;
  return { usedPercent: Number(value.used_percent ?? value.usedPercent), resetsAt: typeof resetsAt === "number" || typeof resetsAt === "string" ? resetsAt : undefined };
}
function readLimits(value: unknown): UsageSnapshot["limits"] | undefined {
  if (!isRecord(value)) return undefined;
  const byLimitId = isRecord(value.rateLimitsByLimitId)
    ? value.rateLimitsByLimitId
    : isRecord(value.rate_limits_by_limit_id)
      ? value.rate_limits_by_limit_id
      : null;
  if (byLimitId) {
    const codex = isRecord(byLimitId.codex) ? byLimitId.codex : null;
    if (codex) return readLimits(codex);
  }
  if (isRecord(value.rateLimits)) return readLimits(value.rateLimits);
  const primary = readLimit(value.primary);
  const secondary = readLimit(value.secondary);
  const windows = [primary, secondary].filter((item): item is LimitWindow => item !== undefined);
  const durationOf = (key: "primary" | "secondary") => {
    const item = value[key];
    return isRecord(item) ? Number(item.window_minutes ?? item.windowDurationMins) : NaN;
  };
  let fiveHour = durationOf("primary") === 300 ? primary : durationOf("secondary") === 300 ? secondary : undefined;
  let sevenDay = durationOf("primary") === 10080 ? primary : durationOf("secondary") === 10080 ? secondary : undefined;
  if (!fiveHour && windows.length && !Number.isFinite(durationOf("primary")) && !Number.isFinite(durationOf("secondary"))) {
    fiveHour = windows[0];
    sevenDay = windows[1];
  }
  return fiveHour || sevenDay ? { fiveHour, sevenDay } : undefined;
}
function findLimits(value: unknown, depth = 0): UsageSnapshot["limits"] | undefined {
  if (!isRecord(value) || depth > 9) return undefined;
  const direct = readLimits(value);
  if (direct) return direct;
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findLimits(item, depth + 1);
        if (found) return found;
      }
    } else {
      const found = findLimits(child, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}
function relativeReset(value?: number | string, dayWindow = false): string {
  if (value == null) return "重置时间未知";
  const timestamp = typeof value === "number" ? value * 1000 : Date.parse(value);
  if (!Number.isFinite(timestamp)) return "重置时间未知";
  // Round upward so the panel never claims a reset has arrived early. Drop to
  // the next smaller unit only inside the final hour/day of each window.
  const minutes = Math.max(0, Math.ceil((timestamp - Date.now()) / 60_000));
  if (minutes < 60) return `还有 ${minutes} 分钟`;
  if (!dayWindow || minutes < 24 * 60)
    return `还有 ${Math.ceil(minutes / 60)} 小时`;
  return `还有 ${Math.ceil(minutes / (24 * 60))} 日`;
}
function makePanel(): HTMLDetailsElement {
  const panel = document.createElement("details");
  panel.id = PANEL_ID;
  panel.open = true;
  return panel;
}
function line(label: string, value: string, percent?: number): HTMLDivElement {
  const row = document.createElement("div");
  row.style.cssText = "margin-top:8px";
  const heading = document.createElement("div");
  heading.style.cssText = "display:flex;justify-content:space-between;gap:12px";
  const name = document.createElement("span"); name.textContent = label; name.style.color = "#bbb";
  const data = document.createElement("span"); data.textContent = value; data.style.textAlign = "right";
  heading.append(name, data);
  row.append(heading);
  if (percent != null && Number.isFinite(percent)) {
    const track = document.createElement("div");
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", `${label}剩余比例`);
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.setAttribute("aria-valuenow", String(100 - Math.max(0, Math.min(100, percent))));
    track.style.cssText = "height:6px;margin-top:5px;overflow:hidden;border-radius:999px;background:#ffffff24";
    const fill = document.createElement("div");
    const remaining = 100 - Math.max(0, Math.min(100, percent));
    fill.style.cssText = `height:100%;width:${remaining}%;border-radius:inherit;background:#10a37f`;
    track.append(fill);
    row.append(track);
  }
  return row;
}
function limitText(window?: LimitWindow, dayWindow = false): string {
  return window ? `剩余 ${Math.max(0, Math.min(100, 100 - Math.round(window.usedPercent)))}% · ${relativeReset(window.resetsAt, dayWindow)}` : "未更新";
}
function mergeUsage(
  primary?: TokenUsage,
  details?: TokenUsage,
): TokenUsage | undefined {
  if (!primary) return details;
  if (!details) return primary;
  return {
    ...primary,
    inputTokens: primary.inputTokens ?? details.inputTokens,
    cachedInputTokens:
      primary.cachedInputTokens ?? details.cachedInputTokens,
    outputTokens: primary.outputTokens ?? details.outputTokens,
    reasoningOutputTokens:
      primary.reasoningOutputTokens ?? details.reasoningOutputTokens,
  };
}
function contextSegments(usage: TokenUsage, firstObserved?: UsageSnapshot["firstObserved"]): HTMLElement {
  const unit = 16_000;
  const capacity = Math.max(unit, usage.modelContextWindow ?? Math.max(256_000, usage.totalTokens));
  const firstRegion = Math.min(capacity, 128_000);
  const count = Math.ceil(firstRegion / 8_000) + Math.ceil(Math.max(0, capacity - 128_000) / unit);
  const dangerBoundary = capacity * 0.85;
  const segmentBoundaries = Array.from({ length: count + 1 }, (_, i) =>
    Math.min(capacity, i <= 16 ? i * 8_000 : 128_000 + (i - 16) * unit),
  );
  const dangerStart = segmentBoundaries.reduce((closest, boundary) =>
    Math.abs(boundary - dangerBoundary) < Math.abs(closest - dangerBoundary) ? boundary : closest,
  );
  const color = usage.totalTokens >= 256_000 ? "#ef5b57" : usage.totalTokens >= 128_000 ? "#f0a342" : "#59cfa5";
  const track = document.createElement("div");
  track.dataset.contextSegments = "true";
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-label", "上下文已使用，前128K每格8K，之后每格16K，128K橙色预警，256K红色预警");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", String(capacity));
  track.setAttribute("aria-valuenow", String(usage.totalTokens));
  track.setAttribute("aria-valuetext", `${formatCount(usage.totalTokens)} / ${formatCount(capacity)}`);
  track.style.cssText = "display:grid;grid-template-columns:repeat(32,minmax(0,1fr));gap:3px;margin-top:7px";
  for (let i = 0; i < count; i++) {
    const cell = document.createElement("span");
    const start = i < 16 ? i * 8_000 : 128_000 + (i - 16) * unit;
    const end = Math.min(capacity, start + (i < 16 ? 8_000 : unit));
    const filled = Math.max(0, Math.min(1, (usage.totalTokens - start) / (end - start)));
    const threshold = end === 128_000 ? "#f0a342" : end === 256_000 ? "#ef5b57" : "#ffffff30";
    cell.title = `${formatCount(start)}–${formatCount(end)}`;
    cell.dataset.filled = String(filled);
    cell.style.cssText = `position:relative;grid-column:span ${i < 16 ? 1 : 2};height:9px;box-sizing:border-box;border:1px solid ${threshold};border-radius:1px;background:#555;box-shadow:inset 0 1px 1px #ffffff20`;
    const fill = document.createElement("span");
    fill.style.cssText = `position:absolute;inset:-1px;border:1px solid ${threshold};border-radius:inherit;background:${color};box-shadow:inset 0 1px 1px #ffffff20;clip-path:inset(0 ${100 - filled * 100}% 0 0)`;
    cell.append(fill);
    if (firstObserved) {
      const initialFill = Math.max(0, Math.min(filled, (firstObserved.totalTokens - start) / (end - start)));
      if (initialFill > 0) {
        const initial = document.createElement("span");
        initial.style.cssText = `position:absolute;inset:-1px;border:1px solid ${threshold};border-radius:inherit;background:#7daaf5;box-shadow:inset 0 1px 1px #ffffff20;clip-path:inset(0 ${100 - initialFill * 100}% 0 0)`;
        cell.append(initial);
      }
    }
    if (start >= dangerStart) {
      const danger = document.createElement("span");
      danger.style.cssText = "pointer-events:none;position:absolute;inset:-1px;box-sizing:border-box;border:0;padding:0;border-radius:inherit;background:repeating-linear-gradient(135deg,transparent 0 3px,#ffffff50 3px 4px)";
      cell.append(danger);
    }
    track.append(cell);
  }
  const result = document.createElement("div");
  result.append(track);
  return result;
}
function usageRow(label: string, usage?: TokenUsage, showBreakdown = false, firstObserved?: UsageSnapshot["firstObserved"]): HTMLDivElement {
  if (!usage) return line(label, "未更新");
  const percent = usage.modelContextWindow
    ? Math.round(Math.min(usage.totalTokens, usage.modelContextWindow) / usage.modelContextWindow * 100)
    : undefined;
  const denominator = usage.modelContextWindow ? ` / ${formatCount(usage.modelContextWindow)}` : "";
  const row = line(label, `${formatCount(usage.totalTokens)}${denominator}${percent == null ? "" : ` · ${percent}%`}${updatedAgo(usage.updatedAt)}`);
  row.append(contextSegments(usage, firstObserved));
  if (showBreakdown) {
    const breakdown = document.createElement("div");
    breakdown.style.cssText = "margin:3px 0 0 2px;color:#999;font-size:11px";
    breakdown.textContent = [
      usage.inputTokens == null ? null : `输入 ${formatCount(usage.inputTokens)}`,
      usage.cachedInputTokens == null ? null : `缓存输入 ${formatCount(usage.cachedInputTokens)}`,
      usage.outputTokens == null ? null : `输出 ${formatCount(usage.outputTokens)}`,
      usage.reasoningOutputTokens == null ? null : `推理 ${formatCount(usage.reasoningOutputTokens)}`,
    ].filter(Boolean).join(" · ");
    if (breakdown.textContent) row.append(breakdown);
  }
  return row;
}
export function mountContextUsage(): void {
  const byThread = new Map<string, UsageSnapshot>();
  let accountLimits: UsageSnapshot["limits"];
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (isRecord(saved)) {
      for (const [id, value] of Object.entries(saved).slice(-32)) {
        if (isRecord(value)) byThread.set(id, value as UsageSnapshot);
      }
    }
  } catch {}
  try {
    const savedLimits = JSON.parse(sessionStorage.getItem(`${STORAGE_KEY}:account`) || "null");
    if (isRecord(savedLimits)) {
      accountLimits = {
        fiveHour: readLimit(savedLimits.fiveHour),
        sevenDay: readLimit(savedLimits.sevenDay),
      };
    }
  } catch {}
  let panel: HTMLDetailsElement | null = null;
  let refreshTimer = 0;
  let rateLimitTimer = 0;
  const usageRequests = new Map<string, number>();
  const refreshLimits = async () => {
    try {
      const read = window.__codexWebReadRateLimits;
      if (!read) return;
      const result = await read();
      const limits = findLimits(result);
      if (!limits) return;
      accountLimits = limits;
      try { sessionStorage.setItem(`${STORAGE_KEY}:account`, JSON.stringify(accountLimits)); } catch {}
      render();
    } catch {
      // Keep the last successful snapshot visible when a refresh is unavailable.
    }
  };
  const render = () => {
    if (!document.body) return;
    panel ??= document.getElementById(PANEL_ID) as HTMLDetailsElement | null ?? makePanel();
    if (!panel.isConnected) attachFloatingPanel(panel, "用量", "▥", 2);
    const id = currentThreadId();
    const snapshot = id ? byThread.get(normalizeId(id)) : undefined;
    if (id) {
      const key = normalizeId(id);
      const latestUpdate = Math.max(snapshot?.threadUsage?.updatedAt ?? 0, snapshot?.tokenCount?.updatedAt ?? 0);
      const now = Date.now();
      let lastRequest = usageRequests.get(key) ?? 0;
      try {
        const savedRequests = JSON.parse(localStorage.getItem(REQUEST_KEY) || "{}");
        if (isRecord(savedRequests) && typeof savedRequests[key] === "number") {
          lastRequest = Math.max(lastRequest, Number(savedRequests[key]));
        }
      } catch {}
      const request = window.__codexWebRequestThreadUsage;
      if (request && now - latestUpdate >= USAGE_REQUEST_COOLDOWN_MS && now - lastRequest >= USAGE_REQUEST_COOLDOWN_MS) {
        usageRequests.set(key, now);
        try {
          const savedRequests = JSON.parse(localStorage.getItem(REQUEST_KEY) || "{}");
          const requests = isRecord(savedRequests) ? savedRequests : {};
          requests[key] = now;
          const recent = Object.fromEntries(Object.entries(requests).slice(-32));
          localStorage.setItem(REQUEST_KEY, JSON.stringify(recent));
        } catch {}
        const timeout = window.setTimeout(() => usageRequests.delete(key), USAGE_REQUEST_TIMEOUT_MS);
        request(id).catch(() => {}).finally(() => window.clearTimeout(timeout));
      }
    }
    if (snapshot && accountLimits) snapshot.limits = accountLimits;
    const summary = document.createElement("summary");
    Object.assign(summary.style, {
      cursor: "pointer", textAlign: "center", listStyle: "none", padding: "8px 10px",
      boxSizing: "border-box", minHeight: "34px",
    });
    // The thread notification is generally the freshest context snapshot.
    // A legacy token_count snapshot is only used to fill missing breakdowns.
    const context = mergeUsage(snapshot?.threadUsage, snapshot?.tokenCount);
    const percent = context?.modelContextWindow ? Math.round(Math.min(context.totalTokens, context.modelContextWindow) / context.modelContextWindow * 100) : null;
    const fiveHour = snapshot?.limits?.fiveHour ?? accountLimits?.fiveHour;
    const sevenDay = snapshot?.limits?.sevenDay ?? accountLimits?.sevenDay;
    const fiveHourPercent = fiveHour?.usedPercent;
    const sevenDayPercent = sevenDay?.usedPercent;
    summary.dataset.expandedLabel = [
      "用量",
      percent == null ? "上下文未更新" : `上下文 ${percent}%`,
      fiveHourPercent == null ? "5H 未更新" : `5H ${Math.round(fiveHourPercent)}%`,
      sevenDayPercent == null ? "7日 未更新" : `7日 ${Math.round(sevenDayPercent)}%`,
    ].join(" · ");
    summary.textContent = "用量";
    summary.title = summary.dataset.expandedLabel;
    updateHeaderStatus("usage", [percent == null ? "上下文未更新" : `上下文 ${percent}%`, fiveHourPercent == null ? "5H 未更新" : `5H 余${Math.max(0, 100 - Math.round(fiveHourPercent))}%`, sevenDayPercent == null ? "7日 未更新" : `7日 余${Math.max(0, 100 - Math.round(sevenDayPercent))}%`].join(" · "));
    const rows: HTMLElement[] = [];
    rows.push(usageRow("上下文", context, true, snapshot?.firstObserved));
    rows.push(line("5H", limitText(fiveHour), fiveHourPercent));
    rows.push(line("7日", limitText(sevenDay, true), sevenDayPercent));
    panel.replaceChildren(summary, ...rows);
  };
  window.addEventListener(EVENT_NAME, (event) => {
    const raw = (event as CustomEvent<unknown>).detail;
    const incomingLimits = findLimits(raw);
    if (incomingLimits) {
      accountLimits = incomingLimits;
      try { sessionStorage.setItem(`${STORAGE_KEY}:account`, JSON.stringify(accountLimits)); } catch {}
    }
    const message = findTokenEvent(raw);
    if (!message) {
      if (accountLimits) render();
      return;
    }
    const params = isRecord(message.params) ? message.params : message;
    const eventMethod = message.method ?? message.type;
    const body = isRecord(params.msg) ? params.msg : params;
    const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : null;
    const rawId = params.threadId ?? params.thread_id ?? params.conversationId ?? body.thread_id ?? body.threadId;
    const isThreadUsage = eventMethod === "thread/tokenUsage/updated";
    const isTokenCount = eventMethod === "codex/event/token_count" || body.type === "token_count";
    if (!isThreadUsage && !isTokenCount) return;
    const activeId = currentThreadId();
    const key = typeof rawId === "string" ? normalizeId(rawId) : isTokenCount && activeId ? normalizeId(activeId) : null;
    if (!key) return;
    const snapshot = byThread.get(key) ?? {};
    if (isThreadUsage && tokenUsage) {
      const last = isRecord(tokenUsage.last) ? tokenUsage.last : null;
      const usage = readTokenUsage(last, tokenUsage.modelContextWindow);
      if (usage) {
        snapshot.threadUsage = usage;
      }
    }
    if (isTokenCount) {
      const info = isRecord(body.info) ? body.info : isRecord(params.info) ? params.info : null;
      const last = info && isRecord(info.last_token_usage) ? info.last_token_usage : null;
      const usage = readTokenUsage(last, info?.model_context_window);
      if (usage) snapshot.tokenCount = usage;
    }
    if (!snapshot.firstObserved) {
      const observed = isThreadUsage ? snapshot.threadUsage : snapshot.tokenCount;
      if (observed && observed.totalTokens > 0) snapshot.firstObserved = { totalTokens: observed.totalTokens, observedAt: observed.updatedAt };
    }
    const limits = readLimits(body.rate_limits ?? params.rate_limits ?? params.rateLimits ?? params.rate_limits_by_limit_id ?? params.rateLimitsByLimitId);
    if (limits) {
      snapshot.limits = limits;
      accountLimits = limits;
    }
    if (eventMethod === "thread/tokenUsage/updated" && isRecord(params.rateLimits)) {
      const v2Limits = readLimits(params.rateLimits);
      if (v2Limits) snapshot.limits = v2Limits;
    }
    byThread.set(key, snapshot);
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(Object.fromEntries(Array.from(byThread.entries()).slice(-32))),
      );
    } catch {}
    render();
  });
  window.addEventListener("popstate", render);
  window.addEventListener("hashchange", render);
  window.addEventListener("message", (event) => {
    if (isRecord(event.data) && event.data.type === "navigate-to-route") {
      window.setTimeout(render, 0);
    }
  });
  new MutationObserver(() => { if (!panel?.isConnected) render(); }).observe(document.documentElement, { childList: true, subtree: true });
  refreshTimer = window.setInterval(render, 60_000);
  rateLimitTimer = window.setInterval(refreshLimits, RATE_LIMIT_REFRESH_MS);
  window.setTimeout(refreshLimits, 2_000);
  window.addEventListener("pagehide", () => {
    window.clearInterval(refreshTimer);
    window.clearInterval(rateLimitTimer);
  }, { once: true });
  render();
}
