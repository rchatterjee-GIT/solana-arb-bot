/**
 * arb-core.js — Solana CEX-DEX Arbitrage Bot v5.0
 *
 * Clean rewrite. Only proven functionality included.
 * Dead code removed. Single responsibility per function.
 *
 * Active directions:
 *   BUY_DEX — buy on Jupiter DEX, no withdrawal needed (instant)
 *
 * Architecture:
 *   - Config loaded from arb-config.json every 30s (hot reload)
 *   - Prices from OKX/Bybit WebSocket (zero latency)
 *   - DEX quotes from Jupiter REST API
 *   - Thresholds from threshold.js (learned per pair)
 *   - Strategy from strategy.js (BULL/NEUTRAL/BEAR regime)
 *   - All state in arb-state.json
 */

'use strict';
require('dotenv').config();

const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');
const WebSocket = require('ws');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');

const jup        = require('./exchanges/jupiter');
const threshold  = require('./threshold');
const strategy   = require('./strategy');
const okxEx      = require('./exchanges/okx');
const bybitEx    = require('./exchanges/bybit');
const krakenEx   = require('./exchanges/kraken');
const rebalancer = require('./rebalance');

// ── Constants ─────────────────────────────────────────────────────────────────
const VERSION        = '5.0.0';
const CONFIG_FILE    = path.join(__dirname, 'arb-config.json');
const STATE_FILE     = path.join(__dirname, 'arb-state.json');
const LIVE_FILE      = path.join(__dirname, 'arb-live.json');
const TRADES_FILE    = path.join(__dirname, 'arb-trades.json');

const USDC_MINT      = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SCAN_INTERVAL  = 4000;   // ms between scans
const CONFIG_RELOAD  = 30000;  // ms between config hot-reloads
const MAX_PRICE_AGE  = 10000;  // ms — discard stale CEX prices
const MIN_PROFIT_USD = 0.10;   // minimum profit to fire

// ── Active pairs — only proven performers ─────────────────────────────────────
const PAIRS = [
  { name: 'JTO/USDT', okxCcy: 'JTO', okxInstId: 'JTO-USDT',  bybitInstId: 'JTOUSDT',  outputMint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',  decimals: 9  },
  { name: 'SOL/USDT', okxCcy: 'SOL', okxInstId: 'SOL-USDT',  bybitInstId: 'SOLUSDT',  outputMint: 'So11111111111111111111111111111111111111112',      decimals: 9  },
  { name: 'WIF/USDT', okxCcy: 'WIF', okxInstId: 'WIF-USDT',  bybitInstId: 'WIFUSDT',  outputMint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',  decimals: 6  },
  { name: 'PENGU/USDT',okxCcy:'PENGU',okxInstId:'PENGU-USDT',bybitInstId:'PENGUUSDT', outputMint: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv',  decimals: 6  },
  { name: 'PNUT/USDT', okxCcy: 'PNUT', okxInstId: 'PNUT-USDT',bybitInstId:'PNUTUSDT', outputMint: '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump',  decimals: 6  },
  { name: 'W/USDT',    okxCcy: 'W',    okxInstId: 'W-USDT',   bybitInstId: 'WUSDT',   outputMint: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ',  decimals: 6  },
];

// ── Runtime state ─────────────────────────────────────────────────────────────
let config        = {};
let okxPrices     = {};   // instId → { bid, ask, ts }
let bybitPrices   = {};   // instId → { bid, ask, ts }
let executing      = false;
let totalTrades    = 0;
let totalWins      = 0;
let totalProfit    = 0;
let consecutiveWins = 0;
let lastConfigLoad  = 0;
const SESSION_STOP_LOSS = 50; // stop trading if down $50 in session

const connection  = new Connection(process.env.RPC_URL, 'confirmed');
const wallet      = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY)));
const JUP_KEY     = process.env.JUPITER_API_KEY;
const TG_TOKEN    = process.env.TELEGRAM_TOKEN;
const TG_CHAT     = process.env.TELEGRAM_CHAT_ID;

const OKX_CREDS   = { key: process.env.OKX_API_KEY, secret: process.env.OKX_API_SECRET, passphrase: process.env.OKX_PASSPHRASE };
const BYBIT_CREDS = { key: process.env.BYBIT_API_KEY, secret: process.env.BYBIT_API_SECRET };
const KRAKEN_CREDS= { key: process.env.KRAKEN_API_KEY, secret: process.env.KRAKEN_API_SECRET };

let liveBalances  = {};
const BALANCE_INTERVAL = 60000; // fetch every 60s

// ── Config hot-reload ─────────────────────────────────────────────────────────
function loadConfig() {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    lastConfigLoad = Date.now();
  } catch(e) {
    console.error('[config] reload failed:', e.message);
  }
}

// ── State persistence ─────────────────────────────────────────────────────────
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    totalTrades     = s.totalTrades     || 0;
    totalWins       = s.totalWins       || 0;
    totalProfit     = s.totalProfit     || 0;
    consecutiveWins = s.consecutiveWins || 0;
  } catch {}
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    version: VERSION, totalTrades, totalWins, totalProfit, consecutiveWins,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function logTrade(trade) {
  const trades = (() => { try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); } catch { return []; } })();
  trades.push(trade);
  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
  threshold.updateFromTrade(trade.pair, trade.spreadPct, trade.outcome);
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }),
    });
  } catch {}
}

// ── Balance fetching ─────────────────────────────────────────────────────────
async function fetchBalances() {
  try {
    const [okxBal, bybitBal, krakenBal, solBal] = await Promise.allSettled([
      okxEx.getFundingBalance('USDT', OKX_CREDS),
      bybitEx.getBalance('USDT', BYBIT_CREDS),
      krakenEx.getUSDTBalance(KRAKEN_CREDS),
      (async () => {
        const usdcMint = new PublicKey(USDC_MINT);
        const ata = await getAssociatedTokenAddress(usdcMint, wallet.publicKey);
        const acc = await getAccount(connection, ata);
        return Number(acc.amount) / 1e6;
      })(),
    ]);
    liveBalances = {
      solana:  solBal.status   === 'fulfilled' ? solBal.value   : liveBalances.solana,
      okx:     okxBal.status   === 'fulfilled' ? okxBal.value   : liveBalances.okx,
      bybit:   bybitBal.status === 'fulfilled' ? bybitBal.value : liveBalances.bybit,
      kraken:  krakenBal.status=== 'fulfilled' ? krakenBal.value: liveBalances.kraken,
      coinbase: liveBalances.coinbase || 0,
    };
    const total = Object.values(liveBalances).reduce((a,b) => a + (b||0), 0);
    liveBalances.total = total;
    console.log(`[balances] SOL:$${liveBalances.solana?.toFixed(2)} OKX:$${liveBalances.okx?.toFixed(2)} Bybit:$${liveBalances.bybit?.toFixed(2)} Kraken:$${liveBalances.kraken?.toFixed(2)} Total:$${total.toFixed(2)}`);
  } catch(e) {
    console.error('[balances] Error:', e.message);
  }
}

// ── Rebalance ─────────────────────────────────────────────────────────────────
async function checkRebalance(force = false) {
  // Check for manual trigger from agent /rb confirm
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (cfg.REBALANCE_NOW) {
    delete cfg.REBALANCE_NOW;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    force = true;
  }
  if (!force) return;

  const b = liveBalances;
  if (!b.okx && !b.bybit) return;

  const balances = {
    Solana: b.solana || 0,
    OKX:    b.okx    || 0,
    Bybit:  b.bybit  || 0,
    Kraken: b.kraken || 0,
  };

  const plan = rebalancer.buildPlan(balances);
  await rebalancer.execute(plan, tg);
}

// ── OKX WebSocket price feed ──────────────────────────────────────────────────
function connectOKX() {
  const ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
  ws.on('open', () => {
    const channels = PAIRS.map(p => ({ channel: 'tickers', instId: p.okxInstId }));
    ws.send(JSON.stringify({ op: 'subscribe', args: channels }));
    console.log('[OKX WS] Connected');
  });
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.arg?.channel === 'tickers' && msg.data?.[0]) {
        const d = msg.data[0];
        okxPrices[d.instId] = { bid: parseFloat(d.bidPx), ask: parseFloat(d.askPx), ts: Date.now() };
      }
    } catch {}
  });
  ws.on('close', () => { console.log('[OKX WS] Disconnected — reconnecting in 5s'); setTimeout(connectOKX, 5000); });
  ws.on('error', () => {});
}

// ── Bybit WebSocket price feed ────────────────────────────────────────────────
function connectBybit() {
  const ws = new WebSocket('wss://stream.bybit.com/v5/public/spot');
  ws.on('open', () => {
    const args = PAIRS.map(p => `tickers.${p.bybitInstId}`);
    ws.send(JSON.stringify({ op: 'subscribe', args }));
    console.log('[Bybit WS] Connected');
  });
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.topic?.startsWith('tickers.') && msg.data) {
        const d = msg.data;
        bybitPrices[msg.topic.replace('tickers.', '')] = {
          bid: parseFloat(d.bid1Price), ask: parseFloat(d.ask1Price), ts: Date.now(),
        };
      }
    } catch {}
  });
  ws.on('close', () => { console.log('[Bybit WS] Disconnected — reconnecting in 5s'); setTimeout(connectBybit, 5000); });
  ws.on('error', () => {});
}

// ── Pre-flight DEX liquidity check ────────────────────────────────────────────
async function preflightCheck(pair, tradeSizeUsd) {
  try {
    const rawIn = Math.floor(tradeSizeUsd * 1e6);
    const quote = await jup.getQuote(USDC_MINT, pair.outputMint, rawIn, JUP_KEY, 300);
    const outUsd = parseInt(quote.outAmount) / Math.pow(10, pair.decimals) *
      (okxPrices[pair.okxInstId]?.bid || 1);
    const impact = parseFloat(quote.priceImpactPct || '0');
    if (outUsd < tradeSizeUsd * 0.85) return { ok: false, reason: `DEX fill only $${outUsd.toFixed(2)}` };
    if (impact > 2.5) return { ok: false, reason: `Price impact ${impact.toFixed(2)}%` };
    return { ok: true };
  } catch(e) {
    return { ok: true }; // non-fatal — proceed if check errors
  }
}

// ── Execute BUY_DEX trade ─────────────────────────────────────────────────────
async function executeBuyDex(pair, spreadPct, dexAsk, tradeSizeUsd) {
  executing = true;
  const tradeId = `dex-${Date.now()}`;
  const startTime = Date.now();

  try {
    // Pre-flight
    const check = await preflightCheck(pair, tradeSizeUsd);
    if (!check.ok) {
      console.log(`[${pair.name}] Pre-flight failed: ${check.reason}`);
      return;
    }

    await tg(`⚡ <b>${pair.okxCcy} BUY_DEX</b>\nSpread: ${spreadPct.toFixed(3)}%\n[1/2] Buying on Jupiter...`);

    // Buy token on DEX with USDC
    const rawIn = Math.floor(tradeSizeUsd * 1e6);
    const { sig: buySig, quote: buyQuote } = await jup.swap(
      USDC_MINT, pair.outputMint, rawIn, wallet, connection, JUP_KEY
    );
    const tokensBought = parseInt(buyQuote.outAmount) / Math.pow(10, pair.decimals);
    console.log(`[${pair.name}] Bought ${tokensBought.toFixed(4)} ${pair.okxCcy} | ${buySig}`);

    await tg(`⚡ <b>${pair.okxCcy} BUY_DEX</b>\n[2/2] Selling back to USDC...`);

    // Sell token back to USDC
    const rawTokenIn = parseInt(buyQuote.outAmount);
    const { sig: sellSig, quote: sellQuote } = await jup.swap(
      pair.outputMint, USDC_MINT, rawTokenIn, wallet, connection, JUP_KEY, 100
    );
    const usdcOut = parseInt(sellQuote.outAmount) / 1e6;
    const profit  = usdcOut - tradeSizeUsd;
    const durationMs = Date.now() - startTime;

    // Update state
    totalTrades++;
    if (profit > 0) { totalWins++; consecutiveWins++; }
    else { consecutiveWins = 0; }
    totalProfit += profit;
    saveState();

    // Session stop-loss check
    if (totalProfit < -SESSION_STOP_LOSS) {
      await tg('⛔ <b>Session stop-loss hit</b> — down $' + Math.abs(totalProfit).toFixed(2) + '\nTrading paused. /resume to restart.');
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      cfg.DISABLE_BUY_DEX = true;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    }

    const trade = {
      date: new Date().toISOString(), tradeId, pair: pair.name,
      direction: 'BUY_DEX', spreadPct, profit,
      usdcIn: tradeSizeUsd, usdcOut, durationMs,
      buySig, sellSig, outcome: profit > 0 ? 'WIN' : 'LOSS',
    };
    logTrade(trade);

    const pnlStr = (profit >= 0 ? '+' : '') + '$' + profit.toFixed(4);
    await tg(
      `✅ <b>${pair.okxCcy} BUY_DEX ${profit >= 0 ? 'WIN' : 'LOSS'}</b>\n` +
      `P&L: ${pnlStr} | ${(durationMs/1000).toFixed(1)}s\n` +
      `Total: ${totalTrades} trades | ${pnlStr} cumulative`
    );
    console.log(`[${pair.name}] Trade complete: ${pnlStr}`);

  } catch(e) {
    console.error(`[${pair.name}] Trade error:`, e.message);
    await tg(`❌ <b>${pair.okxCcy} BUY_DEX failed</b>\n${e.message.slice(0, 150)}`);
    logTrade({
      date: new Date().toISOString(), tradeId, pair: pair.name,
      direction: 'BUY_DEX', spreadPct, profit: 0,
      usdcIn: tradeSizeUsd, usdcOut: 0, outcome: 'ERROR', error: e.message,
    });
  } finally {
    executing = false;
  }
}

// ── Main scan loop ────────────────────────────────────────────────────────────
async function scan() {
  // Reload config periodically
  if (Date.now() - lastConfigLoad > CONFIG_RELOAD) loadConfig();

  if (executing) return;
  if (config.DISABLE_BUY_DEX) return;

  const skipDex     = new Set(config.POLICY_SKIP_DEX || []);
  const tradeSizeUsd = config.TRADE_SIZE_USD || 120;
  const bufferPct    = config.MIN_SPREAD_BUFFER_PCT || 5;

  let bestOpportunity = null;

  const results = await Promise.allSettled(PAIRS.map(async pair => {
    const okx = okxPrices[pair.okxInstId];
    if (!okx) return null;
    if (Date.now() - okx.ts > MAX_PRICE_AGE) return null;
    if (skipDex.has(pair.okxCcy)) return null;

    // Get DEX quote
    const rawIn = Math.floor(tradeSizeUsd * 1e6);
    const buyQ  = await jup.getQuote(USDC_MINT, pair.outputMint, rawIn, JUP_KEY);
    if (!buyQ.outAmount) return null;

    const sellQ = await jup.getQuote(pair.outputMint, USDC_MINT, parseInt(buyQ.outAmount), JUP_KEY, 100);
    const tokenOut = parseInt(buyQ.outAmount) / Math.pow(10, pair.decimals);
    const dexAsk   = tradeSizeUsd / tokenOut;
    const dexBid   = sellQ.outAmount ? (parseInt(sellQ.outAmount) / 1e6) / tokenOut : dexAsk;

    const bestCexBid  = Math.max(okx.bid, bybitPrices[pair.bybitInstId]?.bid || 0);
    const spreadDex   = ((dexBid - bestCexBid) / bestCexBid) * 100;
    const dexThresh   = threshold.getThreshold(pair.okxCcy, config) * (1 + bufferPct / 100);
    const estProfit   = (spreadDex / 100) * tradeSizeUsd - 0.002 * 2 * tradeSizeUsd - 0.15;

    const ts = new Date().toLocaleTimeString();
    const bybit = bybitPrices[pair.bybitInstId];
    process.stdout.write(
      `[${ts}] ${pair.name.padEnd(11)} OKX:$${okx.bid}/$${okx.ask}` +
      ` By:${bybit ? '$'+bybit.bid+'/$'+bybit.ask : '--'}` +
      ` →DEX:${spreadDex.toFixed(2)}%(≥${dexThresh.toFixed(2)}%)\n`
    );

    return { pair, spreadDex, dexThresh, dexAsk, estProfit, tradeSizeUsd };
  }));

  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    const { pair, spreadDex, dexThresh, dexAsk, estProfit, tradeSizeUsd } = r.value;
    if (spreadDex >= dexThresh && estProfit >= MIN_PROFIT_USD) {
      if (!bestOpportunity || spreadDex > bestOpportunity.spreadDex) {
        bestOpportunity = { pair, spreadDex, dexThresh, dexAsk, estProfit, tradeSizeUsd };
      }
    }
  }

  // Write live data for dashboard
  fs.writeFileSync(LIVE_FILE, JSON.stringify({
    version: VERSION,
    timestamp: new Date().toISOString(),
    pairs: results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => {
        const v = r.value;
        const okx = okxPrices[v.pair.okxInstId];
        return {
          name: v.pair.name, okxBid: okx?.bid, okxAsk: okx?.ask,
          spreadDex: parseFloat(v.spreadDex.toFixed(3)),
          dexThresh: parseFloat(v.dexThresh.toFixed(3)),
          estProfit: parseFloat(v.estProfit.toFixed(4)),
        };
      }),
    totalTrades, totalWins, totalProfit,
  }));

  if (bestOpportunity) {
    console.log(`\n🎯 FIRE: ${bestOpportunity.pair.okxCcy} BUY_DEX @ ${bestOpportunity.spreadDex.toFixed(3)}%`);
    await executeBuyDex(
      bestOpportunity.pair, bestOpportunity.spreadDex,
      bestOpportunity.dexAsk, bestOpportunity.tradeSizeUsd
    );
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🚀 arb-core v${VERSION} starting`);
  console.log(`   Wallet: ${wallet.publicKey.toString()}`);
  console.log(`   RPC: ${process.env.RPC_URL?.slice(0, 40)}...`);

  loadConfig();
  loadState();

  // Bootstrap threshold engine from trade history
  try {
    threshold.calibrateFromHistory(TRADES_FILE);
    console.log('   Thresholds calibrated from trade history');
  } catch(e) { console.log('   No trade history yet — using defaults'); }

  // Check initial strategy regime
  try {
    await strategy.checkAndApply(config, CONFIG_FILE);
    loadConfig(); // reload after strategy may have updated it
    console.log(`   Regime: ${config.ACTIVE_REGIME || 'NEUTRAL'}`);
  } catch(e) { console.log('   Strategy check error:', e.message); }

  // Start WebSocket price feeds
  connectOKX();
  connectBybit();

  // Wait for initial prices
  console.log('   Waiting for price feeds...');
  await new Promise(r => setTimeout(r, 3000));

  // Fetch balances immediately and then every 60s
  fetchBalances();
  setInterval(fetchBalances, BALANCE_INTERVAL);

  // Main scan loop
  setInterval(scan, SCAN_INTERVAL);
  scan();

  // Rebalance check every 30 minutes
  setInterval(checkRebalance, 30 * 60 * 1000);

  // Strategy regime check every 5 minutes
  setInterval(async () => {
    try {
      const changed = await strategy.checkAndApply(config, CONFIG_FILE);
      if (changed) { loadConfig(); console.log(`[strategy] Regime → ${config.ACTIVE_REGIME}`); }
    } catch(e) { console.error('[strategy] Error:', e.message); }
  }, 5 * 60 * 1000);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
