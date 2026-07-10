import { readFileSync, writeFileSync, existsSync } from "fs";

import { env } from "../../core/config.mjs";
import { fetchApprovedUids } from "../../core/sheet.mjs";
import { sendDiscord } from "../../core/discord.mjs";
import { redeemAllUids } from "../redeem/redeem-service.mjs";

const { DISCORD_TOKEN, DISCORD_WEBHOOK } = env;
const MANUAL_CODE = process.env.MANUAL_CODE;

const CHANNEL_IDS = [
  "1343771733173473311",
  "1112595962515427338"
];

const LAST_MSG_FILE = "last_message_id.txt";

const discordHeaders = {
  "Authorization": DISCORD_TOKEN,
  "Content-Type": "application/json"
};

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

  await sendDiscord(content, DISCORD_WEBHOOK);
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
    console.log(`開始為 ${uids.length} 個帳號兌換: ${code}`);

    const result = await redeemAllUids(code, uids, {
      validateFirst: true,
      firstFailureStops: true,
      accountDelayMin: 3000,
      accountDelayMax: 6000,
      firstRedeemOptions: {
        indent: "  ",
        loginOptions: { device: "mobile" },
        loginDelayMin: 1000,
        loginDelayMax: 2500
      },
      redeemOptions: {
        indent: "  ",
        loginOptions: { device: "mobile" },
        loginDelayMin: 1000,
        loginDelayMax: 2500
      },
      beforeStart: async () => {
        await sendNotification(`🎁 發現兌換碼：\`${code}\`\n正在嘗試網頁兌換，請稍候...`);
      },
      onFirstFailure: async () => {
        await sendNotification(`🎮 \`${code}\` 網頁兌換失敗，請手動在遊戲內兌換！`);
      },
      afterComplete: async () => {
        const time = new Date().toLocaleString("zh-CN", {
          timeZone: "America/Toronto"
        });

        await sendNotification(`✅ 網頁碼兌換完成！\n碼：\`${code}\`\n時間：${time}`);
        console.log("全部兌換完成 ✓");
      }
    });

    if (result.stoppedEarly) {
      continue;
    }
  }
}

main().catch(err => {
  console.error("🚨 程式中止:", err);
  process.exit(1);
});