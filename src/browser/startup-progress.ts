type StartupEntry = { at: number; event: string; label: string };
type SuspenseEvent = { name: string; event: string; at: number };
type StartupReport = {
  version: number;
  navigationStart: number;
  loadNumber: number;
  navigationType: string;
  status: string;
  entries: StartupEntry[];
  placeholderMounts: number;
  completedAt?: number;
};

const phases: Record<string, string> = {
  renderer_entry: "初始化应用",
  route_prefetch_start: "加载主界面模块",
  react_root_requested: "准备界面",
  startup_metadata_gate_pending: "读取账户及应用信息",
  startup_metadata_gate_resolved: "账户及应用信息已就绪",
  statsig_bootstrap_race_started: "请求远程功能配置",
  statsig_bootstrap_headers_received: "接收远程功能配置正文",
  statsig_bootstrap_race_resolved: "远程功能配置接收完成",
  statsig_bootstrap_payload_parsed: "功能配置解析完成",
  post_login_statsig_initialize_sync_success: "功能配置已就绪，准备主界面",
  statsig_bootstrap_race_timed_out: "功能配置超时，准备备用初始化",
  statsig_bootstrap_race_timed_out_headers: "配置响应超时，准备备用初始化",
  statsig_bootstrap_race_timed_out_body: "配置正文超时，准备备用初始化",
  statsig_client_async_init_pending: "等待备用功能配置初始化",
  statsig_client_async_init_resolved: "备用配置已就绪，准备主界面",
  app_routes_mounted: "界面已挂载，等待首屏就绪信号",
  renderer_phase_first_content_visible: "首屏已就绪",
  first_content_boundary_rendered: "首屏已就绪",
};
const gates: Record<string, string> = {
  Startup: "等待应用启动",
  PersistedStateProvider: "读取本地状态",
  SettingsPreloadGate: "读取设置",
  "CodexStatsigProvider.sync": "等待远程功能配置",
  "CodexStatsigProvider.async": "等待备用功能配置初始化",
  "CodexStatsigProvider.async.identity": "读取账户身份",
  "CodexStatsigProvider.async.update": "更新账户功能配置",
};
const storageKey = "codex-web:startup-report";

export function createStartupProgress() {
  // An explicit per-navigation switch is useful when comparing profiling overhead.
  if (new URLSearchParams(location.search).get("startup") === "off") {
    return { log(_message: unknown) {}, connection(_event: string) {} };
  }
  let previous: StartupReport | undefined;
  try {
    previous =
      JSON.parse(sessionStorage.getItem(storageKey) || "null") ?? undefined;
  } catch {}
  const report: StartupReport = {
    version: 1,
    navigationStart: performance.timeOrigin,
    loadNumber:
      previous?.version === 1 &&
      performance.timeOrigin - previous.navigationStart < 600_000
        ? previous.loadNumber + 1
        : 1,
    navigationType:
      (
        performance.getEntriesByType("navigation")[0] as
          | PerformanceNavigationTiming
          | undefined
      )?.type ?? "unknown",
    status: "loading",
    entries: [],
    placeholderMounts: 0,
  };
  let stage = "加载页面脚本",
    stageAt = 0,
    panel: HTMLDetailsElement | undefined;
  let summary: HTMLElement,
    current: HTMLElement,
    clock: HTMLElement,
    history: HTMLElement;
  let suspenseArray: SuspenseEvent[] | undefined,
    suspenseCursor = 0;
  const seconds = (ms: number) => (Math.max(0, ms) / 1000).toFixed(1) + " 秒";
  const save = () => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(report));
    } catch {}
  };
  // Local diagnostic access; no account data, paths, tokens or request bodies.
  Object.assign(window, { __codexStartupReport: report });
  function render() {
    if (!panel) return;
    const end = report.completedAt ?? performance.now();
    summary.textContent =
      report.completedAt == null
        ? `正在启动 · ${seconds(end)}`
        : `启动完成 · ${seconds(end)}`;
    current.textContent = stage;
    clock.textContent = `本阶段 ${seconds(end - stageAt)} · 本标签页第 ${report.loadNumber} 次加载 · 占位出现 ${report.placeholderMounts} 次`;
  }
  function record(
    event: string,
    label: string,
    at = performance.now(),
    changeStage = true,
  ) {
    if (report.completedAt != null) return;
    if (report.entries.some((e) => e.event === event && e.at === at)) return;
    if (report.entries.length < 120)
      report.entries.push({ event, label, at: Math.round(at) });
    if (changeStage && at >= stageAt) {
      stage = label;
      stageAt = at;
    }
    save();
    render();
    if (history) {
      history.textContent = report.entries
        .slice()
        .sort((a, b) => a.at - b.at)
        .slice(-12)
        .map((e) => `${seconds(e.at)}  ${e.label}`)
        .join("\n");
    }
  }
  function mount() {
    panel = document.createElement("details");
    panel.id = "codex-startup-progress";
    panel.open = true;
    panel.addEventListener("toggle", () => {
      if (panel)
        panel.style.width = panel.open
          ? "min(360px, calc(100vw - 24px))"
          : "auto";
    });
    Object.assign(panel.style, {
      position: "fixed",
      right: "12px",
      bottom: "12px",
      zIndex: "2147483646",
      width: "min(360px, calc(100vw - 24px))",
      boxSizing: "border-box",
      padding: "10px 12px",
      border: "1px solid #8886",
      borderRadius: "10px",
      background: "#202123",
      color: "#eee",
      font: "12px/1.5 system-ui, sans-serif",
      boxShadow: "0 3px 16px #0003",
      textAlign: "left",
    });
    summary = document.createElement("summary");
    summary.style.cursor = "pointer";
    current = document.createElement("div");
    current.style.marginTop = "8px";
    current.setAttribute("role", "status");
    clock = document.createElement("div");
    clock.style.color = "#bbb";
    history = document.createElement("pre");
    Object.assign(history.style, {
      whiteSpace: "pre-wrap",
      maxHeight: "180px",
      overflow: "auto",
      font: "inherit",
      color: "#bbb",
    });
    const copy = document.createElement("button");
    copy.textContent = "复制启动诊断";
    copy.type = "button";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(
          JSON.stringify(
            {
              ...report,
              elapsedMs: Math.round(report.completedAt ?? performance.now()),
              previous: previous?.version === 1 ? previous : undefined,
            },
            null,
            2,
          ),
        );
        copy.textContent = "已复制";
      } catch {
        copy.textContent = "复制失败，可从控制台读取 __codexStartupReport";
      }
    });
    panel.append(summary, current, clock, history, copy);
    document.body.append(panel);
    record(
      "navigation",
      previous?.status === "reloading-after-reconnect"
        ? "服务连接恢复后重新加载页面"
        : report.navigationType === "reload"
          ? "页面刷新"
          : "打开页面",
      0,
      false,
    );
    record("preload", "页面适配脚本已加载", performance.now(), false);
    render();
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
  function readPlaceholders() {
    const events = (
      window as unknown as { __codexStartupSuspenseEvents?: SuspenseEvent[] }
    ).__codexStartupSuspenseEvents;
    if (events !== suspenseArray) {
      suspenseArray = events;
      suspenseCursor = 0;
    }
    for (; events && suspenseCursor < events.length; suspenseCursor++) {
      const e = events[suspenseCursor];
      if (e.event === "mounted") report.placeholderMounts++;
      const name = gates[e.name] ?? "等待界面资源";
      record(
        `placeholder:${e.event}:${e.name}`,
        `${name}${e.event === "cleared" ? "：占位结束" : "：显示占位"}`,
        e.at,
        e.event === "mounted",
      );
    }
  }
  const timer = window.setInterval(() => {
    readPlaceholders();
    render();
  }, 250);
  function finish(at: number) {
    // Drain pending placeholder events before ending observation.
    readPlaceholders();
    report.completedAt = at;
    report.status = "ready";
    clearInterval(timer);
    save();
    render();
    if (panel) panel.open = false;
  }
  window.addEventListener(
    "pagehide",
    () => {
      clearInterval(timer);
      save();
    },
    { once: true },
  );
  save();
  return {
    log(message: unknown) {
      if (report.completedAt != null) return;
      if (typeof message !== "object" || message === null) return;
      const m = message as { type?: unknown; message?: unknown };
      if (m.type !== "log-message" || typeof m.message !== "string") return;
      const match = /^\[startup\]\[trace\] (\S+).*? at (\d+)ms/.exec(m.message);
      if (!match) return;
      const phase = match[1],
        label = phases[phase];
      if (!label) return;
      record(phase, label, Number(match[2]));
      if (
        phase === "renderer_phase_first_content_visible" ||
        phase === "first_content_boundary_rendered"
      )
        finish(Number(match[2]));
    },
    connection(event: string) {
      const labels: Record<string, string> = {
        open: "浏览器与服务已连接",
        close: "服务连接断开，等待重连",
        reload: "服务连接已恢复，需要重新加载页面",
      };
      if (event === "reload") report.status = "reloading-after-reconnect";
      record(
        `connection:${event}`,
        labels[event] ?? "正在连接服务",
        performance.now(),
        event !== "open",
      );
      save();
    },
  };
}
