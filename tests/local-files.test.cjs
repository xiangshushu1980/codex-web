const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const Fastify = require("fastify");
const ts = require("typescript");
const {
  registerLocalFiles,
  resolveLocalPath,
  fileViewUrl,
} = require("../src/server/local-files.js");
let app, root, textPath, localFileUrl;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-files-test-"));
  textPath = path.join(root, "中文 空格 # % ?.md");
  await fs.writeFile(
    textPath,
    "first\n<script>window.pwned=true</script>\nthird",
  );
  await fs.writeFile(
    path.join(root, "binary.docx"),
    Buffer.from([0x50, 0x4b, 0, 0xff]),
  );
  await fs.writeFile(path.join(root, "clip.mp4"), "0123456789");
  await fs.writeFile(path.join(root, "empty"), "");
  await fs.writeFile(
    path.join(root, "large.txt"),
    "x".repeat(2 * 1024 * 1024 + 1),
  );
  await fs.mkdir(path.join(root, "folder"));
  await fs.symlink(textPath, path.join(root, "alias.md"));
  app = Fastify();
  registerLocalFiles(app);
  await app.ready();
  const code = ts.transpileModule(
    await fs.readFile(
      path.join(__dirname, "../src/browser/local-files.ts"),
      "utf8",
    ),
    { compilerOptions: { module: ts.ModuleKind.ESNext } },
  ).outputText;
  ({ localFileUrl } = await import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  ));
});
after(async () => {
  await app?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});
const content = (file, extra = "") =>
  `/__backend/files/content?${new URLSearchParams({ path: file })}${extra}`;
test("path mapping: Linux, drive, URI, relative, WSL UNC", () => {
  assert.equal(resolveLocalPath("/home/test/a #%.md"), "/home/test/a #%.md");
  assert.equal(
    resolveLocalPath("C:\\Users\\test\\文件.docx"),
    "/mnt/c/Users/test/文件.docx",
  );
  assert.equal(
    resolveLocalPath("file:///home/test/a%20%23%25.md"),
    "/home/test/a #%.md",
  );
  assert.equal(
    resolveLocalPath("file:///C:/Users/test/a%20b"),
    "/mnt/c/Users/test/a b",
  );
  assert.equal(resolveLocalPath("a.md", "/tmp"), "/tmp/a.md");
  const distro = process.env.WSL_DISTRO_NAME;
  process.env.WSL_DISTRO_NAME = "Ubuntu";
  try {
    assert.equal(
      resolveLocalPath("\\\\wsl.localhost\\Ubuntu\\home\\test"),
      "/home/test",
    );
    assert.equal(
      resolveLocalPath("file://wsl.localhost/Ubuntu/home/test"),
      "/home/test",
    );
    assert.throws(() => resolveLocalPath("\\\\wsl$\\Other\\home\\test"));
    assert.throws(() => resolveLocalPath("file://server/share/file"));
  } finally {
    if (distro === undefined) delete process.env.WSL_DISTRO_NAME;
    else process.env.WSL_DISTRO_NAME = distro;
  }
  assert.throws(() => resolveLocalPath(""));
  assert.throws(() => resolveLocalPath("/tmp/\0"));
});
test("browser routes preserve real filenames and parse line markers on links only", () => {
  for (const file of [textPath, "/tmp/literal:12", "/tmp/literal#L2"]) {
    assert.equal(
      new URL(localFileUrl(file), "http://localhost").searchParams.get("path"),
      file,
    );
  }
  assert.equal(
    new URL(
      localFileUrl("/tmp/a%20b.md:12:3", undefined, true),
      "http://localhost",
    ).searchParams.get("path"),
    "/tmp/a b.md",
  );
  assert.match(localFileUrl("/tmp/a.md#L3", undefined, true), /line=3#L3$/);
  assert.equal(localFileUrl("https://example.com"), null);
  assert.equal(localFileUrl("/thread/123"), null);
  assert.equal(localFileUrl("/space/123"), null);
  assert.equal(localFileUrl("/local/123", undefined, true), null);
  assert.equal(
    new URL(
      localFileUrl("/@fs/tmp/100%2520.md", undefined, true),
      "http://localhost",
    ).searchParams.get("path"),
    "/tmp/100%20.md",
  );
  assert.equal(localFileUrl("/__backend/files/view"), null);
  assert.equal(
    new URL(
      localFileUrl("/@fs/home/test/a%20b"),
      "http://localhost",
    ).searchParams.get("path"),
    "/home/test/a b",
  );
});
test("text preview escapes HTML, keeps Unicode and line anchors", async () => {
  const response = await app.inject(fileViewUrl(textPath, "3"));
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /&lt;script&gt;/);
  assert.doesNotMatch(response.body, /<script>/);
  assert.match(response.body, /id="L3"/);
  assert.match(response.body, /中文/);
  assert.match(
    response.headers["content-security-policy"],
    /default-src 'none'/,
  );
});
test("directory navigation, symlinks and unsupported files", async () => {
  const listing = await app.inject(fileViewUrl(root));
  assert.match(listing.body, /folder/);
  assert.match(listing.body, /binary.docx/);
  assert.equal(
    (await app.inject(fileViewUrl(path.join(root, "alias.md")))).statusCode,
    200,
  );
  assert.match(
    (await app.inject(fileViewUrl(path.join(root, "binary.docx")))).body,
    /暂不支持网页预览/,
  );
  assert.match(
    (await app.inject(fileViewUrl(path.join(root, "large.txt")))).body,
    /超过 2 MiB/,
  );
});
test("download returns exact bytes and encoded filename", async () => {
  const response = await app.inject(content(textPath, "&download=1"));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.rawPayload, await fs.readFile(textPath));
  assert.match(
    response.headers["content-disposition"],
    /^attachment; filename\*=UTF-8''/,
  );
  assert.match(response.headers["content-disposition"], /%E4/);
});
test("media preview, suffix, open ended and invalid ranges", async () => {
  const file = path.join(root, "clip.mp4");
  assert.match((await app.inject(fileViewUrl(file))).body, /<video controls/);
  for (const [range, expected] of [
    ["bytes=2-4", "234"],
    ["bytes=-3", "789"],
    ["bytes=8-", "89"],
    ["bytes=7-100", "789"],
  ]) {
    const response = await app.inject({
      url: content(file),
      headers: { range },
    });
    assert.equal(response.statusCode, 206);
    assert.equal(response.body, expected);
    assert.equal(response.headers["content-type"], "video/mp4");
  }
  for (const range of [
    "bytes=20-",
    "bytes=4-2",
    "bytes=-",
    "bytes=0-1,5-6",
    "bytes=-0",
  ]) {
    const response = await app.inject({
      url: content(file),
      headers: { range },
    });
    assert.equal(response.statusCode, 416);
    assert.equal(response.headers["content-range"], "bytes */10");
  }
});
test("empty files, errors and special files", async () => {
  assert.equal((await app.inject(content(path.join(root, "empty")))).body, "");
  assert.equal(
    (await app.inject(fileViewUrl(path.join(root, "missing")))).statusCode,
    404,
  );
  assert.equal((await app.inject(content(root))).statusCode, 400);
  assert.equal((await app.inject(content("/dev/zero"))).statusCode, 400);
  assert.equal((await app.inject("/__backend/files/content")).statusCode, 400);
});
test("upstream openIn patch returns the file event to the requesting view", async () => {
  const vm = require("node:vm");
  const source = await fs.readFile(
    path.join(__dirname, "../scratch/asar/.vite/build/main-CqEoQDOU.js"),
    "utf8",
  );
  const start = source.indexOf("  JQ = class extends l.Pt {");
  const end = source.indexOf("\nasync function YQ", start);
  assert.ok(start > 0 && end > start);
  const context = {
    require,
    l: { Pt: class {} },
    f: { i: () => () => ({ error() {} }) },
    r: { Bi: () => false },
    QQ: () => false,
    Fr: () => null,
    ei: () => root,
    MI: (file, cwd) => path.resolve(cwd, file),
    i: { di: { stat: async (file) => fs.stat(file) } },
    C: path,
  };
  const Service = vm.runInNewContext(
    `${source.slice(start, end)}; JQ`,
    context,
  );
  const events = [],
    origin = { id: 123 };
  const service = new Service(
    {},
    { get: () => ({ hostConfig: {}, platformPath: async () => path.posix }) },
    {},
    null,
    origin,
    { sendInlineMessageForView: (view, event) => events.push({ view, event }) },
  );
  const result = await service.open({
    path: path.basename(textPath),
    cwd: root,
    line: 3,
  });
  assert.equal(result.success, true);
  assert.equal(events[0].view, origin);
  assert.equal(events[0].event.type, "codex-web-open-file");
  assert.equal(events[0].event.path, textPath);
  assert.equal(events[0].event.line, 3);
  await service.open({ path: textPath, cwd: root, target: "fileManager" });
  assert.equal(events[1].event.path, root);
});
