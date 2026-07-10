import { BASE, SITE_ID, PROJECT_ID } from "../../core/config.mjs";
import { gameHeaders as headers, fetchJson } from "../../core/api.mjs";
import { login } from "../../core/auth.mjs";
import { sendDiscord } from "../../core/discord.mjs";
import { fetchApprovedUids } from "../../core/sheet.mjs";
import { randomSleep } from "../../core/sleep.mjs";
import { logInfo, logOk, logError } from "../../core/logger.mjs";
import {
  maskUid,
  getTodayDateString,
  runWithConcurrency
} from "../../core/utils.mjs";

const stats = {
  total: 0,
  success: 0,
  failed: 0,
  today: 0,
  makeup: 0,
  alreadyDone: 0,
  failures: []
};

async function getCurrentSignActivity(authedHeaders) {
  const data = await fetchJson(
    `${BASE}/api/v2/store/sale/biz/list?project_id=${PROJECT_ID}&status=2`,
    { headers: authedHeaders }
  );

  const activities = data?.data?.list;

  if (!Array.isArray(activities)) {
    throw new Error(`沒有取得活動列表: ${JSON.stringify(data)}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const sevenDaysSeconds = 7 * 24 * 60 * 60;

  const signActivities = activities
    .filter(item => Number(item.activity_type) === 4)
    .filter(item => Number(item.status) === 2)
    .filter(item => Number(item.activity_switch) === 1)
    .filter(item => {
      const start = Number(item.start_time || 0);
      const stop = Number(item.stop_time || item.cycle_stop_time || 0);

      return start && stop && now >= start && now <= stop;
    })
    .filter(item => {
      const start = Number(item.start_time || 0);
      const stop = Number(item.stop_time || item.cycle_stop_time || 0);

      if (!start || !stop) return false;

      const durationSeconds = stop - start + 1;

      const totalDays = Number(
        item.rule?.sign_in_total_days ??
        item.sign_in_total_days ??
        0
      );

      return (
        durationSeconds === sevenDaysSeconds &&
        totalDays === 7
      );
    })
    .sort(
      (a, b) =>
        Number(b.start_time || 0) -
        Number(a.start_time || 0)
    );

  const activity = signActivities[0];

  if (!activity) {
    throw new Error("沒有找到進行中的 7 天簽到活動");
  }

  logInfo(
    `已選擇簽到活動：${activity.name} / biz_id=${activity.biz_id}`
  );

  return {
    id: activity.biz_id,
    name: activity.name
  };
}

async function getSignInData(authedHeaders, activityId) {
  const data = await fetchJson(
    `${BASE}/api/v2/store/sale/biz/sign-in-list?activity_id=${activityId}&page_size=365&site_id=${SITE_ID}&page_no=1`,
    { headers: authedHeaders }
  );

  if (!data?.data?.sign_in_list) {
    throw new Error(`沒有簽到資料: ${JSON.stringify(data)}`);
  }

  return data.data;
}

function getMakeupItems(signInList) {
  return signInList.filter((item) => item.is_appending && !item.is_sign_in);
}

function getTodayItem(signInList) {
  return signInList.find(
    (item) =>
      item.is_available_sign_in &&
      !item.is_sign_in &&
      !item.is_appending
  );
}

async function receiveMakeupSignIn(authedHeaders, activityId, item) {
  const data = await fetchJson(`${BASE}/api/v2/store/sale/biz/sign-in/gift/receive`, {
    method: "POST",
    headers: authedHeaders,
    body: JSON.stringify({
      activity_id: activityId,
      sign_in_type: 2,
      site_id: SITE_ID,
      day_no: item.day_no,
      appending_date: getTodayDateString()
    })
  });

  if (data.code !== 1) {
    throw new Error(`補簽失敗: ${JSON.stringify(data)}`);
  }

  return data;
}

async function receiveTodaySignIn(authedHeaders, activityId) {
  const data = await fetchJson(`${BASE}/api/v2/store/sale/biz/sign-in/gift/receive`, {
    method: "POST",
    headers: authedHeaders,
    body: JSON.stringify({
      activity_id: activityId,
      sign_in_type: 1,
      site_id: SITE_ID
    })
  });

  if (data.code !== 1) {
    throw new Error(`今天簽到失敗: ${JSON.stringify(data)}`);
  }

  return data;
}

function logSignStatus(signInData) {
  const total = signInData.sign_in_list?.length ?? "?";
  logInfo(`已簽到天數: ${signInData.has_sign_in_days}/${total}`);
  logInfo(`剩餘補簽次數: ${signInData.remain_appending_days}`);
}

async function processSignedInAccount(nickname, authedHeaders, activity) {
  logInfo(`開始處理 ✓ (${nickname})`);

  let signInData = await getSignInData(authedHeaders, activity.id);

  logSignStatus(signInData);

  let makeupCount = 0;
  let todaySigned = false;

  while (true) {
    const makeupItems = getMakeupItems(signInData.sign_in_list);

    logInfo(`目前可補簽 ${makeupItems.length} 天`);

    if (makeupItems.length === 0 || signInData.remain_appending_days <= 0) {
      break;
    }

    const item = makeupItems[0];

    logInfo(`開始補簽：day ${item.day_no}`);

    await receiveMakeupSignIn(authedHeaders, activity.id, item);

    makeupCount++;
    stats.makeup++;

    logOk(`補簽成功 day ${item.day_no}`);

    await randomSleep(1500, 3500);

    signInData = await getSignInData(authedHeaders, activity.id);
  }

  const today = getTodayItem(signInData.sign_in_list);

  if (today) {
    logInfo(`今天可以簽到 day ${today.day_no}`);

    await receiveTodaySignIn(authedHeaders, activity.id);

    todaySigned = true;
    stats.today++;

    logOk("今天簽到成功");

    await randomSleep(1500, 3500);
  } else if (signInData.has_sign_in_days >= signInData.sign_in_list_total) {
    logOk("今天已簽到");
  } else {
    logInfo("沒有今天可簽項目");
  }

  if (makeupCount === 0 && !todaySigned) {
    stats.alreadyDone++;
  }

  stats.success++;

  return {
    nickname,
    makeupCount,
    todaySigned
  };
}

async function processUid(uid, activity) {
  console.log(`\n========== UID: ${maskUid(uid)} ==========`);

  const loginInfo = await login(uid);

  return await processSignedInAccount(
    loginInfo.nickname,
    loginInfo.authedHeaders,
    activity
  );
}

async function main() {
  logInfo("TopHeroesBot signin started");

  let uids;
  try {
    uids = await fetchApprovedUids();
  } catch (err) {
    const msg = `🚨 Top Heroes 簽到中止\n取得 Approved UID 失敗。\n原因: ${err.message}`;
    logError(msg);
    await sendDiscord(msg);
    process.exit(1);
  }

  stats.total = uids.length;

  logInfo(`找到 ${uids.length} 個已 Approved 的帳號`);

  if (uids.length === 0) {
    logInfo("沒有 UID，結束。");
    process.exit(0);
  }

  let activity = null;

  try {
    const firstUid = uids[0];

    console.log(`\n========== 第一個 UID: ${maskUid(firstUid)} ==========`);

    const firstLogin = await login(firstUid);

    logOk(`第一個帳號登錄成功 (${firstLogin.nickname})`);

    activity = await getCurrentSignActivity(firstLogin.authedHeaders);

    logInfo(`目前簽到活動：${activity.name} / biz_id=${activity.id}`);

    const firstResult = await processSignedInAccount(
      firstLogin.nickname,
      firstLogin.authedHeaders,
      activity
    );

    logOk(
      `第一個帳號完成：${firstResult.nickname}，補簽 ${firstResult.makeupCount} 次，今天簽到：${firstResult.todaySigned ? "是" : "否"}`
    );
  } catch (err) {
    stats.failed++;

    const msg =
`🚨 Top Heroes 簽到中止
第一個 UID 失敗，已停止後續帳號。
UID: ${maskUid(uids[0])}
原因: ${err.message}`;

    logError(msg);
    await sendDiscord(msg);

    process.exit(1);
  }

  await randomSleep(5000, 10000);

const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const STAGGER_MS = Number(process.env.STAGGER_MS || 2000);

logInfo(`並發數: ${CONCURRENCY}`);
logInfo(`Worker 錯開啟動: ${STAGGER_MS}ms`);

await runWithConcurrency(
  uids.slice(1),
  CONCURRENCY,
  async (uid, index, workerId) => {
    const realIndex = index + 1;

    try {
      const result = await processUid(uid, activity);

      logOk(
        `完成：${result.nickname}，補簽 ${result.makeupCount} 次，今天簽到：${result.todaySigned ? "是" : "否"}`
      );
    } catch (err) {
      stats.failed++;

      const msg =
`❌ Top Heroes 簽到失敗
進度: ${realIndex + 1}/${uids.length}
Worker: ${workerId}
UID: ${maskUid(uid)}
Activity: ${activity.name} / ${activity.id}
原因: ${err.message}`;

      stats.failures.push(msg);

      logError(msg);
      await sendDiscord(msg);
    }
  },
  STAGGER_MS
);

  const summary =
`✅ Top Heroes 簽到完成
活動: ${activity.name}
Activity ID: ${activity.id}
總數: ${stats.total}
成功: ${stats.success}
失敗: ${stats.failed}
今日簽到: ${stats.today}
補簽次數: ${stats.makeup}
已完成/無需操作: ${stats.alreadyDone}`;

  console.log("\n" + summary);
  await sendDiscord(summary);

  logOk("全部完成！");
}

main().catch(async (err) => {
  const msg = `🚨 Top Heroes 簽到程式異常\n原因: ${err.message}`;
  logError(msg);
  await sendDiscord(msg);
  process.exit(1);
});
