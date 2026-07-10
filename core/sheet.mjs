import { env } from "./config.mjs";
import { fetchJson } from "./api.mjs";

export async function fetchApprovedUids() {
  const { APPS_SCRIPT_URL, APPS_SCRIPT_KEY } = env;

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
