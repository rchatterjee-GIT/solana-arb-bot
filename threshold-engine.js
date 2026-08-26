/**
 * threshold-engine.js — Dynamic threshold calibration for arb pairs
 * 
 * Two paths:
 *   1. Trade history available → learned threshold from outcomes
 *   2. No history → market-derived threshold from order book + break-even
 * 
 * Stored in pair-thresholds.json, replaces DEX_THRESHOLD_OVERRIDES
 */

'use strict';
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const THRESHOLDS_FILE = path.join(__dirname, 'pair-thresholds.json');
const CONFIG_FILE     = path.join(__dirname, 'arb-config.json');
const TRADES_FILE     = path.join(__dirname, 'trades.json');

// Floors — never go below these regardless of data
const MIN_THRESHOLD    = 1.2;  // absolute minimum spread % to fire
const MAX_THRESHOLD    = 5.0;  // absolute maximum (pair effectively disabled above this)
const BUFFER_PCT       = 0.10; // 10% buffer on top of calculated threshold
const OBSERVATION_MINS = 60;   // minutes to observe a new pair before setting threshold
const BREAK_EVEN_BUFFER = 0.30; // add 0.30% on top of break-even for new pairs

// ── Load/save thresholds ──────────────────────────────────────────────────────
function loadThresholds() {
  try { return JSON.parse(fs.readFileSync(THRESHOLDS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveThresholds(thresholds) {
  fs.writeFileSync(THRESHOLDS_FILE, JSON.stringify(thresholds, null, 2));
}

// ── Get effective threshold for a pair ───────────────────────────────────────
function getThreshold(symbol) {
  const thresholds = loadThresholds();
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

  // 1. Check pair-thresholds.json (dynamic)
  if (thresholds[symbol]?.threshold) {
    const t = thresholds[symbol];
    // Apply buffer
    return Math.max(MIN_THRESHOLD, t.threshold * (1 + BUFFER_PCT));
  }

  // 2. Fall back to DEX_THRESHOLD_OVERRIDES (legacy static)
  if (cfg.DEX_THRESHOLD_OVERRIDES?.[symbol]) {
    return cfg.DEX_THRESHOLD_OVERRIDES[symbol] * (1 + BUFFER_PCT);
  }

  // 3. Default
  return (cfg.MIN_SPREAD_CEX || 1.5) * (1 + BUFFER_PCT);
}

// ── Path 1: Update threshold from trade outcome ───────────────────────────────
function updateFromTrade(symbol, spreadPct, outcome) {
  const thresholds = loadThresholds();
  if (!thresholds[symbol]) {
    thresholds[symbol] = { symbol, source: 'trades', threshold: null, wins: [], losses: [], updatedAt: null };
  }

  const t = thresholds[symbol];
  if (outcome === 'WIN' && spreadPct > 0) {
    t.wins = [...(t.wins || []), spreadPct].slice(-20); // keep last 20
  } else if (outcome === 'LOSS' && spreadPct > 0) {
    t.losses = [...(t.losses || []), spreadPct].slice(-20);
  }

  // Recalculate threshold
  const wins = t.wins || [];
  const losses = t.losses || [];

  if (wins.length >= 2 && losses.length >= 1) {
    // Set threshold between max losing spread and min winning spread
    const minWin  = Math.min(...wins);
    const maxLoss = Math.max(...losses);
    if (minWin > maxLoss) {
      // Clear separation — set midpoint
      t.threshold = parseFloat(((minWin + maxLoss) / 2).toFixed(3));
      t.source = 'learned-midpoint';
    } else {
      // Overlap — use min winning spread with small buffer
      t.threshold = parseFloat((minWin * 0.95).toFixed(3));
      t.source = 'learned-min-win';
    }
  } else if (wins.length >= 3) {
    // Only wins so far — use min winning spread
    const minWin = Math.min(...wins);
    t.threshold = parseFloat((minWin * 0.95).toFixed(3));
    t.source = 'learned-wins-only';
  } else if (losses.length >= 2) {
    // Mostly losses — raise threshold above max loss spread
    const maxLoss = Math.max(...losses);
    t.threshold = parseFloat((maxLoss * 1.15).toFixed(3));
    t.source = 'learned-losses-only';
  }

  t.threshold = t.threshold ? Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, t.threshold)) : null;
  t.winRate   = wins.length / Math.max(1, wins.length + losses.length);
  t.updatedAt = new Date().toISOString();
  thresholds[symbol] = t;
  saveThresholds(thresholds);

  console.log('[threshold] ' + symbol + ': ' + outcome + ' at ' + spreadPct?.toFixed(3) + '% → threshold now ' + (t.threshold || 'pending'));
  return t.threshold;
}

// ── Path 2: Market-derived threshold for new pairs ───────────────────────────
async function deriveFromMarket(symbol, okxInstId, withdrawalFeeUsd, tradeSizeUsd) {
  const thresholds = loadThresholds();

  // Already has a learned threshold
  if (thresholds[symbol]?.threshold && thresholds[symbol]?.source !== 'market-initial') {
    return thresholds[symbol].threshold;
  }

  try {
    // 1. Calculate break-even spread
    const OKX_TAKER_FEE  = 0.001;  // 0.1%
    const DEX_FEE        = 0.0025; // 0.25% Jupiter
    const withdrawalPct  = withdrawalFeeUsd / tradeSizeUsd;
    const breakEven      = (OKX_TAKER_FEE + DEX_FEE + withdrawalPct) * 100;

    // 2. Fetch OKX order book to measure typical spread
    const ts  = new Date().toISOString();
    const sig = crypto.createHmac('sha256', process.env.OKX_API_SECRET)
      .update(ts + 'GET/api/v5/market/books?instId=' + okxInstId + '&sz=5').digest('base64');
    const r = await fetch('https://www.okx.com/api/v5/market/books?instId=' + okxInstId + '&sz=5', {
      headers: {
        'OK-ACCESS-KEY': process.env.OKX_API_KEY,
        'OK-ACCESS-SIGN': sig,
        'OK-ACCESS-TIMESTAMP': ts,
        'OK-ACCESS-PASSPHRASE': process.env.OKX_PASSPHRASE,
      },
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json();
    const book = j.data?.[0];
    if (book?.asks?.[0] && book?.bids?.[0]) {
      const ask = parseFloat(book.asks[0][0]);
      const bid = parseFloat(book.bids[0][0]);
      const bookSpread = ((ask - bid) / bid) * 100;

      // 3. Set threshold = max(break-even + buffer, book_spread * 3)
      const derived = Math.max(breakEven + BREAK_EVEN_BUFFER, bookSpread * 3, MIN_THRESHOLD);
      const threshold = parseFloat(Math.min(MAX_THRESHOLD, derived).toFixed(2));

      if (!thresholds[symbol]) thresholds[symbol] = { symbol, wins: [], losses: [] };
      thresholds[symbol].threshold   = threshold;
      thresholds[symbol].source      = 'market-initial';
      thresholds[symbol].breakEven   = parseFloat(breakEven.toFixed(3));
      thresholds[symbol].bookSpread  = parseFloat(bookSpread.toFixed(3));
      thresholds[symbol].updatedAt   = new Date().toISOString();
      saveThresholds(thresholds);

      console.log('[threshold] ' + symbol + ': market-derived threshold=' + threshold + '% (breakEven=' + breakEven.toFixed(3) + '% bookSpread=' + bookSpread.toFixed(3) + '%)');
      return threshold;
    }
  } catch(e) {
    console.log('[threshold] ' + symbol + ': market fetch error — ' + e.message);
  }

  // Fallback — use break-even + buffer
  const fallback = parseFloat(Math.max(MIN_THRESHOLD, (1.5 + BREAK_EVEN_BUFFER)).toFixed(2));
  if (!thresholds[symbol]) thresholds[symbol] = { symbol, wins: [], losses: [] };
  thresholds[symbol].threshold  = fallback;
  thresholds[symbol].source     = 'fallback';
  thresholds[symbol].updatedAt  = new Date().toISOString();
  saveThresholds(thresholds);
  return fallback;
}

// ── Bulk calibrate all pairs from existing trade history ──────────────────────
function calibrateFromHistory() {
  const trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  const real   = trades.filter(t => t.direction !== 'RECOVERY' && t.profit != null && t.spreadPct);
  const thresholds = loadThresholds();

  const pairs = [...new Set(real.map(t => t.pair.replace('/USDT', '')))];
  let updated = 0;

  for (const symbol of pairs) {
    const pairTrades = real.filter(t => t.pair === symbol + '/USDT');
    const wins   = pairTrades.filter(t => t.profit > 0).map(t => t.spreadPct);
    const losses = pairTrades.filter(t => t.profit <= 0 && t.spreadPct > 0).map(t => t.spreadPct);

    if (!thresholds[symbol]) thresholds[symbol] = { symbol, wins: [], losses: [] };
    thresholds[symbol].wins   = wins.slice(-20);
    thresholds[symbol].losses = losses.slice(-20);

    if (wins.length === 0 && losses.length >= 1) {
      // No wins at all — disable with high threshold
      thresholds[symbol].threshold = MAX_THRESHOLD;
      thresholds[symbol].source    = 'loss-only-disabled';
      thresholds[symbol].winRate   = 0;
      thresholds[symbol].updatedAt = new Date().toISOString();
      updated++;
    } else if (wins.length >= 1) {
      const minWin   = Math.min(...wins);
      const maxLoss  = losses.length ? Math.max(...losses) : 0;
      const winRate  = wins.length / (wins.length + losses.length);
      // Conservative factor: if win rate < 50%, add bigger buffer
      const factor   = winRate < 0.5 ? 1.15 : 0.95;
      let threshold;
      if (maxLoss > 0 && minWin > maxLoss) {
        // Clear separation — use midpoint
        threshold = (minWin + maxLoss) / 2;
      } else {
        // No clear separation — use min win spread with factor
        threshold = minWin * factor;
      }
      thresholds[symbol].threshold = parseFloat(Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, threshold)).toFixed(3));
      thresholds[symbol].source    = 'history-calibration';
      thresholds[symbol].winRate   = winRate;
      thresholds[symbol].updatedAt = new Date().toISOString();
      updated++;
    }
  }

  saveThresholds(thresholds);
  console.log('[threshold] Calibrated ' + updated + ' pairs from history');
  return thresholds;
}


function generateReport() {
  const thresholds = loadThresholds();
  const entries = Object.values(thresholds).sort((a, b) => (a.threshold||9) - (b.threshold||9));
  if (!entries.length) return '🔍 [AGENT] No threshold data yet — run /agent calibrate';
  const lines = entries.map(t =>
    t.symbol.padEnd(8) + 'thr:' + (t.threshold?.toFixed(2)||'?') + '% (' + t.source + ') ' +
    (t.winRate != null ? Math.round(t.winRate*100) + '%W' : '') +
    ' wins:' + (t.wins?.length||0) + ' losses:' + (t.losses?.length||0)
  );
  return '📊 [REPORT] Pair Thresholds\n' + lines.join('\n');
}
module.exports = { getThreshold, updateFromTrade, deriveFromMarket, calibrateFromHistory, generateReport, loadThresholds, saveThresholds };

