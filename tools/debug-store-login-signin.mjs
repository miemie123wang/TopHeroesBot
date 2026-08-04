import crypto from "node:crypto";

import {
  SITE_ID,
  PROJECT_ID,
  DEBUG_UID
} from "../core/config.mjs";

const STORE_BASE = "https://store.topheroes.com";
const activityId = Number(process.argv[2] || 1113205);

if (!DEBUG_UID) {
  console.error("请先在 core/config.mjs 中设置 DEBUG_UID。");
  process.exit(1);
}

if (!Number.isInteger(activityId) || activityId <= 0) {
  console.error(
    "用法：node tools/debug-store-login-signin.mjs <activity_id>"
  );
  process.exit(1);
}

const commonHeaders = {
  accept: "application/json, text/plain, */*",
  "accept-language":
    "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7,fr-CA;q=0.6,fr;q=0.5",
  "cache-control": "no-cache",
  "content-type": "application/json",
  pragma: "no-cache",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/151.0.0.0 Safari/537.36"
};

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function fingerprint(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex")
    .slice(0, 12);
}

function getSetCookies(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }

  const raw = response.headers.get("set-cookie");
  return raw ? [raw] : [];
}

function buildCookie(setCookies, authorization) {
  const cookiePairs = setCookies
    .map(value => String(value).split(";")[0].trim())
    .filter(Boolean);

  if (!cookiePairs.some(value => value.startsWith("lang="))) {
    cookiePairs.unshift("lang=en");
  }

  if (!cookiePairs.some(value => value.startsWith("site-token="))) {
    cookiePairs.push(
      `site-token=${encodeURIComponent(authorization)}`
    );
  }

  return cookiePairs.join("; ");
}

async function readJson(response) {
  const text = await response.text();

  return {
    httpStatus: response.status,
    text,
    json: parseJson(text)
  };
}

async function preCheck() {
  const url =
    `${STORE_BASE}/api/v2/store/player-info` +
    `?project_id=${PROJECT_ID}` +
    `&player_id=${encodeURIComponent(DEBUG_UID)}` +
    `&site_id=${SITE_ID}`;

  await fetch(url, {
    method: "GET",
    headers: {
      ...commonHeaders,
      origin: STORE_BASE,
      referer: `${STORE_BASE}/en`
    }
  }).catch(() => {});
}

async function loginAtStore(device) {
  await preCheck();

  const url = `${STORE_BASE}/api/v2/store/login/player`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...commonHeaders,
      origin: STORE_BASE,
      referer: `${STORE_BASE}/en`,
      cookie: "lang=en"
    },
    body: JSON.stringify({
      site_id: SITE_ID,
      player_id: DEBUG_UID,
      server_id: "",
      device
    })
  });

  const result = await readJson(response);

  const authorization =
    response.headers.get("authorization") || "";

  const setCookies = getSetCookies(response);

  return {
    device,
    ...result,
    authorization,
    setCookies,
    cookie: authorization
      ? buildCookie(setCookies, authorization)
      : ""
  };
}

function buildSessionHeaders(session) {
  return {
    ...commonHeaders,
    authorization: session.authorization,
    cookie: session.cookie,
    origin: STORE_BASE,
    referer: `${STORE_BASE}/en`
  };
}

async function getStatus(session) {
  const url =
    `${STORE_BASE}/api/v2/store/sale/biz/sign-in-list` +
    `?page_size=365` +
    `&site_id=${SITE_ID}` +
    `&page_no=1` +
    `&activity_id=${activityId}` +
    `&_=${Date.now()}`;

  const response = await fetch(url, {
    method: "GET",
    headers: buildSessionHeaders(session)
  });

  return readJson(response);
}

async function receive(session) {
  const url =
    `${STORE_BASE}/api/v2/store/sale/biz/sign-in/gift/receive`;

  const body = {
    sign_in_type: 1,
    site_id: SITE_ID,
    activity_id: activityId
  };

  const response = await fetch(url, {
    method: "POST",
    headers: buildSessionHeaders(session),
    body: JSON.stringify(body)
  });

  return {
    body,
    ...(await readJson(response))
  };
}

function summarizeStatus(result) {
  const data = result.json?.data;
  const list = data?.sign_in_list;

  return {
    httpStatus: result.httpStatus,
    code: result.json?.code,
    message: result.json?.message,
    returnedActivityId: data?.activity_id,

    signedDays: Array.isArray(list)
      ? list
          .filter(item => item?.is_sign_in === true)
          .map(item => item?.day_no)
      : [],

    availableDays: Array.isArray(list)
      ? list
          .filter(
            item =>
              item?.is_available_sign_in === true &&
              item?.is_sign_in !== true
          )
          .map(item => item?.day_no)
      : []
  };
}

async function main() {
  console.log(`activity_id: ${activityId}`);
  console.log(`DEBUG_UID: ${DEBUG_UID}`);

  console.log(
    "这次直接在 store.topheroes.com 登录，并用原生 fetch 提交。"
  );

  for (const device of ["pc", "mobile"]) {
    console.log(
      `\n========== store login / ${device} ==========`
    );

    const session = await loginAtStore(device);

    console.log({
      loginHttpStatus: session.httpStatus,
      loginCode: session.json?.code,
      loginMessage: session.json?.message || "",
      hasAuthorization: Boolean(session.authorization),
      tokenFingerprint: fingerprint(session.authorization),

      returnedCookieNames: session.setCookies.map(
        value => String(value).split("=")[0]
      ),

      finalCookieNames: session.cookie
        .split(";")
        .map(value => value.trim().split("=")[0])
        .filter(Boolean)
    });

    if (
      Number(session.json?.code) !== 1 ||
      !session.authorization
    ) {
      continue;
    }

    const before = await getStatus(session);

    console.log(
      "签到前状态：",
      summarizeStatus(before)
    );

    const availableDays =
      summarizeStatus(before).availableDays;

    if (availableDays.length === 0) {
      console.log(
        "当前账号没有可签到天数，换一个未签到账号再测试。"
      );
      return;
    }

    const post = await receive(session);

    console.log("POST 结果：", {
      httpStatus: post.httpStatus,
      body: post.body,
      code: post.json?.code,
      message: post.json?.message,
      data: post.json?.data
    });

    const after = await getStatus(session);

    console.log(
      "签到后状态：",
      summarizeStatus(after)
    );

    if (Number(post.json?.code) === 1) {
      console.log(
        `\n✅ 成功：store login / ${device}`
      );
      return;
    }
  }

  console.error(
    "\n❌ store 域名直接登录后仍然失败。" +
    "下一步需要抓网页的 login/player 请求，" +
    "而不是继续改签到 Payload。"
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