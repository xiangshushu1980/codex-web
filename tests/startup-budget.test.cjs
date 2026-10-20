const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Exercise the prepared upstream function so symbol/patch drift fails visibly.
const bundle = fs.readFileSync(path.join(__dirname,
  '../scratch/asar/webview/assets/app-initial-6350d04672d0.js'), 'utf8');
const start = bundle.indexOf('async function rZs({');
const end = bundle.indexOf('\nvar iZs, f8;', start);
assert.ok(start >= 0 && end > start, 'bootstrap function must exist in prepared bundle');

function harness() {
  let sequence = 0, request;
  const timers = new Map(), phases = [];
  const context = {
    AbortController, iZs: 4000, Nc: 'Codex',
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, {fn, delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
    startupTrace(phase) { phases.push(phase); },
    _zr(body, signal, onHeaders) {
      return new Promise((resolve, reject) => { request = { signal, onHeaders, resolve, reject }; });
    },
    eZs: { parse(value) { return value; } },
    f8: class extends Error { constructor(type, cause) { super(type, {cause}); } },
    zfe: {
      CODEX_POST_LOGIN_STATSIG_BOOTSTRAP_FAILURE_TYPE_REQUEST_FAILED: 'request',
      CODEX_POST_LOGIN_STATSIG_BOOTSTRAP_FAILURE_TYPE_RESPONSE_INVALID: 'invalid',
    },
  };
  vm.runInNewContext(bundle.slice(start, end) + '\nthis.bootstrap = rZs;', context);
  const result = context.bootstrap({});
  return { result, timers, phases, get request() { return request; },
    expire() {
      assert.equal(timers.size, 1);
      const [id, timer] = timers.entries().next().value;
      assert.equal(timer.delay, 4000);
      timers.delete(id); timer.fn();
    },
  };
}

test('missing response headers aborts at the original 4 second budget', async () => {
  const h = harness(); h.expire();
  await assert.rejects(h.result, e => e.cause.message.includes('(headers)'));
  assert.equal(h.request.signal.aborted, true);
  assert.equal(h.timers.size, 0);
});

test('headers replace the deadline; a stalled body is still aborted', async () => {
  const h = harness(); const initial = [...h.timers.keys()][0];
  h.request.onHeaders();
  assert.equal(h.timers.has(initial), false);
  const bodyDeadline = [...h.timers.keys()][0];
  h.request.onHeaders(); // Repeated header callbacks cannot extend the body budget.
  assert.equal([...h.timers.keys()][0], bodyDeadline);
  h.expire();
  await assert.rejects(h.result, e => e.cause.message.includes('(body)'));
  assert.equal(h.request.signal.aborted, true);
  assert.equal(h.timers.size, 0);
  h.request.onHeaders(); // A late callback must not restart an aborted request.
  assert.equal(h.timers.size, 0);
});

test('a complete bootstrap retains payload and identity and clears its deadline', async () => {
  const h = harness(); h.request.onHeaders();
  const payload = JSON.stringify({user: {userID: 'test-account'}, feature_gates: {}});
  h.request.resolve({statsigPayload: payload});
  const result = await h.result;
  assert.equal(result.statsigPayload, payload);
  assert.equal(result.user.userID, 'test-account');
  assert.equal(h.request.signal.aborted, false);
  assert.equal(h.timers.size, 0);
});

test('transport errors clear deadlines and retain the upstream failure path', async () => {
  const h = harness(); h.request.onHeaders();
  const failure = new Error('HTTP failure'); h.request.reject(failure);
  await assert.rejects(h.result, e => e.cause === failure);
  assert.equal(h.timers.size, 0);
});
