import { env } from "./config.mjs";
import { logError } from "./logger.mjs";

export async function sendDiscord(message, webhookUrl = env.DISCORD_WEBHOOK_URL) {
  if (!webhookUrl) return;

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message })
    });
  } catch (err) {
    logError(`Discord 通知失敗: ${err.message}`);
  }
}
