# DOXTRADE / GainEX: Complete Architectural Blueprint & Migration Guide

This document provides a comprehensive technical overview of the **GainEX** binary options trading platform, outlining its core systems, architectural patterns, custom design guardrails, and key development history. It is designed to serve as a complete reference for your new IDE instance.

---

## 1. Project Overview & Tech Stack

GainEX is a premium, real-time binary options trading web platform featuring a Single Page Application (SPA) frontend, an Express.js Node backend, and a dual-database design.

*   **Frontend Logic:** Vanilla Javascript with state-driven rendering ([app.js](file:///public/js/app.js)).
*   **Charting Engine:** Custom canvas overlay engine built on top of Lightweight Charts ([chart.js](file:///public/js/chart.js)) optimized for 120fps V-SYNC rendering.
*   **Backend Server:** Node.js + Express ([routes.js](file:///server/routes.js)).
*   **Database Compatibility:** Uses a wrapper layer ([db.js](file:///server/db.js)) that automatically bridges **SQLite** (local development) and **PostgreSQL** (production deployment on Hostinger).
*   **Real-time Data:** Real-time asset pricing fetched every 1.5 seconds from Binance API and distributed via WebSockets (Ably).

---

## 2. Core Subsystems

### A. The Chart & Coordinate Rendering Loop (`public/js/chart.js`)
*   **120fps Performance:** The chart overlay rendering loop uses a high-performance design that avoids **layout thrashing**.
*   **Dimension Caching:** Viewport client dimensions (`getBoundingClientRect()`) are cached and throttled to once every 1000ms.
*   **Element Caching:** Active trades, ticker indicators, and sentiment bars cache their DOM elements inside class fields (`this._elements`) during initialization to avoid `document.getElementById` lookup overhead.
*   **Repaint Guard:** Style/rendering repaints (like sentiment bar modifications) are gated with change guards (`_lastDisplayGreen !== displayGreen`) so they only redraw when values actually change.

### B. Dual-Database Compatibility Layer (`server/db.js`)
To maintain consistency between local SQLite development and live Postgres:
*   **Syntax Translation:** `convertSqlForPg(sql)` dynamically converts SQLite `?` placeholders to PostgreSQL `$1, $2` parameters.
*   **Boolean Coercion:** PostgreSQL strictly requires SQL boolean literals (`true`/`false`), while SQLite uses integers (`1`/`0`). The `fillParams()` method handles this translation dynamically.
*   **Wrapper Constraints:** The DB helper only supports `.get()`, `.all()`, and `.run()`. Calling `.query()` directly on the connection will result in runtime exceptions.
*   **PG Result Wrapper:** The `.run()` implementation for PostgreSQL appends `RETURNING id` dynamically to insert statements to mimic SQLite's return object containing `lastID`.

### C. Dynamic E-Wallet Limits & Rates
*   **PKR Conversions:** Configured dynamic deposit/withdrawal e-wallet limits. In [app.js](file:///public/js/app.js), selected methods (Easypaisa, Jazzcash, Sadapay, Nayapay, Zindgi) have their limits converted from USD base to PKR using the method's database rate (`pkr_rate`).
*   **Input Validation:** Client input validation limits inputs in PKR dynamically and provides warnings for out-of-bound requests.
*   **Image Compression:** All screenshot/slip uploads are compressed client-side to maximum 1024x1024 JPEG format (~100KB-150KB) before submitting. This avoids hitting Nginx/cPanel `413 Request Entity Too Large` payload limits on live Hostinger servers.

### D. Safe Ledger & History Parsing
*   **Null Coercions:** Description strings in database ledger entries can be `null` on PostgreSQL. Both the backend `/client/history` filter loop and the frontend `loadHistoryData` sanitize these inputs using `String(desc || '')` and `parseFloat` formatting to prevent `TypeError` page crashes.

---

## 3. Strict Rules & Architectural Constraints (`AGENTS.md`)

When transitioning this project to your new PC, ensure your new Antigravity instance follows these workspace rules:

```markdown
- Widescreen layouts must have main content (.app-content) constrained to max 1280px-1300px and centered.
- The Wallet page tab container (#tab-wallet) must be restricted to 800px on desktop.
- The trading screen (.app-content.trade-mode) must override width limits to span 100% of the viewport.
- Never modify mobile media queries when adjusting desktop widescreen rules.
- Authenticated routes must use the 'authenticateToken' middleware.
- Subscribed Ably channels must call `.unsubscribe()` before registering new event callbacks.
- First-time visitors default to the White (Light) theme.
- Dashboard/Home balance cards must always display the Real Balance, never the Demo Balance.
- Zip compression for Hostinger uploads must use PowerShell's 'Compress-Archive' with '*' to ensure a flat structure (no './' path prefixes at root).
- Copying files for zipping requires a 5-second sleep delay before compression to prevent file locks.
```

---

## 4. Migration & Transfer Protocol

To successfully transfer the project to your PC's Antigravity:

### Step 1: Copy Codebase Files
Transfer the workspace files to your new machine, ensuring you copy the following root folders:
```
public/
server/
staff/
app.js
package.json
package-lock.json
migration_guide.md (This document)
.env (Important: Contains JWT secrets, database URLs, and API keys)
.agents/AGENTS.md (Important: Contains the rules listed in Section 3)
```

### Step 2: Install Dependencies
Run:
```bash
npm install
```

### Step 3: Seed Database Settings
If starting with a fresh local database:
- Launching the development server (`npm run dev`) automatically creates the SQLite file (`database.sqlite`) and runs migrations/seeds configured in [db.js](file:///server/db.js), including default users, currency settings, and e-wallet methods.

### Step 4: Bootstrapping the New Antigravity Instance
Once your project files are set up on the new PC, your new Antigravity instance can be immediately aligned with the codebase's history:
1. **Explain the DB Schema:** Point the agent to [server/db.js](file:///server/db.js) and [server/routes.js](file:///server/routes.js).
2. **Teach the Custom Rules:** The agent will automatically scan the Workspace Customizations Root (`.agents/AGENTS.md`). Ensure this file exists at the root of the workspace.
3. **Use `/learn`:** You can use the `/learn` slash command in the chat UI on your new PC to persist behavioral memories or code constraints across sessions.
