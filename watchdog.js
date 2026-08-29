/**
 * watchdog.js — Bot Watchdog v5.0
 *
 * Starts and monitors arb-core.js.
 * Restarts automatically on crash with exponential backoff.
 * Writes crash log entries.
 */

'use strict';
require('dotenv').config();
const { spawn } = require('child_process');
const fs        = require('fs');
const path      = require('path');

const VERSION    = '5.0.0';
const BOT_SCRIPT = path.join(__dirname, 'arb-core.js');
const CRASH_LOG  = path.join(__dirname, 'crash.log');
const BASE_DELAY = 5000;   // ms before first restart
const MAX_DELAY  = 60000;  // ms max restart delay
const TG_TOKEN   = process.env.TELEGRAM_TOKEN;
const TG_CHAT    = process.env.TELEGRAM_CHAT_ID;

let restartCount = 0;
let botProcess   = null;

function log(msg) {
  const line = '[' + new Date().toISOString().slice(11,19) + '] ' + msg;
  console.log(line);
}

async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text }),
    });
  } catch {}
}

function writeCrashLog(msg) {
  try {
    fs.appendFileSync(CRASH_LOG, new Date().toISOString() + ' ' + msg + '\n');
  } catch {}
}

function startBot() {
  log('Starting arb-core (restart #' + restartCount + ')...');

  botProcess = spawn('node', [BOT_SCRIPT], {
    stdio: 'inherit',
    env: process.env,
  });

  botProcess.on('exit', (code, signal) => {
    const msg = 'Bot exited (code ' + code + ', signal ' + signal + ')';
    log(msg);

    if (code !== 0) {
      writeCrashLog(msg);
      const delay = Math.min(BASE_DELAY * Math.pow(2, Math.min(restartCount, 5)), MAX_DELAY);
      log('Restarting in ' + (delay/1000) + 's...');
      if (restartCount > 0 && restartCount % 5 === 0) {
        tg('⚠️ Bot has restarted ' + restartCount + ' times — check crash log').catch(()=>{});
      }
      restartCount++;
      setTimeout(startBot, delay);
    }
  });

  botProcess.on('error', (err) => {
    writeCrashLog('Process error: ' + err.message);
    log('Bot process error: ' + err.message);
  });
}

log('Watchdog v' + VERSION + ' started');
log('Bot script: ' + BOT_SCRIPT);
startBot();

// Keep watchdog alive
process.on('SIGINT', () => {
  log('Watchdog stopping...');
  if (botProcess) botProcess.kill();
  process.exit(0);
});
