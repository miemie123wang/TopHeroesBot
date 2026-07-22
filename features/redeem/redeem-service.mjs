import { NEW_BASE, SITE_ID, PROJECT_ID, MERCHANT_ID } from "../../core/config.mjs";
import { gameHeaders } from "../../core/api.mjs";
import { login } from "../../core/auth.mjs";
import { sleep, randomSleep } from "../../core/sleep.mjs";
import { maskUid, runWithConcurrency } from "../../core/utils.mjs";

async function reportLoginShow(baseUrl = NEW_BASE) {
  await fetch(`${baseUrl}/api/v2/store/point/reporting`, {
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

export function classifyRedeemFailure(message) {
  const normalized = String(message || "").trim().toLowerCase();

  const globalRules = [
    ["CODE_EXPIRED", ["redemption code expired", "code expired"]],
    ["INVALID_CODE", ["invalid redemption code", "redemption code invalid", "invalid code"]],
    ["CODE_NOT_FOUND", ["redemption code not found", "code not found"]],
    ["ACTIVITY_NOT_FOUND", ["activity not found"]]
  ];

  for (const [code, patterns] of globalRules) {
    if (patterns.some(pattern => normalized.includes(pattern))) {
      return { scope: "global", code };
    }
  }

  const accountRules = [
    ["ALREADY_REDEEMED", ["already redeemed", "already been redeemed"]],
    ["PERSONAL_LIMIT", [
      "personal redemption limit reached",
      "personal redemption limit reached for this cdkey"
    ]]
  ];

  for (const [code, patterns] of accountRules) {
    if (patterns.some(pattern => normalized.includes(pattern))) {
      return { scope: "account", code };
    }
  }

  return { scope: "account", code: "ACCOUNT_OR_UNKNOWN_FAILURE" };
}

async function redeemCode(baseUrl, authedHeaders, code) {
  const response = await fetch(`${baseUrl}/api/v2/store/redemption/redeem`, {
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
    const message = `兌換返回不是 JSON: ${text}`;
    return {
      success: false,
      message,
      data: null,
      ...classifyRedeemFailure(message)
    };
  }

  if (data.code === 1) {
    return {
      success: true,
      message: data.message || text,
      data,
      scope: null,
      code: "SUCCESS"
    };
  }

  const message = data.message || text;

  return {
    success: false,
    message,
    data,
    ...classifyRedeemFailure(message)
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
    throwOnError = false,
    workerLabel = null,
    itemNumber = null,
    totalItems = null
  } = options;

  const logPrefix =
    `[${workerLabel ?? "Main"}][${maskUid(uid)}]` +
    (itemNumber && totalItems ? `[${itemNumber}/${totalItems}]` : "");

  if (separator) {
    console.log(`\n========== UID: ${maskUid(uid)} ==========`);
  } else {
    console.log(`${indent}${logPrefix} 開始處理`);
  }

  try {
    const loginInfo = await login(uid, {
      device: "mobile",
      logLifecycle: false,
      ...loginOptions
    });

    console.log(`${indent}${logPrefix} 登錄成功 ✓ (${loginInfo.nickname}, ${loginInfo.system} mall)`);

    try {
      await reportLoginShow(loginInfo.baseUrl);
    } catch {
      // reporting 失敗不影響兌換
    }

    if (reportingDelayMs > 0) {
      await sleep(reportingDelayMs);
    }

    if (loginDelayMax > loginDelayMin) {
      await randomSleep(loginDelayMin, loginDelayMax);
    } else if (loginDelayMs > 0) {
      await sleep(loginDelayMs);
    }

    const result = await redeemCode(loginInfo.baseUrl, loginInfo.authedHeaders, code);

    if (result.success) {
      console.log(`${indent}${logPrefix} 兌換成功 ✓${separator ? ` (${code})` : ""}`);
    } else {
      console.error(`${indent}${logPrefix} 兌換失敗 [${result.scope}/${result.code}]: ${result.message}`);
    }

    return {
      ...result,
      uid,
      nickname: loginInfo.nickname
    };
  } catch (err) {
    if (throwOnError) throw err;

    console.error(`${indent}${logPrefix} 登錄/兌換流程失敗: ${err.message}`);

    return {
      success: false,
      uid,
      nickname: null,
      message: err.message,
      error: err,
      scope: "account",
      code: "LOGIN_OR_REQUEST_FAILURE"
    };
  }
}

export function isCodeWideFailure(result) {
  return Boolean(result && !result.success && result.scope === "global");
}

function buildSummary(uids, results, options = {}) {
  const attemptedResults = results.filter(Boolean);
  const attempted = attemptedResults.filter(item => !item.skipped).length;
  const skipped = attemptedResults.filter(item => item.skipped).length;

  return {
    total: uids.length,
    attempted,
    skipped,
    success: attemptedResults.filter(item => item.success).length,
    failed: attemptedResults.filter(item => !item.success && !item.skipped).length,
    stoppedEarly: Boolean(options.stoppedEarly),
    stopReason: options.stopReason || null,
    stopResult: options.stopResult || null,
    results: attemptedResults
  };
}

export async function redeemAllUids(code, uids, options = {}) {
  const {
    validateFirst = true,
    stopOnCodeWideFailure = true,
    beforeStart,
    onFirstFailure,
    afterComplete,
    concurrency = Number(process.env.REDEEM_CONCURRENCY || 2),
    staggerMs = Number(process.env.REDEEM_STAGGER_MS || 2000),
    accountDelayMin = 0,
    accountDelayMax = 0,
    redeemOptions = {},
    firstRedeemOptions = redeemOptions
  } = options;

  if (!Array.isArray(uids) || uids.length === 0) {
    return buildSummary([], []);
  }

  if (beforeStart) {
    await beforeStart({ code, uids });
  }

  const results = [];
  let remainingUids = uids;

  if (validateFirst) {
    const firstResult = await redeemForUid(uids[0], code, {
      ...firstRedeemOptions,
      workerLabel: "首個帳號",
      itemNumber: 1,
      totalItems: uids.length
    });
    results.push(firstResult);
    remainingUids = uids.slice(1);

    if (!firstResult.success && onFirstFailure) {
      await onFirstFailure({
        code,
        result: firstResult,
        codeWide: isCodeWideFailure(firstResult)
      });
    }

    if (stopOnCodeWideFailure && isCodeWideFailure(firstResult)) {
      console.log(`停止後續帳號：${firstResult.message}`);
      return buildSummary(uids, results, {
        stoppedEarly: true,
        stopReason: "code-wide-failure",
        stopResult: firstResult
      });
    }
  }

  if (remainingUids.length === 0) {
    const summary = buildSummary(uids, results);
    if (afterComplete) await afterComplete({ code, summary });
    return summary;
  }

  console.log(`其餘 ${remainingUids.length} 個帳號使用 ${concurrency} 並發兌換`);

  let globalStopResult = null;

  const concurrentResults = await runWithConcurrency(
    remainingUids,
    concurrency,
    async (uid, index, workerId) => {
      if (globalStopResult) {
        return {
          success: false,
          skipped: true,
          uid,
          nickname: null,
          scope: "global",
          code: "SKIPPED_AFTER_GLOBAL_FAILURE",
          message: `已因全局錯誤停止：${globalStopResult.message}`
        };
      }

      if (accountDelayMax > accountDelayMin) {
        await randomSleep(accountDelayMin, accountDelayMax);
      } else if (accountDelayMin > 0) {
        await sleep(accountDelayMin);
      }

      console.log(`Worker ${workerId} 開始處理第 ${index + 2}/${uids.length} 個帳號`);

      const result = await redeemForUid(uid, code, {
        ...redeemOptions,
        workerLabel: `Worker ${workerId}`,
        itemNumber: index + 2,
        totalItems: uids.length
      });

      if (
        stopOnCodeWideFailure &&
        isCodeWideFailure(result) &&
        !globalStopResult
      ) {
        globalStopResult = result;
        console.log(`偵測到全局錯誤，停止派發後續帳號：${result.message}`);
      }

      return result;
    },
    staggerMs
  );

  results.push(...concurrentResults);

  const summary = buildSummary(uids, results, {
    stoppedEarly: Boolean(globalStopResult),
    stopReason: globalStopResult ? "code-wide-failure" : null,
    stopResult: globalStopResult
  });

  if (afterComplete) {
    await afterComplete({ code, summary });
  }

  return summary;
}
