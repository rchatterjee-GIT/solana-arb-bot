/**
 * strategy-manager.js — Market regime detector and strategy hotswap engine
 *
 * Regimes:
 *   BULL   — BTC +5%/24hr OR funding rates >0.05%/8hr → funding arb active
 *   NEUTRAL — BTC ±5%/24hr, mixed signals → BUY_DEX + triangular arb active
 *   BEAR   — BTC -5%/24hr OR sudden drop >3% in 1hr → BUY_DEX aggressive + triangular
 *   NEWS   — Token-specific move >4% in 15min → enhanced scan on that token
 *
 * Config written to arb-config.json — bot picks up within 30s automatically.
 * State persisted in strategy-state.json.
 */

'use strict';
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_FILE   = path.join(__dirname, 'arb-config.json');
const STATE_FILE    = path.join(__dirname, 'strategy-state.json');
const TRADES_FILE   = path.join(__dirname, 'trades.json');

// ── Regime thresholds ─────────────────────────────────────────────────────────
const BULL_BTC_CHANGE   =  5.0;  // % 24hr change to enter BULL
const BEAR_BTC_CHANGE   = -5.0;  // % 24hr change to enter BEAR
const BEAR_FAST_DROP    = -3.0;  // % 1hr change for fast BEAR trigger
const BULL_FUNDING_RATE =  0.05; // %/8hr funding rate to confirm BULL
const NEWS_TOKEN_MOVE   =  4.0;  // % 15min move to trigger NEWS mode
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes

// ── Config per regime ─────────────────────────────────────────────────────────
const REGIME_CONFIGS = {
  BULL: {
    DISABLE_BUY_OKX:    true,
    DISABLE_BUY_BYBIT:  true,
    DISABLE_BUY_DEX:    true,   // spreads wrong direction in bull
    DEX_ARB_ENABLED:    false,  // save API quota
    FUNDING_ARB_ENABLED:true,
    TRIANGULAR_ARB_ENABLED:false,  // save API quota in bull
    MIN_SPREAD_BUFFER_PCT: 10,
    DEX_THRESHOLD_OVERRIDES: { JTO: 2.0, SOL: 2.0, WIF: 2.5, PENGU: 2.5, PNUT: 2.5, W: 3.5 },
  },
  NEUTRAL: {
    DISABLE_BUY_OKX:    true,   // CEX legs still off (withdrawal lag)
    DISABLE_BUY_BYBIT:  true,
    DISABLE_BUY_DEX:    false,
    DEX_ARB_ENABLED:    false,  // off until API quota allows
    FUNDING_ARB_ENABLED:false,
    TRIANGULAR_ARB_ENABLED:true,   // triangular runs in neutral
    MIN_SPREAD_BUFFER_PCT: 5,
    DEX_THRESHOLD_OVERRIDES: { JTO: 1.8, SOL: 1.8, WIF: 2.0, PENGU: 1.8, PNUT: 2.0, W: 2.5 },
  },
  BEAR: {
    DISABLE_BUY_OKX:    true,
    DISABLE_BUY_BYBIT:  true,
    DISABLE_BUY_DEX:    false,
    DEX_ARB_ENABLED:    false,
    FUNDING_ARB_ENABLED:false,
    TRIANGULAR_ARB_ENABLED:true,   // triangular runs in bear
    MIN_SPREAD_BUFFER_PCT: 3,   // tighter buffer — spreads wider in bear
    DEX_THRESHOLD_OVERRIDES: { JTO: 1.5, SOL: 1.5, WIF: 1.8, PENGU: 1.5, PNUT: 1.8, W: 2.0 },
  },
};

// ── Load/save state ───────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { regime: 'NEUTRAL', since: new Date().toISOString(), btcPrice: null, btcChange24h: 0, lastCheck: 0 }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── OKX market data ───────────────────────────────────────────────────────────
async function getOKXTicker(instId) {
  const r = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${instId}`, {
    signal: AbortSignal.timeout(5000),
  });
  const j = await r.json();
  return j.data?.[0] || null;
}

async function getOKXFundingRate(instId) {
  const r = await fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`, {
    signal: AbortSignal.timeout(5000),
  });
  const j = await r.json();
  return parseFloat(j.data?.[0]?.fundingRate || '0');
}

// ── Detect market regime ──────────────────────────────────────────────────────
async function detectRegime(state) {
  const btc = await getOKXTicker('BTC-USDT');
  if (!btc) return { regime: state.regime, reason: 'OKX unavailable' };

  const btcPrice     = parseFloat(btc.last);
  const btcChange24h = btc.open24h ? ((btcPrice - parseFloat(btc.open24h)) / parseFloat(btc.open24h)) * 100 : 0;
  const btcOpen1h    = parseFloat(btc.open1h || btc.last);
  const btcChange1h  = ((btcPrice - btcOpen1h) / btcOpen1h) * 100;

  // Fetch funding rate for regime confirmation
  let solFunding = 0;
  try { solFunding = await getOKXFundingRate('SOL-USDT-SWAP'); } catch {}

  let regime = 'NEUTRAL';
  let reason = '';

  if (btcChange24h >= BULL_BTC_CHANGE || solFunding >= BULL_FUNDING_RATE / 100) {
    regime = 'BULL';
    reason = `BTC +${btcChange24h.toFixed(1)}%/24hr, SOL funding ${(solFunding*100).toFixed(4)}%/8hr`;
  } else if (btcChange24h <= BEAR_BTC_CHANGE || btcChange1h <= BEAR_FAST_DROP) {
    regime = 'BEAR';
    reason = `BTC ${btcChange24h.toFixed(1)}%/24hr, 1hr: ${btcChange1h.toFixed(1)}%`;
  } else {
    reason = `BTC ${btcChange24h.toFixed(1)}%/24hr (neutral range)`;
  }

  return { regime, reason, btcPrice, btcChange24h, btcChange1h, solFunding };
}

// ── Detect news events on Solana tokens ──────────────────────────────────────
async function detectNewsEvents(state) {
  const WATCH_TOKENS = ['JTO-USDT', 'SOL-USDT', 'WIF-USDT', 'PENGU-USDT', 'PNUT-USDT'];
  const events = [];

  for (const instId of WATCH_TOKENS) {
    try {
      const t = await getOKXTicker(instId);
      if (!t) continue;
      const change = parseFloat(t.change24h) * 100;
      const open1h = parseFloat(t.open1h || t.last);
      const last   = parseFloat(t.last);
      const move1h = ((last - open1h) / open1h) * 100;

      if (Math.abs(move1h) >= NEWS_TOKEN_MOVE) {
        events.push({
          symbol: instId.replace('-USDT', ''),
          move1h: move1h.toFixed(2),
          change24h: change.toFixed(2),
          direction: move1h > 0 ? 'UP' : 'DOWN',
        });
      }
    } catch {}
  }

  return events;
}

// ── Apply regime config ───────────────────────────────────────────────────────
function applyRegimeConfig(regime, newsEvents) {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const regimeCfg = REGIME_CONFIGS[regime] || REGIME_CONFIGS.NEUTRAL;

  // Apply regime settings
  Object.assign(cfg, regimeCfg);

  // NEWS: lower thresholds on affected tokens for faster firing
  if (newsEvents.length > 0) {
    if (!cfg.DEX_THRESHOLD_OVERRIDES) cfg.DEX_THRESHOLD_OVERRIDES = {};
    for (const evt of newsEvents) {
      if (evt.direction === 'DOWN' && !cfg.DISABLE_BUY_DEX) {
        // Price dropped on CEX — DEX may lag, BUY_DEX opportunity
        const current = cfg.DEX_THRESHOLD_OVERRIDES[evt.symbol] || 2.0;
        cfg.DEX_THRESHOLD_OVERRIDES[evt.symbol] = Math.max(1.2, current * 0.8);
        console.log(`[strategy] NEWS: ${evt.symbol} down ${evt.move1h}% — threshold lowered to ${cfg.DEX_THRESHOLD_OVERRIDES[evt.symbol].toFixed(2)}%`);
      }
    }
  }

  cfg.ACTIVE_REGIME = regime;
  cfg.REGIME_SINCE  = new Date().toISOString();

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  return cfg;
}

// ── Main check ────────────────────────────────────────────────────────────────
async function checkAndSwap(sendTG) {
  const state = loadState();
  const { regime, reason, btcPrice, btcChange24h, btcChange1h, solFunding } = await detectRegime(state);
  const newsEvents = await detectNewsEvents(state);

  const regimeChanged = regime !== state.regime || !require("./arb-config.json").ACTIVE_REGIME;
  const hasNews = newsEvents.length > 0;

  if (regimeChanged || hasNews) {
    applyRegimeConfig(regime, newsEvents);

    if (regimeChanged) {
      const emoji = regime === 'BULL' ? '🟢' : regime === 'BEAR' ? '🔴' : '🟡';
      let msg = `${emoji} [STRATEGY] Regime changed: ${state.regime} → ${regime}\n`;
      msg += `Reason: ${reason}\n`;
      msg += `BTC: $${btcPrice?.toLocaleString()} (${btcChange24h?.toFixed(1)}%/24hr)\n\n`;

      if (regime === 'BULL') {
        msg += `Strategy: Funding arb ACTIVE\n`;
        msg += `BUY_DEX: PAUSED (spreads negative in bull)\n`;
        msg += `Action: Run /agent funding to check rates`;
      } else if (regime === 'BEAR') {
        msg += `Strategy: BUY_DEX AGGRESSIVE\n`;
        msg += `Thresholds lowered — JTO fires at 1.5%+\n`;
        msg += `Watch JTO/SOL for spread spikes`;
      } else {
        msg += `Strategy: BUY_DEX NORMAL\n`;
        msg += `JTO threshold: 1.8%, SOL: 1.8%`;
      }

      if (sendTG) await sendTG(msg);
      console.log(`[strategy] ${emoji} Regime: ${state.regime} → ${regime} | ${reason}`);
    }

    if (hasNews) {
      const lines = newsEvents.map(e => `${e.symbol} ${e.direction} ${e.move1h}% (1hr)`).join('\n');
      if (sendTG) await sendTG(`📰 [NEWS] Token moves detected:\n${lines}\n\nThresholds adjusted — enhanced monitoring active`);
      console.log(`[strategy] NEWS events: ${lines}`);
    }
  }

  // Update state
  const newState = {
    regime,
    since: regimeChanged ? new Date().toISOString() : state.since,
    btcPrice, btcChange24h, btcChange1h,
    solFunding: solFunding * 100,
    reason,
    lastCheck: Date.now(),
    newsEvents: hasNews ? newsEvents : [],
  };
  saveState(newState);
  return newState;
}

// ── Generate strategy report ─────────────────────────────────────────────────
function generateReport() {
  const state = loadState();
  const cfg   = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const regime = state.regime || 'UNKNOWN';
  const emoji  = regime === 'BULL' ? '🟢' : regime === 'BEAR' ? '🔴' : '🟡';

  let msg = `${emoji} [STRATEGY] Current Regime: ${regime}\n`;
  msg += `Since: ${state.since?.slice(0,16)?.replace('T',' ')} UTC\n`;
  msg += `BTC: $${state.btcPrice?.toLocaleString() || '?'} (${state.btcChange24h?.toFixed(1) || '?'}%/24hr)\n`;
  msg += `Reason: ${state.reason || 'N/A'}\n\n`;
  msg += `Active config:\n`;
  msg += `  BUY_DEX: ${cfg.DISABLE_BUY_DEX ? 'DISABLED' : 'ENABLED'}\n`;
  msg += `  BUY_OKX: ${cfg.DISABLE_BUY_OKX ? 'DISABLED' : 'ENABLED'}\n`;
  msg += `  Funding arb: ${cfg.FUNDING_ARB_ENABLED ? 'ENABLED' : 'DISABLED'}\n`;
  msg += `  Triangular arb: ${cfg.TRIANGULAR_ARB_ENABLED ? 'ENABLED' : 'DISABLED'}\n`;
  msg += `  Buffer: ${cfg.MIN_SPREAD_BUFFER_PCT}%\n`;
  msg += `  JTO threshold: ${cfg.DEX_THRESHOLD_OVERRIDES?.JTO || 'default'}%\n`;
  if (state.newsEvents?.length > 0) {
    msg += `\nActive news events:\n`;
    msg += state.newsEvents.map(e => `  ${e.symbol} ${e.direction} ${e.move1h}%`).join('\n');
  }
  return msg;
}

module.exports = { checkAndSwap, detectRegime, detectNewsEvents, applyRegimeConfig, generateReport, loadState };
