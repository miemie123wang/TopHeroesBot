import {
  SITE_ID,
  DEBUG_UID,
} from "../core/config.mjs";

import { fetchJson } from "../core/api.mjs";
import { loginAtBase } from "../core/auth.mjs";
import { randomSleep } from "../core/sleep.mjs";
import {
  logInfo,
  logOk,
  logWarn,
  logError,
} from "../core/logger.mjs";

import {
  maskUid,
  getTodayDateString,
} from "../core/utils.mjs";

/**
 * 本地签到入口测试
 *
 * 用法：
 *
 * 1. 自动发现，只检查：
 *    node tools/test-signin-entry.mjs auto
 *
 * 2. 手动指定活动，只检查：
 *    node tools/test-signin-entry.mjs <activity_id>
 *
 * 3. 手动指定活动，实际签到：
 *    node tools/test-signin-entry.mjs <activity_id> --execute
 *
 * 4. 自动发现，实际签到：
 *    node tools/test-signin-entry.mjs auto --execute
 *
 * 只会处理 core/config.mjs 里的 DEBUG_UID。
 * 不会读取 Approved UID，不会处理全部账号。
 */

const STORE_BASE = "https://store.topheroes.com";

const args = process.argv.slice(2);

const execute = args.includes("--execute");

const modeArg =
  args.find(arg => !arg.startsWith("--")) ||
  "auto";

function isAutoMode() {
  return modeArg.toLowerCase() === "auto";
}

function normalizeHeaders(headers) {
  if (typeof headers?.entries === "function") {
    return Object.fromEntries(
      [...headers.entries()].map(([name, value]) => [
        String(name).toLowerCase(),
        value,
      ])
    );
  }

  return Object.fromEntries(
    Object.entries(headers || {}).map(([name, value]) => [
      String(name).toLowerCase(),
      value,
    ])
  );
}

function buildSigninHeaders(authedHeaders) {
  const headers = normalizeHeaders(authedHeaders);
  const authorization = headers.authorization;

  if (!authorization) {
    throw new Error("登录结果中没有 Authorization");
  }

  return {
    ...headers,
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    "cache-control": "no-cache, no-store, max-age=0",
    pragma: "no-cache",
    origin: STORE_BASE,
    referer: `${STORE_BASE}/en`,
    cookie: [
      "lang=en",
      `site-token=${encodeURIComponent(authorization)}`,
    ].join("; "),
  };
}

function extractBuilderActivityIds(payload) {
  const text = JSON.stringify(payload);
  const pattern =
    /(?:activity_id|activityId|biz_id|bizId)[^0-9]{0,40}(\d{4,})/g;
  const ids = new Set();

  for (const match of text.matchAll(pattern)) {
    const id = Number(match[1]);

    if (Number.isInteger(id) && id > 0) {
      ids.add(id);
    }
  }

  return [...ids];
}

function parseManualActivityId() {
  if (isAutoMode()) {
    return null;
  }

  const activityId = Number(modeArg);

  if (
    !Number.isInteger(activityId) ||
    activityId <= 0
  ) {
    throw new Error(
      `无效的 Activity ID: ${modeArg}`
    );
  }

  return activityId;
}

/**
 * Discover activities from the same builder configuration used by production.
 */
async function discoverActivities(
  authedHeaders
) {
  const builderInfoUrl =
    `${STORE_BASE}/api/v2/store/site/builder/info` +
    `?site_builder_id=${SITE_ID}`;

  logInfo(`读取当前商城活动配置：${builderInfoUrl}`);

  const builderInfo = await fetchJson(
    builderInfoUrl,
    { headers: buildSigninHeaders(authedHeaders) },
    0
  );

  const activityIds = extractBuilderActivityIds(builderInfo);

  if (activityIds.length === 0) {
    throw new Error("builder/info 中没有找到活动 ID");
  }

  logInfo(`builder/info 找到 ${activityIds.length} 个候选活动`);

  const activities = [];

  for (const activityId of activityIds) {
    try {
      const signInData = await getSignInData(
        authedHeaders,
        activityId
      );
      const signInList = signInData.sign_in_list;

      if (signInList.every(item => item?.is_expired === true)) {
        logInfo(`排除已过期签到活动 ${activityId}`);
        continue;
      }

      activities.push({
        id: activityId,
        name: `签到活动 ${activityId}`,
        source: "builder-info",
      });
      logOk(`确认有效签到活动：${activityId}`);
    } catch (error) {
      logInfo(`排除候选活动 ${activityId}：${error.message}`);
    }
  }

  if (activities.length === 0) {
    throw new Error("builder/info 候选中没有验证到有效签到活动");
  }

  return activities;
}

function buildManualActivity(activityId) {
  return {
    id: activityId,
    name: `手动活动 ${activityId}`,
    source: "manual",
    startTime: 0,
  };
}

/**
 * 获取某个账号在指定活动中的签到状态。
 *
 * 手动活动不强制必须是 7 天；
 * 只要求活动 ID 正确，并且返回签到列表。
 */
async function getSignInData(
  authedHeaders,
  activityId
) {
  const url =
    `${STORE_BASE}` +
    `/api/v2/store/sale/biz/sign-in-list` +
    `?activity_id=${activityId}` +
    `&page_size=365` +
    `&site_id=${SITE_ID}` +
    `&page_no=1`;

  const data = await fetchJson(
    url,
    {
      headers: buildSigninHeaders(authedHeaders),
    },
    0
  );

  if (Number(data?.code) !== 1) {
    throw new Error(
      `读取签到活动失败: ${data?.message || JSON.stringify(data)}`
    );
  }

  const signInData = data?.data;

  const signInList =
    signInData?.sign_in_list;

  if (!Array.isArray(signInList)) {
    throw new Error(
      `没有签到资料: ` +
      JSON.stringify(data).slice(0, 1000)
    );
  }

  if (
    Number(signInData.activity_id) !==
    Number(activityId)
  ) {
    throw new Error(
      `签到活动 ID 验证失败：` +
      `requested=${activityId}, ` +
      `returned=${signInData.activity_id}`
    );
  }

  if (signInList.length === 0) {
    throw new Error(
      `签到列表为空: activity_id=${activityId}`
    );
  }

  return signInData;
}

function printSignInStatus(
  activity,
  signInData
) {
  console.log(
    `\n=== ${activity.name} / ${activity.id} ===`
  );

  console.log(
    `source: ${activity.source}`
  );

  console.log(
    `has_sign_in_days: ` +
    `${signInData.has_sign_in_days}`
  );

  console.log(
    `sign_in_list_total: ` +
    `${signInData.sign_in_list_total}`
  );

  console.log(
    `remain_appending_days: ` +
    `${signInData.remain_appending_days}`
  );

  console.table(
    signInData.sign_in_list.map(item => ({
      day: item.day_no,
      signed: Boolean(item.is_sign_in),
      available:
        Boolean(
          item.is_available_sign_in
        ),
      appending:
        Boolean(item.is_appending),
      expired:
        Boolean(item.is_expired),
    }))
  );
}

function getMakeupItems(signInList) {
  return signInList.filter(
    item =>
      item.is_appending === true &&
      item.is_sign_in !== true
  );
}

function getTodayItem(signInList) {
  return signInList.find(
    item =>
      item.is_available_sign_in === true &&
      item.is_sign_in !== true &&
      item.is_appending !== true
  );
}

async function receiveMakeupSignIn(
  authedHeaders,
  activityId,
  item
) {
  const data = await fetchJson(
    `${STORE_BASE}` +
    `/api/v2/store/sale/biz/` +
    `sign-in/gift/receive`,
    {
      method: "POST",
      headers: buildSigninHeaders(authedHeaders),
      body: JSON.stringify({
        activity_id: activityId,
        sign_in_type: 2,
        site_id: SITE_ID,
        day_no: item.day_no,
        appending_date:
          getTodayDateString(),
      }),
    }
  );

  if (data?.code !== 1) {
    throw new Error(
      `补签失败: ${JSON.stringify(data)}`
    );
  }

  return data;
}

async function receiveTodaySignIn(
  authedHeaders,
  activityId
) {
  const data = await fetchJson(
    `${STORE_BASE}` +
    `/api/v2/store/sale/biz/` +
    `sign-in/gift/receive`,
    {
      method: "POST",
      headers: buildSigninHeaders(authedHeaders),
      body: JSON.stringify({
        activity_id: activityId,
        sign_in_type: 1,
        site_id: SITE_ID,
      }),
    }
  );

  if (data?.code !== 1) {
    throw new Error(
      `今天签到失败: ` +
      JSON.stringify(data)
    );
  }

  return data;
}

/**
 * 对 DEBUG_UID 执行一个活动。
 *
 * 未加 --execute 时只查询，不发送 POST。
 */
async function processActivity(
  nickname,
  authedHeaders,
  activity
) {
  logInfo(
    `检查活动：` +
    `${activity.name} / ${activity.id}`
  );

  let signInData =
    await getSignInData(
      authedHeaders,
      activity.id
    );

  printSignInStatus(
    activity,
    signInData
  );

  if (!execute) {
    logWarn(
      "当前是检查模式，不会执行签到。"
    );

    return {
      activity,
      executed: false,
    };
  }

  logWarn(
    "当前是执行模式，将实际提交签到。"
  );

  let makeupCount = 0;

  /**
   * 安全限制，避免接口状态不更新时无限循环。
   */
  const maxMakeupAttempts =
    signInData.sign_in_list.length + 2;

  while (makeupCount < maxMakeupAttempts) {
    const makeupItems =
      getMakeupItems(
        signInData.sign_in_list
      );

    if (
      makeupItems.length === 0 ||
      Number(
        signInData.remain_appending_days
      ) <= 0
    ) {
      break;
    }

    const item = makeupItems[0];

    logInfo(
      `开始补签 day ${item.day_no}`
    );

    await receiveMakeupSignIn(
      authedHeaders,
      activity.id,
      item
    );

    makeupCount++;

    logOk(
      `补签成功 day ${item.day_no}`
    );

    await randomSleep(1500, 3000);

    signInData =
      await getSignInData(
        authedHeaders,
        activity.id
      );
  }

  if (
    makeupCount >= maxMakeupAttempts
  ) {
    throw new Error(
      `补签循环超过安全限制：` +
      `${maxMakeupAttempts}`
    );
  }

  const today =
    getTodayItem(
      signInData.sign_in_list
    );

  let todaySigned = false;

  if (today) {
    logInfo(
      `开始今天签到 day ${today.day_no}`
    );

    await receiveTodaySignIn(
      authedHeaders,
      activity.id
    );

    todaySigned = true;

    logOk(
      `今天签到成功 day ${today.day_no}`
    );

    await randomSleep(1500, 3000);
  } else {
    logInfo(
      "当前没有可执行的今天签到项"
    );
  }

  const finalData =
    await getSignInData(
      authedHeaders,
      activity.id
    );

  console.log(
    "\n=== 执行后的最终状态 ==="
  );

  printSignInStatus(
    activity,
    finalData
  );

  return {
    activity,
    executed: true,
    nickname,
    makeupCount,
    todaySigned,
  };
}

async function main() {
  logInfo(
    "Local sign-in entry test started"
  );

  if (!DEBUG_UID) {
    throw new Error(
      "请先在 core/config.mjs 设置 DEBUG_UID"
    );
  }

  logInfo(
    `测试 UID: ${maskUid(DEBUG_UID)}`
  );

  logInfo(
    `模式: ` +
    `${isAutoMode() ? "自动发现" : "手动活动"}`
  );

  logInfo(
    `执行签到: ${execute ? "是" : "否"}`
  );

  const loginInfo = await loginAtBase(
    DEBUG_UID,
    STORE_BASE
  );

  logOk(
    `登录成功：${loginInfo.nickname}`
  );

  let activities;

  if (isAutoMode()) {
    activities =
      await discoverActivities(
        loginInfo.authedHeaders
      );
  } else {
    const manualActivityId =
      parseManualActivityId();

    activities = [
      buildManualActivity(
        manualActivityId
      ),
    ];
  }

  console.log(
    "\n=== 本次候选活动 ==="
  );

  console.table(
    activities.map(activity => ({
      id: activity.id,
      name: activity.name,
      source: activity.source,
    }))
  );

  const successes = [];
  const failures = [];

  for (const activity of activities) {
    try {
      const result =
        await processActivity(
          loginInfo.nickname,
          loginInfo.authedHeaders,
          activity
        );

      successes.push(result);

      logOk(
        `活动测试成功：` +
        `${activity.name} / ${activity.id}`
      );
    } catch (error) {
      failures.push({
        activity,
        error: error.message,
      });

      logError(
        `活动测试失败：` +
        `${activity.name} / ${activity.id}\n` +
        `原因: ${error.message}`
      );
    }
  }

  console.log(
    "\n=== 测试结果 ==="
  );

  console.table([
    ...successes.map(result => ({
      activity_id:
        result.activity.id,
      source:
        result.activity.source,
      result: "success",
      executed:
        result.executed,
      makeup:
        result.makeupCount ?? "",
      today:
        result.todaySigned ?? "",
      error: "",
    })),
    ...failures.map(result => ({
      activity_id:
        result.activity.id,
      source:
        result.activity.source,
      result: "failed",
      executed: execute,
      makeup: "",
      today: "",
      error: result.error,
    })),
  ]);

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  logError(
    `Local sign-in entry test failed: ` +
    error.message
  );

  process.exit(1);
});