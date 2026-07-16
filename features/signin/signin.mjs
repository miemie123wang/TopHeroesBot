import { BASE, SITE_ID, PROJECT_ID } from "../../core/config.mjs";
import { fetchJson } from "../../core/api.mjs";
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
  partial: 0,
  failed: 0,
  failures: [],
  rejectedActivities: [],
  byActivity: new Map()
};

function getActivityStats(activity) {
  if (!stats.byActivity.has(activity.id)) {
    stats.byActivity.set(activity.id, {
      activity,
      success: 0,
      failed: 0,
      today: 0,
      makeup: 0,
      alreadyDone: 0,
      failures: []
    });
  }

  return stats.byActivity.get(activity.id);
}

async function getCurrentSignActivities(authedHeaders) {
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

      return durationSeconds === sevenDaysSeconds && totalDays === 7;
    })
    .sort((a, b) => Number(a.start_time || 0) - Number(b.start_time || 0))
    .map(item => ({
      id: item.biz_id,
      name: item.name,
      startTime: Number(item.start_time || 0)
    }));

  if (signActivities.length === 0) {
    throw new Error("沒有找到進行中的 7 天簽到活動");
  }

  logInfo(`找到 ${signActivities.length} 個進行中的 7 天簽到活動`);
  for (const activity of signActivities) {
    logInfo(`候選活動：${activity.name} / biz_id=${activity.id}`);
  }

  return signActivities;
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
  return signInList.filter(item => item.is_appending && !item.is_sign_in);
}

function getTodayItem(signInList) {
  return signInList.find(
    item => item.is_available_sign_in && !item.is_sign_in && !item.is_appending
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

async function processSingleActivity(nickname, authedHeaders, activity) {
  logInfo(`開始處理活動：${activity.name} / ${activity.id} (${nickname})`);

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
    logOk(`補簽成功 day ${item.day_no}`);

    await randomSleep(1500, 3500);
    signInData = await getSignInData(authedHeaders, activity.id);
  }

  const today = getTodayItem(signInData.sign_in_list);

  if (today) {
    logInfo(`今天可以簽到 day ${today.day_no}`);
    await receiveTodaySignIn(authedHeaders, activity.id);
    todaySigned = true;
    logOk("今天簽到成功");
    await randomSleep(1500, 3500);
  } else if (signInData.has_sign_in_days >= signInData.sign_in_list_total) {
    logOk("今天已簽到");
  } else {
    logInfo("沒有今天可簽項目");
  }

  return {
    activity,
    nickname,
    makeupCount,
    todaySigned,
    alreadyDone: makeupCount === 0 && !todaySigned
  };
}

function recordActivitySuccess(result) {
  const activityStats = getActivityStats(result.activity);
  activityStats.success++;
  activityStats.makeup += result.makeupCount;
  if (result.todaySigned) activityStats.today++;
  if (result.alreadyDone) activityStats.alreadyDone++;
}

function recordActivityFailure(activity, uid, error) {
  const activityStats = getActivityStats(activity);
  activityStats.failed++;
  activityStats.failures.push({ uid: maskUid(uid), error: error.message });
}

async function processActivitiesForAccount(uid, nickname, authedHeaders, activities) {
  const results = [];
  const failures = [];

  for (const activity of activities) {
    try {
      const result = await processSingleActivity(
        nickname,
        authedHeaders,
        activity
      );
      recordActivitySuccess(result);
      results.push(result);
    } catch (error) {
      recordActivityFailure(activity, uid, error);
      failures.push({ activity, error });
      logError(
        `活動處理失敗：${activity.name} / ${activity.id} (${nickname})\n原因: ${error.message}`
      );
    }
  }

  return { nickname, results, failures };
}

function recordAccountResult(accountResult) {
  if (accountResult.failures.length === 0) {
    stats.success++;
  } else if (accountResult.results.length > 0) {
    stats.partial++;
  } else {
    stats.failed++;
  }
}

async function processUid(uid, activities) {
  console.log(`\n========== UID: ${maskUid(uid)} ==========`);
  const loginInfo = await login(uid);
  return processActivitiesForAccount(
    uid,
    loginInfo.nickname,
    loginInfo.authedHeaders,
    activities
  );
}

function buildActivitySummary() {
  return [...stats.byActivity.values()]
    .map(item =>
`${item.activity.name} (${item.activity.id})
  成功: ${item.success}
  失敗: ${item.failed}
  今日簽到: ${item.today}
  補簽次數: ${item.makeup}
  已完成/無需操作: ${item.alreadyDone}`
    )
    .join("\n\n");
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

  let activities = [];

  try {
    const firstUid = uids[0];
    console.log(`\n========== 第一個 UID: ${maskUid(firstUid)} ==========`);

    const firstLogin = await login(firstUid);
    logOk(`第一個帳號登錄成功 (${firstLogin.nickname})`);

    const candidates = await getCurrentSignActivities(firstLogin.authedHeaders);

    for (const activity of candidates) {
      try {
        const result = await processSingleActivity(
          firstLogin.nickname,
          firstLogin.authedHeaders,
          activity
        );

        recordActivitySuccess(result);
        activities.push(activity);
        logOk(`活動驗證成功：${activity.name} / ${activity.id}`);
      } catch (error) {
        stats.rejectedActivities.push({ activity, error: error.message });
        logError(
          `活動驗證失敗，後續帳號將跳過：${activity.name} / ${activity.id}\n原因: ${error.message}`
        );
      }
    }

    if (activities.length === 0) {
      throw new Error("所有候選簽到活動驗證失敗");
    }

    stats.success++;
    logOk(`第一個帳號完成，共處理 ${activities.length} 個有效活動`);
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

  logInfo(`本次確認有效的簽到活動: ${activities.length}`);
  for (const activity of activities) {
    logInfo(`✓ ${activity.name} / biz_id=${activity.id}`);
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
        const result = await processUid(uid, activities);
        recordAccountResult(result);

        const completed = result.results.length;
        const failed = result.failures.length;

        if (failed === 0) {
          logOk(`完成：${result.nickname}，活動 ${completed}/${activities.length}`);
        } else {
          const msg =
`⚠️ Top Heroes 簽到部分失敗
進度: ${realIndex + 1}/${uids.length}
Worker: ${workerId}
UID: ${maskUid(uid)}
暱稱: ${result.nickname}
成功活動: ${completed}
失敗活動: ${failed}
${result.failures.map(x => `- ${x.activity.name} (${x.activity.id}): ${x.error.message}`).join("\n")}`;

          stats.failures.push(msg);
          logError(msg);
          await sendDiscord(msg);
        }
      } catch (err) {
        stats.failed++;

        const msg =
`❌ Top Heroes 簽到失敗
進度: ${realIndex + 1}/${uids.length}
Worker: ${workerId}
UID: ${maskUid(uid)}
原因: ${err.message}`;

        stats.failures.push(msg);
        logError(msg);
        await sendDiscord(msg);
      }
    },
    STAGGER_MS
  );

  const rejectedSummary = stats.rejectedActivities.length > 0
    ? `\n\n已排除活動:\n${stats.rejectedActivities
        .map(x => `- ${x.activity.name} (${x.activity.id}): ${x.error}`)
        .join("\n")}`
    : "";

  const summary =
`✅ Top Heroes 簽到完成
有效活動數: ${activities.length}
帳號總數: ${stats.total}
全部成功: ${stats.success}
部分成功: ${stats.partial}
完全失敗: ${stats.failed}

${buildActivitySummary()}${rejectedSummary}`;

  console.log("\n" + summary);
  await sendDiscord(summary);

  logOk("全部完成！");
}

main().catch(async err => {
  const msg = `🚨 Top Heroes 簽到程式異常\n原因: ${err.message}`;
  logError(msg);
  await sendDiscord(msg);
  process.exit(1);
});
