export type Bootstrap = {
  statsigPayload: string;
  user: {
    userID?: string;
    customIDs?: Record<string, unknown>;
    custom?: Record<string, unknown>;
  };
  cacheMetadata?: Record<string, unknown>;
};
export type CacheScope = {
  userId?: string;
  accountId?: string;
  authMethod?: string;
  [key: string]: unknown;
};
type Entry = { key: string; savedAt: number; value: Bootstrap };
export type CacheStore = {
  read(): Promise<Entry | undefined>;
  write(entry: Entry): Promise<void>;
  clear(): Promise<void>;
};
const FRESH_MS = 10 * 60_000;
const MAX_AGE_MS = 60 * 60_000;

// IndexedDB holds the multi-megabyte bootstrap without localStorage's small quota.
export function indexedBootstrapStore(): CacheStore {
  async function transaction<T>(
    mode: IDBTransactionMode,
    action: (s: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let db: IDBDatabase | undefined,
        settled = false;
      const complete = (error?: unknown, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        db?.close();
        error ? reject(error) : resolve(value as T);
      };
      const timeout = setTimeout(
        () => complete(new Error("Cache storage timeout")),
        500,
      );
      let open: IDBOpenDBRequest;
      try {
        open = indexedDB.open("codex-web-startup", 1);
      } catch (error) {
        complete(error);
        return;
      }
      open.onupgradeneeded = () => {
        open.result.createObjectStore("bootstrap");
      };
      open.onerror = () => complete(open.error);
      open.onblocked = () => complete(new Error("Cache storage blocked"));
      open.onsuccess = () => {
        db = open.result;
        if (settled) {
          db.close();
          return;
        }
        const tx = db.transaction("bootstrap", mode);
        const request = action(tx.objectStore("bootstrap"));
        tx.oncomplete = () => complete(undefined, request.result);
        tx.onabort = () =>
          complete(tx.error ?? new Error("Cache transaction aborted"));
        tx.onerror = () =>
          complete(tx.error ?? new Error("Cache transaction failed"));
      };
    });
  }
  return {
    read: () => transaction("readonly", (s) => s.get("current")),
    write: async (entry) => {
      await transaction("readwrite", (s) => s.put(entry, "current"));
    },
    clear: async () => {
      await transaction("readwrite", (s) => s.clear());
    },
  };
}

export function createStartupCache(
  options: {
    store?: CacheStore;
    now?: () => number;
    hash?: (value: string) => Promise<string>;
    schedule?: (task: () => Promise<void>) => void;
  } = {},
) {
  const store = options.store ?? indexedBootstrapStore();
  const now = options.now ?? Date.now;
  const hash =
    options.hash ??
    (async (s: string) => {
      const bytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(s),
      );
      return Array.from(new Uint8Array(bytes), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
    });
  const schedule =
    options.schedule ??
    ((task) => {
      const start = performance.now();
      const wait = () => {
        if (document.visibilityState === "hidden") {
          setTimeout(wait, 1000);
          return;
        }
        const ready = window as unknown as {
          __codexStartupReport?: { status: string };
          __codexStartupTraceVisible?: boolean;
        };
        if (
          !ready.__codexStartupTraceVisible &&
          ready.__codexStartupReport?.status !== "ready" &&
          performance.now() - start < 30_000
        ) {
          setTimeout(wait, 500);
          return;
        }
        void task();
      };
      setTimeout(wait, 500);
    });
  let identity: string | null = null,
    generation = 0,
    memory: Entry | undefined,
    initialized = false;
  const active = new Map<string, Promise<Bootstrap>>();
  const scheduled = new Map<string, number>();
  let storageQueue: Promise<unknown> = Promise.resolve();
  let observedEmail: unknown;
  const diagnostics: {
    phase: string;
    ageMs?: number;
    metadata?: Record<string, unknown>;
    persistence?: "indexeddb" | "memory";
    events: { phase: string; at: number }[];
  } = { phase: "idle", events: [] };
  const persist = (fn: () => Promise<unknown>) => {
    const result = storageQueue.then(fn, fn).then(
      () => true,
      () => false,
    );
    storageQueue = result;
    return result;
  };
  const identityOf = (scope: CacheScope) =>
    scope.authMethod === "chatgpt" && scope.userId && scope.accountId
      ? JSON.stringify([scope.authMethod, scope.userId, scope.accountId])
      : null;
  function setIdentity(scope: CacheScope) {
    const next = identityOf(scope);
    if (initialized && next === identity) return;
    initialized = true;
    const wasAuthenticated = identity !== null;
    identity = next;
    generation++;
    memory = undefined;
    active.clear();
    // The single stored entry is always scope-checked. On an observed sign-out
    // or switch, purge it too; queued writes cannot resurrect a prior identity.
    if (wasAuthenticated || !next) void persist(() => store.clear());
  }
  function validateIdentity(value: Bootstrap, scope: CacheScope) {
    if (
      !value ||
      typeof value.statsigPayload !== "string" ||
      value.statsigPayload.length > 16 * 1024 * 1024
    )
      throw Error("Invalid bootstrap");
    const account =
      value.user?.customIDs?.account_id ??
      value.user?.custom?.account_id ??
      value.user?.custom?.workspace_id;
    if (
      ![scope.userId, scope.authenticatedUserId]
        .filter(Boolean)
        .includes(value.user?.userID) ||
      account !== scope.accountId
    )
      throw Error("Bootstrap identity mismatch");
  }
  async function load(
    scope: CacheScope,
    fetcher: (background: boolean) => Promise<Bootstrap>,
    validate: (value: Bootstrap) => Bootstrap,
    trace: (phase: string) => void,
  ) {
    const originalTrace = trace;
    trace = (phase) => {
      diagnostics.phase = phase;
      if (diagnostics.events.length < 60)
        diagnostics.events.push({ phase, at: now() });
      originalTrace(phase);
    };
    setIdentity(scope);
    if (!identity) {
      trace("statsig_cache_identity_unavailable");
      return fetcher(false);
    }
    const epoch = generation,
      principal = identity;
    const isCurrent = () => epoch === generation && identity === principal;
    let key: string;
    try {
      key = await hash(
        JSON.stringify(
          Object.keys(scope)
            .sort()
            .map((k) => [k, scope[k] ?? null]),
        ),
      );
    } catch {
      trace("statsig_cache_storage_unavailable");
      return fetcher(false);
    }
    if (!isCurrent()) throw Error("Account changed during cache lookup");
    const checked = (value: Bootstrap) => {
      const result = validate(value);
      validateIdentity(result, scope);
      return result;
    };
    async function fetchAndSave(background: boolean) {
      const pending = active.get(key);
      if (pending) return pending;
      const request = (async () => {
        const fetched = await fetcher(background);
        if (!isCurrent()) throw Error("Account changed during bootstrap");
        let value: Bootstrap;
        try {
          value = checked(fetched);
        } catch {
          trace("statsig_cache_response_not_cacheable");
          if (background)
            throw Error("Refreshed configuration cannot be cached");
          return fetched;
        }
        diagnostics.metadata = value.cacheMetadata;
        diagnostics.ageMs = 0;
        const entry = { key, value, savedAt: now() };
        memory = entry;
        const saved = await persist(async () => {
          if (isCurrent()) await store.write(entry);
        });
        diagnostics.persistence = saved ? "indexeddb" : "memory";
        return value;
      })();
      active.set(key, request);
      try {
        return await request;
      } finally {
        if (active.get(key) === request) active.delete(key);
      }
    }
    function backgroundRefresh() {
      if (scheduled.get(key) === epoch) return;
      scheduled.set(key, epoch);
      schedule(async () => {
        try {
          if (!isCurrent()) return;
          trace("statsig_cache_background_refresh_started");
          await fetchAndSave(true);
          if (isCurrent())
            trace(
              diagnostics.persistence === "indexeddb"
                ? "statsig_cache_background_refresh_saved"
                : "statsig_cache_background_refresh_memory_only",
            );
        } catch {
          if (isCurrent()) trace("statsig_cache_background_refresh_failed");
        } finally {
          if (scheduled.get(key) === epoch) scheduled.delete(key);
        }
      });
    }
    let entry = memory;
    if (!entry || entry.key !== key) {
      try {
        await storageQueue;
        entry = await store.read();
      } catch {
        trace("statsig_cache_storage_unavailable");
      }
    }
    if (!isCurrent()) throw Error("Account changed during cache read");
    if (entry?.key === key && Number.isFinite(entry.savedAt)) {
      const age = now() - entry.savedAt;
      diagnostics.ageMs = age;
      if (age >= 0 && age <= MAX_AGE_MS) {
        try {
          const value = checked(entry.value);
          diagnostics.metadata = value.cacheMetadata;
          memory = entry;
          trace(
            age <= FRESH_MS
              ? "statsig_cache_hit_fresh"
              : "statsig_cache_hit_stale",
          );
          if (age > FRESH_MS) backgroundRefresh();
          return value;
        } catch {
          trace("statsig_cache_invalid");
          memory = undefined;
          void persist(() => store.clear());
        }
      } else trace("statsig_cache_expired");
    }
    trace("statsig_cache_miss");
    try {
      return await fetchAndSave(false);
    } catch (error) {
      // The existing renderer fallback still handles cold-start failures. A
      // single non-blocking, bounded attempt can seed the next navigation.
      if (isCurrent()) backgroundRefresh();
      throw error;
    }
  }
  function observeAuth(auth: CacheScope) {
    // React may render its email-only auth snapshot before local account-info
    // resolves. It must not erase a verified principal on every such render.
    if (auth.authMethod !== "chatgpt" || (auth.userId && auth.accountId))
      setIdentity(auth);
    else if (observedEmail !== undefined && auth.email !== observedEmail)
      setIdentity({});
    observedEmail = auth.email;
  }
  return { setIdentity, observeAuth, load, diagnostics };
}
