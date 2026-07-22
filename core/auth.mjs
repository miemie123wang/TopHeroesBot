import { NEW_BASE, OLD_BASE, SITE_ID, PROJECT_ID } from "./config.mjs";
import { gameHeaders } from "./api.mjs";
import { sleep, randomSleep } from "./sleep.mjs";
import { logInfo } from "./logger.mjs";
import { maskUid, getNicknameFromLoginData } from "./utils.mjs";

function isOldSystemAccount(message) {
  return String(message || "").toLowerCase().includes("user not in new system");
}

function isNewSystemAccount(message) {
  return String(message || "").toLowerCase().includes("redirect to new mall");
}

export async function preCheckPlayer(uid, baseUrl = NEW_BASE) {
  const url =
    `${baseUrl}/api/v2/store/player-info` +
    `?project_id=${PROJECT_ID}` +
    `&player_id=${encodeURIComponent(uid)}` +
    `&site_id=${SITE_ID}`;

  try {
    await fetch(url, { method: "GET", headers: gameHeaders });
  } catch {
    // player-info 失敗不影響 login
  }
}

async function loginAtBase(uid, baseUrl, device) {
  await preCheckPlayer(uid, baseUrl);

  const response = await fetch(`${baseUrl}/api/v2/store/login/player`, {
    method: "POST",
    headers: gameHeaders,
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

  if (data.code !== 1) {
    throw new Error(data.message || JSON.stringify(data));
  }

  const nickname = getNicknameFromLoginData(data) === "Unknown"
    ? "(unknown)"
    : getNicknameFromLoginData(data);
  const token = response.headers.get("authorization");

  if (!token) {
    throw new Error(`沒有拿到 token (${nickname})`);
  }

  return {
    nickname,
    token,
    baseUrl,
    system: baseUrl === NEW_BASE ? "new" : "old",
    authedHeaders: {
      ...gameHeaders,
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
          console.warn(`${maskUid(uid)} 尚未迁移到新商城，立即改用舊商城登入`);
          result = await loginAtBase(uid, OLD_BASE, device);
        } else if (preferredBase === OLD_BASE && isNewSystemAccount(message)) {
          console.warn(`${maskUid(uid)} 已迁移到新商城，立即改用新商城登入`);
          result = await loginAtBase(uid, NEW_BASE, device);
        } else {
          throw error;
        }
      }

      if (logLifecycle) {
        logInfo(`[LOGIN OK] ${maskUid(uid)} ${new Date().toISOString()} (${result.system} mall)`);
      }

      return result;
    } catch (err) {
      lastError = err;

      if (attempt < maxRetries) {
        const wait = retryDelayMin + Math.floor(Math.random() * (retryDelayMax - retryDelayMin));
        console.warn(`[login ${attempt}/${maxRetries}] ${maskUid(uid)} 失敗：${err.message}`);
        console.warn(`等待 ${Math.round(wait / 1000)} 秒後重試...`);
        await sleep(wait);
      }
    }
  }

  throw new Error(`登入失敗（已重試 ${maxRetries} 次）：${lastError.message}`);
}
