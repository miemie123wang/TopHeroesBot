import * as readline from "readline";

import { fetchApprovedUids } from "../../core/sheet.mjs";
import { redeemAllUids } from "./redeem-service.mjs";

async function getCode() {
  if (process.env.REDEEM_CODE) {
    return process.env.REDEEM_CODE.trim();
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise(resolve => {
    rl.question("輸入兌換碼: ", code => {
      rl.close();
      resolve(code.trim());
    });
  });
}

const uids = await fetchApprovedUids();

console.log(`找到 ${uids.length} 個已 Approved 的帳號`);

const code = await getCode();

if (!code) {
  console.error("沒有輸入兌換碼");
  process.exit(1);
}

console.log(`\n開始兌換: ${code}`);

const summary = await redeemAllUids(code, uids, {
  validateFirst: true,
  concurrency: Number(process.env.REDEEM_CONCURRENCY || 2),
  staggerMs: Number(process.env.REDEEM_STAGGER_MS || 2000),
  firstRedeemOptions: {
    separator: true,
    reportingDelayMs: 1000,
    loginDelayMs: 1000,
    loginOptions: {
      maxRetries: 1,
      preDelayMin: 0,
      preDelayMax: 0
    }
  },
  redeemOptions: {
    separator: true,
    reportingDelayMs: 1000,
    loginDelayMs: 1000,
    loginOptions: {
      maxRetries: 1,
      preDelayMin: 0,
      preDelayMax: 0
    }
  }
});

console.log(
  `\n兌換完成：成功 ${summary.success}，失敗 ${summary.failed}，` +
  `跳過 ${summary.skipped}，已嘗試 ${summary.attempted}/${summary.total}`
);

if (summary.stoppedEarly) {
  console.log(`提前停止：${summary.stopResult?.message || summary.stopReason}`);
}
