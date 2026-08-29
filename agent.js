/**
 * agent.js — Telegram Agent v5.0
 *
 * Monitors bot health, market conditions, and responds to commands.
 * Single responsibility: Telegram interface + automated rules.
 *
 * Commands:
 *   /status              — bot health + balances + P&L
 *   /balances            — exchange balances
 *   /trades              — last 5 trades
 *   /wins                — win/loss summary
 *   /rb confirm          — trigger rebalance
 *   /crash               — last crash log entry
 *   /restart             — restart bot via watchdog
 *   /pause               — pause trading
 *   /resume              — resume trading
 *   /regime              — current market regime
 *   /regime check        — force regime re-check
 *   /funding             — funding rates
 *   /thresholds          — pair thresholds
 *   /calibrate           — recalibrate thresholds from history
 *   /listings            — listing monitor report
 *   /scan-okx            — full OKX universe scan
 *   /dex on|off          — toggle DEX arb
 */

'use strict';
require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const VERSION      = '5.0.0';
const CONFIG_FILE  = path.join(__dirname, 'arb-config.json');
const STATUS_FILE  = path.join(__dirname, 'bot-status.json');
const LIVE_FILE    = path.join(__dirname, 'arb-live.json');
const STATE_FILE   = path.join(__dirname, 'arb-state.json');
const TRADES_FILE  = path.join(__dirname, 'arb-trades.json');
const CRASH_FILE   = path.join(__dirname, 'crash.log');
const AGENT_STATE  = path.join(__dirname, 'agent-state.json');

const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;
const POLL_MS  = 60000; // rule check interval

// ── Helpers ───────────────────────────────────────────────────────────────────
function readJSON(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function loadConfig()     { return readJSON(CONFIG_FILE) || {}; }
function loadStatus()     { return readJSON(STATUS_FILE) || {}; }
function loadState()      { return readJSON(STATE_FILE)  || {}; }
function loadAgentState() { return readJSON(AGENT_STATE) || {}; }
function saveAgentState(s){ fs.writeFileSync(AGENT_STATE, JSON.stringify(s, null, 2)); }

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  console.log(line);
  try { fs.appendFileSync('agent.log', line + '\n'); } catch {}
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }),
    });
    const j = await r.json();
    if (!j.ok) log('TG error: ' + JSON.stringify(j));
  } catch(e) { log('TG send error: ' + e.message); }
}

let lastUpdateId = 0;
async function pollTelegram() {
  if (!TG_TOKEN) return;
  try {
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/getUpdates?offset=' + (lastUpdateId + 1) + '&timeout=10', {
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    if (!j.ok || !j.result?.length) return;
    for (const update of j.result) {
      lastUpdateId = update.update_id;
      const text = update.message?.text?.trim();
      if (text) {
        log('TG command: ' + text);
        const reply = await handleCommand(text);
        if (reply) await tg(reply);
      }
    }
  } catch {}
}

// ── Command handlers ──────────────────────────────────────────────────────────
async function handleCommand(text) {
  const cmd = text.toLowerCase().trim();

  // ── /status ────────────────────────────────────────────────────────────────
  if (cmd === '/status') {
    const status = loadStatus();
    const state  = loadState();
    const cfg    = loadConfig();
    const age    = status.timestamp ? Math.round((Date.now() - new Date(status.timestamp).getTime()) / 1000) : 999;
    const b      = status.liveBalances || {};
    const total  = (b.solana||0) + (b.okx||0) + (b.bybit||0) + (b.kraken||0) + (b.coinbase||0);
    const botOk  = age < 30;

    return (botOk ? '✅' : '❌') + ' <b>arb-core v' + VERSION + '</b>\n' +
      'Bot: ' + (botOk ? 'running' : 'STALE ' + age + 's') + '\n' +
      'Regime: ' + (cfg.ACTIVE_REGIME || 'NEUTRAL') + '\n' +
      'BUY_DEX: ' + (cfg.DISABLE_BUY_DEX ? 'DISABLED' : 'ENABLED') + '\n\n' +
      '<b>Balances</b>\n' +
      'Solana: $' + (b.solana||0).toFixed(2) + '\n' +
      'OKX: $' + (b.okx||0).toFixed(2) + '\n' +
      'Bybit: $' + (b.bybit||0).toFixed(2) + '\n' +
      'Kraken: $' + (b.kraken||0).toFixed(2) + '\n' +
      'Total: $' + total.toFixed(2) + '\n\n' +
      '<b>P&L</b>\n' +
      'Trades: ' + (state.totalTrades||0) + ' | Wins: ' + (state.totalWins||0) + '\n' +
      'Profit: $' + (state.totalProfit||0).toFixed(4);
  }

  // ── /balances ─────────────────────────────────────────────────────────────
  if (cmd === '/balances') {
    const b = loadStatus().liveBalances || {};
    const total = Object.values(b).reduce((a,v) => a + (typeof v === 'number' ? v : 0), 0);
    return '<b>Balances</b>\n' +
      'Solana: $' + (b.solana||0).toFixed(2) + '\n' +
      'OKX: $'    + (b.okx||0).toFixed(2) + '\n' +
      'Bybit: $'  + (b.bybit||0).toFixed(2) + '\n' +
      'Kraken: $' + (b.kraken||0).toFixed(2) + '\n' +
      'Coinbase: $' + (b.coinbase||0).toFixed(2) + '\n' +
      'Total: $'  + total.toFixed(2);
  }

  // ── /trades ───────────────────────────────────────────────────────────────
  if (cmd === '/trades') {
    const trades = readJSON(TRADES_FILE) || [];
    const recent = trades.slice(-5).reverse();
    if (!recent.length) return 'No trades yet';
    const lines = recent.map(t =>
      (t.outcome === 'WIN' ? '✅' : '❌') + ' ' +
      t.pair + ' ' + t.direction + '\n' +
      '  Spread: ' + (t.spreadPct||0).toFixed(3) + '% | P&L: ' + (t.profit >= 0 ? '+' : '') + '$' + (t.profit||0).toFixed(4) + '\n' +
      '  ' + (t.date||'').slice(0,16).replace('T',' ')
    ).join('\n\n');
    return '<b>Recent Trades</b>\n\n' + lines;
  }

  // ── /wins ─────────────────────────────────────────────────────────────────
  if (cmd === '/wins') {
    const trades = readJSON(TRADES_FILE) || [];
    const wins   = trades.filter(t => t.outcome === 'WIN');
    const losses = trades.filter(t => t.outcome === 'LOSS');
    const profit = trades.reduce((a,t) => a + (t.profit||0), 0);
    const wr     = trades.length ? Math.round(wins.length / trades.length * 100) : 0;
    return '<b>Win/Loss Summary</b>\n' +
      'Trades: ' + trades.length + '\n' +
      'Wins: ' + wins.length + ' (' + wr + '%)\n' +
      'Losses: ' + losses.length + '\n' +
      'Total P&L: ' + (profit >= 0 ? '+' : '') + '$' + profit.toFixed(4);
  }

  // ── /rb confirm ───────────────────────────────────────────────────────────
  if (cmd === '/rb confirm') {
    const b = loadStatus().liveBalances || {};
    const keys = ['solana','okx','bybit','kraken'].filter(k => b[k] > 0);
    if (keys.length < 2) return '❌ Insufficient balance data for rebalance';
    const total  = keys.reduce((a,k) => a + b[k], 0);
    const target = total / keys.length;
    const over   = keys.filter(k => b[k] > target * 1.08);
    const under  = keys.filter(k => b[k] < target * 0.92);
    if (!over.length || !under.length) {
      return '✅ Balances already within 8% tolerance\n' +
        keys.map(k => k + ': $' + b[k].toFixed(2)).join('\n') +
        '\nTarget: $' + target.toFixed(2);
    }
    // Write rebalance flag for bot to pick up
    const cfg = loadConfig();
    cfg.REBALANCE_NOW = true;
    cfg.REBALANCE_TARGET = target;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    return '⚖️ Rebalance triggered\nTarget: $' + target.toFixed(2) + ' per exchange\n' +
      'Over: ' + over.map(k => k + ' $' + b[k].toFixed(2)).join(', ') + '\n' +
      'Under: ' + under.map(k => k + ' $' + b[k].toFixed(2)).join(', ') + '\n' +
      'Bot will execute within 30s';
  }

  // ── /crash ────────────────────────────────────────────────────────────────
  if (cmd === '/crash') {
    try {
      const lines = fs.readFileSync(CRASH_FILE, 'utf8').split('\n').filter(Boolean);
      const last5 = lines.slice(-5).join('\n');
      return '<b>Last crash entries:</b>\n' + last5;
    } catch { return 'No crash log found'; }
  }

  // ── /pause / /resume ──────────────────────────────────────────────────────
  if (cmd === '/pause') {
    const cfg = loadConfig();
    cfg.DISABLE_BUY_DEX = true;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    return '⏸️ Trading paused — BUY_DEX disabled';
  }

  if (cmd === '/resume') {
    const cfg = loadConfig();
    cfg.DISABLE_BUY_DEX = false;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    return '▶️ Trading resumed — BUY_DEX enabled';
  }

  // ── /regime ───────────────────────────────────────────────────────────────
  if (cmd === '/regime') {
    try {
      const sm = require('./strategy');
      return sm.generateReport();
    } catch(e) { return '❌ Strategy error: ' + e.message; }
  }

  if (cmd === '/regime check') {
    try {
      const sm  = require('./strategy');
      const cfg = loadConfig();
      await tg('🔍 Checking market regime...');
      const changed = await sm.checkAndApply(cfg, CONFIG_FILE);
      const newCfg  = loadConfig();
      return '✅ Regime check complete\nRegime: ' + newCfg.ACTIVE_REGIME + (changed ? ' (CHANGED)' : ' (unchanged)');
    } catch(e) { return '❌ ' + e.message; }
  }

  // ── /thresholds ───────────────────────────────────────────────────────────
  if (cmd === '/thresholds') {
    try {
      const te = require('./threshold');
      return te.generateReport();
    } catch(e) { return '❌ ' + e.message; }
  }

  // ── /calibrate ────────────────────────────────────────────────────────────
  if (cmd === '/calibrate') {
    try {
      const te = require('./threshold');
      te.calibrateFromHistory(TRADES_FILE);
      return te.generateReport();
    } catch(e) { return '❌ ' + e.message; }
  }

  // ── /funding ──────────────────────────────────────────────────────────────
  if (cmd === '/funding') {
    try {
      const fa = require('./funding-arb');
      const pairs = ['SOL','JTO','WIF','PENGU','PNUT'];
      await tg('📡 Fetching funding rates...');
      const report = await fa.generateFundingReport(pairs);
      return report;
    } catch(e) { return '❌ ' + e.message; }
  }

  // ── /listings ─────────────────────────────────────────────────────────────
  if (cmd === '/listings') {
    try {
      const lm = require('./listing-monitor');
      return lm.generateListingReport();
    } catch(e) { return '❌ ' + e.message; }
  }

  // ── /scan-okx ─────────────────────────────────────────────────────────────
  if (cmd === '/scan-okx') {
    tg('🔍 Starting OKX universe scan (~5min)...').catch(()=>{});
    require('./listing-monitor').scanFullOKXUniverse(tg)
      .then(r => tg('✅ OKX scan: ' + r.added + ' new pairs from ' + r.total + ' checked').catch(()=>{}))
      .catch(e => tg('❌ ' + e.message).catch(()=>{}));
    return null;
  }

  // ── /dex on|off ───────────────────────────────────────────────────────────
  if (cmd === '/dex on') {
    const cfg = loadConfig();
    cfg.DEX_ARB_ENABLED = true;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    return '⚡ DEX arb enabled';
  }

  if (cmd === '/dex off') {
    const cfg = loadConfig();
    cfg.DEX_ARB_ENABLED = false;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    return '⚡ DEX arb disabled';
  }

  // ── /help ─────────────────────────────────────────────────────────────────
  if (cmd === '/help') {
    return '<b>arb-core v' + VERSION + ' Commands</b>\n\n' +
      '/status — bot health + balances + P&L\n' +
      '/balances — exchange balances\n' +
      '/trades — last 5 trades\n' +
      '/wins — win/loss summary\n' +
      '/rb confirm — trigger rebalance\n' +
      '/crash — last crash log\n' +
      '/pause — pause trading\n' +
      '/resume — resume trading\n' +
      '/regime — current market regime\n' +
      '/regime check — force regime re-check\n' +
      '/thresholds — pair thresholds\n' +
      '/calibrate — recalibrate from history\n' +
      '/funding — funding rates\n' +
      '/listings — listing monitor\n' +
      '/scan-okx — full OKX universe scan\n' +
      '/dex on|off — toggle DEX arb';
  }

  return null; // unknown command
}

// ── Automated monitoring rules ────────────────────────────────────────────────
async function runRules() {
  const status    = loadStatus();
  const cfg       = loadConfig();
  const agentState= loadAgentState();
  const now       = Date.now();

  // Rule 1: Bot stale alert
  if (status.timestamp) {
    const age = (now - new Date(status.timestamp).getTime()) / 1000;
    const lastAlert = agentState.lastStaleAlert || 0;
    if (age > 180 && now - lastAlert > 5 * 60 * 1000) {
      await tg('🚨 <b>Bot stale ' + Math.round(age) + 's</b> — may be crashed. Check watchdog.');
      agentState.lastStaleAlert = now;
      saveAgentState(agentState);
    }
  }

  // Rule 2: Strategy regime check (every 5 minutes)
  const lastRegime = agentState.lastRegimeCheck || 0;
  if (now - lastRegime > 5 * 60 * 1000) {
    try {
      const sm      = require('./strategy');
      const changed = await sm.checkAndApply(cfg, CONFIG_FILE);
      if (changed) {
        const newCfg = loadConfig();
        const emoji  = newCfg.ACTIVE_REGIME === 'BULL' ? '🟢' : newCfg.ACTIVE_REGIME === 'BEAR' ? '🔴' : '🟡';
        await tg(emoji + ' <b>Regime changed → ' + newCfg.ACTIVE_REGIME + '</b>\n' + sm.generateReport());
      }
      agentState.lastRegimeCheck = now;
      saveAgentState(agentState);
    } catch(e) { log('Regime check error: ' + e.message); }
  }

  // Rule 3: Spread approaching threshold alert (every 5 minutes)
  const lastSpread = agentState.lastSpreadAlert || 0;
  if (now - lastSpread > 5 * 60 * 1000) {
    try {
      const live = readJSON(LIVE_FILE);
      const liveAge = live ? (now - new Date(live.timestamp).getTime()) / 1000 : 999;
      if (liveAge < 30 && live.pairs) {
        const approaching = live.pairs.filter(p =>
          p.spreadDex > 0 && p.spreadDex > p.dexThresh * 0.5
        );
        if (approaching.length > 0) {
          const lines = approaching.map(p =>
            p.name.replace('/USDT','') + ': ' + p.spreadDex.toFixed(3) + '% (thr:' + p.dexThresh.toFixed(2) + '%)'
          ).join('\n');
          await tg('📡 <b>Spreads approaching threshold</b>\n' + lines);
          agentState.lastSpreadAlert = now;
          saveAgentState(agentState);
        }
      }
    } catch {}
  }

  // Rule 4: Low balance warning
  const lastBalAlert = agentState.lastBalAlert || 0;
  if (now - lastBalAlert > 60 * 60 * 1000) {
    const b = status.liveBalances || {};
    const low = Object.entries(b).filter(([k,v]) => typeof v === 'number' && v > 0 && v < 50 && k !== 'total');
    if (low.length > 0) {
      await tg('⚠️ <b>Low balance warning</b>\n' + low.map(([k,v]) => k + ': $' + v.toFixed(2)).join('\n'));
      agentState.lastBalAlert = now;
      saveAgentState(agentState);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log('Agent v' + VERSION + ' starting');
  await tg('🤖 <b>Agent v' + VERSION + ' online</b>\n/help for commands');

  // Poll Telegram every 3 seconds
  setInterval(pollTelegram, 3000);

  // Run monitoring rules every minute
  setInterval(runRules, POLL_MS);

  // Run rules immediately on start
  await runRules();
}

main().catch(e => {
  log('Agent fatal: ' + e.message);
  process.exit(1);
});
