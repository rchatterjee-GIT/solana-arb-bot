# BOT_LIBRARY.md — v4.16 Function & Feature Reference
# Last updated: 30 Aug 2026
# Use this before making ANY changes

---

## FILE MAP

### okx-arb.js (main bot)
Handles: trading, price feeds, rebalance execution, Telegram commands for bot

**Telegram commands handled INSIDE okx-arb.js (via watchdog polling):**
- `/status` — bot health, balances, P&L
- `/balances` — exchange balances
- `/wins` — win/loss summary
- `/trades` — recent trades
- `/crash` — crash log
- `/restart` — restart bot
- `/help` — command list
- `/morning` — morning report
- `/rebalance` — show rebalance plan (does NOT execute)
- `/rebalance confirm` — execute rebalance

**Key functions in okx-arb.js:**
- `handleRebalanceCommand(autoMode)` — calculates and executes rebalance
- `withdrawUSDTFromOKX(amount)` — OKX→Solana (Transfer to funding → withdraw USDT-Solana chain)
- `withdrawUSDTFromBybit(amount, toAddress)` — Bybit→Solana or Bybit→OKX
- `withdrawFromKraken(asset, key)` — Kraken→Solana using named address key
- `executeRebalanceMove(from, to, amount)` — routes to correct withdraw function
- `getOKXBalances()` — OKX trading account USDT balance
- `getBybitEquity()` — Bybit USDT balance  
- `getWalletBalances()` — Solana USDC balance
- `checkAndExecute()` — main scan loop
- `getBuyDexThreshold(ccy)` — gets threshold from threshold-engine.js with config fallback
- `calibrateFromHistory()` — startup threshold calibration from trades.json

### agent.js (monitoring agent)
Handles: autonomous rules, Telegram commands for AGENT operations

**Telegram commands handled in agent.js:**
- `/agent status` — agent health
- `/agent pause` / `/agent resume` — pause/resume autonomous actions
- `/agent report` — force report
- `/agent macro` — macro context
- `/agent approve-thresholds` — approve pending threshold changes
- `/agent skip-thresholds` — dismiss threshold recommendations
- `/agent thresholds` — show pending threshold changes
- `/agent listings` — listing monitor report
- `/agent strategy` — regime report
- `/agent strategy check` — force regime check
- `/agent funding` — funding rates
- `/agent scan-okx` — OKX universe scan
- `/agent calibrate` — recalibrate thresholds
- `/agent pair-thresholds` — show pair thresholds
- `/agent dex-arb on/off` — toggle DEX arb

**NOTE: `/rb confirm` and `/rebalance confirm` are NOT in agent.js**
**They are handled in okx-arb.js**

### agent-rules.js (41 rules)
Key rules and what they do:

| Rule ID | What it does | Risk |
|---------|-------------|------|
| pair-consecutive-losses | Adds pair to SKIP_OKX/SKIP_BYBIT after 3 losses ON ACTIVE EXCHANGE | Fixed: now skips disabled exchanges |
| catastrophic-loss-detection | Kills pair if single loss > $10 on BUY_DEX only | Fixed: BUY_DEX only |
| exchange-severely-imbalanced | ALERTS only, does NOT rebalance | Limitation |
| bot-stale | ALERTS only, does NOT restart | Limitation |
| dex-threshold-dynamic | Updates thresholds based on volume/volatility | Fixed: new base values |
| market-regime-detector | Calls strategy-manager every 5min | Working |
| spread-flip-alert | Alerts when spread approaches threshold | Working |

### threshold-engine.js
- `getThreshold(symbol)` — returns effective threshold
- **Priority order (FIXED): config DEX_THRESHOLD_OVERRIDES → learned → default**
- MIN_THRESHOLD = 0.60% (was 1.2%)
- BUFFER_PCT = 5% (was 10%)
- Calibrates from trades.json on startup

### strategy-manager.js
- Detects BULL/NEUTRAL/BEAR every 5min
- Writes regime config to arb-config.json
- NEUTRAL thresholds: JTO 0.80, SOL 0.80, WIF 1.00, PENGU 1.00, PNUT 1.20, W 1.20

### watchdog.js
- Starts okx-arb.js
- Monitors process, restarts on crash
- Handles /status /balances /wins /trades /crash /restart Telegram commands

---

## REBALANCE ROUTES

| Route | Status | Method | Notes |
|-------|--------|--------|-------|
| OKX→Solana | ✅ WORKING | USDT-Solana chain, fee 0.29, min 1 | Transfer to funding first |
| OKX→Bybit | ✅ WORKING | Pre-whitelisted 6Vmfat... | OKX address book |
| OKX→Kraken | ✅ WORKING | Pre-whitelisted CJoM8s... | OKX address book |
| Bybit→Solana | ✅ WORKING | USDT-SOL withdrawal | |
| Bybit→OKX | ✅ WORKING | OKX deposit address | |
| Kraken→Solana | ❌ BROKEN | `solana-bot` key | EFunding: No funding method — Kraken account config issue, not code |
| Coinbase→Solana | ❌ BROKEN | coinbaseWithdraw() | No COINBASE_API_KEY_NAME in .env |
| Solana→OKX | ⬜ UNTESTED | USDC→USDT swap + send | |
| Solana→Bybit | ⬜ UNTESTED | USDC→USDT swap + send | |

---

## EXCHANGE CREDENTIALS STATUS

| Exchange | Key | Status |
|----------|-----|--------|
| OKX | OKX_API_KEY | ✅ SET |
| Bybit | BYBIT_API_KEY | ✅ SET |
| Kraken | KRAKEN_API_KEY | ✅ SET |
| Coinbase | COINBASE_API_KEY_NAME | ❌ MISSING |
| Jupiter | JUPITER_API_KEY | ✅ SET |
| Solana | PRIVATE_KEY + RPC_URL | ✅ SET |

---

## ACTIVE PAIRS (BUY_DEX only)

| Pair | Threshold | Status | Notes |
|------|-----------|--------|-------|
| JTO/USDT | 0.84% | ✅ Active | Best performer |
| SOL/USDT | 0.84% | ✅ Active | |
| WIF/USDT | 1.05% | ✅ Active | |
| PENGU/USDT | 1.05% | ✅ Active | |
| PNUT/USDT | 1.26% | ✅ Active | |
| W/USDT | 1.26% | ✅ Active | |

## SKIP LISTS (as of 30 Aug 2026)

POLICY_SKIP_OKX: BOME, POPCAT, ZEUS, GOAT, RAY, RENDER, TRUMP, BONK, JUP, MEW
POLICY_SKIP_BYBIT: BOME, POPCAT, ZEUS, GOAT, RAY, RENDER, TRUMP, BONK, JUP, MEW  
POLICY_SKIP_DEX: BOME, POPCAT, ZEUS, GOAT, RAY, RENDER, TRUMP, BONK, JUP, MEW

---

## KNOWN ISSUES

1. **Solana USDC low ($13)** — needs rebalance from OKX. Bot cannot trade until Solana has >$120.
2. **Kraken→Solana broken** — `EFunding: No funding method`. Fix: configure USDT Solana withdrawal in Kraken account settings (Funding → Withdraw → USDT → add Solana network method).
3. **Coinbase broken** — no API key. Fix: add COINBASE_API_KEY_NAME to .env
4. **rebalance /rb confirm** — the rebalance now uses bot-status.json liveBalances (fixed today). OKX→Solana should work. Coinbase and Kraken routes will fail gracefully.
5. **exchange-severely-imbalanced rule** — alerts but doesn't trigger rebalance. Would need agent.js to call handleRebalanceCommand() directly.

---

## DEPLOYMENT RULES (NON-NEGOTIABLE)

1. `taskkill //F //IM node.exe //T` — ALWAYS FIRST
2. Confirm `All clear` before touching anything
3. All patches via `.js` files — NEVER `node -e` inline
4. `node --check <file>` immediately after every change
5. `git add -f <file> && git commit && git push` immediately after verify
6. `git show HEAD:<file> | grep <pattern>` — verify commit contains change
7. `node run-tests.js --static-only` — must pass before restart
8. `restart.bat` only if tests pass

---

## GIT TAGS

- `v4.16-stable` — current stable state (30 Aug 2026)
  - Thresholds: JTO 0.84%, SOL 0.84%, config priority fixed
  - Agent rules: consecutive-loss rule respects disabled exchanges
  - Threshold engine: config overrides take priority over learned values

---

## BALANCES (30 Aug 2026)

- Solana USDC: ~$13 (needs funding)
- OKX trading: ~$562
- Bybit: ~$332
- Kraken: ~$370
- Coinbase: ~$383 (no API key)
- Total: ~$1660
