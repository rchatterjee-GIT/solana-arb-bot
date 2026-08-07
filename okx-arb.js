require('dotenv').config();
// ── Version History ───────────────────────────────────────────────────────────
// v4.14 — DEX atomic lock fix, cross-exchange ranking, balance sync, auto-rebalance
// v4.13 — immediate rebalance after trade completion
// v4.12 — consecutiveClean resets on restart (session-based)
// v4.11 — consecutiveClean now persists to state after every trade
// v4.10 — Kraken scaffold (KRAKEN_ENABLED/KRAKEN_SYNTHETIC), sim cooldown,
//          atomic locks, OKX WS watchdog, consecutiveClean counter,
//          TradeLogger ms-precision forensics, rebalance command,
//          deploy.bat CI/CD, cleanBar morning report fix
// v4.9  — Smart sell fix, Bybit UUID withdrawal, spread buffer,
//          MAX_CONCURRENT_TRADES, background USDT cleaner, morning report
// ─────────────────────────────────────────────────────────────────────────────
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');
const WebSocket = require('ws');
const { Connection, Keypair, VersionedTransaction, PublicKey, Transaction } = require('@solana/web3.js');
const { getAssociatedTokenAddress, getAccount, createTransferInstruction, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');

// ── Global crash handlers ─────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  const msg = `${new Date().toISOString()} UNCAUGHT: ${err.message}\n${err.stack}\n\n`;
  console.error('💥 Uncaught exception:', err.message);
  try { fs.appendFileSync(path.join(__dirname, 'crash.log'), msg); } catch (e) {}
});
process.on('unhandledRejection', (reason) => {
  const msg = `${new Date().toISOString()} UNHANDLED REJECTION: ${reason}\n\n`;
  console.error('💥 Unhandled rejection:', reason);
  try { fs.appendFileSync(path.join(__dirname, 'crash.log'), msg); } catch (e) {}
});

const connection = new Connection(process.env.RPC_URL, 'confirmed');
const wallet     = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY)));
console.log('🔑 Wallet loaded:', wallet.publicKey.toString());

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_VERSION            = 'v4.14';
const TRADE_SIZE_USD         = 120;
const MIN_SPREAD_CEX         = 1.00;
const MAX_RETRIES            = 3;
const OKX_FEE                = 0.001;
const BYBIT_FEE              = 0.001;
const DEX_FEE                = 0.003;
const REBALANCE_FLOOR        = 80;
const REBALANCE_RESERVE      = 80;
const MAX_PRICE_MOVE         = 0.20;
const MAX_PRICE_AGE_MS       = 15_000;
const MAX_WITHDRAWAL_FEE_PCT = 5.0;
const COIN_REFRESH_MS        = 6 * 60 * 60 * 1000;
const POLL_INTERVAL_MS       = 30_000;
const POLL_TIMEOUT_MS        = 2 * 60 * 60 * 1000;
const MIN_PROFIT             = 0.50;
const LEG_A_SLIPPAGE         = [100, 200, 300, 500];
const LEG_B_SLIPPAGE         = [100, 200, 300];
const ACTIVE_HOURS_START     = 5;
const ACTIVE_HOURS_END       = 15;
const WINS_TARGET            = 10;
const SESSION_STOP_LOSS      = 10.00;
const BALANCE_FLOOR_USDT     = 40.00;
const BYBIT_SETTLE_DELAY_MS  = 15_000;
const DUST_USD_THRESHOLD     = 0.50;
const HOLD_CHECK_MS          = 30_000;
const HOLD_MAX_MS            = 2 * 60 * 60 * 1000;
const HOLD_STOP_LOSS_PCT     = 5.0;
const HOLD_MIN_SPREAD_PCT    = 0.4;
const HOLD_REPORT_INTERVAL   = 30 * 60 * 1000;

// ── Per-pair BUY_DEX thresholds ───────────────────────────────────────────────
const BUY_DEX_THRESHOLDS = {
  'SOL': 2.50, 'JTO': 2.50, 'WIF': 2.50, 'RAY': 2.50,
  'W': 2.00, 'PYTH': 2.50, 'RENDER': 2.50,
  'BONK': 3.50, 'MEW': 3.50, 'BOME': 3.50, 'ZEUS': 3.50,
  'PNUT': 3.50, 'GOAT': 3.50, 'PENGU': 4.50, 'TRUMP': 4.00,
  'DEFAULT': 3.50,
};
function getBuyDexThreshold(ccy) { return BUY_DEX_THRESHOLDS[ccy] || BUY_DEX_THRESHOLDS['DEFAULT']; }

const POLICY_SKIP_OKX   = ['TRUMP', 'POPCAT', 'BONK', 'JUP', 'BOME'];
const POLICY_SKIP_BYBIT = ['JUP', 'TRUMP', 'POPCAT', 'BONK', 'BOME'];

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

// ── Static trading pairs ──────────────────────────────────────────────────────
const PAIRS = [
  { name: 'SOL/USDT',    okxInstId: 'SOL-USDT',    bybitInstId: 'SOLUSDT',    outputMint: 'So11111111111111111111111111111111111111112',    decimals: 9,  dex: 'Raydium', isNative: true,  okxCcy: 'SOL',    okxChain: 'SOL-Solana',    bybitCcy: 'SOL',    bybitChain: 'SOL', buyDexEnabled: true  },
  { name: 'JTO/USDT',    okxInstId: 'JTO-USDT',    bybitInstId: 'JTOUSDT',    outputMint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',  decimals: 9,  dex: null,      isNative: false, okxCcy: 'JTO',    okxChain: 'JTO-Solana',    bybitCcy: 'JTO',    bybitChain: 'SOL', buyDexEnabled: true  },
  { name: 'WIF/USDT',    okxInstId: 'WIF-USDT',    bybitInstId: 'WIFUSDT',    outputMint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',  decimals: 6,  dex: 'Raydium', isNative: false, okxCcy: 'WIF',    okxChain: 'WIF-Solana',    bybitCcy: 'WIF',    bybitChain: 'SOL', buyDexEnabled: true  },
  { name: 'BONK/USDT',   okxInstId: 'BONK-USDT',   bybitInstId: 'BONKUSDT',   outputMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',  decimals: 5,  dex: null,      isNative: false, okxCcy: 'BONK',   okxChain: 'BONK-Solana',   bybitCcy: 'BONK',   bybitChain: 'SOL', buyDexEnabled: false },
  { name: 'JUP/USDT',    okxInstId: 'JUP-USDT',    bybitInstId: 'JUPUSDT',    outputMint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',   decimals: 6,  dex: null,      isNative: false, okxCcy: 'JUP',    okxChain: 'JUP-Solana',    bybitCcy: 'JUP',    bybitChain: 'SOL', buyDexEnabled: false },
  { name: 'PYTH/USDT',   okxInstId: 'PYTH-USDT',   bybitInstId: null,         outputMint: 'HZ1JovNiVvGqNLPQFZE5BsKs1Jvzd2Qqxe5bw3RVFHW',   decimals: 6,  dex: null,      isNative: false, okxCcy: 'PYTH',   okxChain: 'PYTH-Solana',   bybitCcy: null,     bybitChain: null,  buyDexEnabled: true  },
  { name: 'RAY/USDT',    okxInstId: 'RAY-USDT',    bybitInstId: null,         outputMint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',   decimals: 6,  dex: 'Raydium', isNative: false, okxCcy: 'RAY',    okxChain: 'RAY-Solana',    bybitCcy: null,     bybitChain: null,  buyDexEnabled: true  },
  { name: 'W/USDT',      okxInstId: 'W-USDT',      bybitInstId: 'WUSDT',      outputMint: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ',   decimals: 6,  dex: null,      isNative: false, okxCcy: 'W',      okxChain: 'W-Solana',      bybitCcy: 'W',      bybitChain: 'SOL', buyDexEnabled: true  },
  { name: 'POPCAT/USDT', okxInstId: 'POPCAT-USDT', bybitInstId: null,         outputMint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',   decimals: 9,  dex: null,      isNative: false, okxCcy: 'POPCAT', okxChain: 'POPCAT-Solana', bybitCcy: null,     bybitChain: null,  buyDexEnabled: false },
  { name: 'MEW/USDT',    okxInstId: 'MEW-USDT',    bybitInstId: 'MEWUSDT',    outputMint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5',    decimals: 5,  dex: null,      isNative: false, okxCcy: 'MEW',    okxChain: 'MEW-Solana',    bybitCcy: 'MEW',    bybitChain: 'SOL', buyDexEnabled: false },
  { name: 'BOME/USDT',   okxInstId: 'BOME-USDT',   bybitInstId: 'BOMEUSDT',   outputMint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',   decimals: 6,  dex: null,      isNative: false, okxCcy: 'BOME',   okxChain: 'BOME-Solana',   bybitCcy: 'BOME',   bybitChain: 'SOL', buyDexEnabled: false },
  { name: 'TRUMP/USDT',  okxInstId: 'TRUMP-USDT',  bybitInstId: 'TRUMPUSDT',  outputMint: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN',   decimals: 6,  dex: null,      isNative: false, okxCcy: 'TRUMP',  okxChain: 'TRUMP-Solana',  bybitCcy: 'TRUMP',  bybitChain: 'SOL', buyDexEnabled: true  },
  { name: 'ZEUS/USDT',   okxInstId: 'ZEUS-USDT',   bybitInstId: null,         outputMint: 'ZEUS1aR7aX8DFFkgutzZaBW51tvGc4GRsHcEUuRLJtb',    decimals: 6,  dex: null,      isNative: false, okxCcy: 'ZEUS',   okxChain: 'ZEUS-Solana',   bybitCcy: null,     bybitChain: null,  buyDexEnabled: false },
  { name: 'RENDER/USDT', okxInstId: 'RENDER-USDT', bybitInstId: 'RENDERUSDT', outputMint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof',    decimals: 8,  dex: null,      isNative: false, okxCcy: 'RENDER', okxChain: 'RENDER-Solana', bybitCcy: 'RENDER', bybitChain: 'SOL', buyDexEnabled: true  },
  { name: 'PNUT/USDT',   okxInstId: 'PNUT-USDT',   bybitInstId: 'PNUTUSDT',   outputMint: '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump',   decimals: 6,  dex: null,      isNative: false, okxCcy: 'PNUT',   okxChain: 'PNUT-Solana',   bybitCcy: 'PNUT',   bybitChain: 'SOL', buyDexEnabled: false },
  { name: 'GOAT/USDT',   okxInstId: 'GOAT-USDT',   bybitInstId: 'GOATUSDT',   outputMint: 'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump',   decimals: 6,  dex: null,      isNative: false, okxCcy: 'GOAT',   okxChain: 'GOAT-Solana',   bybitCcy: 'GOAT',   bybitChain: 'SOL', buyDexEnabled: false },
  { name: 'PENGU/USDT',  okxInstId: 'PENGU-USDT',  bybitInstId: 'PENGUUSDT',  outputMint: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv',   decimals: 6,  dex: null,      isNative: false, okxCcy: 'PENGU',  okxChain: 'PENGU-Solana',  bybitCcy: 'PENGU',  bybitChain: 'SOL', buyDexEnabled: true  },
];

// ── Files ─────────────────────────────────────────────────────────────────────
const STATE_FILE     = path.join(__dirname, 'arb-state.json');
const TRADE_LOG_FILE = path.join(__dirname, 'trade-log.json');
const TRADES_FILE    = path.join(__dirname, 'trades.json');
const CRASH_LOG      = path.join(__dirname, 'crash.log');
const NEW_PAIRS_FILE = path.join(__dirname, 'new-pairs.json');
const LOG_FILE       = path.join(__dirname, 'arb-log.json');
const FIRES_FILE     = path.join(__dirname, 'fires.json');

// ── Persistent state ──────────────────────────────────────────────────────────
function loadState() {
  for (const file of [STATE_FILE, STATE_FILE + '.bak']) {
    try {
      if (fs.existsSync(file)) {
        const s = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (file.endsWith('.bak')) console.warn('⚠️  Loaded from backup state file');
        console.log(`📂 Loaded state: ${s.totalTrades} trades | P&L ${s.totalProfit >= 0 ? '+' : ''}$${s.totalProfit.toFixed(4)} | Start: $${s.startCapital?.toFixed(2) || '?'}`);
        return s;
      }
    } catch (err) { console.warn(`State load error (${file}):`, err.message); }
  }
  return { totalProfit: 0, totalTrades: 0, winningTrades: 0, consecutiveWins: 0, consecutiveClean: 0, startCapital: null, pendingTrades: [] };
}

let saveLock = false;
async function saveState() {
  while (saveLock) await new Promise(r => setTimeout(r, 10));
  saveLock = true;
  try {
    const data = JSON.stringify({
      totalProfit, totalTrades, winningTrades, consecutiveWins, consecutiveClean, startCapital,
      pendingTrades: [...pendingDex, ...pendingOkx, ...pendingBybit],
      lastUpdated: new Date().toISOString(),
    }, null, 2);
    fs.writeFileSync(STATE_FILE, data);
    fs.writeFileSync(STATE_FILE + '.bak', data);
  } catch (err) { logCrash('saveState', err); }
  finally { saveLock = false; }
}

function logTrade(trade) {
  try {
    let trades = [];
    if (fs.existsSync(TRADES_FILE)) trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
    trades.push(trade);
    fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
    if (trade.direction !== 'RECOVERY') {
      totalTrades++;
      consecutiveClean++;
      saveState().catch(function(e) { logCrash('logTrade:saveState', e); });
    }
  } catch (err) { logCrash('logTrade', err); }
}

function logFire(fire) {
  try {
    let fires = [];
    if (fs.existsSync(FIRES_FILE)) fires = JSON.parse(fs.readFileSync(FIRES_FILE, 'utf8'));
    fires.push({ ...fire, date: fire.date || new Date().toISOString() });
    // Keep last 500 entries
    if (fires.length > 500) fires = fires.slice(-500);
    fs.writeFileSync(FIRES_FILE, JSON.stringify(fires, null, 2));
  } catch (err) { logCrash('logFire', err); }
}

function getPairStats() {
  try {
    if (!fs.existsSync(TRADES_FILE)) return {};
    const trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
    const stats  = {};
    for (const t of trades) {
      if (!stats[t.pair]) stats[t.pair] = { fires: 0, wins: 0, pnl: 0, spreads: [] };
      stats[t.pair].fires++;
      if (t.profit > 0) stats[t.pair].wins++;
      stats[t.pair].pnl += t.profit;
      if (t.spreadPct) stats[t.pair].spreads.push(t.spreadPct);
    }
    return stats;
  } catch { return {}; }
}

function logCrash(context, err) {
  const msg = `${new Date().toISOString()} [${context}] ${err?.message || err}\n${err?.stack || ''}\n\n`;
  try { fs.appendFileSync(CRASH_LOG, msg); } catch (e) {}
  console.error(`💥 [${context}]`, err?.message || err);
}

const _state        = loadState();
let totalProfit     = _state.totalProfit;
let totalTrades     = _state.totalTrades;
let winningTrades   = _state.winningTrades;
let consecutiveWins  = _state.consecutiveWins  || 0;
let consecutiveClean = _state.consecutiveClean || 0; // persistent until $240 scale
let startCapital    = _state.startCapital;

// ── Runtime state ─────────────────────────────────────────────────────────────
const okxPrices       = {};
const bybitPrices     = {};
const lastKnownPrice  = {};
const priceTimestamps = {};
let   lastReportTime  = 0;
let   consecutiveErrors = 0;
let   feedsReady      = false;

// ── OKX health ────────────────────────────────────────────────────────────────
let okxHealthy         = true;
let okxHealthLastCheck = 0;
let okxDownSince       = null;
const OKX_HEALTH_INTERVAL = 30_000;

async function checkOKXHealth() {
  try {
    const res = await Promise.race([
      fetch('https://www.okx.com/api/v5/public/time'),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000)),
    ]);
    const j = await res.json();
    const wasHealthy = okxHealthy;
    okxHealthy = j.code === '0';
    if (!wasHealthy && okxHealthy) {
      console.log('✅ OKX REST back online');
      const downSecs = okxDownSince ? Math.round((Date.now() - okxDownSince) / 1000) : 0;
      if (okxDownSince && downSecs > 300) {
        await sendAlert('✅ <b>OKX back online</b> — was down ' + Math.round(downSecs/60) + 'min');
      }
      okxDownSince = null;
    } else if (wasHealthy && !okxHealthy) {
      console.log('⚠️  OKX REST unreachable — pausing BUY_OKX');
      okxDownSince = Date.now();
    }
  } catch {
    const wasHealthy = okxHealthy;
    okxHealthy = false;
    if (wasHealthy) console.log('⚠️  OKX REST unreachable — pausing BUY_OKX');
  }
  okxHealthLastCheck = Date.now();
}

// ── Live config ───────────────────────────────────────────────────────────────
let liveConfig = {};
let lastConfigLoad = 0;

function loadLiveConfig() {
  try {
    const configFile = path.join(__dirname, 'arb-config.json');
    if (!fs.existsSync(configFile)) return;
    const mtime = fs.statSync(configFile).mtimeMs;
    if (mtime <= lastConfigLoad) return;
    lastConfigLoad = mtime;
    liveConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    console.log('📋 Config reloaded — skipOKX:', (liveConfig.POLICY_SKIP_OKX||[]).join(','), '| skipBybit:', (liveConfig.POLICY_SKIP_BYBIT||[]).join(','));
  } catch (err) { logCrash('loadLiveConfig', err); }
}

// ── Concurrent pending arrays ─────────────────────────────────────────────────
let pendingDex   = [];
let pendingOkx   = [];
let pendingBybit = [];
let executingDex   = false;
let executingOkx   = false;
let executingBybit = false;

function activeTradeCount() { return pendingDex.length + pendingOkx.length + pendingBybit.length; }
function activeTradeLabel() { const n = activeTradeCount(); return n === 0 ? '0 active' : `${n} active`; }
function removePending(type, tradeId) {
  if (type === 'dex')   pendingDex   = pendingDex.filter(t => t.tradeId !== tradeId);
  if (type === 'okx')   pendingOkx   = pendingOkx.filter(t => t.tradeId !== tradeId);
  if (type === 'bybit') pendingBybit = pendingBybit.filter(t => t.tradeId !== tradeId);
}

function isPairInFlight(okxCcy) {
  return [...pendingDex, ...pendingOkx, ...pendingBybit].some(t => t.symbol === okxCcy);
}

// ── Dynamic pairs ─────────────────────────────────────────────────────────────
let dynamicPairs         = [];
let lastDynamicPairsLoad = 0;
let okxWithdrawalInfo    = {};
let bybitWithdrawalInfo  = {};
let lastCoinRefresh      = 0;

async function loadDynamicPairs() {
  try {
    if (!fs.existsSync(NEW_PAIRS_FILE)) return;
    const mtime = fs.statSync(NEW_PAIRS_FILE).mtimeMs;
    if (mtime <= lastDynamicPairsLoad) return;
    lastDynamicPairsLoad = mtime;
    const text = fs.readFileSync(NEW_PAIRS_FILE, 'utf8');
    let loaded;
    try { loaded = JSON.parse(text); }
    catch (e) { console.warn('⚠️  new-pairs.json parse error'); return; }
    const now      = Date.now();
    const active   = loaded.filter(p => new Date(p.expiresAt).getTime() > now);
    const existing = new Set([...PAIRS, ...dynamicPairs].map(p => p.okxInstId));
    const brandNew = active.filter(p => !existing.has(p.okxInstId));
    if (brandNew.length > 0) {
      console.log(`\n🆕 Adding ${brandNew.length} dynamic pair(s)`);
      for (const pair of brandNew) await sendAlert(`🆕 <b>New pair active: ${pair.name}</b>`);
    }
    dynamicPairs = active;
  } catch (err) { logCrash('loadDynamicPairs', err); }
}

// ── Peak spread tracking ──────────────────────────────────────────────────────
const peakSpreads = {};
function updatePeakSpread(pairName, direction, spread) {
  if (spread <= 0) return;
  const key = `${pairName}:${direction}`;
  if (!peakSpreads[key] || spread > peakSpreads[key].spread)
    peakSpreads[key] = { spread, time: new Date().toLocaleTimeString() };
}
function getPeakSpreadsReport() {
  const entries = Object.entries(peakSpreads).filter(([, v]) => v.spread > 0).sort((a, b) => b[1].spread - a[1].spread).slice(0, 5);
  if (entries.length === 0) return 'No positive spreads this period';
  return entries.map(([key, v]) => {
    const pairName  = key.split(':')[0];
    const ccy       = pairName.split('/')[0];
    const direction = key.split(':')[1];
    const threshold = direction === 'BUY_DEX' ? getBuyDexThreshold(ccy) : MIN_SPREAD_CEX;
    const away      = Math.max(0, threshold - v.spread);
    const status    = v.spread >= threshold ? '🔥 FIRED' : `${away.toFixed(3)}% away`;
    return `${pairName} ${direction === 'BUY_DEX' ? '→CEX' : '→DEX'}: +${v.spread.toFixed(3)}% @ ${v.time} (${status})`;
  }).join('\n');
}
function resetPeakSpreads() { Object.keys(peakSpreads).forEach(k => delete peakSpreads[k]); }

// ── Approach Alert System ─────────────────────────────────────────────────────
const APPROACH_BANDS_DEFAULT = [
  { pct: 60, cooldown_min: 30 },
  { pct: 75, cooldown_min: 15 },
  { pct: 90, cooldown_min: 5  },
];
const bandState = {};

function isApproachActive() {
  const now     = new Date();
  const day     = now.getUTCDay();
  const hour    = now.getUTCHours();
  const isWeekend = day === 0 || day === 6;
  if (isWeekend) return liveConfig.WEEKEND_ALERTS !== false;
  const start = liveConfig.APPROACH_ACTIVE_WEEKDAY_START ?? 5;
  const end   = liveConfig.APPROACH_ACTIVE_WEEKDAY_END   ?? 15;
  return hour >= start && hour < end;
}

function getApproachBands() {
  const bands    = liveConfig.APPROACH_BANDS || APPROACH_BANDS_DEFAULT;
  const volatile = liveConfig.VOLATILE_MODE === true;
  const mult     = volatile ? (liveConfig.VOLATILE_BAND_MULTIPLIER ?? 0.8) : 1.0;
  return bands.map(b => ({ ...b, pct: Math.round(b.pct * mult) }));
}

function getBandKey(pairName, direction, bandIdx) { return `${pairName}:${direction}:${bandIdx}`; }

function shouldAlertBand(key, cooldown_min) {
  const last = bandState[key]?.lastAlertTime;
  if (!last) return true;
  return Date.now() - last > cooldown_min * 60 * 1000;
}

function markBandAlerted(key) {
  if (!bandState[key]) bandState[key] = {};
  bandState[key].lastAlertTime = Date.now();
}

function resetBandsBelow(pairName, direction, pct) {
  getApproachBands().forEach((b, i) => {
    if (pct < b.pct) { const key = getBandKey(pairName, direction, i); if (bandState[key]) delete bandState[key]; }
  });
}

function buildApproachBar(pct) {
  const filled = Math.min(10, Math.round(pct / 10));
  const empty  = 10 - filled;
  const block  = pct >= 90 ? '🟥' : pct >= 75 ? '🟧' : '🟨';
  return block.repeat(filled) + '⬜'.repeat(empty);
}

function resetAllBands() { Object.keys(bandState).forEach(k => delete bandState[k]); console.log('📡 Approach bands reset'); }

async function checkApproachAlerts(pairResults) {
  if (!isApproachActive()) return;
  const bands    = getApproachBands();
  const volatile = liveConfig.VOLATILE_MODE === true;
  for (const result of pairResults) {
    if (result.status !== 'fulfilled' || !result.value) continue;
    const r = result.value;
    const checks = [];
    if (r.okxViable && r.spreadOKX > 0)
      checks.push({ direction: 'BUY_OKX',   spread: r.spreadOKX,   threshold: MIN_SPREAD_CEX, pct: (r.spreadOKX   / MIN_SPREAD_CEX) * 100, est: r.estOKX   });
    if (r.bybit && r.bybitViable && r.spreadBybit > 0)
      checks.push({ direction: 'BUY_BYBIT', spread: r.spreadBybit, threshold: MIN_SPREAD_CEX, pct: (r.spreadBybit / MIN_SPREAD_CEX) * 100, est: r.estBybit });
    if (r.dexEnabled && r.spreadDex > 0)
      checks.push({ direction: 'BUY_DEX',   spread: r.spreadDex,   threshold: r.dexThresh,    pct: (r.spreadDex   / r.dexThresh)    * 100, est: r.estDex   });
    for (const check of checks) {
      const { direction, spread, threshold, pct, est } = check;
      resetBandsBelow(r.pair.name, direction, pct);
      if (pct >= 100 || isPairInFlight(r.pair.okxCcy)) continue;
      for (let i = bands.length - 1; i >= 0; i--) {
        const band = bands[i];
        if (pct >= band.pct) {
          const key = getBandKey(r.pair.name, direction, i);
          if (shouldAlertBand(key, band.cooldown_min)) {
            markBandAlerted(key);
            const bar    = buildApproachBar(pct);
            const estStr = est >= 0 ? `+${est.toFixed(2)}` : `-${Math.abs(est).toFixed(2)}`;
            const volTag = volatile ? ' 🟡' : '';
            await sendAlert(
              `📡 <b>${r.pair.name} — ${direction}</b>${volTag}
` +
              `Spread: ${spread.toFixed(3)}% → ${threshold}% needed
` +
              `${bar} ${pct.toFixed(0)}%
` +
              `Est if fired: ${estStr}`
            );
          }
          break;
        }
      }
    }
  }
}



// ── Daily log ─────────────────────────────────────────────────────────────────
function appendToLog(w, okxBals, bybitBal, peakReport) {
  try {
    const today   = new Date().toISOString().slice(0, 10);
    const hour    = new Date().getUTCHours();
    const min     = new Date().getUTCMinutes();
    const timeStr = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    const total   = w.usdc + okxBals.usdt + bybitBal;
    let log = {};
    if (fs.existsSync(LOG_FILE)) log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    if (!log[today]) log[today] = { open: { total, time: timeStr }, high: { total, time: timeStr }, low: { total, time: timeStr }, close: { total, time: timeStr }, trades: 0, wins: 0, pnl: 0, reports: [] };
    const day = log[today];
    if (total > day.high.total) day.high = { total, time: timeStr };
    if (total < day.low.total)  day.low  = { total, time: timeStr };
    day.close = { total, time: timeStr };
    day.trades = totalTrades; day.wins = winningTrades; day.pnl = totalProfit;
    day.reports.push({ time: timeStr, solanaUsdc: parseFloat(w.usdc.toFixed(2)), okxUsdt: parseFloat(okxBals.usdt.toFixed(2)), bybitUsdt: parseFloat(bybitBal.toFixed(2)), total: parseFloat(total.toFixed(2)), trades: totalTrades, pnl: parseFloat(totalProfit.toFixed(4)), peaks: peakReport });
    fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
  } catch (err) { logCrash('appendToLog', err); }
}

let lastMorningReportDate = '';

async function sendMorningReport(force = false) {
  try {
    const now  = new Date();
    const date = now.toISOString().slice(0, 10);
    if (!force && lastMorningReportDate === date) return;
    lastMorningReportDate = date;

    const yesterday = new Date(now - 86400000).toISOString().slice(0, 10);
    let log = {};
    if (fs.existsSync(LOG_FILE)) log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    const day = log[yesterday] || {};

    // Balances
    const w        = await getWalletBalances().catch(() => ({ usdc: 0, sol: 0 }));
    const okxBals  = await getOKXBalances().catch(() => ({ usdt: 0 }));
    const bybitBal = await getBybitBalance('USDT').catch(() => 0);
    const total    = w.usdc + okxBals.usdt + bybitBal;
    const gain     = total - (startCapital || total);
    const gainPct  = startCapital ? ((gain / startCapital) * 100).toFixed(2) : '0';

    // Fires from last 24hrs
    let fires24 = [];
    if (fs.existsSync(FIRES_FILE)) {
      const allFires = JSON.parse(fs.readFileSync(FIRES_FILE, 'utf8'));
      const since    = Date.now() - 86400000;
      fires24        = allFires.filter(f => new Date(f.date).getTime() > since);
    }

    const fired    = fires24.filter(f => f.outcome === 'fired');
    const success  = fires24.filter(f => f.outcome === 'success');
    const losses   = fires24.filter(f => f.outcome === 'loss');
    const failed   = fires24.filter(f => f.outcome === 'failed');
    const pnl24    = [...success, ...losses].reduce((s, f) => s + (f.profit || 0), 0);

    // Fire summary — compact for Telegram 4096 char limit
    const fireSum = `Fired: ${fired.length} | ✅ ${success.length} win | ⚠️ ${losses.length} loss | ❌ ${failed.length} fail`;
    const recentFires = fires24.slice(-10).map(f => {
      const time   = new Date(f.date).toUTCString().slice(17, 22);
      const dir    = (f.direction || '').replace('BUY_', '').padEnd(5);
      const pair   = (f.pair || '').replace('/USDT', '').padEnd(6);
      const status = f.outcome === 'success' ? `+$${(f.profit||0).toFixed(2)}` :
                     f.outcome === 'loss'    ? `-$${Math.abs(f.profit||0).toFixed(2)}` :
                     f.outcome === 'failed'  ? `❌ ${(f.reason||'').slice(0,20)}` : '🔫';
      return `${time} ${dir} ${pair} ${status}`;
    }).join('\n') || 'None';

    // Top spreads yesterday
    const peakLines = (day.reports || [])
      .flatMap(r => (r.peaks || '').split('\n'))
      .filter(Boolean)
      .slice(0, 5)
      .join('\n') || 'No data';

    // Config
    const skipOKX   = (liveConfig.POLICY_SKIP_OKX   || POLICY_SKIP_OKX).join(', ');
    const skipBybit = (liveConfig.POLICY_SKIP_BYBIT  || POLICY_SKIP_BYBIT).join(', ');
    const smartSell = liveConfig.SMART_SELL !== false ? 'ON' : 'OFF';
    const volatile  = liveConfig.VOLATILE_MODE ? 'ON 🟡' : 'OFF';
    const winsBar   = '🟢'.repeat(consecutiveWins)  + '⚪'.repeat(Math.max(0, WINS_TARGET - consecutiveWins));
    const cleanBar2 = '✅'.repeat(consecutiveClean) + '⬜'.repeat(Math.max(0, WINS_TARGET - consecutiveClean));

    // Warnings
    const warnings = [];
    if (bybitBal < TRADE_SIZE_USD * 1.05) warnings.push(`⚠️ Bybit low: $${bybitBal.toFixed(0)} (min $${Math.ceil(TRADE_SIZE_USD * 1.05)})`);
    if (w.usdc < TRADE_SIZE_USD)           warnings.push(`⚠️ Solana low: $${w.usdc.toFixed(0)}`);
    if (okxBals.usdt < BALANCE_FLOOR_USDT) warnings.push(`⚠️ OKX low: $${okxBals.usdt.toFixed(0)}`);
    if (!okxHealthy)                       warnings.push('🔴 OKX offline');
    if (consecutiveWins === 0 && totalTrades > 5) warnings.push('⚠️ No consecutive wins — check thresholds');
    const warnStr = warnings.length > 0 ? '\n⚠️ <b>Warnings</b>\n' + warnings.join('\n') : '';

    const dayStr = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

    await sendAlert(
      `🌅 <b>Morning Report — ${dayStr}</b>\n\n` +
      `💰 $${total.toFixed(0)} | ${gain >= 0 ? '+' : ''}$${gain.toFixed(2)} (${gainPct}%)\n` +
      `Sol:$${w.usdc.toFixed(0)} OKX:$${okxBals.usdt.toFixed(0)} By:$${bybitBal.toFixed(0)}\n\n` +
      `📊 ${totalTrades} trades | ${winningTrades}W | P&L:${totalProfit >= 0 ? '+' : ''}$${totalProfit.toFixed(2)}\n` +
      `🏆 Clean: ${cleanBar2} ${consecutiveClean}/${WINS_TARGET}\n` +
      `🎯 Wins:  ${winsBar} ${consecutiveWins}/${WINS_TARGET}\n\n` +
      `📈 24hrs: ${fireSum}\n` +
      `<code>${recentFires}</code>\n\n` +
      `🔥 Spreads:\n${peakLines}\n\n` +
      `⚙️ $${TRADE_SIZE_USD} | SmartSell:${smartSell} | Vol:${volatile}` +
      ((() => {
        try {
          const simFile = require('path').join(__dirname, 'sim-trades.json');
          if (!require('fs').existsSync(simFile)) return '';
          const sims = JSON.parse(require('fs').readFileSync(simFile, 'utf8'));
          const since = Date.now() - 86400000;
          const day = sims.filter(s => new Date(s.date).getTime() > since);
          if (!day.length) return '';
          const simPnl = day.reduce((a, s) => a + (s.profit || 0), 0);
          const simW   = day.filter(s => s.profit > 0).length;
          return '\n\n🔵 [SIM] Kraken 24hrs: ' + day.length + ' trades | ' + simW + 'W | P&L:' + (simPnl >= 0 ? '+' : '') + '$' + simPnl.toFixed(2);
        } catch { return ''; }
      })()) +
      warnStr
    );
  } catch (err) { logCrash('sendMorningReport', err); }
}

async function maybeSendDailySummary() {
  const now  = new Date();
  const hour = now.getUTCHours();
  const min  = now.getUTCMinutes();
  if (hour === 7 && min < 2) await sendMorningReport();
}



// ── TradeLogger — forensic per-trade event log ───────────────────────────────
class TradeLogger {
  constructor(tradeId, pair, direction, spreadPct, tradeSizeUsd) {
    this.tradeId      = tradeId;
    this.pair         = pair;
    this.direction    = direction;
    this.spreadPct    = spreadPct;
    this.tradeSizeUsd = tradeSizeUsd;
    this.startMs      = Date.now();
    this.events       = [];
    this.balanceBefore = null;
    this._log('TRADE_START', `${direction} ${pair} spread:${spreadPct.toFixed(3)}% size:$${tradeSizeUsd}`);
  }

  _log(event, detail, extra = {}) {
    const ms = Date.now();
    const entry = { ms, t: new Date(ms).toISOString(), event, detail, ...extra };
    this.events.push(entry);
    console.log(`  [${this.tradeId}] ${entry.t.slice(11,23)} ${event} — ${detail}`);
    return entry;
  }

  log(event, detail, extra = {}) {
    return this._log(event, detail, extra);
  }

  async apiCall(label, fn) {
    const start = Date.now();
    this._log('API_CALL', label);
    try {
      const result  = await fn();
      const latMs   = Date.now() - start;
      this._log('API_RESP', `OK ${label}`, { latencyMs: latMs });
      return result;
    } catch (err) {
      const latMs = Date.now() - start;
      this._log('API_RESP', `FAIL ${label}: ${err.message.slice(0, 120)}`, { latencyMs: latMs, error: err.message });
      throw err;
    }
  }

  async wait(ms, reason) {
    this._log('WAIT', `${ms}ms — ${reason}`);
    await new Promise(r => setTimeout(r, ms));
  }

  setBalanceBefore(balances) {
    this.balanceBefore = balances;
    this._log('BALANCE_SNAP', `before — Sol:$${balances.solana?.toFixed(2)} OKX:$${balances.okx?.toFixed(2)} By:$${balances.bybit?.toFixed(2)}`);
  }

  balanceSnap(label, balances) {
    this._log('BALANCE_SNAP', `${label} — Sol:$${balances.solana?.toFixed(2)} OKX:$${balances.okx?.toFixed(2)} By:$${balances.bybit?.toFixed(2)}`);
  }

  pollEvent(label, found, elapsed) {
    this._log('POLL', `${label} — ${found ? 'FOUND' : 'waiting'} (${elapsed}s elapsed)`);
  }

  complete(pnl, usdcOut, durationMin, extra = {}) {
    this._log('TRADE_COMPLETE', `P&L:${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)} usdcOut:$${usdcOut.toFixed(4)} dur:${durationMin}min`);
    this._write('success', { pnl, usdcOut, durationMin, ...extra });
  }

  fail(reason, fundsRecovered = false, failedAt = '', extra = {}) {
    this._log('TRADE_FAIL', `failedAt:${failedAt} fundsRecovered:${fundsRecovered} reason:${reason.slice(0, 120)}`);
    this._write('failed', { failedAt, fundsRecovered, error: reason, ...extra });
  }

  _write(outcome, extra = {}) {
    try {
      const entry = {
        tradeId:      this.tradeId,
        pair:         this.pair,
        direction:    this.direction,
        spreadPct:    this.spreadPct,
        tradeSizeUsd: this.tradeSizeUsd,
        startMs:      this.startMs,
        startTime:    new Date(this.startMs).toISOString(),
        durationMs:   Date.now() - this.startMs,
        outcome,
        balanceBefore: this.balanceBefore,
        events:       this.events,
        ...extra,
      };
      let log = [];
      if (fs.existsSync(TRADE_LOG_FILE)) {
        try { log = JSON.parse(fs.readFileSync(TRADE_LOG_FILE, 'utf8')); } catch {}
      }
      log = [...log.filter(t => t.tradeId !== this.tradeId), entry].slice(-200);
      fs.writeFileSync(TRADE_LOG_FILE, JSON.stringify(log, null, 2));
    } catch (err) { logCrash('TradeLogger._write', err); }
  }
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendAlert(message) {
  try {
    const token  = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
    });
  } catch (err) { logCrash('sendAlert', err); }
}

// ── Trade Context — single summary message per trade ─────────────────────────
class TradeContext {
  constructor(tradeId, pair, direction, spreadPct, exchange) {
    this.tradeId   = tradeId;
    this.pair      = pair;
    this.direction = direction;
    this.spreadPct = spreadPct;
    this.exchange  = exchange;
    this.symbol    = pair.name.split('/')[0];
    this.startTime = Date.now();
    this.events    = [];
    this.status    = 'running';
  }

  log(msg) {
    console.log(`  [${this.tradeId}] ${msg}`);
    this.events.push(msg);
  }

  async complete({ profit, usdcOut, tokenAmount, durationMin }) {
    this.status = 'complete';
    const won      = profit >= 0;
    const pnlStr   = `${won ? '+' : ''}$${profit.toFixed(4)}`;
    const winsBar   = '🟢'.repeat(consecutiveWins)  + '⚪'.repeat(Math.max(0, WINS_TARGET - consecutiveWins));
    const cleanBar  = '✅'.repeat(consecutiveClean) + '⬜'.repeat(Math.max(0, WINS_TARGET - consecutiveClean));
    const w        = await getWalletBalances().catch(() => ({ usdc: 0 }));
    const okxBal   = await getOKXBalances().catch(() => ({ usdt: 0 }));
    const bybitBal = await getBybitBalance().catch(() => 0);
    const total    = w.usdc + okxBal.usdt + bybitBal;

    logFire({ tradeId: this.tradeId, pair: this.pair.name, direction: this.direction, exchange: this.exchange, spreadPct: this.spreadPct, outcome: won ? 'success' : 'loss', profit, fundsAffected: false });
    await sendAlert(
      `${won ? '✅' : '⚠️'} <b>TRADE ${won ? 'COMPLETE' : 'COMPLETE (loss)'} — ${this.direction} ${this.pair.name}</b>\n` +
      `Spread: ${this.spreadPct.toFixed(3)}% | Exchange: ${this.exchange} | ${durationMin}min\n` +
      `${tokenAmount.toFixed(4)} ${this.symbol} → $${usdcOut.toFixed(2)} USDC\n` +
      `<b>P&L: ${pnlStr}</b>\n\n` +
      `🎯 Wins: ${winsBar} ${consecutiveWins}/${WINS_TARGET}\n` +
      `💰 Total: $${total.toFixed(2)} | OKX:$${okxBal.usdt.toFixed(0)} By:$${bybitBal.toFixed(0)} Sol:$${w.usdc.toFixed(0)}\n` +
      `📊 ${totalTrades} trades | P&L: ${totalProfit >= 0 ? '+' : ''}$${totalProfit.toFixed(2)}`
    );
    if (consecutiveWins >= WINS_TARGET) await sendAlert(`🚀 <b>${WINS_TARGET} consecutive wins!</b> Ready to scale.`);
  }

  async fail({ reason, fundsAffected = false, autoFixed = null }) {
    this.status = 'failed';
    logFire({ tradeId: this.tradeId, pair: this.pair.name, direction: this.direction, exchange: this.exchange, spreadPct: this.spreadPct, outcome: 'failed', reason, fundsAffected });
    const fundsStr = fundsAffected ? '⚠️ Funds may be affected — check exchanges' : '✅ No funds affected';
    const fixStr   = autoFixed ? `\n🤖 Auto-fixed: ${autoFixed}` : '\n⚠️ Manual check may be needed';
    await sendAlert(
      `❌ <b>TRADE FAILED — ${this.direction} ${this.pair.name}</b>\n` +
      `Reason: ${reason}\n` +
      `${fundsStr}${fixStr}\n\n` +
      `📊 ${activeTradeLabel()} | P&L: ${totalProfit >= 0 ? '+' : ''}$${totalProfit.toFixed(2)}`
    );
  }

  async alert(msg) {
    // Only urgent mid-trade alerts — withdrawal failures, leg A failures
    await sendAlert(`⚡ <b>${this.direction} ${this.symbol}</b> [${this.tradeId}]\n${msg}`);
  }
}

// ── OKX API ───────────────────────────────────────────────────────────────────
function okxSign(ts, method, path, body = '') {
  return crypto.createHmac('sha256', process.env.OKX_API_SECRET).update(ts + method + path + body).digest('base64');
}
function okxHeaders(method, path, body = '') {
  const ts = new Date().toISOString();
  return { 'Content-Type': 'application/json', 'OK-ACCESS-KEY': process.env.OKX_API_KEY, 'OK-ACCESS-SIGN': okxSign(ts, method, path, body), 'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': process.env.OKX_PASSPHRASE };
}
async function okxPrivate(method, path, body = null) {
  const bodyStr = body ? JSON.stringify(body) : '';
  const res = await fetch(`https://www.okx.com${path}`, { method, headers: okxHeaders(method, path, bodyStr), body: bodyStr || undefined });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`OKX API non-JSON: ${text.slice(0, 100)}`); }
}

// ── Bybit API ─────────────────────────────────────────────────────────────────
async function bybitPrivate(method, path, params = {}) {
  const ts = Date.now().toString(), rw = '5000', BASE = 'https://api.bybit.com';
  let res;
  if (method === 'GET') {
    const qs  = new URLSearchParams(params).toString();
    const sig = crypto.createHmac('sha256', process.env.BYBIT_API_SECRET).update(ts + process.env.BYBIT_API_KEY + rw + qs).digest('hex');
    res = await fetch(`${BASE}${path}?${qs}`, { headers: { 'X-BAPI-API-KEY': process.env.BYBIT_API_KEY, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-SIGN': sig, 'X-BAPI-RECV-WINDOW': rw } });
  } else {
    const bodyStr = JSON.stringify(params);
    const sig     = crypto.createHmac('sha256', process.env.BYBIT_API_SECRET).update(ts + process.env.BYBIT_API_KEY + rw + bodyStr).digest('hex');
    res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'X-BAPI-API-KEY': process.env.BYBIT_API_KEY, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-SIGN': sig, 'X-BAPI-RECV-WINDOW': rw, 'Content-Type': 'application/json' }, body: bodyStr });
  }
  const text = await res.text();
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`Bybit API non-JSON: ${text.slice(0, 100)}`); }
}

// ── Viability refresh ─────────────────────────────────────────────────────────
async function refreshOKXViability() {
  console.log('\n🔄 Refreshing OKX viability...');
  const allPairs = [...PAIRS, ...dynamicPairs];
  const ccys     = [...new Set(allPairs.map(p => p.okxCcy).filter(Boolean))];
  const newInfo  = {}, skipped = [], viable = [];
  for (const ccy of ccys) {
    try {
      const r   = await okxPrivate('GET', `/api/v5/asset/currencies?ccy=${ccy}`);
      const sol = (r.data || []).find(d => d.chain?.includes('Solana'));
      if (!sol) { newInfo[ccy] = { viable: false }; skipped.push(ccy); continue; }
      const fee = parseFloat(sol.minFee), minWd = parseFloat(sol.minWd), precision = parseInt(sol.wdTickSz) || 8;
      const ticker = okxPrices[`${ccy}-USDT`];
      let price = ticker ? (ticker.bid + ticker.ask) / 2 : 0;
      if (!price) { try { const pr = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${ccy}-USDT`); const pj = await pr.json(); price = parseFloat(pj.data?.[0]?.last || '0'); } catch { /* ignore */ } }
      const boughtAmt = price > 0 ? TRADE_SIZE_USD / price : 0;
      const feePct    = boughtAmt > 0 ? (fee / boughtAmt) * 100 : 999;
      const isViable  = !isOKXViable_skip(ccy) && boughtAmt >= minWd && feePct <= MAX_WITHDRAWAL_FEE_PCT;
      newInfo[ccy] = { viable: isViable, fee: fee.toString(), precision, minWd, feePct: parseFloat(feePct.toFixed(2)) };
      if (isViable) viable.push(`${ccy} (${feePct.toFixed(1)}%)`); else skipped.push(ccy);
    } catch (err) { logCrash(`refreshOKX:${ccy}`, err); newInfo[ccy] = { viable: false }; }
    await new Promise(r => setTimeout(r, 300));
  }
  okxWithdrawalInfo = newInfo;
  console.log(`  ✅ OKX viable: ${viable.join(', ')}`);
  return { viable, skipped };
}

async function refreshBybitViability() {
  console.log('\n🔄 Refreshing Bybit viability...');
  if (!process.env.BYBIT_API_KEY) return { viable: [], skipped: [] };
  const allPairs = [...PAIRS, ...dynamicPairs];
  const ccys     = [...new Set(allPairs.filter(p => p.bybitCcy).map(p => p.bybitCcy))];
  const newInfo  = {}, skipped = [], viable = [];
  for (const ccy of ccys) {
    try {
      const r      = await bybitPrivate('GET', '/v5/asset/coin/query-info', { coin: ccy });
      const chains = r.result?.rows?.[0]?.chains || [];
      const sol    = chains.find(c => c.chain === 'SOL' || c.chainType?.includes('Solana'));
      if (!sol) { newInfo[ccy] = { viable: false }; skipped.push(ccy); continue; }
      const fee = parseFloat(sol.withdrawFee || '0'), minWd = parseFloat(sol.minWithdraw || '0');
      const pair   = allPairs.find(p => p.bybitCcy === ccy);
      const ticker = pair?.bybitInstId ? bybitPrices[pair.bybitInstId] : null;
      let price = ticker ? (ticker.bid + ticker.ask) / 2 : 0;
      if (!price) { try { const pr = await fetch(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${ccy}USDT`); const pj = await pr.json(); price = parseFloat(pj.result?.list?.[0]?.lastPrice || '0'); } catch { /* ignore */ } }
      const boughtAmt = price > 0 ? TRADE_SIZE_USD / price : 0;
      const feePct    = boughtAmt > 0 ? (fee / boughtAmt) * 100 : 999;
      const isViable  = !isBybitViable_skip(ccy) && boughtAmt >= minWd && feePct <= MAX_WITHDRAWAL_FEE_PCT;
      newInfo[ccy] = { viable: isViable, fee: fee.toString(), precision: 6, minWd, feePct: parseFloat(feePct.toFixed(2)) };
      if (isViable) viable.push(`${ccy} (${feePct.toFixed(1)}%)`); else skipped.push(ccy);
    } catch (err) { logCrash(`refreshBybit:${ccy}`, err); newInfo[ccy] = { viable: false }; }
    await new Promise(r => setTimeout(r, 300));
  }
  bybitWithdrawalInfo = newInfo;
  console.log(`  ✅ Bybit viable: ${viable.join(', ')}`);
  return { viable, skipped };
}

async function refreshCoinViability() {
  const okx = await refreshOKXViability(), bybit = await refreshBybitViability();
  lastCoinRefresh = Date.now();
  console.log(`🔄 Viability: OKX [${okx.viable.map(v=>v.split(' ')[0]).join(',')||'none'}] Bybit [${bybit.viable.map(v=>v.split(' ')[0]).join(',')||'none'}]`);
}

function isOKXViable_skip(ccy)   { const skip = liveConfig.POLICY_SKIP_OKX   || POLICY_SKIP_OKX;   return skip.includes(ccy); }
function isBybitViable_skip(ccy) { const skip = liveConfig.POLICY_SKIP_BYBIT || POLICY_SKIP_BYBIT; return skip.includes(ccy); }
function isOKXViable(ccy)   { return !isOKXViable_skip(ccy)   && okxWithdrawalInfo[ccy]?.viable === true; }
function isBybitViable(ccy) { return !isBybitViable_skip(ccy) && bybitWithdrawalInfo[ccy]?.viable === true; }
function getOKXFee(ccy)     { return okxWithdrawalInfo[ccy]?.fee || '0.1'; }
function getBybitFee(ccy)   { return bybitWithdrawalInfo[ccy]?.fee || '0.5'; }
function getOKXPrecision(ccy)   { return okxWithdrawalInfo[ccy]?.precision || 8; }
function getBybitPrecision(ccy) { return bybitWithdrawalInfo[ccy]?.precision || 6; }
function fmtOKX(amount, ccy)   { return parseFloat(amount.toFixed(getOKXPrecision(ccy))).toString(); }
function fmtBybit(amount, ccy) { return parseFloat(amount.toFixed(getBybitPrecision(ccy))).toString(); }

// ── OKX balance helpers ───────────────────────────────────────────────────────
async function getOKXBalances()             { const r = await okxPrivate('GET', '/api/v5/account/balance'); const d = r.data?.[0]?.details || []; return { usdt: parseFloat(d.find(x => x.ccy === 'USDT')?.availBal || '0') }; }
async function getOKXFundingBal(ccy='USDT') { const r = await okxPrivate('GET', `/api/v5/asset/balances?ccy=${ccy}`); return parseFloat(r.data?.[0]?.availBal || '0'); }
async function getOKXTokenBal(ccy)          { const r = await okxPrivate('GET', '/api/v5/account/balance'); const d = r.data?.[0]?.details || []; return parseFloat(d.find(x => x.ccy === ccy)?.availBal || '0'); }
async function getOKXAllBalances()          { const r = await okxPrivate('GET', '/api/v5/account/balance'); return r.data?.[0]?.details || []; }

async function moveFundingToTrading() {
  try {
    const bal = await getOKXFundingBal('USDT');
    if (bal < 1) return 0;
    const res = await okxPrivate('POST', '/api/v5/asset/transfer', { ccy: 'USDT', amt: bal.toFixed(2), from: '6', to: '18', type: '0' });
    if (res.code === '0') { console.log(`  ✅ Moved $${bal.toFixed(2)} OKX funding → trading`); return bal; }
    return 0;
  } catch (err) { logCrash('moveFundingToTrading', err); return 0; }
}

async function getOKXDepositAddress(ccy, chain) {
  const r = await okxPrivate('GET', `/api/v5/asset/deposit-address?ccy=${ccy}`);
  if (r.code !== '0') throw new Error(`OKX deposit address failed: ${r.msg}`);
  const match = (r.data || []).find(a => a.chain === chain);
  if (!match) throw new Error(`No ${chain} deposit address for ${ccy}`);
  return match.addr;
}

async function withdrawFromOKX(ccy, chain, grossAmount) {
  console.log(`  📤 OKX withdrawal: ${grossAmount} ${ccy} chain:${chain}...`);
  const transferAmt = parseFloat(grossAmount).toString();
  let transferRes;
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 3000));
    transferRes = await okxPrivate('POST', '/api/v5/asset/transfer', { ccy, amt: transferAmt, from: '18', to: '6', type: '0' });
    if (transferRes.code === '0') break;
    console.log(`  ⚠️  Transfer attempt ${i+1}/5: ${transferRes.msg}`);
  }
  if (transferRes.code !== '0') throw new Error(`OKX transfer failed: ${transferRes.msg}`);
  let fundingBal = 0;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 5000));
    fundingBal = await getOKXFundingBal(ccy);
    if (fundingBal >= parseFloat(grossAmount) * 0.99) break;
  }
  await new Promise(r => setTimeout(r, 20000));
  const fee    = getOKXFee(ccy);
  const netAmt = fmtOKX(parseFloat(grossAmount) - parseFloat(fee), ccy);
  const result = await okxPrivate('POST', '/api/v5/asset/withdrawal', { ccy, amt: netAmt, dest: '4', toAddr: wallet.publicKey.toString(), fee, chain });
  if (result.code !== '0') {
    try { await okxPrivate('POST', '/api/v5/asset/transfer', { ccy, amt: transferAmt, from: '6', to: '18', type: '0' }); } catch { /* ignore */ }
    throw new Error(`OKX withdrawal error: ${result.msg} (${result.code})`);
  }
  return result.data?.[0]?.wdId;
}

// ── Bybit balance helpers ─────────────────────────────────────────────────────
async function getBybitBalance(ccy='USDT') {
  try {
    if (!process.env.BYBIT_API_KEY) return 0;
    const r = await bybitPrivate('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED', coin: ccy });
    return parseFloat(r.result?.list?.[0]?.coin?.find(c => c.coin === ccy)?.walletBalance || '0');
  } catch { return 0; }
}

async function getBybitAllBalances() {
  try {
    const r = await bybitPrivate('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
    return r.result?.list?.[0]?.coin || [];
  } catch { return []; }
}

async function placeBybitOrder(side, qty, symbol, quoteQty = null) {
  const params = { category: 'spot', symbol, side: side === 'buy' ? 'Buy' : 'Sell', orderType: 'Market', timeInForce: 'IOC' };
  if (side === 'buy' && quoteQty) {
    params.marketUnit = 'quoteCoin';
    params.qty = String(quoteQty);
  } else {
    params.qty = String(qty);
  }
  const r = await bybitPrivate('POST', '/v5/order/create', params);
  if (r.retCode !== 0) throw new Error(`Bybit order error: ${r.retMsg}`);
  return r.result?.orderId;
}

async function withdrawFromBybit(ccy, chain, grossAmount) {
  const fee    = getBybitFee(ccy);
  const netAmt = fmtBybit(parseFloat(grossAmount) - parseFloat(fee), ccy);
  const r = await bybitPrivate('POST', '/v5/asset/withdraw/create', { coin: ccy, chain, address: wallet.publicKey.toString(), amount: netAmt, timestamp: Date.now() });
  if (r.retCode !== 0) throw new Error(`Bybit withdrawal error: ${r.retMsg}`);
  return r.result?.id;
}

async function getBybitDepositAddress(ccy) {
  try { const r = await bybitPrivate('GET', '/v5/asset/deposit/query-address', { coin: ccy, chainType: 'SOL' }); return r.result?.chains?.[0]?.addressDeposit; }
  catch { return null; }
}

// ── Solana helpers ────────────────────────────────────────────────────────────
async function getTokenBalance(mint, isNative = false) {
  if (isNative) return (await connection.getBalance(wallet.publicKey)) / 1e9;
  try { const ata = await getAssociatedTokenAddress(new PublicKey(mint), wallet.publicKey); return Number((await getAccount(connection, ata)).amount); }
  catch { return 0; }
}

async function getWalletBalances() {
  const lamports = await connection.getBalance(wallet.publicKey);
  let usdc = 0;
  try { const ata = await getAssociatedTokenAddress(new PublicKey(USDC_MINT), wallet.publicKey); usdc = Number((await getAccount(connection, ata)).amount) / 1e6; } catch { /* no USDC */ }
  return { sol: lamports / 1e9, usdc };
}

async function sendTokenToAddress(pair, rawAmount, depositAddress) {
  const destPubkey = new PublicKey(depositAddress);
  const mint       = new PublicKey(pair.outputMint);
  const fromAta    = await getAssociatedTokenAddress(mint, wallet.publicKey);
  const toAta      = await getAssociatedTokenAddress(mint, destPubkey);
  const tx         = new Transaction();
  try { await getAccount(connection, toAta); } catch { tx.add(createAssociatedTokenAccountInstruction(wallet.publicKey, toAta, destPubkey, mint)); }
  tx.add(createTransferInstruction(fromAta, toAta, wallet.publicKey, rawAmount));
  const sig = await connection.sendTransaction(tx, [wallet]);
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

// ── Slippage helpers ──────────────────────────────────────────────────────────
function isSlippageError(err) {
  return err.message?.includes('0x1771') || err.message?.includes('custom program error') ||
         err.message?.includes('SlippageToleranceExceeded') || err.message?.includes('slippage') ||
         err.message?.includes('Simulation failed') || err.message?.includes('No quote');
}

// ── Jupiter quote + swap ──────────────────────────────────────────────────────
async function getQuote(inputMint, outputMint, amount, isRawAmount = false, dex = null) {
  const rawAmount = isRawAmount ? Math.floor(amount) : Math.floor(amount * 1e6);
  let url = `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${rawAmount}&slippageBps=100`;
  if (dex) url += `&dexes=${dex}`;
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'x-api-key': process.env.JUPITER_API_KEY } });
    clearTimeout(timeout);
    if (res.status === 429) { await new Promise(r => setTimeout(r, 10000)); return getQuote(inputMint, outputMint, amount, isRawAmount, dex); }
    return res.json();
  } catch (err) { clearTimeout(timeout); if (err.name === 'AbortError') throw new Error('Quote timed out'); throw err; }
}

async function jupiterSwapRaw(inputMint, outputMint, rawAmount, slippageBps = 300) {
  const qr = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${rawAmount}&slippageBps=${slippageBps}`, { headers: { 'x-api-key': process.env.JUPITER_API_KEY } });
  const quote = await qr.json();
  if (!quote.outAmount) throw new Error('No quote');
  const sr = await fetch('https://api.jup.ag/swap/v1/swap', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.JUPITER_API_KEY }, body: JSON.stringify({ quoteResponse: quote, userPublicKey: wallet.publicKey.toString(), wrapAndUnwrapSol: true, dynamicSlippage: true, prioritizationFeeLamports: 200_000 }) });
  const swapJson = await sr.json();
  if (swapJson.error || !swapJson.swapTransaction) throw new Error(`Swap failed: ${swapJson.error || 'no transaction'}`);
  const tx = VersionedTransaction.deserialize(Buffer.from(swapJson.swapTransaction, 'base64'));
  tx.sign([wallet]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: MAX_RETRIES });
  await connection.confirmTransaction(sig, 'confirmed');
  return { sig, outAmount: quote.outAmount };
}

// ── RECOVERY: Solana wallet ───────────────────────────────────────────────────
async function recoverSolanaTokens() {
  console.log('\n🔍 Recovery: scanning Solana wallet for unexpected tokens...');
  const allPairs = [...PAIRS, ...dynamicPairs];
  const recovered = [];
  for (const pair of allPairs) {
    if (pair.isNative || pair.outputMint === USDC_MINT || pair.outputMint === USDT_MINT) continue;
    if (isPairInFlight(pair.okxCcy)) { console.log(`  ⏭  ${pair.okxCcy}: trade in flight — skipping`); continue; }
    try {
      const rawBal = await getTokenBalance(pair.outputMint, false);
      if (rawBal <= 0) continue;
      const tokenAmt = rawBal / Math.pow(10, pair.decimals);
      const qr = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${pair.outputMint}&outputMint=${USDC_MINT}&amount=${Math.floor(rawBal)}&slippageBps=300`, { headers: { 'x-api-key': process.env.JUPITER_API_KEY } });
      const quote = await qr.json();
      const usdEst = quote.outAmount ? quote.outAmount / 1e6 : 0;
      if (usdEst < DUST_USD_THRESHOLD) { console.log(`  🔸 ${pair.okxCcy}: ${tokenAmt.toFixed(4)} (~$${usdEst.toFixed(2)}) — dust, skipping`); continue; }
      console.log(`  ⚠️  ${pair.okxCcy}: found ${tokenAmt.toFixed(4)} (~$${usdEst.toFixed(2)}) — auto-swapping to USDC`);
      const { outAmount } = await jupiterSwapRaw(pair.outputMint, USDC_MINT, Math.floor(rawBal));
      const usdcOut = outAmount / 1e6;
      const profit  = usdcOut - TRADE_SIZE_USD;
      // Recovery trades: log for audit but don't affect P&L stats
      logTrade({ date: new Date().toISOString(), tradeId: `${pair.okxCcy}-recovery-${Date.now()}`, pair: pair.name, direction: 'RECOVERY', exchange: 'wallet', spreadPct: 0, profit, usdcOut, tradeSizeUsd: TRADE_SIZE_USD, durationMin: 0, autoRecovery: true });
      recovered.push({ ccy: pair.okxCcy, tokenAmt, usdcOut, profit });
      await sendAlert(`🤖 <b>Auto-recovered: ${pair.okxCcy}</b>\n${tokenAmt.toFixed(4)} tokens → $${usdcOut.toFixed(2)} USDC\nP&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(4)}`);
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) { logCrash(`recoverSolanaTokens:${pair.okxCcy}`, err); }
  }
  if (recovered.length > 0) { saveState(); console.log(`  ✅ Recovered ${recovered.length} token(s)`); }
  else { console.log('  ✅ No unexpected tokens found'); }
  return recovered;
}

// ── RECOVERY: OKX tokens ──────────────────────────────────────────────────────
async function recoverOKXTokens() {
  if (!okxHealthy) { console.log('\n⏭  Recovery: OKX offline — skipping OKX token scan'); return []; }
  console.log('\n🔍 Recovery: scanning OKX for unexpected tokens...');
  const recovered = [];
  try {
    const details = await getOKXAllBalances();
    for (const d of details) {
      if (d.ccy === 'USDT' || d.ccy === 'USDC') continue;
      const bal = parseFloat(d.availBal || '0');
      if (bal <= 0.000001) continue;
      if (isPairInFlight(d.ccy)) { console.log(`  ⏭  OKX ${d.ccy}: trade in flight — skipping`); continue; }
      try {
        const pr = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${d.ccy}-USDT`);
        const pj = await pr.json();
        const price   = parseFloat(pj.data?.[0]?.last || '0');
        const usdEst  = bal * price;
        if (usdEst < DUST_USD_THRESHOLD) { console.log(`  🔸 OKX ${d.ccy}: ${bal.toFixed(4)} (~$${usdEst.toFixed(2)}) — dust, skipping`); continue; }
        console.log(`  ⚠️  OKX ${d.ccy}: found ${bal.toFixed(4)} (~$${usdEst.toFixed(2)}) — selling to USDT`);
        const body   = JSON.stringify({ instId: `${d.ccy}-USDT`, tdMode: 'cash', side: 'sell', ordType: 'market', sz: parseFloat(bal.toFixed(6)).toString(), tgtCcy: 'base_ccy' });
        const result = await okxPrivate('POST', '/api/v5/trade/order', JSON.parse(body));
        if (result.code !== '0') throw new Error(`OKX sell failed: ${result.msg}`);
        await new Promise(r => setTimeout(r, 3000));
        const newBals = await getOKXBalances();
        recovered.push({ ccy: d.ccy, bal, usdEst });
        await sendAlert(`🤖 <b>Auto-recovered: ${d.ccy} on OKX</b>\nSold ${bal.toFixed(4)} ${d.ccy}\nOKX USDT now: $${newBals.usdt.toFixed(2)}`);
      } catch (err) { logCrash(`recoverOKXTokens:${d.ccy}`, err); }
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (err) { logCrash('recoverOKXTokens', err); }
  if (recovered.length === 0) console.log('  ✅ No unexpected OKX tokens found');
  return recovered;
}

// ── RECOVERY: Bybit tokens ────────────────────────────────────────────────────
async function recoverBybitTokens() {
  console.log('\n🔍 Recovery: scanning Bybit for unexpected tokens...');
  const recovered = [];
  try {
    const coins = await getBybitAllBalances();
    for (const c of coins) {
      if (c.coin === 'USDT' || c.coin === 'USDC') continue;
      const bal = parseFloat(c.walletBalance || '0');
      if (bal <= 0.000001) continue;
      if (isPairInFlight(c.coin)) { console.log(`  ⏭  Bybit ${c.coin}: trade in flight — skipping`); continue; }
      const recoverySkip = liveConfig.RECOVERY_SKIP_BYBIT || [];
      if (recoverySkip.includes(c.coin)) { console.log(`  ⏭  Bybit ${c.coin}: in recovery skip list`); continue; }
      const pair = PAIRS.find(p => p.bybitCcy === c.coin);
      if (!pair?.bybitInstId) continue;
      try {
        const pr = await fetch(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${c.coin}USDT`);
        const pj = await pr.json();
        const price  = parseFloat(pj.result?.list?.[0]?.lastPrice || '0');
        const usdEst = bal * price;
        if (usdEst < DUST_USD_THRESHOLD) { console.log(`  🔸 Bybit ${c.coin}: ${bal.toFixed(4)} (~$${usdEst.toFixed(2)}) — dust, skipping`); continue; }
        console.log(`  ⚠️  Bybit ${c.coin}: found ${bal.toFixed(4)} (~$${usdEst.toFixed(2)}) — selling to USDT`);
        // Robust sell — use lot size precision, retry up to 5 times
        const lotR = await fetch(`https://api.bybit.com/v5/market/instruments-info?category=spot&symbol=${pair.bybitInstId}`);
        const lotJ = await lotR.json();
        const lotInfo = lotJ.result?.list?.[0]?.lotSizeFilter;
        const step    = parseFloat(lotInfo?.basePrecision || 1);
        const minAmt  = parseFloat(lotInfo?.minOrderAmt || 5);
        const priceR2  = await fetch(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${pair.bybitInstId}`);
        const priceJ2  = await priceR2.json();
        const price2   = parseFloat(priceJ2.result?.list?.[0]?.lastPrice || 0);
        let sold = false;
        for (let attempt = 0; attempt < 5 && !sold; attempt++) {
          const tryBal  = bal * Math.pow(0.99, attempt);
          const steps   = Math.floor(tryBal / step);
          const sellQty = (steps * step).toFixed(String(step).split('.')[1]?.length || 0);
          const usdVal  = parseFloat(sellQty) * price2;
          if (usdVal < minAmt) { console.log(`  ⏭  Bybit ${c.coin}: $${usdVal.toFixed(2)} below min $${minAmt} — will retry later`); break; }
          const sr = await bybitPrivate('POST', '/v5/order/create', { category: 'spot', symbol: pair.bybitInstId, side: 'Sell', orderType: 'Market', qty: sellQty, timeInForce: 'IOC' });
          if (sr.retCode === 0) { sold = true; }
          else { console.log(`  ⚠️  Bybit ${c.coin} sell attempt ${attempt+1}/5: ${sr.retMsg}`); await new Promise(r => setTimeout(r, 1000)); }
        }
        if (!sold) continue;
        await new Promise(r => setTimeout(r, 3000));
        const newBal = await getBybitBalance('USDT');
        recovered.push({ ccy: c.coin, bal, usdEst });
        await sendAlert(`🤖 <b>Auto-recovered: ${c.coin} on Bybit</b>\nSold ${bal.toFixed(4)} ${c.coin}\nBybit USDT now: $${newBal.toFixed(2)}`);
      } catch (err) { logCrash(`recoverBybitTokens:${c.coin}`, err); }
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (err) { logCrash('recoverBybitTokens', err); }
  if (recovered.length === 0) console.log('  ✅ No unexpected Bybit tokens found');
  return recovered;
}

// ── RECOVERY: Master ──────────────────────────────────────────────────────────
async function runRecoveryChecks() {
  console.log('\n🛡️  Running recovery checks...');
  try {
    resumePendingTrades();
    await recoverOKXTokens();
    await recoverBybitTokens();
    await recoverSolanaTokens();
    console.log('✅ Recovery checks complete\n');
  } catch (err) { logCrash('runRecoveryChecks', err); }
}

// ── Leg A ─────────────────────────────────────────────────────────────────────
async function executeJupiterSwap(originalQuote, ctx) {
  const inputMint = originalQuote.inputMint, outputMint = originalQuote.outputMint, amount = originalQuote.inAmount;
  for (let attempt = 0; attempt < LEG_A_SLIPPAGE.length; attempt++) {
    const slippage = LEG_A_SLIPPAGE[attempt];
    try {
      ctx.log(`Leg A attempt ${attempt+1}/${LEG_A_SLIPPAGE.length} @ ${slippage}bps`);
      let quote = originalQuote;
      if (attempt > 0) {
        const qr = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippage}`, { headers: { 'x-api-key': process.env.JUPITER_API_KEY } });
        quote = await qr.json();
        if (!quote.outAmount) throw new Error('No quote — Jupiter returned no route');
      }
      const sr = await fetch('https://api.jup.ag/swap/v1/swap', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.JUPITER_API_KEY }, body: JSON.stringify({ quoteResponse: quote, userPublicKey: wallet.publicKey.toString(), wrapAndUnwrapSol: true, dynamicSlippage: true, prioritizationFeeLamports: 100_000 }) });
      const { swapTransaction, error } = await sr.json();
      if (error) throw new Error(`Jupiter swap error: ${error}`);
      const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
      tx.sign([wallet]);
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: MAX_RETRIES });
      await connection.confirmTransaction(sig, 'confirmed');
      ctx.log(`Leg A success on attempt ${attempt+1}`);
      return sig;
    } catch (err) {
      ctx.log(`Leg A attempt ${attempt+1} failed: ${err.message?.slice(0, 60)}`);
      if (attempt < LEG_A_SLIPPAGE.length - 1) {
        await new Promise(r => setTimeout(r, 2000));
        if (!isSlippageError(err)) throw err;
      } else { throw err; }
    }
  }
}

// ── Leg B ─────────────────────────────────────────────────────────────────────
async function getCurrentDexPrice(pair) {
  try {
    const rawAmount  = Math.floor(TRADE_SIZE_USD * 1e6);
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 5000);
    const qr = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${USDC_MINT}&outputMint=${pair.outputMint}&amount=${rawAmount}&slippageBps=100`, { headers: { 'x-api-key': process.env.JUPITER_API_KEY }, signal: controller.signal });
    clearTimeout(timeout);
    const quote = await qr.json();
    if (!quote.outAmount) return null;
    const tokenOut = quote.outAmount / Math.pow(10, pair.decimals);
    return TRADE_SIZE_USD / tokenOut;
  } catch { return null; }
}

async function executeSwapToUSDC(trade, ctx) {
  const { pair, tokenAmount, rawAmount, tradeSizeUsd, startTime, spreadPct, exchange, tradeId, entryPrice } = trade;
  const logger = trade.logger || new TradeLogger(tradeId, pair.name, `BUY_${exchange}`, spreadPct, tradeSizeUsd);
  const symbol = pair.name.split('/')[0];
  logger.log('SWAP_START', `Leg B: ${tokenAmount?.toFixed(4)} ${symbol} → USDC rawAmount:${rawAmount}`);

  // ── Smart sell: check if conditions are good, hold if not ────────────────
  const smartSell  = liveConfig.SMART_SELL !== false;
  const minSpread  = liveConfig.HOLD_MIN_SPREAD_PCT ?? HOLD_MIN_SPREAD_PCT;
  const stopLossPct = liveConfig.HOLD_STOP_LOSS_PCT ?? HOLD_STOP_LOSS_PCT;
  const maxHoldMs  = (liveConfig.HOLD_MAX_HOURS ?? 2) * 60 * 60 * 1000;
  const arrivalTime = Date.now();
  let lastHoldReport = 0;
  let soldViaSmartSell = false;

  if (smartSell && entryPrice) {
    console.log(`  [${tradeId}] 🧠 Smart sell active — entry price: $${entryPrice.toFixed(6)}`);
    const holdStart = Date.now();
    while (Date.now() - holdStart < maxHoldMs) {
      const currentPrice = await getCurrentDexPrice(pair);
      if (!currentPrice) { await new Promise(r => setTimeout(r, HOLD_CHECK_MS)); continue; }
      const pricePct  = ((currentPrice - entryPrice) / entryPrice) * 100;
      const spreadPct = -pricePct; // if price went up on DEX, spread closed; if down, spread opened
      console.log(`  [${tradeId}] 🧠 ${symbol} entry:$${entryPrice.toFixed(6)} now:$${currentPrice.toFixed(6)} (${pricePct >= 0 ? '+' : ''}${pricePct.toFixed(2)}%)`);

      // Stop-loss: price dropped too much
      if (pricePct < -stopLossPct) {
        await ctx.alert(`🛑 Stop-loss triggered on ${symbol}\nEntry: $${entryPrice.toFixed(6)} | Now: $${currentPrice.toFixed(6)} (${pricePct.toFixed(2)}%)\nSelling to limit loss`);
        soldViaSmartSell = true;
        break;
      }

      // Good conditions: DEX price is below entry (spread has re-opened or is profitable)
      if (pricePct <= -minSpread) {
        console.log(`  [${tradeId}] 🧠 Conditions good — selling now`);
        soldViaSmartSell = true;
        break;
      }

      // 30-min hold update
      if (Date.now() - lastHoldReport > HOLD_REPORT_INTERVAL) {
        lastHoldReport = Date.now();
        const heldMin = Math.round((Date.now() - holdStart) / 1000 / 60);
        await ctx.alert(`⏳ Holding ${symbol} — ${heldMin}min\nEntry: $${entryPrice.toFixed(6)} | Now: $${currentPrice.toFixed(6)} (${pricePct >= 0 ? '+' : ''}${pricePct.toFixed(2)}%)\nWaiting for spread ≥ ${minSpread}%`);
      }

      await new Promise(r => setTimeout(r, HOLD_CHECK_MS));
    }

    if (!soldViaSmartSell) {
      // Timeout — sell at market
      const currentPrice = await getCurrentDexPrice(pair);
      const pricePct = currentPrice ? ((currentPrice - entryPrice) / entryPrice * 100).toFixed(2) : '?';
      await ctx.alert(`⏱ ${symbol} hold timeout — selling at market\nEntry: $${entryPrice.toFixed(6)} | Now: $${currentPrice?.toFixed(6) || '?'} (${pricePct}%)`);
      soldViaSmartSell = true;
    }
  }

  // ── Execute the swap ─────────────────────────────────────────────────────
  let usdcOut = 0;
  for (let attempt = 0; attempt < LEG_B_SLIPPAGE.length; attempt++) {
    const slippage = LEG_B_SLIPPAGE[attempt];
    try {
      ctx.log(`Leg B attempt ${attempt+1}/${LEG_B_SLIPPAGE.length} @ ${slippage}bps`);
      logger.log('SWAP_ATTEMPT', `attempt ${attempt+1}/${LEG_B_SLIPPAGE.length} slippage:${slippage}bps`);
      const qr = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${pair.outputMint}&outputMint=${USDC_MINT}&amount=${rawAmount}&slippageBps=${slippage}`, { headers: { 'x-api-key': process.env.JUPITER_API_KEY } });
      const quote = await qr.json();
      if (!quote.outAmount) throw new Error('No quote — Jupiter returned no route');
      usdcOut = quote.outAmount / 1e6;
      const sr = await fetch('https://api.jup.ag/swap/v1/swap', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.JUPITER_API_KEY }, body: JSON.stringify({ quoteResponse: quote, userPublicKey: wallet.publicKey.toString(), wrapAndUnwrapSol: true, dynamicSlippage: true, prioritizationFeeLamports: 100_000 }) });
      const { swapTransaction, error } = await sr.json();
      if (error) throw new Error(`Jupiter swap error: ${error}`);
      const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
      tx.sign([wallet]);
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: MAX_RETRIES });
      await connection.confirmTransaction(sig, 'confirmed');
      ctx.log(`Leg B success on attempt ${attempt+1} → $${usdcOut.toFixed(2)} USDC`);
      logger.log('SWAP_SUCCESS', `attempt ${attempt+1} → $${usdcOut.toFixed(2)} USDC`);
      break;
    } catch (err) {
      ctx.log(`Leg B attempt ${attempt+1} failed: ${err.message?.slice(0, 60)}`);
      if (attempt === LEG_B_SLIPPAGE.length - 1) {
        logCrash(`executeSwapToUSDC:allAttemptsFailed [${tradeId}]`, err);
        removePending(exchange === 'OKX' ? 'okx' : 'bybit', tradeId);
        saveState();
        await ctx.fail({ reason: `Leg B failed after ${LEG_B_SLIPPAGE.length} attempts — ${err.message?.slice(0, 80)}`, fundsAffected: true, autoFixed: 'Token left in wallet — will auto-recover on next restart' });
        return;
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  const profit   = usdcOut - tradeSizeUsd;
  const duration = Math.round((Date.now() - startTime) / 1000 / 60);
  totalProfit  += profit;
  if (profit > 0) { winningTrades++; consecutiveWins++; } else { consecutiveWins = 0; }
  removePending(exchange === 'OKX' ? 'okx' : 'bybit', tradeId);
  saveState();
  logTrade({ date: new Date().toISOString(), tradeId, pair: pair.name, direction: `BUY_${exchange}`, exchange, spreadPct, profit, usdcOut, tradeSizeUsd, durationMin: duration, smartSell: soldViaSmartSell });
  logger.complete(profit, usdcOut, duration, { fundsRecovered: true });
  await ctx.complete({ profit, usdcOut, tokenAmount, durationMin: duration });
  lastReportTime = 0;
  // Immediate rebalance check after trade — restores exchange balance for next opportunity
  try {
    const to = new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 30000));
    await Promise.race([checkAndRebalance(), to]);
  } catch(e) { logCrash('post-trade rebalance', e); }
}

// ── Rebalance ─────────────────────────────────────────────────────────────────
async function swapUSDCtoUSDT(amountUsd) {
  const rawAmount = Math.floor(amountUsd * 1e6);
  let quote;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      console.log(`  swapUSDCtoUSDT retry ${attempt+1}/5 in 5s...`);
      await new Promise(r => setTimeout(r, 5000));
    }
    const qr = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${USDC_MINT}&outputMint=${USDT_MINT}&amount=${rawAmount}&slippageBps=50`, { headers: { 'x-api-key': process.env.JUPITER_API_KEY } });
    quote = await qr.json();
    if (quote.outAmount) break;
    console.log(`  swapUSDCtoUSDT attempt ${attempt+1} failed: ${JSON.stringify(quote).slice(0, 80)}`);
  }
  if (!quote.outAmount) throw new Error('USDC→USDT quote failed after 5 attempts: ' + JSON.stringify(quote).slice(0, 80));
  const sr = await fetch('https://api.jup.ag/swap/v1/swap', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.JUPITER_API_KEY }, body: JSON.stringify({ quoteResponse: quote, userPublicKey: wallet.publicKey.toString(), wrapAndUnwrapSol: true, dynamicSlippage: true, prioritizationFeeLamports: 100_000 }) });
  const { swapTransaction, error } = await sr.json();
  if (error) throw new Error(`USDC→USDT error: ${error}`);
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([wallet]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: MAX_RETRIES });
  await connection.confirmTransaction(sig, 'confirmed');
  return quote.outAmount / 1e6;
}

async function pollAndSwapUSDTtoUSDC(expectedUsd) {
  const startTime = Date.now(), rawExpected = Math.floor(expectedUsd * 1e6 * 0.85), balBefore = await getTokenBalance(USDT_MINT);
  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const arrived = await getTokenBalance(USDT_MINT) - balBefore;
      if (arrived >= rawExpected) {
        const { outAmount } = await jupiterSwapRaw(USDT_MINT, USDC_MINT, Math.floor(arrived), 50);
        await sendAlert(`⚖️ <b>Rebalance complete</b>\n$${(outAmount/1e6).toFixed(2)} USDC added`);
        return;
      }
    } catch (err) { logCrash('pollAndSwapUSDTtoUSDC', err); }
  }
  await sendAlert(`⚠️ <b>Rebalance timeout</b> — USDT did not arrive`);
}

async function checkAndRebalance() {
  try {
    const w   = await Promise.race([getWalletBalances(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 15000))]);
    const okx = await Promise.race([getOKXBalances(),   new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 15000))]);
    console.log(`\n🔄 Rebalance — Solana: $${w.usdc.toFixed(2)} | OKX: $${okx.usdt.toFixed(2)}`);
    if (w.usdc < REBALANCE_FLOOR && okx.usdt > REBALANCE_FLOOR + 10) {
      const transfer = Math.min(80, okx.usdt - REBALANCE_RESERVE);
      if (transfer < 5) return;
      await sendAlert(`⚖️ <b>Auto-rebalance</b> — withdrawing $${transfer.toFixed(2)} from OKX`);
      try { await withdrawFromOKX('USDT', 'USDT-Solana', transfer.toFixed(2)); await pollAndSwapUSDTtoUSDC(transfer); }
      catch (err) { logCrash('rebalance:withdraw', err); await sendAlert(`⚠️ Rebalance failed: ${err.message}`); }
    } else if (okx.usdt < REBALANCE_FLOOR && w.usdc > REBALANCE_FLOOR + 10) {
      const transfer = Math.min(80, w.usdc - REBALANCE_RESERVE);
      if (transfer < 5) return;
      await sendAlert(`⚖️ <b>Auto-rebalance</b> — depositing $${transfer.toFixed(2)} to OKX`);
      try {
        const usdtReceived = await swapUSDCtoUSDT(transfer);
        if (usdtReceived > 0) {
          const depositAddr = await getOKXDepositAddress('USDT', 'USDT-Solana');
          const rawUSDT     = Math.floor(usdtReceived * 1e6);
          const usdtMint    = new PublicKey(USDT_MINT), destPubkey = new PublicKey(depositAddr);
          const fromAta     = await getAssociatedTokenAddress(usdtMint, wallet.publicKey);
          const toAta       = await getAssociatedTokenAddress(usdtMint, destPubkey);
          const tx          = new Transaction();
          try { await getAccount(connection, toAta); } catch { tx.add(createAssociatedTokenAccountInstruction(wallet.publicKey, toAta, destPubkey, usdtMint)); }
          tx.add(createTransferInstruction(fromAta, toAta, wallet.publicKey, rawUSDT));
          const sig = await connection.sendTransaction(tx, [wallet]);
          await connection.confirmTransaction(sig, 'confirmed');
          await sendAlert(`⚖️ <b>Rebalance complete</b> — deposited $${usdtReceived.toFixed(2)} USDT to OKX`);
        }
      } catch (err) { logCrash('rebalance:deposit', err); }
    } else { console.log(`  ✅ Balances OK`); }
  } catch (err) { logCrash('checkAndRebalance', err); }
}

// ── WS trigger ────────────────────────────────────────────────────────────────

// ── Background wallet cleaner ─────────────────────────────────────────────────
let lastWalletClean = 0;
const WALLET_CLEAN_INTERVAL_MS = 15 * 60 * 1000;

async function backgroundWalletClean() {
  if (Date.now() - lastWalletClean < WALLET_CLEAN_INTERVAL_MS) return;
  if (testRunning) return;
  if (activeTradeCount() > 0) return;
  lastWalletClean = Date.now();
  let anyFound = false;

  // ── OKX ───────────────────────────────────────────────────────────────────
  try {
    if (okxHealthy) {
      const details = await getOKXAllBalances();
      for (const d of details) {
        if (d.ccy === 'USDT' || d.ccy === 'USDC') continue;
        const bal = parseFloat(d.availBal || '0');
        if (bal <= 0.000001) continue;
        if (isPairInFlight(d.ccy)) continue;
        try {
          const pr = await fetch('https://www.okx.com/api/v5/market/ticker?instId=' + d.ccy + '-USDT');
          const pj = await pr.json();
          const px = parseFloat(pj.data?.[0]?.last || '0');
          const usdEst = bal * px;
          if (usdEst < DUST_USD_THRESHOLD) continue;
          anyFound = true;
          const lotR = await fetch('https://www.okx.com/api/v5/public/instruments?instType=SPOT&instId=' + d.ccy + '-USDT');
          const lotJ = await lotR.json();
          const lotSz = parseFloat(lotJ.data?.[0]?.lotSz || 0.01);
          const steps = Math.floor(bal / lotSz);
          const sellQty = (steps * lotSz).toFixed(String(lotSz).split('.')[1]?.length || 8);
          console.log('  🧹 OKX ' + d.ccy + ': $' + usdEst.toFixed(2) + ' — selling');
          const result = await okxPrivate('POST', '/api/v5/trade/order', { instId: d.ccy + '-USDT', tdMode: 'cash', side: 'sell', ordType: 'market', sz: sellQty, tgtCcy: 'base_ccy' });
          if (result.code === '0') {
            console.log('  ✅ OKX ' + d.ccy + ' sold');
            await sendAlert('🧹 <b>Cleaned: ' + d.ccy + ' on OKX</b>\n$' + usdEst.toFixed(2) + ' → USDT');
          } else {
            console.log('  ⚠️  OKX ' + d.ccy + ' sell failed: ' + result.msg);
          }
        } catch (err) { logCrash('bgClean:OKX:' + d.ccy, err); }
        await new Promise(r => setTimeout(r, 500));
      }
    }
  } catch (err) { logCrash('bgClean:OKX', err); }

  // ── Bybit ──────────────────────────────────────────────────────────────────
  try {
    const coins = await getBybitAllBalances();
    const recoverySkip = liveConfig.RECOVERY_SKIP_BYBIT || [];
    for (const c of coins) {
      if (c.coin === 'USDT' || c.coin === 'USDC') continue;
      if (recoverySkip.includes(c.coin)) continue;
      const bal = parseFloat(c.walletBalance || '0');
      if (bal <= 0.000001) continue;
      if (isPairInFlight(c.coin)) continue;
      const pair = PAIRS.find(p => p.bybitCcy === c.coin);
      if (!pair?.bybitInstId) continue;
      try {
        const pr = await fetch('https://api.bybit.com/v5/market/tickers?category=spot&symbol=' + c.coin + 'USDT');
        const pj = await pr.json();
        const px = parseFloat(pj.result?.list?.[0]?.lastPrice || '0');
        const usdEst = bal * px;
        if (usdEst < DUST_USD_THRESHOLD) continue;
        const lotR = await fetch('https://api.bybit.com/v5/market/instruments-info?category=spot&symbol=' + pair.bybitInstId);
        const lotJ = await lotR.json();
        const lotInfo = lotJ.result?.list?.[0]?.lotSizeFilter;
        const step   = parseFloat(lotInfo?.basePrecision || 1);
        const minAmt = parseFloat(lotInfo?.minOrderAmt || 5);
        if (usdEst < minAmt) {
          console.log('  ⏳ Bybit ' + c.coin + ': $' + usdEst.toFixed(2) + ' below min $' + minAmt + ' — waiting for price recovery');
          continue;
        }
        anyFound = true;
        const steps = Math.floor(bal / step);
        const sellQty = (steps * step).toFixed(String(step).split('.')[1]?.length || 0);
        console.log('  🧹 Bybit ' + c.coin + ': $' + usdEst.toFixed(2) + ' — selling');
        let sold = false;
        for (let attempt = 0; attempt < 3 && !sold; attempt++) {
          const sr = await bybitPrivate('POST', '/v5/order/create', { category: 'spot', symbol: pair.bybitInstId, side: 'Sell', orderType: 'Market', qty: sellQty, timeInForce: 'IOC' });
          if (sr.retCode === 0) { sold = true; }
          else { await new Promise(r => setTimeout(r, 2000)); }
        }
        if (sold) {
          console.log('  ✅ Bybit ' + c.coin + ' sold');
          await sendAlert('🧹 <b>Cleaned: ' + c.coin + ' on Bybit</b>\n$' + usdEst.toFixed(2) + ' → USDT');
        } else {
          console.log('  ⚠️  Bybit ' + c.coin + ': will retry in 15min');
        }
      } catch (err) { logCrash('bgClean:Bybit:' + c.coin, err); }
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (err) { logCrash('bgClean:Bybit', err); }

  // ── Solana USDT → USDC swap ───────────────────────────────────────────────
  try {
    const usdtBal = await getTokenBalance(USDT_MINT);
    const usdtAmt = usdtBal / 1e6;
    if (usdtAmt >= 1) {
      console.log(`  🧹 Solana USDT: $${usdtAmt.toFixed(2)} — swapping to USDC`);
      const { outAmount } = await jupiterSwapRaw(USDT_MINT, USDC_MINT, Math.floor(usdtBal), 50);
      const usdcOut = outAmount / 1e6;
      console.log(`  ✅ Swapped $${usdtAmt.toFixed(2)} USDT → $${usdcOut.toFixed(2)} USDC`);
      await sendAlert(`🧹 <b>Cleaned: USDT on Solana</b>\n$${usdtAmt.toFixed(2)} → $${usdcOut.toFixed(2)} USDC`);
      anyFound = true;
    }
  } catch (err) { logCrash('bgClean:Solana:USDT', err); }

  // ── Solana wallet ──────────────────────────────────────────────────────────
  try {
    const allPairs = [...PAIRS, ...dynamicPairs];
    for (const pair of allPairs) {
      if (pair.isNative || pair.outputMint === USDC_MINT || pair.outputMint === USDT_MINT) continue;
      if (isPairInFlight(pair.okxCcy)) continue;
      const rawBal = await getTokenBalance(pair.outputMint, false);
      if (rawBal <= 0) continue;
      const tokenAmt = rawBal / Math.pow(10, pair.decimals);
      try {
        const qr = await fetch('https://api.jup.ag/swap/v1/quote?inputMint=' + pair.outputMint + '&outputMint=' + USDC_MINT + '&amount=' + Math.floor(rawBal) + '&slippageBps=300', { headers: { 'x-api-key': process.env.JUPITER_API_KEY } });
        const quote = await qr.json();
        const usdEst = quote.outAmount ? quote.outAmount / 1e6 : 0;
        if (usdEst < DUST_USD_THRESHOLD) continue;
        anyFound = true;
        console.log('  🧹 Solana ' + pair.okxCcy + ': $' + usdEst.toFixed(2) + ' — swapping to USDC');
        const { outAmount } = await jupiterSwapRaw(pair.outputMint, USDC_MINT, Math.floor(rawBal));
        const usdcOut = outAmount / 1e6;
        console.log('  ✅ Solana ' + pair.okxCcy + ' → $' + usdcOut.toFixed(2) + ' USDC');
        await sendAlert('🧹 <b>Cleaned: ' + pair.okxCcy + ' on Solana</b>\n$' + usdEst.toFixed(2) + ' → $' + usdcOut.toFixed(2) + ' USDC');
      } catch (err) { logCrash('bgClean:Solana:' + pair.okxCcy, err); }
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (err) { logCrash('bgClean:Solana', err); }

  if (anyFound) console.log('🧹 Background clean complete');
}

let scanDebounce = null;
function triggerScan(reason) {
  if (!feedsReady) return;
  if (scanDebounce) return;
  scanDebounce = setTimeout(() => {
    scanDebounce = null;
    console.log(`⚡ WS trigger: ${reason}`);
    checkAndExecute().catch(err => logCrash('triggerScan', err));
  }, 500);
}

// ── OKX WebSocket ─────────────────────────────────────────────────────────────
function startOKXWS() {
  console.log('📡 Connecting to OKX WebSocket...');
  const ws = new WebSocket('wss://ws.okx.com:443/ws/v5/public');
  ws.on('open', () => {
    console.log('✅ OKX WebSocket connected');
    const allPairs = [...PAIRS, ...dynamicPairs];
    ws.send(JSON.stringify({ op: 'subscribe', args: allPairs.map(p => ({ channel: 'tickers', instId: p.okxInstId })) }));
  });
  ws.on('message', (data) => {
    const raw = data.toString();
    if (raw === 'pong') return;
    try {
      const msg = JSON.parse(raw);
      if (msg.event === 'subscribe') return;
      if (msg.arg?.channel === 'tickers' && msg.data?.[0]) {
        const ticker = msg.data[0], bid = parseFloat(ticker.bidPx), ask = parseFloat(ticker.askPx);
        if (!isNaN(bid) && !isNaN(ask) && bid > 0 && ask > 0) {
          const mid     = (bid + ask) / 2;
          const prevMid = lastKnownPrice[`okx:${ticker.instId}`] || mid;
          if (Math.abs(mid - prevMid) / prevMid > MAX_PRICE_MOVE) return;
          lastKnownPrice[`okx:${ticker.instId}`] = mid;
          okxPrices[ticker.instId] = { bid, ask };
          lastOkxWsMsg = Date.now();
          priceTimestamps[`okx:${ticker.instId}`] = Date.now();
          const movePct = Math.abs(mid - prevMid) / prevMid * 100;
          if (movePct > 0.3 && !executingDex && !executingOkx && !executingBybit)
            triggerScan(`OKX ${ticker.instId} moved ${movePct.toFixed(2)}%`);
        }
      }
    } catch { /* ignore */ }
  });
  const ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping'); }, 10000);
  ws.on('close', () => {
    console.warn('⚠️  OKX WS closed — reconnecting...');
    clearInterval(ping);
    Object.keys(okxPrices).forEach(k => delete okxPrices[k]);
    Object.keys(priceTimestamps).filter(k => k.startsWith('okx:')).forEach(k => delete priceTimestamps[k]);
    setTimeout(() => { startOKXWS(); }, 1000);
  });
  ws.on('error', (err) => logCrash('OKX WS', err));
}

// ── Bybit WebSocket ───────────────────────────────────────────────────────────
function startBybitWS() {
  if (!process.env.BYBIT_API_KEY) { console.log('⚠️  Bybit key not set'); return; }
  console.log('📡 Connecting to Bybit WebSocket...');
  const ws = new WebSocket('wss://stream.bybit.com/v5/public/spot');
  ws.on('open', () => {
    console.log('✅ Bybit WebSocket connected');
    const args = [...PAIRS, ...dynamicPairs].filter(p => p.bybitInstId).map(p => `orderbook.1.${p.bybitInstId}`);
    ws.send(JSON.stringify({ op: 'subscribe', args: args.slice(0, 5) }));
    if (args.length > 5) setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'subscribe', args: args.slice(5) })); }, 1000);
  });
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.op === 'pong' || msg.ret_msg === 'pong') return;
      if (msg.op === 'subscribe') return;
      if (msg.topic?.startsWith('orderbook.1.') && msg.data) {
        const ob = msg.data, symbol = ob.s;
        if (!symbol) return;
        const bid = ob.b?.[0]?.[0] ? parseFloat(ob.b[0][0]) : null;
        const ask = ob.a?.[0]?.[0] ? parseFloat(ob.a[0][0]) : null;
        if (bid && ask && !isNaN(bid) && !isNaN(ask) && bid > 0 && ask > 0) {
          const mid     = (bid + ask) / 2;
          const prevMid = lastKnownPrice[`bybit:${symbol}`] || mid;
          if (Math.abs(mid - prevMid) / prevMid > MAX_PRICE_MOVE) return;
          lastKnownPrice[`bybit:${symbol}`] = mid;
          bybitPrices[symbol] = { bid, ask };
          priceTimestamps[`bybit:${symbol}`] = Date.now();
          const movePct = Math.abs(mid - prevMid) / prevMid * 100;
          if (movePct > 0.3 && !executingDex && !executingOkx && !executingBybit)
            triggerScan(`Bybit ${symbol} moved ${movePct.toFixed(2)}%`);
        }
      }
    } catch (err) { logCrash('Bybit WS parse', err); }
  });
  const ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'ping' })); }, 20000);
  ws.on('close', () => { console.warn('⚠️  Bybit WS closed — reconnecting...'); clearInterval(ping); Object.keys(bybitPrices).forEach(k => delete bybitPrices[k]); setTimeout(startBybitWS, 5000); });
  ws.on('error', (err) => logCrash('Bybit WS', err));
}

// ── BUY_DEX Leg B ─────────────────────────────────────────────────────────────
async function waitAndSellOnExchange(trade, ctx) {
  const { pair, expectedAmount, tradeSizeUsd, startTime, spreadPct, exchange, tradeId } = trade;
  const symbol    = pair.name.split('/')[0];
  const threshold = expectedAmount * 0.85;
  ctx.log(`Polling ${exchange} for ${symbol}...`);
  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`  [${tradeId}] 🔍 ${exchange} ${symbol}... (${elapsed}s)`);
    try {
      const balance = exchange === 'OKX' ? await getOKXTokenBal(pair.okxCcy) : await getBybitBalance(pair.bybitCcy);
      if (balance >= threshold && balance > 0.001) {
        ctx.log(`${symbol} arrived on ${exchange} — selling`);
        let usdtGained = 0;
        if (exchange === 'OKX') {
          const before = (await getOKXBalances()).usdt;
          const body   = JSON.stringify({ instId: pair.okxInstId, tdMode: 'cash', side: 'sell', ordType: 'market', sz: String(balance.toFixed(6)), tgtCcy: 'base_ccy' });
          await okxPrivate('POST', '/api/v5/trade/order', JSON.parse(body));
          await new Promise(r => setTimeout(r, 3000));
          usdtGained = (await getOKXBalances()).usdt - before;
        } else {
          const before = await getBybitBalance('USDT');
          await placeBybitOrder('sell', Math.floor(balance).toString(), pair.bybitInstId);
          await new Promise(r => setTimeout(r, 3000));
          usdtGained = await getBybitBalance('USDT') - before;
        }
        const profit   = usdtGained - tradeSizeUsd;
        const duration = Math.round((Date.now() - startTime) / 1000 / 60);
        totalProfit  += profit;
        if (profit > 0) { winningTrades++; consecutiveWins++; } else { consecutiveWins = 0; }
        removePending('dex', tradeId);
        saveState();
        logTrade({ date: new Date().toISOString(), tradeId, pair: pair.name, direction: 'BUY_DEX', exchange, spreadPct, profit, usdtGained, tradeSizeUsd, durationMin: duration });
        await ctx.complete({ profit, usdcOut: usdtGained, tokenAmount: balance, durationMin: duration });
        if (consecutiveWins >= WINS_TARGET) await sendAlert(`🚀 <b>${WINS_TARGET} consecutive wins!</b> Ready to scale.`);
        lastReportTime = 0;
        await checkAndRebalance();
        return;
      }
    } catch (err) { logCrash(`waitAndSellOnExchange [${tradeId}]`, err); }
  }
  await ctx.fail({ reason: `${symbol} never arrived on ${exchange} after 2hrs`, fundsAffected: true, autoFixed: 'Will auto-recover on next restart' });
  removePending('dex', tradeId);
  saveState();
}

// ── BUY_CEX Leg B ─────────────────────────────────────────────────────────────
async function waitAndSwapBack(trade, ctx) {
  const { pair, expectedRawAmount, tradeSizeUsd, startTime, spreadPct, exchange, tradeId } = trade;
  const logger    = trade.logger || new TradeLogger(tradeId, pair.name, `BUY_${exchange}`, spreadPct, tradeSizeUsd);
  const symbol    = pair.name.split('/')[0];
  const threshold = expectedRawAmount * 0.85;
  logger.log('POLL_START', `waiting for ${symbol} on Solana threshold:${(threshold/Math.pow(10,pair.decimals)).toFixed(4)}`);
  ctx.log(`Polling Solana for ${symbol}...`);
  const balBefore = await getTokenBalance(pair.outputMint, pair.isNative);
  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`  [${tradeId}] 🔍 ${symbol} wallet... (${elapsed}s)`);
    try {
      const current = await getTokenBalance(pair.outputMint, pair.isNative);
      const arrived = pair.isNative ? (current - balBefore) * 1e9 : current - balBefore;
      logger.pollEvent(`Solana ${symbol}`, arrived >= threshold && arrived > 0, elapsed);
      if (arrived >= threshold && arrived > 0) {
        logger.log('TOKEN_ARRIVED', `${(arrived/Math.pow(10,pair.decimals)).toFixed(4)} ${symbol} arrived on Solana`);
        const arrivedTokens = pair.isNative ? arrived / 1e9 : arrived / Math.pow(10, pair.decimals);
        const rawArrived    = pair.isNative ? Math.floor(arrivedTokens * 1e9) : Math.floor(arrived);
        ctx.log(`${symbol} arrived on Solana — swapping to USDC`);
        await executeSwapToUSDC({ ...trade, tokenAmount: arrivedTokens, rawAmount: rawArrived }, ctx);
        return;
      }
    } catch (err) { logCrash(`waitAndSwapBack [${tradeId}]`, err); }
  }
  await ctx.fail({ reason: `${symbol} never arrived on Solana after 2hrs`, fundsAffected: true, autoFixed: 'Will auto-recover on next restart' });
  removePending(exchange === 'OKX' ? 'okx' : 'bybit', tradeId);
  saveState();
}

// ── Resume pending trades ─────────────────────────────────────────────────────
function resumePendingTrades() {
  const pending = _state.pendingTrades || [];
  if (pending.length === 0) return;
  console.log(`  ♻️  Resuming ${pending.length} pending trade(s)...`);
  const allPairs = [...PAIRS, ...dynamicPairs];
  for (const p of pending) {
    const elapsed = Math.round((Date.now() - p.startTime) / 1000 / 60);
    const pair    = allPairs.find(pr => pr.okxCcy === p.symbol || pr.bybitCcy === p.symbol || pr.name.startsWith(p.symbol));
    if (!pair) { console.warn(`  ⚠️  Could not find pair for ${p.symbol}`); continue; }
    console.log(`  ♻️  Resuming ${p.direction}: ${p.symbol} (${elapsed}min ago) [${p.tradeId}]`);
    const ctx = new TradeContext(p.tradeId, pair, p.direction, p.spreadPct || 0, p.exchange || '');
    ctx.log(`Resumed after restart (${elapsed}min elapsed)`);
    if (p.direction === 'BUY_DEX') {
      const entry = { ...p, pair };
      pendingDex.push(entry);
      waitAndSellOnExchange(entry, ctx).catch(err => { logCrash(`resume:BUY_DEX [${p.tradeId}]`, err); removePending('dex', p.tradeId); saveState(); });
    } else if (p.direction === 'BUY_OKX') {
      const entry = { ...p, pair };
      pendingOkx.push(entry);
      waitAndSwapBack(entry, ctx).catch(err => { logCrash(`resume:BUY_OKX [${p.tradeId}]`, err); removePending('okx', p.tradeId); saveState(); });
    } else if (p.direction === 'BUY_BYBIT') {
      const entry = { ...p, pair };
      pendingBybit.push(entry);
      waitAndSwapBack(entry, ctx).catch(err => { logCrash(`resume:BUY_BYBIT [${p.tradeId}]`, err); removePending('bybit', p.tradeId); saveState(); });
    }
  }
}

// ── Main scan ─────────────────────────────────────────────────────────────────
async function checkAndExecute() {
  if (testRunning || rebalancing) return; // pause during exchange tests or rebalance
  loadLiveConfig();

  // ── OKX WebSocket watchdog ─────────────────────────────────────────────────
  if (Date.now() - lastOkxWsMsg > 60000) {
    console.warn('⚠️  OKX WS silent for 60s — forcing reconnect...');
    lastOkxWsMsg = Date.now();
    Object.keys(okxPrices).forEach(k => delete okxPrices[k]);
    startOKXWS();
  }
  // ── Kraken WebSocket watchdog ───────────────────────────────────────────────
  if ((liveConfig.KRAKEN_ENABLED) && getKraken()) getKraken().checkKrakenWsHealth();
  // Cap concurrent trades to prevent balance drain
  const maxConcurrent = liveConfig.MAX_CONCURRENT_TRADES ?? 2;
  if (activeTradeCount() >= maxConcurrent) return;
  if (Date.now() - okxHealthLastCheck > OKX_HEALTH_INTERVAL) await checkOKXHealth();
  // Atomic locks prevent race condition when multiple scan cycles run simultaneously
  const canDex    = !executingDex     && !dexLock    && pendingDex.length   === 0;
  const canOkx    = !executingOkx     && !okxLock    && pendingOkx.length   === 0 && okxHealthy;
  const canBybit  = !executingBybit   && !bybitLock  && pendingBybit.length  === 0;
  const canKraken = !executingKraken  && !krakenLock && (liveConfig.KRAKEN_ENABLED || false) && getKraken()?.krakenHealthy();
  const krakenSynthetic = liveConfig.KRAKEN_SYNTHETIC || false;
  if (!canDex && !canOkx && !canBybit && !canKraken) return;
  if (Date.now() - lastCoinRefresh > COIN_REFRESH_MS) await refreshCoinViability();
  await loadDynamicPairs();
  const allPairs    = [...PAIRS, ...dynamicPairs];
  const activePairs = allPairs.filter(p => okxPrices[p.okxInstId]);
  if (activePairs.length === 0) return;
  try {
    const timestamp = new Date().toLocaleTimeString();
    let bestDex = null, bestOkx = null, bestBybit = null;
    const pairResults = await Promise.allSettled(
      activePairs.map(async (pair) => {
        const okx = okxPrices[pair.okxInstId];
        if (!okx) return null;
        const okxAge = Date.now() - (priceTimestamps[`okx:${pair.okxInstId}`] || 0);
        if (okxAge > MAX_PRICE_AGE_MS) return null;
        const bybit = pair.bybitInstId ? bybitPrices[pair.bybitInstId] : null;
        const quoteBuy = await getQuote(USDC_MINT, pair.outputMint, TRADE_SIZE_USD, false, pair.dex);
        if (!quoteBuy.outAmount) return null;
        const quoteSell = await getQuote(pair.outputMint, USDC_MINT, quoteBuy.outAmount, true, pair.dex);
        const tokenOut  = quoteBuy.outAmount / Math.pow(10, pair.decimals);
        const dexAsk    = TRADE_SIZE_USD / tokenOut;
        const dexBid    = quoteSell.outAmount ? (quoteSell.outAmount / 1e6) / tokenOut : dexAsk;
        const spreadOKX   = ((dexBid - okx.ask) / okx.ask) * 100;
        const netOKX      = spreadOKX - (OKX_FEE + DEX_FEE) * 100;
        const spreadBybit = bybit ? ((dexBid - bybit.ask) / bybit.ask) * 100 : -999;
        const netBybit    = spreadBybit - (BYBIT_FEE + DEX_FEE) * 100;
        const bestBid     = Math.max(okx.bid, bybit?.bid || 0);
        const bestBidCex  = bestBid === (bybit?.bid || 0) && bybit ? 'Bybit' : 'OKX';
        const spreadDex   = ((bestBid - dexAsk) / dexAsk) * 100;
        const netDex      = spreadDex - (OKX_FEE + DEX_FEE) * 100;
        const dexThresh   = getBuyDexThreshold(pair.okxCcy);
        const dexEnabled  = pair.buyDexEnabled !== false;
        const okxViable   = isOKXViable(pair.okxCcy);
        const bybitViable = pair.bybitCcy ? isBybitViable(pair.bybitCcy) : false;
        if (spreadOKX > 20 || spreadBybit > 20 || spreadDex > 20) return null;
        if (dexEnabled)           updatePeakSpread(pair.name, 'BUY_DEX',   spreadDex);
        if (okxViable)            updatePeakSpread(pair.name, 'BUY_OKX',   spreadOKX);
        if (bybit && bybitViable) updatePeakSpread(pair.name, 'BUY_BYBIT', spreadBybit);
        const estDex   = (spreadDex   / 100) * TRADE_SIZE_USD - (DEX_FEE * 2 * TRADE_SIZE_USD) - 0.15;
        const estOKX   = (spreadOKX   / 100) * TRADE_SIZE_USD - (OKX_FEE + DEX_FEE) * TRADE_SIZE_USD - 0.15;
        const estBybit = (spreadBybit / 100) * TRADE_SIZE_USD - (BYBIT_FEE + DEX_FEE) * TRADE_SIZE_USD - 0.15;
        console.log(`[${timestamp}] ${pair.name.padEnd(11)}${!okxViable?'[Os]':''}${!bybitViable&&pair.bybitCcy?'[Bs]':''}${!dexEnabled?'[Ds]':''}${!okxHealthy?'[Ox]':''} OKX:$${okx.bid}/$${okx.ask} ${bybit?`By:$${bybit.bid}/$${bybit.ask}`:'By:--'} →OKX:${spreadOKX.toFixed(2)}% →By:${bybit?spreadBybit.toFixed(2):'--'}% →DEX:${spreadDex.toFixed(2)}%(≥${dexThresh}%)`);
        return { pair, okx, bybit, quoteBuy, tokenOut, dexAsk, bestBidCex, dexThresh, dexEnabled, okxViable, bybitViable, spreadOKX, netOKX, spreadBybit, netBybit, spreadDex, netDex, estOKX, estBybit, estDex };
      })
    );
    try {
      const liveData = { timestamp: new Date().toISOString(), okxHealthy, pairs: pairResults.filter(r => r.status === 'fulfilled' && r.value).map(r => { const v = r.value; return { name: v.pair.name, okxBid: v.okx.bid, okxAsk: v.okx.ask, bybitBid: v.bybit?.bid||null, bybitAsk: v.bybit?.ask||null, spreadOKX: parseFloat(v.spreadOKX.toFixed(3)), spreadBybit: v.bybit?parseFloat(v.spreadBybit.toFixed(3)):null, spreadDex: parseFloat(v.spreadDex.toFixed(3)), dexThresh: v.dexThresh, okxViable: v.okxViable, bybitViable: v.bybitViable, dexEnabled: v.dexEnabled }; }).sort((a, b) => Math.max(b.spreadOKX, b.spreadDex) - Math.max(a.spreadOKX, a.spreadDex)) };
      fs.writeFileSync(path.join(__dirname, 'arb-live.json'), JSON.stringify(liveData));
      // Write bot status for dashboard
      fs.writeFileSync(path.join(__dirname, 'bot-status.json'), JSON.stringify({
        version: BOT_VERSION,
        timestamp: new Date().toISOString(),
        okxHealthy,
        activeTradeCount: activeTradeCount(),
        pendingDex:   pendingDex.map(t=>({symbol:t.symbol,exchange:t.exchange,startTime:t.startTime,direction:t.direction})),
        pendingOkx:   pendingOkx.map(t=>({symbol:t.symbol,startTime:t.startTime,direction:t.direction,entryPrice:t.entryPrice})),
        pendingBybit: pendingBybit.map(t=>({symbol:t.symbol,startTime:t.startTime,direction:t.direction,entryPrice:t.entryPrice})),
        consecutiveWins,
        totalTrades,
        winningTrades,
        totalProfit,
        lastWalletClean,
        nextRebalanceCheck: lastWalletClean + WALLET_CLEAN_INTERVAL_MS,
        volatileMode: liveConfig.VOLATILE_MODE || false,
        smartSell: liveConfig.SMART_SELL !== false,
        skipOKX: liveConfig.POLICY_SKIP_OKX || POLICY_SKIP_OKX,
        skipBybit: liveConfig.POLICY_SKIP_BYBIT || POLICY_SKIP_BYBIT,
      }));
    } catch { /* ignore */ }
    await checkApproachAlerts(pairResults);
    for (const result of pairResults) {
      if (result.status !== 'fulfilled' || !result.value) continue;
      const r = result.value;
      if (isPairInFlight(r.pair.okxCcy)) continue;
      if (canDex && r.dexEnabled && r.spreadDex > r.dexThresh && r.netDex > 0 && r.estDex >= MIN_PROFIT) {
        if (!bestDex || r.spreadDex > bestDex.spreadPct)
          bestDex = { pair: r.pair, direction: 'BUY_DEX', spreadPct: r.spreadDex, quoteBuy: r.quoteBuy, tokenOut: r.tokenOut, exchange: r.bestBidCex };
      }
      const spreadBuffer = (liveConfig.MIN_SPREAD_BUFFER_PCT ?? 0) / 100;
      const okxThresh   = MIN_SPREAD_CEX * (1 + spreadBuffer);
      const bybitThresh = MIN_SPREAD_CEX * (1 + spreadBuffer);
      if (canOkx && r.okxViable && r.spreadOKX > okxThresh && r.netOKX > 0 && r.estOKX >= MIN_PROFIT) {
        if (!bestOkx || r.spreadOKX > bestOkx.spreadPct)
          bestOkx = { pair: r.pair, direction: 'BUY_OKX', spreadPct: r.spreadOKX, quoteBuy: r.quoteBuy, tokenOut: r.tokenOut, exchange: 'OKX' };
      }
      if (canBybit && r.bybit && r.bybitViable && r.spreadBybit > bybitThresh && r.netBybit > 0 && r.estBybit >= MIN_PROFIT) {
        if (!bestBybit || r.spreadBybit > bestBybit.spreadPct)
          bestBybit = { pair: r.pair, direction: 'BUY_BYBIT', spreadPct: r.spreadBybit, quoteBuy: r.quoteBuy, tokenOut: r.tokenOut, exchange: 'Bybit' };
      }
    }
    consecutiveErrors = 0;
    const toFire = [bestDex, bestOkx, bestBybit].filter(Boolean);
    if (toFire.length > 0) {
      // Claim ALL locks atomically before ANY execution begins
      // This prevents concurrent scans from firing on the same opportunities
      if (bestDex)   { dexLock   = true; executingDex   = true; }
      if (bestOkx)   { okxLock   = true; executingOkx   = true; }
      if (bestBybit) { bybitLock = true; executingBybit = true; }
      console.log(`\n🚨 Firing ${toFire.length} trade(s): ${toFire.map(t => `${t.direction}:${t.pair.name}`).join(', ')}`);
      await Promise.allSettled(toFire.map(opp => executeArb(opp)));
      // Release all locks and executing flags
      if (bestDex)   { dexLock   = false; executingDex   = false; }
      if (bestOkx)   { okxLock   = false; executingOkx   = false; }
      if (bestBybit) { bybitLock = false; executingBybit = false; }
    }

    // ── Kraken synthetic simulation (runs alongside real trades) ──────────────
    if (canKraken && krakenSynthetic && getKraken()) {
      const kraken   = getKraken();
      const kPairs   = kraken.KRAKEN_PAIRS || [];
      let bestKraken = null;
      let bestSpread = 0;
      for (const kPair of kPairs) {
        const kPrice = (kraken.krakenPrices || {})[kPair.wsPair];
        if (!kPrice) continue;
        // Find matching DEX price
        const dexPrice = await getCurrentDexPrice(kPair).catch(() => null);
        if (!dexPrice) continue;
        const spread = ((dexPrice - kPrice.ask) / kPrice.ask) * 100;
        const net    = spread - 0.40 - 0.30;
        const thresh = (liveConfig.MIN_SPREAD_CEX || 1.0) * (1 + (liveConfig.MIN_SPREAD_BUFFER_PCT || 20) / 100);
        if (net > thresh && net > bestSpread) {
          bestSpread  = net;
          bestKraken  = { pair: kPair, direction: 'BUY_KRAKEN', spreadPct: net, exchange: 'Kraken' };
        }
      }
      if (bestKraken) {
        const simKey = bestKraken.pair.name;
        const lastSim = simCooldowns[simKey] || 0;
        const SIM_COOLDOWN_MS = 15 * 60 * 1000; // 15 min between sim fires per pair
        if (Date.now() - lastSim > SIM_COOLDOWN_MS) {
          simCooldowns[simKey] = Date.now();
          krakenLock = true;
          console.log(`\n🔵 [SIM] Kraken fire: ${bestKraken.pair.name} spread ${bestKraken.spreadPct.toFixed(3)}%`);
          await simulateTrade(bestKraken).catch(err => logCrash('simulateTrade', err));
        }
      }
    }
  } catch (err) {
    consecutiveErrors++;
    logCrash('checkAndExecute', err);
    await new Promise(r => setTimeout(r, Math.min(consecutiveErrors * 10000, 300000)));
  }
}

// ── Execute single arb ────────────────────────────────────────────────────────
async function executeArb({ pair, direction, spreadPct, quoteBuy, tokenOut, exchange }) {
  const tradeId = `${pair.okxCcy}-${Date.now()}`;
  const symbol  = pair.name.split('/')[0];
  const ctx     = new TradeContext(tradeId, pair, direction, spreadPct, exchange);
  const logger  = new TradeLogger(tradeId, pair.name, direction, spreadPct, TRADE_SIZE_USD);

  if (direction === 'BUY_DEX')   executingDex   = true;
  if (direction === 'BUY_OKX')   executingOkx   = true;
  if (direction === 'BUY_BYBIT') executingBybit = true;

  try {
    const w        = await getWalletBalances();
    const okxBals  = await getOKXBalances();
    const bybitBal = await getBybitBalance('USDT');
    const walletUSDC = w.usdc;

    // Auto-rebalance if OKX drops below trade minimum
    if (okxHealthy && okxBals.usdt < TRADE_SIZE_USD && !rebalancing) {
      console.log(`⚠️  OKX $${okxBals.usdt.toFixed(0)} below $${TRADE_SIZE_USD} minimum — auto-rebalancing`);
      checkAndRebalance().catch(err => logCrash('autoRebalance', err));
    }

    logger.setBalanceBefore({ solana: w.usdc, okx: okxBals.usdt, bybit: bybitBal });
    const cexFee   = exchange === 'Bybit' ? BYBIT_FEE : OKX_FEE;
    const estProfit = (spreadPct / 100) * TRADE_SIZE_USD - (cexFee + DEX_FEE) * TRADE_SIZE_USD;

    logFire({ tradeId, pair: pair.name, direction, exchange, spreadPct, outcome: 'fired', reason: null, fundsAffected: false });
    // Single fire alert
    await sendAlert(
      `🚨 <b>${direction}: ${pair.name}</b>\n` +
      `Spread: ${spreadPct.toFixed(3)}% | Est: ${estProfit >= 0 ? '+' : ''}$${estProfit.toFixed(2)}\n` +
      `Exchange: ${exchange} | Wins: ${consecutiveWins}/${WINS_TARGET}`
    );

    if (direction === 'BUY_DEX') {
      if (w.usdc < TRADE_SIZE_USD) {
        await ctx.fail({ reason: `Insufficient USDC: $${w.usdc.toFixed(2)}`, fundsAffected: false });
        return;
      }
      try {
        await executeJupiterSwap(quoteBuy, ctx);
      } catch (err) {
        await ctx.fail({ reason: `Leg A failed: ${err.message?.slice(0, 100)}`, fundsAffected: false });
        throw err;
      }
      await new Promise(r => setTimeout(r, 3000));
      const rawReceived    = await getTokenBalance(pair.outputMint, pair.isNative);
      const rawAmount      = pair.isNative ? Math.floor(rawReceived * 1e9) : Math.floor(rawReceived);
      const expectedTokens = pair.isNative ? rawReceived : rawReceived / Math.pow(10, pair.decimals);
      if (rawReceived === 0 || expectedTokens < 0.000001) throw new Error('Zero balance after swap');
      const depositAddress = exchange === 'OKX'
        ? await getOKXDepositAddress(pair.okxCcy, pair.okxChain)
        : await getBybitDepositAddress(pair.bybitCcy);
      if (!depositAddress) throw new Error(`No deposit address for ${pair.bybitCcy}`);
      await sendTokenToAddress(pair, rawAmount, depositAddress);
      ctx.log(`Sent ${expectedTokens.toFixed(4)} ${symbol} to ${exchange}`);
      const legStartTime = Date.now();
      const tradeEntry   = { tradeId, symbol, direction: 'BUY_DEX', exchange, startTime: legStartTime, pair, expectedAmount: expectedTokens, tradeSizeUsd: TRADE_SIZE_USD, spreadPct, logger };
      pendingDex.push(tradeEntry);
      saveState();
      waitAndSellOnExchange(tradeEntry, ctx).catch(async (err) => { logCrash(`BUY_DEX legB [${tradeId}]`, err); removePending('dex', tradeId); saveState(); await ctx.fail({ reason: err.message, fundsAffected: true, autoFixed: 'Will auto-recover on next restart' }); });

    } else if (direction === 'BUY_OKX') {
      if (okxBals.usdt < TRADE_SIZE_USD) {
        await ctx.fail({ reason: `Insufficient OKX USDT: $${okxBals.usdt.toFixed(2)}`, fundsAffected: false });
        return;
      }
      const okxQty = tokenOut.toFixed(6);
      ctx.log(`Placing OKX order: ${okxQty} ${symbol}`);
      await okxPrivate('POST', '/api/v5/trade/order', { instId: pair.okxInstId, tdMode: 'cash', side: 'buy', ordType: 'market', sz: String(TRADE_SIZE_USD), tgtCcy: 'quote_ccy' });
      await new Promise(r => setTimeout(r, 3000));
      const actualBal = await getOKXTokenBal(pair.okxCcy);
      if (actualBal < 0.000001) {
        await ctx.fail({ reason: 'OKX order did not fill', fundsAffected: false });
        totalTrades--;
        return;
      }
      ctx.log(`OKX filled: ${actualBal.toFixed(4)} ${symbol} — withdrawing`);
      const grossAmount  = fmtOKX(actualBal, pair.okxCcy);
      const rawExpected  = Math.floor(actualBal * Math.pow(10, pair.decimals));
      const legStartTime = Date.now();
      try {
        await withdrawFromOKX(pair.okxCcy, pair.okxChain, grossAmount);
        ctx.log(`Withdrew ${symbol} from OKX — polling Solana`);
      } catch (err) {
        logCrash(`BUY_OKX withdrawal [${tradeId}]`, err);
        await ctx.alert(`Withdrawal failed: ${err.message}\nWill auto-recover on restart`);
      }
      const okxEntryPrice = actualBal > 0 ? TRADE_SIZE_USD / actualBal : 0;
      const tradeEntry = { tradeId, symbol, direction: 'BUY_OKX', exchange: 'OKX', startTime: legStartTime, pair, expectedRawAmount: rawExpected, tradeSizeUsd: TRADE_SIZE_USD, spreadPct, entryPrice: okxEntryPrice, logger };
      pendingOkx.push(tradeEntry);
      saveState();
      waitAndSwapBack(tradeEntry, ctx).catch(async (err) => { logCrash(`BUY_OKX legB [${tradeId}]`, err); removePending('okx', tradeId); saveState(); await ctx.fail({ reason: err.message, fundsAffected: true, autoFixed: 'Will auto-recover on next restart' }); });

    } else if (direction === 'BUY_BYBIT') {
      if (bybitBal < TRADE_SIZE_USD * 1.05) {
        await ctx.fail({ reason: `Insufficient Bybit USDT: $${bybitBal.toFixed(2)} (need $${(TRADE_SIZE_USD*1.05).toFixed(2)})`, fundsAffected: false });
        return;
      }
      const bybitQty = Math.floor(tokenOut).toString();
      if (parseFloat(bybitQty) < 1) {
        await ctx.fail({ reason: `Order qty too small: ${bybitQty} ${symbol}`, fundsAffected: false });
        return;
      }
      ctx.log(`Placing Bybit order: ${bybitQty} ${symbol}`);
      await placeBybitOrder('buy', bybitQty, pair.bybitInstId, TRADE_SIZE_USD);
      totalTrades++;
      await new Promise(r => setTimeout(r, BYBIT_SETTLE_DELAY_MS));
      const actualBal = await getBybitBalance(pair.bybitCcy);
      if (actualBal < 0.000001) {
        await ctx.fail({ reason: 'Bybit order did not fill', fundsAffected: false });
        totalTrades--;
        return;
      }
      ctx.log(`Bybit filled: ${actualBal.toFixed(4)} ${symbol} — withdrawing`);
      const rawExpected  = Math.floor(actualBal * Math.pow(10, pair.decimals));
      const legStartTime = Date.now();
      try {
        await withdrawFromBybit(pair.bybitCcy, pair.bybitChain, fmtBybit(actualBal, pair.bybitCcy));
        ctx.log(`Withdrew ${symbol} from Bybit — polling Solana`);
      } catch (err) {
        logCrash(`BUY_BYBIT withdrawal [${tradeId}]`, err);
        await ctx.alert(`Withdrawal failed: ${err.message}\nWill auto-recover on restart`);
      }
      const bybitEntryPrice = actualBal > 0 ? TRADE_SIZE_USD / actualBal : 0;
      const tradeEntry = { tradeId, symbol, direction: 'BUY_BYBIT', exchange: 'Bybit', startTime: legStartTime, pair, expectedRawAmount: rawExpected, tradeSizeUsd: TRADE_SIZE_USD, spreadPct, entryPrice: bybitEntryPrice, logger };
      pendingBybit.push(tradeEntry);
      saveState();
      waitAndSwapBack(tradeEntry, ctx).catch(async (err) => { logCrash(`BUY_BYBIT legB [${tradeId}]`, err); removePending('bybit', tradeId); saveState(); await ctx.fail({ reason: err.message, fundsAffected: true, autoFixed: 'Will auto-recover on restart' }); });
    }

    if (totalProfit <= -SESSION_STOP_LOSS) { await sendAlert(`⛔ <b>Stop loss hit</b> — down $${Math.abs(totalProfit).toFixed(2)}`); process.exit(1); }
  } catch (err) {
    logCrash(`executeArb [${tradeId}]`, err);
    consecutiveClean = 0; // reset — trade failed, may need intervention
  } finally {
    if (direction === 'BUY_DEX')   executingDex   = false;
    if (direction === 'BUY_OKX')   executingOkx   = false;
    if (direction === 'BUY_BYBIT') executingBybit = false;
  }
}

// ── Balance reporter ──────────────────────────────────────────────────────────
async function maybeReport() {
  const now      = Date.now();
  const utcHour  = new Date().getUTCHours();
  const isActive = utcHour >= ACTIVE_HOURS_START && utcHour < ACTIVE_HOURS_END;
  const interval = isActive ? 30 * 60 * 1000 : 2 * 60 * 60 * 1000;
  if (now - lastReportTime < interval) return;
  lastReportTime = now;
  await reportBalances();
  await maybeSendDailySummary();
}

async function reportBalances() {
  try {
    const w        = await getWalletBalances();
    const okxBals  = await getOKXBalances();
    const okxFund  = await getOKXFundingBal();
    const bybitBal = await getBybitBalance('USDT');
    const hour     = new Date().getUTCHours(), min = new Date().getUTCMinutes();
    const timeStr  = `${new Date().toLocaleTimeString()} UTC${hour}:${String(min).padStart(2,'0')}`;
    const isActive = hour >= ACTIVE_HOURS_START && hour < ACTIVE_HOURS_END;

    if (!startCapital) { startCapital = w.usdc + okxBals.usdt + bybitBal; saveState(); }
    if (okxFund > 1) await moveFundingToTrading();

    const peakReport = getPeakSpreadsReport();
    resetPeakSpreads();
    appendToLog(w, okxBals, bybitBal, peakReport);

    const total   = w.usdc + okxBals.usdt + okxFund + bybitBal;
    const gain    = total - startCapital;
    const gainPct = ((gain / startCapital) * 100).toFixed(1);
    const winsBar = '🟢'.repeat(consecutiveWins) + '⚪'.repeat(Math.max(0, WINS_TARGET - consecutiveWins));

    // In-flight trades
    const inFlight = [
      ...pendingDex.map(t   => `  DEX ${t.symbol}→${t.exchange} [${Math.round((Date.now()-t.startTime)/60000)}min]`),
      ...pendingOkx.map(t   => `  OKX ${t.symbol} [${Math.round((Date.now()-t.startTime)/60000)}min]`),
      ...pendingBybit.map(t => `  Bybit ${t.symbol} [${Math.round((Date.now()-t.startTime)/60000)}min]`),
    ];

    // Warnings
    const warnings = [];
    if (!okxHealthy)                        warnings.push('🔴 OKX offline');
    if (okxBals.usdt < BALANCE_FLOOR_USDT)  warnings.push(`⚠️ OKX low $${okxBals.usdt.toFixed(0)}`);
    if (bybitBal < TRADE_SIZE_USD * 1.05)   warnings.push(`⚠️ Bybit low $${bybitBal.toFixed(0)}`);
    if (w.usdc < TRADE_SIZE_USD)            warnings.push(`⚠️ Solana low $${w.usdc.toFixed(0)}`);

    // Console output
    console.log(`
${'─'.repeat(60)}`);
    console.log(`💼 ${BOT_VERSION} [${isActive?'ACTIVE':'quiet'}] — ${timeStr}`);
    console.log(`   Sol:$${w.usdc.toFixed(0)} OKX:$${okxBals.usdt.toFixed(0)} By:$${bybitBal.toFixed(0)} Total:$${total.toFixed(0)} | ${gain>=0?'+':''}$${gain.toFixed(2)} (${gainPct}%)`);
    console.log(`   Wins: ${winsBar} | Trades:${totalTrades} P&L:${totalProfit>=0?'+':''}$${totalProfit.toFixed(2)}`);
    console.log(`   Active: ${activeTradeLabel()}`);
    if (warnings.length) console.log(`   ⚠️  ${warnings.join(' | ')}`);
    console.log(`${'─'.repeat(60)}
`);

    // Telegram — compact single message
    const parts = [
      `💼 <b>${BOT_VERSION}</b> ${isActive?'🟢':'🌙'} ${timeStr}`,
      `Sol:$${w.usdc.toFixed(0)} OKX:$${okxBals.usdt.toFixed(0)}${!okxHealthy?'🔴':''} By:$${bybitBal.toFixed(0)} | <b>$${total.toFixed(0)}</b> ${gain>=0?'+':''}$${gain.toFixed(0)} (${gainPct}%)`,
      `🎯 ${winsBar} ${consecutiveWins}/${WINS_TARGET} | ${totalTrades}T ${winningTrades}W P&L:${totalProfit>=0?'+':''}$${totalProfit.toFixed(2)}`,
    ];
    if (inFlight.length) parts.push('⏳ In flight:\n' + inFlight.join('\n'));
    if (peakReport && peakReport !== 'No positive spreads this period') parts.push('📡 ' + peakReport);
    if (warnings.length) parts.push(warnings.join(' | '));
    await sendAlert(parts.join('\n'));
  } catch (err) { logCrash('reportBalances', err); }
}

// ── Startup ───────────────────────────────────────────────────────────────────
async function runStartupChecks() {
  console.log('\n🔍 Running startup checks...');
  // Auto-correct state vs trades.json
  try {
    if (fs.existsSync(TRADES_FILE)) {
      const trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
      const realTrades = trades.filter(t => t.direction !== 'RECOVERY');
      if (Math.abs(totalTrades - realTrades.length) > 2) {
        console.log(`⚠️  State mismatch: totalTrades=${totalTrades} but trades.json has ${realTrades.length} — auto-correcting`);
        totalTrades   = realTrades.length;
        winningTrades = realTrades.filter(t => t.profit > 0).length;
        totalProfit   = realTrades.reduce((a, t) => a + (t.profit || 0), 0);
        let c = 0;
        for (let i = realTrades.length - 1; i >= 0; i--) {
          if (realTrades[i].profit > 0) c++; else break;
        }
        consecutiveWins = c;
        // Recalculate consecutiveClean — count from end until a crash/recovery
        // consecutiveClean stays at 0 on restart - counts from this session only
        await saveState();
        console.log(`✅ State corrected: ${totalTrades} trades, ${winningTrades}W, P&L $${totalProfit.toFixed(2)}, ${consecutiveWins} consec wins`);
      }
    }
  } catch (err) { logCrash('startupIntegrityCheck', err); }
  if (fs.existsSync(CRASH_LOG)) {
    const content = fs.readFileSync(CRASH_LOG, 'utf8').trim();
    if (content) {
      const lastCrash = content.split('\n\n').filter(Boolean).pop();
      console.log(`⚠️  Last crash:\n${lastCrash}`);
    }
  }
  await checkOKXHealth();
  try { await moveFundingToTrading(); } catch (err) { logCrash('startup:moveFunding', err); }
  await new Promise(r => setTimeout(r, 2000));
  await loadDynamicPairs();
  await refreshCoinViability();
  await runRecoveryChecks();
  const w = await getWalletBalances(), okxBals = await getOKXBalances(), okxFunding = await getOKXFundingBal(), bybitBal = await getBybitBalance('USDT');
  const total = w.usdc + okxBals.usdt + okxFunding + bybitBal;
  console.log(`\n💼 Capital Summary:`);
  console.log(`   Solana USDC:      $${w.usdc.toFixed(2)}`);
  console.log(`   Solana SOL:       ${w.sol.toFixed(4)}`);
  console.log(`   OKX trading USDT: $${okxBals.usdt.toFixed(2)}${!okxHealthy?' [OFFLINE]':''}`);
  console.log(`   OKX funding USDT: $${okxFunding.toFixed(2)}`);
  console.log(`   Bybit USDT:       $${bybitBal.toFixed(2)}`);
  console.log(`   Total liquid:     $${total.toFixed(2)}`);
  console.log(`   Trade size:       $${TRADE_SIZE_USD}`);
  console.log(`   OKX health:       ${okxHealthy ? '✅ online' : '❌ offline'}`);
  console.log('\n✅ Startup checks complete\n');
}


// ── Telegram command polling ──────────────────────────────────────────────────
let lastTelegramUpdateId = 0;
async function pollTelegramCommands() {
  try {
    const token  = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${lastTelegramUpdateId + 1}&timeout=0`);
    const j = await r.json();
    if (!j.ok || !j.result?.length) return;
    for (const update of j.result) {
      lastTelegramUpdateId = update.update_id;
      const text = update.message?.text?.trim().toLowerCase();
      if (!text) continue;
      if (text === '/volatile') {
        const configFile = path.join(__dirname, 'arb-config.json');
        const c = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        c.VOLATILE_MODE = true;
        fs.writeFileSync(configFile, JSON.stringify(c, null, 2));
        resetAllBands();
        await sendAlert('🟡 <b>Volatile mode ON</b>\nApproach bands lowered — earlier warnings\nAuto-resets in 4hrs or send /normal'); setTimeout(async () => { try { const c2 = JSON.parse(fs.readFileSync(configFile, 'utf8')); if (c2.VOLATILE_MODE) { c2.VOLATILE_MODE = false; fs.writeFileSync(configFile, JSON.stringify(c2, null, 2)); await sendAlert('🔵 <b>Volatile mode auto-reset</b> after 4hrs'); } } catch { } }, 4 * 60 * 60 * 1000);
      } else if (text === '/normal') {
        const configFile = path.join(__dirname, 'arb-config.json');
        const c = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        c.VOLATILE_MODE = false;
        fs.writeFileSync(configFile, JSON.stringify(c, null, 2));
        resetAllBands();
        await sendAlert('🔵 <b>Normal mode restored</b>\nApproach bands back to standard');
      } else if (text === '/test') {
        if (testRunning) {
          await sendAlert('⚠️ Test already running');
        } else {
          runExchangeTests('Telegram /test command').catch(err => logCrash('runExchangeTests', err));
          await sendAlert('🧪 Test queued — will report when complete');
        }
      } else if (text === '/morning') {
        await sendMorningReport(true); // force send regardless of guard
      } else if (text.startsWith('/smartsell')) {
        const configFile = path.join(__dirname, 'arb-config.json');
        const c = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        const on = text.includes('on');
        const off = text.includes('off');
        if (on || off) {
          c.SMART_SELL = on;
          fs.writeFileSync(configFile, JSON.stringify(c, null, 2));
          await sendAlert((on ? '🧠 <b>Smart sell ON</b>\nBot will hold tokens until conditions are favourable' : '🔵 <b>Smart sell OFF</b>\nBot will sell immediately on arrival'));
        } else {
          const status = c.SMART_SELL !== false ? 'ON 🧠' : 'OFF';
          await sendAlert('Smart sell: ' + status + '\nUse /smartsell on or /smartsell off');
        }
      } else if (text.startsWith('/addpair')) {
        const ccy = text.replace('/addpair', '').trim();
        handleAddPair(ccy).catch(err => logCrash('handleAddPair', err));
      } else if (text.startsWith('/removepair')) {
        const ccy = text.replace('/removepair', '').trim();
        handleRemovePair(ccy).catch(err => logCrash('handleRemovePair', err));
      } else if (text === '/pairs') {
        const staticList  = PAIRS.map(p => p.okxCcy).join(', ');
        const dynamicList = dynamicPairs.map(p => p.okxCcy + ' (dynamic)').join(', ') || 'none';
        await sendAlert('📋 <b>Active pairs</b>\nStatic: ' + staticList + '\nDynamic: ' + dynamicList);
      } else if (text === '/rebalance' || text === '/rebalance confirm') {
        const confirm = text.includes('confirm');
        handleRebalanceCommand(confirm).catch(err => logCrash('handleRebalanceCommand', err));
      } else if (text === '/holdings') {
        const held = [...pendingOkx, ...pendingBybit].filter(t => t.entryPrice);
        if (held.length === 0) {
          await sendAlert('📦 No holdings currently');
        } else {
          const lines = await Promise.all(held.map(async t => {
            const price = await getCurrentDexPrice(t.pair).catch(() => null);
            const pct   = price && t.entryPrice ? ((price - t.entryPrice) / t.entryPrice * 100).toFixed(2) : '?';
            const heldMin = Math.round((Date.now() - t.startTime) / 1000 / 60);
            return t.symbol + ' ' + heldMin + 'min | entry:$' + t.entryPrice.toFixed(6) + ' now:' + (price ? '$' + price.toFixed(6) : '?') + ' (' + pct + '%)';
          }));
          await sendAlert('📦 <b>Current holdings</b>\n' + lines.join('\n'));
        }
      } else if (text === '/bands') {
        const bands  = getApproachBands();
        const active = isApproachActive();
        const vol    = liveConfig.VOLATILE_MODE === true;
        await sendAlert(
          `📡 <b>Approach Alert Status</b>
` +
          `Mode: ${vol ? '🟡 Volatile' : '🔵 Normal'}
` +
          `Active: ${active ? '✅ Yes' : '❌ No (outside hours)'}
` +
          `Bands:
` +
          bands.map(b => '  ' + b.pct + '% — cooldown ' + b.cooldown_min + 'min').join('\n')
        );
      }
    }
  } catch (err) { /* ignore polling errors */ }
}



// ── Exchange test suite runner ────────────────────────────────────────────────
let testRunning  = false;
let rebalancing  = false;
let okxLock      = false; // atomic lock — prevents race condition on concurrent scans
let lastOkxWsMsg = Date.now();  // WS watchdog — tracks last message received
let bybitLock    = false;
let dexLock      = false;
let krakenLock      = false; // Kraken atomic lock (disabled until KRAKEN_ENABLED: true)
const simCooldowns = {};   // pair → last sim fire timestamp, 15min cooldown
let executingKraken = false;
let _krakenMod   = null;
function getKraken() {
  if (!_krakenMod) {
    try { _krakenMod = require('./kraken-scaffold'); } catch { return null; }
  }
  return _krakenMod;
}
let lastTestDate = null;

async function runExchangeTests(triggeredBy = 'manual') {
  if (testRunning) {
    await sendAlert('⚠️ Test already running — please wait');
    return;
  }
  testRunning = true;
  console.log('\n🧪 Starting exchange test suite...');
  await sendAlert('🧪 <b>Exchange test starting</b>\nTrading paused during test\nTriggered by: ' + triggeredBy);

  try {
    const { execFile } = require('child_process');
    const testScript   = path.join(__dirname, 'test-exchange.js');
    const applyScript  = path.join(__dirname, 'apply-results.js');

    // Run test-exchange.js
    await new Promise((resolve, reject) => {
      const proc = execFile(process.execPath, [testScript], { cwd: __dirname, timeout: 10 * 60 * 1000 }, (err, stdout, stderr) => {
        if (stdout) console.log(stdout);
        if (err) reject(err); else resolve();
      });
    });

    // Run apply-results.js
    const { applyResults, buildTelegramSummary } = require('./apply-results.js');
    const resultsFile = path.join(__dirname, 'exchange-test-results.json');
    const configFile  = path.join(__dirname, 'arb-config.json');
    const result      = applyResults(resultsFile, configFile, false);
    const testResults = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    const msg         = buildTelegramSummary(result, testResults.summary);

    lastTestDate = new Date().toISOString();
    loadLiveConfig(); // reload immediately
    await sendAlert(msg);
    console.log('\n✅ Exchange test complete — config updated');
  } catch (err) {
    logCrash('runExchangeTests', err);
    await sendAlert('❌ <b>Exchange test failed</b>\n' + err.message?.slice(0, 100));
  } finally {
    testRunning = false;
  }
}

async function maybeRunWeeklyTest() {
  const now = new Date();
  if (now.getUTCDay() !== 0) return;      // Sunday only
  if (now.getUTCHours() !== 6) return;    // 06:00 UTC
  if (now.getUTCMinutes() > 2) return;    // within first 2 minutes
  const today = now.toISOString().slice(0, 10);
  if (lastTestDate && lastTestDate.startsWith(today)) return; // already ran today
  await runExchangeTests('weekly schedule');
}



// ── Synthetic trade simulation ────────────────────────────────────────────────
// Runs alongside real trades when KRAKEN_SYNTHETIC: true
// Uses live prices, no real money moved
async function simulateTrade({ pair, direction, spreadPct, exchange }) {
  const tradeId = `SIM-${pair.okxCcy}-${Date.now()}`;
  const symbol  = pair.name.split('/')[0];
  const logger  = new TradeLogger(tradeId, pair.name, `SIM_${direction}`, spreadPct, TRADE_SIZE_USD);
  executingKraken = true;
  krakenLock = true;

  try {
    // Snapshot balances (real balances for reference)
    const w       = await getWalletBalances();
    const okxBals = await getOKXBalances();
    logger.setBalanceBefore({ solana: w.usdc, okx: okxBals.usdt, bybit: 0 });

    // Get current Kraken ask price
    const kraken  = getKraken();
    const kPrices = kraken?.krakenPrices || {};
    const kPrice  = kPrices[pair.wsPair || pair.name];
    if (!kPrice) throw new Error('No Kraken price for ' + pair.name);

    const entryPrice = kPrice.ask;
    const tokenQty   = TRADE_SIZE_USD / entryPrice;
    logger.log('SIM_BUY', `simulated buy ${tokenQty.toFixed(4)} ${symbol} @ $${entryPrice.toFixed(6)} on Kraken`);

    await sendAlert(
      `🚨 [SIM] BUY_KRAKEN: ${pair.name}\n` +
      `Spread: ${spreadPct.toFixed(3)}% | ~${tokenQty.toFixed(2)} ${symbol} @ $${entryPrice.toFixed(4)}\n` +
      `[SIMULATION — no real funds moved]`
    );

    // Simulate withdrawal delay (10s in sim mode instead of real 2-15min)
    logger.log('SIM_WITHDRAW', 'simulating withdrawal — 10s delay');
    await new Promise(r => setTimeout(r, 10000));

    // Get current DEX price for Leg B simulation
    const dexPrice = await getCurrentDexPrice(pair);
    const usdcOut  = dexPrice
      ? tokenQty * dexPrice
      : TRADE_SIZE_USD * (1 + spreadPct / 100 - 0.007); // fallback estimate
    const profit = usdcOut - TRADE_SIZE_USD;

    logger.log('SIM_SWAP', `simulated DEX swap → $${usdcOut.toFixed(4)} USDC (dexPrice:$${dexPrice?.toFixed(6) || 'est'})`);
    logger.complete(profit, usdcOut, 0.17); // ~10s duration

    // Log as SIM trade — tracks in trade-log.json but not trades.json P&L
    const simEntry = {
      date:        new Date().toISOString(),
      tradeId,
      pair:        pair.name,
      direction:   `SIM_KRAKEN`,
      exchange:    'Kraken',
      spreadPct,
      profit,
      usdcOut,
      tradeSizeUsd: TRADE_SIZE_USD,
      durationMin: 0,
      synthetic:   true,
    };
    // Write to sim-trades.json separately — doesn't affect real P&L
    try {
      const simFile = path.join(__dirname, 'sim-trades.json');
      let sims = [];
      if (fs.existsSync(simFile)) try { sims = JSON.parse(fs.readFileSync(simFile, 'utf8')); } catch {}
      sims.push(simEntry);
      fs.writeFileSync(simFile, JSON.stringify(sims.slice(-200), null, 2));
    } catch {}

    logFire({ date: new Date().toISOString(), pair: pair.name, direction: `SIM_KRAKEN`, outcome: profit > 0 ? 'success' : 'loss', profit, spreadPct, synthetic: true });

    await sendAlert(
      `${profit >= 0 ? '✅' : '⚠️'} [SIM] Kraken ${pair.name} completed\n` +
      `P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(4)} | Entry: $${entryPrice.toFixed(4)} DEX: $${dexPrice?.toFixed(4) || 'est'}\n` +
      `[SIMULATION — based on live prices]`
    );

  } catch (err) {
    logCrash(`simulateTrade [${tradeId}]`, err);
    logger.fail(err.message, false, 'SIM');
    await sendAlert(`❌ [SIM] Kraken ${pair.name} sim failed: ${err.message.slice(0, 80)}`);
  } finally {
    executingKraken = false;
    krakenLock = false;
  }
}

// ── /addpair command handler ──────────────────────────────────────────────────
async function handleAddPair(ccy) {
  ccy = ccy.toUpperCase().trim();
  if (!ccy) { await sendAlert('Usage: /addpair SYMBOL (e.g. /addpair BONK)'); return; }

  // Check not already in static PAIRS
  if ([...PAIRS, ...dynamicPairs].find(p => p.okxCcy === ccy)) {
    await sendAlert(`⚠️ ${ccy} already in bot PAIRS`); return;
  }

  await sendAlert(`🔍 <b>Testing ${ccy}</b>...\nChecking OKX + Bybit + Solana compatibility`);

  const result = { ccy, okx: {}, bybit: {}, solana: {}, viable: false, reason: '' };

  // ── 1. OKX check ─────────────────────────────────────────────────────────
  try {
    const instId = ccy + '-USDT';
    const pr = await fetch('https://www.okx.com/api/v5/market/ticker?instId=' + instId);
    const pj = await pr.json();
    const price = parseFloat(pj.data?.[0]?.last || '0');
    if (!price) { result.reason = 'Not listed on OKX'; await sendAlert('❌ ' + ccy + ': ' + result.reason); return; }
    result.okx.price = price;
    result.okx.instId = instId;

    // Get lot size
    const lr = await fetch('https://www.okx.com/api/v5/public/instruments?instType=SPOT&instId=' + instId);
    const lj = await lr.json();
    result.okx.lotSz  = parseFloat(lj.data?.[0]?.lotSz || 0.01);
    result.okx.minSz  = parseFloat(lj.data?.[0]?.minSz || 0);

    // Get withdrawal info
    const ts = new Date().toISOString();
    const wpath = '/api/v5/asset/currencies?ccy=' + ccy;
    const wr = await okxPrivate('GET', '/api/v5/asset/currencies?ccy=' + ccy);
    const sol = (wr.data || []).find(d => d.chain?.includes('Solana'));
    if (!sol) { result.reason = 'No Solana withdrawal chain on OKX'; await sendAlert('❌ ' + ccy + ': ' + result.reason); return; }
    if (sol.canWd !== true && sol.canWd !== '1') { result.reason = 'OKX withdrawals disabled'; await sendAlert('❌ ' + ccy + ': ' + result.reason); return; }
    result.okx.fee     = parseFloat(sol.minFee);
    result.okx.minWd   = parseFloat(sol.minWd);
    result.okx.chain   = sol.chain;
    result.okx.feePct  = (result.okx.fee / (TRADE_SIZE_USD / price) * 100);
    if (result.okx.feePct > MAX_WITHDRAWAL_FEE_PCT) {
      result.reason = 'OKX withdrawal fee too high: ' + result.okx.feePct.toFixed(2) + '%';
      await sendAlert('❌ ' + ccy + ': ' + result.reason); return;
    }
    result.okx.viable = true;
  } catch (err) { result.reason = 'OKX error: ' + err.message?.slice(0,60); await sendAlert('❌ ' + ccy + ': ' + result.reason); return; }

  // ── 2. Find Solana mint via Jupiter ──────────────────────────────────────
  try {
    const jr = await fetch('https://api.jup.ag/tokens/v1/search?query=' + ccy + '&verify_token=true');
    const jj = await jr.json();
    const token = (jj.tokens || jj || []).find(t => t.symbol?.toUpperCase() === ccy && t.extensions?.coingeckoId);
    if (!token?.address) { result.reason = 'No verified Solana mint found'; await sendAlert('❌ ' + ccy + ': ' + result.reason); return; }
    result.solana.mint     = token.address;
    result.solana.decimals = token.decimals || 6;
    result.solana.viable   = true;
  } catch (err) { result.reason = 'Jupiter error: ' + err.message?.slice(0,60); await sendAlert('❌ ' + ccy + ': ' + result.reason); return; }

  // ── 3. Bybit check (optional) ─────────────────────────────────────────────
  try {
    const br = await fetch('https://api.bybit.com/v5/market/tickers?category=spot&symbol=' + ccy + 'USDT');
    const bj = await br.json();
    const price = parseFloat(bj.result?.list?.[0]?.lastPrice || '0');
    if (price > 0) {
      const cr = await bybitPrivate('GET', '/v5/asset/coin/query-info', { coin: ccy });
      const chains = cr.result?.rows?.[0]?.chains || [];
      const solChain = chains.find(c => c.chain === 'SOL' || c.chainType?.includes('Solana'));
      if (solChain && solChain.chainWithdraw === '1') {
        result.bybit.viable   = true;
        result.bybit.instId   = ccy + 'USDT';
        result.bybit.fee      = parseFloat(solChain.withdrawFee || 0);
        result.bybit.feePct   = (result.bybit.fee / (TRADE_SIZE_USD / price) * 100);
        if (result.bybit.feePct > MAX_WITHDRAWAL_FEE_PCT) result.bybit.viable = false;
      }
    }
  } catch { result.bybit.viable = false; }

  // ── 4. Check DEX liquidity ────────────────────────────────────────────────
  try {
    const qr = await fetch('https://api.jup.ag/swap/v1/quote?inputMint=' + USDC_MINT + '&outputMint=' + result.solana.mint + '&amount=' + Math.floor(TRADE_SIZE_USD * 1e6) + '&slippageBps=100', { headers: { 'x-api-key': process.env.JUPITER_API_KEY } });
    const qj = await qr.json();
    result.solana.dexLiquidity = qj.outAmount ? true : false;
    result.solana.dexEnabled   = result.solana.dexLiquidity;
  } catch { result.solana.dexEnabled = false; }

  // ── 5. Build pair entry and add to new-pairs.json ─────────────────────────
  const newPair = {
    name:        ccy + '/USDT',
    okxInstId:   ccy + '-USDT',
    bybitInstId: result.bybit.viable ? ccy + 'USDT' : null,
    outputMint:  result.solana.mint,
    decimals:    result.solana.decimals,
    dex:         null,
    isNative:    false,
    okxCcy:      ccy,
    okxChain:    result.okx.chain,
    bybitCcy:    result.bybit.viable ? ccy : null,
    bybitChain:  result.bybit.viable ? 'SOL' : null,
    buyDexEnabled: result.solana.dexEnabled,
    addedAt:     new Date().toISOString(),
    expiresAt:   new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
    source:      'manual',
  };

  // Save to new-pairs.json
  let pairs = [];
  if (fs.existsSync(NEW_PAIRS_FILE)) {
    try { pairs = JSON.parse(fs.readFileSync(NEW_PAIRS_FILE, 'utf8')); } catch {}
  }
  pairs = pairs.filter(p => p.okxCcy !== ccy); // remove if exists
  pairs.push(newPair);
  fs.writeFileSync(NEW_PAIRS_FILE, JSON.stringify(pairs, null, 2));

  const okxFeeStr   = result.okx.feePct.toFixed(2) + '%';
  const bybitStr    = result.bybit.viable ? '✅ viable (fee ' + result.bybit.feePct.toFixed(2) + '%)' : '❌ not viable';
  const dexStr      = result.solana.dexEnabled ? '✅ liquidity found' : '⚠️ low liquidity';

  await sendAlert(
    '✅ <b>' + ccy + ' added to bot</b>\n' +
    'OKX: ✅ fee ' + okxFeeStr + '\n' +
    'Bybit: ' + bybitStr + '\n' +
    'DEX: ' + dexStr + '\n' +
    'Mint: ' + result.solana.mint.slice(0,16) + '...\n' +
    'Bot will start scanning ' + ccy + ' within 30s\n' +
    'Remove with /removepair ' + ccy
  );

  // Reload dynamic pairs immediately
  lastDynamicPairsLoad = 0;
  await loadDynamicPairs();
}

async function handleRemovePair(ccy) {
  ccy = ccy.toUpperCase().trim();
  if (!ccy) { await sendAlert('Usage: /removepair SYMBOL'); return; }
  if ([...PAIRS].find(p => p.okxCcy === ccy)) {
    await sendAlert('❌ ' + ccy + ' is a static pair — cannot remove via command. Edit PAIRS in okx-arb.js'); return;
  }
  let pairs = [];
  if (fs.existsSync(NEW_PAIRS_FILE)) {
    try { pairs = JSON.parse(fs.readFileSync(NEW_PAIRS_FILE, 'utf8')); } catch {}
  }
  const before = pairs.length;
  pairs = pairs.filter(p => p.okxCcy !== ccy);
  fs.writeFileSync(NEW_PAIRS_FILE, JSON.stringify(pairs, null, 2));
  dynamicPairs = dynamicPairs.filter(p => p.okxCcy !== ccy);
  if (pairs.length < before) {
    await sendAlert('🗑️ <b>' + ccy + ' removed</b>\nBot will stop scanning within 30s');
  } else {
    await sendAlert('⚠️ ' + ccy + ' not found in dynamic pairs');
  }
}


// ── Manual rebalance command ──────────────────────────────────────────────────
async function handleRebalanceCommand(confirm = false) {
  try {
    const w        = await getWalletBalances();
    const okxBals  = await getOKXBalances();
    const bybitBal = await getBybitBalance('USDT');

    const solana   = w.usdc;
    const okx      = okxBals.usdt;
    const bybit    = bybitBal;
    const total    = solana + okx + bybit;

    // Targets — configurable via arb-config.json
    const targetSolana = liveConfig.REBALANCE_TARGET_SOLANA ?? 200;
    const targetOKX    = liveConfig.REBALANCE_TARGET_OKX    ?? 350;
    const targetBybit  = liveConfig.REBALANCE_TARGET_BYBIT  ?? 300;

    const solanaExcess  = Math.max(0, solana - targetSolana);
    const okxShortfall  = Math.max(0, targetOKX   - okx);
    const bybitShortfall= Math.max(0, targetBybit - bybit);
    const totalShortfall= okxShortfall + bybitShortfall;

    // Calculate transfer amounts
    let toOKX   = 0;
    let toBybit = 0;
    if (solanaExcess > 10 && totalShortfall > 10) {
      const budget = Math.min(solanaExcess, totalShortfall);
      if (okxShortfall >= bybitShortfall) {
        toOKX   = Math.min(okxShortfall, budget);
        toBybit = Math.min(bybitShortfall, Math.max(0, budget - toOKX));
      } else {
        toBybit = Math.min(bybitShortfall, budget);
        toOKX   = Math.min(okxShortfall, Math.max(0, budget - toBybit));
      }
    }

    const statusMsg =
      '\u2696\ufe0f <b>Rebalance Check</b>\n' +
      'Sol: $' + solana.toFixed(0) + ' | OKX: $' + okx.toFixed(0) + ' | By: $' + bybit.toFixed(0) + '\n' +
      'Total: $' + total.toFixed(0) + '\n\n' +
      '<b>Targets:</b> Sol:$' + targetSolana + ' OKX:$' + targetOKX + ' By:$' + targetBybit + '\n\n';

    if (toOKX < 5 && toBybit < 5) {
      await sendAlert(statusMsg + '\u2705 Balances within target range — no action needed');
      return;
    }

    const planMsg = statusMsg +
      '<b>Plan:</b>\n' +
      (toOKX   > 5 ? '\u2192 Move $' + toOKX.toFixed(0)   + ' Solana \u2192 OKX\n'   : '') +
      (toBybit > 5 ? '\u2192 Move $' + toBybit.toFixed(0) + ' Solana \u2192 Bybit\n' : '') +
      '\n';

    if (!confirm) {
      await sendAlert(planMsg + 'Reply /rebalance confirm to execute');
      return;
    }

    // Pause scanning during rebalance to avoid Jupiter rate limits
    rebalancing = true;
    await sendAlert(planMsg + '\u23f3 Executing... (scanning paused)');
    await new Promise(r => setTimeout(r, 2000)); // let any in-flight scan finish

    // Transfer to OKX: USDC→USDT on Solana, send to OKX deposit address
    if (toOKX > 5) {
      try {
        const usdtOut     = await swapUSDCtoUSDT(toOKX);
        await new Promise(r => setTimeout(r, 3000));
        const depositAddr = await getOKXDepositAddress('USDT', 'USDT-Solana');
        const rawUSDT     = Math.floor(usdtOut * 1e6);
        const usdtMintPk  = new PublicKey(USDT_MINT);
        const destPubkey  = new PublicKey(depositAddr);
        const fromAta     = await getAssociatedTokenAddress(usdtMintPk, wallet.publicKey);
        const toAta       = await getAssociatedTokenAddress(usdtMintPk, destPubkey);
        // Create dest ATA in separate tx first if needed
        try { await getAccount(connection, toAta); }
        catch {
          const createTx = new Transaction();
          createTx.add(createAssociatedTokenAccountInstruction(wallet.publicKey, toAta, destPubkey, usdtMintPk));
          const cs = await connection.sendTransaction(createTx, [wallet]);
          await connection.confirmTransaction(cs, 'confirmed');
          await new Promise(r => setTimeout(r, 2000));
        }
        // Transfer in separate tx
        const transferTx = new Transaction();
        transferTx.add(createTransferInstruction(fromAta, toAta, wallet.publicKey, rawUSDT));
        const sig = await connection.sendTransaction(transferTx, [wallet]);
        await connection.confirmTransaction(sig, 'confirmed');
        await sendAlert('\u2705 Sent $' + toOKX.toFixed(0) + ' USDT to OKX\nArrives in 5-15min');
      } catch (err) {
        logCrash('manualRebalance:OKX', err);
        await sendAlert('\u26a0\ufe0f OKX transfer failed: ' + err.message.slice(0, 80));
      }
    }

    // Transfer to Bybit: USDC→USDT on Solana, send to Bybit deposit address
    if (toBybit > 5) {
      try {
        const usdtOut     = await swapUSDCtoUSDT(toBybit);
        await new Promise(r => setTimeout(r, 3000));
        const depositAddr = await getBybitDepositAddress('USDT');
        if (!depositAddr) throw new Error('No Bybit USDT deposit address');
        const rawUSDT     = Math.floor(usdtOut * 1e6);
        const usdtMintPk  = new PublicKey(USDT_MINT);
        const destPubkey  = new PublicKey(depositAddr);
        const fromAta     = await getAssociatedTokenAddress(usdtMintPk, wallet.publicKey);
        const toAta       = await getAssociatedTokenAddress(usdtMintPk, destPubkey);
        // Create dest ATA in separate tx first if needed
        try { await getAccount(connection, toAta); }
        catch {
          const createTx = new Transaction();
          createTx.add(createAssociatedTokenAccountInstruction(wallet.publicKey, toAta, destPubkey, usdtMintPk));
          const cs = await connection.sendTransaction(createTx, [wallet]);
          await connection.confirmTransaction(cs, 'confirmed');
          await new Promise(r => setTimeout(r, 2000));
        }
        // Transfer in separate tx
        const transferTx = new Transaction();
        transferTx.add(createTransferInstruction(fromAta, toAta, wallet.publicKey, rawUSDT));
        const sig = await connection.sendTransaction(transferTx, [wallet]);
        await connection.confirmTransaction(sig, 'confirmed');
        await sendAlert('\u2705 Sent $' + toBybit.toFixed(0) + ' USDT to Bybit\nArrives in 5-15min');
      } catch (err) {
        logCrash('manualRebalance:Bybit', err);
        await sendAlert('\u26a0\ufe0f Bybit transfer failed: ' + err.message.slice(0, 80));
      }
    }

  } catch (err) {
    logCrash('handleRebalanceCommand', err);
    await sendAlert('\u26a0\ufe0f Rebalance error: ' + err.message.slice(0, 100));
  } finally {
    rebalancing = false;
    console.log('Rebalancing complete — scanning resumed');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const dexOn = PAIRS.filter(p => p.buyDexEnabled !== false).map(p => p.okxCcy);
  console.log(`⚡ OKX + Bybit Arb Bot — ${BOT_VERSION}`);
  console.log(`   Trade size:      $${TRADE_SIZE_USD}`);
  console.log(`   Clean messaging: 1 fire alert + 1 outcome per trade ✅`);
  console.log(`   Live config:     arb-config.json (no restart needed) ✅`);
  console.log(`   Recovery:        auto-scan OKX + Bybit + wallet ✅`);
  console.log(`   OKX health:      health check + silent REST drops ✅`);
  console.log(`   OKX WS:          port 443, 10s ping, 1s reconnect ✅`);
  console.log(`   Smart sell:      hold until spread recovers ✅`);
  console.log(`   Morning report:  07:00 UTC daily ✅`);
  console.log(`   Fire logging:    fires.json ✅`);
  console.log(`   Exchange tests:  /test command, weekly Sunday 06:00 UTC ✅`);
  console.log(`   Wallet cleaner:  background every 15min ✅`);
  console.log(`   Dynamic pairs:   /addpair /removepair /pairs ✅`);
  console.log(`   WINS_TARGET:     ${WINS_TARGET}`);
  console.log(`   BUY_DEX on:      ${dexOn.join(', ')}`);
  console.log(`   Static pairs:    ${PAIRS.length}\n`);

  await runStartupChecks();

  await sendAlert(
    `✅ <b>${BOT_VERSION} online</b> | ${okxHealthy?'OKX ✅':'OKX 🔴'} | Wins:${consecutiveWins}/${WINS_TARGET} | P&L:${totalProfit>=0?'+':''}$${totalProfit.toFixed(2)}`
  );
    startOKXWS();
  startBybitWS();
  loadLiveConfig(); // ensure config loaded before Kraken check
  // Start Kraken WS if enabled
  if (liveConfig.KRAKEN_ENABLED && getKraken()) {
    console.log('🔄 Starting Kraken WebSocket...');
    getKraken().startKrakenWS();
    await getKraken().refreshKrakenViability();
  }

  console.log('⏳ Waiting for price feeds...');
  await new Promise(r => setTimeout(r, 3000));
  feedsReady = true;
  console.log('✅ Price feeds ready — scanning active');

  setInterval(async () => {
    try { await pollTelegramCommands(); }
    catch (err) { logCrash('pollTelegramCommands', err); }
  }, 5000);

  setInterval(async () => {
    try { await pollTelegramCommands(); }
    catch (err) { logCrash('pollTelegramCommands', err); }
  }, 5000);

  setInterval(async () => {
    try { await checkAndExecute(); }
    catch (err) { logCrash('checkAndExecute interval', err); }
  }, 2000);

  setInterval(async () => {
    try { await maybeReport(); }
    catch (err) { logCrash('maybeReport interval', err); }
  }, 60 * 1000);

  // Dedicated morning report check — runs every minute to ensure 07:00 UTC fires
  setInterval(async () => {
    try { await maybeSendDailySummary(); }
    catch (err) { logCrash('morningReport interval', err); }
  }, 60 * 1000);

  // Weekly exchange test — Sunday 06:00 UTC
  setInterval(async () => {
    try { await maybeRunWeeklyTest(); }
    catch (err) { logCrash('maybeRunWeeklyTest', err); }
  }, 60 * 1000);

  setInterval(async () => {
    try {
      const to = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000));
      await Promise.race([checkAndRebalance(), to]);
    }
    catch (err) { logCrash('checkAndRebalance', err); }
  }, 30 * 60 * 1000);

  // Balance sync every 5 minutes — keeps dashboard accurate
  setInterval(async () => {
    try {
      const [w, okxBals, bybitBal] = await Promise.all([
        getWalletBalances(),
        getOKXBalances(),
        getBybitBalance('USDT'),
      ]);
      // Write live balances to bot-status so dashboard stays current
      const statusFile = path.join(__dirname, 'bot-status.json');
      const existing = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      existing.liveBalances = {
        solana: w.usdc,
        okx: okxBals.usdt,
        bybit: bybitBal,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(statusFile, JSON.stringify(existing, null, 2));
    } catch(err) { logCrash('balanceSync', err); }
  }, 5 * 60 * 1000);

  // Background wallet cleaner — every 15 minutes
  setInterval(async () => {
    try { await backgroundWalletClean(); }
    catch (err) { logCrash('backgroundWalletClean', err); }
  }, 60 * 1000);

  await reportBalances();
  lastReportTime = Date.now();
}

main().catch(err => logCrash('main', err));
