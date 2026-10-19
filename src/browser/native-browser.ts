import { toBrowserUrl, openBrowserLink } from "./browser-links";

type RecordValue = Record<string, any>;
type Page = {
  conversationId: string;
  browserTabId: string;
  frame?: HTMLIFrameElement;
  url: string;
  history: string[];
  index: number;
  mode: string;
  title: string;
  selected?: Element;
  clearHighlight?: () => void;
  overlay?: HTMLElement;
  suspended?: boolean;
};

export function createBrowserAdapter(emit: (message: RecordValue) => void) {
  const pages = new Map<string, Page>();
  const key = (p: RecordValue) => `${p.conversationId}\0${p.browserTabId}`;
  function page(p: RecordValue): Page {
    const id = key(p);
    let value = pages.get(id);
    if (!value) {
      value = {
        conversationId: p.conversationId,
        browserTabId: p.browserTabId,
        url: "",
        history: [],
        index: -1,
        mode: "browse",
        title: "",
      };
      pages.set(id, value);
    }
    return value;
  }
  function snapshot(p: Page, loading = false) {
    emit({
      type: "browser-sidebar-state",
      conversationId: p.conversationId,
      browserTabId: p.browserTabId,
      snapshot: {
        annotationFlow: "batch",
        annotationModeEntrySource: null,
        tabType: "web",
        isSuspended: false,
        title: p.title,
        url: p.url,
        committedUrl: p.url,
        faviconUrl: null,
        securityState: null,
        isAudible: false,
        isAudioMuted: false,
        isCapturingUserMedia: false,
        isCapturingCamera: false,
        isCapturingMicrophone: false,
        isLoading: loading,
        isWaitingForResponse: loading,
        canGoBack: p.index > 0,
        canGoForward: p.index < p.history.length - 1,
        zoomPercent: 100,
        commentModeDisabledReason: null,
        interactionMode: p.mode,
        comments: [],
        siteToolsAvailability: {
          webMcp: "unavailable",
          annotations: "unavailable",
        },
        webMcpToolsRevision: 0,
        lastWebMcpToolCall: null,
      },
    });
  }
  function navigate(p: Page, input: string, remember = true) {
    p.url = toBrowserUrl(input, window.location.href);
    if (remember) {
      p.history.splice(p.index + 1);
      p.history.push(p.url);
      p.index = p.history.length - 1;
    }
    snapshot(p, true);
    if (p.frame) p.frame.src = p.url;
  }
  function bindDocument(p: Page) {
    const frame = p.frame;
    if (!frame) return;
    try {
      const doc = frame.contentDocument;
      if (!doc) throw new Error("此页面不允许选择元素，请在外部浏览器打开。");
      const loadedUrl = frame.contentWindow!.location.href;
      if (loadedUrl !== p.url) {
        p.history.splice(p.index + 1);
        p.history.push(loadedUrl);
        p.index = p.history.length - 1;
      }
      p.title = doc.title || new URL(p.url).pathname.split("/").pop() || "网页";
      p.url = frame.contentWindow!.location.href;
      let previous: HTMLElement | undefined;
      let outline = "";
      const clear = () => {
        if (previous) previous.style.outline = outline;
        previous = undefined;
      };
      p.clearHighlight = clear;
      doc.addEventListener(
        "keydown",
        (event) => {
          if (event.code === "Space") p.suspended = true;
          if (event.key === "Escape") {
            p.mode = "browse";
            clear();
            p.overlay?.remove();
            snapshot(p);
          }
        },
        true,
      );
      doc.addEventListener(
        "keyup",
        (event) => {
          if (event.code === "Space") p.suspended = false;
        },
        true,
      );
      doc.addEventListener(
        "pointermove",
        (event) => {
          if (
            p.mode === "browse" ||
            p.suspended ||
            !(
              event.target &&
              (event.target as Element).nodeType === 1 &&
              "style" in event.target
            )
          )
            return;
          clear();
          previous = event.target as HTMLElement;
          outline = previous.style.outline;
          previous.style.outline = "2px solid #4f8cff";
        },
        true,
      );
      doc.addEventListener(
        "click",
        (event) => {
          if (p.mode === "browse" || p.suspended) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          clear();
          const element = event.target as Element;
          if (!element?.tagName) return;
          p.selected = element;
          const selector = element.id
            ? `#${CSS.escape(element.id)}`
            : element.tagName.toLowerCase() +
              [...element.classList]
                .slice(0, 3)
                .map((c) => `.${CSS.escape(c)}`)
                .join("");
          const text = (
            element.textContent ||
            element.getAttribute("aria-label") ||
            ""
          )
            .trim()
            .slice(0, 500);
          showAnnotation(p, selector, text, element.outerHTML.slice(0, 1500));
        },
        true,
      );
    } catch {
      /* Cross-origin pages keep browsing; element selection is unavailable. */
    }
    snapshot(p);
  }
  function showAnnotation(
    p: Page,
    selector: string,
    text: string,
    html: string,
  ) {
    p.overlay?.remove();
    const form = document.createElement("form");
    form.setAttribute("aria-label", "网页元素批注");
    Object.assign(form.style, {
      position: "fixed",
      right: "20px",
      bottom: "30px",
      width: "min(360px, 90vw)",
      zIndex: "2147483647",
      padding: "14px",
      borderRadius: "10px",
      border: "1px solid #888",
      boxShadow: "0 6px 25px #0005",
      background: "Canvas",
      color: "CanvasText",
      font: "14px system-ui",
    });
    const title = document.createElement("strong");
    title.textContent = selector;
    const detail = document.createElement("p");
    detail.textContent = text.slice(0, 150);
    detail.style.overflowWrap = "anywhere";
    const input = document.createElement("textarea");
    input.placeholder = "对这个元素提问或描述要修改的内容";
    input.setAttribute("aria-label", "批注内容");
    input.rows = 3;
    input.style.cssText = "width:100%;box-sizing:border-box;margin:8px 0";
    const add = document.createElement("button");
    add.type = "submit";
    add.textContent = "加入输入框";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    cancel.style.marginLeft = "8px";
    cancel.onclick = () => form.remove();
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    form.append(title, detail, input, add, cancel, status);
    form.onsubmit = (event) => {
      event.preventDefault();
      const editors = [
        ...document.querySelectorAll<HTMLElement>(
          '[contenteditable="true"][role="textbox"], .tiptap[contenteditable="true"], .ProseMirror[contenteditable="true"]',
        ),
      ];
      const editor = editors.find(
        (e) =>
          e.getBoundingClientRect().height > 0 &&
          !e.closest('[role="tabpanel"]'),
      );
      if (!editor) {
        status.textContent = "未找到聊天输入框，请先返回当前聊天。";
        return;
      }
      const parsed = new URL(p.url);
      const file = parsed.pathname.startsWith("/@fs/")
        ? decodeURIComponent(parsed.pathname.slice(4))
        : p.url;
      const prompt = `\n[网页元素批注]\n页面：${file}\n元素：${selector}\n文字：${text}\nHTML：${html}\n要求：${input.value.trim()}\n`;
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      if (!document.execCommand("insertText", false, prompt)) {
        status.textContent = "无法加入输入框，请复制批注内容。";
        return;
      }
      form.remove();
      p.mode = "browse";
      p.clearHighlight?.();
      snapshot(p);
    };
    document.body.append(form);
    p.overlay = form;
    input.focus();
  }
  const browserHost = new Proxy(
    {
      async registerWebviewHostSession() {
        return true;
      },
      async registerWebviewHost() {
        return true;
      },
      async syncView(p: RecordValue) {
        const value = page(p);
        if (
          value.frame &&
          value.frame.dataset.attached !== String(p.mountGeneration)
        ) {
          value.frame.dataset.attached = String(p.mountGeneration);
          queueMicrotask(() =>
            emit({
              type: "browser-sidebar-webview-attached",
              conversationId: p.conversationId,
              browserTabId: p.browserTabId,
              mountGeneration: p.mountGeneration,
            }),
          );
        }
      },
      async setAnnotationPresentation(p: RecordValue) {
        if (p.suspended != null) page(p).suspended = p.suspended;
      },
      registerAnnotationButton() {
        return { async updateBounds() {}, [Symbol.dispose]() {} };
      },
    } as RecordValue,
    {
      get(target, property) {
        if (property === "then") return undefined;
        return target[property as string] ?? (async () => undefined);
      },
    },
  );
  return {
    adaptServices(services: RecordValue) {
      // Code-block "copy" calls appServices.clipboard.writeText, an RPC that
      // reaches the headless Codex app-server (no OS clipboard on the WSL
      // backend), so it rejects and the app shows "Couldn't copy to clipboard".
      // Route clipboard writes through the browser clipboard instead; the shim
      // already patches navigator.clipboard.writeText with an execCommand
      // fallback for focus/permission edge cases. Other clipboard methods keep
      // delegating to the original RPC service.
      const originalClipboard = services.clipboard;
      const clipboard = new Proxy(originalClipboard ?? {}, {
        get(target, property, receiver) {
          if (property === "writeText") {
            return (text: unknown) =>
              navigator.clipboard.writeText(String(text ?? ""));
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return { ...services, browserHost, clipboard };
    },
    open(p: RecordValue) {
      const value = page(p);
      navigate(value, p.url);
    },
    createWebview(p: RecordValue) {
      const value = page(p);
      const frame = document.createElement("iframe");
      frame.title = "Codex 浏览器";
      frame.style.border = "0";
      frame.allow = "autoplay; fullscreen; clipboard-write";
      value.frame = frame;
      const original = frame.setAttribute.bind(frame);
      frame.setAttribute = (name, content) => {
        if (name === "src" && content.startsWith("about:blank")) {
          if (value.url) original("src", value.url);
          return;
        }
        original(name, content);
      };
      Object.assign(frame, {
        getWebContentsId: () => 0,
        getURL: () => value.url,
        loadURL: (url: string) => navigate(value, url),
        setAudioMuted() {},
      });
      frame.addEventListener("load", () => bindDocument(value));
      if (value.url) frame.src = value.url;
      return frame;
    },
    handle(message: RecordValue) {
      if (
        message.type !== "browser-sidebar-command" ||
        !pages.has(key(message))
      )
        return false;
      const value = page(message),
        command = message.command;
      switch (command.type) {
        case "navigate":
          navigate(value, command.url);
          break;
        case "reload":
          value.frame?.contentWindow?.location.reload();
          break;
        case "go-back":
          if (value.index > 0) {
            value.index--;
            navigate(value, value.history[value.index]!, false);
          }
          break;
        case "go-forward":
          if (value.index < value.history.length - 1) {
            value.index++;
            navigate(value, value.history[value.index]!, false);
          }
          break;
        case "set-interaction-mode":
          value.mode = command.interactionMode;
          value.clearHighlight?.();
          snapshot(value);
          break;
        case "close-tab":
          value.frame?.remove();
          value.overlay?.remove();
          pages.delete(key(message));
          break;
        case "print":
          value.frame?.contentWindow?.print();
          break;
        case "open-external":
        case "open-in-browser":
          openBrowserLink(value.url);
          break;
        case "stop":
          value.frame?.contentWindow?.stop();
          snapshot(value);
          break;
        case "capture-screenshot":
          emit({
            type: "browser-sidebar-screenshot-copy-failed",
            conversationId: value.conversationId,
            browserTabId: value.browserTabId,
          });
          break;
        default:
          break;
      }
      return true;
    },
  };
}
