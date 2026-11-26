import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const original = new URL('../', import.meta.url);
const staged = original;
const sources = {
  auth: await fs.readFile(new URL('core/auth.mjs', staged), 'utf8'),
  utils: await fs.readFile(new URL('core/utils.mjs', staged), 'utf8'),
  redeem: await fs.readFile(new URL('features/redeem/redeem-service.mjs', staged), 'utf8'),
  'rate-limit': await fs.readFile(new URL('core/rate-limit.mjs', staged), 'utf8'),
};
const ok = { status: 200, code: 1, message: 'ok' };
const limited = { status: 429, code: 10017, message: 'too many requests', retryAfter: '60' };

async function fixture({ login = () => ok, precheck = () => ok, redeem = () => ok } = {}) {
  let clock = 0;
  let loginCalls = 0;
  const events = [];
  const logs = [];
  class FakeDate extends Date { static now() { return clock; } }
  const context = vm.createContext({
    Date: FakeDate, Math: Object.assign(Object.create(Math), { random: () => 0 }),
    console: Object.fromEntries(['log', 'warn', 'error'].map(k => [k, (...args) => logs.push(args.join(' '))])),
    process: { env: {} }, URL, encodeURIComponent,
    fetch: async (url, options = {}) => {
      const path = new URL(url).pathname;
      const response = path.endsWith('/login/player') ? login(++loginCalls)
        : path.endsWith('/player-info') ? precheck()
        : path.endsWith('/redemption/redeem') ? redeem() : ok;
      events.push({ kind: 'request', at: clock, path, status: response.status });
      return {
        ok: response.status >= 200 && response.status < 300, status: response.status,
        text: async () => JSON.stringify({ code: response.code, message: response.message, data: { nickname: 'mock' } }),
        headers: { get: name => {
          events.push({ kind: 'header', name: name.toLowerCase() });
          if (name.toLowerCase() === 'authorization') return 'fake-token';
          if (name.toLowerCase() === 'retry-after') return response.retryAfter ?? null;
          return null;
        } },
      };
    },
  });
  const modules = new Map();
  const synthetic = (id, values) => new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value);
  }, { context, identifier: id });
  const sleep = async ms => { events.push({ kind: 'sleep', ms }); clock += ms; await Promise.resolve(); };
  modules.set('config', synthetic('config', {
    NEW_BASE: 'https://new.mall.invalid', OLD_BASE: 'https://old.mall.invalid', SITE_ID: 'mock', PROJECT_ID: 'mock', MERCHANT_ID: 'mock',
  }));
  modules.set('api', synthetic('api', { gameHeaders: {} }));
  modules.set('logger', synthetic('logger', { logInfo: () => {} }));
  modules.set('sleep', synthetic('sleep', { sleep, randomSleep: min => sleep(min) }));
  for (const [id, code] of Object.entries(sources)) modules.set(id, new vm.SourceTextModule(code, { context, identifier: id }));
  await modules.get('redeem').link(specifier => {
    const key = specifier.split('/').pop().replace(/\.mjs$/, '');
    if (!modules.has(key)) throw new Error(`Unexpected import: ${specifier}`);
    return modules.get(key);
  });
  await modules.get('redeem').evaluate();
  return { redeem: modules.get('redeem').namespace, auth: modules.get('auth').namespace,
    rate: modules.get('rate-limit').namespace, events, logs };
}
const uids = Array.from({ length: 27 }, (_, i) => `fake-account-${i + 1}`);
const accountOptions = { reportingDelayMs: 1000, loginDelayMs: 1000,
  loginOptions: { maxRetries: 3, preDelayMin: 0, preDelayMax: 0 } };
const options = { concurrency: 2, staggerMs: 2000, redeemOptions: accountOptions, firstRedeemOptions: accountOptions };
const passed = [];

const batch = await fixture({ login: n => n <= 2 ? ok : limited });
const batchResult = await batch.redeem.redeemAllUids('FAKE-CODE', uids, options);
assert.equal(batchResult.success, 2);
assert.equal(batchResult.stoppedEarly, true);
assert.equal(batchResult.stopReason, 'rate-limited');
assert.ok(batchResult.attempted < 27);
assert.ok(batchResult.skipped > 0);
assert.ok(batch.events.some(e => e.kind === 'sleep' && e.ms >= 60000));
assert.ok(batch.events.some(e => e.kind === 'header' && e.name === 'retry-after'));
passed.push('two successes followed by 429: shared waiting, bounded retries, remaining accounts skipped');

const recovery = await fixture({ login: n => n === 1 ? limited : ok });
const recovered = await recovery.auth.login('fake', { maxRetries: 2, preDelayMin: 0, preDelayMax: 0, logLifecycle: false });
assert.equal(recovered.nickname, 'mock');
assert.ok(recovery.events.some(e => e.kind === 'sleep' && e.ms >= 60000));
passed.push('429 then recovery: waits at least the advertised 60 seconds before retry');

const precheck = await fixture({ precheck: () => limited });
const preResult = await precheck.redeem.redeemAllUids('FAKE', uids, options);
assert.equal(preResult.stopReason, 'rate-limited');
assert.equal(precheck.events.filter(e => e.kind === 'request' && e.path.endsWith('/login/player')).length, 0);
passed.push('429 on preliminary player-info: no immediate login request follows');

const redeem429 = await fixture({ redeem: () => limited });
const redeemResult = await redeem429.redeem.redeemAllUids('FAKE', uids, options);
assert.equal(redeemResult.stopReason, 'rate-limited');
assert.equal(redeemResult.attempted, 1);
passed.push('429 on redemption endpoint: remaining accounts are not dispatched');

const success = await fixture();
const successResult = await success.redeem.redeemAllUids('FAKE', uids, options);
assert.equal(successResult.success, 27);
assert.equal(successResult.failed, 0);
passed.push('normal operation: all 27 accounts still complete');

const expired = await fixture({ redeem: () => ({ status: 200, code: 0, message: 'redemption code expired' }) });
const expiredResult = await expired.redeem.redeemAllUids('FAKE', uids, options);
assert.equal(expiredResult.stopReason, 'code-wide-failure');
assert.equal(expiredResult.attempted, 1);
passed.push('expired code: existing first-account stop behavior is preserved');

const businessLimit = await fixture({ login: () => ({ status: 200, code: 10017, message: 'too many requests' }) });
const businessResult = await businessLimit.redeem.redeemAllUids('FAKE', uids, options);
assert.equal(businessResult.stopReason, 'rate-limited');
passed.push('HTTP 200 with business code 10017 is also recognized as a rate limit');

assert.equal(success.rate.retryAfterMs('60'), 60000);
assert.equal(success.rate.retryAfterMs(''), null);
assert.equal(success.rate.retryAfterMs('invalid'), null);
assert.equal(success.rate.retryAfterMs(new Date(60000).toUTCString(), 0), 60000);
assert.equal(success.rate.retryAfterMs(new Date(0).toUTCString(), 60000), 0);
passed.push('Retry-After parses seconds and HTTP dates, rejects invalid values');

// Real short timers exercise concurrent reservations without virtual-clock scheduling artifacts.
const times = [];
const gate = success.rate.createRequestGate({ intervalMs: 15, now: Date.now, wait: ms => new Promise(r => setTimeout(r, ms)) });
await Promise.all(Array.from({ length: 4 }, async () => { await gate.acquire(); times.push(Date.now()); }));
assert.ok(times.every((t, i) => i === 0 || t - times[i - 1] >= 12));
passed.push('concurrent requests share a single interval gate');

const deferredTimes = [];
const deferredGate = success.rate.createRequestGate({ intervalMs: 15, now: Date.now, wait: ms => new Promise(r => setTimeout(r, ms)) });
await deferredGate.acquire();
const pending = deferredGate.acquire().then(() => deferredTimes.push(Date.now()));
const until = Date.now() + 70;
deferredGate.defer(70);
await pending;
assert.ok(deferredTimes[0] >= until);
passed.push('already queued requests respect an extended shared cooldown');

console.log(JSON.stringify({ mode: 'OFFLINE: all HTTP mocked; no source deployment or real redemptions',
  checksPassed: passed.length, passed,
  reproductionAfterFix: { success: batchResult.success, failed: batchResult.failed,
    skipped: batchResult.skipped, attempted: batchResult.attempted, stopReason: batchResult.stopReason },
}, null, 2));
