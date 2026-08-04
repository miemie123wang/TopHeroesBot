TopHeroesBot 签到修正包（2026-08-03）

本包不是完整项目：用户上传的源包只包含 auth.mjs、api.mjs、signin.mjs。
本包已按项目目录重新整理，可直接覆盖：

  core/auth.mjs
  core/api.mjs
  features/signin/signin.mjs

修复内容：
1. 签到功能优先在 https://store.topheroes.com 登录，device=pc。
2. 新活动可用 chain_id 查询 sign-in-list，但 gift/receive 始终提交 activity_id。
3. 提交签到时补齐 store 同源 Origin、Referer、site-token Cookie。
4. 保留 builder/info 自动发现、chain_id=1 探测、KOP 名称补充。
5. 单个活动失败继续处理其他活动与后续账号。

覆盖方法：
1. 备份当前项目。
2. 将本包内 core 和 features 文件夹复制到 TopHeroesBot 根目录并选择覆盖。
3. 在项目根目录运行：

   node --check core/auth.mjs
   node --check core/api.mjs
   node --check features/signin/signin.mjs

4. 本地先用 DEBUG_UID 运行：

   node features/signin/signin.mjs

关键成功日志应包含：

  [LOGIN OK] ... (store mall)
  签到活动 1113205 / query:chain_id=1 / receive:activity_id=1113205
  今天签到成功

注意：
- 不要把 runtime/*.json 加入 Git。
- 本包未包含 config、sheet、discord、workflow 等项目其他文件。
- 若需要整个项目 ZIP，请上传当前完整 TopHeroesBot 项目 ZIP，再在完整项目上合并本修复。
