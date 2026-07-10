import { sleep } from "./sleep.mjs";

export function maskUid(uid) {
  const value = String(uid);
  if (value.length <= 4) return "****";
  return value.slice(0, 2) + "*".repeat(value.length - 4) + value.slice(-2);
}

export function getTodayDateString() {
  return new Date().toISOString().slice(0, 10);
}

export function getNicknameFromLoginData(loginData) {
  return (
    loginData?.data?.user?.nickname ||
    loginData?.data?.nickname ||
    loginData?.user?.nickname ||
    "Unknown"
  );
}

export async function runWithConcurrency(items, concurrency, worker, staggerMs = 2000) {
  const safeConcurrency = Math.max(1, Number(concurrency) || 1);
  const workerCount = Math.min(safeConcurrency, items.length);
  const results = new Array(items.length);
  const queue = items.map((item, index) => ({ item, index }));

  async function runner(workerId) {
    if (workerId > 0 && staggerMs > 0) {
      await sleep(workerId * staggerMs);
    }

    while (queue.length > 0) {
      const task = queue.shift();
      if (!task) break;

      try {
        results[task.index] = await worker(task.item, task.index, workerId);
      } catch (err) {
        results[task.index] = { ok: false, error: err };
      }
    }
  }

  await Promise.all(
    Array.from({ length: workerCount }, (_, workerId) => runner(workerId))
  );

  return results;
}
