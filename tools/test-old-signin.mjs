import {
  BASE,
  SITE_ID,
  PROJECT_ID,
  DEBUG_UID
} from "../core/config.mjs";

import { sleep, randomSleep } from "../core/sleep.mjs";
import { logInfo, logOk, logWarn, logError } from "../core/logger.mjs";

const TEST_UID = DEBUG_UID;

// 先测旧签到：3010 / 2569 / 2299
const TEST_BIZ_ID = 3010;

// 第一次先 false，只查看状态，不真正领取。
// 确认 available_days 有值以后，再改成 true。
const REALLY_RECEIVE = true;

const headers = {
  "Content-Type": "application/json",
  accept: "application/json, text/plain, */*",
  "user-agent":
    "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36",
  cookie: "lang=en"
};

function maskUid(uid) {
  uid = String(uid);
  if (uid.length <= 4) return "****";
  return uid.slice(0, 2) + "*".repeat(uid.length - 4) + uid.slice(-2);
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`回傳不是 JSON，HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
  }

  return { data, res };
}

async function preCheckPlayer(uid) {
  const url =
    `${BASE}/api/v2/store/player-info` +
    `?project_id=${PROJECT_ID}` +
    `&player_id=${encodeURIComponent(uid)}` +
    `&site_id=${SITE_ID}`;

  try {
    await fetch(url, { method: "GET", headers });
  } catch {}
}

function getNickname(loginData) {
  return (
    loginData?.data?.user?.nickname ||
    loginData?.data?.nickname ||
    "Unknown"
  );
}

async function login(uid) {
  await preCheckPlayer(uid);
  await randomSleep(1000, 2500);

  logInfo(`[LOGIN START] ${maskUid(uid)} ${new Date().toISOString()}`);

  const { data: loginData, res } = await fetchJson(
    `${BASE}/api/v2/store/login/player`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        site_id: SITE_ID,
        player_id: uid,
        server_id: "",
        device: "pc"
      })
    }
  );

  if (loginData.code !== 1) {
    throw new Error(`登錄失敗: ${loginData.message || JSON.stringify(loginData)}`);
  }

  const token =
    res.headers.get("authorization") ||
    res.headers.get("Authorization");

  if (!token) {
    throw new Error("沒有拿到 authorization token");
  }

  const nickname = getNickname(loginData);

  logInfo(`[LOGIN OK] ${maskUid(uid)} ${new Date().toISOString()} (${nickname})`);

  return {
    nickname,
    authedHeaders: {
      ...headers,
      authorization: token
    }
  };
}

async function getActivityInfo(authedHeaders, bizId) {
  const url =
    `${BASE}/api/v2/store/sale/biz/list` +
    `?player_id=${encodeURIComponent(TEST_UID)}` +
    `&project_id=${PROJECT_ID}` +
    `&biz_id=${bizId}` +
    `&status=2`;

  const { data } = await fetchJson(url, { headers: authedHeaders });
  return data?.data?.list?.[0] || null;
}

async function getSignInData(authedHeaders, activityId) {
  const url =
    `${BASE}/api/v2/store/sale/biz/sign-in-list` +
    `?activity_id=${activityId}` +
    `&page_size=365` +
    `&site_id=${SITE_ID}` +
    `&page_no=1`;

  const { data } = await fetchJson(url, { headers: authedHeaders });

  if (!data?.data?.sign_in_list) {
    throw new Error(`沒有簽到資料: ${JSON.stringify(data).slice(0, 500)}`);
  }

  return data.data;
}

function summarizeSignIn(signInData) {
  const list = signInData.sign_in_list || [];

  return {
    has_sign_in_days: signInData.has_sign_in_days,
    remain_appending_days: signInData.remain_appending_days,
    total: list.length,
    signed_days: list.filter(x => x.is_sign_in).map(x => x.day_no),
    available_today_days: list
      .filter(x => x.is_available_sign_in && !x.is_sign_in && !x.is_appending)
      .map(x => x.day_no),
    makeup_days: list
      .filter(x => x.is_appending && !x.is_sign_in)
      .map(x => x.day_no)
  };
}

function getTodayItem(signInData) {
  return (signInData.sign_in_list || []).find(
    x => x.is_available_sign_in && !x.is_sign_in && !x.is_appending
  );
}

async function receiveTodaySignIn(authedHeaders, activityId) {
  const { data } = await fetchJson(
    `${BASE}/api/v2/store/sale/biz/sign-in/gift/receive`,
    {
      method: "POST",
      headers: authedHeaders,
      body: JSON.stringify({
        activity_id: activityId,
        sign_in_type: 1,
        site_id: SITE_ID
      })
    }
  );

  return data;
}

function printGiftResponse(data) {
  console.log("\n=== Receive Response ===");
  console.log(JSON.stringify(data, null, 2));

  const gifts =
    data?.data?.gift_list ||
    data?.data?.gifts ||
    data?.gift_list ||
    [];

  if (Array.isArray(gifts) && gifts.length) {
    console.log("\n=== Gifts ===");
    for (const gift of gifts) {
      console.log(
        `- ${gift.gift_goods_name || gift.gift_goods_id || "unknown"} x${gift.num ?? "?"}`
      );
    }
  }
}

async function main() {
  logInfo("Old sign-in test started");

  if (!TEST_UID) {
    throw new Error("請先在 core/config.mjs 設定 DEBUG_UID，或直接修改 TEST_UID");
  }

  logInfo(`測試 UID: ${maskUid(TEST_UID)}`);
  logInfo(`測試 Activity: ${TEST_BIZ_ID}`);
  logWarn(`REALLY_RECEIVE = ${REALLY_RECEIVE}`);

  const loginInfo = await login(TEST_UID);
  logOk(`登入成功: ${loginInfo.nickname}`);

  const activity = await getActivityInfo(loginInfo.authedHeaders, TEST_BIZ_ID);

  console.log("\n=== Activity Info ===");
  console.log(
    activity
      ? {
          biz_id: activity.biz_id,
          name: activity.name,
          activity_type: activity.activity_type,
          status: activity.status,
          activity_switch: activity.activity_switch,
          start_time: activity.start_time,
          stop_time: activity.stop_time,
          cycle_stop_time: activity.cycle_stop_time
        }
      : "沒有取得 activity info"
  );

  const before = await getSignInData(loginInfo.authedHeaders, TEST_BIZ_ID);
  const beforeSummary = summarizeSignIn(before);

  console.log("\n=== Before ===");
  console.log(beforeSummary);

  const todayItem = getTodayItem(before);

  if (!todayItem) {
    logWarn("沒有今天可簽項目，停止，不會 receive。");
    return;
  }

  logInfo(`今天可簽：day ${todayItem.day_no}`);

  if (!REALLY_RECEIVE) {
    logWarn("REALLY_RECEIVE=false，跳過真正領取。");
    logWarn("如果要真的測試，把 REALLY_RECEIVE 改成 true 再跑。");
    return;
  }

  logWarn("即將真正呼叫 receive...");
  await sleep(1500);

  const receiveResult = await receiveTodaySignIn(
    loginInfo.authedHeaders,
    TEST_BIZ_ID
  );

  printGiftResponse(receiveResult);

  await sleep(1000);

  const after = await getSignInData(loginInfo.authedHeaders, TEST_BIZ_ID);
  const afterSummary = summarizeSignIn(after);

  console.log("\n=== After ===");
  console.log(afterSummary);

  console.log("\n=== Diff ===");
  console.log({
    has_sign_in_days: `${beforeSummary.has_sign_in_days} -> ${afterSummary.has_sign_in_days}`,
    signed_days: `${beforeSummary.signed_days.join(",") || "(empty)"} -> ${afterSummary.signed_days.join(",") || "(empty)"}`,
    available_today_days: `${beforeSummary.available_today_days.join(",") || "(empty)"} -> ${afterSummary.available_today_days.join(",") || "(empty)"}`
  });

  logOk("Old sign-in test finished");
}

main().catch(err => {
  logError(`Old sign-in test failed: ${err.message}`);
  process.exit(1);
});