import { readFileSync, writeFileSync, existsSync } from "fs";

import { env } from "../../core/config.mjs";
import { fetchApprovedUids } from "../../core/sheet.mjs";
import {
  DiscordApiError,
  fetchDiscordJson,
  sendDiscord
} from "../../core/discord.mjs";
import { redeemAllUids } from "../redeem/redeem-service.mjs";

const { DISCORD_TOKEN, DISCORD_WEBHOOK } = env;
const MANUAL_CODE = process.env.MANUAL_CODE;

const CHANNEL_IDS = [
  "1343771733173473311",
  "1112595962515427338"
];

const STATE_FILE = "last_message_id.txt";
const MAX_PROCESSED_CODES = 100;

const discordHeaders = {
  Authorization: DISCORD_TOKEN,
  "Content-Type": "application/json"
};

function createEmptyState() {
  return {
    channels: {},
    processedCodes: {}
  };
}

function loadState() {
  if (!existsSync(STATE_FILE)) return createEmptyState();

  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf-8").trim());

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return createEmptyState();
    }

    // 向後相容舊格式：{ "channelId": "lastMessageId" }
    if (!parsed.channels) {
      return {
        channels: { ...parsed },
        processedCodes: {}
      };
    }

    return {
      channels:
        parsed.channels && typeof parsed.channels === "object"
          ? parsed.channels
          : {},
      processedCodes:
        parsed.processedCodes && typeof parsed.processedCodes === "object"
          ? parsed.processedCodes
          : {}
    };
  } catch (error) {
    console.warn(`讀取 ${STATE_FILE} 失敗，使用空狀態: ${error.message}`);
    return createEmptyState();
  }
}

function pruneProcessedCodes(processedCodes) {
  return Object.fromEntries(
    Object.entries(processedCodes)
      .sort(([, a], [, b]) => String(b.processedAt || "").localeCompare(String(a.processedAt || "")))
      .slice(0, MAX_PROCESSED_CODES)
  );
}

function saveState(state) {
  const safeState = {
    channels: state.channels || {},
    processedCodes: pruneProcessedCodes(state.processedCodes || {})
  };

  writeFileSync(STATE_FILE, `${JSON.stringify(safeState, null, 2)}\n`);
}

function normalizeCode(code) {
  return String(code || "").trim();
}

function extractGiftCode(content) {
  const backtickMatch = content.match(/`([A-Za-z0-9]{6,20})`/);
  const labelMatch = content.match(/(?:giftcode|redeem\s*code)[^\n]*\n+([A-Za-z0-9]{6,20})/i);
  const blockMatch = content.match(/^([A-Za-z0-9]{6,20})$/m);

  const code = backtickMatch?.[1] || labelMatch?.[1] || blockMatch?.[1];
  if (!code) return null;

  const hasCodeKeyword = /code|gift|redeem/i.test(content);
  return hasCodeKeyword ? normalizeCode(code) : null;
}

async function sendNotification(content) {
  if (!DISCORD_WEBHOOK) {
    console.error("缺少 DISCORD_WEBHOOK 環境變量");
    return false;
  }

  return sendDiscord(content, DISCORD_WEBHOOK);
}

function describeDiscordError(error) {
  if (!(error instanceof DiscordApiError)) return error.message;

  switch (error.code) {
    case "DISCORD_UNAUTHORIZED":
      return "Discord token 已失效或未授權 (401)";
    case "DISCORD_FORBIDDEN":
      return "Discord token 無權讀取此頻道 (403)";
    case "DISCORD_RATE_LIMITED":
      return `Discord API 觸發限流 (429)${error.retryAfterMs ? `，建議 ${error.retryAfterMs}ms 後重試` : ""}`;
    case "DISCORD_SERVER_ERROR":
      return `Discord 伺服器錯誤 (${error.status})`;
    case "DISCORD_NETWORK_ERROR":
      return "Discord 網路請求失敗";
    default:
      return error.message;
  }
}

async function fetchChannelMessages(channelId, params) {
  return fetchDiscordJson(
    `https://discord.com/api/v10/channels/${channelId}/messages?${params}`,
    { headers: discordHeaders }
  );
}

async function initializeChannels(state, metrics) {
  let initializedAny = false;

  for (const channelId of CHANNEL_IDS) {
    if (state.channels[channelId]) continue;

    try {
      const messages = await fetchChannelMessages(
        channelId,
        new URLSearchParams({ limit: "1" })
      );

      metrics.channelsScanned += 1;

      if (messages.length) {
        state.channels[channelId] = messages[0].id;
        console.log(`頻道 ${channelId} 初始化完成`);
        initializedAny = true;
      }
    } catch (error) {
      throw error;
    }
  }

  return initializedAny;
}

async function checkDiscordChannels(state, metrics) {
  const foundCodes = [];
  const pendingChannelIds = {};

  for (const channelId of CHANNEL_IDS) {
    const lastId = state.channels[channelId];
    const params = new URLSearchParams({ limit: "10" });
    if (lastId) params.append("after", lastId);

    let messages;
    try {
      messages = await fetchChannelMessages(channelId, params);
      metrics.channelsScanned += 1;
    } catch (error) {
      metrics.discordErrors += 1;
      console.error(`頻道 ${channelId} 讀取失敗: ${describeDiscordError(error)}`);

      if (
        error instanceof DiscordApiError &&
        ["DISCORD_UNAUTHORIZED", "DISCORD_FORBIDDEN"].includes(error.code)
      ) {
        throw error;
      }

      continue;
    }

    if (!messages.length) continue;

    messages.sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? 1 : -1));
    metrics.messagesChecked += messages.length;

    for (const msg of messages) {
      console.log("原始消息:", JSON.stringify(msg.content));

      const code = extractGiftCode(msg.content || "");
      if (!code) continue;

      metrics.codesFound += 1;
      console.log(`頻道 ${channelId} 發現兌換碼: ${code}`);
      foundCodes.push(code);
    }

    // 只有本頻道請求與解析都成功後，才準備推進游標。
    pendingChannelIds[channelId] = messages[messages.length - 1].id;
  }

  return { foundCodes, pendingChannelIds };
}

function getManualCodes() {
  if (!MANUAL_CODE || !MANUAL_CODE.trim()) return [];

  return MANUAL_CODE
    .split(/[\s,，;；]+/)
    .map(normalizeCode)
    .filter(Boolean);
}

function dedupeCodes(codes, processedCodes, metrics, ignoreHistory = false) {
  const unique = [];
  const seen = new Set();

  for (const code of codes) {
    const normalized = normalizeCode(code);

    if (seen.has(normalized)) {
      metrics.duplicateCodes += 1;
      continue;
    }
    seen.add(normalized);

    if (!ignoreHistory && processedCodes[normalized]) {
      metrics.previouslyProcessed += 1;
      console.log(`跳過已處理兌換碼 ${normalized}（${processedCodes[normalized].status || "unknown"}）`);
      continue;
    }

    unique.push(normalized);
  }

  metrics.uniqueCodes = unique.length;
  return unique;
}

function createMetrics() {
  return {
    channelsScanned: 0,
    messagesChecked: 0,
    codesFound: 0,
    uniqueCodes: 0,
    duplicateCodes: 0,
    previouslyProcessed: 0,
    codesProcessed: 0,
    globalFailures: 0,
    accountFailures: 0,
    redemptionSuccesses: 0,
    discordErrors: 0,
    startedAt: Date.now()
  };
}

function printMonitorSummary(metrics) {
  const elapsedSeconds = ((Date.now() - metrics.startedAt) / 1000).toFixed(1);

  console.log("\n========== Monitor Summary ==========");
  console.log(`Channels scanned: ${metrics.channelsScanned}`);
  console.log(`Messages checked: ${metrics.messagesChecked}`);
  console.log(`Gift codes found: ${metrics.codesFound}`);
  console.log(`Unique new codes: ${metrics.uniqueCodes}`);
  console.log(`Duplicate codes: ${metrics.duplicateCodes}`);
  console.log(`Previously processed: ${metrics.previouslyProcessed}`);
  console.log(`Codes processed: ${metrics.codesProcessed}`);
  console.log(`Successful redemptions: ${metrics.redemptionSuccesses}`);
  console.log(`Account failures: ${metrics.accountFailures}`);
  console.log(`Global failures: ${metrics.globalFailures}`);
  console.log(`Discord API errors: ${metrics.discordErrors}`);
  console.log(`Elapsed: ${elapsedSeconds}s`);
}

async function main() {
  const metrics = createMetrics();
  const state = loadState();
  let pendingChannelIds = {};

  try {
    if (!DISCORD_TOKEN && !MANUAL_CODE) {
      throw new Error("缺少 DISCORD_TOKEN 環境變量；如需手動兌換，請提供 MANUAL_CODE");
    }

    let codes = getManualCodes();
    const isManual = codes.length > 0;

    if (isManual) {
      console.log(`使用手動輸入兌換碼: ${codes.join(", ")}`);
      metrics.codesFound = codes.length;
    } else {
      console.log("檢查 Discord 頻道...");

      const initializedAny = await initializeChannels(state, metrics);
      if (initializedAny) {
        saveState(state);
        console.log("初始化完成，下次運行開始監聽新消息");
        return;
      }

      const scanResult = await checkDiscordChannels(state, metrics);
      codes = scanResult.foundCodes;
      pendingChannelIds = scanResult.pendingChannelIds;
    }

    // 手動輸入視為明確重試，不受歷史去重限制。
    codes = dedupeCodes(codes, state.processedCodes, metrics, isManual);

    if (!codes.length) {
      console.log("沒有新的 code");
      state.channels = { ...state.channels, ...pendingChannelIds };
      saveState(state);
      return;
    }

    console.log("發現 code，從 Google Sheet 獲取已 Approved 的 UID...");
    const uids = await fetchApprovedUids();

    if (uids.length === 0) {
      console.log("沒有已 Approved 的 UID，保留游標以便下次重試");
      return;
    }

    console.log(`找到 ${uids.length} 個已 Approved 的帳號`);

    for (const code of codes) {
      console.log(`開始為 ${uids.length} 個帳號兌換: ${code}`);

      const result = await redeemAllUids(code, uids, {
        validateFirst: true,
        concurrency: Number(process.env.REDEEM_CONCURRENCY || 2),
        staggerMs: Number(process.env.REDEEM_STAGGER_MS || 2000),
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
        onFirstFailure: async ({ result: firstResult, codeWide }) => {
          if (codeWide) {
            await sendNotification(
              `⛔ \`${code}\` 為全局無效碼，已停止後續帳號。\n原因：${firstResult.message}`
            );
            return;
          }

          console.log(`首個帳號為帳號級失敗，繼續其他帳號：${firstResult.message}`);
        },
        afterComplete: async ({ summary }) => {
          const time = new Date().toLocaleString("zh-CN", {
            timeZone: "America/Toronto"
          });

          const status = summary.stoppedEarly
            ? "⚠️ 網頁碼兌換提前停止"
            : "✅ 網頁碼兌換完成";

          await sendNotification(
            `${status}！\n` +
              `碼：\`${code}\`\n` +
              `成功：${summary.success}\n` +
              `失敗：${summary.failed}\n` +
              `跳過：${summary.skipped}\n` +
              `已嘗試：${summary.attempted}/${summary.total}\n` +
              `時間：${time}`
          );
          console.log("兌換流程完成 ✓");
        }
      });

      metrics.codesProcessed += 1;
      metrics.redemptionSuccesses += result.success;
      metrics.accountFailures += result.results.filter(
        item => !item.success && !item.skipped && item.scope === "account"
      ).length;

      if (result.stoppedEarly && result.stopResult?.scope === "global") {
        metrics.globalFailures += 1;
      }

      state.processedCodes[code] = {
        processedAt: new Date().toISOString(),
        status:
          result.stoppedEarly && result.stopResult?.scope === "global"
            ? `global:${result.stopResult.code}`
            : "completed",
        success: result.success,
        failed: result.failed
      };
    }

    // 所有找到的新 code 都完成處理後，才提交本次成功掃描的頻道游標。
    state.channels = { ...state.channels, ...pendingChannelIds };
    saveState(state);
  } catch (error) {
    const message = describeDiscordError(error);
    console.error(`🚨 Monitor 中止: ${message}`);

    if (error instanceof DiscordApiError) {
      if (metrics.discordErrors === 0) metrics.discordErrors += 1;
      await sendNotification(`🚨 Discord Monitor 失敗\n${message}\n請檢查 DISCORD_TOKEN 與頻道權限。`);
    }

    process.exitCode = 1;
  } finally {
    printMonitorSummary(metrics);
  }
}

main();
