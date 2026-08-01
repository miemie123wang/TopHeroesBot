TopHeroesBot 签到自动发现修正版
================================

替换文件：
1. features/signin/signin.mjs
2. .github/workflows/signin.yml

本次修正：
- 自动模式只执行 builder/info 当前页面中出现的活动 ID。
- KOP biz/list 仅用于补充活动名称，不再把 test1111、常驻循环和历史签到加入执行列表。
- 第一个账号的单个活动失败不会停止后续活动和其他账号。
- 补签返回 code=10006 / permission denied 时，只跳过该次补签，继续今天签到和其他账号。
- 只有第一个账号登录失败或活动发现失败时，才会中止，因为此时没有可靠活动列表可供后续账号复用。
- GitHub Actions 手动 activity_id 入口保持不变。

按 2026-08-01 的页面配置，自动模式应识别：
- 1113212
- 3431

不应再执行：
- 3508 (test1111)
- 3010 / 2569 / 2299 等 KOP 常驻或历史候选

本地运行：
  node features/signin/signin.mjs

本地手动指定活动：
  PowerShell:
    $env:SIGNIN_ACTIVITY_ID="3431"
    node features/signin/signin.mjs

GitHub Actions：
- activity_id 留空：从 builder/info 自动发现当前页面签到活动。
- activity_id 填 3431 或 1113212：只处理该活动。
