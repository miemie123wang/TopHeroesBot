const BASE = "https://topheroes.store.kopglobal.com";
const SITE_ID = 1028526;
const PROJECT_ID = 1028637;

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const APPS_SCRIPT_KEY = process.env.APPS_SCRIPT_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const headers = {
  "Content-Type": "application/json",
  accept: "application/json, text/plain, */*",
  "user-agent":
    "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36",
  cookie: "lang=en"
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function randomSleep(min, max) {
  return sleep(Math.floor(Math.random() * (max - min + 1)) + min);
}

function nowText() {
  return new Date().toLocaleString("zh-CN", {
    timeZone: "America/Montreal",
    hour12: false
  });
}

function logInfo(message) {
  console.log(`[${nowText()}] ℹ️ ${message}`);
}

function logOk(message) {
  console.log(`[${nowText()}] ✅ ${message}`);
}

function logWarn(message) {
  console.warn(`[${nowText()}] ⚠️ ${message}`);
}

function logError(message) {
  console.error(`[${nowText()}] ❌ ${message}`);
}

const stats = {
  total: 0,
  success: 0,
  failed: 0,
  today: 0,
  makeup: 0,
  alreadyDone: 0,
  failures: []
};

function maskUid(uid) {
  uid = String(uid);
  if (uid.length <= 4) return "****";
  return uid.slice(0, 2) + "*".repeat(uid.length - 4) + uid.slice(-2);
}

function getTodayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function getNicknameFromLoginData(loginData) {
  return (
    loginData?.data?.user?.nickname ||
    loginData?.data?.nickname ||
    loginData?.user?.nickname ||
    "Unknown"
  );
}

async function fetchJson(url, options = {}, retries = 2) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      const text = await res.text();

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`回傳不是 JSON，HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
      }

      return data;
    } catch (err) {
      lastError = err;

      if (attempt < retries) {
        const wait = 1000 + attempt * 1500;
        logWarn(`請求失敗，${wait}ms 後重試 ${attempt + 1}/${retries}: ${err.message}`);
        await sleep(wait);
      }
    }
  }

  throw lastError;
}

async function fetchJsonWithHeaders(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`回傳不是 JSON，HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }

  return { data, res };
}

async function sendDiscord(message) {
  if (!DISCORD_WEBHOOK_URL) return;

  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message })
    });
  } catch (err) {
    logError(`Discord 通知失敗: ${err.message}`);
  }
}

async function fetchApprovedUids() {
  if (!APPS_SCRIPT_URL || !APPS_SCRIPT_KEY) {
    throw new Error("缺少 APPS_SCRIPT_URL 或 APPS_SCRIPT_KEY 環境變量");
  }

  const url = `${APPS_SCRIPT_URL}?key=${encodeURIComponent(APPS_SCRIPT_KEY)}`;
  const data = await fetchJson(url, { redirect: "follow" });

  if (data.error) {
    throw new Error(`Apps Script 錯誤: ${data.error}`);
  }

  return data.uids || [];
}

async function loginOnce(uid) {
  const url = `${BASE}/api/v2/store/login/player`;

  const { data: loginData, res: loginRes } = await fetchJsonWithHeaders(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      site_id: SITE_ID,
      player_id: uid,
      server_id: "",
      device: "mobile"
    })
  });

  if (loginData.code !== 1) {
    throw new Error(`登錄失敗: ${loginData.message || JSON.stringify(loginData)}`);
  }

  const token =
    loginRes.headers.get("authorization") ||
    loginRes.headers.get("Authorization") ||
    loginData?.data?.authorization ||
    loginData?.data?.token ||
    loginData?.authorization ||
    loginData?.token;

  return {
    nickname: getNicknameFromLoginData(loginData),
    token
  };
}

async function preCheckPlayer(uid) {
  const url =
    `${BASE}/api/v2/store/player-info` +
    `?project_id=${PROJECT_ID}` +
    `&player_id=${encodeURIComponent(uid)}` +
    `&site_id=${SITE_ID}`;

  try {
    await fetch(url, {
      method: "GET",
      headers
    });
  } catch {
    // player-info 失败不影响 login
  }
}

async function login(uid, maxRetries = 6) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // 登录前预热
      await preCheckPlayer(uid);

      // 模拟真人操作
      await randomSleep(1000, 3000);

      const loginRes = await fetch(`${BASE}/api/v2/store/login/player`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          site_id: SITE_ID,
          player_id: uid,
          server_id: "",
          device: "pc"
        })
      });

      const text = await loginRes.text();

      if (!loginRes.ok) {
        throw new Error(`HTTP ${loginRes.status}: ${text}`);
      }

      let loginData;

      try {
        loginData = JSON.parse(text);
      } catch {
        throw new Error(`返回不是 JSON：${text}`);
      }

      if (loginData.code !== 1) {
        throw new Error(loginData.message || JSON.stringify(loginData));
      }

      const nickname = loginData?.data?.user?.nickname || "(unknown)";
      const token = loginRes.headers.get("authorization");

      if (!token) {
        throw new Error(`沒有拿到 token (${nickname})`);
      }

      return {
        nickname,
        authedHeaders: {
          ...headers,
          authorization: token
        }
      };

    } catch (err) {
      lastError = err;

      if (attempt < maxRetries) {
        const wait = 15000 + Math.floor(Math.random() * 20000);

        console.warn(
          `[login ${attempt}/${maxRetries}] ${maskUid(uid)} 失敗：${err.message}`
        );
        console.warn(`等待 ${Math.round(wait / 1000)} 秒後重試...`);

        await sleep(wait);
      }
    }
  }

  throw new Error(
    `登入失敗（已重試 ${maxRetries} 次）：${lastError.message}`
  );
}
async function getCurrentSignActivity(authedHeaders) {
  const data = await fetchJson(
    `${BASE}/api/v2/store/sale/biz/list?project_id=${PROJECT_ID}&status=2`,
    { headers: authedHeaders }
  );

  if (!data?.data?.list) {
    throw new Error(`沒有取得活動列表: ${JSON.stringify(data)}`);
  }

  const activity = data.data.list.find(
    (item) =>
      item.activity_type === 4 &&
      item.status === 2 &&
      item.activity_switch === 1
  );

  if (!activity) {
    throw new Error("沒有找到進行中的簽到活動");
  }

  return {
    id: activity.biz_id,
    name: activity.name
  };
}

async function getSignInData(authedHeaders, activityId) {
  const data = await fetchJson(
    `${BASE}/api/v2/store/sale/biz/sign-in-list?activity_id=${activityId}&page_size=365&site_id=${SITE_ID}&page_no=1`,
    { headers: authedHeaders }
  );

  if (!data?.data?.sign_in_list) {
    throw new Error(`沒有簽到資料: ${JSON.stringify(data)}`);
  }

  return data.data;
}

function getMakeupItems(signInList) {
  return signInList.filter((item) => item.is_appending && !item.is_sign_in);
}

function getTodayItem(signInList) {
  return signInList.find(
    (item) =>
      item.is_available_sign_in &&
      !item.is_sign_in &&
      !item.is_appending
  );
}

async function receiveMakeupSignIn(authedHeaders, activityId, item) {
  const data = await fetchJson(`${BASE}/api/v2/store/sale/biz/sign-in/gift/receive`, {
    method: "POST",
    headers: authedHeaders,
    body: JSON.stringify({
      activity_id: activityId,
      sign_in_type: 2,
      site_id: SITE_ID,
      day_no: item.day_no,
      appending_date: getTodayDateString()
    })
  });

  if (data.code !== 1) {
    throw new Error(`補簽失敗: ${JSON.stringify(data)}`);
  }

  return data;
}

async function receiveTodaySignIn(authedHeaders, activityId) {
  const data = await fetchJson(`${BASE}/api/v2/store/sale/biz/sign-in/gift/receive`, {
    method: "POST",
    headers: authedHeaders,
    body: JSON.stringify({
      activity_id: activityId,
      sign_in_type: 1,
      site_id: SITE_ID
    })
  });

  if (data.code !== 1) {
    throw new Error(`今天簽到失敗: ${JSON.stringify(data)}`);
  }

  return data;
}

function logSignStatus(signInData) {
  const total = signInData.sign_in_list?.length ?? "?";
  logInfo(`已簽到天數: ${signInData.has_sign_in_days}/${total}`);
  logInfo(`剩餘補簽次數: ${signInData.remain_appending_days}`);
}

async function processSignedInAccount(nickname, authedHeaders, activity) {
  logInfo(`開始處理 ✓ (${nickname})`);

  let signInData = await getSignInData(authedHeaders, activity.id);

  logSignStatus(signInData);

  let makeupCount = 0;
  let todaySigned = false;

  while (true) {
    const makeupItems = getMakeupItems(signInData.sign_in_list);

    logInfo(`目前可補簽 ${makeupItems.length} 天`);

    if (makeupItems.length === 0 || signInData.remain_appending_days <= 0) {
      break;
    }

    const item = makeupItems[0];

    logInfo(`開始補簽：day ${item.day_no}`);

    await receiveMakeupSignIn(authedHeaders, activity.id, item);

    makeupCount++;
    stats.makeup++;

    logOk(`補簽成功 day ${item.day_no}`);

    await randomSleep(1500, 3500);

    signInData = await getSignInData(authedHeaders, activity.id);
  }

  const today = getTodayItem(signInData.sign_in_list);

  if (today) {
    logInfo(`今天可以簽到 day ${today.day_no}`);

    await receiveTodaySignIn(authedHeaders, activity.id);

    todaySigned = true;
    stats.today++;

    logOk("今天簽到成功");

    await randomSleep(1500, 3500);
  } else if (signInData.has_sign_in_days >= signInData.sign_in_list_total) {
    logOk("今天已簽到");
  } else {
    logInfo("沒有今天可簽項目");
  }

  if (makeupCount === 0 && !todaySigned) {
    stats.alreadyDone++;
  }

  stats.success++;

  return {
    nickname,
    makeupCount,
    todaySigned
  };
}

async function processUid(uid, activity) {
  console.log(`\n========== UID: ${maskUid(uid)} ==========`);

  const loginInfo = await login(uid);

  return await processSignedInAccount(
    loginInfo.nickname,
    loginInfo.authedHeaders,
    activity
  );
}

async function main() {
  logInfo("TopHeroesBot signin started");

  let uids;
  try {
    uids = await fetchApprovedUids();
  } catch (err) {
    const msg = `🚨 Top Heroes 簽到中止\n取得 Approved UID 失敗。\n原因: ${err.message}`;
    logError(msg);
    await sendDiscord(msg);
    process.exit(1);
  }

  stats.total = uids.length;

  logInfo(`找到 ${uids.length} 個已 Approved 的帳號`);

  if (uids.length === 0) {
    logInfo("沒有 UID，結束。");
    process.exit(0);
  }

  let activity = null;

  try {
    const firstUid = uids[0];

    console.log(`\n========== 第一個 UID: ${maskUid(firstUid)} ==========`);

    const firstLogin = await login(firstUid);

    logOk(`第一個帳號登錄成功 (${firstLogin.nickname})`);

    activity = await getCurrentSignActivity(firstLogin.authedHeaders);

    logInfo(`目前簽到活動：${activity.name} / biz_id=${activity.id}`);

    const firstResult = await processSignedInAccount(
      firstLogin.nickname,
      firstLogin.authedHeaders,
      activity
    );

    logOk(
      `第一個帳號完成：${firstResult.nickname}，補簽 ${firstResult.makeupCount} 次，今天簽到：${firstResult.todaySigned ? "是" : "否"}`
    );
  } catch (err) {
    stats.failed++;

    const msg =
`🚨 Top Heroes 簽到中止
第一個 UID 失敗，已停止後續帳號。
UID: ${maskUid(uids[0])}
原因: ${err.message}`;

    logError(msg);
    await sendDiscord(msg);

    process.exit(1);
  }

  await randomSleep(5000, 10000);

  for (let i = 1; i < uids.length; i++) {
    const uid = uids[i];

    try {
      const result = await processUid(uid, activity);

      logOk(
        `完成：${result.nickname}，補簽 ${result.makeupCount} 次，今天簽到：${result.todaySigned ? "是" : "否"}`
      );
    } catch (err) {
      stats.failed++;

      const msg =
`❌ Top Heroes 簽到失敗
進度: ${i + 1}/${uids.length}
UID: ${maskUid(uid)}
Activity: ${activity.name} / ${activity.id}
原因: ${err.message}`;

      stats.failures.push(msg);

      logError(msg);
      await sendDiscord(msg);
    }

    await randomSleep(5000, 10000);
  }

  const summary =
`✅ Top Heroes 簽到完成
活動: ${activity.name}
Activity ID: ${activity.id}
總數: ${stats.total}
成功: ${stats.success}
失敗: ${stats.failed}
今日簽到: ${stats.today}
補簽次數: ${stats.makeup}
已完成/無需操作: ${stats.alreadyDone}`;

  console.log("\n" + summary);
  await sendDiscord(summary);

  logOk("全部完成！");
}

main().catch(async (err) => {
  const msg = `🚨 Top Heroes 簽到程式異常\n原因: ${err.message}`;
  logError(msg);
  await sendDiscord(msg);
  process.exit(1);
});
