import fs from "node:fs";
import path from "node:path";

import {
  BASE,
  SITE_ID,
  PROJECT_ID,
  DEBUG_UID,
} from "../core/config.mjs";

import { fetchJson } from "../core/api.mjs";
import { login } from "../core/auth.mjs";
import { sleep } from "../core/sleep.mjs";
import {
  logInfo,
  logOk,
  logError,
} from "../core/logger.mjs";
import { maskUid } from "../core/utils.mjs";

/**
 * 旧商城 API 域名。
 * 当前 core/config.mjs 里的 BASE 应该是：
 * https://topheroes.pay-store.rivergame.net
 */
const OLD_STORE_BASE = BASE;

/**
 * 网页目前实际使用的新商城 API 域名。
 */
const NEW_STORE_BASE = "https://store.topheroes.com";

/**
 * 当活动列表接口返回空时，直接探测已知活动。
 * 这里只查询签到状态，不会执行签到。
 */
const KNOWN_ACTIVITY_IDS = [3431];

/**
 * 兼容不同活动列表返回结构。
 */
function extractActivityList(response) {
  const possibleLists = [
    response?.data?.list,
    response?.data?.data,
    response?.list,
  ];

  for (const value of possibleLists) {
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
}

/**
 * 合并不同接口返回的活动，按照 biz_id 去重。
 */
function mergeActivities(lists) {
  const activityMap = new Map();

  for (const list of lists) {
    if (!Array.isArray(list)) {
      continue;
    }

    for (const activity of list) {
      const activityId = Number(
        activity?.biz_id ??
        activity?.activity_id ??
        activity?.id ??
        0
      );

      if (!activityId) {
        continue;
      }

      const oldActivity = activityMap.get(activityId) || {};

      activityMap.set(activityId, {
        ...oldActivity,
        ...activity,
        biz_id:
          activity?.biz_id ??
          activity?.activity_id ??
          activity?.id ??
          activityId,
      });
    }
  }

  return [...activityMap.values()];
}

/**
 * 测试旧域名和新域名的活动列表接口。
 */
async function getActivities(authedHeaders) {
  const requests = [
    // 旧域名
    {
      name: "old-domain-status=2",
      domain: "old",
      url:
        `${OLD_STORE_BASE}/api/v2/store/sale/biz/list` +
        `?project_id=${PROJECT_ID}&status=2`,
    },
    {
      name: "old-domain-no-status",
      domain: "old",
      url:
        `${OLD_STORE_BASE}/api/v2/store/sale/biz/list` +
        `?project_id=${PROJECT_ID}`,
    },
    {
      name: "old-domain-status=1",
      domain: "old",
      url:
        `${OLD_STORE_BASE}/api/v2/store/sale/biz/list` +
        `?project_id=${PROJECT_ID}&status=1`,
    },
    {
      name: "old-domain-status=0",
      domain: "old",
      url:
        `${OLD_STORE_BASE}/api/v2/store/sale/biz/list` +
        `?project_id=${PROJECT_ID}&status=0`,
    },
    {
      name: "old-domain-status=2-site-id",
      domain: "old",
      url:
        `${OLD_STORE_BASE}/api/v2/store/sale/biz/list` +
        `?project_id=${PROJECT_ID}` +
        `&site_id=${SITE_ID}` +
        `&status=2`,
    },

    // 新域名
    {
      name: "new-domain-status=2",
      domain: "new",
      url:
        `${NEW_STORE_BASE}/api/v2/store/sale/biz/list` +
        `?project_id=${PROJECT_ID}&status=2`,
    },
    {
      name: "new-domain-no-status",
      domain: "new",
      url:
        `${NEW_STORE_BASE}/api/v2/store/sale/biz/list` +
        `?project_id=${PROJECT_ID}`,
    },
    {
      name: "new-domain-status=1",
      domain: "new",
      url:
        `${NEW_STORE_BASE}/api/v2/store/sale/biz/list` +
        `?project_id=${PROJECT_ID}&status=1`,
    },
    {
      name: "new-domain-status=0",
      domain: "new",
      url:
        `${NEW_STORE_BASE}/api/v2/store/sale/biz/list` +
        `?project_id=${PROJECT_ID}&status=0`,
    },
    {
      name: "new-domain-status=2-site-id",
      domain: "new",
      url:
        `${NEW_STORE_BASE}/api/v2/store/sale/biz/list` +
        `?project_id=${PROJECT_ID}` +
        `&site_id=${SITE_ID}` +
        `&status=2`,
    },
  ];

  const rawResults = [];
  const activityLists = [];

  for (const request of requests) {
    logInfo(`测试活动列表接口: ${request.name}`);
    logInfo(request.url);

    try {
      const response = await fetchJson(request.url, {
        headers: authedHeaders,
      });

      const list = extractActivityList(response);

      activityLists.push(list);

      rawResults.push({
        name: request.name,
        domain: request.domain,
        url: request.url,
        count: list.length,
        total:
          response?.data?.total ??
          response?.total ??
          null,
        response,
      });

      logInfo(
        `${request.name} 返回活动数量: ${list.length}; ` +
        `原始 total: ${
          response?.data?.total ??
          response?.total ??
          "unknown"
        }`
      );
    } catch (error) {
      rawResults.push({
        name: request.name,
        domain: request.domain,
        url: request.url,
        error: error.message,
      });

      logError(
        `${request.name} 请求失败: ${error.message}`
      );
    }

    await sleep(300);
  }

  return {
    activities: mergeActivities(activityLists),
    rawResults,
  };
}

/**
 * 在指定域名查询某个签到活动。
 */
async function probeSignInOnBase(
  authedHeaders,
  activityId,
  baseUrl,
  baseName
) {
  const url =
    `${baseUrl}/api/v2/store/sale/biz/sign-in-list` +
    `?page_size=365` +
    `&site_id=${SITE_ID}` +
    `&page_no=1` +
    `&activity_id=${activityId}`;

  try {
    const response = await fetchJson(url, {
      headers: authedHeaders,
    });

    const signInList = response?.data?.sign_in_list;

    return {
      base_name: baseName,
      base_url: baseUrl,
      url,
      ok:
        Array.isArray(signInList) &&
        signInList.length > 0,
      code: response?.code,
      message: response?.message,
      returned_activity_id:
        response?.data?.activity_id,
      days:
        Array.isArray(signInList)
          ? signInList.length
          : 0,
      sign_in_list_total:
        response?.data?.sign_in_list_total,
      has_sign_in_days:
        response?.data?.has_sign_in_days,
      remain_appending_days:
        response?.data?.remain_appending_days,
      available_days:
        Array.isArray(signInList)
          ? signInList
              .filter(
                item =>
                  item.is_available_sign_in === true &&
                  item.is_sign_in !== true
              )
              .map(item => item.day_no)
          : [],
      signed_days:
        Array.isArray(signInList)
          ? signInList
              .filter(
                item => item.is_sign_in === true
              )
              .map(item => item.day_no)
          : [],
      response,
    };
  } catch (error) {
    return {
      base_name: baseName,
      base_url: baseUrl,
      url,
      ok: false,
      error: error.message,
    };
  }
}

/**
 * 同时测试新旧两个域名的签到详情。
 */
async function probeSignInActivity(
  authedHeaders,
  activity
) {
  const activityId = Number(
    activity?.biz_id ??
    activity?.activity_id ??
    activity?.id ??
    0
  );

  const attempts = [];

  logInfo(
    `Probe ${activityId} on new domain`
  );

  const newDomainResult = await probeSignInOnBase(
    authedHeaders,
    activityId,
    NEW_STORE_BASE,
    "new-domain"
  );

  attempts.push(newDomainResult);

  await sleep(300);

  logInfo(
    `Probe ${activityId} on old domain`
  );

  const oldDomainResult = await probeSignInOnBase(
    authedHeaders,
    activityId,
    OLD_STORE_BASE,
    "old-domain"
  );

  attempts.push(oldDomainResult);

  const selectedResult =
    attempts.find(item => item.ok === true) ||
    attempts[0];

  return {
    ...selectedResult,
    attempts,
  };
}

function compactActivity(activity, probe) {
  return {
    biz_id: activity.biz_id,
    name: activity.name,
    activity_type: activity.activity_type,
    status: activity.status,
    activity_switch: activity.activity_switch,
    start_time: activity.start_time,
    stop_time: activity.stop_time,
    cycle_stop_time: activity.cycle_stop_time,
    end_time: activity.end_time,
    sort: activity.sort,
    display_order: activity.display_order,
    site_id: activity.site_id,
    project_id: activity.project_id,
    sign_in_total_days:
      activity?.rule?.sign_in_total_days ??
      activity?.sign_in_total_days,
    probe,
  };
}

function toMilliseconds(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return 0;
  }

  const numericValue = Number(value);

  if (Number.isFinite(numericValue)) {
    return numericValue < 1_000_000_000_000
      ? numericValue * 1000
      : numericValue;
  }

  const parsedValue = Date.parse(value);

  return Number.isFinite(parsedValue)
    ? parsedValue
    : 0;
}

function scoreCandidate(activity) {
  const now = Date.now();

  const start = toMilliseconds(
    activity.start_time
  );

  const stop = toMilliseconds(
    activity.stop_time ??
    activity.cycle_stop_time ??
    activity.end_time
  );

  const inTimeRange =
    (!start || now >= start) &&
    (!stop || now <= stop);

  const probeOk = activity.probe?.ok
    ? 1
    : 0;

  const signedDays = Number(
    activity.probe?.has_sign_in_days || 0
  );

  const availableDays =
    activity.probe?.available_days?.length || 0;

  return (
    probeOk * 100000 +
    (inTimeRange ? 10000 : 0) +
    (availableDays > 0 ? 1000 : 0) +
    (signedDays > 0 ? 500 : 0) +
    Number(activity.biz_id || 0)
  );
}

async function main() {
  logInfo("Debug activities started");

  if (!DEBUG_UID) {
    throw new Error(
      "请先在 core/config.mjs 里面设置 DEBUG_UID"
    );
  }

  logInfo(
    `使用 UID: ${maskUid(DEBUG_UID)}`
  );

  const loginInfo = await login(DEBUG_UID, {
    maxRetries: 1,
  });

  logOk(
    `登入成功: ${loginInfo.nickname}`
  );

  fs.mkdirSync("runtime", {
    recursive: true,
  });

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-");

  const {
    activities,
    rawResults,
  } = await getActivities(
    loginInfo.authedHeaders
  );

  const rawPath = path.join(
    "runtime",
    `activities-list-raw-${stamp}.json`
  );

  fs.writeFileSync(
    rawPath,
    JSON.stringify(rawResults, null, 2)
  );

  logOk(
    `活动列表原始响应已输出: ${rawPath}`
  );

  logInfo(
    `合并后活动总数: ${activities.length}`
  );

  const signInCandidates = activities
    .filter(
      activity =>
        Number(activity.activity_type) === 4
    )
    .sort(
      (a, b) =>
        Number(b.biz_id || 0) -
        Number(a.biz_id || 0)
    );

  logInfo(
    `签到候选 activity_type=4: ${signInCandidates.length}`
  );

  const activityMap = new Map();

  for (const activity of signInCandidates) {
    activityMap.set(
      Number(activity.biz_id),
      activity
    );
  }

  /**
   * 如果活动列表全部为空，
   * 仍然直接测试已知活动 3431。
   */
  for (const activityId of KNOWN_ACTIVITY_IDS) {
    if (!activityMap.has(activityId)) {
      activityMap.set(activityId, {
        biz_id: activityId,
        name: `Known activity ${activityId}`,
        activity_type: 4,
      });
    }
  }

  const probedActivities = [];

  for (const activity of activityMap.values()) {
    logInfo(
      `开始 Probe ${activity.biz_id} ${activity.name || ""}`
    );

    const probe = await probeSignInActivity(
      loginInfo.authedHeaders,
      activity
    );

    probedActivities.push(
      compactActivity(activity, probe)
    );

    await sleep(500);
  }

  const ranked = [...probedActivities].sort(
    (a, b) =>
      scoreCandidate(b) -
      scoreCandidate(a)
  );

  console.log(
    "\n=== Ranked sign-in candidates ==="
  );

  console.table(
    ranked.map(activity => ({
      score: scoreCandidate(activity),
      biz_id: activity.biz_id,
      name: activity.name,
      ok: activity.probe?.ok,
      source:
        activity.probe?.base_name ?? "",
      days:
        activity.probe?.days ?? "",
      returned_id:
        activity.probe?.returned_activity_id ??
        "",
      total:
        activity.probe?.sign_in_list_total ??
        "",
      has:
        activity.probe?.has_sign_in_days ??
        "",
      signed:
        activity.probe?.signed_days?.join(",") ??
        "",
      available:
        activity.probe?.available_days?.join(",") ??
        "",
      status:
        activity.status ?? "",
      switch:
        activity.activity_switch ?? "",
      start_time:
        activity.start_time ?? "",
      stop_time:
        activity.stop_time ??
        activity.cycle_stop_time ??
        activity.end_time ??
        "",
      message:
        activity.probe?.message ||
        activity.probe?.error ||
        "",
    }))
  );

  console.log(
    "\n=== Domain comparison ==="
  );

  for (const activity of ranked) {
    console.log(
      `\nActivity ${activity.biz_id} ${activity.name || ""}`
    );

    console.table(
      (activity.probe?.attempts || []).map(
        attempt => ({
          domain: attempt.base_name,
          ok: attempt.ok,
          days: attempt.days ?? "",
          returned_id:
            attempt.returned_activity_id ?? "",
          total:
            attempt.sign_in_list_total ?? "",
          has:
            attempt.has_sign_in_days ?? "",
          signed:
            attempt.signed_days?.join(",") ??
            "",
          available:
            attempt.available_days?.join(",") ??
            "",
          message:
            attempt.message ||
            attempt.error ||
            "",
        })
      )
    );
  }

  const fullPath = path.join(
    "runtime",
    `activities-full-${stamp}.json`
  );

  const probedPath = path.join(
    "runtime",
    `activities-probed-${stamp}.json`
  );

  fs.writeFileSync(
    fullPath,
    JSON.stringify(activities, null, 2)
  );

  fs.writeFileSync(
    probedPath,
    JSON.stringify(
      probedActivities,
      null,
      2
    )
  );

  logOk(
    `完整活动 JSON 已输出: ${fullPath}`
  );

  logOk(
    `Probe 结果已输出: ${probedPath}`
  );

  if (activities.length === 0) {
    logInfo(
      "⚠️ 所有活动列表查询都返回空，但已经直接 Probe 活动 3431。"
    );
  }
}

main().catch(error => {
  logError(
    `Debug activities failed: ${error.message}`
  );

  process.exit(1);
});