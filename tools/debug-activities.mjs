import fs from "node:fs";
import path from "node:path";

import {
  OLD_BASE,
  NEW_BASE,
  SITE_ID,
  PROJECT_ID,
  MERCHANT_ID,
  DEBUG_UID,
} from "../core/config.mjs";

import { fetchJson } from "../core/api.mjs";
import { login } from "../core/auth.mjs";
import { sleep } from "../core/sleep.mjs";
import {
  logInfo,
  logOk,
  logWarn,
  logError,
} from "../core/logger.mjs";
import { maskUid } from "../core/utils.mjs";

/**
 * 目的：
 *
 * 1. 正常登录，取得带账号身份的请求头。
 * 2. 探测多个商城域名的活动列表接口。
 * 3. 重点测试仍能通过 biz_id=3256 返回数据的 KOP 域名。
 * 4. 自动寻找所有 activity_type=4 的签到活动。
 * 5. 对发现的签到活动调用 sign-in-list 验证。
 *
 * 此脚本只查询，不会执行签到。
 */

const STORE_TOPHEROES_BASE =
  "https://store.topheroes.com";

/**
 * 这些 ID 只用于对照诊断。
 *
 * 即使活动列表没有自动发现它们，也会查询它们的
 * sign-in-list，确认活动是否仍然有效。
 *
 * 它们不会被冒充成“自动发现结果”。
 */
const KNOWN_SIGNIN_IDS_FOR_DIAGNOSTIC = [
  3431,
  1113212,
];

/**
 * 当前已知的三个商城 API 域名。
 *
 * OLD_BASE:
 * https://topheroes.store.kopglobal.com
 *
 * NEW_BASE:
 * https://topheroes.pay-store.rivergame.net
 */
const BASES = [
  {
    name: "kopglobal-old-mall",
    url: OLD_BASE,
  },
  {
    name: "rivergame-new-mall",
    url: NEW_BASE,
  },
  {
    name: "store-topheroes-alias",
    url: STORE_TOPHEROES_BASE,
  },
];

/**
 * 兼容不同的活动列表响应结构。
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

function getActivityId(activity) {
  return Number(
    activity?.biz_id ??
      activity?.activity_id ??
      activity?.id ??
      0
  );
}

function getActivityName(activity) {
  return String(
    activity?.name ??
      activity?.activity_name ??
      ""
  );
}

function getActivityType(activity) {
  return Number(
    activity?.activity_type ??
      activity?.type ??
      0
  );
}

/**
 * 合并不同请求返回的活动，按照 biz_id 去重。
 */
function mergeActivities(lists) {
  const map = new Map();

  for (const list of lists) {
    if (!Array.isArray(list)) {
      continue;
    }

    for (const activity of list) {
      const activityId = getActivityId(activity);

      if (!activityId) {
        continue;
      }

      map.set(activityId, {
        ...(map.get(activityId) || {}),
        ...activity,
        biz_id: activityId,
      });
    }
  }

  return [...map.values()];
}

/**
 * 为每个域名生成活动列表探测请求。
 */
function buildListRequests(baseUrl) {
  const endpoint =
    `${baseUrl}/api/v2/store/sale/biz/list`;

  const queryCases = [
    /**
     * 已知可以返回活动 3256。
     * 用于确认域名、接口和登录请求头是否可用。
     */
    [
      "known-biz-3256",
      {
        biz_id: 3256,
      },
    ],

    /**
     * 原正式签到程序使用的查询。
     */
    [
      "project-status2",
      {
        project_id: PROJECT_ID,
        status: 2,
      },
    ],

    /**
     * 不带 status。
     */
    [
      "project-only",
      {
        project_id: PROJECT_ID,
      },
    ],

    /**
     * 加入 site_id。
     */
    [
      "project-site-status2",
      {
        project_id: PROJECT_ID,
        site_id: SITE_ID,
        status: 2,
      },
    ],

    /**
     * 加入 merchant_id。
     */
    [
      "project-merchant-status2",
      {
        project_id: PROJECT_ID,
        merchant_id: MERCHANT_ID,
        status: 2,
      },
    ],

    /**
     * 同时加入 site_id 和 merchant_id。
     */
    [
      "project-site-merchant-status2",
      {
        project_id: PROJECT_ID,
        site_id: SITE_ID,
        merchant_id: MERCHANT_ID,
        status: 2,
      },
    ],

    /**
     * 测试接口现在是否要求分页参数。
     */
    [
      "project-page-status2",
      {
        project_id: PROJECT_ID,
        status: 2,
        page_no: 1,
        page_size: 500,
      },
    ],
    [
      "project-page-no-status",
      {
        project_id: PROJECT_ID,
        page_no: 1,
        page_size: 500,
      },
    ],

    /**
     * 直接查询签到类型 activity_type=4。
     */
    [
      "project-type4-status2",
      {
        project_id: PROJECT_ID,
        activity_type: 4,
        status: 2,
      },
    ],
    [
      "project-type4-no-status",
      {
        project_id: PROJECT_ID,
        activity_type: 4,
      },
    ],
    [
      "project-type4-page",
      {
        project_id: PROJECT_ID,
        activity_type: 4,
        page_no: 1,
        page_size: 500,
      },
    ],

    /**
     * 测试字段是否从 status 改成了 activity_status。
     */
    [
      "project-activity-status2",
      {
        project_id: PROJECT_ID,
        activity_status: 2,
      },
    ],

    /**
     * 测试现在是否只认 merchant_id。
     */
    [
      "merchant-status2",
      {
        merchant_id: MERCHANT_ID,
        status: 2,
        page_no: 1,
        page_size: 500,
      },
    ],

    /**
     * 测试现在是否只认 site_id。
     */
    [
      "site-status2",
      {
        site_id: SITE_ID,
        status: 2,
        page_no: 1,
        page_size: 500,
      },
    ],

    /**
     * 不带业务筛选，只带分页。
     */
    [
      "page-only",
      {
        page_no: 1,
        page_size: 500,
      },
    ],
  ];

  return queryCases.map(([caseName, params]) => {
    const query = new URLSearchParams();

    for (const [key, value] of Object.entries(
      params
    )) {
      if (
        value !== undefined &&
        value !== null &&
        value !== ""
      ) {
        query.set(key, String(value));
      }
    }

    return {
      caseName,
      url: `${endpoint}?${query.toString()}`,
    };
  });
}

/**
 * 探测所有域名和查询参数组合。
 */
async function exploreActivityLists(
  authedHeaders
) {
  const rawResults = [];
  const allLists = [];

  for (const base of BASES) {
    logInfo(
      `\n===== 探测域名: ${base.name} =====`
    );

    logInfo(base.url);

    const requests = buildListRequests(base.url);

    for (const request of requests) {
      const requestName =
        `${base.name}/${request.caseName}`;

      logInfo(`测试: ${requestName}`);

      try {
        const response = await fetchJson(
          request.url,
          {
            headers: authedHeaders,
          },
          0
        );

        const list =
          extractActivityList(response);

        const ids = list
          .map(getActivityId)
          .filter(Boolean);

        const signInActivities = list.filter(
          activity =>
            getActivityType(activity) === 4
        );

        allLists.push(list);

        rawResults.push({
          base_name: base.name,
          base_url: base.url,
          case_name: request.caseName,
          url: request.url,
          count: list.length,
          total:
            response?.data?.total ??
            response?.total ??
            null,
          ids,
          sign_in_ids: signInActivities
            .map(getActivityId)
            .filter(Boolean),
          response,
        });

        const total =
          response?.data?.total ??
          response?.total ??
          "unknown";

        logInfo(
          `${requestName}: ` +
            `count=${list.length}, ` +
            `total=${total}`
        );

        if (ids.length > 0) {
          logOk(
            `${requestName} 活动 ID: ` +
              ids.slice(0, 30).join(",") +
              (ids.length > 30 ? " ..." : "")
          );
        }

        if (signInActivities.length > 0) {
          logOk(
            `${requestName} 找到签到活动: ` +
              signInActivities
                .map(
                  activity =>
                    `${getActivityId(activity)} ` +
                    `${getActivityName(activity)}`
                )
                .join(" | ")
          );
        }
      } catch (error) {
        rawResults.push({
          base_name: base.name,
          base_url: base.url,
          case_name: request.caseName,
          url: request.url,
          error: error.message,
        });

        logWarn(
          `${requestName} 失败: ` +
            error.message
        );
      }

      await sleep(250);
    }
  }

  return {
    rawResults,
    activities: mergeActivities(allLists),
  };
}

/**
 * 在指定域名查询某个签到活动。
 */
async function probeSignInAtBase(
  authedHeaders,
  activityId,
  base
) {
  const url =
    `${base.url}/api/v2/store/sale/biz/sign-in-list` +
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

    const signInList =
      response?.data?.sign_in_list;

    return {
      domain: base.name,
      url,
      ok:
        Array.isArray(signInList) &&
        signInList.length > 0,
      code: response?.code,
      returned_activity_id:
        response?.data?.activity_id,
      days: Array.isArray(signInList)
        ? signInList.length
        : 0,
      has_sign_in_days:
        response?.data?.has_sign_in_days,
      sign_in_list_total:
        response?.data?.sign_in_list_total,
      signed_days: Array.isArray(signInList)
        ? signInList
            .filter(
              item =>
                item.is_sign_in === true
            )
            .map(item => item.day_no)
        : [],
      available_days: Array.isArray(
        signInList
      )
        ? signInList
            .filter(
              item =>
                item.is_available_sign_in ===
                  true &&
                item.is_sign_in !== true
            )
            .map(item => item.day_no)
        : [],
      message: response?.message,
      response,
    };
  } catch (error) {
    return {
      domain: base.name,
      url,
      ok: false,
      error: error.message,
    };
  }
}

/**
 * 使用所有域名验证同一个签到活动。
 */
async function probeSignInActivity(
  authedHeaders,
  activityId
) {
  const attempts = [];

  for (const base of BASES) {
    logInfo(
      `Probe 签到 ${activityId}: ` +
        base.name
    );

    attempts.push(
      await probeSignInAtBase(
        authedHeaders,
        activityId,
        base
      )
    );

    await sleep(250);
  }

  return attempts;
}

function printListSummary(rawResults) {
  console.log(
    "\n=== Activity list request summary ==="
  );

  console.table(
    rawResults.map(result => ({
      domain: result.base_name,
      case: result.case_name,
      count: result.count ?? "",
      total: result.total ?? "",
      sign_in_ids:
        result.sign_in_ids?.join(",") ?? "",
      ids:
        result.ids
          ?.slice(0, 8)
          .join(",") ?? "",
      error: result.error ?? "",
    }))
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
    `登入成功: ${loginInfo.nickname}; ` +
      `login base=${loginInfo.baseUrl}`
  );

  fs.mkdirSync("runtime", {
    recursive: true,
  });

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-");

  const {
    rawResults,
    activities,
  } = await exploreActivityLists(
    loginInfo.authedHeaders
  );

  printListSummary(rawResults);

  const rawPath = path.join(
    "runtime",
    `activity-api-explore-${stamp}.json`
  );

  fs.writeFileSync(
    rawPath,
    JSON.stringify(rawResults, null, 2)
  );

  logOk(
    `完整探测响应已输出: ${rawPath}`
  );

  logInfo(
    `所有请求合并后活动数: ` +
      activities.length
  );

  /**
   * 只保留签到活动 activity_type=4。
   */
  const discoveredSignIns = activities
    .filter(
      activity =>
        getActivityType(activity) === 4
    )
    .sort(
      (a, b) =>
        getActivityId(b) -
        getActivityId(a)
    );

  console.log(
    "\n=== Automatically discovered sign-in activities ==="
  );

  console.table(
    discoveredSignIns.map(activity => ({
      biz_id: getActivityId(activity),
      name: getActivityName(activity),
      type: getActivityType(activity),
      status:
        activity.status ??
        activity.activity_status ??
        "",
      switch:
        activity.activity_switch ?? "",
      start:
        activity.start_time ??
        activity.activity_start_time ??
        "",
      stop:
        activity.stop_time ??
        activity.activity_stop_time ??
        activity.cycle_stop_time ??
        "",
    }))
  );

  const discoveredIds = discoveredSignIns
    .map(getActivityId)
    .filter(Boolean);

  /**
   * 自动发现到的 ID 会标记为 auto-discovered。
   *
   * 3431 和 1113212 只是诊断对照，
   * 如果没有自动发现，它们不会被算作自动结果。
   */
  const probeIds = [
    ...new Set([
      ...discoveredIds,
      ...KNOWN_SIGNIN_IDS_FOR_DIAGNOSTIC,
    ]),
  ];

  const probeResults = [];

  for (const activityId of probeIds) {
    const source = discoveredIds.includes(
      activityId
    )
      ? "auto-discovered"
      : "known-diagnostic-only";

    const attempts =
      await probeSignInActivity(
        loginInfo.authedHeaders,
        activityId
      );

    probeResults.push({
      activity_id: activityId,
      source,
      attempts,
    });
  }

  console.log(
    "\n=== Sign-in probe summary ==="
  );

  console.table(
    probeResults.flatMap(result =>
      result.attempts.map(attempt => ({
        activity_id: result.activity_id,
        source: result.source,
        domain: attempt.domain,
        ok: attempt.ok,
        returned_id:
          attempt.returned_activity_id ?? "",
        days: attempt.days ?? "",
        has:
          attempt.has_sign_in_days ?? "",
        total:
          attempt.sign_in_list_total ?? "",
        signed:
          attempt.signed_days?.join(",") ??
          "",
        available:
          attempt.available_days?.join(",") ??
          "",
        message:
          attempt.message ??
          attempt.error ??
          "",
      }))
    )
  );

  const probePath = path.join(
    "runtime",
    `signin-probe-${stamp}.json`
  );

  fs.writeFileSync(
    probePath,
    JSON.stringify(
      probeResults,
      null,
      2
    )
  );

  logOk(
    `签到 Probe 响应已输出: ${probePath}`
  );

  if (discoveredIds.length === 0) {
    logWarn(
      "本轮仍未自动发现 activity_type=4；" +
        "请把 Activity list request summary " +
        "和 activity-api-explore JSON 发回来。"
    );
  } else {
    logOk(
      `自动发现签到活动 ID: ` +
        discoveredIds.join(",")
    );
  }
}

main().catch(error => {
  logError(
    `Debug activities failed: ${error.message}`
  );

  process.exit(1);
});