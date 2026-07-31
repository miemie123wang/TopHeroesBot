export const OLD_MALL_BASE_URL = "https://topheroes.store.kopglobal.com";
export const NEW_MALL_BASE_URL = "https://topheroes.pay-store.rivergame.net";

// 兼容 auth.mjs
export const OLD_BASE = OLD_MALL_BASE_URL;
export const NEW_BASE = NEW_MALL_BASE_URL;

// 保留旧代码兼容
export const BASE = NEW_BASE;

export const SITE_ID = 1028526;
export const PROJECT_ID = 1028637;
export const MERCHANT_ID = 1002558;
export const DEBUG_UID = "1730046798208";

// 临时签到活动兜底。
// 正式流程仍会优先自动读取活动列表；只有自动发现失败时才使用这里。
// 也可以在 GitHub Actions / 本地环境中用 SIGNIN_ACTIVITY_ID 临时覆盖。
export const SIGNIN_FALLBACK_ACTIVITY_ID = Number(
  process.env.SIGNIN_ACTIVITY_ID || 3431
);
export const SIGNIN_FALLBACK_ACTIVITY_NAME =
  process.env.SIGNIN_ACTIVITY_NAME || "史莱姆签到0727-2-正式";

export const env = {
  APPS_SCRIPT_URL: process.env.APPS_SCRIPT_URL,
  APPS_SCRIPT_KEY: process.env.APPS_SCRIPT_KEY,
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK,
};
