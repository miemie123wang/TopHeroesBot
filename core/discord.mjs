import { env } from "./config.mjs";
import { logError } from "./logger.mjs";

export class DiscordApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "DiscordApiError";
    this.status = options.status ?? null;
    this.code = options.code ?? "DISCORD_API_ERROR";
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.responseBody = options.responseBody ?? null;
  }
}

function classifyDiscordStatus(status) {
  if (status === 401) return "DISCORD_UNAUTHORIZED";
  if (status === 403) return "DISCORD_FORBIDDEN";
  if (status === 429) return "DISCORD_RATE_LIMITED";
  if (status >= 500) return "DISCORD_SERVER_ERROR";
  return "DISCORD_HTTP_ERROR";
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function fetchDiscordJson(url, options = {}) {
  let response;

  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new DiscordApiError(`Discord 網路請求失敗: ${error.message}`, {
      code: "DISCORD_NETWORK_ERROR"
    });
  }

  const body = await readResponseBody(response);

  if (!response.ok) {
    const retryAfterSeconds = Number(body?.retry_after);
    const retryAfterMs = Number.isFinite(retryAfterSeconds)
      ? Math.ceil(retryAfterSeconds * 1000)
      : null;

    throw new DiscordApiError(
      `Discord API ${response.status}: ${body?.message || response.statusText || "request failed"}`,
      {
        status: response.status,
        code: classifyDiscordStatus(response.status),
        retryAfterMs,
        responseBody: body
      }
    );
  }

  return body;
}

export async function sendDiscord(message, webhookUrl = env.DISCORD_WEBHOOK_URL) {
  if (!webhookUrl) return false;

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
    }

    return true;
  } catch (err) {
    logError(`Discord 通知失敗: ${err.message}`);
    return false;
  }
}
