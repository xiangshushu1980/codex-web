const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
let createBrowserAdapter;
let copiedText;
before(async () => {
  const links = ts.transpileModule(
    await fs.readFile(
      path.join(__dirname, "../src/browser/browser-links.ts"),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const linkModule = { exports: {} };
  vm.runInNewContext(links, {
    exports: linkModule.exports,
    module: linkModule,
    URL,
  });
  const code = ts.transpileModule(
    await fs.readFile(
      path.join(__dirname, "../src/browser/native-browser.ts"),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    exports: module.exports,
    module,
    require: () => linkModule.exports,
    URL,
    Map,
    Symbol,
    queueMicrotask,
    window: { location: { href: "http://localhost:8214/thread/test" } },
    navigator: {
      clipboard: {
        writeText: (text) => {
          copiedText = text;
          return Promise.resolve();
        },
      },
    },
  });
  ({ createBrowserAdapter } = module.exports);
});
test("native services retain other RPC services and provide disposable registrations", async () => {
  const adapter = createBrowserAdapter(() => {});
  const existing = { appServer: { token: 1 } };
  const services = adapter.adaptServices(existing);
  assert.equal(services.appServer, existing.appServer);
  assert.equal(await services.browserHost.registerWebviewHostSession(), true);
  const registration = services.browserHost.registerAnnotationButton();
  assert.equal(typeof registration[Symbol.dispose], "function");
  registration[Symbol.dispose]();
  await registration.updateBounds({});
});
test("native services route clipboard writes through the browser clipboard", async () => {
  const adapter = createBrowserAdapter(() => {});
  const rpcCalls = [];
  const existing = {
    clipboard: {
      readText: () => {
        rpcCalls.push("readText");
        return Promise.resolve("from-rpc");
      },
    },
  };
  const services = adapter.adaptServices(existing);
  await services.clipboard.writeText("copy me");
  assert.equal(copiedText, "copy me");
  assert.equal(await services.clipboard.readText(), "from-rpc");
  assert.deepEqual(rpcCalls, ["readText"]);
});
test("attachFrame makes an in-tree iframe the command target", () => {
  const events = [];
  const adapter = createBrowserAdapter((e) => events.push(e));
  const route = { conversationId: "chat1", browserTabId: "page1" };
  adapter.open({ ...route, url: "file:///tmp/one.html" });
  let reloaded = 0;
  const frame = {
    addEventListener() {},
    contentDocument: undefined,
    contentWindow: {
      location: {
        reload: () => {
          reloaded++;
        },
      },
    },
  };
  adapter.attachFrame({ ...route, frame });
  // Registering the same frame again must not re-wire listeners.
  adapter.attachFrame({ ...route, frame });
  adapter.handle({
    type: "browser-sidebar-command",
    ...route,
    command: { type: "reload" },
  });
  assert.equal(reloaded, 1);
});
test("browser commands and history stay scoped to the correct chat and tab", () => {
  const events = [];
  const adapter = createBrowserAdapter((e) => events.push(e));
  const route = { conversationId: "chat1", browserTabId: "page1" };
  adapter.open({ ...route, url: "file:///tmp/one.html" });
  adapter.open({
    conversationId: "chat2",
    browserTabId: "page1",
    url: "file:///tmp/other.html",
  });
  const send = (command) =>
    adapter.handle({ type: "browser-sidebar-command", ...route, command });
  send({ type: "navigate", url: "file:///tmp/two.html" });
  assert.equal(events.at(-1).snapshot.canGoBack, true);
  send({ type: "go-back" });
  assert.equal(
    events.at(-1).snapshot.url,
    "http://localhost:8214/@fs/tmp/one.html",
  );
  assert.equal(events.at(-1).snapshot.canGoForward, true);
  send({ type: "go-forward" });
  assert.equal(
    events.at(-1).snapshot.url,
    "http://localhost:8214/@fs/tmp/two.html",
  );
  send({ type: "set-interaction-mode", interactionMode: "comment" });
  assert.equal(events.at(-1).snapshot.interactionMode, "comment");
  const other = events.filter((e) => e.conversationId === "chat2");
  assert.equal(other.length, 1);
  assert.equal(other[0].snapshot.interactionMode, "browse");
  assert.equal(
    adapter.handle({
      type: "browser-sidebar-command",
      conversationId: "unknown",
      browserTabId: "page1",
      command: { type: "reload" },
    }),
    false,
  );
  send({ type: "close-tab" });
  assert.equal(send({ type: "reload" }), false);
});
