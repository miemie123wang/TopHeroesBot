import {
  OLD_BASE,
  NEW_BASE,
  SITE_ID,
  DEBUG_UID,
} from "../core/config.mjs";

import { fetchJson } from "../core/api.mjs";
import { login } from "../core/auth.mjs";

const STORE_BASE =
  "https://store.topheroes.com";

const activityId = Number(
  process.argv.find(arg =>
    /^\d+$/.test(arg)
  )
);

const execute =
  process.argv.includes("--execute");

if (
  !Number.isInteger(activityId) ||
  activityId <= 0
) {
  console.error(
    "用法：node tools/debug-signin-activity.mjs " +
    "<activity_id> [--execute]"
  );

  process.exit(1);
}

if (!DEBUG_UID) {
  console.error(
    "请先设置 DEBUG_UID。"
  );

  process.exit(1);
}

const bases = [
  {
    name: "store.topheroes.com",
    url: STORE_BASE,
  },
  {
    name:
      "topheroes.pay-store.rivergame.net",
    url: NEW_BASE,
  },
  {
    name:
      "topheroes.store.kopglobal.com",
    url: OLD_BASE,
  },
].filter(
  (item, index, list) =>
    item.url &&
    list.findIndex(
      other =>
        other.url === item.url
    ) === index
);

function getHeaderValue(
  headers,
  targetName
) {
  if (!headers) {
    return "";
  }

  if (
    typeof headers.get === "function"
  ) {
    return (
      headers.get(targetName) ||
      headers.get(
        targetName.toLowerCase()
      ) ||
      ""
    );
  }

  const target =
    targetName.toLowerCase();

  const entry =
    Object.entries(headers).find(
      ([name]) =>
        name.toLowerCase() === target
    );

  return entry?.[1] || "";
}

function buildBrowserLikeHeaders(
  baseUrl,
  authedHeaders
) {
  const authorization =
    getHeaderValue(
      authedHeaders,
      "authorization"
    );

  if (!authorization) {
    throw new Error(
      "登录结果中没有 Authorization"
    );
  }

  return {
    ...authedHeaders,

    accept:
      "application/json, text/plain, */*",

    "accept-language":
      "en-US,en;q=0.9,zh-CN;q=0.8," +
      "zh;q=0.7,fr-CA;q=0.6,fr;q=0.5",

    authorization,

    "cache-control": "no-cache",

    "content-type":
      "application/json",

    origin: baseUrl,

    pragma: "no-cache",

    referer: `${baseUrl}/en`,

    /*
     * 浏览器成功请求同时携带：
     *
     * Authorization: Bearer ...
     * Cookie: site-token=Bearer%20...
     *
     * encodeURIComponent 会把空格转成 %20。
     */
    cookie: [
      "lang=en",
      `site-token=${encodeURIComponent(
        authorization
      )}`,
    ].join("; "),
  };
}

function getSignInList(response) {
  return response?.data?.sign_in_list;
}

function isValidSignInActivity(
  response
) {
  const returnedId = Number(
    response?.data?.activity_id || 0
  );

  const list =
    getSignInList(response);

  return (
    Number(response?.code) === 1 &&
    returnedId === activityId &&
    Array.isArray(list) &&
    list.length > 0
  );
}

function findAvailableDay(response) {
  const list =
    getSignInList(response) || [];

  return list.find(
    item =>
      item?.is_available_sign_in ===
        true &&
      item?.is_sign_in !== true &&
      item?.is_appending !== true
  );
}

function isAlreadySignedResponse(
  response
) {
  const message = String(
    response?.message || ""
  ).toLowerCase();

  return (
    message.includes("already") ||
    message.includes("已签到") ||
    message.includes("重复")
  );
}

async function checkActivity(
  base,
  authedHeaders
) {
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
        headers:
          buildBrowserLikeHeaders(
            base.url,
            authedHeaders
          ),
      },
      0
    );

    return {
      base,
      url,
      response,
      valid:
        isValidSignInActivity(
          response
        ),
      availableDay:
        findAvailableDay(response),
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

async function receiveTodaySignIn(
  base,
  authedHeaders
) {
  const url =
    `${base.url}` +
    `/api/v2/store/sale/biz/` +
    `sign-in/gift/receive`;

  /*
   * 浏览器真实成功请求使用 activity_id。
   * chain_id 只用于部分查询链路，
   * 不能用于 gift/receive。
   */
  const body = {
    sign_in_type: 1,
    site_id: SITE_ID,
    activity_id: activityId,
  };

  try {
    const response = await fetchJson(
      url,
      {
        method: "POST",

        headers:
          buildBrowserLikeHeaders(
            base.url,
            authedHeaders
          ),

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
  console.log(
    `\n活动 ID: ${activityId}`
  );

  console.log(
    `实际签到: ${
      execute
        ? "YES"
        : "NO，只读测试"
    }`
  );

  const loginInfo = await login(
    DEBUG_UID,
    {
      maxRetries: 1,
    }
  );

  console.log(
    `登录成功: ${
      loginInfo.nickname ||
      DEBUG_UID
    }`
  );

  const authorization =
    getHeaderValue(
      loginInfo.authedHeaders,
      "authorization"
    );

  console.log({
    hasAuthorization:
      Boolean(authorization),
    authorizationType:
      authorization.startsWith(
        "Bearer "
      )
        ? "Bearer"
        : authorization
          ? "Other"
          : "Missing",
    siteTokenCookie:
      authorization
        ? "将自动生成"
        : "无法生成",
  });

  const checks = [];

  for (const base of bases) {
    const result =
      await checkActivity(
        base,
        loginInfo.authedHeaders
      );

    checks.push(result);

    console.log(
      `\n=== GET ${base.name} ===`
    );

    if (result.error) {
      console.log({
        url: result.url,
        error: result.error,
      });

      continue;
    }

    const data =
      result.response?.data;

    const list =
      data?.sign_in_list;

    console.log({
      code:
        result.response?.code,

      message:
        result.response?.message,

      returnedActivityId:
        data?.activity_id,

      valid:
        result.valid,

      days:
        Array.isArray(list)
          ? list.length
          : 0,

      signedDays:
        Array.isArray(list)
          ? list
              .filter(
                item =>
                  item?.is_sign_in ===
                  true
              )
              .map(
                item =>
                  item?.day_no
              )
          : [],

      availableDays:
        Array.isArray(list)
          ? list
              .filter(
                item =>
                  item
                    ?.is_available_sign_in ===
                    true &&
                  item?.is_sign_in !==
                    true
              )
              .map(
                item =>
                  item?.day_no
              )
          : [],

      availableDay:
        result.availableDay
          ?.day_no ?? null,
    });
  }

  if (!execute) {
    console.log(
      "\n只读测试结束。" +
      "加 --execute 才会实际签到。"
    );

    return;
  }

  /*
   * 优先在 GET 验证成功的域名提交。
   */
  const validBases = checks
    .filter(
      result =>
        result.valid
    )
    .map(
      result =>
        result.base
    );

  const remainingBases =
    bases.filter(
      base =>
        !validBases.some(
          validBase =>
            validBase.url ===
            base.url
        )
    );

  const postBases = [
    ...validBases,
    ...remainingBases,
  ];

  console.log(
    "\n开始实际签到，域名尝试顺序："
  );

  console.log(
    postBases
      .map(
        item =>
          item.name
      )
      .join(" -> ")
  );

  for (const base of postBases) {
    console.log(
      `\n=== POST ${base.name} ===`
    );

    const result =
      await receiveTodaySignIn(
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
      url:
        result.url,

      body:
        result.body,

      requestContext: {
        origin:
          base.url,

        referer:
          `${base.url}/en`,

        authorization:
          "Bearer ***",

        cookie:
          "lang=en; " +
          "site-token=Bearer%20***",
      },

      code:
        result.response?.code,

      message:
        result.response?.message,

      data:
        result.response?.data,
    });

    if (
      Number(
        result.response?.code
      ) === 1
    ) {
      console.log(
        `\n签到成功，可用域名：` +
        base.name
      );

      return;
    }

    if (
      isAlreadySignedResponse(
        result.response
      )
    ) {
      console.log(
        "\n服务端显示已经签到，" +
        "停止继续尝试。"
      );

      return;
    }
  }

  console.error(
    "\n所有域名的签到请求都失败了。"
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