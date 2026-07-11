import { BASE, SITE_ID, PROJECT_ID, MERCHANT_ID } from "../../core/config.mjs";
import { gameHeaders } from "../../core/api.mjs";
import { login } from "../../core/auth.mjs";
import { sleep, randomSleep } from "../../core/sleep.mjs";
import { maskUid } from "../../core/utils.mjs";

async function reportLoginShow() {
  await fetch(`${BASE}/api/v2/store/point/reporting`, {
    method: "POST",
    headers: gameHeaders,
    body: JSON.stringify({
      project_id: PROJECT_ID,
      store_id: SITE_ID,
      merchant_id: MERCHANT_ID,
      country: "CA",
      type: "UID_LOGIN_SHOW",
      device: "mobile",
      platform: "android"
    })
  });
}

async function redeemCode(authedHeaders, code) {
  const response = await fetch(`${BASE}/api/v2/store/redemption/redeem`, {
    method: "POST",
    headers: authedHeaders,
    body: JSON.stringify({
      project_id: PROJECT_ID,
      redemption_code: code
    })
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      success: false,
      message: `兌換返回不是 JSON: ${text}`,
      data: null
    };
  }

  return {
    success: data.code === 1,
    message: data.message || text,
    data
  };
}

export async function redeemForUid(uid, code, options = {}) {
  const {
    separator = false,
    indent = "",
    reportingDelayMs = 0,
    loginDelayMs = 0,
    loginDelayMin = 0,
    loginDelayMax = 0,
    loginOptions = {},
    throwOnError = false
  } = options;

  if (separator) {
    console.log(`\n========== UID: ${maskUid(uid)} ==========`);
  } else {
    console.log(`${indent}UID: ${maskUid(uid)}`);
  }

  try {
    await reportLoginShow();

    if (reportingDelayMs > 0) {
      await sleep(reportingDelayMs);
    }

    const loginInfo = await login(uid, {
      device: "mobile",
      logLifecycle: false,
      ...loginOptions
    });

    console.log(`${indent}登錄成功 ✓ (${loginInfo.nickname})`);

    if (loginDelayMax > loginDelayMin) {
      await randomSleep(loginDelayMin, loginDelayMax);
    } else if (loginDelayMs > 0) {
      await sleep(loginDelayMs);
    }

    const result = await redeemCode(loginInfo.authedHeaders, code);

    if (result.success) {
      console.log(`${indent}兌換成功 ✓${separator ? ` (${code})` : ""}`);
    } else {
      console.error(`${indent}兌換失敗: ${result.message}`);
    }

    return {
      ...result,
      uid,
      nickname: loginInfo.nickname
    };
  } catch (err) {
    if (throwOnError) throw err;

    console.error(`${indent}登錄/兌換流程失敗: ${err.message}`);

    return {
      success: false,
      uid,
      nickname: null,
      message: err.message,
      error: err
    };
  }
}

function isCodeWideFailure(result) {
  if (!result || result.success) return false;

  const message = String(result.message || "").toLowerCase();

  return [
    "redemption code expired",
    "code expired",
    "invalid redemption code",
    "redemption code invalid",
    "activity not found",
    "code not found"
  ].some(text => message.includes(text));
}

export async function redeemAllUids(code, uids, options = {}) {
  const {
    validateFirst = false,
    firstFailureStops = validateFirst,
    stopOnCodeWideFailure = true,
    beforeStart,
    onFirstFailure,
    afterComplete,
    accountDelayMin = 3000,
    accountDelayMax = 6000,
    redeemOptions = {},
    firstRedeemOptions = redeemOptions
  } = options;

  if (!Array.isArray(uids) || uids.length === 0) {
    return { total: 0, success: 0, failed: 0, stoppedEarly: false, results: [] };
  }

  if (beforeStart) {
    await beforeStart({ code, uids });
  }

  const results = [];
  let startIndex = 0;

  if (validateFirst) {
    const firstResult = await redeemForUid(uids[0], code, firstRedeemOptions);
    results.push(firstResult);
    startIndex = 1;

    if (!firstResult.success && firstFailureStops) {
      if (onFirstFailure) {
        await onFirstFailure({ code, result: firstResult });
      }

      return {
        total: uids.length,
        success: 0,
        failed: 1,
        stoppedEarly: true,
        results
      };
    }
  }

  for (let index = startIndex; index < uids.length; index++) {
    if (index > 0) {
      await randomSleep(accountDelayMin, accountDelayMax);
    }

    const result = await redeemForUid(uids[index], code, redeemOptions);
    results.push(result);

    if (stopOnCodeWideFailure && isCodeWideFailure(result)) {
      console.log(`停止後續帳號：${result.message}`);

      const summary = {
        total: uids.length,
        success: results.filter(item => item.success).length,
        failed: results.filter(item => !item.success).length,
        stoppedEarly: true,
        stopReason: "code-wide-failure",
        results
      };

      if (onFirstFailure && results.length == 1) {
        await onFirstFailure({ code, result });
      }

      return summary;
    }
  }

  const summary = {
    total: uids.length,
    success: results.filter(item => item.success).length,
    failed: results.filter(item => !item.success).length,
    stoppedEarly: false,
    results
  };

  if (afterComplete) {
    await afterComplete({ code, summary });
  }

  return summary;
}
