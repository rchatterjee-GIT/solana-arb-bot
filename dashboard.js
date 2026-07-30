require('dotenv').config();
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT         = 3000;
const STATE_FILE   = path.join(__dirname, 'arb-state.json');
const TRADES_FILE  = path.join(__dirname, 'trades.json');
const FIRES_FILE   = path.join(__dirname, 'fires.json');
const LOG_FILE     = path.join(__dirname, 'arb-log.json');
const CRASH_LOG    = path.join(__dirname, 'crash.log');
const LIVE_FILE    = path.join(__dirname, 'arb-live.json');
const STATUS_FILE  = path.join(__dirname, 'bot-status.json');
const CONFIG_FILE  = path.join(__dirname, 'arb-config.json');

const WALLET = 'wSyZPy2NrfFtUFqzwmDvurDrqw5JXysZ22uLnq1AQaa';

const TOKEN_MINTS = {
  'So11111111111111111111111111111111111111112':    'SOL',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
  'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL':  'JTO',
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': 'WIF',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN':  'JUP',
  'HZ1JovNiVvGqNLPQFZE5BsKs1Jvzd2Qqxe5bw3RVFHW': 'PYTH',
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': 'RAY',
  '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ': 'W',
  '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr': 'POPCAT',
  'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5':  'MEW',
  'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82':  'BOME',
  '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN': 'TRUMP',
  'ZEUS1aR7aX8DFFkgutzZaBW51tvGc4GRsHcEUuRLJtb':  'ZEUS',
  'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof':  'RENDER',
  '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump': 'PNUT',
  'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump': 'GOAT',
  '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv': 'PENGU',
};

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function okxSign(ts, method, p, body = '') {
  return crypto.createHmac('sha256', process.env.OKX_API_SECRET).update(ts + method + p + body).digest('base64');
}

async function fetchOKXBalance() {
  try {
    const ts = new Date().toISOString();
    const r  = await fetch('https://www.okx.com/api/v5/account/balance', {
      headers: { 'OK-ACCESS-KEY': process.env.OKX_API_KEY, 'OK-ACCESS-SIGN': okxSign(ts, 'GET', '/api/v5/account/balance'), 'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': process.env.OKX_PASSPHRASE }
    });
    const j = await r.json();
    return parseFloat(j.data?.[0]?.details?.find(d => d.ccy === 'USDT')?.availBal || '0');
  } catch { return null; }
}

async function fetchBybitBalance() {
  try {
    const ts = '' + Date.now(), rw = '5000', qs = 'accountType=UNIFIED&coin=USDT';
    const sig = crypto.createHmac('sha256', process.env.BYBIT_API_SECRET).update(ts + process.env.BYBIT_API_KEY + rw + qs).digest('hex');
    const r = await fetch('https://api.bybit.com/v5/account/wallet-balance?' + qs, {
      headers: { 'X-BAPI-API-KEY': process.env.BYBIT_API_KEY, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-SIGN': sig, 'X-BAPI-RECV-WINDOW': rw }
    });
    const j = await r.json();
    const coin = j.result?.list?.[0]?.coin?.find(c => c.coin === 'USDT');
    return Math.max(parseFloat(coin?.availableToWithdraw || '0'), parseFloat(coin?.equity || '0'), parseFloat(coin?.walletBalance || '0') * 0.95);
  } catch { return null; }
}

async function fetchSolanaBalance() {
  try {
    const { Keypair, PublicKey, Connection } = require('@solana/web3.js');
    const { getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');
    const connection = new Connection(process.env.RPC_URL, 'confirmed');
    const wallet     = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY)));
    const USDC       = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const ata        = await getAssociatedTokenAddress(new PublicKey(USDC), wallet.publicKey);
    const acc        = await getAccount(connection, ata);
    return parseFloat((Number(acc.amount) / 1e6).toFixed(2));
  } catch { return null; }
}

async function fetchTokenBalances() {
  try {
    const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
    const r1     = await fetch(rpcUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner',
        params: [WALLET, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }] })
    });
    const text1 = await r1.text();
    const j1    = JSON.parse(text1);
    const toks  = {};
    for (const a of (j1.result?.value || [])) {
      const info = a.account.data.parsed?.info;
      if (info?.mint && parseFloat(info?.tokenAmount?.uiAmount || 0) > 0)
        toks[info.mint] = parseFloat(info.tokenAmount.uiAmount);
    }
    const mintList = Object.keys(toks).length > 0
      ? Object.keys(toks).join(',')
      : Object.keys(TOKEN_MINTS).slice(0, 5).join(',');
    const r2     = await fetch('https://api.jup.ag/price/v2?ids=' + mintList);
    const text2  = await r2.text();
    let prices   = {};
    try { prices = JSON.parse(text2).data || {}; } catch { prices = {}; }
    return { toks, prices };
  } catch(e) { return { toks: {}, prices: {}, error: e.message }; }
}

function getData() {
  const state  = readJSON(STATE_FILE) || {};
  const trades = readJSON(TRADES_FILE) || [];
  const fires  = readJSON(FIRES_FILE) || [];
  const log    = readJSON(LOG_FILE) || {};
  const live     = readJSON(LIVE_FILE) || null;
  const tradeLog = (() => { try { return JSON.parse(require('fs').readFileSync(path.join(__dirname,'trade-log.json'),'utf8')); } catch { return []; } })();
  const simTrades = (() => { try { return JSON.parse(require('fs').readFileSync(path.join(__dirname,'sim-trades.json'),'utf8')); } catch { return []; } })();
  const status = readJSON(STATUS_FILE) || null;
  const config = readJSON(CONFIG_FILE) || {};

  const recentTrades = trades.slice(-10).reverse();
  const recentFires  = fires.slice(-20).reverse();

  const pairStats = {};
  for (const t of trades) {
    if (!pairStats[t.pair]) pairStats[t.pair] = { fires: 0, wins: 0, pnl: 0, spreads: [] };
    pairStats[t.pair].fires++;
    if (t.profit > 0) pairStats[t.pair].wins++;
    pairStats[t.pair].pnl += t.profit;
    if (t.spreadPct) pairStats[t.pair].spreads.push(t.spreadPct);
  }

  const balHistory = [];
  for (const [date, day] of Object.entries(log).slice(-7)) {
    for (const r of (day.reports || [])) {
      balHistory.push({ time: date + ' ' + r.time, total: r.total, okx: r.okxUsdt, solana: r.solanaUsdc, bybit: r.bybitUsdt });
    }
  }

  const now     = Date.now();
  const oneWeek = 7 * 24 * 60 * 60 * 1000;
  const week    = trades.filter(t => new Date(t.date).getTime() > now - oneWeek);
  const allWinPct  = trades.length ? Math.round(trades.filter(t => t.profit > 0).length / trades.length * 100) : 0;
  const weekWinPct = week.length   ? Math.round(week.filter(t => t.profit > 0).length / week.length * 100)   : 0;
  const weekPnl    = week.reduce((s, t) => s + (t.profit || 0), 0);
  const startCapital  = state.startCapital || 0;
  const tradingProfit = state.totalProfit  || 0;
  const injRatio      = startCapital > 0 ? (tradingProfit / startCapital * 100) : 0;

  const latest   = balHistory[balHistory.length - 1] || {};
  const today    = new Date().toISOString().slice(0, 10);
  const todayLog = log[today] || {};
  const dayChange = (todayLog.open?.total && todayLog.close?.total)
    ? ((todayLog.close.total - todayLog.open.total) / todayLog.open.total * 100) : null;

  return {
    state, recentTrades, recentFires, pairStats, balHistory, live, status, config,
    dayChange, allWinPct, weekWinPct, weekPnl, latest,
    allTrades: trades.length, weekTrades: week.length,
    allWins: trades.filter(t => t.profit > 0).length,
    weekWins: week.filter(t => t.profit > 0).length,
    startCapital, tradingProfit, injRatio,
    tradeLog,
    simTrades,
    now: new Date().toISOString(),
  };
}

function buildHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arb Bot</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',monospace;background:#08080f;color:#e0e0e0;padding:12px;font-size:13px}
h2{color:#a78bfa;font-size:.72rem;text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px}
.grid{display:grid;gap:10px;margin-bottom:12px}
.g3{grid-template-columns:repeat(3,1fr)}
.g4{grid-template-columns:repeat(4,1fr)}
.g2{grid-template-columns:1fr 1fr}
.g1{grid-template-columns:1fr}
@media(max-width:700px){.g3,.g4{grid-template-columns:1fr 1fr}.g2{grid-template-columns:1fr}}
.card{background:#11111c;border:1px solid #1e1e30;border-radius:8px;padding:12px}
.card.alert{border-color:#ef4444}
.card.warn{border-color:#eab308}
.val{font-size:1.4rem;font-weight:700;color:#7c3aed}
.lbl{font-size:.68rem;color:#555;margin-top:2px}
.sub{font-size:.72rem;color:#888;margin-top:4px}
.green{color:#22c55e}.red{color:#ef4444}.yellow{color:#eab308}.purple{color:#a78bfa}.dim{color:#444}
.badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:.65rem;font-weight:700;margin-right:3px}
.bg{background:#14532d;color:#22c55e}.br{background:#450a0a;color:#ef4444}
.by{background:#422006;color:#eab308}.bp{background:#2e1065;color:#a78bfa}.bn{background:#1e1e30;color:#666}
.wdot{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:2px}
.wf{background:#22c55e}.we{background:#2a2a3f}
.pulse{animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px}
.dot-g{background:#22c55e}.dot-r{background:#ef4444}.dot-y{background:#eab308}
table{width:100%;border-collapse:collapse;font-size:.72rem}
th{padding:4px 6px;color:#444;border-bottom:1px solid #1e1e30;text-align:left;font-weight:normal}
td{padding:4px 6px;border-bottom:1px solid #0f0f1a}
tr:hover td{background:#14141f}
.prog{height:6px;background:#1e1e30;border-radius:3px;overflow:hidden;margin-top:4px}
.progf{height:100%;border-radius:3px;transition:width .5s}
.hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px}
.hdr-left{display:flex;align-items:center;gap:12px}
.ver{background:#1e1e30;color:#a78bfa;border:1px solid #4c1d95;border-radius:4px;padding:2px 8px;font-size:.72rem;font-weight:bold}
.status-pill{border-radius:4px;padding:2px 8px;font-size:.72rem;font-weight:bold}
.sp-active{background:#14532d;color:#22c55e}
.sp-quiet{background:#1e1e30;color:#666}
.btn{background:#1e1e30;border:1px solid #4c1d95;color:#a78bfa;border-radius:5px;padding:5px 12px;font-size:.72rem;cursor:pointer;transition:all .15s}
.btn:hover{background:#2e1065;color:#fff}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn-warn{border-color:#eab308;color:#eab308}
.btn-warn:hover{background:#422006}
.inflight{background:#0f0f1a;border:1px solid #4c1d95;border-radius:6px;padding:10px;margin-top:8px}
.inflight-row{display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #1e1e30}
.inflight-row:last-child{border:none}
.timer{font-family:monospace;color:#eab308;font-size:.8rem}
.countdown{font-size:.65rem;color:#555}
.fire-row td{background:rgba(234,179,8,.06)!important}
.sec{color:#a78bfa;font-size:.68rem;text-transform:uppercase;letter-spacing:.08em;margin:12px 0 6px;border-bottom:1px solid #1e1e30;padding-bottom:3px;display:flex;justify-content:space-between}
</style>
</head>
<body>

<div class="hdr">
  <div class="hdr-left">
    <span class="ver" id="verBadge">v?.?</span>
    <span class="status-pill" id="statusPill">loading...</span>
    <span style="font-size:.68rem;color:#444"><span class="dot dot-g pulse" id="liveDot"></span><span id="liveAge">-</span></span>
  </div>
  <div style="display:flex;gap:6px;flex-wrap:wrap">
    <button class="btn" id="refreshBtn" onclick="refreshBalances()">↻ Balances</button>
    <button class="btn btn-warn" id="volatileBtn" onclick="toggleVolatile()">🔵 Normal</button>
    <button class="btn" onclick="resyncState()" style="border-color:#22c55e;color:#22c55e">🔁 Resync</button>
    <button class="btn" onclick="restartBot()" style="border-color:#ef4444;color:#ef4444">Restart</button>
    <button class="btn" id="rollbackBtn" onclick="rollback()" style="border-color:#666;color:#666;display:none" title="Rollback state to pre-deploy backup">Rollback</button>
    <button class="btn" id="rebalanceBtn" onclick="showRebalanceModal()" style="border-color:#eab308;color:#eab308">Rebalance</button>
  </div>
</div>

<!-- Deploy status bar -->
<div id="deployBar" style="background:#0f0f1a;border:1px solid #1e1e30;border-radius:6px;padding:8px 12px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;font-size:.72rem">
  <div>
    <span style="color:#555">Deployed: </span>
    <span id="deployVer" style="color:#a78bfa;font-weight:bold">-</span>
    <span style="color:#555;margin-left:12px">Uptime: </span>
    <span id="deployUptime" style="color:#888">-</span>
    <span style="color:#555;margin-left:12px">Trades: </span>
    <span id="deployTrades" style="color:#888">-</span>
    <span style="color:#555;margin-left:12px">P&L: </span>
    <span id="deployPnl" style="color:#888">-</span>
  </div>
  <div id="deployBackup" style="display:none">
    <span style="color:#eab308;font-size:.65rem">Backup available</span>
  </div>
</div>

<!-- Row 1: Capital -->
<div class="grid g4" style="margin-bottom:10px">
  <div class="card">
    <div class="val" id="tcap">-</div>
    <div class="lbl">Total Capital</div>
    <div class="sub" id="cgain">-</div>
    <div class="sub" id="dchg">-</div>
  </div>
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <div class="val" id="lb-sol">-</div>
        <div class="lbl">Solana USDC</div>
      </div>
      <span class="badge bn" id="sol-status">-</span>
    </div>
  </div>
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <div class="val" id="lb-okx">-</div>
        <div class="lbl">OKX USDT</div>
      </div>
      <span class="badge" id="okx-status">-</span>
    </div>
  </div>
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <div class="val" id="lb-bybit">-</div>
        <div class="lbl">Bybit USDT</div>
      </div>
      <span class="badge bn" id="bybit-status">-</span>
    </div>
  </div>
  <div class="card" id="krakenCard" style="display:none">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <div class="val" id="lb-kraken">-</div>
        <div class="lbl">Kraken USDT <span class="badge bp" style="font-size:.6rem" id="krakenModeBadge">SIM</span></div>
      </div>
      <span class="badge bn" id="kraken-status">-</span>
    </div>
  </div>
</div>

<!-- Row 2: Stats -->
<div class="grid g4" style="margin-bottom:10px;grid-template-columns:repeat(5,1fr)">
  <div class="card">
    <div class="lbl" style="margin-bottom:5px">Consecutive Wins</div>
    <div id="wbar" style="display:flex;gap:2px"></div>
    <div class="sub" id="wtxt">-</div>
  </div>
  <div class="card">
    <div class="lbl" style="margin-bottom:5px">Consecutive Clean</div>
    <div id="cbar" style="display:flex;gap:2px"></div>
    <div class="sub" id="ctxt">-</div>
  </div>
  <div class="card">
    <div class="val green" id="tpnl">-</div>
    <div class="lbl">Trading P&amp;L</div>
    <div class="sub" id="wpnl">-</div>
  </div>
  <div class="card">
    <div class="val" id="awp">-</div>
    <div class="lbl">Win Rate (all time)</div>
    <div class="sub" id="awd">-</div>
  </div>
  <div class="card">
    <div class="val" id="roi">-</div>
    <div class="lbl">Return on Capital</div>
    <div class="prog"><div class="progf" id="roibar" style="width:0%;background:linear-gradient(90deg,#7c3aed,#22c55e)"></div></div>
    <div class="sub" id="roiDet">-</div>
  </div>
</div>

<!-- In-flight trades -->
<div id="inflightSection" style="display:none;margin-bottom:10px">
  <div class="sec">⏳ In-flight Trades <span id="inflightCount"></span></div>
  <div id="inflightList"></div>
</div>

<!-- Next actions -->
<div class="grid g2" style="margin-bottom:10px">
  <div class="card">
    <h2>System Status</h2>
    <table>
      <tr><td class="dim">Version</td><td id="sysVer">-</td></tr>
      <tr><td class="dim">OKX health</td><td id="sysOKX">-</td></tr>
      <tr><td class="dim">Kraken</td><td id="sysKraken">disabled</td></tr>
      <tr><td class="dim">Smart sell</td><td id="sysSmartSell">-</td></tr>
      <tr><td class="dim">Volatile mode</td><td id="sysVolatile">-</td></tr>
      <tr><td class="dim">Next clean</td><td id="sysClean">-</td></tr>
      <tr><td class="dim">Trade size</td><td id="sysSize">-</td></tr>
      <tr><td class="dim">Last updated</td><td id="sysUpdated">-</td></tr>
    </table>
  </div>
  <div class="card">
    <h2>Pair Viability</h2>
    <div style="margin-bottom:6px">
      <span style="font-size:.68rem;color:#555">OKX: </span>
      <span id="okxViable" style="font-size:.72rem"></span>
    </div>
    <div style="margin-bottom:6px">
      <span style="font-size:.68rem;color:#555">Bybit: </span>
      <span id="bybitViable" style="font-size:.72rem"></span>
    </div>
    <div>
      <span style="font-size:.68rem;color:#555">BUY_DEX: </span>
      <span id="dexViable" style="font-size:.72rem;color:#a78bfa">SOL JTO WIF RAY PYTH W RENDER PENGU TRUMP</span>
    </div>
    <div id="krakenViableRow" style="display:none;margin-top:6px">
      <span style="font-size:.68rem;color:#555">Kraken: </span>
      <span id="krakenViable" style="font-size:.72rem"></span>
      <span class="badge bp" style="font-size:.6rem;margin-left:4px">SIM</span>
    </div>
  </div>
</div>

<!-- Live Spreads -->
<div class="sec">📡 Live Spreads</div>
<div class="card" style="margin-bottom:10px">
  <table>
    <thead><tr>
      <th>Pair</th><th>OKX</th><th>Bybit</th>
      <th style="text-align:right">→OKX</th><th style="text-align:right">→Bybit</th><th style="text-align:right">→DEX</th>
      <th>Thresh</th><th>Status</th>
    </tr></thead>
    <tbody id="ltable"></tbody>
  </table>
</div>

<!-- Token Balances -->
<div class="sec">🪙 Solana Wallet Tokens</div>
<div class="card" style="margin-bottom:10px">
  <div id="tokbals" style="color:#444;font-size:.72rem">Loading...</div>
</div>

<!-- Charts & History -->
<div class="grid g2" style="margin-bottom:10px">
  <div class="card">
    <h2>Capital History (7d)</h2>
    <canvas id="chart" height="100"></canvas>
  </div>
  <div class="card">
    <h2>Recent Fires (last 20)</h2>
    <table>
      <thead><tr><th>Time</th><th>Pair</th><th>Dir</th><th>Outcome</th><th>Reason</th></tr></thead>
      <tbody id="firetable"></tbody>
    </table>
  </div>
</div>

<!-- Kraken Sim Panel -->
<div id="simPanel" style="display:none;margin-bottom:10px">
  <div class="sec" style="margin-top:12px">Kraken [SIM] <span id="simCount" style="color:#555"></span> <span class="badge bp" style="font-size:.65rem">SYNTHETIC</span></div>
  <div class="card">
    <div class="grid g4" style="margin-bottom:8px">
      <div><div class="val" id="simTrades" style="font-size:1rem">-</div><div class="lbl">Sim Trades</div></div>
      <div><div class="val" id="simPnl" style="font-size:1rem">-</div><div class="lbl">Sim P&L</div></div>
      <div><div class="val" id="simWr" style="font-size:1rem">-</div><div class="lbl">Sim Win Rate</div></div>
      <div><div class="val" id="simVsReal" style="font-size:1rem">-</div><div class="lbl">vs Real P&L</div></div>
    </div>
    <div id="simTable" style="font-size:.72rem"></div>
  </div>
</div>

<!-- Trade Log Timeline -->
<div class="sec" style="margin-top:12px">Trade Log <span id="tradeLogCount" style="color:#555"></span></div>
<div class="card" style="margin-bottom:10px">
  <div id="tradeLogTable" style="font-size:.72rem"></div>
</div>

<div class="grid g2">
  <div class="card">
    <h2>Recent Trades</h2>
    <table>
      <thead><tr><th>Time</th><th>Pair</th><th>Dir</th><th>Spread</th><th>P&amp;L</th><th>Min</th></tr></thead>
      <tbody id="ttable"></tbody>
    </table>
  </div>
  <div class="card">
    <h2>Pair Stats</h2>
    <table>
      <thead><tr><th>Pair</th><th>Fires</th><th>Win%</th><th>Avg%</th><th>P&amp;L</th></tr></thead>
      <tbody id="ptable"></tbody>
    </table>
  </div>
</div>

<script>
var chart = null;
var tokCache = null, tokTime = 0;
var liveBalData = null, liveBalTime = 0;
var timers = {};

function fmt(n,d){return n!=null?'$'+parseFloat(n).toFixed(d||0):'-';}
function fmtPct(n){return n!=null?(n>=0?'+':'')+n.toFixed(1)+'%':'-';}
function elapsed(ms){var s=Math.round((Date.now()-ms)/1000);if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m '+Math.floor(s%60)+'s';return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';}
function countdown(ms){var s=Math.round((ms-Date.now())/1000);if(s<=0)return 'now';if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m';return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';}

function sc(spread,thresh){var p=spread/thresh;if(p>=1)return'#eab308';if(p>=.8)return'#f97316';if(p>=.5)return'#a78bfa';if(spread>0)return'#22c55e';return'#ef4444';}

async function fetchToks(){
  if(Date.now()-tokTime<15000&&tokCache)return tokCache;
  try{var r=await fetch('/api/tokens');var d=await r.json();tokCache=d;tokTime=Date.now();return d;}
  catch(e){return null;}
}

async function refreshBalances(){
  var btn=document.getElementById('refreshBtn');
  btn.disabled=true;btn.textContent='Fetching...';
  try{
    var r=await fetch('/api/live-balances');var d=await r.json();
    liveBalData=d;liveBalTime=Date.now();
    renderBalances(d);
    btn.textContent='OK Done';
    setTimeout(function(){btn.textContent='Refresh Balances';btn.disabled=false;},2000);
  }catch(e){btn.textContent='Error: Error';setTimeout(function(){btn.textContent='Refresh Balances';btn.disabled=false;},2000);}
}

async function showRebalanceModal(){
  document.getElementById('rebalanceModal').style.display='flex';
  document.getElementById('rebalanceContent').textContent='Fetching balances...';
  document.getElementById('rebalanceExecBtn').disabled=true;
  try{
    var r=await fetch('/api/rebalance-check');
    var d=await r.json();
    if(d.error){document.getElementById('rebalanceContent').innerHTML='<span class="red">Error: '+d.error+'</span>';return;}
    var html='<table style="width:100%;border-collapse:collapse">';
    html+='<tr><td style="color:#555;padding:3px 0">Solana USDC</td><td style="text-align:right">$'+d.solana.toFixed(0)+'</td><td style="text-align:right;color:#444">target $'+d.targetSolana+'</td></tr>';
    html+='<tr><td style="color:#555;padding:3px 0">OKX USDT</td><td style="text-align:right">$'+d.okx.toFixed(0)+'</td><td style="text-align:right;color:#444">target $'+d.targetOKX+'</td></tr>';
    html+='<tr><td style="color:#555;padding:3px 0">Bybit USDT</td><td style="text-align:right">$'+d.bybit.toFixed(0)+'</td><td style="text-align:right;color:#444">target $'+d.targetBybit+'</td></tr>';
    html+='</table><hr style="border-color:#1e1e30;margin:12px 0">';
    if(!d.needed){
      html+='<span class="green">Balances within target range - no action needed</span>';
      document.getElementById('rebalanceExecBtn').disabled=true;
    } else {
      html+='<b style="color:#eab308">Recommended transfers:</b><br>';
      if(d.toOKX>5)   html+='Move $'+d.toOKX+' Solana &rarr; OKX<br>';
      if(d.toBybit>5) html+='Move $'+d.toBybit+' Solana &rarr; Bybit<br>';
      html+='<br><span style="color:#555;font-size:.68rem">This will swap USDC to USDT and send to exchange deposit address. Arrives in 5-15min.</span>';
      document.getElementById('rebalanceExecBtn').disabled=false;
    }
    document.getElementById('rebalanceContent').innerHTML=html;
  }catch(e){document.getElementById('rebalanceContent').innerHTML='<span class="red">Error: '+e.message+'</span>';}
}

function closeRebalanceModal(){
  document.getElementById('rebalanceModal').style.display='none';
}

async function executeRebalance(){
  var btn=document.getElementById('rebalanceExecBtn');
  btn.disabled=true;btn.textContent='Executing...';
  try{
    var r=await fetch('/api/rebalance-execute',{method:'POST'});
    var d=await r.json();
    if(d.ok){
      document.getElementById('rebalanceContent').innerHTML='<span class="green">Rebalance command sent to bot. Check Telegram for updates.</span>';
    } else {
      document.getElementById('rebalanceContent').innerHTML='<span class="red">Failed: '+d.error+'</span>';
      btn.disabled=false;btn.textContent='Execute';
    }
  }catch(e){
    document.getElementById('rebalanceContent').innerHTML='<span class="red">Error: '+e.message+'</span>';
    btn.disabled=false;btn.textContent='Execute';
  }
}

async function loadDeployStatus(){
  try{
    var r=await fetch('/api/deploy-status');
    var d=await r.json();
    if(d.error) return;
    document.getElementById('deployVer').textContent=d.version||'-';
    var uptime=d.uptime;
    var uptimeStr=uptime?
      (uptime<60?uptime+'s':uptime<3600?Math.floor(uptime/60)+'m':Math.floor(uptime/3600)+'h '+Math.floor((uptime%3600)/60)+'m')
      :'-';
    document.getElementById('deployUptime').textContent=uptimeStr;
    document.getElementById('deployTrades').textContent=d.trades||0;
    var pnl=d.pnl||0;
    document.getElementById('deployPnl').innerHTML='<span class="'+(pnl>=0?'green':'red')+'">'+(pnl>=0?'+':'')+'$'+pnl.toFixed(2)+'</span>';
    if(d.hasBackup){
      document.getElementById('deployBackup').style.display='';
      document.getElementById('rollbackBtn').style.display='';
      document.getElementById('rollbackBtn').style.color='#eab308';
      document.getElementById('rollbackBtn').style.borderColor='#eab308';
    }
  }catch(e){}
}

async function rollback(){
  if(!confirm('Rollback arb-state.json and trades.json to pre-deploy backup? This will revert state but NOT revert code files.')) return;
  var btn=document.getElementById('rollbackBtn');
  btn.textContent='Rolling back...';btn.disabled=true;
  try{
    var r=await fetch('/api/rollback',{method:'POST'});
    var d=await r.json();
    if(d.ok){
      btn.textContent='Rolled back';
      btn.style.color='#22c55e';
      alert('Rollback complete. Restored: '+d.restored.join(', ')+'\nRestart bot to apply.');
    } else {
      btn.textContent='Failed';
      alert('Rollback failed: '+d.error);
      btn.disabled=false;
    }
  }catch(e){btn.textContent='Error';btn.disabled=false;}
}

async function resyncState(){
  if(!confirm('Resync state from trades.json? This will recalculate all P&L and win counts.')) return;
  try{
    var r=await fetch('/api/resync',{method:'POST'});
    var d=await r.json();
    if(d.ok){
      alert('Resynced. Trades:'+d.trades+' Wins:'+d.wins+' P&L:$'+d.pnl.toFixed(2));
      refresh();
    } else { alert('Resync failed: '+d.error); }
  }catch(e){alert('Error: '+e.message);}
}

async function restartBot(){
  if(!confirm('Restart the bot? Active trades will resume automatically.')) return;
  try{
    var r=await fetch('/api/restart',{method:'POST'});
    var d=await r.json();
    if(d.ok){
      var btn=document.querySelector('[onclick="restartBot()"]');
      if(btn){btn.textContent='Restart Restarting...';btn.disabled=true;setTimeout(function(){btn.textContent='Restart Restart';btn.disabled=false;},10000);}
    } else { alert('Restart failed: '+d.error); }
  }catch(e){alert('Error: '+e.message);}
}

async function toggleVolatile(){
  var btn=document.getElementById('volatileBtn');
  var isVol=btn.textContent.includes('Normal');
  try{
    var r=await fetch('/api/volatile?mode='+(isVol?'on':'off'),{method:'POST'});
    var d=await r.json();
    renderVolatileBtn(d.volatile);
  }catch(e){console.error(e);}
}

function renderVolatileBtn(vol){
  var btn=document.getElementById('volatileBtn');
  btn.textContent=vol?'[Y] Volatile':'[B] Normal';
  btn.style.borderColor=vol?'#eab308':'#4c1d95';
  btn.style.color=vol?'#eab308':'#a78bfa';
}

function renderBalances(d){
  if(!d)return;
  var krakenEnabled=d.krakenEnabled||false;
  var total=(d.solana||0)+(d.okx||0)+(d.bybit||0)+(krakenEnabled&&d.kraken?d.kraken:0);
  document.getElementById('lb-sol').textContent=d.solana!=null?'$'+d.solana.toFixed(2):'?';
  document.getElementById('lb-okx').textContent=d.okx!=null?'$'+d.okx.toFixed(2):'?';
  document.getElementById('lb-bybit').textContent=d.bybit!=null?'$'+d.bybit.toFixed(2):'?';
  document.getElementById('tcap').textContent='$'+total.toFixed(2);
  // Kraken card
  var kCard=document.getElementById('krakenCard');
  if(krakenEnabled){
    kCard.style.display='';
    document.getElementById('lb-kraken').textContent=d.kraken!=null?'$'+d.kraken.toFixed(2):'?';
    document.getElementById('kraken-status').className='badge bp';
    document.getElementById('kraken-status').textContent='SIM';
  } else {
    kCard.style.display='none';
  }
}

function renderToks(data){
  var el=document.getElementById('tokbals');
  if(!data||data.error){el.innerHTML='<span class="dim">'+( data?.error||'Unable to fetch')+'</span>';return;}
  var rows=[];
  for(var mint in data.toks){
    var symbol=MINT_SYMBOLS[mint]||mint.slice(0,6);
    var bal=data.toks[mint];
    var price=parseFloat(data.prices[mint]?.price||0);
    var usd=bal*price;
    rows.push({symbol,bal,usd,price});
  }
  rows.sort(function(a,b){return b.usd-a.usd;});
  el.innerHTML=rows.map(function(r){
    var dust=r.usd<0.01;
    var balStr=r.bal>0?(r.bal<1?r.bal.toFixed(4):r.bal.toFixed(2)):'0';
    var usdStr=r.usd>0?'$'+r.usd.toFixed(2):'-';
    return '<span style="display:inline-block;min-width:120px;margin:3px 8px 3px 0;vertical-align:top;'+(dust?'opacity:.3':'')+'">'+
      '<b style="color:#a78bfa">'+r.symbol+'</b>'+
      '<span style="color:#444;font-size:.65rem;margin-left:3px">@$'+parseFloat(r.price||0).toPrecision(3)+'</span><br>'+
      balStr+' <span class="green">'+usdStr+'</span></span>';
  }).join('');
}


function renderSim(sims, realPnl) {
  var panel=document.getElementById('simPanel');
  if(!sims||!sims.length){panel.style.display='none';return;}
  panel.style.display='';
  var recent=sims.slice(-30);
  var pnl=recent.reduce(function(a,s){return a+(s.profit||0);},0);
  var wins=recent.filter(function(s){return s.profit>0;}).length;
  var wr=recent.length?Math.round(wins/recent.length*100):0;
  document.getElementById('simCount').textContent='('+recent.length+' trades)';
  document.getElementById('simTrades').textContent=recent.length;
  document.getElementById('simPnl').innerHTML='<span class="'+(pnl>=0?'green':'red')+'">'+(pnl>=0?'+':'')+'$'+pnl.toFixed(2)+'</span>';
  document.getElementById('simWr').innerHTML='<span class="'+(wr>=50?'green':'yellow')+'">'+wr+'%</span>';
  var diff=pnl-(realPnl||0);
  document.getElementById('simVsReal').innerHTML='<span class="'+(diff>=0?'green':'red')+'">'+(diff>=0?'+':'')+'$'+diff.toFixed(2)+'</span>';
  document.getElementById('simTable').innerHTML=recent.slice().reverse().slice(0,10).map(function(s){
    var profit=s.profit||0;
    var time=new Date(s.date).toLocaleString('en-GB',{month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'});
    return '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #0f0f1a">'+
      '<span><b class="purple">'+s.pair.replace('/USDT','')+'</b> <span class="dim">'+s.spreadPct?.toFixed(2)+'%</span></span>'+
      '<span class="'+(profit>=0?'green':'red')+'">'+(profit>=0?'+':'')+'$'+profit.toFixed(4)+'</span>'+
      '</div>';
  }).join('');
}

function renderTradeLog(logs) {
  if(!logs||!logs.length){document.getElementById('tradeLogTable').innerHTML='<span class="dim">No trade logs yet</span>';return;}
  document.getElementById('tradeLogCount').textContent='('+logs.length+' trades)';
  var recent=logs.slice().reverse().slice(0,20);
  document.getElementById('tradeLogTable').innerHTML=recent.map(function(t){
    var dur=(t.durationMs/1000).toFixed(1)+'s';
    var outcomeCol=t.outcome==='success'?'green':'red';
    var pnl=t.pnl!=null?(t.pnl>=0?'+$':'$')+Math.abs(t.pnl).toFixed(2):'';
    var failAt=t.failedAt?'failed at '+t.failedAt:'';
    var rec=t.fundsRecovered?' [recovered]':'';
    // Build step pills
    var steps=[];
    var stepNames=['TRADE_START','BUY_PLACE','API_CALL','WITHDRAW','POLL_START','TOKEN_ARRIVED','SWAP_START','SWAP_SUCCESS','TRADE_COMPLETE','TRADE_FAIL'];
    var seen={};
    (t.events||[]).forEach(function(e){
      if(!seen[e.event]){
        seen[e.event]=true;
        var col=e.event==='TRADE_FAIL'?'red':e.event==='TRADE_COMPLETE'?'green':e.event.includes('FAIL')?'red':'purple';
        var elapsed=((e.ms-t.startMs)/1000).toFixed(1);
        steps.push('<span style="color:'+col+';margin-right:4px;font-size:.65rem">'+e.event.replace('_',' ')+'@'+elapsed+'s</span>');
      }
    });
    return '<div style="border-bottom:1px solid #0f0f1a;padding:6px 0">'+
      '<div style="display:flex;justify-content:space-between">'+
        '<span><b class="purple">'+t.pair.replace('/USDT','')+'</b> '+
        '<span class="badge bn" style="font-size:.6rem">'+t.direction.replace('BUY_','')+'</span> '+
        '<span class="dim">'+t.spreadPct.toFixed(2)+'%</span></span>'+
        '<span class="'+outcomeCol+'">'+pnl+' '+dur+'</span>'+
      '</div>'+
      '<div style="margin-top:3px">'+steps.join('')+'</div>'+
      (failAt?'<div style="color:#ef4444;font-size:.65rem">'+failAt+rec+'</div>':'')+
      '</div>';
  }).join('');
}

async function refresh(){
  try{
    var [r,td]=await Promise.all([fetch('/api/data'),fetchToks()]);
    var d=await r.json();
    render(d);
    renderToks(td);
    if(liveBalData)renderBalances(liveBalData);
    // Sync volatile from config
    if(d.config?.VOLATILE_MODE!==undefined)renderVolatileBtn(d.config.VOLATILE_MODE);
  }catch(e){console.error(e);}
}

function render(d){
  document.getElementById('sysUpdated').textContent=new Date().toLocaleTimeString();
  if(d.tradeLog) renderTradeLog(d.tradeLog);
  loadDeployStatus();
  if(d.simTrades) renderSim(d.simTrades, d.state?.totalProfit||0);

  // Version and status from bot-status.json
  var st=d.status;
  var ver=st?.version||'v?.?';
  document.getElementById('verBadge').textContent=ver;
  document.getElementById('sysVer').textContent=ver;

  // Live age
  if(st?.timestamp){
    var age=Math.round((Date.now()-new Date(st.timestamp).getTime())/1000);
    document.getElementById('liveAge').textContent=age<5?'live':age+'s ago';
    var dot=document.getElementById('liveDot');
    dot.className='dot '+(age>30?'dot-r pulse':'dot-g pulse');
  }

  // Status pill
  var active=(st?.activeTradeCount||0);
  var pill=document.getElementById('statusPill');
  if(active>0){pill.className='status-pill sp-active';pill.textContent=active+' active';}
  else{pill.className='status-pill sp-quiet';pill.textContent='watching';}

  // Capital
  var latest=d.latest||{};
  var total=latest.total||0;
  var gain=total-(d.startCapital||total);
  var gainPct=d.startCapital?((gain/d.startCapital)*100).toFixed(1):'0';
  if(!liveBalData){
    document.getElementById('tcap').textContent='$'+total.toFixed(2);
    document.getElementById('lb-sol').textContent='$'+(latest.solana||0).toFixed(2);
    document.getElementById('lb-okx').textContent='$'+(latest.okx||0).toFixed(2);
    document.getElementById('lb-bybit').textContent='$'+(latest.bybit||0).toFixed(2);
  }
  document.getElementById('cgain').innerHTML='<span class="'+(gain>=0?'green':'red')+'">'+(gain>=0?'+':'')+'$'+gain.toFixed(2)+' ('+gainPct+'%)</span>';
  if(d.dayChange!=null)document.getElementById('dchg').innerHTML='Today: <span class="'+(d.dayChange>=0?'green':'red')+'">'+(d.dayChange>=0?'+':'')+d.dayChange.toFixed(2)+'%</span>';

  // Exchange status badges
  var okxOk=st?.okxHealthy!==false;
  document.getElementById('okx-status').className='badge '+(okxOk?'bg':'br');
  document.getElementById('okx-status').textContent=okxOk?'OK':'[R]';
  document.getElementById('sol-status').className='badge bg';
  document.getElementById('sol-status').textContent='OK';
  document.getElementById('bybit-status').className='badge bg';
  document.getElementById('bybit-status').textContent='OK';

  // Wins bar
  var wins=d.state?.consecutiveWins||0,tgt=10;
  var clean=d.state?.consecutiveClean||0;
  var bar='';for(var i=0;i<tgt;i++)bar+='<div class="wdot '+(i<wins?'wf':'we')+'"></div>';
  document.getElementById('wbar').innerHTML=bar;
  document.getElementById('wtxt').textContent=wins+'/'+tgt+' consecutive';
  var cbar='';for(var i=0;i<tgt;i++)cbar+='<div class="wdot" style="background:'+(i<clean?'#22c55e':'#1e1e30')+'"></div>';
  document.getElementById('cbar').innerHTML=cbar;
  document.getElementById('ctxt').textContent=clean+'/'+tgt+' no intervention';

  // P&L
  var pnl=d.state?.totalProfit||0;
  document.getElementById('tpnl').textContent=(pnl>=0?'+':'')+'$'+pnl.toFixed(2);
  document.getElementById('tpnl').className='val '+(pnl>=0?'green':'red');
  document.getElementById('wpnl').innerHTML='This week: <span class="'+(d.weekPnl>=0?'green':'red')+'">'+(d.weekPnl>=0?'+':'')+'$'+d.weekPnl.toFixed(2)+'</span>';

  // Win rate
  document.getElementById('awp').textContent=d.allWinPct+'%';
  document.getElementById('awp').className='val '+(d.allWinPct>=50?'green':'yellow');
  document.getElementById('awd').textContent=d.allWins+'W / '+(d.allTrades-d.allWins)+'L - '+d.allTrades+' trades';

  // ROI
  document.getElementById('roi').textContent=d.injRatio.toFixed(1)+'%';
  document.getElementById('roi').className='val '+(d.injRatio>=0?'green':'red');
  document.getElementById('roibar').style.width=Math.min(100,Math.max(0,d.injRatio))+'%';
  document.getElementById('roiDet').innerHTML='Start: $'+d.startCapital.toFixed(0)+' Profit: <span class="green">+$'+d.tradingProfit.toFixed(2)+'</span>';

  // System status
  document.getElementById('sysOKX').innerHTML=okxOk?'<span class="green">OK online</span>':'<span class="red">[R] offline</span>';
  var krakenEnabled2=d.config?.KRAKEN_ENABLED||false;
  var krakenSim=d.config?.KRAKEN_SYNTHETIC||false;
  var krakenEl=document.getElementById('sysKraken');
  if(!krakenEnabled2){krakenEl.innerHTML='<span class="dim">disabled</span>';}
  else if(krakenSim){krakenEl.innerHTML='<span class="purple">SIM active</span>';}
  else{krakenEl.innerHTML='<span class="green">LIVE active</span>';}
  var kvRow=document.getElementById('krakenViableRow');
  if(krakenEnabled2){
    kvRow.style.display='';
    document.getElementById('krakenViable').innerHTML='<span class="badge bg">SOL</span><span class="badge bg">PENGU</span>';
    document.getElementById('krakenModeBadge').textContent=krakenSim?'SIM':'LIVE';
  } else {
    if(kvRow) kvRow.style.display='none';
  }
  document.getElementById('sysSmartSell').textContent=st?.smartSell?'[AI] ON':'OFF';
  document.getElementById('sysVolatile').textContent=st?.volatileMode?'[Y] ON':'[B] OFF';
  document.getElementById('sysSize').textContent='$'+(d.config?.TRADE_SIZE_USD||120);
  if(st?.nextRebalanceCheck){
    var ms=st.nextRebalanceCheck-Date.now();
    document.getElementById('sysClean').textContent=ms>0?'in '+countdown(st.nextRebalanceCheck):'now';
  }

  // Pair viability from config skip lists
  var allOKX=['SOL','JTO','WIF','W','MEW','PNUT','GOAT','PENGU','PYTH','RAY'];
  var allBybit=['SOL','JTO','WIF','W','RENDER','PNUT','PENGU'];
  var skipOKX=st?.skipOKX||[];
  var skipBybit=st?.skipBybit||[];
  document.getElementById('okxViable').innerHTML=allOKX.map(function(t){
    var ok=!skipOKX.includes(t);
    return '<span class="badge '+(ok?'bg':'br')+'">'+t+'</span>';
  }).join('');
  document.getElementById('bybitViable').innerHTML=allBybit.map(function(t){
    var ok=!skipBybit.includes(t);
    return '<span class="badge '+(ok?'bg':'br')+'">'+t+'</span>';
  }).join('');

  // In-flight trades
  var pending=[
    ...(st?.pendingDex||[]).map(function(t){return{...t,type:'DEX'}}),
    ...(st?.pendingOkx||[]).map(function(t){return{...t,type:'OKX'}}),
    ...(st?.pendingBybit||[]).map(function(t){return{...t,type:'Bybit'}}),
  ];
  var inflightSec=document.getElementById('inflightSection');
  if(pending.length>0){
    inflightSec.style.display='';
    document.getElementById('inflightCount').textContent=pending.length+' trade'+(pending.length>1?'s':'');
    document.getElementById('inflightList').innerHTML=pending.map(function(t){
      var elapsed2=Math.round((Date.now()-t.startTime)/1000/60);
      var maxMin=120;
      var pct=Math.min(100,Math.round(elapsed2/maxMin*100));
      var entry=t.entryPrice?'entry $'+t.entryPrice.toFixed(4):'';
      return '<div class="inflight-row">'+
        '<div><b class="purple">'+t.symbol+'</b> <span class="badge by">'+t.type+'</span> '+entry+'</div>'+
        '<div><span class="timer">'+elapsed2+'min</span> <span class="countdown">'+pct+'% of 2hr</span></div>'+
        '</div>'+
        '<div class="prog" style="margin-bottom:6px"><div class="progf" style="width:'+pct+'%;background:'+(pct>80?'#ef4444':pct>50?'#eab308':'#7c3aed')+'"></div></div>';
    }).join('');
  } else {
    inflightSec.style.display='none';
  }

  // Live spreads
  var lb=document.getElementById('ltable');
  if(d.live?.pairs?.length>0){
    lb.innerHTML=d.live.pairs.map(function(p){
      var best=Math.max(p.spreadOKX,p.spreadBybit??-999,p.spreadDex);
      var thr=p.dexEnabled?p.dexThresh:1.0;
      var pct=best/thr;
      var rc=pct>=1.0?'fire-row':'';
      var oc='<span style="color:'+sc(p.spreadOKX,1.0)+'">'+(p.spreadOKX>0?'+':'')+p.spreadOKX.toFixed(2)+'%</span>';
      var bc=p.spreadBybit!=null?'<span style="color:'+sc(p.spreadBybit,1.0)+'">'+(p.spreadBybit>0?'+':'')+p.spreadBybit.toFixed(2)+'%</span>':'<span class="dim">--</span>';
      var dc=p.dexEnabled?'<span style="color:'+sc(p.spreadDex,p.dexThresh)+'">'+(p.spreadDex>0?'+':'')+p.spreadDex.toFixed(2)+'%</span>':'<span class="dim">'+p.spreadDex.toFixed(2)+'% off</span>';
      var tags=(!p.okxViable?'<span class="badge br">Os</span>':'')+(!p.bybitViable&&p.spreadBybit!=null?'<span class="badge br">Bs</span>':'')+(!p.dexEnabled?'<span class="badge bn">Ds</span>':'');
      var st2=pct>=1.0?'<span class="badge by">!!!</span>':pct>=0.8?'<span class="badge by">[O]</span>':pct>=0.5?'<span class="badge bp">[P]</span>':'';
      return '<tr class="'+rc+'"><td><b>'+p.name.replace('/USDT','')+'</b> '+tags+'</td>'+
        '<td class="dim" style="font-size:.65rem">'+(p.okxBid?'$'+p.okxBid:'--')+'</td>'+
        '<td class="dim" style="font-size:.65rem">'+(p.bybitBid?'$'+p.bybitBid:'--')+'</td>'+
        '<td style="text-align:right">'+oc+'</td><td style="text-align:right">'+bc+'</td><td style="text-align:right">'+dc+'</td>'+
        '<td class="dim">>='+thr+'%</td><td>'+st2+'</td></tr>';
    }).join('');
  } else {
    lb.innerHTML='<tr><td colspan="8" class="dim" style="padding:12px;text-align:center">Waiting for scan data...</td></tr>';
  }

  // Capital chart
  var labels=d.balHistory.map(function(b){return b.time.slice(5,16);});
  var totals=d.balHistory.map(function(b){return b.total;});
  var ctx=document.getElementById('chart').getContext('2d');
  if(chart)chart.destroy();
  chart=new Chart(ctx,{type:'line',data:{labels:labels,datasets:[{label:'Total',data:totals,borderColor:'#7c3aed',backgroundColor:'rgba(124,58,237,0.1)',borderWidth:2,pointRadius:1,fill:true,tension:0.3}]},
    options:{responsive:true,plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#333',maxTicksLimit:6,font:{size:9}},grid:{color:'#0f0f1a'}},y:{ticks:{color:'#555',font:{size:9},callback:function(v){return'$'+v.toFixed(0);}},grid:{color:'#0f0f1a'}}}}});

  // Fire table
  document.getElementById('firetable').innerHTML=d.recentFires.map(function(f){
    var time=new Date(f.date).toLocaleString('en-GB',{month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'});
    var oc=f.outcome==='success'?'<span class="badge bg">OK</span>':f.outcome==='loss'?'<span class="badge br">[!]</span>':f.outcome==='fired'?'<span class="badge by">[F]</span>':'<span class="badge br">Error:</span>';
    var reason=f.reason?f.reason.slice(0,25):'';
    return '<tr><td class="dim" style="white-space:nowrap">'+time+'</td>'+
      '<td>'+(f.pair||'').replace('/USDT','')+'</td>'+
      '<td><span class="badge bn" style="font-size:.6rem">'+(f.direction||'').replace('BUY_','')+'</span></td>'+
      '<td>'+oc+'</td>'+
      '<td class="dim" style="font-size:.65rem">'+reason+'</td></tr>';
  }).join('');

  // Trade table
  document.getElementById('ttable').innerHTML=d.recentTrades.map(function(t){
    var profit=t.profit||0;
    var date=new Date(t.date).toLocaleString('en-GB',{month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'});
    var dc=t.direction?.includes('DEX')?'bg':t.direction?.includes('RECOVERY')?'bp':'by';
    return '<tr><td class="dim" style="white-space:nowrap">'+date+'</td>'+
      '<td>'+(t.pair?.replace('/USDT','')||'')+'</td>'+
      '<td><span class="badge '+dc+'" style="font-size:.6rem">'+(t.direction?.replace('BUY_','')||'')+'</span></td>'+
      '<td>'+(t.spreadPct?.toFixed(2)||'-')+'%</td>'+
      '<td class="'+(profit>=0?'green':'red')+'">'+(profit>=0?'+':'')+'$'+profit.toFixed(2)+'</td>'+
      '<td class="dim">'+(t.durationMin||0)+'</td></tr>';
  }).join('');

  // Pair stats
  document.getElementById('ptable').innerHTML=Object.entries(d.pairStats)
    .sort(function(a,b){return b[1].fires-a[1].fires;})
    .map(function(entry){
      var pair=entry[0],s=entry[1];
      var wr=s.fires?Math.round(s.wins/s.fires*100):0;
      var avg=s.spreads.length?(s.spreads.reduce(function(a,b){return a+b;},0)/s.spreads.length).toFixed(2):'-';
      return '<tr><td>'+pair.replace('/USDT','')+'</td><td>'+s.fires+'</td>'+
        '<td class="'+(wr>=50?'green':wr>0?'yellow':'red')+'">'+wr+'%</td>'+
        '<td class="dim">'+avg+'%</td>'+
        '<td class="'+(s.pnl>=0?'green':'red')+'">'+(s.pnl>=0?'+':'')+'$'+s.pnl.toFixed(2)+'</td></tr>';
    }).join('');
}

var MINT_SYMBOLS={'So11111111111111111111111111111111111111112':'SOL','EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v':'USDC','Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB':'USDT','jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL':'JTO','EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm':'WIF','DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263':'BONK','JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN':'JUP','HZ1JovNiVvGqNLPQFZE5BsKs1Jvzd2Qqxe5bw3RVFHW':'PYTH','4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R':'RAY','85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ':'W','7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr':'POPCAT','MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5':'MEW','ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82':'BOME','6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN':'TRUMP','ZEUS1aR7aX8DFFkgutzZaBW51tvGc4GRsHcEUuRLJtb':'ZEUS','rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof':'RENDER','2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump':'PNUT','CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump':'GOAT','2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv':'PENGU'};
var scr=document.createElement('script');
scr.src='https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js';
scr.onload=function(){refresh();setInterval(refresh,3000);};
document.head.appendChild(scr);
</script>
<div id="rebalanceModal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:1000;align-items:center;justify-content:center">
  <div style="background:#11111c;border:1px solid #eab308;border-radius:10px;padding:24px;max-width:400px;width:90%">
    <h3 style="color:#eab308;margin-bottom:16px">Rebalance Capital</h3>
    <div id="rebalanceContent" style="color:#e0e0e0;font-size:.8rem;margin-bottom:16px">Loading...</div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button onclick="executeRebalance()" id="rebalanceExecBtn" class="btn" style="border-color:#22c55e;color:#22c55e;flex:1">Execute</button>
      <button onclick="closeRebalanceModal()" class="btn" style="flex:1">Cancel</button>
    </div>
  </div>
</div>
</body>
</html>`;
}

async function sendTelegram(text) {
  try {
    const token  = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
  } catch {}
}

const server = http.createServer(async function(req, res) {
  const url = req.url.split('?')[0];

  if (req.url === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getData()));

  } else if (req.url === '/api/tokens') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(await fetchTokenBalances()));

  } else if (req.url === '/api/live-balances') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      const config = readJSON(CONFIG_FILE) || {};
      const krakenEnabled = config.KRAKEN_ENABLED || false;
      const [solana, okx, bybit] = await Promise.all([fetchSolanaBalance(), fetchOKXBalance(), fetchBybitBalance()]);
      let kraken = null;
      if (krakenEnabled) {
        try {
          const crypto2 = require('crypto');
          const nonce = Date.now().toString();
          const data = 'nonce=' + nonce;
          const hash = crypto2.createHash('sha256').update(nonce + data).digest('binary');
          const hmac = crypto2.createHmac('sha512', Buffer.from(process.env.KRAKEN_API_SECRET, 'base64'));
          hmac.update('/0/private/Balance', 'binary');
          hmac.update(hash, 'binary');
          const sig = hmac.digest('base64');
          const r = await fetch('https://api.kraken.com/0/private/Balance', {
            method: 'POST',
            headers: { 'API-Key': process.env.KRAKEN_API_KEY, 'API-Sign': sig, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: data,
          });
          const j = await r.json();
          kraken = parseFloat(j.result?.USDT || j.result?.ZUSD || '0');
        } catch { kraken = 0; }
      }
      res.end(JSON.stringify({ solana, okx, bybit, kraken, krakenEnabled, fetchedAt: new Date().toISOString() }));
    } catch(e) { res.end(JSON.stringify({ solana: null, okx: null, bybit: null, error: e.message })); }

  } else if (req.url === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try { res.end(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { res.end('{}'); }

  } else if (url === '/api/restart' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      const { execSync } = require('child_process');
      // Send Telegram notification
      await sendTelegram('🔄 <b>Bot restarting</b> — triggered from dashboard');
      // Kill and restart via watchdog signal
      try { execSync('taskkill /F /IM node.exe /FI "WINDOWTITLE eq okx-arb*"', { stdio: 'ignore' }); } catch {}
      res.end(JSON.stringify({ ok: true, message: 'Restart signal sent' }));
    } catch(e) { res.end(JSON.stringify({ ok: false, error: e.message })); }

  } else if (url === '/api/resync' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      const state  = readJSON(STATE_FILE) || {};
      const trades = readJSON(TRADES_FILE) || [];
      const real   = trades.filter(t => t.direction !== 'RECOVERY');
      const wins   = real.filter(t => t.profit > 0).length;
      const pnl    = real.reduce((a, t) => a + (t.profit || 0), 0);
      let consec   = 0;
      for (let i = real.length - 1; i >= 0; i--) {
        if (real[i].profit > 0) consec++; else break;
      }
      const corrected = {
        ...state,
        totalTrades:    real.length,
        winningTrades:  wins,
        totalProfit:    pnl,
        consecutiveWins: consec,
        lastResync:     new Date().toISOString(),
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(corrected, null, 2));
      fs.writeFileSync(STATE_FILE + '.bak', JSON.stringify(corrected, null, 2));
      const winPct = real.length ? Math.round(wins / real.length * 100) : 0;
      const winsBar = '🟢'.repeat(consec) + '⚪'.repeat(Math.max(0, 10 - consec));
      await sendTelegram(
        '🔁 <b>State resynced from dashboard</b>\n' +
        'Trades: ' + real.length + ' | Wins: ' + wins + ' (' + winPct + '%) | P&L: ' + (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2) + '\n' +
        'Consecutive: ' + winsBar + ' ' + consec + '/10'
      );
      res.end(JSON.stringify({ ok: true, trades: real.length, wins, pnl, consec }));
    } catch(e) { res.end(JSON.stringify({ ok: false, error: e.message })); }

  } else if (url === '/api/rebalance-check' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      const [solana, okx, bybit] = await Promise.all([fetchSolanaBalance(), fetchOKXBalance(), fetchBybitBalance()]);
      const config = readJSON(CONFIG_FILE) || {};
      const targetSolana = config.REBALANCE_TARGET_SOLANA ?? 200;
      const targetOKX    = config.REBALANCE_TARGET_OKX    ?? 350;
      const targetBybit  = config.REBALANCE_TARGET_BYBIT  ?? 300;
      const solanaExcess   = Math.max(0, (solana||0) - targetSolana);
      const okxShortfall   = Math.max(0, targetOKX   - (okx||0));
      const bybitShortfall = Math.max(0, targetBybit - (bybit||0));
      const totalShortfall = okxShortfall + bybitShortfall;
      let toOKX = 0, toBybit = 0;
      if (solanaExcess > 10 && totalShortfall > 10) {
        const budget = Math.min(solanaExcess, totalShortfall);
        if (okxShortfall >= bybitShortfall) {
          toOKX   = Math.min(okxShortfall, budget);
          toBybit = Math.min(bybitShortfall, Math.max(0, budget - toOKX));
        } else {
          toBybit = Math.min(bybitShortfall, budget);
          toOKX   = Math.min(okxShortfall, Math.max(0, budget - toBybit));
        }
      }
      res.end(JSON.stringify({
        solana, okx, bybit,
        targetSolana, targetOKX, targetBybit,
        toOKX: Math.round(toOKX), toBybit: Math.round(toBybit),
        needed: toOKX > 5 || toBybit > 5
      }));
    } catch(e) { res.end(JSON.stringify({ error: e.message })); }

  } else if (url === '/api/rebalance-execute' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      // Send rebalance command to bot via Telegram (bot handles execution)
      await sendTelegram('/rebalance confirm');
      res.end(JSON.stringify({ ok: true, message: 'Rebalance command sent to bot' }));
    } catch(e) { res.end(JSON.stringify({ ok: false, error: e.message })); }

  } else if (url === '/api/deploy-status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      const status = readJSON(path.join(__dirname, 'bot-status.json')) || {};
      const state  = readJSON(STATE_FILE) || {};
      const hasBackup = fs.existsSync(path.join(__dirname, 'arb-state.json.deploy-bak'));
      res.end(JSON.stringify({
        version:    status.version || 'unknown',
        timestamp:  status.timestamp,
        uptime:     status.timestamp ? Math.round((Date.now() - new Date(status.timestamp).getTime()) / 1000) : null,
        hasBackup,
        trades:     state.totalTrades || 0,
        pnl:        state.totalProfit || 0,
      }));
    } catch(e) { res.end(JSON.stringify({ error: e.message })); }

  } else if (url === '/api/rollback' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      const bakState  = path.join(__dirname, 'arb-state.json.deploy-bak');
      const bakTrades = path.join(__dirname, 'trades.json.deploy-bak');
      let restored = [];
      if (fs.existsSync(bakState)) {
        fs.copyFileSync(bakState, path.join(__dirname, 'arb-state.json'));
        restored.push('arb-state.json');
      }
      if (fs.existsSync(bakTrades)) {
        fs.copyFileSync(bakTrades, path.join(__dirname, 'trades.json'));
        restored.push('trades.json');
      }
      await sendTelegram('Rollback executed from dashboard. Restored: ' + restored.join(', '));
      res.end(JSON.stringify({ ok: true, restored }));
    } catch(e) { res.end(JSON.stringify({ ok: false, error: e.message })); }

  } else if (url === '/api/volatile' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      const mode = new URL('http://x' + req.url).searchParams.get('mode');
      const c    = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      c.VOLATILE_MODE = mode === 'on';
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
      res.end(JSON.stringify({ volatile: c.VOLATILE_MODE }));
    } catch(e) { res.end(JSON.stringify({ error: e.message })); }

  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(buildHTML());
  }
});

server.on('error', function(err) {
  if (err.code === 'EADDRINUSE') {
    console.error('\n❌ Port ' + PORT + ' already in use.');
    console.error('   Run: taskkill /F /IM node.exe /T');
    console.error('   Then restart: node dashboard.js\n');
    process.exit(1);
  } else {
    throw err;
  }
});

server.listen(PORT, function() {
  console.log('\n📊 Dashboard v4.10 — http://localhost:' + PORT);
  console.log('   Version badge, deploy status, rollback, Kraken sim panel\n');
});
