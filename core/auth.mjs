import { NEW_BASE, OLD_BASE, SITE_ID, PROJECT_ID } from "./config.mjs";
import { gameHeaders } from "./api.mjs";
import { sleep, randomSleep } from "./sleep.mjs";
import { logInfo } from "./logger.mjs";
import { maskUid, getNicknameFromLoginData } from "./utils.mjs";

const STORE_BASE = "https://store.topheroes.com";

function normalizeHeaderObject(headers) {
  if (!headers) return {};

  if (typeof headers.entries === "function") {
    return Object.fromEntries(
      [...headers.entries()].map(([name, value]) => [
        String(name).toLowerCase(),
        value
      ])
    );
  }

  const normalized = {};

  for (const [name, value] of Object.entries(headers)) {
    normalized[String(name).toLowerCase()] = value;
  }

  return normalized;
}

/*
 * store.topheroes.com 的签到写入接口要求使用该域名签发的
 * Authorization，并保持网页的桌面登录环境。
 *
 * 这里必须先把 gameHeaders 统一成小写，再覆盖 content-type。
 * 否则同时存在 Content-Type / content-type 时，Node fetch 会合并成：
 * application/json, application/json，商城会返回 Parameter exception。
 */
const STORE_DESKTOP_HEADERS = {
  ...normalizeHeaderObject(gameHeaders),
  accept: "application/json, text/plain, */*",
  "accept-language":
    "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7,fr-CA;q=0.6,fr;q=0.5",
  "cache-control": "no-cache",
  "content-type": "application/json",
  pragma: "no-cache",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/151.0.0.0 Safari/537.36",
  cookie: "lang=en"
};

function isOldSystemAccount(message) {
  return String(message || "").toLowerCase().includes("user not in new system");
}

function isNewSystemAccount(message) {
  return String(message || "").toLowerCase().includes("redirect to new mall");
}

function getHeadersForBase(baseUrl) {
  if (baseUrl === STORE_BASE) {
    return { ...STORE_DESKTOP_HEADERS };
  }

  return { ...gameHeaders };
}

export async function preCheckPlayer(uid, baseUrl = NEW_BASE) {
  const url =
    `${baseUrl}/api/v2/store/player-info` +
    `?project_id=${PROJECT_ID}` +
    `&player_id=${encodeURIComponent(uid)}` +
    `&site_id=${SITE_ID}`;

  const baseHeaders = getHeadersForBase(baseUrl);

  try {
    await fetch(url, {
      method: "GET",
      headers: {
        ...baseHeaders,
        ...(baseUrl === STORE_BASE
          ? {
              origin: STORE_BASE,
              referer: `${STORE_BASE}/en`
            }
          : {})
      }
    });
  } catch {
    // player-info 失败不影响 login
  }
}

export async function loginAtBase(uid, baseUrl, device = "pc") {
  await preCheckPlayer(uid, baseUrl);

  const baseHeaders = getHeadersForBase(baseUrl);

  const response = await fetch(`${baseUrl}/api/v2/store/login/player`, {
    method: "POST",
    headers: {
      ...baseHeaders,
      origin: baseUrl,
      referer: `${baseUrl}/en`,
      ...(baseUrl === STORE_BASE ? { cookie: "lang=en" } : {})
    },
    body: JSON.stringify({
      site_id: SITE_ID,
      player_id: uid,
      server_id: "",
      device
    })
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`返回不是 JSON：${text}`);
  }

  if (Number(data?.code) !== 1) {
    throw new Error(data?.message || JSON.stringify(data));
  }

  const rawNickname = getNicknameFromLoginData(data);
  const nickname = rawNickname === "Unknown" ? "(unknown)" : rawNickname;
  const token = response.headers.get("authorization");

  if (!token) {
    throw new Error(`没有拿到 token (${nickname})`);
  }

  return {
    nickname,
    token,
    baseUrl,
    system:
      baseUrl === NEW_BASE
        ? "new"
        : baseUrl === OLD_BASE
          ? "old"
          : baseUrl === STORE_BASE
            ? "store"
            : "unknown",
    authedHeaders: {
      ...baseHeaders,
      authorization: token
    }
  };
}

export async function login(uid, options = {}) {
  const {
    maxRetries = 6,
    device = "pc",
    preDelayMin = 1000,
    preDelayMax = 3000,
    retryDelayMin = 15000,
    retryDelayMax = 35000,
    logLifecycle = true
  } = options;

  let lastError;
  let preferredBase = NEW_BASE;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await randomSleep(preDelayMin, preDelayMax);

      if (logLifecycle) {
        logInfo(`[LOGIN START] ${maskUid(uid)} ${new Date().toISOString()}`);
      }

      let result;
      try {
        result = await loginAtBase(uid, preferredBase, device);
      } catch (error) {
        const message = error.message || String(error);

        if (preferredBase === NEW_BASE && isOldSystemAccount(message)) {
          console.warn(`${maskUid(uid)} 尚未迁移到新商城，立即改用旧商城登录`);
          result = await loginAtBase(uid, OLD_BASE, device);
        } else if (preferredBase === OLD_BASE && isNewSystemAccount(message)) {
          console.warn(`${maskUid(uid)} 已迁移到新商城，立即改用新商城登录`);
          result = await loginAtBase(uid, NEW_BASE, device);
        } else {
          throw error;
        }
      }

      if (logLifecycle) {
        logInfo(
          `[LOGIN OK] ${maskUid(uid)} ${new Date().toISOString()} ` +
          `(${result.system} mall)`
        );
      }

      return result;
    } catch (err) {
      lastError = err;

      if (attempt < maxRetries) {
        const wait =
          retryDelayMin +
          Math.floor(Math.random() * (retryDelayMax - retryDelayMin));

        console.warn(`[login ${attempt}/${maxRetries}] ${maskUid(uid)} 失败：${err.message}`);
        console.warn(`等待 ${Math.round(wait / 1000)} 秒后重试...`);
        await sleep(wait);
      }
    }
  }

  throw new Error(
    `登录失败（已重试 ${maxRetries} 次）：${lastError?.message || "unknown"}`
  );
}
