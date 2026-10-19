const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { promisify } = require("node:util");
const ts = require("typescript");
const {
  normalizeWindowsPath,
  explorerArguments,
} = require("../src/server/electron/shell.js");
let root, file, code;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-explorer-test-"));
  file = path.join(root, "中文 空格 # %,test.html");
  await fs.writeFile(file, "<html>test</html>");
  code = ts.transpileModule(
    await fs.readFile(
      path.join(__dirname, "../src/server/electron/shell.ts"),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    },
  ).outputText;
});
after(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});
function shellFixture({ failLaunch = false, failConversion = false } = {}) {
  const calls = [];
  const execFile = () => {};
  execFile[promisify.custom] = async (command, args) => {
    calls.push({ command, args });
    if (failConversion) throw new Error("wslpath failed");
    return {
      stdout:
        args[0] === "-u"
          ? `${file}\n`
          : `\\\\\\\\wsl.localhost\\\\Ubuntu\\\\tmp\\\\中文 空格 # %,test.html\n`,
      stderr: "",
    };
  };
  const fakeProcess = { platform: "linux", env: {} };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    URL,
    exports: module.exports,
    module,
    process: fakeProcess,
    console,
    require: (name) => {
      if (name === "node:child_process")
        return {
          execFile,
          spawn: (command, args, options) => {
            calls.push({ command, args, options });
            const child = new EventEmitter();
            child.unref = () => {};
            queueMicrotask(() =>
              child.emit(
                failLaunch ? "error" : "spawn",
                new Error("launch failed"),
              ),
            );
            return child;
          },
        };
      if (name === "node:fs")
        return {
          existsSync: () => true,
          readdirSync: () => ["c"],
          readFileSync: () => "Linux microsoft WSL2",
        };
      return require(name);
    },
  });
  return { ...module.exports, calls };
}
test("canonical UNC and drive paths; preserve spaces, Unicode and punctuation", () => {
  assert.equal(
    normalizeWindowsPath(
      "\\\\\\\\wsl.localhost\\\\Ubuntu\\\\home\\\\sean\\\\a b.csv\n",
    ),
    "\\\\wsl.localhost\\Ubuntu\\home\\sean\\a b.csv",
  );
  assert.equal(
    normalizeWindowsPath("C:\\\\Users\\\\中文 # %,a.html"),
    "C:\\Users\\中文 # %,a.html",
  );
  assert.throws(() => normalizeWindowsPath("relative.txt"));
  assert.throws(() => normalizeWindowsPath("C:\\bad\0"));
});
test("file selection uses distinct argv without shell interpolation; directories open directly", () => {
  const target = "\\\\wsl.localhost\\Ubuntu\\home\\a b # %,test.csv";
  assert.deepEqual(explorerArguments(target, false), ["/select,", target]);
  assert.deepEqual(explorerArguments("C:\\Users\\test", true), [
    "C:\\Users\\test",
  ]);
});
test("both Open and Reveal invoke Explorer and select an existing file", async () => {
  const fixture = shellFixture();
  assert.equal(await fixture.shell.openPath(file), "");
  assert.equal(typeof fixture.shell.showItemInFolder, "function");
  const launch = fixture.calls.find((call) =>
    call.command.endsWith("explorer.exe"),
  );
  assert.equal(launch.args[0], "/select,");
  assert.equal(
    launch.args[1],
    "\\\\wsl.localhost\\Ubuntu\\tmp\\中文 空格 # %,test.html",
  );
  assert.equal(launch.options.cwd, "/mnt/c");
  assert.equal(launch.options.stdio, "ignore");
  assert.equal(launch.options.shell, undefined);
  fixture.shell.showItemInFolder(file);
  for (
    let i = 0;
    i < 20 &&
    fixture.calls.filter((call) => call.command.endsWith("explorer.exe"))
      .length < 2;
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    fixture.calls.filter((call) => call.command.endsWith("explorer.exe"))
      .length,
    2,
  );
});
test("an existing directory opens without /select", async () => {
  const fixture = shellFixture();
  assert.equal(await fixture.revealInFileManager(root), "");
  const launch = fixture.calls.find((call) =>
    call.command.endsWith("explorer.exe"),
  );
  assert.equal(launch.args.length, 1);
  assert.ok(!launch.args[0].startsWith("/select"));
});
test("file URI, Windows drive, UNC and literal Linux filenames resolve", async () => {
  const fixture = shellFixture();
  assert.equal(await fixture.resolveHostPath(file), file);
  assert.equal(
    await fixture.resolveHostPath(
      `file://${encodeURI(file).replaceAll("#", "%23")}`,
    ),
    file,
  );
  assert.equal(await fixture.resolveHostPath("C:\\Users\\test.html"), file);
  assert.equal(
    await fixture.resolveHostPath("\\\\wsl.localhost\\Ubuntu\\tmp\\test.html"),
    file,
  );
  assert.equal(fixture.calls.filter((call) => call.args[0] === "-u").length, 2);
});
test("invalid, missing and device paths produce errors and never launch", async () => {
  const fixture = shellFixture();
  assert.notEqual(await fixture.revealInFileManager(""), "");
  assert.notEqual(await fixture.revealInFileManager("/tmp/a\0b"), "");
  assert.notEqual(
    await fixture.revealInFileManager(path.join(root, "missing")),
    "",
  );
  assert.notEqual(await fixture.revealInFileManager("/dev/zero"), "");
  assert.equal(fixture.calls.length, 0);
});
test("conversion and launch failures propagate through openPath", async () => {
  assert.match(
    await shellFixture({ failConversion: true }).shell.openPath(file),
    /wslpath failed/,
  );
  assert.match(
    await shellFixture({ failLaunch: true }).shell.openPath(file),
    /launch failed/,
  );
});
test("upstream default/fileManager opens use the shell; explicit editor and remote routing remain upstream", async () => {
  const source = await fs.readFile(
    path.join(__dirname, "../scratch/asar/.vite/build/main-CqEoQDOU.js"),
    "utf8",
  );
  const start = source.indexOf("  JQ = class extends l.Pt {");
  const end = source.indexOf("\nasync function YQ", start);
  assert.ok(start > 0 && end > start);
  const calls = [];
  const context = {
    l: { Pt: class {} },
    f: { i: () => () => ({ error() {} }) },
    r: { Bi: (host) => host.remote },
    QQ: () => false,
    Fr: () => null,
    ei: () => root,
    MI: (file, cwd) => path.resolve(cwd, file),
    i: { di: { stat: async (file) => fs.stat(file) }, p: () => false },
    _: {
      shell: {
        openPath: async (file) => {
          calls.push(file);
          return "";
        },
      },
    },
  };
  context.require = (name) => {
    assert.equal(name, "electron");
    return context._;
  };
  const Service = vm.runInNewContext(`${source.slice(start, end)};JQ`, context);
  const service = new Service(
    {},
    {
      get: () => ({
        hostConfig: { remote: false },
        platformPath: async () => path.posix,
      }),
    },
    {},
    null,
    {},
    {},
  );
  for (const target of [undefined, "fileManager", "systemDefault"]) {
    assert.equal(
      (await service.open({ path: path.basename(file), cwd: root, target }))
        .success,
      true,
    );
  }
  assert.deepEqual(calls, [file, file, file]);
  await service.open({ path: file, cwd: root, target: "vscode" });
  assert.equal(calls.length, 3);
  const remote = new Service(
    {},
    {
      get: () => ({
        hostConfig: { remote: true },
        platformPath: async () => path.posix,
      }),
    },
    {},
    null,
    {},
    {},
  );
  await remote.open({ path: file, cwd: root });
  assert.equal(calls.length, 3);
  context._.shell.openPath = async () => "cannot launch";
  assert.equal((await service.open({ path: file, cwd: root })).success, false);
});
test("browser HTML links reuse /@fs and retain encoding, relative assets and anchors", async () => {
  const source = await fs.readFile(
    path.join(__dirname, "../src/browser/browser-links.ts"),
    "utf8",
  );
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext },
  }).outputText;
  const { toBrowserUrl } = await import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
  const base = "http://localhost:8214/thread/test";
  assert.equal(
    toBrowserUrl("file:///home/test/a%20b%23%25.html#chart", base),
    "http://localhost:8214/@fs/home/test/a%20b%23%25.html#chart",
  );
  assert.equal(
    toBrowserUrl("file:///C:/Users/test/a%20b.html", base),
    "http://localhost:8214/@fs/mnt/c/Users/test/a%20b.html",
  );
  assert.equal(
    toBrowserUrl("https://example.com/test", base),
    "https://example.com/test",
  );
  assert.throws(() => toBrowserUrl("file://other-host/share/test.html", base));
});
test("existing /@fs serves encoded filenames, real HTML, relative media and byte ranges", async () => {
  const Fastify = require("fastify");
  const staticPlugin = require("@fastify/static");
  const { registerHostFileRoutes } = require("../src/server/host-files.js");
  const app = Fastify();
  await app.register(staticPlugin, { root, serve: false });
  registerHostFileRoutes(app);
  try {
    const html = await app.inject(
      "/@fs" + file.split("/").map(encodeURIComponent).join("/"),
    );
    assert.equal(html.statusCode, 200);
    assert.match(html.headers["content-type"], /text\/html/);
    assert.equal(html.body, "<html>test</html>");
    await fs.mkdir(path.join(root, ".hidden"));
    await fs.writeFile(path.join(root, ".hidden", "video.mp4"), "0123456789");
    const media = await app.inject({
      url: "/@fs" + path.join(root, ".hidden", "video.mp4"),
      headers: { range: "bytes=2-4" },
    });
    assert.equal(media.statusCode, 206);
    assert.equal(media.body, "234");
    assert.equal(media.headers["content-range"], "bytes 2-4/10");
    assert.equal(
      (await app.inject("/@fs" + root + "/missing.html")).statusCode,
      404,
    );
    assert.equal((await app.inject("/@fs/tmp/a%00b")).statusCode, 400);
  } finally {
    await app.close();
  }
});
test("plain local HTML opens in the existing sidebar; explicit targets and source locations bypass it", async () => {
  const source = await fs.readFile(
    path.join(
      __dirname,
      "../scratch/asar/webview/assets/app-initial-6350d04672d0.js",
    ),
    "utf8",
  );
  const start = source.indexOf(
    "  if (r != null && !A && (m == null || m === `local`)",
  );
  const end = source.indexOf("  if (r != null && A && qi(T)", start);
  assert.ok(start > 0 && end > start);
  const events = [];
  const context = {
    r: {},
    A: false,
    m: "local",
    O: null,
    C: null,
    y: false,
    v: null,
    c: null,
    f: null,
    T: "/tmp/page.html",
    D: null,
    u: null,
    k: null,
    x: () => {},
    Kj() {},
    Fj() {},
    vi() {},
    uf() {},
    u7n() {},
    Zp: path.resolve,
    URL,
    encodeURIComponent,
    window: { location: { href: "http://localhost:8214/" } },
    Mj: (kind, Component, options) => ({ kind, Component, ...options }),
    Gj: (_scope, type, options) => events.push({ type, options }),
    W: () => ({ jsx: (type, props) => ({ type, props }) }),
  };
  const run = () =>
    vm.runInNewContext(`(function(){${source.slice(start, end)};})()`, context);
  run();
  assert.equal(events.length, 1);
  assert.equal(
    events[0].options.props.url,
    "http://localhost:8214/@fs/tmp/page.html",
  );
  assert.equal(
    events[0].type.Component(events[0].options.props).type,
    "iframe",
  );
  assert.equal(events[0].options.revealAndFocus, true);
  for (const field of ["O", "v", "A"]) {
    const previous = context[field];
    context[field] = field === "A" ? true : field === "v" ? 5 : "fileManager";
    run();
    assert.equal(events.length, 1);
    context[field] = previous;
  }
});
