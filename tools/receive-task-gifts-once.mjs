import {
  SITE_ID,
  PROJECT_ID,
  DEBUG_UID
} from "../core/config.mjs";

import {
  fetchApprovedUids
} from "../core/sheet.mjs";

import {
  logInfo,
  logOk,
  logWarn,
  logError
} from "../core/logger.mjs";

import {
  maskUid
} from "../core/utils.mjs";

const STORE_BASE =
  "https://store.topheroes.com";

const EXECUTE =
  process.argv.includes("--execute");

/*
 * 顺序处理，不开并发。
 * store 登录近期容易触发 429，
 * 每个账号之间至少间隔 4 秒。
 */
const ACCOUNT_INTERVAL_MS = 4000;

const sleep = ms =>
  new Promise(resolve =>
    setTimeout(resolve, ms)
  );

const commonHeaders = {
  accept:
    "application/json, text/plain, */*",

  "accept-language":
    "en-US,en;q=0.9,zh-CN;q=0.8," +
    "zh;q=0.7,fr-CA;q=0.6,fr;q=0.5",

  "cache-control":
    "no-cache",

  "content-type":
    "application/json",

  pragma:
    "no-cache",

  "user-agent":
    "Mozilla/5.0 " +
    "(Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 " +
    "(KHTML, like Gecko) " +
    "Chrome/151.0.0.0 Safari/537.36"
};

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readResponse(response) {
  const text =
    await response.text();

  return {
    httpStatus:
      response.status,

    json:
      parseJson(text),

    text
  };
}

function buildAuthedHeaders(
  authorization
) {
  return {
    ...commonHeaders,

    authorization,

    cookie: [
      "lang=en",
      `site-token=${encodeURIComponent(
        authorization
      )}`
    ].join("; "),

    origin:
      STORE_BASE,

    referer:
      `${STORE_BASE}/en`
  };
}

async function preCheckPlayer(uid) {
  const url =
    `${STORE_BASE}` +
    `/api/v2/store/player-info` +
    `?project_id=${PROJECT_ID}` +
    `&player_id=${encodeURIComponent(uid)}` +
    `&site_id=${SITE_ID}`;

  try {
    await fetch(url, {
      method: "GET",

      headers: {
        ...commonHeaders,

        origin:
          STORE_BASE,

        referer:
          `${STORE_BASE}/en`
      }
    });
  } catch {
    // 预热失败不阻断登录
  }
}

async function loginOnce(uid) {
  await preCheckPlayer(uid);

  const response =
    await fetch(
      `${STORE_BASE}` +
      `/api/v2/store/login/player`,
      {
        method: "POST",

        headers: {
          ...commonHeaders,

          origin:
            STORE_BASE,

          referer:
            `${STORE_BASE}/en`,

          cookie:
            "lang=en"
        },

        body:
          JSON.stringify({
            site_id:
              SITE_ID,

            player_id:
              uid,

            server_id:
              "",

            device:
              "pc"
          })
      }
    );

  const result =
    await readResponse(response);

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ` +
      result.text
    );
  }

  if (
    Number(result.json?.code) !== 1
  ) {
    throw new Error(
      result.json?.message ||
      result.text ||
      "登录失败"
    );
  }

  const authorization =
    response.headers.get(
      "authorization"
    );

  if (!authorization) {
    throw new Error(
      "登录成功但没有拿到 Authorization"
    );
  }

  const nickname =
    result.json?.data?.nickname ||
    result.json?.data?.player_name ||
    result.json?.data?.role_name ||
    "(unknown)";

  return {
    nickname,
    authorization,
    headers:
      buildAuthedHeaders(
        authorization
      )
  };
}

async function loginWithRetry(
  uid,
  maxRetries = 4
) {
  let lastError;

  for (
    let attempt = 1;
    attempt <= maxRetries;
    attempt++
  ) {
    try {
      logInfo(
        `[LOGIN START] ` +
        `${maskUid(uid)} ` +
        `${new Date().toISOString()}`
      );

      const result =
        await loginOnce(uid);

      logInfo(
        `[LOGIN OK] ` +
        `${maskUid(uid)} ` +
        `${new Date().toISOString()} ` +
        `(store mall)`
      );

      return result;
    } catch (error) {
      lastError = error;

      if (attempt >= maxRetries) {
        break;
      }

      const message =
        String(error?.message || error);

      /*
       * 429 等待更久；
       * 其他登录错误也稍等后重试。
       */
      const waitMs =
        message.includes("429") ||
        message
          .toLowerCase()
          .includes(
            "too many requests"
          )
          ? 30000
          : 12000;

      logWarn(
        `[store login ${attempt}/` +
        `${maxRetries}] ` +
        `${maskUid(uid)} 失败：` +
        message
      );

      logWarn(
        `等待 ${Math.round(
          waitMs / 1000
        )} 秒后重试`
      );

      await sleep(waitMs);
    }
  }

  throw new Error(
    `登录失败：${lastError?.message}`
  );
}

async function fetchTaskList(headers) {
  const url =
    `${STORE_BASE}` +
    `/api/v2/store/task/list` +
    `?project_id=${PROJECT_ID}` +
    `&_=${Date.now()}`;

  const response =
    await fetch(url, {
      method: "GET",
      headers
    });

  const result =
    await readResponse(response);

  return {
    url,
    ...result
  };
}

async function receiveAll(headers) {
  const url =
    `${STORE_BASE}` +
    `/api/v2/store/task/gift/receive-all`;

  /*
   * 网页真实成功请求：
   * - POST
   * - 没有 Request Payload
   * - 没有 Content-Type
   *
   * 不能把 application/json 和空 body 一起发送，
   * 否则接口会返回 Parameter exception。
   */
  const receiveHeaders = {
    ...headers
  };

  for (const name of Object.keys(receiveHeaders)) {
    if (name.toLowerCase() === "content-type") {
      delete receiveHeaders[name];
    }
  }

  const response =
    await fetch(url, {
      method: "POST",
      headers: receiveHeaders

      // 不设置 body
    });

  const result =
    await readResponse(response);

  return {
    url,
    ...result
  };
}

function summarizeTaskList(result) {
  const data =
    result?.json?.data;

  if (Array.isArray(data)) {
    return {
      type: "array",
      count: data.length
    };
  }

  if (
    Array.isArray(data?.list)
  ) {
    return {
      type: "data.list",
      count: data.list.length
    };
  }

  if (
    Array.isArray(data?.tasks)
  ) {
    return {
      type: "data.tasks",
      count: data.tasks.length
    };
  }

  return {
    type:
      data == null
        ? "empty"
        : typeof data,

    count:
      null
  };
}

async function processUid(
  uid,
  index,
  total
) {
  console.log(
    `\n========== ` +
    `${index + 1}/${total} ` +
    `UID: ${maskUid(uid)} ` +
    `==========`
  );

  const loginInfo =
    await loginWithRetry(uid);

  logInfo(
    `昵称: ${loginInfo.nickname}`
  );

  const before =
    await fetchTaskList(
      loginInfo.headers
    );

  logInfo(
    `task/list: ` +
    `HTTP ${before.httpStatus}, ` +
    `code=${before.json?.code ?? "?"}`
  );

  logInfo(
    `task/list 摘要: ` +
    JSON.stringify(
      summarizeTaskList(before)
    )
  );

  if (!EXECUTE) {
    logWarn(
      "只读模式：未调用 receive-all"
    );

    return {
      uid,
      nickname:
        loginInfo.nickname,

      success: true,
      executed: false
    };
  }

  const receiveResult =
    await receiveAll(
      loginInfo.headers
    );

const code =
  Number(receiveResult.json?.code);

const message =
  String(
    receiveResult.json?.message || ""
  ).toLowerCase();

if (code === 1) {
  logOk(
    `receive-all 成功: ` +
    JSON.stringify(receiveResult.json)
  );
} else if (
  code === 89001 ||
  message.includes("the gift has received") ||
  message.includes("already received")
) {
  logInfo(
    "任务奖励已经领取，跳过此账号"
  );
} else {
  throw new Error(
    `receive-all 失败: ` +
    (
      receiveResult.text ||
      JSON.stringify(receiveResult.json)
    )
  );
}

  /*
   * 再查一次，便于确认领取后状态。
   */
  await sleep(500);

  const after =
    await fetchTaskList(
      loginInfo.headers
    );

  logInfo(
    `领取后 task/list 摘要: ` +
    JSON.stringify(
      summarizeTaskList(after)
    )
  );

  return {
    uid,
    nickname:
      loginInfo.nickname,

    success: true,
    executed: true
  };
}

async function main() {
  logInfo(
    "TopHeroes 一次性任务奖励领取开始"
  );

  logWarn(
    EXECUTE
      ? "当前为执行模式，会实际调用 receive-all"
      : "当前为只读模式，不会领取；加 --execute 才会执行"
  );

let uids;

try {
  uids = await fetchApprovedUids();
} catch (error) {
  const message = String(
    error?.message || error
  );

  if (
    message.includes("APPS_SCRIPT_URL") &&
    DEBUG_UID
  ) {
    logWarn(
      "本地缺少 Apps Script 环境变量，" +
      `本次只测试 DEBUG_UID: ${maskUid(DEBUG_UID)}`
    );

    uids = [DEBUG_UID];
  } else {
    throw error;
  }
}

  if (
    !Array.isArray(uids) ||
    uids.length === 0
  ) {
    throw new Error(
      "没有找到 Approved 账号"
    );
  }

  logInfo(
    `找到 ${uids.length} 个已 Approved 的账号`
  );

  const results = [];

  for (
    let index = 0;
    index < uids.length;
    index++
  ) {
    const uid =
      String(uids[index]).trim();

    try {
      const result =
        await processUid(
          uid,
          index,
          uids.length
        );

      results.push(result);
    } catch (error) {
      logError(
        `账号处理失败: ` +
        `${maskUid(uid)}\n` +
        `原因: ${error.message}`
      );

      results.push({
        uid,
        success: false,
        error:
          error.message
      });
    }

    if (
      index <
      uids.length - 1
    ) {
      logInfo(
        `等待 ${ACCOUNT_INTERVAL_MS / 1000} 秒后处理下一个账号`
      );

      await sleep(
        ACCOUNT_INTERVAL_MS
      );
    }
  }

  const successCount =
    results.filter(
      item => item.success
    ).length;

  const failureCount =
    results.length -
    successCount;

  console.log(
    "\n========== 执行汇总 =========="
  );

  logInfo(
    `总账号: ${results.length}`
  );

  logOk(
    `成功: ${successCount}`
  );

  if (failureCount > 0) {
    logWarn(
      `失败: ${failureCount}`
    );

    for (
      const item of results.filter(
        result => !result.success
      )
    ) {
      console.log(
        `- ${maskUid(item.uid)}: ` +
        item.error
      );
    }

    process.exitCode = 2;
  } else {
    logOk(
      EXECUTE
        ? "所有账号的一次性任务奖励领取完成"
        : "所有账号只读检查完成"
    );
  }
}

main().catch(error => {
  logError(
    `一次性任务奖励脚本失败: ` +
    error.message
  );

  process.exit(1);
});