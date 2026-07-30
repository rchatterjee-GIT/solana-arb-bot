require('dotenv').config();
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const BOT_SCRIPT  = path.join(__dirname, 'okx-arb.js');
const CRASH_LOG   = path.join(__dirname, 'crash.log');
const STATE_FILE  = path.join(__dirname, 'arb-state.json');
const TRADES_FILE = path.join(__dirname, 'trades.json');
const RESTART_SEC = 10;
let   restarts    = 0;
let   botProc     = null;
let   lastUpdateId = 0;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;

// ── Global crash handlers ─────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  const msg = `${new Date().toISOString()} WATCHDOG CRASH: ${err.message}\n${err.stack}\n\n`;
  console.error('💥 Watchdog uncaught exception:', err.message);
  try { fs.appendFileSync(CRASH_LOG, msg); } catch (e) { /* ignore */ }
});

process.on('unhandledRejection', (reason) => {
  const msg = `${new Date().toISOString()} WATCHDOG REJECTION: ${reason}\n\n`;
  console.error('💥 Watchdog unhandled rejection:', reason);
  try { fs.appendFileSync(CRASH_LOG, msg); } catch (e) { /* ignore */ }
});

// ── Telegram helpers ──────────────────────────────────────────────────────────
async function tgSend(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: TELEGRAM_CHAT, text, parse_mode: 'HTML' }),
    });
  } catch (e) { /* ignore */ }
}

async function tgGetUpdates() {
  if (!TELEGRAM_TOKEN) return [];
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`
    );
    const j = await res.json();
    return j.result || [];
  } catch (e) { return []; }
}

// ── Command handlers ──────────────────────────────────────────────────────────
async function handleCommand(text) {
  const cmd = text.trim().toLowerCase().split(' ')[0];

  if (cmd === '/status' || cmd === '/s') {
    try {
      const state  = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const isAlive = botProc && !botProc.killed;
      const lastUpdate = new Date(state.lastUpdated);
      const minutesAgo = Math.round((Date.now() - lastUpdate.getTime()) / 60000);
      const winsBar = `${'🟢'.repeat(state.consecutiveWins || 0)}${'⚪'.repeat(Math.max(0, 5 - (state.consecutiveWins || 0)))} ${state.consecutiveWins || 0}/5`;

      await tgSend(
        `🐕 <b>Watchdog Status</b>\n` +
        `Bot: ${isAlive ? '✅ running' : '❌ down'}\n` +
        `Restarts: ${restarts}\n` +
        `Last state update: ${minutesAgo}min ago\n\n` +
        `💰 P&L: ${state.totalProfit >= 0 ? '+' : ''}$${state.totalProfit.toFixed(4)}\n` +
        `📊 Trades: ${state.totalTrades} | Wins: ${state.winningTrades}\n` +
        `🎯 Consecutive: ${winsBar}\n` +
        `💼 Capital: $${(state.startCapital || 0).toFixed(2)} start\n` +
        `⏰ ${new Date().toUTCString()}`
      );
    } catch (err) {
      await tgSend(`❌ Status error: ${err.message}`);
    }
  }

  else if (cmd === '/wins' || cmd === '/w') {
    try {
      const state  = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const wins   = state.consecutiveWins || 0;
      const winsBar = `${'🟢'.repeat(wins)}${'⚪'.repeat(Math.max(0, 5 - wins))} ${wins}/5`;
      await tgSend(
        `🎯 <b>Win Counter</b>\n` +
        `${winsBar}\n\n` +
        `Total trades: ${state.totalTrades}\n` +
        `Total wins: ${state.winningTrades}\n` +
        `Win rate: ${state.totalTrades > 0 ? Math.round((state.winningTrades / state.totalTrades) * 100) : 0}%\n` +
        `P&L: ${state.totalProfit >= 0 ? '+' : ''}$${state.totalProfit.toFixed(4)}`
      );
    } catch (err) {
      await tgSend(`❌ Error: ${err.message}`);
    }
  }

  else if (cmd === '/trades' || cmd === '/t') {
    try {
      const trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
      const last5  = trades.slice(-5).reverse();
      const lines  = last5.map(t => {
        const date   = new Date(t.date).toISOString().slice(11, 16);
        const profit = t.profit >= 0 ? `+$${t.profit.toFixed(3)}` : `-$${Math.abs(t.profit).toFixed(3)}`;
        const icon   = t.profit >= 0 ? '✅' : '❌';
        return `${icon} ${date} ${t.pair} ${t.direction.replace('BUY_', '')} ${profit}`;
      }).join('\n');
      await tgSend(`📊 <b>Last 5 trades:</b>\n<pre>${lines}</pre>`);
    } catch (err) {
      await tgSend(`❌ Error: ${err.message}`);
    }
  }

  else if (cmd === '/crash' || cmd === '/c') {
    try {
      if (!fs.existsSync(CRASH_LOG)) {
        await tgSend('✅ No crash log — no crashes recorded');
        return;
      }
      const content = fs.readFileSync(CRASH_LOG, 'utf8').trim();
      if (!content) {
        await tgSend('✅ Crash log is empty');
        return;
      }
      const crashes = content.split('\n\n').filter(Boolean);
      const last    = crashes[crashes.length - 1];
      await tgSend(`💥 <b>Last crash:</b>\n<pre>${last.slice(0, 500)}</pre>`);
    } catch (err) {
      await tgSend(`❌ Error: ${err.message}`);
    }
  }

  else if (cmd === '/restart' || cmd === '/r') {
    await tgSend('🔄 Restarting bot...');
    if (botProc) {
      try { botProc.kill('SIGTERM'); } catch (e) { /* ignore */ }
    }
    // start() will be called automatically via proc.on('exit')
  }

  else if (cmd === '/help' || cmd === '/h') {
    await tgSend(
      `🤖 <b>Available commands:</b>\n\n` +
      `/status — bot status + P&L summary\n` +
      `/wins — consecutive win counter\n` +
      `/trades — last 5 trades\n` +
      `/crash — last crash details\n` +
      `/restart — restart the bot\n` +
      `/help — this message\n\n` +
      `Shortcuts: /s /w /t /c /r /h`
    );
  }
}

// ── Poll Telegram for commands ────────────────────────────────────────────────
async function pollTelegram() {
  try {
    const updates = await tgGetUpdates();
    for (const update of updates) {
      lastUpdateId = update.update_id;
      const text = update.message?.text;
      const chatId = update.message?.chat?.id?.toString();
      if (text && chatId === TELEGRAM_CHAT) {
        console.log(`📱 Telegram command: ${text}`);
        await handleCommand(text);
      }
    }
  } catch (e) { /* ignore */ }
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────
setInterval(() => {
  try { fs.writeFileSync(path.join(__dirname, 'watchdog.heartbeat'), new Date().toISOString()); }
  catch (e) { /* ignore */ }
}, 60 * 1000);

// ── Hourly watchdog alive ping ────────────────────────────────────────────────
setInterval(async () => {
  try {
    const state    = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const winsBar  = `${'🟢'.repeat(state.consecutiveWins || 0)}${'⚪'.repeat(Math.max(0, 5 - (state.consecutiveWins || 0)))} ${state.consecutiveWins || 0}/5`;
    await tgSend(
      `🐕 <b>Watchdog heartbeat</b>\n` +
      `Bot restarts: ${restarts}\n` +
      `Wins: ${winsBar}\n` +
      `P&L: ${state.totalProfit >= 0 ? '+' : ''}$${state.totalProfit.toFixed(4)}\n` +
      `⏰ ${new Date().toUTCString()}`
    );
  } catch (e) { /* ignore */ }
}, 60 * 60 * 1000);

// ── Poll commands every 5 seconds ────────────────────────────────────────────
setInterval(pollTelegram, 5000);

// ── Kill existing processes ───────────────────────────────────────────────────
function killExisting() {
  try {
    execSync('pkill -f okx-arb.js 2>/dev/null || true', { encoding: 'utf8' });
    console.log('🛑 Killed existing okx-arb.js processes');
  } catch (e) { /* ignore */ }
  const start = Date.now();
  while (Date.now() - start < 2000) { const buf = Buffer.alloc(1); }
}

// ── Start bot ─────────────────────────────────────────────────────────────────
function start() {
  const now = new Date().toLocaleTimeString();
  console.log(`[${now}] 🐕 Watchdog: starting bot (restart #${restarts})...`);

  try {
    botProc = spawn('node', [BOT_SCRIPT], { stdio: 'inherit' });
  } catch (err) {
    const msg = `${new Date().toISOString()} SPAWN ERROR: ${err.message}\n\n`;
    console.error('💥 Failed to spawn bot:', err.message);
    try { fs.appendFileSync(CRASH_LOG, msg); } catch (e) { /* ignore */ }
    setTimeout(start, RESTART_SEC * 1000);
    return;
  }

  botProc.on('exit', (code, signal) => {
    const ts  = new Date().toLocaleTimeString();
    const msg = `${new Date().toISOString()} BOT EXIT: code=${code} signal=${signal} restart=#${restarts}\n\n`;
    restarts++;
    console.log(`[${ts}] ⚠️  Bot exited (code=${code} signal=${signal}) — restarting in ${RESTART_SEC}s...`);
    try { fs.appendFileSync(CRASH_LOG, msg); } catch (e) { /* ignore */ }
    tgSend(`⚠️ <b>Bot crashed — restarting</b>\ncode=${code} signal=${signal}\nRestart #${restarts}`);
    setTimeout(start, RESTART_SEC * 1000);
  });

  botProc.on('error', (err) => {
    const msg = `${new Date().toISOString()} PROC ERROR: ${err.message}\n\n`;
    console.error(`Watchdog proc error: ${err.message}`);
    try { fs.appendFileSync(CRASH_LOG, msg); } catch (e) { /* ignore */ }
  });
}

console.log('🐕 Watchdog started — bot will auto-restart on crash');
console.log('📱 Telegram commands: /status /wins /trades /crash /restart /help');
killExisting();
start();