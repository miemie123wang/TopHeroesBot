# TopHeroesBot - PROJECT

> **Purpose**
>
> This document is the single source of truth for the TopHeroesBot
> project. Every new ChatGPT conversation should start by reading this
> file.

------------------------------------------------------------------------

# 1. Project Overview

TopHeroesBot automates several daily Top Heroes tasks:

-   Daily Sign-in
-   Gift Code Redeem
-   Discord Gift Code Monitor
-   Google Sheets account management
-   Discord notifications

Runtime:

-   Node.js (ES Modules)

------------------------------------------------------------------------

# 2. Current Architecture

    TopHeroesBot
    │
    ├── PROJECT.md          <-- Read first
    ├── README.md           <-- Public introduction
    ├── CHANGELOG.md        <-- Version history
    │
    ├── core/
    │   ├── api.mjs
    │   ├── auth.mjs
    │   ├── config.mjs
    │   ├── discord.mjs
    │   ├── logger.mjs
    │   ├── sheet.mjs
    │   ├── sleep.mjs
    │   └── utils.mjs
    │
    ├── features/
    │   ├── signin/
    │   ├── redeem/
    │   └── monitor/
    │
    ├── runtime/
    ├── tools/
    └── .github/workflows/

------------------------------------------------------------------------

# 3. Module Status

  Module                        Status
  ----------------------------- --------
  M1 Bootstrap                  ✅
  M2 Config                     ✅
  M3 Stable Features            ✅
  M4 Signin Migration           ✅
  M5 Shared Modules             ✅
  M6 Redeem Concurrency         ✅
  M7 Monitor Reliability        ✅
  M7.2 Multi-Activity Sign-in   🚧

------------------------------------------------------------------------

# 4. Design Decisions

## Login

-   Login once per account.
-   Never login multiple times for different features.

## Redeem

-   First account validates gift code.
-   Global failures stop immediately.
-   Account failures continue.
-   Concurrency = 2.

### Why concurrency = 2

Testing result:

-   2 → Stable
-   3 → Occasional 429
-   5 → Unstable

Do not increase without testing.

## Monitor

Trigger chain:

cron-job.org

↓

GitHub workflow_dispatch

↓

monitor.yml

↓

redeem-service

Do not replace with GitHub schedule without discussion.

## Sign-in

Current strategy:

-   Dynamic activity discovery
-   activity_type == 4
-   status == 2
-   activity_switch == 1
-   Login once
-   Process every valid activity

Current game now supports multiple sign-in activities.

Example:

-   3368 气泡霜熊签到0713-正式
-   3419 0716免费金砖签到

------------------------------------------------------------------------

# 5. Workflows

-   signin.yml
-   redeem.yml
-   monitor.yml
-   inspect-discord-message.yml

workflow_dispatch is the primary testing entry.

------------------------------------------------------------------------

# 6. Debug Tools

-   debug-activities.mjs
-   inspect-discord-message.mjs
-   test-old-signin.mjs

------------------------------------------------------------------------

# 7. Collaboration Rules

Always:

-   Use the latest uploaded project ZIP.
-   Modify the real project only.
-   List modified files.
-   Explain why changes are made.

Never:

-   Claim code is finished unless the real project has been updated.
-   Invent ZIP files.
-   Change production trigger without discussion.

------------------------------------------------------------------------

# 8. Next Milestone

Current:

-   Finish M7.2 Multi-Activity Sign-in.

Future:

-   M8 Runtime Pipeline
-   Documentation
-   Long-term maintenance

------------------------------------------------------------------------

# 9. Update Policy

Update this file whenever:

-   A milestone is completed.
-   A major design decision changes.
-   A new workflow is added.
-   Collaboration rules change.

This file should always reflect the latest project state.
