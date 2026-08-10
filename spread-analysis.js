// spread-analysis.js — analyse spread duration patterns from trade history
// Answers: how long do spreads stay open? Which pairs close fastest?
// Used by agent to optimise entry timing and threshold setting

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const TRADELOG  = path.join(__dirname, 'trade-log.json');
const TRADES    = path.join(__dirname, 'trades.json');
const FIRES     = path.join(__dirname, 'fires.json');

function readJSON(f) { try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch { return null; } }

// ── Core analysis ─────────────────────────────────────────────────────────────
function analyseSpreadDuration() {
  const tradelog = readJSON(TRADELOG) || [];
  const trades   = readJSON(TRADES)   || [];
  const fires    = readJSON(FIRES)    || [];
  const real     = trades.filter(t => t.direction !== 'RECOVERY');

  const results = {
    byPair:     {},
    byExchange: {},
    overall:    {},
    insights:   [],
    warnings:   [],
  };

  // ── Phase 1: Withdrawal time analysis ────────────────────────────────────
  // How long from trade fire to token arrival on Solana?
  const withdrawalTimes = [];
  for (const log of tradelog) {
    const start   = log.events?.find(e => e.event === 'TRADE_START');
    const arrived = log.events?.find(e => e.event === 'TOKEN_ARRIVED');
    const swap    = log.events?.find(e => e.event === 'SWAP_SUCCESS');
    const complete = log.events?.find(e => e.event === 'TRADE_COMPLETE');

    if (!start || !arrived) continue;

    const withdrawSec = Math.round((arrived.ms - start.ms) / 1000);
    const smartSellSec = swap ? Math.round((swap.ms - arrived.ms) / 1000) : null;
    const totalSec = complete ? Math.round((complete.ms - start.ms) / 1000) : null;

    const pair = log.pair?.replace('/USDT','') || 'unknown';
    const exchange = log.direction?.replace('BUY_','') || 'unknown';
    const trade = real.find(t => t.tradeId === log.tradeId);
    const profit = trade?.profit || 0;
    const spread = trade?.spreadPct || log.spreadPct || 0;

    withdrawalTimes.push({
      tradeId: log.tradeId, pair, exchange,
      spread, profit, withdrawSec, smartSellSec, totalSec,
      won: profit > 0,
    });

    // Build per-pair stats
    if (!results.byPair[pair]) results.byPair[pair] = {
      trades: [], avgWithdraw: 0, avgSmartSell: 0,
      fastestWin: null, slowestWin: null,
      winsAtFast: 0, lossesAtFast: 0,
      winsAtSlow: 0, lossesAtSlow: 0,
    };
    results.byPair[pair].trades.push({ withdrawSec, smartSellSec, profit, spread, won: profit > 0 });

    // Build per-exchange stats
    if (!results.byExchange[exchange]) results.byExchange[exchange] = { trades: [], avgWithdraw: 0 };
    results.byExchange[exchange].trades.push({ withdrawSec, profit, pair, won: profit > 0 });
  }

  // ── Phase 2: Calculate derived stats ─────────────────────────────────────
  for (const [pair, data] of Object.entries(results.byPair)) {
    const t = data.trades;
    if (t.length === 0) continue;

    data.avgWithdraw   = Math.round(t.reduce((a,x) => a+(x.withdrawSec||0),0) / t.length);
    data.avgSmartSell  = Math.round(t.filter(x=>x.smartSellSec!=null).reduce((a,x) => a+(x.smartSellSec||0),0) / Math.max(1,t.filter(x=>x.smartSellSec!=null).length));
    data.avgTotal      = Math.round(t.filter(x=>x.smartSellSec!=null).reduce((a,x) => a+(x.withdrawSec||0)+(x.smartSellSec||0),0) / Math.max(1,t.filter(x=>x.smartSellSec!=null).length));

    // Split fast vs slow withdrawals at median
    const sorted = [...t].sort((a,b) => (a.withdrawSec||0)-(b.withdrawSec||0));
    const median = sorted[Math.floor(sorted.length/2)]?.withdrawSec || 0;

    const fast = t.filter(x => (x.withdrawSec||0) <= median);
    const slow = t.filter(x => (x.withdrawSec||0) > median);

    data.medianWithdraw = median;
    data.winsAtFast     = fast.filter(x=>x.won).length;
    data.lossesAtFast   = fast.filter(x=>!x.won).length;
    data.winsAtSlow     = slow.filter(x=>x.won).length;
    data.lossesAtSlow   = slow.filter(x=>!x.won).length;
    data.fastWinRate    = fast.length ? data.winsAtFast/fast.length : 0;
    data.slowWinRate    = slow.length ? data.winsAtSlow/slow.length : 0;
    data.winRateDropFast2Slow = data.fastWinRate - data.slowWinRate;

    // Spread decay: did the spread that was captured survive withdrawal time?
    const avgWinSpread  = t.filter(x=>x.won).reduce((a,x)=>a+x.spread,0) / Math.max(1,t.filter(x=>x.won).length);
    const avgLossSpread = t.filter(x=>!x.won).reduce((a,x)=>a+x.spread,0) / Math.max(1,t.filter(x=>!x.won).length);
    data.avgWinSpread   = parseFloat(avgWinSpread.toFixed(3));
    data.avgLossSpread  = parseFloat(avgLossSpread.toFixed(3));
    data.spreadDecay    = parseFloat((avgLossSpread - avgWinSpread).toFixed(3)); // positive = losses at higher spread = spread closed
  }

  for (const [ex, data] of Object.entries(results.byExchange)) {
    const t = data.trades;
    if (t.length === 0) continue;
    data.avgWithdraw = Math.round(t.reduce((a,x) => a+(x.withdrawSec||0),0) / t.length);
    data.winRate     = parseFloat((t.filter(x=>x.won).length/t.length).toFixed(2));
    data.count       = t.length;
  }

  // ── Phase 3: Generate insights ────────────────────────────────────────────
  for (const [pair, data] of Object.entries(results.byPair)) {
    if (data.trades.length < 2) continue;

    // Insight 1: Slow withdrawals correlate with losses
    if (data.winRateDropFast2Slow > 0.3 && data.trades.length >= 3) {
      results.insights.push({
        pair,
        type: 'withdrawal-speed-matters',
        message: `${pair}: win rate drops ${Math.round(data.fastWinRate*100)}% → ${Math.round(data.slowWinRate*100)}% as withdrawal slows. Fast trades (<${data.medianWithdraw}s) win more.`,
        recommendation: `Consider ${pair} only when OKX withdrawal queue is fast. Avoid during network congestion.`,
      });
    }

    // Insight 2: Spread closure — losing at high spread means price moved against us
    if (data.spreadDecay > 0.5 && data.trades.length >= 3) {
      results.insights.push({
        pair,
        type: 'spread-closes-fast',
        message: `${pair}: losses occur at HIGHER spreads (${data.avgLossSpread.toFixed(2)}%) than wins (${data.avgWinSpread.toFixed(2)}%). Spread closes before arrival.`,
        recommendation: `${pair} spreads are short-lived. Need withdrawal under ${Math.round(data.avgWithdraw*0.7)}s to capture. Consider raising threshold or skipping.`,
      });
    }

    // Insight 3: Smart sell holding too long
    if (data.avgSmartSell > 600 && data.slowWinRate < data.fastWinRate) {
      results.insights.push({
        pair,
        type: 'smart-sell-too-long',
        message: `${pair}: avg smart sell hold ${Math.round(data.avgSmartSell/60)}min. Correlation with losses.`,
        recommendation: `${pair}: lower HOLD_MAX_HOURS or add to fast-sell list.`,
      });
    }

    // Warning: Pair consistently loses regardless of spread
    if (data.trades.length >= 3) {
      const winRate = data.trades.filter(x=>x.won).length / data.trades.length;
      if (winRate < 0.25) {
        results.warnings.push({
          pair,
          type: 'persistent-loser',
          message: `${pair}: ${Math.round(winRate*100)}% win rate over ${data.trades.length} trades. Spread closes consistently before arb can be executed.`,
          recommendation: `Skip ${pair} or require 3x normal threshold (${(data.avgLossSpread * 2).toFixed(1)}%+)`,
        });
      }
    }
  }

  // ── Phase 4: Overall stats ────────────────────────────────────────────────
  const allWithdrawals = withdrawalTimes.filter(t => t.withdrawSec > 0);
  results.overall = {
    totalAnalysed:    allWithdrawals.length,
    avgWithdrawSec:   Math.round(allWithdrawals.reduce((a,t)=>a+t.withdrawSec,0) / Math.max(1,allWithdrawals.length)),
    fastestWithdraw:  Math.min(...allWithdrawals.map(t=>t.withdrawSec)),
    slowestWithdraw:  Math.max(...allWithdrawals.map(t=>t.withdrawSec)),
    winRateFast:      parseFloat((allWithdrawals.filter(t=>t.withdrawSec<120&&t.won).length / Math.max(1,allWithdrawals.filter(t=>t.withdrawSec<120).length)).toFixed(2)),
    winRateSlow:      parseFloat((allWithdrawals.filter(t=>t.withdrawSec>=120&&t.won).length / Math.max(1,allWithdrawals.filter(t=>t.withdrawSec>=120).length)).toFixed(2)),
    idealWindowSec:   120, // trades completing under 2min have higher win rate
  };

  return results;
}

function printReport(results) {
  console.log('\n=== SPREAD DURATION ANALYSIS ===\n');

  console.log('── Overall ──');
  const o = results.overall;
  console.log(`Trades analysed: ${o.totalAnalysed}`);
  console.log(`Avg withdrawal:  ${o.avgWithdrawSec}s`);
  console.log(`Range:           ${o.fastestWithdraw}s - ${o.slowestWithdraw}s`);
  console.log(`Win rate <2min:  ${Math.round(o.winRateFast*100)}%`);
  console.log(`Win rate >2min:  ${Math.round(o.winRateSlow*100)}%`);

  console.log('\n── By Pair ──');
  for (const [pair, data] of Object.entries(results.byPair)) {
    if (data.trades.length === 0) continue;
    const wins = data.trades.filter(x=>x.won).length;
    console.log(`\n${pair} (${data.trades.length} trades, ${wins}W/${data.trades.length-wins}L):`);
    console.log(`  Avg withdrawal:  ${data.avgWithdraw}s (median: ${data.medianWithdraw}s)`);
    console.log(`  Avg smart sell:  ${Math.round(data.avgSmartSell/60)}min`);
    console.log(`  Fast win rate:   ${Math.round(data.fastWinRate*100)}% vs slow: ${Math.round(data.slowWinRate*100)}%`);
    console.log(`  Avg win spread:  ${data.avgWinSpread}% vs loss: ${data.avgLossSpread}%`);
    if (data.spreadDecay > 0.5) console.log(`  ⚠️  Spread closes fast (decay: ${data.spreadDecay.toFixed(2)}%)`);
  }

  console.log('\n── By Exchange ──');
  for (const [ex, data] of Object.entries(results.byExchange)) {
    console.log(`${ex}: ${data.count} trades, avg withdrawal ${data.avgWithdraw}s, win rate ${Math.round(data.winRate*100)}%`);
  }

  if (results.insights.length > 0) {
    console.log('\n── Insights ──');
    results.insights.forEach(i => {
      console.log(`\n[${i.type}] ${i.pair}`);
      console.log(`  ${i.message}`);
      console.log(`  → ${i.recommendation}`);
    });
  }

  if (results.warnings.length > 0) {
    console.log('\n── Warnings ──');
    results.warnings.forEach(w => {
      console.log(`\n⚠️  ${w.pair}: ${w.message}`);
      console.log(`  → ${w.recommendation}`);
    });
  }
}

module.exports = { analyseSpreadDuration, printReport };

if (require.main === module) {
  const results = analyseSpreadDuration();
  printReport(results);
}
