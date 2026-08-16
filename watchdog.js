require('dotenv').config();
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const BOT_SCRIPT  = path.join(__dirname, 'okx-arb.js');
const CRASH_LOG   = path.join(__dirname, 'crash.log');
const STATE_FILE  = path.join(__dirname, 'arb-state.json');
const TRADES_FILE = path.join(__dirname, 'trades.json');
const STATUS_FILE = path.join(__dirname, 'bot-status.json');
const RESTART_SEC = 10;
let   restarts    = 0;
let   botProc     = null;
let   lastUpdateId = 0;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;

const WATCHDOG_VERSION = 'v1.2'; // Kraken + Coinbase monitoring

// ── Global crash handlers ─────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  const msg = `${new Date().toISOString()} WATCHDOG CRASH: ${err.message}\n${err.stack}\n\n`;
  console.error('💥 Watchdog uncaught exception:', err.message);
  try { fs.appendFileSync(CRASH_LOG, msg); } catch {}
});
process.on('unhandledRejection', (reason) => {
  console.error('💥 Watchdog unhandled rejection:', reason);
  try { fs.appendFileSync(CRASH_LOG, `${new Date().toISOString()} WATCHDOG REJECTION: ${reason}\n\n`); } catch {}
});

// ── Telegram helpers ──────────────────────────────────────────────────────────
async function tgSend(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text, parse_mode: 'HTML' }),
    });
  } catch {}
}

async function tgGetUpdates() {
  if (!TELEGRAM_TOKEN) return [];
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`
    );
    const j = await res.json();
    return j.result || [];
  } catch { return []; }
}

// ── Balance helpers ───────────────────────────────────────────────────────────
function getLiveBalances() {
  try {
    const s = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    return s.liveBalances || {};
  } catch { return {}; }
}

function formatBalance(val, currency) {
  if (val == null) return 'syncing';
  return '$' + val.toFixed(0) + ' ' + currency;
}

function getCapitalSummary() {
  const lb = getLiveBalances();
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const total = (lb.solana||0) + (lb.okx||0) + (lb.bybit||0) + (lb.kraken||0) + (lb.coinbase||0);
  const sc = state.startCapital || 261.31;
  const roi = ((total - sc) / sc * 100).toFixed(1);
  return { lb, total, sc, roi, state };
}

// ── Command handlers ──────────────────────────────────────────────────────────
async function handleCommand(text) {
  const cmd = text.trim().toLowerCase().split(' ')[0];

  if (cmd === '/status' || cmd === '/s') {
    try {
      const { lb, total, roi, state } = getCapitalSummary();
      const isAlive = botProc && !botProc.killed;
      const minutesAgo = Math.round((Date.now() - new Date(state.lastUpdated).getTime()) / 60000);
      const winsBar = '🟢'.repeat(state.consecutiveWins||0) + '⚪'.repeat(Math.max(0,10-(state.consecutiveWins||0)));

      await tgSend(
        '🤖 [BOT] Watchdog ' + WATCHDOG_VERSION + ' Status\n' +
        'Bot: ' + (isAlive?'✅ running':'❌ DOWN') + ' | Restarts: ' + restarts + '\n' +
        'Last update: ' + minutesAgo + 'min ago\n\n' +
        'Sol: ' + formatBalance(lb.solana,'USDC') + '\n' +
        'OKX: ' + formatBalance(lb.okx,'USDT') + '\n' +
        'Bybit: ' + formatBalance(lb.bybit,'USDT') + '\n' +
        'Kraken: ' + formatBalance(lb.kraken,'USDT') + '\n' +
        'Coinbase: ' + formatBalance(lb.coinbase,'USDC') + '\n' +
        'Total: $' + total.toFixed(0) + ' (' + (total>=state.startCapital?'+':'') + roi + '% ROI)\n\n' +
        'Wins: ' + winsBar + ' ' + (state.consecutiveWins||0) + '/10\n' +
        'Trades: ' + state.totalTrades + ' | P&L: ' + (state.totalProfit>=0?'+':'') + '$' + (state.totalProfit||0).toFixed(2) + '\n' +
        '⏰ ' + new Date().toUTCString()
      );
    } catch(err) { await tgSend('❌ Status error: ' + err.message); }

  } else if (cmd === '/wins' || cmd === '/w') {
    try {
      const trades = JSON.parse(fs.readFileSync(TRADES_FILE,'utf8'));
      const real = trades.filter(t => t.direction !== 'RECOVERY');
      const wins = real.filter(t => t.profit > 0);
      const pnl = real.reduce((a,t) => a+(t.profit||0), 0);
      const recent = real.slice(-5).map(t =>
        (t.profit>0?'✅':'❌') + ' ' + t.direction.replace('BUY_','') + ' ' + t.pair.replace('/USDT','') +
        ' ' + (t.profit>=0?'+':'') + '$' + t.profit.toFixed(2)
      ).join('\n');
      await tgSend(
        '⚡ [TRADE] Win Summary\n' +
        'Total: ' + real.length + ' trades | ' + wins.length + ' wins (' + Math.round(wins.length/Math.max(1,real.length)*100) + '%)\n' +
        'P&L: ' + (pnl>=0?'+':'') + '$' + pnl.toFixed(2) + '\n\n' +
        'Last 5:\n' + recent
      );
    } catch(err) { await tgSend('❌ Wins error: ' + err.message); }

  } else if (cmd === '/trades' || cmd === '/t') {
    try {
      const trades = JSON.parse(fs.readFileSync(TRADES_FILE,'utf8'));
      const real = trades.filter(t => t.direction !== 'RECOVERY').slice(-8);
      const lines = real.map(t =>
        (t.profit>0?'✅':'❌') + ' ' + t.direction.replace('BUY_','') + ' ' +
        t.pair.replace('/USDT','') + ' ' + (t.profit>=0?'+':'') + '$' + t.profit.toFixed(2) +
        ' @ ' + t.spreadPct.toFixed(2) + '%'
      ).join('\n');
      await tgSend('⚡ [TRADE] Last 8 trades:\n' + lines);
    } catch(err) { await tgSend('❌ Trades error: ' + err.message); }

  } else if (cmd === '/crash') {
    try {
      const log = fs.existsSync(CRASH_LOG) ? fs.readFileSync(CRASH_LOG,'utf8') : 'No crashes';
      const last = log.split('\n\n').filter(Boolean).slice(-2).join('\n---\n');
      await tgSend('💥 Last crashes:\n' + last.slice(0,1000));
    } catch(err) { await tgSend('❌ Crash error: ' + err.message); }

  } else if (cmd === '/restart') {
    await tgSend('🔄 Restarting bot...');
    if (botProc) { botProc.kill('SIGTERM'); }

  } else if (cmd === '/balances' || cmd === '/b') {
    try {
      const { lb, total, roi } = getCapitalSummary();
      await tgSend(
        '🤖 [BOT] Live Balances\n' +
        'Sol: ' + formatBalance(lb.solana,'USDC') + '\n' +
        'OKX: ' + formatBalance(lb.okx,'USDT') + '\n' +
        'Bybit: ' + formatBalance(lb.bybit,'USDT') + '\n' +
        'Kraken: ' + formatBalance(lb.kraken,'USDT') + '\n' +
        'Coinbase: ' + formatBalance(lb.coinbase,'USDC') + '\n' +
        'Total: $' + total.toFixed(0) + ' (' + roi + '% ROI)\n' +
        'Updated: ' + (getLiveBalances().updatedAt||'unknown')
      );
    } catch(err) { await tgSend('❌ Balance error: ' + err.message); }

  } else if (cmd === '/help' || cmd === '/h') {
    await tgSend(
      '🤖 [BOT] Watchdog ' + WATCHDOG_VERSION + ' Commands\n' +
      '/status — bot status + all balances\n' +
      '/balances — live exchange balances\n' +
      '/wins — win summary + last 5 trades\n' +
      '/trades — last 8 trades\n' +
      '/crash — recent crash logs\n' +
      '/restart — restart bot\n' +
      '/help — this message\n\n' +
      'Agent commands (prefix /agent):\n' +
      '/agent status | report | macro | pause | resume'
    );
  }
}

// ── Telegram polling ──────────────────────────────────────────────────────────
async function pollTelegram() {
  const updates = await tgGetUpdates();
  for (const u of updates) {
    lastUpdateId = u.update_id;
    const text = u.message?.text || u.edited_message?.text || '';
    if (text) await handleCommand(text);
  }
}

// ── Bot process management ────────────────────────────────────────────────────
function killExisting() {
  try { execSync('taskkill /F /IM node.exe /FI "WINDOWTITLE eq okx-arb*" 2>nul', { stdio: 'pipe' }); } catch {}
  try { execSync('taskkill /F /IM node.exe /T 2>nul', { stdio: 'pipe' }); } catch {}
}

function start() {
  const timeStr = new Date().toLocaleTimeString('en-GB', { hour12: false });
  console.log(`[${timeStr}] 🚀 Watchdog: starting bot (restart #${restarts})...`);

  botProc = spawn('node', [BOT_SCRIPT], {
    stdio: 'inherit',
    env: process.env,
  });

  botProc.on('exit', (code, signal) => {
    const timeStr2 = new Date().toLocaleTimeString('en-GB', { hour12: false });
    console.log(`[${timeStr2}] ⚠️ Bot exited (code ${code}, signal ${signal}) — restarting in ${RESTART_SEC}s`);
    restarts++;
    if (restarts <= 3) {
      tgSend('⚠️ [WARN] Bot crashed (exit ' + code + ') — restarting in ' + RESTART_SEC + 's (restart #' + restarts + ')').catch(() => {});
    } else if (restarts === 4) {
      tgSend('🚨 [ALERT] Bot crashed ' + restarts + ' times — check crash.log').catch(() => {});
    }
    setTimeout(start, RESTART_SEC * 1000);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log('🐕 Watchdog ' + WATCHDOG_VERSION + ' started — bot will auto-restart on crash');
console.log('📱 Telegram: /status /balances /wins /trades /crash /restart /help');
killExisting();

setInterval(async () => {
  try { await pollTelegram(); } catch {}
}, 3000);

start();
