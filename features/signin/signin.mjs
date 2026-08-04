import {
  OLD_BASE,
  NEW_BASE,
  SITE_ID,
  PROJECT_ID
} from "../../core/config.mjs";
import { fetchJson } from "../../core/api.mjs";
import { login, loginAtBase } from "../../core/auth.mjs";
import { sendDiscord } from "../../core/discord.mjs";
import { fetchApprovedUids } from "../../core/sheet.mjs";
import { randomSleep, sleep } from "../../core/sleep.mjs";
import { logInfo, logOk, logWarn, logError } from "../../core/logger.mjs";
import {
  maskUid,
  getTodayDateString,
  runWithConcurrency
} from "../../core/utils.mjs";

const STORE_BASE = "https://store.topheroes.com";

const SIGNIN_CHAIN_IDS = String(
  process.env.SIGNIN_CHAIN_IDS || "1"
)
  .split(/[\s,;]+/)
  .map(value => Number(value.trim()))
  .filter(value => Number.isInteger(value) && value > 0);

const SIGNIN_BASES = [
  { name: "store.topheroes.com", url: STORE_BASE },
  { name: "topheroes.store.kopglobal.com", url: OLD_BASE },
  { name: "topheroes.pay-store.rivergame.net", url: NEW_BASE }
].filter(
  (item, index, list) =>
    item.url && list.findIndex(other => other.url === item.url) === index
);

const STORE_LOGIN_MIN_INTERVAL_MS = Math.max(
  0,
  Number(process.env.STORE_LOGIN_MIN_INTERVAL_MS || 3000)
);

let storeLoginQueue = Promise.resolve();
let lastStoreLoginStartedAt = 0;

function queueStoreLogin(task) {
  const run = storeLoginQueue.then(async () => {
    const wait = Math.max(
      0,
      lastStoreLoginStartedAt + STORE_LOGIN_MIN_INTERVAL_MS - Date.now()
    );

    if (wait > 0) {
      await sleep(wait);
    }

    lastStoreLoginStartedAt = Date.now();
    return task();
  });

  // 前一次登录失败也不能阻塞后面的账号。
  storeLoginQueue = run.then(
    () => undefined,
    () => undefined
  );

  return run;
}

async function loginForSignin(uid, options = {}) {
  const {
    maxRetries = 6,
    device = "pc",
    preDelayMin = 1000,
    preDelayMax = 3000,
    retryDelayMin = 15000,
    retryDelayMax = 35000
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await randomSleep(preDelayMin, preDelayMax);

      logInfo(`[LOGIN START] ${maskUid(uid)} ${new Date().toISOString()}`);

      // 新签到活动的领取接口要求使用 store.topheroes.com
      // 自己签发的 Authorization。pay-store 的 token 虽可读取列表，
      // 但提交新活动时会返回 Activity not found / Parameter exception。
      const result = await queueStoreLogin(() =>
        loginAtBase(uid, STORE_BASE, device)
      );

      logInfo(
        `[LOGIN OK] ${maskUid(uid)} ${new Date().toISOString()} ` +
        `(store mall)`
      );

      return result;
    } catch (error) {
      lastError = error;

      if (attempt < maxRetries) {
        const wait =
          retryDelayMin +
          Math.floor(Math.random() * (retryDelayMax - retryDelayMin));

        logWarn(
          `[store login ${attempt}/${maxRetries}] ${maskUid(uid)} ` +
          `失败：${error.message}`
        );
        logWarn(`等待 ${Math.round(wait / 1000)} 秒后重试...`);
        await sleep(wait);
      }
    }
  }

  // 保留旧账号/临时异常的回退路径，但会明确记录。
  logWarn(
    `${maskUid(uid)} 无法在 store.topheroes.com 登录，` +
    `回退现有新/旧商城登录。原因: ${lastError?.message || "unknown"}`
  );

  return login(uid, options);
}

function normalizeHeaderObject(headers) {
  if (!headers) return {};

  if (typeof headers.entries === "function") {
    return Object.fromEntries(
      [...headers.entries()].map(([name, value]) => [
        String(name).toLowerCase(),
        value
      ])
    );
  }

  const normalized = {};

  for (const [name, value] of Object.entries(headers)) {
    normalized[String(name).toLowerCase()] = value;
  }

  return normalized;
}

function getHeaderValue(headers, name) {
  const normalized = normalizeHeaderObject(headers);
  return normalized[String(name).toLowerCase()] || "";
}

function buildSigninHeaders(authedHeaders, baseUrl) {
  // 先统一 Header 名称，避免 Content-Type / content-type 被 Node 合并。
  const normalizedHeaders = normalizeHeaderObject(authedHeaders);
  const authorization = getHeaderValue(normalizedHeaders, "authorization");

  return {
    ...normalizedHeaders,
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    "cache-control": "no-cache",
    pragma: "no-cache",
    origin: baseUrl,
    referer: `${baseUrl}/en`,
    ...(authorization
      ? {
          authorization,
          cookie: [
            "lang=en",
            `site-token=${encodeURIComponent(authorization)}`
          ].join("; ")
        }
      : {})
  };
}

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

function getManualActivityIds() {
  const raw = String(process.env.SIGNIN_ACTIVITY_ID || "").trim();

  if (!raw) {
    return [];
  }

  const ids = raw
    .split(/[\s,;]+/)
    .map(value => Number(value.trim()))
    .filter(value => Number.isInteger(value) && value > 0);

  const uniqueIds = [...new Set(ids)];

  if (uniqueIds.length === 0) {
    throw new Error(
      `SIGNIN_ACTIVITY_ID 无效: ${raw}. 请填写正整数活动 ID。`
    );
  }

  return uniqueIds;
}

function extractBuilderCandidateIds(payload) {
  const text = JSON.stringify(payload);
  const pattern =
    /(?:activity_id|activityId|biz_id|bizId)[^0-9]{0,40}(\d{4,})/g;
  const ids = [];
  const seen = new Set();

  for (const match of text.matchAll(pattern)) {
    const id = Number(match[1]);

    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) {
      continue;
    }

    seen.add(id);
    ids.push(id);
  }

  return ids;
}

function getActivityQuery(activity) {
  if (
    activity?.protocol === "chain" &&
    Number.isInteger(Number(activity?.chainId))
  ) {
    return `chain_id=${Number(activity.chainId)}`;
  }

  return `activity_id=${Number(activity.id)}`;
}

function getReceiveIdentity(activity) {
  // sign-in-list 可以用 chain_id 查询新活动，
  // 但网页真实的 gift/receive 请求始终提交 activity_id。
  return {
    activity_id: Number(activity.id)
  };
}

function getProtocolLabel(activity) {
  if (activity?.protocol === "chain") {
    return (
      `query:chain_id=${activity.chainId} / ` +
      `receive:activity_id=${activity.id}`
    );
  }

  return `activity_id=${activity.id}`;
}

function extractActivityList(response) {
  const candidates = [
    response?.data?.list,
    response?.data?.data,
    response?.list
  ];

  return candidates.find(Array.isArray) || [];
}

function mergeCandidates(...groups) {
  const map = new Map();

  for (const group of groups) {
    for (const candidate of group || []) {
      const id = Number(candidate?.id);

      if (!Number.isInteger(id) || id <= 0) {
        continue;
      }

      const previous = map.get(id);

      map.set(id, {
        id,
        name:
          candidate.name ||
          previous?.name ||
          `签到活动 ${id}`,
        source: [previous?.source, candidate.source]
          .filter(Boolean)
          .filter((value, index, list) => list.indexOf(value) === index)
          .join("+") || "unknown"
      });
    }
  }

  return [...map.values()];
}

async function discoverFromBuilderInfo(authedHeaders) {
  const url =
    `${STORE_BASE}/api/v2/store/site/builder/info` +
    `?site_builder_id=${SITE_ID}`;

  logInfo(`读取站点活动配置: ${url}`);

  const response = await fetchJson(
    url,
    { headers: buildSigninHeaders(authedHeaders, STORE_BASE) },
    1
  );

  const ids = extractBuilderCandidateIds(response);

  logInfo(`builder/info 提取到 ${ids.length} 个候选活动 ID`);

  return ids.map(id => ({
    id,
    name: `签到活动 ${id}`,
    source: "builder-info"
  }));
}

async function discoverFromKopActivityList(authedHeaders) {
  const url =
    `${OLD_BASE}/api/v2/store/sale/biz/list` +
    `?project_id=${PROJECT_ID}` +
    `&activity_type=4`;

  try {
    const response = await fetchJson(
      url,
      { headers: buildSigninHeaders(authedHeaders, OLD_BASE) },
      1
    );

    const activities = extractActivityList(response)
      .filter(item => Number(item?.activity_type) === 4)
      .map(item => ({
        id: Number(item?.biz_id ?? item?.activity_id ?? item?.id),
        name: item?.name || item?.activity_name || "",
        source: "kop-biz-list"
      }))
      .filter(item => Number.isInteger(item.id) && item.id > 0);

    logInfo(`KOP 活动列表读取到 ${activities.length} 个签到候选，仅用于补充名称`);

    return activities;
  } catch (error) {
    logWarn(`KOP 活动列表读取失败，继续使用 builder/info。原因: ${error.message}`);
    return [];
  }
}

async function discoverChainActivities(authedHeaders) {
  const discovered = [];
  const seenActivityIds = new Set();

  for (const chainId of SIGNIN_CHAIN_IDS) {
    let matched = null;

    for (const base of SIGNIN_BASES) {
      const url =
        `${base.url}/api/v2/store/sale/biz/sign-in-list` +
        `?page_size=365` +
        `&site_id=${SITE_ID}` +
        `&page_no=1` +
        `&chain_id=${chainId}` +
        `&_=${Date.now()}`;

      try {
        const response = await fetchJson(
          url,
          {
            headers: {
              ...buildSigninHeaders(authedHeaders, base.url),
              "cache-control": "no-cache, no-store, max-age=0"
            }
          },
          0
        );

        const signInData = response?.data;
        const signInList = signInData?.sign_in_list;
        const activityId = Number(signInData?.activity_id || 0);
        const allExpired =
          Array.isArray(signInList) &&
          signInList.length > 0 &&
          signInList.every(item => item?.is_expired === true);

        if (
          Number(response?.code) === 1 &&
          Number.isInteger(activityId) &&
          activityId > 0 &&
          Array.isArray(signInList) &&
          signInList.length > 0 &&
          !allExpired
        ) {
          matched = {
            id: activityId,
            name: `签到活动 ${activityId}`,
            source: "chain-id",
            protocol: "chain",
            chainId,
            baseName: base.name,
            baseUrl: base.url,
            days: signInList.length,
            initialSignInData: signInData
          };

          break;
        }
      } catch {
        // 当前域名不支持该 chain_id，继续尝试其他域名。
      }

      await sleep(100);
    }

    if (matched && !seenActivityIds.has(matched.id)) {
      seenActivityIds.add(matched.id);
      discovered.push(matched);

      logOk(
        `发现链式签到活动: ${matched.id} / ` +
        `chain_id=${matched.chainId} / ${matched.baseName}`
      );
    }
  }

  if (discovered.length === 0) {
    logInfo(
      `未发现链式签到活动；已检查 chain_id: ` +
      `${SIGNIN_CHAIN_IDS.join(", ")}`
    );
  }

  return discovered;
}

function validateSignInResponse(response, requestedId) {
  const signInData = response?.data;
  const signInList = signInData?.sign_in_list;
  const returnedId = Number(signInData?.activity_id || 0);

  if (Number(response?.code) !== 1) {
    return {
      ok: false,
      reason: response?.message || `code=${response?.code}`
    };
  }

  if (returnedId !== Number(requestedId)) {
    return {
      ok: false,
      reason: `返回活动 ID 不匹配: requested=${requestedId}, returned=${returnedId}`
    };
  }

  if (!Array.isArray(signInList) || signInList.length === 0) {
    return {
      ok: false,
      reason: "没有 sign_in_list"
    };
  }

  const allExpired = signInList.every(item => item?.is_expired === true);

  if (allExpired) {
    return {
      ok: false,
      reason: "签到活动所有天数均已过期"
    };
  }

  return {
    ok: true,
    signInData,
    days: signInList.length
  };
}

async function probeCandidateAtBase(authedHeaders, candidate, base) {
  const url =
    `${base.url}/api/v2/store/sale/biz/sign-in-list` +
    `?page_size=365` +
    `&site_id=${SITE_ID}` +
    `&page_no=1` +
    `&${getActivityQuery(candidate)}` +
    `&_=${Date.now()}`;

  try {
    const response = await fetchJson(
      url,
      { headers: buildSigninHeaders(authedHeaders, base.url) },
      0
    );

    const validation = validateSignInResponse(response, candidate.id);

    return {
      ...validation,
      baseName: base.name,
      baseUrl: base.url,
      url,
      response
    };
  } catch (error) {
    return {
      ok: false,
      baseName: base.name,
      baseUrl: base.url,
      url,
      reason: error.message
    };
  }
}

async function verifyCandidate(authedHeaders, candidate) {
  const attempts = [];

  const bases = candidate.baseUrl
    ? [
        ...SIGNIN_BASES.filter(base => base.url === candidate.baseUrl),
        ...SIGNIN_BASES.filter(base => base.url !== candidate.baseUrl)
      ]
    : SIGNIN_BASES;

  for (const base of bases) {
    const result = await probeCandidateAtBase(
      authedHeaders,
      candidate,
      base
    );

    attempts.push(result);

    if (result.ok) {
      return {
        ...candidate,
        name:
          candidate.name && !candidate.name.startsWith("签到活动 ")
            ? candidate.name
            : `签到活动 ${candidate.id}`,
        baseName: result.baseName,
        baseUrl: result.baseUrl,
        days: result.days,
        initialSignInData: result.signInData,
        attempts
      };
    }

    await sleep(150);
  }

  const reason = attempts
    .map(item => `${item.baseName}: ${item.reason || "验证失败"}`)
    .join(" | ");

  return {
    ...candidate,
    verified: false,
    reason,
    attempts
  };
}

async function getCurrentSignActivities(authedHeaders) {
  const manualIds = getManualActivityIds();
  let candidates;

  const chainActivities = await discoverChainActivities(authedHeaders);
  const chainByActivityId = new Map(
    chainActivities.map(activity => [activity.id, activity])
  );

  if (manualIds.length > 0) {
    logWarn(
      `使用手动活动 ID: ${manualIds.join(", ")}`
    );

    candidates = manualIds.map(id => {
      const chain = chainByActivityId.get(id);

      if (chain) {
        return {
          ...chain,
          name:
            manualIds.length === 1 && process.env.SIGNIN_ACTIVITY_NAME
              ? process.env.SIGNIN_ACTIVITY_NAME
              : `手动签到活动 ${id}`,
          source: "manual+chain-id"
        };
      }

      return {
        id,
        name:
          manualIds.length === 1 && process.env.SIGNIN_ACTIVITY_NAME
            ? process.env.SIGNIN_ACTIVITY_NAME
            : `手动签到活动 ${id}`,
        source: "manual",
        protocol: "activity"
      };
    });
  } else {
    const builderCandidates = await discoverFromBuilderInfo(authedHeaders);
    const kopCandidates = await discoverFromKopActivityList(authedHeaders);
    const kopById = new Map(
      kopCandidates.map(candidate => [candidate.id, candidate])
    );

    // builder/info 是商城当前页面真实使用的活动配置。
    // KOP biz/list 仅补充名称，不能把独有测试/历史活动加入执行列表。
    candidates = builderCandidates.map(candidate => {
      const kop = kopById.get(candidate.id);
      const chain = chainByActivityId.get(candidate.id);

      return {
        ...candidate,
        ...(chain || {}),
        id: candidate.id,
        name: kop?.name || chain?.name || candidate.name,
        source: [
          "builder-info",
          kop ? "kop-biz-list" : "",
          chain ? "chain-id" : ""
        ]
          .filter(Boolean)
          .join("+"),
        protocol: chain ? "chain" : "activity"
      };
    });

    // chain_id 是网页当前真实使用的新签到协议。
    // 即使 builder/info 在活动切换瞬间仍命中旧缓存，也要加入 chain 返回的新活动。
    for (const chain of chainActivities) {
      if (!candidates.some(candidate => candidate.id === chain.id)) {
        candidates.push({
          ...chain,
          source: "chain-id"
        });
      }
    }

    logInfo(
      `最终候选 ${candidates.length} 个：` +
      `builder/info 当前页面活动 + chain_id 当前签到；` +
      `KOP 列表仅补充名称`
    );
  }

  if (candidates.length === 0) {
    throw new Error("没有发现任何签到候选活动");
  }

  const validActivities = [];

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];

    logInfo(
      `验证候选 ${index + 1}/${candidates.length}: ` +
      `${candidate.id} / source=${candidate.source}`
    );

    const result = await verifyCandidate(authedHeaders, candidate);

    if (result.baseUrl) {
      validActivities.push(result);
      logOk(
        `确认签到活动: ${result.id} / ${result.days} 天 / ` +
        `${result.baseName}`
      );
    } else {
      stats.rejectedActivities.push({
        activity: candidate,
        error: result.reason
      });
      logInfo(`排除非签到活动 ${candidate.id}: ${result.reason}`);
    }

    await sleep(200);
  }

  if (validActivities.length === 0) {
    const mode = manualIds.length > 0 ? "手动活动" : "自动发现";
    throw new Error(`${mode}没有验证到可用的签到活动`);
  }

  logOk(
    `最终确认 ${validActivities.length} 个签到活动: ` +
    validActivities.map(item => item.id).join(", ")
  );

  return validActivities;
}

async function getSignInData(authedHeaders, activity) {
  const data = await fetchJson(
    `${activity.baseUrl}/api/v2/store/sale/biz/sign-in-list` +
    `?page_size=365` +
    `&site_id=${SITE_ID}` +
    `&page_no=1` +
    `&${getActivityQuery(activity)}` +
    `&_=${Date.now()}`,
    {
      headers: {
        ...buildSigninHeaders(authedHeaders, activity.baseUrl),
        "cache-control": "no-cache, no-store, max-age=0"
      }
    }
  );

  const validation = validateSignInResponse(data, activity.id);

  if (!validation.ok) {
    throw new Error(
      `没有可用签到资料: ${getProtocolLabel(activity)}; ${validation.reason}`
    );
  }

  return validation.signInData;
}

function getMakeupItems(signInList) {
  return signInList.filter(item => item.is_appending && !item.is_sign_in);
}

function getTodayItem(signInList) {
  return signInList.find(
    item => item.is_available_sign_in && !item.is_sign_in && !item.is_appending
  );
}

async function receiveMakeupSignIn(authedHeaders, activity, item) {
  const data = await fetchJson(
    `${activity.baseUrl}/api/v2/store/sale/biz/sign-in/gift/receive`,
    {
      method: "POST",
      headers: buildSigninHeaders(authedHeaders, activity.baseUrl),
      body: JSON.stringify({
        ...getReceiveIdentity(activity),
        sign_in_type: 2,
        site_id: SITE_ID,
        day_no: item.day_no,
        appending_date: getTodayDateString()
      })
    }
  );

  if (Number(data?.code) !== 1) {
    throw new Error(`补签失败: ${JSON.stringify(data)}`);
  }

  return data;
}

async function receiveTodaySignIn(authedHeaders, activity) {
  const data = await fetchJson(
    `${activity.baseUrl}/api/v2/store/sale/biz/sign-in/gift/receive`,
    {
      method: "POST",
      headers: buildSigninHeaders(authedHeaders, activity.baseUrl),
      body: JSON.stringify({
        ...getReceiveIdentity(activity),
        sign_in_type: 1,
        site_id: SITE_ID
      })
    }
  );

  if (Number(data?.code) !== 1) {
    throw new Error(`今天签到失败: ${JSON.stringify(data)}`);
  }

  return data;
}

function logSignStatus(signInData) {
  const total = signInData.sign_in_list?.length ?? "?";
  logInfo(`已签到天数: ${signInData.has_sign_in_days}/${total}`);
  logInfo(`剩余补签次数: ${signInData.remain_appending_days}`);
}

async function processSingleActivity(
  nickname,
  authedHeaders,
  activity,
  initialSignInData = null
) {
  logInfo(
    `开始处理活动: ${activity.name} / ${activity.id} / ` +
    `${getProtocolLabel(activity)} / ${activity.baseName} (${nickname})`
  );

  let signInData =
    initialSignInData || await getSignInData(authedHeaders, activity);

  logSignStatus(signInData);

  let makeupCount = 0;
  let todaySigned = false;

  while (true) {
    const makeupItems = getMakeupItems(signInData.sign_in_list);
    const remainAppendingDays = Number(
      signInData.remain_appending_days || 0
    );

    logInfo(`目前可补签 ${makeupItems.length} 天`);

    if (makeupItems.length === 0 || remainAppendingDays <= 0) {
      break;
    }

    const item = makeupItems[0];

    // 新活动的 sign-in-list 可以使用 chain_id 查询，
    // 但补签的网页真实 Payload 仍未抓到。
    // 为避免猜测 day_no/appending_date 规则而阻断今天签到，
    // chain 活动暂时跳过补签。
    if (activity.protocol === "chain") {
      logWarn(
        `链式签到 ${getProtocolLabel(activity)} 暂不执行补签 day ${item.day_no}，` +
        `继续处理今天签到`
      );
      break;
    }

    logInfo(`开始补签: day ${item.day_no}`);

    try {
      await receiveMakeupSignIn(authedHeaders, activity, item);
      makeupCount++;
      logOk(`补签成功 day ${item.day_no}`);
    } catch (error) {
      const text = String(error?.message || error).toLowerCase();
      const permissionDenied =
        text.includes("permission denied") ||
        text.includes('"code":10006');

      // 补签是附加动作。接口可能显示可补签，但账号实际上没有权限。
      // 这种情况不能让整个账号、更不能让全部账号中止。
      if (permissionDenied) {
        logWarn(
          `补签 day ${item.day_no} 被拒绝，跳过补签并继续今天签到。` +
          `原因: ${error.message}`
        );
        break;
      }

      throw error;
    }

    await randomSleep(1500, 3500);
    signInData = await getSignInData(authedHeaders, activity);
  }

  const today = getTodayItem(signInData.sign_in_list);

  if (today) {
    logInfo(`今天可以签到 day ${today.day_no}`);
    await receiveTodaySignIn(authedHeaders, activity);
    todaySigned = true;
    logOk("今天签到成功");
    await randomSleep(1500, 3500);
  } else if (
    Number(signInData.has_sign_in_days || 0) >=
    Number(signInData.sign_in_list_total || signInData.sign_in_list.length)
  ) {
    logOk("今天已签到");
  } else {
    logInfo("没有今天可签到的项目");
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

async function processActivitiesForAccount(
  uid,
  nickname,
  authedHeaders,
  activities
) {
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
        `活动处理失败: ${activity.name} / ${activity.id} (${nickname})\n` +
        `原因: ${error.message}`
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
  const loginInfo = await loginForSignin(uid);

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
  接口: ${item.activity.baseName}
  协议: ${getProtocolLabel(item.activity)}
  成功: ${item.success}
  失败: ${item.failed}
  今日签到: ${item.today}
  补签次数: ${item.makeup}
  已完成/无需操作: ${item.alreadyDone}`
    )
    .join("\n\n");
}

async function main() {
  logInfo("TopHeroesBot signin started");

  let uids;
  try {
    uids = await fetchApprovedUids();
  } catch (error) {
    const message =
      `🚨 Top Heroes 签到中止\n` +
      `取得 Approved UID 失败。\n` +
      `原因: ${error.message}`;

    logError(message);
    await sendDiscord(message);
    process.exit(1);
  }

  stats.total = uids.length;
  logInfo(`找到 ${uids.length} 个已 Approved 的账号`);

  if (uids.length === 0) {
    logInfo("没有 UID，结束。");
    return;
  }

  let activities = [];

  try {
    const firstUid = uids[0];
    console.log(`\n========== 第一个 UID: ${maskUid(firstUid)} ==========`);

    const firstLogin = await loginForSignin(firstUid);
    logOk(`第一个账号登录成功 (${firstLogin.nickname})`);

    activities = await getCurrentSignActivities(firstLogin.authedHeaders);

    const firstResult = {
      nickname: firstLogin.nickname,
      results: [],
      failures: []
    };

    // 第一个账号也和后续账号一样：单个活动失败只记录，继续其余活动。
    // 只有“登录失败”或“活动发现失败”才会中止，因为后续没有可复用的活动列表。
    for (const activity of activities) {
      try {
        const result = await processSingleActivity(
          firstLogin.nickname,
          firstLogin.authedHeaders,
          activity,
          activity.initialSignInData
        );

        recordActivitySuccess(result);
        firstResult.results.push(result);
        logOk(
          `活动完成: ${activity.name} / ${activity.id} / ` +
          `source=${activity.source}`
        );
      } catch (error) {
        recordActivityFailure(activity, firstUid, error);
        firstResult.failures.push({ activity, error });
        logError(
          `第一个账号活动失败，继续处理其他活动和账号: ` +
          `${activity.name} / ${activity.id}\n原因: ${error.message}`
        );
      } finally {
        delete activity.initialSignInData;
        delete activity.attempts;
      }
    }

    recordAccountResult(firstResult);

    if (firstResult.failures.length === 0) {
      logOk(`第一个账号完成，共处理 ${activities.length} 个有效活动`);
    } else {
      const message =
`⚠️ Top Heroes 第一个账号部分失败，但不会停止后续账号
UID: ${maskUid(firstUid)}
昵称: ${firstLogin.nickname}
成功活动: ${firstResult.results.length}
失败活动: ${firstResult.failures.length}
${firstResult.failures
  .map(item => `- ${item.activity.name} (${item.activity.id}): ${item.error.message}`)
  .join("\n")}`;

      stats.failures.push(message);
      logWarn(message);
      await sendDiscord(message);
    }
  } catch (error) {
    stats.failed++;

    const message =
`🚨 Top Heroes 签到中止
无法使用第一个账号完成登录或活动发现，后续没有可靠活动列表。
UID: ${maskUid(uids[0])}
原因: ${error.message}`;

    logError(message);
    await sendDiscord(message);
    process.exit(1);
  }

  logInfo(`本次确认有效的签到活动: ${activities.length}`);
  for (const activity of activities) {
    logInfo(
      `✓ ${activity.name} / ${getProtocolLabel(activity)} / ` +
      `${activity.baseName} / source=${activity.source}`
    );
  }

  if (uids.length > 1) {
    await randomSleep(5000, 10000);
  }

  const concurrency = Number(process.env.CONCURRENCY || 2);
  const staggerMs = Number(process.env.STAGGER_MS || 1000);

  logInfo(`并发数: ${concurrency}`);
  logInfo(`Worker 错开启动: ${staggerMs}ms`);
  logInfo(`store 登录最小间隔: ${STORE_LOGIN_MIN_INTERVAL_MS}ms`);

  await runWithConcurrency(
    uids.slice(1),
    concurrency,
    async (uid, index, workerId) => {
      const realIndex = index + 1;

      try {
        const result = await processUid(uid, activities);
        recordAccountResult(result);

        const completed = result.results.length;
        const failed = result.failures.length;

        if (failed === 0) {
          logOk(
            `完成: ${result.nickname}，活动 ${completed}/${activities.length}`
          );
        } else {
          const message =
`⚠️ Top Heroes 签到部分失败
进度: ${realIndex + 1}/${uids.length}
Worker: ${workerId}
UID: ${maskUid(uid)}
昵称: ${result.nickname}
成功活动: ${completed}
失败活动: ${failed}
${result.failures
  .map(item => `- ${item.activity.name} (${item.activity.id}): ${item.error.message}`)
  .join("\n")}`;

          stats.failures.push(message);
          logError(message);
          await sendDiscord(message);
        }
      } catch (error) {
        stats.failed++;

        const message =
`❌ Top Heroes 签到失败
进度: ${realIndex + 1}/${uids.length}
Worker: ${workerId}
UID: ${maskUid(uid)}
原因: ${error.message}`;

        stats.failures.push(message);
        logError(message);
        await sendDiscord(message);
      }
    },
    staggerMs
  );

  const rejectedSummary = stats.rejectedActivities.length > 0
    ? `\n\n已排除候选活动:\n${stats.rejectedActivities
        .map(item => `- ${item.activity.id}: ${item.error}`)
        .join("\n")}`
    : "";

  const summary =
`✅ Top Heroes 签到完成
有效活动数: ${activities.length}
活动 ID: ${activities.map(item => item.id).join(", ")}
账号总数: ${stats.total}
全部成功: ${stats.success}
部分成功: ${stats.partial}
完全失败: ${stats.failed}

${buildActivitySummary()}${rejectedSummary}`;

  console.log("\n" + summary);
  await sendDiscord(summary);

  logOk("全部完成！");
}

main().catch(async error => {
  const message = `🚨 Top Heroes 签到程序异常\n原因: ${error.message}`;
  logError(message);
  await sendDiscord(message);
  process.exit(1);
});
