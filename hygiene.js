// hygiene.js — proactive fund management and dust clearing
// Runs every 15 minutes via okx-arb.js require
// Handles: OKX trading/funding cleanup, Bybit UNIFIED/FUND cleanup,
//          Solana dust, FUND buffer maintenance

require('dotenv').config();
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');

const DUST_THRESHOLD_USD = 1.00;   // below this = dust, skip
const FUND_BUFFER_USDT   = 15.00;  // keep this much USDT in Bybit FUND account
const LOG_FILE = path.join(__dirname, 'hygiene.log');

function log(msg) {
  const line = `[${new Date().toISOString().slice(11,19)}] ${msg}`;
  console.log(`🧹 ${line}`);
  try {
    const existing = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE,'utf8') : '';
    const lines = existing.split('\n').filter(Boolean);
    lines.push(line);
    // Keep last 500 lines
    fs.writeFileSync(LOG_FILE, lines.slice(-500).join('\n') + '\n');
  } catch {}
}

// ── OKX helpers ───────────────────────────────────────────────────────────────
function okxSign(ts, m, p, b) {
  b = b || '';
  return crypto.createHmac('sha256', process.env.OKX_API_SECRET).update(ts + m + p + b).digest('base64');
}

async function okxGet(ep) {
  const ts = new Date().toISOString();
  const r  = await fetch('https://www.okx.com' + ep, {
    headers: { 'OK-ACCESS-KEY': process.env.OKX_API_KEY, 'OK-ACCESS-SIGN': okxSign(ts,'GET',ep), 'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': process.env.OKX_PASSPHRASE }
  });
  return r.json();
}

async function okxPost(ep, body) {
  const ts  = new Date().toISOString();
  const b   = JSON.stringify(body);
  const r   = await fetch('https://www.okx.com' + ep, {
    method: 'POST',
    headers: { 'OK-ACCESS-KEY': process.env.OKX_API_KEY, 'OK-ACCESS-SIGN': okxSign(ts,'POST',ep,b), 'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': process.env.OKX_PASSPHRASE, 'Content-Type': 'application/json' },
    body: b
  });
  return r.json();
}

// ── Bybit helpers ─────────────────────────────────────────────────────────────
function bybitSign(ts, rw, p) {
  return crypto.createHmac('sha256', process.env.BYBIT_API_SECRET).update(ts + process.env.BYBIT_API_KEY + rw + p).digest('hex');
}

async function bybitGet(ep, qs) {
  const ts = '' + Date.now(), rw = '5000';
  const sig = bybitSign(ts, rw, qs);
  const r = await fetch('https://api.bybit.com' + ep + '?' + qs, {
    headers: { 'X-BAPI-API-KEY': process.env.BYBIT_API_KEY, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-SIGN': sig, 'X-BAPI-RECV-WINDOW': rw }
  });
  return r.json();
}

async function bybitPost(ep, body) {
  const ts = '' + Date.now(), rw = '5000';
  const b  = JSON.stringify(body);
  const sig = bybitSign(ts, rw, b);
  const r = await fetch('https://api.bybit.com' + ep, {
    method: 'POST',
    headers: { 'X-BAPI-API-KEY': process.env.BYBIT_API_KEY, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-SIGN': sig, 'X-BAPI-RECV-WINDOW': rw, 'Content-Type': 'application/json' },
    body: b
  });
  return r.json();
}

// ── OKX Trading account cleanup ───────────────────────────────────────────────
async function cleanOKXTrading() {
  try {
    const j = await okxGet('/api/v5/account/balance');
    const details = j.data?.[0]?.details || [];
    const dirty = details.filter(d => d.ccy !== 'USDT' && parseFloat(d.eqUsd || 0) >= DUST_THRESHOLD_USD);
    if (dirty.length === 0) return;
    log(`OKX trading: found ${dirty.length} non-USDT token(s)`);
    for (const d of dirty) {
      try {
        const r = await okxPost('/api/v5/trade/order', {
          instId: `${d.ccy}-USDT`, tdMode: 'cash', side: 'sell',
          ordType: 'market', sz: d.availBal, tgtCcy: 'base_ccy'
        });
        if (r.code === '0') log(`OKX trading: sold ${d.availBal} ${d.ccy} (~$${parseFloat(d.eqUsd).toFixed(2)})`);
        else log(`OKX trading: sell ${d.ccy} failed — ${r.msg}`);
      } catch(e) { log(`OKX trading: sell ${d.ccy} error — ${e.message}`); }
    }
  } catch(e) { log(`OKX trading cleanup error: ${e.message}`); }
}

// ── OKX Funding account cleanup ───────────────────────────────────────────────
async function cleanOKXFunding() {
  try {
    const j = await okxGet('/api/v5/asset/balances');
    const balances = j.data || [];
    const usdt = balances.find(b => b.ccy === 'USDT');
    const tokens = balances.filter(b => b.ccy !== 'USDT' && parseFloat(b.availBal) > 0);

    // Transfer USDT from funding to trading
    if (usdt && parseFloat(usdt.availBal) > 0.01) {
      const r = await okxPost('/api/v5/asset/transfer', {
        type: '0', ccy: 'USDT', amt: usdt.availBal, from: '6', to: '18'
      });
      if (r.code === '0') log(`OKX funding: transferred $${parseFloat(usdt.availBal).toFixed(2)} USDT to trading`);
      else log(`OKX funding: USDT transfer failed — ${r.msg}`);
    }

    // Log dust tokens (can't easily sell from funding without converting)
    if (tokens.length > 0) {
      tokens.forEach(t => {
        if (parseFloat(t.availBal) > 0.001) log(`OKX funding: dust ${t.availBal} ${t.ccy} (ignored)`);
      });
    }
  } catch(e) { log(`OKX funding cleanup error: ${e.message}`); }
}

// ── Bybit FUND account maintenance ───────────────────────────────────────────
async function maintainBybitFund() {
  try {
    const j = await bybitGet('/v5/asset/transfer/query-account-coins-balance', 'accountType=FUND');
    const coins = j.result?.balance || [];
    const usdt  = coins.find(c => c.coin === 'USDT');
    const tokens = coins.filter(c => c.coin !== 'USDT' && parseFloat(c.walletBalance) > 0.001);

    const fundUsdt = parseFloat(usdt?.walletBalance || '0');
    log(`Bybit FUND: $${fundUsdt.toFixed(2)} USDT, ${tokens.length} token(s)`);

    // Sell any non-USDT tokens in FUND (shouldn't be there)
    for (const t of tokens) {
      log(`Bybit FUND: unexpected ${t.coin} ${t.walletBalance} — transfer to UNIFIED for cleanup`);
      try {
        const transferId = crypto.randomUUID();
        const r = await bybitPost('/v5/asset/transfer/inter-transfer', {
          transferId, coin: t.coin, amount: t.walletBalance,
          fromAccountType: 'FUND', toAccountType: 'UNIFIED'
        });
        if (r.retCode === 0) log(`Bybit FUND: transferred ${t.coin} to UNIFIED`);
      } catch(e) { log(`Bybit FUND token transfer error: ${e.message}`); }
    }

    // Top up FUND buffer if low
    if (fundUsdt < FUND_BUFFER_USDT) {
      const needed = (FUND_BUFFER_USDT - fundUsdt).toFixed(2);
      try {
        const transferId = crypto.randomUUID();
        const r = await bybitPost('/v5/asset/transfer/inter-transfer', {
          transferId, coin: 'USDT', amount: needed,
          fromAccountType: 'UNIFIED', toAccountType: 'FUND'
        });
        if (r.retCode === 0) log(`Bybit FUND: topped up $${needed} USDT from UNIFIED (buffer maintained)`);
        else log(`Bybit FUND: top-up failed — ${r.retMsg}`);
      } catch(e) { log(`Bybit FUND top-up error: ${e.message}`); }
    }
  } catch(e) { log(`Bybit FUND maintenance error: ${e.message}`); }
}

// ── Bybit UNIFIED account cleanup ─────────────────────────────────────────────
async function cleanBybitUnified() {
  try {
    const j = await bybitGet('/v5/account/wallet-balance', 'accountType=UNIFIED');
    const coins = j.result?.list?.[0]?.coin || [];
    const dirty = coins.filter(c => c.coin !== 'USDT' && parseFloat(c.usdValue || 0) >= DUST_THRESHOLD_USD);
    if (dirty.length === 0) return;
    log(`Bybit UNIFIED: found ${dirty.length} non-USDT token(s)`);
    for (const c of dirty) {
      try {
        const r = await bybitPost('/v5/order/create', {
          category: 'spot', symbol: `${c.coin}USDT`,
          side: 'Sell', orderType: 'Market', qty: c.walletBalance
        });
        if (r.retCode === 0) log(`Bybit UNIFIED: sold ${c.walletBalance} ${c.coin} (~$${parseFloat(c.usdValue).toFixed(2)})`);
        else log(`Bybit UNIFIED: sell ${c.coin} failed — ${r.retMsg}`);
      } catch(e) { log(`Bybit UNIFIED: sell ${c.coin} error — ${e.message}`); }
    }
  } catch(e) { log(`Bybit UNIFIED cleanup error: ${e.message}`); }
}

// ── Main hygiene run ──────────────────────────────────────────────────────────
async function runHygiene() {
  log('--- Hygiene cycle start ---');
  await cleanOKXTrading();
  await cleanOKXFunding();
  await cleanBybitUnified();
  await maintainBybitFund();
  log('--- Hygiene cycle complete ---');
}

module.exports = { runHygiene, log };

// Run directly if called standalone
if (require.main === module) {
  runHygiene().catch(e => console.error('Hygiene error:', e.message));
}
