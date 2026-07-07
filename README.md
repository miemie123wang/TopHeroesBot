# TopHeroesBot

An automation bot for Top Heroes.

## Features

- ✅ Daily Sign-in
- ✅ Make-up Sign-in
- ✅ Gift Code Redeem
- ✅ Google Sheet Account Management
- ✅ Discord Notification

---

## Project Structure

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
│   ├── redeem
│   └── monitor
│
├── docs
│
├── README.md
└── package.json
```

---

## Architecture

Feature-based architecture.

```
Features
        │
        ▼
     Core Layer
        │
        ▼
Top Heroes API / Google Sheet / Discord
```

---

## Design Principles

### 1. Main branch is always runnable.

Every commit should be stable.

---

### 2. Only `core/api.mjs` communicates with Top Heroes API.

Business modules should never call `fetch()` directly.

---

### 3. Core contains only reusable modules.

If a module is shared by two or more features, it belongs in `core`.

Otherwise it stays inside its feature.

---

### 4. Small commits.

One feature.

One commit.

One milestone.

---

## Milestones

| Status | Milestone |
|--------|-----------|
| ✅ | M1 - Project Bootstrap |
| ✅ | M2 - Extract Config |
| ⏳ | M3 - Extract Sleep |
| ⏳ | M4 - Extract Logger |
| ⏳ | M5 - Extract Discord |
| ⏳ | M6 - Extract Sheet |
| ⏳ | M7 - Extract API |
| ⏳ | M8 - Signin Module |
| ⏳ | M9 - Redeem Module |
| ⏳ | M10 - Monitor Module |

---

## Future Plans

- Better retry mechanism
- Activity auto discovery
- Shared HTTP client
- Unit tests
- More event modules

---

## License

MIT