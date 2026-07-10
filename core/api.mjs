import { sleep } from "./sleep.mjs";
import { logWarn } from "./logger.mjs";

export const gameHeaders = {
  "Content-Type": "application/json",
  accept: "application/json, text/plain, */*",
  "user-agent":
    "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36",
  cookie: "lang=en"
};

function parseJsonResponse(text, status) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`回傳不是 JSON，HTTP ${status}: ${text.slice(0, 200)}`);
  }
}

export async function fetchJson(url, options = {}, retries = 2) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      const text = await res.text();
      const data = parseJsonResponse(text, res.status);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
      }

      return data;
    } catch (err) {
      lastError = err;

      if (attempt < retries) {
        const wait = 1000 + attempt * 1500;
        logWarn(`請求失敗，${wait}ms 後重試 ${attempt + 1}/${retries}: ${err.message}`);
        await sleep(wait);
      }
    }
  }

  throw lastError;
}

export async function fetchJsonWithResponse(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  const data = parseJsonResponse(text, res.status);

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }

  return { data, response: res };
}
