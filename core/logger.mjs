function nowText() {
  return new Date().toLocaleString("zh-CN", {
    timeZone: "America/Montreal",
    hour12: false
  });
}

export function logInfo(message) {
  console.log(`[${nowText()}] ℹ️ ${message}`);
}

export function logOk(message) {
  console.log(`[${nowText()}] ✅ ${message}`);
}

export function logWarn(message) {
  console.warn(`[${nowText()}] ⚠️ ${message}`);
}

export function logError(message) {
  console.error(`[${nowText()}] ❌ ${message}`);
}