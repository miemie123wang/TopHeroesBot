import { readFileSync, writeFileSync, existsSync } from "fs";

const BASE = "https://topheroes.store.kopglobal.com";
const SITE_ID = 1028526;
const PROJECT_ID = 1028637;

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const APPS_SCRIPT_KEY = process.env.APPS_SCRIPT_KEY;
const MANUAL_CODE = process.env.MANUAL_CODE;

const CHANNEL_IDS = [
  "1343771733173473311",
  "1112595962515427338"
];

const LAST_MSG_FILE = "last_message_id.txt";

const gameHeaders = {
  "Content-Type": "application/json",
  "accept": "application/json, text/plain, */*",
  "user-agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36",
  "cookie": "lang=en"
};

const discordHeaders = {
  "Authorization": DISCORD_TOKEN,
  "Content-Type": "application/json"
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const randomSleep = (min, max) =>
  sleep(min + Math.floor(Math.random() * (max - min)));

function maskUid(uid) {
  uid = String(uid);
  if (uid.length <= 4) return "****";
  return uid.slice(0, 2) + "*".repeat(uid.length - 4) + uid.slice(-2);
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

function loadLastMessageId() {
  if (existsSync(LAST_MSG_FILE)) {
    try {
      const content = readFileSync(LAST_MSG_FILE, "utf-8").trim();
      const parsed = JSON.parse(content);
      if (typeof parsed !== "object" || parsed === null) return {};
      return parsed;
    } catch {
      return {};
    }
  }

  return {};
}

function saveLastMessageId(ids) {
  writeFileSync(LAST_MSG_FILE, JSON.stringify(ids));
}

function extractGiftCode(content) {
  const backtickMatch = content.match(/`([A-Za-z0-9]{6,20})`/);
  const labelMatch = content.match(/(?:giftcode|redeem\s*code)[^\n]*\n+([A-Za-z0-9]{6,20})/i);
  const blockMatch = content.match(/^([A-Za-z0-9]{6,20})$/m);

  const code = backtickMatch?.[1] || labelMatch?.[1] || blockMatch?.[1];
  if (!code) return null;

  const hasCodeKeyword = /code|gift|redeem/i.test(content);
  return hasCodeKeyword ? code : null;
}

async function sendNotification(content) {
  if (!DISCORD_WEBHOOK) {
    console.error("缺少 DISCORD_WEBHOOK 環境變量");
    return;
  }

  const res = await fetch(DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content })
  });

  if (!res.ok) {
    console.error("Webhook 發送失敗:", await res.text());
  }
}

async function checkDiscordChannel(lastMessageIds) {
  const allCodes = [];
  const newLastIds = { ...lastMessageIds };

  for (const channelId of CHANNEL_IDS) {
    const lastId = lastMessageIds[channelId];
    const params = new URLSearchParams({ limit: "10" });

    if (lastId) params.append("after", lastId);

    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages?${params}`,
      { headers: discordHeaders }
    );

    if (!res.ok) {
      console.error(`頻道 ${channelId} 錯誤: ${res.status}`);
      continue;
    }

    const messages = await res.json();

    if (!messages.length) continue;

    messages.sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? 1 : -1));

    for (const msg of messages) {
      console.log("原始消息:", JSON.stringify(msg.content));

      const code = extractGiftCode(msg.content);

      if (code && !allCodes.includes(code)) {
        console.log(`頻道 ${channelId} 發現兌換碼: ${code}`);
        allCodes.push(code);
      }
    }

    newLastIds[channelId] = messages[messages.length - 1].id;
  }

  return { newLastIds, codes: allCodes };
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
      headers: gameHeaders
    });
  } catch {
    // player-info 失败不影响 login
  }
}

async function login(uid, maxRetries = 6) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await preCheckPlayer(uid);

      await randomSleep(1000, 3000);

      const loginRes = await fetch(`${BASE}/api/v2/store/login/player`, {
        method: "POST",
        headers: gameHeaders,
        body: JSON.stringify({
          site_id: SITE_ID,
          player_id: uid,
          server_id: "",
          device: "mobile"
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
          ...gameHeaders,
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

  throw new Error(`登入失敗（已重試 ${maxRetries} 次）：${lastError.message}`);
}

async function redeemForUid(uid, code) {
  console.log(`  UID: ${maskUid(uid)}`);

  await fetch(`${BASE}/api/v2/store/point/reporting`, {
    method: "POST",
    headers: gameHeaders,
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

  try {
    const { nickname, authedHeaders } = await login(uid);

    console.log(`  登錄成功 ✓ (${nickname})`);

    await randomSleep(1000, 2500);

    const redeemRes = await fetch(`${BASE}/api/v2/store/redemption/redeem`, {
      method: "POST",
      headers: authedHeaders,
      body: JSON.stringify({
        project_id: PROJECT_ID,
        redemption_code: code
      })
    });

    const redeemText = await redeemRes.text();

    let redeemData;

    try {
      redeemData = JSON.parse(redeemText);
    } catch {
      console.error(`  兌換返回不是 JSON: ${redeemText}`);
      return false;
    }

    if (redeemData.code === 1) {
      console.log(`  兌換成功 ✓`);
      return true;
    }

    console.error(`  兌換失敗: ${redeemData.message || redeemText}`);
    return false;
  } catch (err) {
    console.error(`  登錄/兌換流程失敗: ${err.message}`);
    return false;
  }
}

async function redeemAllUids(code, uids) {
  console.log(`開始為 ${uids.length} 個帳號兌換: ${code}`);

  await sendNotification(`🎁 發現兌換碼：\`${code}\`\n正在嘗試網頁兌換，請稍候...`);

  const firstSuccess = await redeemForUid(uids[0], code);

  if (!firstSuccess) {
    await sendNotification(`🎮 \`${code}\` 網頁兌換失敗，請手動在遊戲內兌換！`);
    return;
  }

  for (const uid of uids.slice(1)) {
    await randomSleep(3000, 6000);
    await redeemForUid(uid, code);
  }

  const time = new Date().toLocaleString("zh-CN", {
    timeZone: "America/Toronto"
  });

  await sendNotification(`✅ 網頁碼兌換完成！\n碼：\`${code}\`\n時間：${time}`);

  console.log("全部兌換完成 ✓");
}

function getManualCodes() {
  if (!MANUAL_CODE || !MANUAL_CODE.trim()) return [];

  return MANUAL_CODE
    .split(/[\s,，;；]+/)
    .map(code => code.trim())
    .filter(Boolean);
}

async function main() {
  if (!DISCORD_TOKEN && !MANUAL_CODE) {
    console.error("缺少 DISCORD_TOKEN 環境變量；如需手動兌換，請提供 MANUAL_CODE");
    process.exit(1);
  }

  let codes = getManualCodes();

  if (codes.length > 0) {
    console.log(`使用手動輸入兌換碼: ${codes.join(", ")}`);
  } else {
    console.log("檢查 Discord 頻道...");

    let lastMessageIds = loadLastMessageId();

    let needsSave = false;

    for (const channelId of CHANNEL_IDS) {
      if (!lastMessageIds[channelId]) {
        const res = await fetch(
          `https://discord.com/api/v10/channels/${channelId}/messages?limit=1`,
          { headers: discordHeaders }
        );

        const messages = await res.json();

        if (messages.length) {
          lastMessageIds[channelId] = messages[0].id;
          console.log(`頻道 ${channelId} 初始化完成`);
          needsSave = true;
        }
      }
    }

    if (needsSave) {
      saveLastMessageId(lastMessageIds);
      console.log("初始化完成，下次運行開始監聽新消息");
      return;
    }

    const result = await checkDiscordChannel(lastMessageIds);

    saveLastMessageId(result.newLastIds);

    codes = result.codes;
  }

  if (!codes.length) {
    console.log("沒有新 code");
    return;
  }

  console.log("發現 code，從 Google Sheet 獲取已 Approved 的 UID...");

  const uids = await fetchApprovedUids();

  if (uids.length === 0) {
    console.log("沒有已 Approved 的 UID，結束");
    return;
  }

  console.log(`找到 ${uids.length} 個已 Approved 的帳號`);

  for (const code of codes) {
    await redeemAllUids(code, uids);
  }
}

main().catch(err => {
  console.error("🚨 程式中止:", err);
  process.exit(1);
});