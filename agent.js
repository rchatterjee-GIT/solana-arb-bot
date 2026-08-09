// agent.js — fully autonomous trading agent
// Runs as a separate process alongside the bot
// Monitors performance, adjusts config, self-heals, reports

require('dotenv').config();
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const rules  = require('./agent-rules');
const { fetchMarketData, getMarketData } = require('./market-data');

const CONFIG_FILE    = path.join(__dirname, 'arb-config.json');
const STATE_FILE     = path.join(__dirname, 'arb-state.json');
const TRADES_FILE    = path.join(__dirname, 'trades.json');
const FIRES_FILE     = path.join(__dirname, 'fires.json');
const STATUS_FILE    = path.join(__dirname, 'bot-status.json');
const CRASH_FILE     = path.join(__dirname, 'crash.log');
const AGENT_FILE     = path.join(__dirname, 'agent-state.json');
const AGENT_LOG      = path.join(__dirname, 'agent.log');

const AGENT_VERSION  = 'v1.0';
const CYCLE_MS       = 60 * 1000;  // run every 60 seconds
const PAUSED_KEY     = 'paused';

function readJSON(f) { try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch { return null; } }
function writeJSON(f, d) { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

function agentLog(msg, level='INFO') {
  const line = `[${new Date().toISOString().slice(0,19)}] [${level}] ${msg}`;
  console.log(`🤖 ${line}`);
  try {
    const existing = fs.existsSync(AGENT_LOG) ? fs.readFileSync(AGENT_LOG,'utf8') : '';
    const lines = existing.split('\n').filter(Boolean);
    lines.push(line);
    fs.writeFileSync(AGENT_LOG, lines.slice(-1000).join('\n') + '\n');
  } catch {}
}

async function sendTG(text) {
  try {
    await fetch('https://api.telegram.org/bot'+process.env.TELEGRAM_TOKEN+'/sendMessage', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({chat_id: process.env.TELEGRAM_CHAT_ID, text, parse_mode:'HTML'})
    });
  } catch(e) { agentLog('Telegram send failed: '+e.message, 'WARN'); }
}

function buildPairStats(trades) {
  const stats = {};
  const real = trades.filter(t => t.direction !== 'RECOVERY');
  for (const t of real) {
    if (!stats[t.pair]) stats[t.pair] = {
      total:0, wins:0, losses:0, pnl:0, spreads:[], winSpreads:[], lossSpreads:[],
      recentLosses:0, lastExchange:null, lastDate:null
    };
    const s = stats[t.pair];
    s.total++;
    s.pnl += t.profit||0;
    s.spreads.push(t.spreadPct||0);
    s.lastExchange = (t.direction||'').replace('BUY_','');
    s.lastDate = t.date;
    if (t.profit > 0) { s.wins++; s.winSpreads.push(t.spreadPct||0); }
    else { s.losses++; s.lossSpreads.push(t.spreadPct||0); }
  }
  // Calculate derived stats
  for (const [pair, s] of Object.entries(stats)) {
    s.winRate = s.total ? s.wins/s.total : 0;
    s.lossRate = s.total ? s.losses/s.total : 0;
    s.avgSpread = s.spreads.length ? s.spreads.reduce((a,b)=>a+b,0)/s.spreads.length : 0;
    s.avgWinSpread = s.winSpreads.length ? s.winSpreads.reduce((a,b)=>a+b,0)/s.winSpreads.length : 0;
    s.minWinSpread = s.winSpreads.length ? Math.min(...s.winSpreads) : 0;
    // Count consecutive recent losses (last 5 trades for this pair)
    const pairTrades = real.filter(t=>t.pair===pair).slice(-5);
    let consec = 0;
    for (let i=pairTrades.length-1;i>=0;i--) { if(pairTrades[i].profit<=0)consec++;else break; }
    s.recentLosses = consec;
  }
  return stats;
}

async function getBalances() {
  // Read from bot-status liveBalances if available, else from state
  const status = readJSON(STATUS_FILE)||{};
  const state  = readJSON(STATE_FILE)||{};
  return {
    solana: status.liveBalances?.solana || null,
    okx:    status.liveBalances?.okx    || null,
    bybit:  status.liveBalances?.bybit  || null,
    kraken: status.liveBalances?.kraken || null,
  };
}

async function resyncState() {
  const state  = readJSON(STATE_FILE)||{};
  const trades = readJSON(TRADES_FILE)||[];
  const real   = trades.filter(t=>t.direction!=='RECOVERY');
  const wins   = real.filter(t=>t.profit>0).length;
  const pnl    = real.reduce((a,t)=>a+(t.profit||0),0);
  let cw=0; for(let i=real.length-1;i>=0;i--){if(real[i].profit>0)cw++;else break;}
  const corrected = {...state, totalTrades:real.length, winningTrades:wins, totalProfit:pnl, consecutiveWins:cw, lastResync:new Date().toISOString()};
  writeJSON(STATE_FILE, corrected);
  agentLog(`State resynced: ${real.length} trades, ${wins} wins, P&L $${pnl.toFixed(2)}`);
}

function getRecentCrashLines() {
  try {
    const log = fs.readFileSync(CRASH_FILE,'utf8');
    const lines = log.split('\n');
    const cutoff = Date.now() - 60*60*1000; // last hour
    return lines.filter(l => {
      const match = l.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
      return match && new Date(match[1]).getTime() > cutoff;
    });
  } catch { return []; }
}

function handleTelegramCommand(text, agentState) {
  if (text === '/agent status') {
    const paused = agentState[PAUSED_KEY];
    return `🤖 Agent ${AGENT_VERSION}\nStatus: ${paused?'PAUSED':'RUNNING'}\nCycle: every 60s\nLast run: ${agentState.lastRun?.slice(0,19)||'never'}\nActions today: ${agentState.actionsToday||0}`;
  }
  if (text === '/agent pause') { agentState[PAUSED_KEY]=true; return '🤖 Agent paused — no autonomous actions will be taken'; }
  if (text === '/agent resume') { agentState[PAUSED_KEY]=false; return '🤖 Agent resumed'; }
  if (text === '/agent history') {
    const history = (agentState.history||[]).slice(-10);
    if (!history.length) return '🤖 No actions taken yet';
    return '🤖 Last 10 actions:\n' + history.map(h=>`${h.time.slice(0,16)} ${h.rule}: ${h.changes.join(', ')}`).join('\n');
  }
  if (text === '/agent report') return '__FORCE_REPORT__';
  return null;
}

async function pollTelegram(agentState, offset) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getUpdates?offset=${offset}&timeout=5`);
    const j = await r.json();
    let newOffset = offset;
    for (const update of (j.result||[])) {
      newOffset = update.update_id + 1;
      const text = update.message?.text;
      if (!text || !text.startsWith('/agent')) continue;
      const response = handleTelegramCommand(text, agentState);
      if (response === '__FORCE_REPORT__') {
        agentState.lastDailyReport = 0; // force report on next cycle
        await sendTG('🤖 Forcing report on next cycle...');
      } else if (response) {
        await sendTG(response);
      }
    }
    return newOffset;
  } catch { return offset; }
}

async function runCycle(agentState) {
  if (agentState[PAUSED_KEY]) { agentLog('Agent paused — skipping cycle'); return; }

  const config  = readJSON(CONFIG_FILE)||{};
  const state   = readJSON(STATE_FILE)||{};
  const trades  = readJSON(TRADES_FILE)||[];
  const fires   = readJSON(FIRES_FILE)||[];
  const botStatus = readJSON(STATUS_FILE)||{};
  const real    = trades.filter(t=>t.direction!=='RECOVERY');
  const pairStats = buildPairStats(trades);
  const balances  = await getBalances();
  const pending   = [...(botStatus.pendingDex||[]), ...(botStatus.pendingOkx||[]), ...(botStatus.pendingBybit||[])];
  const recentCrashLines = getRecentCrashLines();

  // Get market data (cached, refreshes every 30min)
  let marketData = getMarketData();
  if (!marketData) {
    agentLog('Refreshing market data...');
    marketData = await fetchMarketData(config.TRADE_SIZE_USD || 120);
  }

  const ctx = {
    config, state, trades, fires, pairStats, balances, pending,
    botStatus, agentState, recentCrashLines, marketData,
    realTradeCount: real.length,
    sendTG, resyncState,
  };

  let configChanged = false;
  const allChanges = [];

  const now = Date.now();
  for (const rule of rules) {
    try {
      // Cooldown: info rules max once per hour, warn once per 30min, critical always
      const lastFired = agentState.ruleCooldowns?.[rule.id] || 0;
      const cooldown = rule.severity === 'critical' ? 0 : rule.severity === 'warn' ? 30*60*1000 : 60*60*1000;
      if (cooldown > 0 && now - lastFired < cooldown) continue;

      const issues = rule.detect(ctx);
      if (!issues) continue;

      // Record fire time
      if (!agentState.ruleCooldowns) agentState.ruleCooldowns = {};
      agentState.ruleCooldowns[rule.id] = now;

      agentLog(`Rule triggered: ${rule.name} (${rule.severity})`, rule.severity === 'critical' ? 'WARN' : 'INFO');
      const changes = await rule.action(ctx, issues);

      if (changes && changes.length) {
        allChanges.push(...changes.map(c => ({ time: new Date().toISOString(), rule: rule.id, changes: [c], severity: rule.severity })));
        for (const c of changes) agentLog(`Action: ${c}`);
        configChanged = true;
      }
    } catch(e) {
      agentLog(`Rule ${rule.id} error: ${e.message}`, 'ERROR');
    }
  }

  // Save config if changed
  if (configChanged) {
    writeJSON(CONFIG_FILE, ctx.config);
    agentLog('Config updated — bot will hot-reload within 30s');
    if (allChanges.length) {
      const msgs = allChanges.map(c => `• ${c.changes[0]}`).join('\n');
      await sendTG(`🤖 <b>Agent Actions</b>\n${msgs}`);
    }
  }

  // Update agent state
  agentState.lastRun = new Date().toISOString();
  agentState.history = [...(agentState.history||[]), ...allChanges].slice(-100);
  agentState.actionsToday = (agentState.actionsToday||0) + allChanges.length;
  // Reset daily action count at midnight
  const today = new Date().toISOString().slice(0,10);
  if (agentState.lastActionDate !== today) { agentState.actionsToday = allChanges.length; agentState.lastActionDate = today; }

  writeJSON(AGENT_FILE, agentState);
}

async function main() {
  agentLog(`Agent ${AGENT_VERSION} starting...`);
  await sendTG(`🤖 <b>Agent ${AGENT_VERSION} online</b>\nMonitoring: pairs, balances, state, crashes\nCommands: /agent status | history | pause | resume | report`);

  let agentState = readJSON(AGENT_FILE) || { history: [], lastDailyReport: 0 };
  let tgOffset = 0;

  // Run first cycle immediately
  await runCycle(agentState);

  setInterval(async () => {
    try {
      tgOffset = await pollTelegram(agentState, tgOffset);
      await runCycle(agentState);
    } catch(e) { agentLog('Cycle error: '+e.message, 'ERROR'); }
  }, CYCLE_MS);
}

main().catch(e => { agentLog('Fatal: '+e.message, 'ERROR'); process.exit(1); });
