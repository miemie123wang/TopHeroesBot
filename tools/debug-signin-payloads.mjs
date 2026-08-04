import {
  SITE_ID,
  DEBUG_UID,
} from "../core/config.mjs";

import { fetchJson } from "../core/api.mjs";
import { login } from "../core/auth.mjs";

const STORE_BASE =
  "https://store.topheroes.com";

const activityId = Number(
  process.argv[2]
);

const chainId = Number(
  process.argv[3] || 1
);

if (
  !Number.isInteger(activityId) ||
  activityId <= 0
) {
  console.error(
    "用法：node tools/debug-signin-payloads.mjs " +
    "<activity_id> [chain_id]"
  );

  process.exit(1);
}

if (!DEBUG_UID) {
  console.error(
    "请先设置 DEBUG_UID。"
  );

  process.exit(1);
}

function normalizeHeaders(headers) {
  if (!headers) {
    return {};
  }

  if (
    typeof headers.entries ===
    "function"
  ) {
    return Object.fromEntries(
      headers.entries()
    );
  }

  return { ...headers };
}

function buildHeaders(
  authedHeaders
) {
  return {
    ...normalizeHeaders(
      authedHeaders
    ),

    accept:
      "application/json, text/plain, */*",

    "content-type":
      "application/json",

    "cache-control":
      "no-cache",

    pragma:
      "no-cache",

    origin:
      STORE_BASE,

    referer:
      `${STORE_BASE}/en`,
  };
}

function getList(response) {
  return (
    response?.data?.sign_in_list ||
    []
  );
}

function signedDays(response) {
  return getList(response)
    .filter(
      item =>
        item?.is_sign_in === true
    )
    .map(
      item =>
        item?.day_no
    );
}

function availableDays(response) {
  return getList(response)
    .filter(
      item =>
        item
          ?.is_available_sign_in ===
          true &&
        item?.is_sign_in !== true
    )
    .map(
      item =>
        item?.day_no
    );
}

function isSuccess(response) {
  return (
    Number(response?.code) === 1
  );
}

function isAlreadySigned(response) {
  const message = String(
    response?.message || ""
  ).toLowerCase();

  return (
    message.includes("already") ||
    message.includes("已签到") ||
    message.includes("重复")
  );
}

async function readByActivityId(
  headers
) {
  const url =
    `${STORE_BASE}` +
    `/api/v2/store/sale/biz/sign-in-list` +
    `?page_size=365` +
    `&site_id=${SITE_ID}` +
    `&page_no=1` +
    `&activity_id=${activityId}` +
    `&_=${Date.now()}`;

  return fetchJson(
    url,
    { headers },
    0
  );
}

async function readByChainId(
  headers
) {
  const url =
    `${STORE_BASE}` +
    `/api/v2/store/sale/biz/sign-in-list` +
    `?page_size=365` +
    `&site_id=${SITE_ID}` +
    `&page_no=1` +
    `&chain_id=${chainId}` +
    `&_=${Date.now()}`;

  return fetchJson(
    url,
    { headers },
    0
  );
}

async function submitPayload(
  headers,
  name,
  body
) {
  const url =
    `${STORE_BASE}` +
    `/api/v2/store/sale/biz/` +
    `sign-in/gift/receive`;

  console.log(
    `\n========== ${name} ==========`
  );

  console.log(
    "提交 Payload：",
    body
  );

  try {
    const response =
      await fetchJson(
        url,
        {
          method: "POST",
          headers,
          body:
            JSON.stringify(body),
        },
        0
      );

    console.log(
      "响应：",
      {
        code:
          response?.code,

        message:
          response?.message,

        data:
          response?.data,
      }
    );

    return response;
  } catch (error) {
    console.log(
      "请求异常：",
      error.message
    );

    return {
      code: null,
      message: error.message,
      data: null,
    };
  }
}

async function main() {
  console.log(
    `\nactivity_id: ${activityId}`
  );

  console.log(
    `chain_id: ${chainId}`
  );

  console.log(
    `DEBUG_UID: ${DEBUG_UID}`
  );

  const loginInfo =
    await login(
      DEBUG_UID,
      {
        maxRetries: 1,
      }
    );

  console.log(
    `登录成功：${
      loginInfo.nickname ||
      DEBUG_UID
    }`
  );

  const headers =
    buildHeaders(
      loginInfo.authedHeaders
    );

  /*
   * 先查看两种查询方式的结果。
   */
  console.log(
    "\n========== GET activity_id =========="
  );

  const activityResponse =
    await readByActivityId(
      headers
    );

  console.log({
    code:
      activityResponse?.code,

    message:
      activityResponse?.message,

    returnedActivityId:
      activityResponse?.data
        ?.activity_id,

    signedDays:
      signedDays(
        activityResponse
      ),

    availableDays:
      availableDays(
        activityResponse
      ),
  });

  console.log(
    "\n========== GET chain_id =========="
  );

  const chainResponse =
    await readByChainId(
      headers
    );

  console.log({
    code:
      chainResponse?.code,

    message:
      chainResponse?.message,

    returnedActivityId:
      chainResponse?.data
        ?.activity_id,

    returnedChainId:
      chainResponse?.data
        ?.chain_id,

    signedDays:
      signedDays(
        chainResponse
      ),

    availableDays:
      availableDays(
        chainResponse
      ),
  });

  const currentAvailable =
    availableDays(
      activityResponse
    );

  if (
    currentAvailable.length === 0
  ) {
    console.log(
      "\n当前账号没有可签到天数。"
    );

    console.log(
      "请把 DEBUG_UID 换成今天尚未签到的账号。"
    );

    return;
  }

  console.log(
    `\n当前可签到天数：` +
    currentAvailable.join(", ")
  );

  /*
   * Payload 1：
   * 与浏览器成功请求完全一致。
   */
  const payloads = [
    {
      name:
        "Payload 1：activity_id",

      body: {
        sign_in_type: 1,
        site_id: SITE_ID,
        activity_id:
          activityId,
      },
    },

    /*
     * Payload 2：
     * 只使用 chain_id。
     */
    {
      name:
        "Payload 2：chain_id",

      body: {
        sign_in_type: 1,
        site_id: SITE_ID,
        chain_id:
          chainId,
      },
    },

    /*
     * Payload 3：
     * 同时携带 activity_id
     * 和 chain_id。
     */
    {
      name:
        "Payload 3：activity_id + chain_id",

      body: {
        sign_in_type: 1,
        site_id: SITE_ID,
        activity_id:
          activityId,
        chain_id:
          chainId,
      },
    },
  ];

  for (const payload of payloads) {
    const response =
      await submitPayload(
        headers,
        payload.name,
        payload.body
      );

    if (isSuccess(response)) {
      console.log(
        `\n✅ 成功 Payload：${payload.name}`
      );

      console.log(
        payload.body
      );

      break;
    }

    if (
      isAlreadySigned(
        response
      )
    ) {
      console.log(
        "\n服务端显示已经签到，" +
        "停止继续测试。"
      );

      break;
    }

    console.log(
      "此 Payload 失败，继续测试下一种。"
    );
  }

  /*
   * 再读一次状态，确认是否真的签到成功。
   */
  console.log(
    "\n========== 最终状态确认 =========="
  );

  const finalResponse =
    await readByActivityId(
      headers
    );

  console.log({
    code:
      finalResponse?.code,

    message:
      finalResponse?.message,

    signedDays:
      signedDays(
        finalResponse
      ),

    availableDays:
      availableDays(
        finalResponse
      ),
  });
}

main().catch(error => {
  console.error(
    "\nDebug failed：",
    error
  );

  process.exit(1);
});