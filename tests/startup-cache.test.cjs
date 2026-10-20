const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const moduleOutput = ts.transpileModule(
  fs.readFileSync(
    path.join(__dirname, "../src/browser/startup-cache.ts"),
    "utf8",
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const cacheModule = { exports: {} };
new Function("exports", "module", moduleOutput)(
  cacheModule.exports,
  cacheModule,
);
const { createStartupCache } = cacheModule.exports;
const scope = {
  authMethod: "chatgpt",
  userId: "user-A",
  accountId: "workspace-A",
  appVersion: "1",
  stableId: "device",
  locale: "zh-CN",
};
const value = (s = scope, time = 1) => ({
  statsigPayload: JSON.stringify({
    has_updates: true,
    time,
    user: { userID: s.userId, customIDs: { account_id: s.accountId } },
  }),
  user: { userID: s.userId, customIDs: { account_id: s.accountId } },
});
const validate = (v) => ({ ...v, user: JSON.parse(v.statsigPayload).user });
function fixture() {
  let entry,
    now = 1000,
    writes = 0,
    calls = 0;
  const tasks = [],
    events = [];
  const store = {
    read: async () => entry,
    write: async (e) => {
      entry = structuredClone(e);
      writes++;
    },
    clear: async () => {
      entry = undefined;
    },
  };
  const make = (custom = {}) =>
    createStartupCache({
      store,
      now: () => now,
      hash: async (s) => s,
      schedule: (fn) => tasks.push(fn),
      ...custom,
    });
  const fetcher = async () => {
    calls++;
    return value();
  };
  return {
    make,
    store,
    tasks,
    events,
    fetcher,
    trace: (e) => events.push(e),
    get entry() {
      return entry;
    },
    set entry(e) {
      entry = e;
    },
    get calls() {
      return calls;
    },
    get writes() {
      return writes;
    },
    advance(ms) {
      now += ms;
    },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a fresh persisted bootstrap serves a new page without any network request", async () => {
  const f = fixture();
  await f.make().load(scope, f.fetcher, validate, f.trace);
  const warm = await f.make().load(
    scope,
    () => {
      throw Error("must not fetch");
    },
    validate,
    f.trace,
  );
  assert.equal(warm.user.userID, scope.userId);
  assert.equal(f.calls, 1);
  assert.equal(f.tasks.length, 0);
  assert.ok(f.events.includes("statsig_cache_hit_fresh"));
});
test("stale data returns immediately; scheduled refresh updates the next navigation", async () => {
  const f = fixture();
  await f.make().load(scope, f.fetcher, validate, f.trace);
  f.advance(11 * 60_000);
  let calls = 0;
  const cached = await f.make().load(
    scope,
    async (background) => {
      assert.equal(background, true);
      calls++;
      return value(scope, 2);
    },
    validate,
    f.trace,
  );
  assert.equal(JSON.parse(cached.statsigPayload).time, 1);
  assert.equal(calls, 0);
  assert.equal(f.tasks.length, 1);
  await f.tasks[0]();
  assert.equal(calls, 1);
  const next = await f.make().load(
    scope,
    () => {
      throw Error("must not fetch");
    },
    validate,
    f.trace,
  );
  assert.equal(JSON.parse(next.statsigPayload).time, 2);
});
test("data older than one hour never bypasses the foreground fetch", async () => {
  const f = fixture();
  await f.make().load(scope, f.fetcher, validate, f.trace);
  f.advance(61 * 60_000);
  await assert.rejects(
    f.make().load(
      scope,
      async () => {
        throw Error("offline");
      },
      validate,
      f.trace,
    ),
    /offline/,
  );
  assert.ok(f.events.includes("statsig_cache_expired"));
});
test("account, workspace, version, locale and stable ID each isolate cache entries", async () => {
  for (const [field, replacement] of [
    ["userId", "B"],
    ["accountId", "B"],
    ["appVersion", "2"],
    ["locale", "en"],
    ["stableId", "other"],
  ]) {
    const f = fixture();
    await f.make().load(scope, f.fetcher, validate, f.trace);
    let fetched = 0;
    const other = { ...scope, [field]: replacement };
    const result = await f.make().load(
      other,
      async () => {
        fetched++;
        return value(other);
      },
      validate,
      f.trace,
    );
    assert.equal(fetched, 1, field);
    assert.equal(result.user.userID, other.userId);
  }
});
test("sign-out deletes persisted data and a late response cannot repopulate it", async () => {
  const f = fixture(),
    cache = f.make();
  let resolve;
  const result = cache.load(
    scope,
    () =>
      new Promise((r) => {
        resolve = r;
      }),
    validate,
    f.trace,
  );
  await flush();
  cache.setIdentity({ authMethod: "none" });
  resolve(value());
  await assert.rejects(result, /Account changed/);
  await flush();
  assert.equal(f.entry, undefined);
});
test("a background refresh scheduled before an account switch is discarded", async () => {
  const f = fixture(),
    cache = f.make();
  await cache.load(scope, f.fetcher, validate, f.trace);
  f.advance(11 * 60_000);
  await cache.load(
    scope,
    () => {
      throw Error("must not fetch");
    },
    validate,
    f.trace,
  );
  cache.setIdentity({ ...scope, accountId: "other" });
  await f.tasks[0]();
  await flush();
  assert.equal(f.entry, undefined);
});
test("corrupt cached identity falls through to the real server response", async () => {
  const f = fixture();
  await f.make().load(scope, f.fetcher, validate, f.trace);
  f.entry.value = value({ ...scope, accountId: "wrong" });
  const result = await f.make().load(scope, f.fetcher, validate, f.trace);
  assert.equal(result.user.customIDs.account_id, scope.accountId);
  assert.equal(f.calls, 2);
});
test("storage failures do not break authentication or normal network startup", async () => {
  const f = fixture(),
    cache = f.make({
      store: {
        read: async () => {
          throw Error("blocked");
        },
        write: async () => {
          throw Error("quota");
        },
        clear: async () => {},
      },
    });
  const result = await cache.load(scope, f.fetcher, validate, f.trace);
  assert.equal(result.user.userID, scope.userId);
  assert.equal(f.calls, 1);
});
test("uncacheable server data is passed back unchanged instead of breaking the app", async () => {
  const f = fixture(),
    fetched = value({ ...scope, userId: "other" });
  const result = await f
    .make()
    .load(scope, async () => fetched, validate, f.trace);
  assert.equal(result, fetched);
  assert.equal(f.entry, undefined);
  assert.ok(f.events.includes("statsig_cache_response_not_cacheable"));
});
test("a future timestamp is not treated as an indefinitely fresh cache", async () => {
  const f = fixture();
  await f.make().load(scope, f.fetcher, validate, f.trace);
  f.entry.savedAt += 100_000;
  await f.make().load(scope, f.fetcher, validate, f.trace);
  assert.equal(f.calls, 2);
});
test("concurrent same-scope initializations share one in-flight request", async () => {
  const f = fixture(),
    cache = f.make();
  let resolve,
    calls = 0;
  const fetcher = () => {
    calls++;
    return new Promise((r) => {
      resolve = r;
    });
  };
  const a = cache.load(scope, fetcher, validate, f.trace),
    b = cache.load(scope, fetcher, validate, f.trace);
  await flush();
  assert.equal(calls, 1);
  resolve(value());
  await Promise.all([a, b]);
});
test("cold-start failure preserves the original fallback and schedules one later warming attempt", async () => {
  const f = fixture();
  let calls = 0;
  await assert.rejects(
    f.make().load(
      scope,
      async (background) => {
        calls++;
        if (!background) throw Error("timeout");
        return value();
      },
      validate,
      f.trace,
    ),
    /timeout/,
  );
  assert.equal(calls, 1);
  assert.equal(f.tasks.length, 1);
  await f.tasks[0]();
  assert.equal(calls, 2);
  assert.ok(f.entry);
});
test("a new signed-out page purges an earlier signed-in cache", async () => {
  const f = fixture();
  await f.make().load(scope, f.fetcher, validate, f.trace);
  f.make().setIdentity({ authMethod: "none" });
  await flush();
  assert.equal(f.entry, undefined);
});

test("email-only intermediate auth snapshots do not purge a verified cache", async () => {
  const f = fixture(),
    cache = f.make();
  cache.observeAuth({ authMethod: "chatgpt", email: "a@example.test" });
  await cache.load(scope, f.fetcher, validate, f.trace);
  cache.observeAuth({ authMethod: "chatgpt", email: "a@example.test" });
  await cache.load(
    scope,
    () => {
      throw Error("must not fetch");
    },
    validate,
    f.trace,
  );
  assert.equal(f.calls, 1);
  cache.observeAuth({ authMethod: "none" });
  await flush();
  assert.equal(f.entry, undefined);
});
test("lack of secure hashing disables caching without blocking normal startup", async () => {
  const f = fixture();
  const cache = f.make({
    hash: async () => {
      throw Error("no crypto");
    },
  });
  const result = await cache.load(scope, f.fetcher, validate, f.trace);
  assert.equal(result.user.userID, scope.userId);
  assert.equal(f.calls, 1);
  assert.equal(f.entry, undefined);
});
test("a verified authenticated user alias may match, but cannot cross a workspace", async () => {
  const f = fixture();
  const scoped = { ...scope, authenticatedUserId: "auth-user" };
  const alias = value({ ...scope, userId: "auth-user" });
  await f.make().load(scoped, async () => alias, validate, f.trace);
  assert.ok(f.entry);
  const other = { ...scoped, accountId: "other" };
  await f.make().load(other, async () => alias, validate, f.trace);
  assert.equal(f.entry.key.includes("workspace-A"), true); // Bad response did not replace the old scope.
});
