import * as readline from "readline";

const BASE = "https://topheroes.store.kopglobal.com";
const SITE_ID = 1028526;
const PROJECT_ID = 1028637;

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const APPS_SCRIPT_KEY = process.env.APPS_SCRIPT_KEY;

const headers = {
  "Content-Type": "application/json",
  "accept": "application/json, text/plain, */*",
  "user-agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36",
  "cookie": "lang=en"
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function maskUid(uid) {
  if (uid.length <= 4) return "****";
  return uid.slice(0, 2) + "*".repeat(uid.length - 4) + uid.slice(-2);
}

async function preCheckPlayer(uid) {
  const url = `${BASE}/api/v2/store/player-info?project_id=${PROJECT_ID}&player_id=${encodeURIComponent(uid)}&site_id=${SITE_ID}`;

  const res = await fetch(url, {
    method: "GET",
    headers
  });

  // 不强制要求成功，只当作登录前预热
  const text = await res.text();

  if (!res.ok) {
    console.warn(`player-info 預檢失敗 HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function fetchApprovedUids() {
  if (!APPS_SCRIPT_URL || !APPS_SCRIPT_KEY) {
    throw new Error("缺少 APPS_SCRIPT_URL 或 APPS_SCRIPT_KEY 環境變量");
  }
  const url = `${APPS_SCRIPT_URL}?key=${encodeURIComponent(APPS_SCRIPT_KEY)}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Apps Script 請求失敗: ${res.status}`);
  }
  const data = await res.json();
  if (data.error) {
    throw new Error(`Apps Script 錯誤: ${data.error}`);
  }
  return data.uids || [];
}

async function getCode() {
  // Try environment variable first (GitHub Actions)
  if (process.env.REDEEM_CODE) {
    return process.env.REDEEM_CODE.trim();
  }
  // Otherwise prompt
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question("輸入兌換碼: ", (code) => {
      rl.close();
      resolve(code.trim().toUpperCase());
    });
  });
}

async function redeemForUid(uid, code) {
  console.log(`\n========== UID: ${maskUid(uid)} ==========`);

  // Step 1: reporting
  await fetch(`${BASE}/api/v2/store/point/reporting`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      project_id: PROJECT_ID,
      store_id: SITE_ID,
      merchant_id: 1002558,
      country: "CA",
      type: "UID_LOGIN_SHOW",
      device: "mobile",
      platform: "android"
    })
  });
  await sleep(1000);

  // Step 2: login
  await preCheckPlayer(uid);
  const loginRes = await fetch(`${BASE}/api/v2/store/login/player`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      site_id: SITE_ID,
      player_id: uid,
      server_id: "",
      device: "mobile"
    })
  });
  const loginData = await loginRes.json();
  if (loginData.code !== 1) {
    console.error("登錄失敗:", loginData.message);
    return;
  }
  const token = loginRes.headers.get("authorization");
  if (!token) {
    console.error("沒有拿到 token");
    return;
  }
  console.log(`登錄成功 ✓ (${loginData.data.user.nickname})`);
  await sleep(1000);

  // Step 3: redeem
  const redeemRes = await fetch(`${BASE}/api/v2/store/redemption/redeem`, {
    method: "POST",
    headers: { ...headers, authorization: token },
    body: JSON.stringify({
      project_id: PROJECT_ID,
      redemption_code: code
    })
  });
  const redeemData = await redeemRes.json();
  if (redeemData.code === 1) {
    console.log(`兌換成功 ✓ (${code})`);
  } else {
    console.error(`兌換失敗: ${redeemData.message}`);
  }
}

// 從 Google Sheet 獲取 UID
const uids = await fetchApprovedUids();

console.log(`找到 ${uids.length} 個已 Approved 的帳號`);
const code = await getCode();
if (!code) {
  console.error("沒有輸入兌換碼");
  process.exit(1);
}

console.log(`\n開始兌換: ${code}`);
for (const uid of uids) {
  await redeemForUid(uid, code);
  await sleep(3000 + Math.random() * 3000);
}
console.log("\n全部完成！");