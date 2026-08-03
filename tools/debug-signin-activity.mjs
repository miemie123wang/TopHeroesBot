import {
  OLD_BASE,
  NEW_BASE,
  SITE_ID,
  DEBUG_UID,
} from "../core/config.mjs";

import { fetchJson } from "../core/api.mjs";
import { login } from "../core/auth.mjs";

const STORE_BASE = "https://store.topheroes.com";

const activityId = Number(
  process.argv.find(arg => /^\d+$/.test(arg))
);

const execute = process.argv.includes("--execute");

if (!Number.isInteger(activityId) || activityId <= 0) {
  console.error(
    "用法：node tools/debug-signin-activity.mjs <activity_id> [--execute]"
  );
  process.exit(1);
}

if (!DEBUG_UID) {
  console.error("请先设置 DEBUG_UID。");
  process.exit(1);
}

const bases = [
  {
    name: "store.topheroes.com",
    url: STORE_BASE,
  },
  {
    name: "topheroes.store.kopglobal.com",
    url: OLD_BASE,
  },
  {
    name: "topheroes.pay-store.rivergame.net",
    url: NEW_BASE,
  },
].filter(
  (item, index, list) =>
    item.url &&
    list.findIndex(other => other.url === item.url) ===
      index
);

function getSignInList(response) {
  return response?.data?.sign_in_list;
}

function isValidSignInActivity(response) {
  const returnedId = Number(
    response?.data?.activity_id || 0
  );

  const list = getSignInList(response);

  return (
    Number(response?.code) === 1 &&
    returnedId === activityId &&
    Array.isArray(list) &&
    list.length > 0
  );
}

function findAvailableDay(response) {
  const list = getSignInList(response) || [];

  return list.find(
    item =>
      item?.is_available_sign_in === true &&
      item?.is_sign_in !== true &&
      item?.is_appending !== true
  );
}

async function checkActivity(base, headers) {
  const url =
    `${base.url}` +
    `/api/v2/store/sale/biz/sign-in-list` +
    `?page_size=365` +
    `&site_id=${SITE_ID}` +
    `&page_no=1` +
    `&activity_id=${activityId}` +
    `&_=${Date.now()}`;

  try {
    const response = await fetchJson(
      url,
      {
        headers: {
          ...headers,
          "cache-control":
            "no-cache, no-store, max-age=0",
          pragma: "no-cache",
        },
      },
      0
    );

    return {
      base,
      url,
      response,
      valid: isValidSignInActivity(response),
      availableDay: findAvailableDay(response),
    };
  } catch (error) {
    return {
      base,
      url,
      valid: false,
      error: error.message,
    };
  }
}

async function signIn(base, headers) {
  const url =
    `${base.url}` +
    `/api/v2/store/sale/biz/sign-in/gift/receive`;

  const body = {
    activity_id: activityId,
    sign_in_type: 1,
    site_id: SITE_ID,
  };

  try {
    const response = await fetchJson(
      url,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      0
    );

    return {
      base,
      url,
      body,
      response,
    };
  } catch (error) {
    return {
      base,
      url,
      body,
      error: error.message,
    };
  }
}

async function main() {
  console.log(`\n活动 ID: ${activityId}`);
  console.log(
    `实际签到: ${execute ? "YES" : "NO，只读测试"}`
  );

  const loginInfo = await login(DEBUG_UID, {
    maxRetries: 1,
  });

  console.log(
    `登录成功: ${loginInfo.nickname || DEBUG_UID}`
  );

  const checks = [];

  for (const base of bases) {
    const result = await checkActivity(
      base,
      loginInfo.authedHeaders
    );

    checks.push(result);

    console.log(`\n=== GET ${base.name} ===`);

    if (result.error) {
      console.log({
        error: result.error,
        url: result.url,
      });

      continue;
    }

    const data = result.response?.data;
    const list = data?.sign_in_list;

    console.log({
      code: result.response?.code,
      message: result.response?.message,
      returnedActivityId: data?.activity_id,
      valid: result.valid,
      days: Array.isArray(list)
        ? list.length
        : 0,
      signedDays: Array.isArray(list)
        ? list
            .filter(
              item => item?.is_sign_in === true
            )
            .map(item => item?.day_no)
        : [],
      availableDays: Array.isArray(list)
        ? list
            .filter(
              item =>
                item?.is_available_sign_in ===
                  true &&
                item?.is_sign_in !== true
            )
            .map(item => item?.day_no)
        : [],
      availableDay:
        result.availableDay?.day_no ?? null,
    });
  }

  if (!execute) {
    console.log(
      "\n只读测试结束。加 --execute 才会实际签到。"
    );

    return;
  }

  const validBases = checks
    .filter(item => item.valid)
    .map(item => item.base);

  const otherBases = bases.filter(
    base =>
      !validBases.some(
        validBase => validBase.url === base.url
      )
  );

  const postBases = [
    ...validBases,
    ...otherBases,
  ];

  console.log(
    "\n开始实际签到，域名尝试顺序："
  );

  console.log(
    postBases
      .map(item => item.name)
      .join(" -> ")
  );

  for (const base of postBases) {
    console.log(`\n=== POST ${base.name} ===`);

    const result = await signIn(
      base,
      loginInfo.authedHeaders
    );

    if (result.error) {
      console.log({
        url: result.url,
        body: result.body,
        error: result.error,
      });

      continue;
    }

    console.log({
      url: result.url,
      body: result.body,
      code: result.response?.code,
      message: result.response?.message,
      data: result.response?.data,
    });

    if (Number(result.response?.code) === 1) {
      console.log(
        `\n签到成功，可用域名：${base.name}`
      );

      return;
    }

    const message = String(
      result.response?.message || ""
    ).toLowerCase();

    if (
      message.includes("already") ||
      message.includes("已签到") ||
      message.includes("重复")
    ) {
      console.log(
        "\n服务端显示已经签到，停止继续尝试。"
      );

      return;
    }
  }

  console.error(
    "\n三个域名的签到请求都失败了。"
  );

  process.exitCode = 2;
}

main().catch(error => {
  console.error(
    "\nDebug failed:",
    error
  );

  process.exit(1);
});