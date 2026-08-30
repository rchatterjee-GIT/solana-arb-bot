# VARIABLES_AND_CONTAINERS.md — v4.16 Complete Reference
# Last updated: 30 Aug 2026

---

## 1. RUNTIME STATE (in-memory, lost on restart)

### Trading State (persisted to arb-state.json on change)
| Variable | Type | Default | Purpose |
|----------|------|---------|---------|
| `totalProfit` | number | from state | Cumulative P&L in USD |
| `totalTrades` | number | from state | Total completed trades |
| `winningTrades` | number | from state | Number of winning trades |
| `consecutiveWins` | number | from state | Current consecutive win streak |
| `startCapital` | number | from state | Starting capital for session |

### Price Feeds (updated by WebSocket in real-time)
| Variable | Type | Structure | Purpose |
|----------|------|-----------|---------|
| `okxPrices` | object | `{instId: {bid, ask, last}}` | OKX real-time prices |
| `bybitPrices` | object | `{symbol: {bid, ask}}` | Bybit real-time prices |
| `lastKnownPrice` | object | `{pairName: price}` | Last valid price per pair |
| `priceTimestamps` | object | `{key: timestamp}` | When each price was last updated |

### Exchange Health
| Variable | Type | Purpose |
|----------|------|---------|
| `okxHealthy` | boolean | Is OKX API responding? |
| `okxHealthLastCheck` | number | Last health check timestamp |
| `okxDownSince` | number\|null | When OKX went down (null if up) |
| `feedsReady` | boolean | Both WS feeds connected and receiving |

### Config (hot-reloaded every 30s)
| Variable | Type | Purpose |
|----------|------|---------|
| `liveConfig` | object | Current arb-config.json contents |
| `lastConfigLoad` | number | Timestamp of last config reload |

### Trade Execution Locks (prevent race conditions)
| Variable | Type | Purpose |
|----------|------|---------|
| `pendingDex` | array | Active DEX trade IDs |
| `pendingOkx` | array | Active OKX trade IDs |
| `pendingBybit` | array | Active Bybit trade IDs |
| `executingDex` | boolean | DEX execution in progress |
| `executingOkx` | boolean | OKX execution in progress |
| `executingBybit` | boolean | Bybit execution in progress |
| `executingCoinbase` | boolean | Coinbase execution in progress |
| `executingKraken` | boolean | Kraken execution in progress |
| `bybitLock` | boolean | Bybit order lock |
| `dexLock` | boolean | DEX swap lock |
| `rebalancing` | boolean | Rebalance in progress |
| `testRunning` | boolean | Exchange test in progress |
| `coinbaseLock` | boolean | Coinbase operation lock |

### Dynamic Data
| Variable | Type | Purpose |
|----------|------|---------|
| `dynamicPairs` | array | New pairs from new-pairs.json |
| `lastDynamicPairsLoad` | number | Last load timestamp |
| `okxWithdrawalInfo` | object | OKX withdrawal fees/precision per pair |
| `bybitWithdrawalInfo` | object | Bybit withdrawal fees/precision per pair |
| `lastCoinRefresh` | number | Last coin viability refresh |
| `peakSpreads` | object | Peak spreads per pair per direction |
| `bandState` | object | Approach band alert state |
| `checkAndExecuteRunning` | boolean | Main scan loop running |
| `lastReportTime` | number | Last report timestamp |
| `consecutiveErrors` | number | Consecutive scan errors |
| `lastMorningReportDate` | string | Date of last morning report |
| `lastTelegramUpdateId` | number | Last TG update processed |
| `lastTestDate` | Date\|null | Last exchange test run |
| `lastWalletClean` | number | Last wallet cleanup timestamp |
| `scanDebounce` | timeout | Scan debounce timer |

---

## 2. CONSTANTS (hardcoded, require restart to change)

| Constant | Value | Purpose |
|----------|-------|---------|
| `BOT_VERSION` | 'v4.16' | Version string |
| `TRADE_SIZE_USD` | 120 | Default trade size (overridden by liveConfig) |
| `MIN_SPREAD_CEX` | 1.00% | Min spread for CEX direction |
| `MAX_RETRIES` | 3 | Max retries on failure |
| `OKX_FEE` | 0.001 | OKX taker fee (0.1%) |
| `BYBIT_FEE` | 0.001 | Bybit taker fee (0.1%) |
| `DEX_FEE` | 0.003 | Jupiter DEX fee (0.3%) |
| `REBALANCE_FLOOR` | 80 | Min USDT to keep on exchange |
| `REBALANCE_RESERVE` | 80 | Reserve buffer for rebalance |
| `MAX_PRICE_MOVE` | 0.20 | Max 20% price move before abort |
| `MAX_PRICE_AGE_MS` | 15,000 | Price stale after 15s |
| `MAX_WITHDRAWAL_FEE_PCT` | 5.0% | Skip pairs with high withdrawal fees |
| `COIN_REFRESH_MS` | 6hrs | How often to refresh coin viability |
| `POLL_INTERVAL_MS` | 30,000 | Telegram command poll interval |
| `POLL_TIMEOUT_MS` | 2hrs | USDT poll timeout |
| `MIN_PROFIT` | $0.50 | Min profit to fire |
| `LEG_A_SLIPPAGE` | [100,200,300,500] bps | Slippage ladder for buy leg |
| `LEG_B_SLIPPAGE` | [100,200,300] bps | Slippage ladder for sell leg |
| `ACTIVE_HOURS_START` | 5 | Active trading start hour UTC |
| `ACTIVE_HOURS_END` | 15 | Active trading end hour UTC |
| `WINS_TARGET` | 10 | Consecutive wins target for scaling |
| `SESSION_STOP_LOSS` | $10.00 | Stop trading if down this much |
| `BALANCE_FLOOR_USDT` | $40.00 | Alert if exchange drops below |
| `BYBIT_SETTLE_DELAY_MS` | 15,000 | Wait after Bybit order before checking |
| `DUST_USD_THRESHOLD` | $0.50 | Ignore balances below this |
| `HOLD_CHECK_MS` | 30,000 | How often to check held positions |
| `HOLD_MAX_MS` | 2hrs | Max time to hold a position |
| `HOLD_STOP_LOSS_PCT` | 5.0% | Sell held position if down this much |
| `HOLD_MIN_SPREAD_PCT` | 0.4% | Min spread to hold position for |
| `HOLD_REPORT_INTERVAL` | 30min | How often to report held positions |
| `OKX_HEALTH_INTERVAL` | 30,000 | How often to check OKX health |
| `WALLET_CLEAN_INTERVAL_MS` | 15min | Background wallet cleanup interval |

### Token Addresses
| Constant | Value | Purpose |
|----------|-------|---------|
| `USDC_MINT` | EPjFWdd5... | Solana USDC mint address |
| `USDT_MINT` | Es9vMFrz... | Solana USDT mint address |

### Pair Configuration
| Constant | Type | Purpose |
|----------|------|---------|
| `PAIRS` | array | Static pair definitions with mints, decimals, exchange IDs |
| `BUY_DEX_THRESHOLDS` | object | Default DEX thresholds per pair (overridden by threshold-engine) |
| `COINBASE_PAIRS` | Set | Pairs available on Coinbase |
| `COINBASE_DECIMALS` | object | Decimal precision per pair on Coinbase |

---

## 3. PERSISTED FILES (JSON on disk)

### arb-config.json — Hot-reloaded every 30s
| Key | Type | Purpose |
|-----|------|---------|
| `TRADE_SIZE_USD` | number | Trade size override |
| `MIN_SPREAD_CEX` | number | Min spread for CEX direction |
| `MIN_SPREAD_KRAKEN` | number | Min spread for Kraken direction |
| `MIN_SPREAD_BUFFER_PCT` | number | Buffer % on top of threshold |
| `MAX_CONCURRENT_TRADES` | number | Max simultaneous trades |
| `DEX_THRESHOLD_OVERRIDES` | object | Per-pair DEX thresholds {JTO:0.80, SOL:0.80, ...} |
| `POLICY_SKIP_OKX` | array | Pairs to skip on OKX |
| `POLICY_SKIP_BYBIT` | array | Pairs to skip on Bybit |
| `POLICY_SKIP_DEX` | array | Pairs to skip on DEX direction |
| `RECOVERY_SKIP_BYBIT` | array | Pairs to skip in Bybit recovery |
| `DISABLE_BUY_OKX` | boolean | Disable OKX buy leg entirely |
| `DISABLE_BUY_BYBIT` | boolean | Disable Bybit buy leg entirely |
| `DISABLE_BUY_DEX` | boolean | Disable DEX buy direction |
| `KRAKEN_ENABLED` | boolean | Enable Kraken exchange |
| `KRAKEN_SYNTHETIC` | boolean | Kraken synthetic mode |
| `COINBASE_ENABLED` | boolean | Enable Coinbase exchange |
| `SMART_SELL` | boolean | Enable smart sell holding |
| `HOLD_MAX_HOURS` | number | Max hold time in hours |
| `HOLD_STOP_LOSS_PCT` | number | Hold stop loss % |
| `HOLD_MIN_SPREAD_PCT` | number | Min spread to hold for |
| `HOLD_CHECK_SECS` | number | Hold check interval in seconds |
| `VOLATILE_MODE` | boolean | Volatile mode active |
| `VOLATILE_BAND_MULTIPLIER` | number | Band multiplier in volatile mode |
| `APPROACH_BANDS` | array | Approach band thresholds [{pct, cooldown_min, note}] |
| `APPROACH_ACTIVE_WEEKDAY_START` | number | Active window start hour |
| `APPROACH_ACTIVE_WEEKDAY_END` | number | Active window end hour |
| `WEEKEND_ALERTS` | boolean | Send weekend alerts |
| `WINS_TARGET` | number | Consecutive wins target |
| `REBALANCE_TARGET_SOLANA` | number | Target Solana balance |
| `REBALANCE_TARGET_OKX` | number | Target OKX balance |
| `REBALANCE_TARGET_BYBIT` | number | Target Bybit balance |
| `REBALANCE_TARGET_KRAKEN` | number | Target Kraken balance |
| `ACTIVE_REGIME` | string | BULL/NEUTRAL/BEAR |
| `TEMP_SKIPS` | object | Temporary pair skips with expiry timestamps |
| `DEX_ARB_ENABLED` | boolean | Enable DEX-DEX arb |

### arb-state.json — Saved on every trade
| Key | Type | Purpose |
|-----|------|---------|
| `totalProfit` | number | Cumulative P&L |
| `totalTrades` | number | Total trades |
| `winningTrades` | number | Winning trades |
| `consecutiveWins` | number | Current win streak |
| `startCapital` | number | Starting capital |
| `version` | string | Bot version that wrote it |

### bot-status.json — Updated every scan cycle
| Key | Type | Purpose |
|-----|------|---------|
| `timestamp` | string | ISO timestamp of last update |
| `okxHealthy` | boolean | OKX API status |
| `activeTradeCount` | number | Trades currently executing |
| `totalTrades` | number | Total trades |
| `winningTrades` | number | Winning trades |
| `totalProfit` | number | Cumulative P&L |
| `consecutiveWins` | number | Current win streak |
| `liveBalances` | object | `{solana, okx, bybit, kraken, coinbase, total, updatedAt}` |

### arb-live.json — Updated every scan cycle
| Key | Type | Purpose |
|-----|------|---------|
| `timestamp` | string | ISO timestamp |
| `okxHealthy` | boolean | OKX health |
| `pairs` | array | Per-pair data: `{name, okxBid, okxAsk, bybitBid, bybitAsk, spreadOKX, spreadBybit, spreadDex, dexThresh, okxViable, bybitViable, dexEnabled}` |

### trades.json — Appended on every trade
| Key | Type | Purpose |
|-----|------|---------|
| `date` | string | ISO timestamp |
| `pair` | string | e.g. 'JTO/USDT' |
| `direction` | string | BUY_DEX, BUY_OKX, BUY_BYBIT, SELL_COINBASE, RECOVERY |
| `exchange` | string | OKX, Bybit, DEX |
| `spreadPct` | number | Spread at time of fire |
| `profit` | number | Actual profit/loss |
| `outcome` | string | WIN, LOSS, ERROR |
| `tradeId` | string | Unique trade ID |

### pair-thresholds.json — Updated by threshold-engine
| Key | Type | Purpose |
|-----|------|---------|
| `[symbol]` | object | Per-pair: `{threshold, wins[], losses[], winRate, source, updatedAt}` |
| `source` | string | 'learned', 'history', 'disabled-all-losses', 'market-derived' |

### agent-state.json — Agent persistent state
| Key | Type | Purpose |
|-----|------|---------|
| `lastDexAdjust` | number | Last threshold adjustment timestamp |
| `lastRegimeCheck` | number | Last regime check timestamp |
| `lastStaleAlert` | number | Last bot-stale alert timestamp |
| `lastFundingArbOpen` | number | Last funding arb open attempt |
| `pendingThresholdChanges` | array | Threshold changes awaiting approval |
| `[PAUSED_KEY]` | boolean | Agent paused flag |
| `TEMP_SKIPS` | object | Temporary skips with expiry |

### strategy-state.json — Strategy manager state
| Key | Type | Purpose |
|-----|------|---------|
| `regime` | string | BULL/NEUTRAL/BEAR |
| `since` | string | ISO timestamp of regime start |
| `btcPrice` | number | BTC price at last check |
| `btcChange24h` | number | BTC 24h change % |
| `reason` | string | Human readable regime reason |
| `lastCheck` | string | ISO timestamp of last check |

### fires.json — Every trade attempt logged
| Key | Type | Purpose |
|-----|------|---------|
| `tradeId` | string | Unique ID |
| `pair` | string | Pair name |
| `direction` | string | Trade direction |
| `spreadPct` | number | Spread at fire |
| `outcome` | string | fired, skipped, error |
| `reason` | string | Why it was skipped/errored |
| `fundsAffected` | boolean | Were funds moved? |

### new-pairs.json — Dynamic pairs from listing monitor
| Structure | array of pair objects same as PAIRS constant |

### arb-log.json — Daily balance log
| Key | Type | Purpose |
|-----|------|---------|
| `days` | array | Per-day: `{date, reports[]}` |
| Report | object | `{time, solanaUsdc, okxUsdt, bybitUsdt, total, trades, pnl, peaks}` |

---

## 4. KEY FUNCTIONS REFERENCE

### Exchange API Functions
| Function | Exchange | Purpose |
|----------|----------|---------|
| `okxPrivate(method, path, body)` | OKX | Authenticated OKX API call |
| `bybitPrivate(method, path, params)` | Bybit | Authenticated Bybit API call |
| `getOKXBalances()` | OKX | Trading account USDT balance |
| `getOKXFundingBal(ccy)` | OKX | Funding account balance |
| `getBybitEquity()` | Bybit | Bybit USDT equity |
| `getBybitBalance(ccy)` | Bybit | Specific Bybit balance |
| `getWalletBalances()` | Solana | USDC + token balances |
| `getTokenBalance(mint, isNative)` | Solana | Specific token balance |

### Withdrawal Functions
| Function | Route | Notes |
|----------|-------|-------|
| `withdrawFromOKX(ccy, chain, grossAmount)` | OKX→anywhere | Transfer to funding first, then withdraw |
| `withdrawUSDTFromOKX(amount, toAddr, chain)` | OKX→Solana | Chain='USDT-Solana', fee=0.29 |
| `withdrawFromBybit(ccy, chain, grossAmount)` | Bybit→anywhere | |
| `withdrawUSDTFromBybit(amount, toAddr)` | Bybit→Solana | |
| `withdrawUSDTFromOKXToKraken(amount)` | OKX→Kraken | Via hardcoded OKX address book |
| `withdrawFromCoinbaseToSolana(amount)` | Coinbase→Solana | Requires COINBASE_API_KEY_NAME |
| `sendTokenToAddress(pair, rawAmount, addr)` | Solana→anywhere | Token transfer on Solana |
| `sendUSDTOnSolana(amount, toAddr)` | Solana USDT | Send USDT between Solana addresses |
| `sendUSDCOnSolana(amount, toAddr)` | Solana USDC | Send USDC between Solana addresses |

### Swap Functions
| Function | Purpose |
|----------|---------|
| `getQuote(inMint, outMint, amount, isRaw, dex)` | Jupiter quote |
| `jupiterSwapRaw(inMint, outMint, rawAmount, slippageBps)` | Execute swap |
| `executeJupiterSwap(quote, ctx)` | Execute swap with retry and slippage ladder |
| `swapUSDCtoUSDT(amountUsd)` | USDC→USDT on Jupiter |
| `swapUSDTtoUSDC(amountUsd)` | USDT→USDC on Jupiter |
| `pollAndSwapUSDTtoUSDC(expectedUsd)` | Poll for USDT arrival then swap |

### Rebalance Functions
| Function | Purpose |
|----------|---------|
| `handleRebalanceCommand(confirm)` | Main rebalance entry point — called by /rebalance confirm |
| `executeRebalanceMove(move)` | Execute a single rebalance move |
| `checkAndRebalance()` | Auto-rebalance check (runs after each trade) |

### Threshold Functions
| Function | Purpose |
|----------|---------|
| `getBuyDexThreshold(ccy)` | Get effective threshold: config → learned → default |
| `thresholdEngine.getThreshold(symbol)` | Threshold engine lookup |
| `thresholdEngine.calibrateFromHistory()` | Calibrate from trades.json |

### Recovery Functions
| Function | Purpose |
|----------|---------|
| `recoverSolanaTokens()` | Sell orphaned tokens on Solana |
| `recoverOKXTokens()` | Recover tokens stuck on OKX |
| `recoverBybitTokens()` | Recover tokens stuck on Bybit |
| `runRecoveryChecks()` | Run all recovery checks |
| `backgroundWalletClean()` | Periodic cleanup of dust |

### Classes
| Class | Purpose |
|-------|---------|
| `TradeLogger` | ms-precision trade step logging to trade-log.json |
| `TradeContext` | Single trade lifecycle management, outcome tracking |

---

## 5. ENV VARIABLES REQUIRED

| Variable | Required | Purpose |
|----------|----------|---------|
| `RPC_URL` | ✅ | Helius Solana RPC endpoint |
| `PRIVATE_KEY` | ✅ | Solana wallet private key (JSON array) |
| `OKX_API_KEY` | ✅ | OKX API key |
| `OKX_API_SECRET` | ✅ | OKX API secret |
| `OKX_PASSPHRASE` | ✅ | OKX API passphrase |
| `BYBIT_API_KEY` | ✅ | Bybit API key |
| `BYBIT_API_SECRET` | ✅ | Bybit API secret |
| `KRAKEN_API_KEY` | ✅ | Kraken API key |
| `KRAKEN_API_SECRET` | ✅ | Kraken API secret |
| `JUPITER_API_KEY` | ✅ | Jupiter paid API key |
| `TELEGRAM_TOKEN` | ✅ | Telegram bot token |
| `TELEGRAM_CHAT_ID` | ✅ | Telegram chat ID |
| `COINBASE_API_KEY_NAME` | ❌ MISSING | Coinbase Advanced Trade key name |
| `COINBASE_API_KEY_SECRET` | ❌ MISSING | Coinbase Advanced Trade private key |

---

## 6. APPROACH BANDS (alert system)

Fires Telegram alert when spread reaches % of threshold:

| Band | Default % | Default Cooldown |
|------|-----------|-----------------|
| Band 1 | 60% | 60 min |
| Band 2 | 75% | 30 min |
| Band 3 | 90% | 15 min |

Configurable via `APPROACH_BANDS` in arb-config.json.

---

## 7. SCALING GATES

| Gate | Trigger | Action |
|------|---------|--------|
| Gate 1 | 24 consecutive clean trades | ✅ Done |
| Gate 2 | 10 consecutive wins at $120 | Scale to $200, add Kraken |
| Gate 3 | 10 consecutive wins at $200 | Scale to $300 |
| Gate 4 | Coinbase proven | Add to full rotation |
