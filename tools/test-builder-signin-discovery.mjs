import fs from "node:fs";
import path from "node:path";

import {
  SITE_ID,
  DEBUG_UID,
} from "../core/config.mjs";

import { fetchJson } from "../core/api.mjs";
import { login } from "../core/auth.mjs";

import {
  logInfo,
  logOk,
  logWarn,
  logError,
} from "../core/logger.mjs";

import { maskUid } from "../core/utils.mjs";

/**
 * 测试目标：
 *
 * 1. 使用 DEBUG_UID 登录。
 * 2. 从 site/builder/info 自动提取所有 activity_id / biz_id。
 * 3. 对每个候选 ID 调用 sign-in-list。
 * 4. 自动识别真正的签到活动。
 *
 * 本脚本只发送 GET 请求。
 * 不会调用 sign-in/gift/receive，不会真正签到。
 */

const STORE_BASE =
  "https://store.topheroes.com";

const KOP_STORE_BASE =
  "https://topheroes.store.kopglobal.com";

const BUILDER_INFO_URL =
  `${STORE_BASE}` +
  `/api/v2/store/site/builder/info` +
  `?site_builder_id=${SITE_ID}`;

const delay = ms =>
  new Promise(resolve =>
    setTimeout(resolve, ms)
  );

/**
 * builder/info 内部可能包含：
 *
 * {
 *   "activity_id": 1113212
 * }
 *
 * 也可能是转义后的 JSON 字符串：
 *
 * "{\"activity_id\":1113212}"
 *
 * 所以直接扫描完整 JSON 文本最稳。
 */
function extractCandidateIds(payload) {
  const text = JSON.stringify(payload);

  const ids = [];
  const seen = new Set();

  const pattern =
    /(?:activity_id|activityId|biz_id|bizId)[^0-9]{0,40}(\d{4,})/g;

  for (const match of text.matchAll(pattern)) {
    const id = Number(match[1]);

    if (
      !Number.isInteger(id) ||
      id <= 0 ||
      seen.has(id)
    ) {
      continue;
    }

    seen.add(id);
    ids.push(id);
  }

  return ids;
}

function getSignedDays(list) {
  return list
    .filter(item =>
      item.is_sign_in === true
    )
    .map(item => item.day_no);
}

function getAvailableDays(list) {
  return list
    .filter(item =>
      item.is_available_sign_in === true &&
      item.is_sign_in !== true &&
      item.is_appending !== true
    )
    .map(item => item.day_no);
}

function getMakeupDays(list) {
  return list
    .filter(item =>
      item.is_appending === true &&
      item.is_sign_in !== true
    )
    .map(item => item.day_no);
}

function getExpiredDays(list) {
  return list
    .filter(item =>
      item.is_expired === true
    )
    .map(item => item.day_no);
}

/**
 * 在单个域名上验证一个候选 ID。
 */
async function probeAtBase(
  baseUrl,
  baseName,
  authedHeaders,
  activityId
) {
  const url =
    `${baseUrl}` +
    `/api/v2/store/sale/biz/sign-in-list` +
    `?page_size=365` +
    `&site_id=${SITE_ID}` +
    `&page_no=1` +
    `&activity_id=${activityId}`;

  try {
    const response = await fetchJson(
      url,
      {
        headers: authedHeaders,
      },
      0
    );

    const data = response?.data;
    const list = data?.sign_in_list;

    const returnedId =
      Number(data?.activity_id || 0);

    const hasList =
      Array.isArray(list) &&
      list.length > 0;

    const idMatches =
      returnedId === activityId;

    const isSignInActivity =
      response?.code === 1 &&
      hasList &&
      idMatches;

    const allExpired =
      isSignInActivity &&
      list.every(item =>
        item.is_expired === true
      );

    const active =
      isSignInActivity &&
      !allExpired;

    return {
      activityId,
      baseName,
      url,
      code: response?.code,
      returnedId,
      isSignInActivity,
      active,
      allExpired,
      days: hasList
        ? list.length
        : 0,
      signedDays: hasList
        ? getSignedDays(list)
        : [],
      availableDays: hasList
        ? getAvailableDays(list)
        : [],
      makeupDays: hasList
        ? getMakeupDays(list)
        : [],
      expiredDays: hasList
        ? getExpiredDays(list)
        : [],
      hasSignInDays:
        data?.has_sign_in_days,
      remainAppendingDays:
        data?.remain_appending_days,
      message:
        response?.message || "",
      response,
    };
  } catch (error) {
    return {
      activityId,
      baseName,
      url,
      isSignInActivity: false,
      active: false,
      error: error.message,
    };
  }
}

/**
 * store.topheroes.com 优先。
 *
 * 如果该域名验证失败，再尝试 KOP 域名。
 */
async function probeCandidate(
  authedHeaders,
  activityId
) {
  const primary = await probeAtBase(
    STORE_BASE,
    "store.topheroes.com",
    authedHeaders,
    activityId
  );

  if (primary.isSignInActivity) {
    return primary;
  }

  await delay(150);

  const fallback = await probeAtBase(
    KOP_STORE_BASE,
    "topheroes.store.kopglobal.com",
    authedHeaders,
    activityId
  );

  if (fallback.isSignInActivity) {
    return fallback;
  }

  return {
    ...primary,
    fallbackError:
      fallback.error ||
      fallback.message ||
      "",
    fallbackCode:
      fallback.code,
  };
}

function printCandidateTable(ids) {
  console.log(
    "\n=== builder/info 提取到的候选 ID ==="
  );

  console.table(
    ids.map((id, index) => ({
      order: index + 1,
      activity_id: id,
    }))
  );
}

function printProbeTable(results) {
  console.log(
    "\n=== sign-in-list 验证结果 ==="
  );

  console.table(
    results.map(result => ({
      activity_id:
        result.activityId,
      domain:
        result.baseName || "",
      code:
        result.code ?? "",
      returned_id:
        result.returnedId ?? "",
      signin:
        result.isSignInActivity
          ? "YES"
          : "NO",
      active:
        result.active
          ? "YES"
          : "NO",
      all_expired:
        result.allExpired
          ? "YES"
          : "",
      days:
        result.days ?? "",
      signed:
        result.signedDays?.join(",") ||
        "",
      available:
        result.availableDays?.join(",") ||
        "",
      makeup:
        result.makeupDays?.join(",") ||
        "",
      error:
        result.error ||
        result.message ||
        result.fallbackError ||
        "",
    }))
  );
}

async function main() {
  logInfo(
    "Builder sign-in discovery test started"
  );

  if (!DEBUG_UID) {
    throw new Error(
      "请先在 core/config.mjs 中设置 DEBUG_UID"
    );
  }

  logInfo(
    `测试 UID: ${maskUid(DEBUG_UID)}`
  );

  /**
   * 浏览器是否登录不重要。
   * 此处由程序自己登录 DEBUG_UID。
   */
  const loginInfo = await login(
    DEBUG_UID,
    {
      maxRetries: 1,
    }
  );

  logOk(
    `登录成功：${loginInfo.nickname}`
  );

  logInfo(
    `读取 builder/info：${BUILDER_INFO_URL}`
  );

  const builderInfo = await fetchJson(
    BUILDER_INFO_URL,
    {
      headers:
        loginInfo.authedHeaders,
    },
    0
  );

  const candidateIds =
    extractCandidateIds(builderInfo);

  if (candidateIds.length === 0) {
    throw new Error(
      "builder/info 中没有提取到任何活动 ID"
    );
  }

  logOk(
    `builder/info 提取到 ` +
    `${candidateIds.length} 个候选 ID`
  );

  printCandidateTable(candidateIds);

  const results = [];

  for (
    let index = 0;
    index < candidateIds.length;
    index++
  ) {
    const activityId =
      candidateIds[index];

    logInfo(
      `验证第 ${index + 1}/` +
      `${candidateIds.length} 个候选：` +
      `${activityId}`
    );

    const result =
      await probeCandidate(
        loginInfo.authedHeaders,
        activityId
      );

    results.push(result);

    if (
      result.isSignInActivity &&
      result.active
    ) {
      logOk(
        `确认有效签到活动：${activityId}`
      );
    } else if (
      result.isSignInActivity &&
      result.allExpired
    ) {
      logWarn(
        `签到活动已全部过期：${activityId}`
      );
    } else {
      logInfo(
        `不是签到活动：${activityId}`
      );
    }

    await delay(200);
  }

  printProbeTable(results);

  const validSignIns =
    results.filter(result =>
      result.isSignInActivity &&
      result.active
    );

  const expiredSignIns =
    results.filter(result =>
      result.isSignInActivity &&
      result.allExpired
    );

  console.log(
    "\n=== 自动发现结果 ==="
  );

  console.table(
    validSignIns.map(result => ({
      activity_id:
        result.activityId,
      domain:
        result.baseName,
      days:
        result.days,
      signed:
        result.signedDays.join(","),
      available:
        result.availableDays.join(","),
      makeup:
        result.makeupDays.join(","),
    }))
  );

  fs.mkdirSync("runtime", {
    recursive: true,
  });

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-");

  const reportPath = path.join(
    "runtime",
    `builder-signin-discovery-${stamp}.json`
  );

  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        generatedAt:
          new Date().toISOString(),
        uid: maskUid(DEBUG_UID),
        nickname:
          loginInfo.nickname,
        builderInfoUrl:
          BUILDER_INFO_URL,
        candidateIds,
        validSignInIds:
          validSignIns.map(
            result =>
              result.activityId
          ),
        expiredSignInIds:
          expiredSignIns.map(
            result =>
              result.activityId
          ),
        results,
      },
      null,
      2
    )
  );

  logOk(
    `测试报告已保存：${reportPath}`
  );

  if (validSignIns.length === 0) {
    throw new Error(
      "没有验证到当前有效的签到活动"
    );
  }

  logOk(
    `自动发现并验证有效签到活动：` +
    validSignIns
      .map(result =>
        result.activityId
      )
      .join(", ")
  );

  logWarn(
    "本脚本没有执行签到，" +
    "只完成了自动发现和验证。"
  );
}

main().catch(error => {
  logError(
    `Builder sign-in discovery test failed: ` +
    error.message
  );

  process.exit(1);
});