export const BASE = "https://topheroes.store.kopglobal.com";

export const SITE_ID = 1028526;
export const PROJECT_ID = 1028637;
export const MERCHANT_ID = 1002558;

export const headers = {
  "Content-Type": "application/json",
  accept: "application/json, text/plain, */*",
  "user-agent":
    "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36",
  cookie: "lang=en"
};

export const env = {
  APPS_SCRIPT_URL: process.env.APPS_SCRIPT_URL,
  APPS_SCRIPT_KEY: process.env.APPS_SCRIPT_KEY,
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK
};