import fs from "node:fs";
import path from "node:path";

import {
  BASE,
  SITE_ID,
  PROJECT_ID,
  DEBUG_UID,
} from "../core/config.mjs";

import { fetchJson } from "../core/api.mjs";
import { login } from "../core/auth.mjs";
import { sleep } from "../core/sleep.mjs";
import { logInfo, logOk, logError } from "../core/logger.mjs";
import { maskUid } from "../core/utils.mjs";

async function getActivities(authedHeaders) {
  const data = await fetchJson(
    `${BASE}/api/v2/store/sale/biz/list?project_id=${PROJECT_ID}&status=2`,
    { headers: authedHeaders }
  );

  const list = data?.data?.list;
  if (!Array.isArray(list)) {
    throw new Error(`沒有取得活動列表: ${JSON.stringify(data).slice(0, 500)}`);
  }

  return list;
}

async function probeSignInActivity(authedHeaders, activity) {
  const url =
    `${BASE}/api/v2/store/sale/biz/sign-in-list` +
    `?activity_id=${activity.biz_id}` +
    `&page_size=365` +
    `&site_id=${SITE_ID}` +
    `&page_no=1`;

  try {
    const data = await fetchJson(url, { headers: authedHeaders });

    const signInList = data?.data?.sign_in_list;

    return {
      ok: Boolean(signInList),
      code: data?.code,
      message: data?.message,
      days: Array.isArray(signInList) ? signInList.length : 0,
      has_sign_in_days: data?.data?.has_sign_in_days,
      remain_appending_days: data?.data?.remain_appending_days,
      available_days: Array.isArray(signInList)
        ? signInList
            .filter(x => x.is_available_sign_in && !x.is_sign_in)
            .map(x => x.day_no)
        : [],
      signed_days: Array.isArray(signInList)
        ? signInList.filter(x => x.is_sign_in).map(x => x.day_no)
        : []
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message
    };
  }
}

function compactActivity(item, probe) {
  return {
    biz_id: item.biz_id,
    name: item.name,
    activity_type: item.activity_type,
    status: item.status,
    activity_switch: item.activity_switch,
    start_time: item.start_time,
    end_time: item.end_time,
    sort: item.sort,
    display_order: item.display_order,
    site_id: item.site_id,
    project_id: item.project_id,
    probe
  };
}

function scoreCandidate(x) {
  const now = Date.now();

  const start = x.start_time ? new Date(x.start_time).getTime() : 0;
  const end = x.end_time ? new Date(x.end_time).getTime() : 0;

  const inTimeRange =
    (!start || now >= start) &&
    (!end || now <= end);

  const ok = x.probe?.ok ? 1 : 0;
  const has = Number(x.probe?.has_sign_in_days || 0);
  const available = x.probe?.available_days?.length || 0;

  return (
    ok * 100000 +
    (inTimeRange ? 10000 : 0) +
    (available > 0 ? 1000 : 0) +
    (has > 0 ? 500 : 0) +
    Number(x.biz_id || 0)
  );
}

async function main() {
  logInfo("Debug activities started");

  if (!DEBUG_UID) {
    throw new Error("請先在 core/config.mjs 裡設定 DEBUG_UID");
  }

  logInfo(`使用 UID: ${maskUid(DEBUG_UID)}`);

  const loginInfo = await login(DEBUG_UID, { maxRetries: 1 });
  logOk(`登入成功: ${loginInfo.nickname}`);

  const activities = await getActivities(loginInfo.authedHeaders);

  const candidates = activities
    .filter(x => Number(x.activity_type) === 4)
    .sort((a, b) => Number(b.biz_id) - Number(a.biz_id));

  logInfo(`活動總數: ${activities.length}`);
  logInfo(`簽到候選 activity_type=4: ${candidates.length}`);

  const probed = [];

  for (const item of candidates) {
    logInfo(`Probe ${item.biz_id} ${item.name}`);
    const probe = await probeSignInActivity(loginInfo.authedHeaders, item);
    probed.push(compactActivity(item, probe));
    await sleep(500);
  }

const ranked = [...probed].sort((a, b) => scoreCandidate(b) - scoreCandidate(a));

console.log("\n=== Ranked sign-in candidates ===");
console.table(
  ranked.map(x => ({
    score: scoreCandidate(x),
    biz_id: x.biz_id,
    name: x.name,
    ok: x.probe?.ok,
    days: x.probe?.days ?? "",
    has: x.probe?.has_sign_in_days ?? "",
    available: x.probe?.available_days?.join(",") ?? "",
    status: x.status ?? "",
    switch: x.activity_switch ?? "",
    start_time: x.start_time ?? "",
    end_time: x.end_time ?? "",
    sort: x.sort ?? "",
    display_order: x.display_order ?? "",
    message: x.probe?.message || x.probe?.error || ""
  }))
);

const selected = ranked[0];

console.log("\n=== Selected candidate ===");
console.log({
  biz_id: selected.biz_id,
  name: selected.name,
  score: scoreCandidate(selected)
});

  fs.mkdirSync("runtime", { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fullPath = path.join("runtime", `activities-full-${stamp}.json`);
  const probedPath = path.join("runtime", `activities-probed-${stamp}.json`);

  fs.writeFileSync(fullPath, JSON.stringify(activities, null, 2));
  fs.writeFileSync(probedPath, JSON.stringify(probed, null, 2));

  logOk(`完整活動 JSON 已輸出: ${fullPath}`);
  logOk(`Probe 結果已輸出: ${probedPath}`);
}

main().catch(err => {
  logError(`Debug activities failed: ${err.message}`);
  process.exit(1);
});