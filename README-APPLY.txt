TopHeroesBot 签到自动发现最终版
================================

替换文件：
1. features/signin/signin.mjs
2. .github/workflows/signin.yml

功能：
- 留空 activity_id：登录第一个账号后，从 builder/info 自动提取活动候选。
- 同时从 KOP biz/list 补充旧系统签到候选。
- 每个候选都通过 sign-in-list 验证，非签到活动自动排除。
- 当前应自动识别 1113212 和 3431。
- GitHub Actions 手动填写 activity_id 时，只验证并执行该活动。
- 支持多个同时存在的签到活动。
- 每个账号只登录一次。
- 并发保持 2。

本地运行：
  node features/signin/signin.mjs

本地手动指定活动：
  PowerShell:
    $env:SIGNIN_ACTIVITY_ID="3431"
    node features/signin/signin.mjs

  CMD:
    set SIGNIN_ACTIVITY_ID=3431
    node features/signin/signin.mjs

GitHub Actions：
- activity_id 留空：自动发现。
- activity_id 填 3431 或 1113212：只处理该活动。
