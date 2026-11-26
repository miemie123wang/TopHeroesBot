import { sleep } from './sleep.mjs';

export function retryAfterMs(value, now = Date.now()) {
  if (value == null || String(value).trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export class RateLimitError extends Error {
  constructor(message, waitMs = null, options = {}) {
    super(message, options);
    this.name = 'RateLimitError';
    this.status = 429;
    this.code = 'RATE_LIMITED';
    this.retryAfterMs = waitMs;
  }
}

export function createRequestGate({ intervalMs = 2500, now = Date.now, wait = sleep } = {}) {
  let nextAt = 0;
  let cooldownUntil = 0;
  let tail = Promise.resolve();
  return {
    defer(ms) { cooldownUntil = Math.max(cooldownUntil, now() + Math.max(0, ms)); },
    acquire() {
      const turn = tail.then(async () => {
        // Recheck after waking: another in-flight request may extend cooldown.
        while (Math.max(nextAt, cooldownUntil) > now()) {
          await wait(Math.max(nextAt, cooldownUntil) - now());
        }
        nextAt = now() + intervalMs;
      });
      tail = turn.catch(() => {});
      return turn;
    },
  };
}

export const loginRequestGate = createRequestGate();

export async function fetchLoginRequest(url, options) {
  await loginRequestGate.acquire();
  const response = await fetch(url, options);
  if (response.status === 429) {
    const waitMs = retryAfterMs(response.headers.get('retry-after'));
    loginRequestGate.defer(Math.max(30000, waitMs ?? 0));
    throw new RateLimitError(`HTTP 429: ${await response.text()}`, waitMs);
  }
  return response;
}
