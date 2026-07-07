# TopHeroesBot

A long-term automation project for **Top Heroes**.

---

# Philosophy

> Build it slowly.
>
> Keep it clean.
>
> Keep it runnable.

---

# Features

- ✅ Daily Sign-in
- ✅ Make-up Sign-in
- ✅ Gift Code Redeem
- ✅ Gift Code Monitor
- ✅ Google Sheet Account Management
- ✅ Discord Notification

---

# Project Structure

```
TopHeroesBot
│
├── .github
│   └── workflows
│
├── core
│   ├── api.mjs
│   ├── config.mjs
│   ├── discord.mjs
│   ├── logger.mjs
│   ├── sheet.mjs
│   ├── sleep.mjs
│   └── utils.mjs
│
├── features
│   ├── signin
│   │   └── signin.mjs
│   │
│   ├── redeem
│   │   └── redeem.mjs
│   │
│   └── monitor
│       └── monitor.mjs
│
├── docs
│
├── README.md
└── package.json
```

---

# Architecture

```
GitHub Actions
        │
        ▼
Feature Modules
(signin / redeem / monitor)
        │
        ▼
Core Modules
(api / config / logger / sheet / discord)
        │
        ▼
Top Heroes API
Google Apps Script
Discord
```

---

# Design Principles

### Main is always runnable

Every commit pushed to `main` should be deployable.

---

### Import before Refactor

Always import the stable implementation first.

Refactor only after the feature has been verified.

---

### Shared code belongs in `core`

Only reusable modules should be moved into `core`.

Feature-specific code stays inside its own feature folder.

---

### One Milestone, One Goal

Small commits.

Small improvements.

Long-term maintainability.

---

# Milestones

| Status | Milestone |
|--------|-----------|
| ✅ | M1 - Project Bootstrap |
| ✅ | M2 - Extract Config |
| ✅ | M3 - Import Stable Features |
| ⏳ | M4 - Switch GitHub Actions to Project |
| ⏳ | M5 - Extract Sleep |
| ⏳ | M6 - Extract Logger |
| ⏳ | M7 - Extract Discord |
| ⏳ | M8 - Extract Google Sheet |
| ⏳ | M9 - Extract API |
| ⏳ | M10 - Shared HTTP Client |

---

# Development Log

## 2026-07-08

- Initialized TopHeroesBot project
- Created feature-based architecture
- Added core module
- Extracted configuration
- Imported stable Sign-in / Redeem / Monitor modules

---

# Future Ideas

- Better retry mechanism
- Shared HTTP client
- Unit tests
- Activity plug-in architecture
- Dashboard

---

# License

MIT