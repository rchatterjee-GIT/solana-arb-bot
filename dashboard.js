require('dotenv').config();
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT        = 3001;
const VERSION     = 'v5.2';
const STATE_FILE  = path.join(__dirname, 'arb-state.json');
const TRADES_FILE = path.join(__dirname, 'trades.json');
const FIRES_FILE  = path.join(__dirname, 'fires.json');
const LOG_FILE    = path.join(__dirname, 'arb-log.json');
const LIVE_FILE   = path.join(__dirname, 'arb-live.json');
const STATUS_FILE = path.join(__dirname, 'bot-status.json');
const CONFIG_FILE = path.join(__dirname, 'arb-config.json');

function readJSON(f) { try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch { return null; } }

async function fetchOKX() {
  try {
    const ts=new Date().toISOString();
    const sig=crypto.createHmac('sha256',process.env.OKX_API_SECRET).update(ts+'GET'+'/api/v5/account/balance').digest('base64');
    const r=await fetch('https://www.okx.com/api/v5/account/balance',{headers:{'OK-ACCESS-KEY':process.env.OKX_API_KEY,'OK-ACCESS-SIGN':sig,'OK-ACCESS-TIMESTAMP':ts,'OK-ACCESS-PASSPHRASE':process.env.OKX_PASSPHRASE}});
    const j=await r.json();
    const details=j.data?.[0]?.details||[];
    const usdt=details.find(d=>d.ccy==='USDT');
    const tokens=details.filter(d=>d.ccy!=='USDT'&&parseFloat(d.eqUsd||0)>0.01).map(d=>({sym:d.ccy,bal:parseFloat(d.availBal),usd:parseFloat(d.eqUsd||0)}));
    return {usdt:parseFloat(usdt?.availBal||0),tokens};
  } catch(e){return {usdt:null,tokens:[]};}
}

async function fetchBybit() {
  try {
    const ts=''+Date.now(),rw='5000',qs='accountType=UNIFIED';
    const sig=crypto.createHmac('sha256',process.env.BYBIT_API_SECRET).update(ts+process.env.BYBIT_API_KEY+rw+qs).digest('hex');
    const r=await fetch('https://api.bybit.com/v5/account/wallet-balance?'+qs,{headers:{'X-BAPI-API-KEY':process.env.BYBIT_API_KEY,'X-BAPI-TIMESTAMP':ts,'X-BAPI-SIGN':sig,'X-BAPI-RECV-WINDOW':rw}});
    const j=await r.json();
    const coins=j.result?.list?.[0]?.coin||[];
    const usdt=coins.find(c=>c.coin==='USDT');
    const tokens=coins.filter(c=>c.coin!=='USDT'&&parseFloat(c.usdValue||0)>0.01).map(c=>({sym:c.coin,bal:parseFloat(c.walletBalance),usd:parseFloat(c.usdValue||0)}));
    // Also fetch FUND account balance
    const ts2=''+Date.now(),qs2='accountType=FUND&coin=USDT';
    const sig2=crypto.createHmac('sha256',process.env.BYBIT_API_SECRET).update(ts2+process.env.BYBIT_API_KEY+rw+qs2).digest('hex');
    const r2=await fetch('https://api.bybit.com/v5/asset/transfer/query-account-coins-balance?'+qs2,{headers:{'X-BAPI-API-KEY':process.env.BYBIT_API_KEY,'X-BAPI-TIMESTAMP':ts2,'X-BAPI-SIGN':sig2,'X-BAPI-RECV-WINDOW':rw}});
    const j2=await r2.json();
    const fundUsdt=parseFloat(j2.result?.balance?.[0]?.walletBalance||'0');
    const unifiedUsdt=parseFloat(usdt?.equity||0);
    return {usdt:unifiedUsdt+fundUsdt,tokens,unified:unifiedUsdt,fund:fundUsdt};
  } catch(e){return {usdt:null,tokens:[]};}
}

async function fetchSolana() {
  try {
    const {Connection,Keypair,PublicKey}=require('@solana/web3.js');
    const {getAssociatedTokenAddress,getAccount}=require('@solana/spl-token');
    const conn=new Connection(process.env.RPC_URL,'confirmed');
    const wallet=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY)));
    const USDC=new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const ata=await getAssociatedTokenAddress(USDC,wallet.publicKey);
    const acc=await getAccount(conn,ata);
    const usdc=parseFloat((Number(acc.amount)/1e6).toFixed(2));
    const r=await fetch(process.env.RPC_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getTokenAccountsByOwner',params:[wallet.publicKey.toString(),{programId:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'},{encoding:'jsonParsed'}]})});
    const j=await r.json();
    const SYMS={'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL':'JTO','EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm':'WIF','85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ':'W','2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump':'PNUT','CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump':'GOAT','2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv':'PENGU','4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R':'RAY','Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB':'USDT'};
    const tokens=(j.result?.value||[]).filter(a=>{const info=a.account.data.parsed?.info;return parseFloat(info?.tokenAmount?.uiAmount||0)>0.001&&info?.mint!=='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';}).map(a=>{const info=a.account.data.parsed?.info;return {sym:SYMS[info.mint]||info.mint.slice(0,8),bal:parseFloat(info.tokenAmount.uiAmount),mint:info.mint};});
    return {usdc,tokens};
  } catch(e){return {usdc:null,tokens:[]};}
}

async function fetchKraken() {
  try {
    const nonce=''+Date.now(),data='nonce='+nonce;
    const hash=crypto.createHash('sha256').update(nonce+data).digest('binary');
    const hmac=crypto.createHmac('sha512',Buffer.from(process.env.KRAKEN_API_SECRET,'base64'));
    hmac.update('/0/private/Balance','binary');hmac.update(hash,'binary');
    const sig=hmac.digest('base64');
    const r=await fetch('https://api.kraken.com/0/private/Balance',{method:'POST',headers:{'API-Key':process.env.KRAKEN_API_KEY,'API-Sign':sig,'Content-Type':'application/x-www-form-urlencoded'},body:data});
    const j=await r.json();
    const usdt=parseFloat(j.result?.USDT||0);
    const zusd=parseFloat(j.result?.ZUSD||0);
    return usdt+zusd;
  } catch(e){return null;}
}

async function fetchCoinbase() {
  try {
    if(!process.env.COINBASE_API_KEY||!process.env.COINBASE_API_SECRET) return null;
    const cb = require('./coinbase-scaffold');
    return await cb.getCoinbaseBalance('USDC');
  } catch(e){ return null; }
}

async function sendTG(text) {
  try {
    await fetch('https://api.telegram.org/bot'+process.env.TELEGRAM_TOKEN+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:process.env.TELEGRAM_CHAT_ID,text,parse_mode:'HTML'})});
  } catch {}
}

function getData() {
  const state=readJSON(STATE_FILE)||{};
  const trades=readJSON(TRADES_FILE)||[];
  const fires=readJSON(FIRES_FILE)||[];
  const log=readJSON(LOG_FILE)||{};
  const live=readJSON(LIVE_FILE)||null;
  const status=readJSON(STATUS_FILE)||null;
  const config=readJSON(CONFIG_FILE)||{};
  const recentTrades=trades.slice(-20).reverse();
  const recentFires=fires.slice(-30).reverse();
  const pairStats={};
  for(const t of trades){if(!pairStats[t.pair])pairStats[t.pair]={fires:0,wins:0,pnl:0};pairStats[t.pair].fires++;if(t.profit>0)pairStats[t.pair].wins++;pairStats[t.pair].pnl+=t.profit||0;}
  const balHistory=[];
  for(const [date,day] of Object.entries(log).slice(-7)){for(const r of(day.reports||[]))balHistory.push({time:date+' '+r.time,total:r.total,okx:r.okxUsdt,solana:r.solanaUsdc,bybit:r.bybitUsdt});}
  const now=Date.now(),oneWeek=7*24*60*60*1000;
  const week=trades.filter(t=>new Date(t.date).getTime()>now-oneWeek);
  const allWins=trades.filter(t=>t.profit>0).length;
  const weekPnl=week.reduce((a,t)=>a+(t.profit||0),0);
  const startCapital=state.startCapital||0;
  const tradingProfit=state.totalProfit||0;
  const injRatio=startCapital?(tradingProfit/startCapital*100):0;
  const latest=balHistory[balHistory.length-1]||{};
  return {state,recentTrades,recentFires,pairStats,balHistory,live,status,config,
    allWinPct:trades.length?Math.round(allWins/trades.length*100):0,
    weekPnl,latest,allTrades:trades.length,allWins,startCapital,tradingProfit,injRatio,
    now:new Date().toISOString()};
}

function buildHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arb Bot ${VERSION}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:monospace;background:#08080f;color:#e0e0e0;font-size:13px}
.topbar{position:sticky;top:0;z-index:100;background:#0a0a14;border-bottom:1px solid #1e1e30;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.content{padding:12px}
.tabs{display:flex;gap:2px;margin-bottom:12px;border-bottom:1px solid #1e1e30}
.tab{padding:7px 16px;cursor:pointer;font-size:.75rem;color:#555;border-bottom:2px solid transparent;transition:all .15s}
.tab:hover{color:#a78bfa}
.tab.active{color:#a78bfa;border-bottom-color:#7c3aed}
.panel{display:none}
.panel.active{display:block}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
.g3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:10px}
.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:10px}
.g5{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:10px}
.card{background:#11111c;border:1px solid #1e1e30;border-radius:8px;padding:12px}
.card.warn{border-color:#eab308}
.card.danger{border-color:#ef4444}
.val{font-size:1.3rem;font-weight:700;color:#7c3aed}
.val.ok{color:#22c55e}
.val.warn{color:#eab308}
.val.bad{color:#ef4444}
.lbl{font-size:.68rem;color:#555;margin-top:2px}
.sub{font-size:.72rem;color:#888;margin-top:4px}
.green{color:#22c55e}.red{color:#ef4444}.yellow{color:#eab308}.purple{color:#a78bfa}.dim{color:#444}
.badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:.65rem;font-weight:700;margin-right:3px}
.bg{background:#14532d;color:#22c55e}.br{background:#450a0a;color:#ef4444}
.by{background:#422006;color:#eab308}.bp{background:#2e1065;color:#a78bfa}.bn{background:#1e1e30;color:#666}
.wdot{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:2px}
.wf{background:#22c55e}.we{background:#2a2a3f}
.ver{background:#1e1e30;color:#a78bfa;border:1px solid #4c1d95;border-radius:4px;padding:2px 8px;font-size:.72rem;font-weight:bold}
.pill{border-radius:4px;padding:2px 8px;font-size:.72rem;font-weight:bold}
.pa{background:#14532d;color:#22c55e}.pq{background:#1e1e30;color:#666}
.btn{background:#1e1e30;border:1px solid #4c1d95;color:#a78bfa;border-radius:5px;padding:5px 12px;font-size:.72rem;cursor:pointer;white-space:nowrap}
.btn:hover{background:#2e1065;color:#fff}
.btn.ok{border-color:#22c55e;color:#22c55e}
.btn.warn{border-color:#eab308;color:#eab308}
.btn.danger{border-color:#ef4444;color:#ef4444}
.btn:disabled{opacity:.4;cursor:not-allowed}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px}
.dg{background:#22c55e}.dr{background:#ef4444}
.pulse{animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.prog{height:6px;background:#1e1e30;border-radius:3px;overflow:hidden;margin-top:4px}
.pf{height:100%;border-radius:3px}
.sec{color:#a78bfa;font-size:.68rem;text-transform:uppercase;letter-spacing:.08em;margin:14px 0 6px;border-bottom:1px solid #1e1e30;padding-bottom:3px}
table{width:100%;border-collapse:collapse;font-size:.72rem}
th{padding:4px 6px;color:#444;border-bottom:1px solid #1e1e30;text-align:left;font-weight:normal}
td{padding:4px 6px;border-bottom:1px solid #0f0f1a}
tr:hover td{background:#14141f}
.modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.85);z-index:1000;align-items:center;justify-content:center}
.mbox{background:#11111c;border:1px solid #eab308;border-radius:10px;padding:24px;max-width:440px;width:90%}
.tok-grid{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
.tok{background:#11111c;border:1px solid #1e1e30;border-radius:6px;padding:6px 10px;font-size:.72rem}
.tok b{color:#a78bfa}
.tok span{color:#22c55e}
.alert-row{background:#1a0a0a;border:1px solid #ef4444;border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:.72rem}
</style>
</head>
<body>

<div class="topbar">
  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <span class="ver" id="vb">${VERSION}</span>
    <span class="pill" id="sp">loading...</span>
    <span style="font-size:.68rem;color:#444"><span class="dot dg pulse" id="ld"></span><span id="la">-</span></span>
    <span style="font-size:.68rem;color:#555">v<span id="bv" style="color:#a78bfa">-</span> up <span id="du" style="color:#888">-</span> trades:<span id="dt" style="color:#888">-</span> p&l:<span id="dp" style="color:#888">-</span></span>
  </div>
  <div style="display:flex;gap:6px;flex-wrap:wrap">
    <button class="btn" onclick="doRefresh()">Refresh</button>
    <button class="btn warn" onclick="doRebalance()">Rebalance</button>
    <button class="btn ok" onclick="doResync()">Resync</button>
    <button class="btn danger" onclick="doRestart()">Restart</button>
    <span id="dbk" style="display:none"><button class="btn" style="border-color:#666;color:#666" onclick="doRollback()">Rollback</button></span>
  </div>
</div>

<div class="content">

<div class="tabs">
  <div class="tab active" onclick="switchTab('status')">Status</div>
  <div class="tab" onclick="switchTab('wallets')">Wallets</div>
  <div class="tab" onclick="switchTab('market')">Market</div>
  <div class="tab" onclick="switchTab('trades')">Trades</div>
</div>

<!-- STATUS TAB -->
<div id="tab-status" class="panel active">

  <div id="alerts-box"></div>

  <div class="g5">
    <div class="card"><div class="val" id="tc">-</div><div class="lbl">Total Capital</div><div class="sub" id="tc-delta"></div><div class="sub" id="cg">-</div></div>
    <div class="card"><div class="val" id="ls">-</div><div class="lbl">Solana USDC</div><div class="sub" id="ls-delta"></div></div>
    <div class="card" id="okx-card"><div class="val" id="lo">-</div><div class="lbl">OKX USDT</div><div class="sub" id="os">-</div><div class="sub" id="lo-delta"></div></div>
    <div class="card"><div class="val" id="lb">-</div><div class="lbl">Bybit USDT</div><div class="sub" id="bs">-</div><div class="sub" id="lb-delta"></div></div>
    <div class="card"><div class="val" id="lk">-</div><div class="lbl">Kraken</div><div class="sub" id="ks">-</div><div class="sub" id="lk-delta"></div></div>
    <div class="card"><div class="val" id="lcb">-</div><div class="lbl">Coinbase USDC</div><div class="sub" id="cbs">-</div><div class="sub" id="lcb-delta"></div></div>
  </div>

  <div class="g5">
    <div class="card"><div class="lbl" style="margin-bottom:5px">Consecutive Wins</div><div id="wb" style="display:flex;gap:2px;flex-wrap:wrap"></div><div class="sub" id="wt">-</div></div>
    <div class="card"><div class="lbl" style="margin-bottom:5px">Consecutive Clean</div><div id="cb" style="display:flex;gap:2px;flex-wrap:wrap"></div><div class="sub" id="ct">-</div></div>
    <div class="card"><div class="val" id="pl">-</div><div class="lbl">Trading P&L</div></div>
    <div class="card"><div class="val" id="wr">-</div><div class="lbl">Win Rate</div><div class="sub" id="wd">-</div></div>
    <div class="card"><div class="val" id="ri">-</div><div class="lbl">Return on Capital</div><div class="prog"><div class="pf" id="rb" style="background:linear-gradient(90deg,#7c3aed,#22c55e)"></div></div></div>
  </div>

  <div id="ifsec" style="display:none;margin-bottom:10px">
    <div class="sec">In-flight Trades <span id="ifc"></span></div>
    <div id="ifl"></div>
  </div>

  <div class="g2">
    <div class="card">
      <div class="sec" style="margin-top:0;display:flex;justify-content:space-between;align-items:center">
        Agent Feed <span style="font-size:.65rem;color:#444" id="af-age"></span>
      </div>
      <div id="af-list" style="font-size:.68rem;max-height:220px;overflow-y:auto"></div>
    </div>
    <div class="card">
      <div class="sec" style="margin-top:0">Capital Chart</div>
      <canvas id="ch" height="120"></canvas>
    </div>
  </div>
</div>

<!-- WALLETS TAB -->
<div id="tab-wallets" class="panel">
  <div class="sec" style="margin-top:0;display:flex;justify-content:space-between;align-items:center">
    Exchange Balances
    <button class="btn ok" style="font-size:.65rem;padding:3px 8px" onclick="doLiveBalances()">Live Refresh</button>
  </div>
  <div class="g4" style="margin-bottom:10px">
    <div class="card" id="w-sol-card">
      <div class="val" id="w-sol">-</div>
      <div class="lbl">Solana USDC</div>
      <div id="w-sol-toks" class="tok-grid"></div>
    </div>
    <div class="card" id="w-okx-card">
      <div class="val" id="w-okx">-</div>
      <div class="lbl">OKX USDT</div>
      <div id="w-okx-toks" class="tok-grid"></div>
    </div>
    <div class="card" id="w-bybit-card">
      <div class="val" id="w-bybit">-</div>
      <div class="lbl">Bybit USDT</div>
      <div id="w-bybit-toks" class="tok-grid"></div>
    </div>
    <div class="card">
      <div class="val" id="w-kraken">-</div>
      <div class="lbl">Kraken USDT</div>
    </div>
    <div class="card">
      <div class="val" id="w-coinbase">-</div>
      <div class="lbl">Coinbase USDC</div>
    </div>
  </div>

  <div class="sec">Rebalance Targets</div>
  <div class="card" style="margin-bottom:10px">
    <table>
      <thead><tr><th>Exchange</th><th>Current</th><th>Target</th><th>Status</th><th>Action</th></tr></thead>
      <tbody id="rebal-table"></tbody>
    </table>
  </div>

  <div class="sec">Pair Viability</div>
  <div class="card">
    <div style="margin-bottom:8px"><span class="dim">OKX: </span><span id="ov"></span></div>
    <div style="margin-bottom:8px"><span class="dim">Bybit: </span><span id="byv"></span></div>
    <div id="kvr" style="display:none"><span class="dim">Kraken: </span><span id="kv"></span></div>
    <div id="cvr" style="display:none"><span class="dim">Coinbase: </span><span id="cbv"></span></div>
  </div>
</div>

<!-- MARKET TAB -->
<div id="tab-market" class="panel">
  <div class="sec" style="margin-top:0">Live Spreads</div>
  <div class="card" style="margin-bottom:10px">
    <table>
      <thead><tr><th>Pair</th><th>OKX bid</th><th>Bybit bid</th><th style="text-align:right">OKX%</th><th style="text-align:right">Bybit%</th><th style="text-align:right">DEX%</th><th>Status</th></tr></thead>
      <tbody id="lt"></tbody>
    </table>
  </div>
  <div class="sec">Recent Fires</div>
  <div class="card">
    <table><thead><tr><th>Time</th><th>Pair</th><th>Dir</th><th>Spread</th><th>Result</th><th>Reason</th></tr></thead>
    <tbody id="ft"></tbody></table>
  </div>
</div>

<!-- TRADES TAB -->
<div id="tab-trades" class="panel">
  <div class="g3" style="margin-bottom:10px">
    <div class="card"><div class="val" id="t-total">-</div><div class="lbl">Total Trades</div></div>
    <div class="card"><div class="val" id="t-wins">-</div><div class="lbl">Win Rate</div></div>
    <div class="card"><div class="val" id="t-pnl">-</div><div class="lbl">Total P&L</div></div>
  </div>
  <div class="sec" style="margin-top:0">Recent Trades</div>
  <div class="card" style="margin-bottom:10px">
    <table><thead><tr><th>Date</th><th>Pair</th><th>Dir</th><th>Spread</th><th>Duration</th><th>P&L</th></tr></thead>
    <tbody id="tt"></tbody></table>
  </div>
  <div class="sec">Pair Statistics</div>
  <div class="card">
    <table><thead><tr><th>Pair</th><th>Fires</th><th>Win%</th><th>Avg spread</th><th>P&L</th></tr></thead>
    <tbody id="pt"></tbody></table>
  </div>
</div>

</div><!-- end content -->

<!-- REBALANCE MODAL -->
<div id="rm" class="modal">
  <div class="mbox">
    <h3 style="color:#eab308;margin-bottom:16px">Rebalance Capital</h3>
    <div id="rc" style="color:#e0e0e0;font-size:.8rem;margin-bottom:16px">Loading...</div>
    <div style="display:flex;gap:8px">
      <button onclick="execRebalance()" id="re" class="btn ok" style="flex:1">Execute</button>
      <button onclick="closeR()" class="btn" style="flex:1">Cancel</button>
    </div>
  </div>
</div>

<script>
var chart=null,liveBal=null,activeTab='status';

function switchTab(t){
  activeTab=t;
  document.querySelectorAll('.tab').forEach(function(el,i){el.classList.toggle('active',['status','wallets','market','trades'][i]===t);});
  document.querySelectorAll('.panel').forEach(function(el){el.classList.remove('active');});
  document.getElementById('tab-'+t).classList.add('active');
  if(t==='wallets')doLiveBalances();
}

function sc(v,t){var p=v/t;if(p>=1)return'#eab308';if(p>=.8)return'#f97316';if(p>=.5)return'#a78bfa';if(v>0)return'#22c55e';return'#ef4444';}
function countdown(ms){var s=Math.round((ms-Date.now())/1000);if(s<=0)return'now';if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m';return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';}
function fmt2(n){return n!=null?'$'+parseFloat(n).toFixed(2):'-';}

async function loadAgentFeed(){
  try{
    var r=await fetch('/api/agent-feed');var d=await r.json();
    var el=document.getElementById('af-list');
    var age=d.lastRun?Math.round((Date.now()-new Date(d.lastRun).getTime())/1000)+'s ago':'never';
    document.getElementById('af-age').textContent=age+' | '+d.actionsToday+' actions today'+(d.paused?' | PAUSED':'');
    if(!d.entries||d.entries.length===0){el.innerHTML='<span class="dim">No agent activity yet</span>';return;}
    var today=new Date().toISOString().slice(0,10);
    el.innerHTML=d.entries.map(function(e){
      var isAction=e.msg.startsWith('Action:');
      var isMarket=e.msg.startsWith('Market:')||e.msg.startsWith('Funding:');
      var isTG=e.msg.startsWith('TG:')||e.msg.includes('sent')||e.msg.includes('alert');
      var col=e.level==='ERROR'?'#ef4444':e.level==='WARN'?'#fbbf24':isAction?'#4ade80':isMarket?'#60a5fa':isTG?'#c084fc':'#9ca3af';
      var msg=e.msg.replace('Action: ','').replace('Telegram: ','');
      var ts=e.date&&e.date.slice(0,10)!==today?e.date.slice(5,16):e.time;
      return '<div style="padding:3px 0;border-bottom:1px solid #111827;display:flex;gap:8px;align-items:baseline">'+
        '<span style="font-size:.63rem;color:#6b7280;white-space:nowrap;font-family:monospace;flex-shrink:0">'+ts+'</span>'+
        '<span style="color:'+col+';font-size:.72rem;line-height:1.4;word-break:break-word">'+msg+'</span></div>';
    }).join('');
  }catch(e){console.error(e);}
}

async function doRefresh(){
  try{var r=await fetch('/api/data');var d=await r.json();render(d);loadStatus();}catch(e){console.error(e);}
}

  function deltaIndicator(curr, prev) {
    if (prev == null || curr == null) return '<span style="color:#555">&#8212;</span>';
    var diff = curr - prev;
    if (Math.abs(diff) < 0.50) return '<span style="color:#f59e0b">&#8212;</span>';
    if (diff > 0) return '<span style="color:#22c55e">&#9650; $' + diff.toFixed(2) + '</span>';
    return '<span style="color:#ef4444">&#9660; $' + Math.abs(diff).toFixed(2) + '</span>';
  }
async function doLiveBalances(){
  try{
    var r=await fetch('/api/live-balances');var d=await r.json();
    var prev=liveBal; // snapshot before update
    prevBal=prev;
    liveBal=d;
    renderWallets(d);
    // Helper to update a tile with delta indicator
    function updateTile(elId, deltaElId, curr, prevVal) {
      var el=document.getElementById(elId);
      if(el&&curr!=null) el.textContent=fmt2(curr);
      var del=document.getElementById(deltaElId);
      if(del) del.innerHTML=deltaIndicator(curr, prevVal);
    }
    var ps=prev||{};
    updateTile('ls','ls-delta',d.solana,ps.solana);
    updateTile('lo','lo-delta',d.okx,ps.okx);
    updateTile('lb','lb-delta',d.bybit,ps.bybit);
    if(d.kraken!=null&&d.kraken>0){
      updateTile('lk','lk-delta',d.kraken,ps.kraken);
      document.getElementById('ks').innerHTML='<span class="green">online</span>';
    }
    var cbEnabled=d.coinbaseEnabled||false;
    if(document.getElementById('lcb')){
      updateTile('lcb','lcb-delta',d.coinbase,ps.coinbase);
    }
    if(document.getElementById('cbs')){document.getElementById('cbs').innerHTML=!cbEnabled?'<span class="dim">disabled</span>':d.coinbase!=null?'<span class="green">online</span>':'<span class="yellow">-</span>';}
    var total=(d.solana||0)+(d.okx||0)+(d.bybit||0)+(d.kraken||0)+(d.coinbase||0);
    var prevTotal=ps.solana!=null?(ps.solana||0)+(ps.okx||0)+(ps.bybit||0)+(ps.kraken||0)+(ps.coinbase||0):null;
    document.getElementById('tc').textContent=fmt2(total);
    var tcDelta=document.getElementById('tc-delta');
    if(tcDelta) tcDelta.innerHTML=deltaIndicator(total,prevTotal);
    // OKX warning
    var okxCard=document.getElementById('okx-card');
    if(d.okx!=null&&d.okx<120){okxCard.className='card danger';}
    else{okxCard.className='card';}
    // Alerts
    var alerts=[];
    if(d.okx!=null&&d.okx<120)alerts.push('OKX balance $'+d.okx.toFixed(0)+' is below minimum $120 - bot cannot trade on OKX');
    if(d.bybit!=null&&d.bybit>400)alerts.push('Bybit balance $'+d.bybit.toFixed(0)+' is significantly above target $300 - rebalance recommended');
    var ab=document.getElementById('alerts-box');
    ab.innerHTML=alerts.map(function(a){return '<div class="alert-row"><span style="color:#ef4444">! </span>'+a+'</div>';}).join('');
  }catch(e){console.error(e);}
}

function renderWallets(d){
  document.getElementById('w-sol').textContent=fmt2(d.solana);
  document.getElementById('w-okx').textContent=fmt2(d.okx);
  document.getElementById('w-bybit').textContent=fmt2(d.bybit);
  document.getElementById('w-kraken').textContent=d.kraken!=null?fmt2(d.kraken):'-';
  document.getElementById('w-coinbase').textContent=d.coinbase!=null?fmt2(d.coinbase):d.coinbaseEnabled?'loading...':'-';
  // Tokens
  function renderToks(elId,toks){
    var el=document.getElementById(elId);
    el.innerHTML=(toks||[]).filter(function(t){return t.bal>0.001;}).map(function(t){
      var usdStr=t.usd!=null?'$'+t.usd.toFixed(2):'';
      var balStr=t.bal<1?t.bal.toFixed(4):t.bal.toFixed(2);
      return '<div class="tok"><b>'+t.sym+'</b> '+balStr+(usdStr?' <span>'+usdStr+'</span>':'')+'</div>';
    }).join('');
  }
  renderToks('w-sol-toks',d.solanaTokens);
  renderToks('w-okx-toks',d.okxTokens);
  renderToks('w-bybit-toks',d.bybitTokens);
  // Rebalance table
  var cfg=readConfig||{};
  // Equal-share rebalancing   target is total/5 for each exchange
  var total5=(d.solana||0)+(d.okx||0)+(d.bybit||0)+(d.kraken||0)+(d.coinbase||0);
  var equalShare=Math.round(total5/5);
  var rows=[
    {ex:'Solana',cur:d.solana,tgt:equalShare},
    {ex:'OKX',cur:d.okx,tgt:equalShare},
    {ex:'Bybit',cur:d.bybit,tgt:equalShare},
    {ex:'Kraken',cur:d.kraken,tgt:equalShare},
    {ex:'Coinbase',cur:d.coinbase,tgt:equalShare}
  ];
  document.getElementById('rebal-table').innerHTML=rows.map(function(r){
    if(r.cur==null)return '<tr><td>'+r.ex+'</td><td class="dim">-</td><td>$'+r.tgt+'</td><td class="dim">-</td><td></td></tr>';
    var diff=r.cur-r.tgt;
    var pct=Math.abs(diff)/r.tgt*100;
    var status=pct<5?'<span class="green">OK</span>':diff>0?'<span class="yellow">+$'+Math.abs(diff).toFixed(0)+' excess</span>':'<span class="red">-$'+Math.abs(diff).toFixed(0)+' short</span>';
    var action=pct>=10?(diff>0?'<span class="dim">move out</span>':'<span class="red">top up</span>'):'';
    return '<tr><td><b>'+r.ex+'</b></td><td>$'+r.cur.toFixed(0)+'</td><td>$'+r.tgt+'</td><td>'+status+'</td><td>'+action+'</td></tr>';
  }).join('');
}

var readConfig=null;

async function doRebalance(){
  document.getElementById('rm').style.display='flex';
  document.getElementById('rc').textContent='Fetching balances...';
  document.getElementById('re').disabled=true;
  try{
    var r=await fetch('/api/rebalance-check');var d=await r.json();
    if(d.error){document.getElementById('rc').innerHTML='<span class="red">'+d.error+'</span>';return;}
    var h='<table style="width:100%;border-collapse:collapse;margin-bottom:12px">';
    h+='<tr><td class="dim">Solana</td><td>$'+d.solana.toFixed(0)+'</td><td class="dim">target $'+d.targetSolana+'</td></tr>';
    h+='<tr><td class="dim">OKX</td><td>$'+d.okx.toFixed(0)+'</td><td class="dim">target $'+d.targetOKX+'</td></tr>';
    h+='<tr><td class="dim">Bybit</td><td>$'+d.bybit.toFixed(0)+'</td><td class="dim">target $'+d.targetBybit+'</td></tr>';
    h+='<tr><td class="dim">Kraken</td><td>'+(d.kraken!=null?'$'+d.kraken.toFixed(0):'-')+'</td><td class="dim">target $'+d.targetKraken+'</td></tr>';
    h+='<tr><td class="dim">Coinbase</td><td>'+(d.coinbase!=null?'$'+d.coinbase.toFixed(0):'-')+'</td><td class="dim">target $'+d.targetCoinbase+'</td></tr>';
    h+='</table>';
    if(!d.moves||d.moves.length===0){
      h+='<span class="green">All balances within target range</span>';
      document.getElementById('re').disabled=true;
    } else {
      h+='<b style="color:#eab308">Recommended:</b><br>';
      d.moves.forEach(function(m){h+='&rarr; $'+m.amount+' '+m.from+' &rarr; '+m.to+'<br>';});
      document.getElementById('re').disabled=false;
    }
    document.getElementById('rc').innerHTML=h;
  }catch(e){document.getElementById('rc').innerHTML='<span class="red">'+e.message+'</span>';}
}
function closeR(){document.getElementById('rm').style.display='none';}
async function execRebalance(){
  document.getElementById('re').disabled=true;document.getElementById('re').textContent='Sending...';
  try{await fetch('/api/rebalance-execute',{method:'POST'});document.getElementById('rc').innerHTML='<span class="green">Sent. Check Telegram.</span>';setTimeout(function(){closeR();},1500);}
  catch(e){document.getElementById('rc').innerHTML='<span class="red">'+e.message+'</span>';}
}
async function doResync(){
  if(!confirm('Resync state from trades.json?'))return;
  try{var r=await fetch('/api/resync',{method:'POST'});var d=await r.json();if(d.ok)doRefresh();else alert('Failed: '+d.error);}catch(e){alert(e.message);}
}
async function doRestart(){
  if(!confirm('Restart the bot?'))return;
  try{await fetch('/api/restart',{method:'POST'});}catch(e){}
}
async function doRollback(){
  if(!confirm('Rollback state to pre-deploy backup?'))return;
  try{var r=await fetch('/api/rollback',{method:'POST'});var d=await r.json();if(d.ok)alert('Done: '+d.restored.join(', '));else alert('Failed: '+d.error);}catch(e){alert(e.message);}
}

async function loadStatus(){
  try{
    var r=await fetch('/api/deploy-status');var d=await r.json();
    document.getElementById('bv').textContent=d.version||'-';
    var u=d.uptime;document.getElementById('du').textContent=u?(u<60?u+'s':u<3600?Math.floor(u/60)+'m':Math.floor(u/3600)+'h '+Math.floor((u%3600)/60)+'m'):'-';
    document.getElementById('dt').textContent=d.trades||0;
    var p=d.pnl||0;document.getElementById('dp').innerHTML='<span class="'+(p>=0?'green':'red')+'">'+(p>=0?'+':'')+'$'+p.toFixed(2)+'</span>';
    if(d.hasBackup)document.getElementById('dbk').style.display='';
  }catch(e){}
}

function render(d){
  var st=d.status;
  var ver=st&&st.version||'${VERSION}';
  document.getElementById('vb').textContent=ver;
  // sv removed - agent feed replaces system status
  readConfig=d.config;
  if(st&&st.timestamp){
    var age=Math.round((Date.now()-new Date(st.timestamp).getTime())/1000);
    document.getElementById('la').textContent=age<5?'live':age+'s ago';
    document.getElementById('ld').className='dot '+(age>30?'dr pulse':'dg pulse');
  }
  var active=st&&st.activeTradeCount||0;
  var pill=document.getElementById('sp');
  if(active>0){pill.className='pill pa';pill.textContent=active+' active';}else{pill.className='pill pq';pill.textContent='watching';}
  if(!liveBal){
    var latest=d.latest||{};
    document.getElementById('ls').textContent='$'+(latest.solana||0).toFixed(2);
    document.getElementById('lo').textContent='$'+(latest.okx||0).toFixed(2);
    document.getElementById('lb').textContent='$'+(latest.bybit||0).toFixed(2);
    document.getElementById('tc').textContent='$'+(latest.total||0).toFixed(2);
  }
  var gain=(d.tradingProfit||0);
  var gainPct=d.startCapital?((gain/d.startCapital)*100).toFixed(1):'0';
  document.getElementById('cg').innerHTML='<span class="'+(gain>=0?'green':'red')+'">'+(gain>=0?'+':'')+'$'+gain.toFixed(2)+' ('+gainPct+'%)</span>';
  var okxOk=st&&st.okxHealthy!==false;
  document.getElementById('os').innerHTML=okxOk?'<span class="green">online</span>':'<span class="red">offline</span>';
  // so removed - OKX status shown in top bar
  // Bybit status - assume online if we have a balance
  var bybitOk=liveBal&&liveBal.bybit!=null&&liveBal.bybit>0;
  document.getElementById('bs').innerHTML=bybitOk?'<span class="green">online</span>':'<span class="dim">-</span>';
  // Kraken status
  var krakenEnabled2=d.config&&d.config.KRAKEN_ENABLED;
  var krakenOk=liveBal&&liveBal.kraken!=null&&liveBal.kraken>0;
  document.getElementById('ks').innerHTML=!krakenEnabled2?'<span class="dim">disabled</span>':krakenOk?'<span class="green">online</span>':'<span class="red">offline</span>';
  var wins=d.state&&d.state.consecutiveWins||0,tgt=10;
  var clean=d.state&&d.state.consecutiveClean||0,ctgt=20;
  var wbar='';for(var i=0;i<tgt;i++)wbar+='<div class="wdot '+(i<wins?'wf':'we')+'"></div>';
  document.getElementById('wb').innerHTML=wbar;document.getElementById('wt').textContent=wins+'/'+tgt+' consecutive';
  var cbar='';for(var i=0;i<ctgt;i++)cbar+='<div class="wdot" style="background:'+(i<clean?'#22c55e':'#1e1e30')+'"></div>';
  document.getElementById('cb').innerHTML=cbar;document.getElementById('ct').textContent=clean+'/'+ctgt+' clean';
  var pnl=d.state&&d.state.totalProfit||0;
  document.getElementById('pl').textContent=(pnl>=0?'+':'')+'$'+pnl.toFixed(2);
  document.getElementById('pl').className='val '+(pnl>=0?'green':'red');
  document.getElementById('wr').textContent=d.allWinPct+'%';
  document.getElementById('wr').className='val '+(d.allWinPct>=50?'green':'yellow');
  document.getElementById('wd').textContent=d.allWins+'W / '+(d.allTrades-d.allWins)+'L ('+d.allTrades+' total)';
  document.getElementById('ri').textContent=d.injRatio.toFixed(1)+'%';
  document.getElementById('ri').className='val '+(d.injRatio>=0?'green':'red');
  document.getElementById('rb').style.width=Math.min(100,Math.max(0,d.injRatio))+'%';
  // ss/sz/sc removed - agent feed replaces system status card
  var krakenOn=d.config&&d.config.KRAKEN_ENABLED,krakenSim=d.config&&d.config.KRAKEN_SYNTHETIC;
  // sk removed
  // Kraken mode in system status table
  var krakenOn2=d.config&&d.config.KRAKEN_ENABLED,krakenSim2=d.config&&d.config.KRAKEN_SYNTHETIC;
  // sk element removed - Kraken status in Wallets tab
  // Don't blank Kraken balance on refresh - keep last known value
  var kvr=document.getElementById('kvr');if(krakenOn){kvr.style.display='';document.getElementById('kv').innerHTML='<span class="badge bg">SOL</span><span class="badge bg">PENGU</span>';}else kvr.style.display='none';
  var cvr=document.getElementById('cvr');var cbOn=d.config&&d.config.COINBASE_ENABLED;if(cbOn){cvr.style.display='';document.getElementById('cbv').innerHTML='<span class="badge bg">JTO</span><span class="badge bg">WIF</span><span class="badge bg">BONK</span><span class="badge bg">PENGU</span><span class="badge bg">PNUT</span><span class="badge bg">W</span><span class="badge bg">RENDER</span><span class="badge bg">TRUMP</span><span class="badge bg">PYTH</span><span class="badge bg">SOL</span>';}else cvr.style.display='none';
  var allOKX=['SOL','JTO','WIF','W','PNUT','GOAT','PENGU','PYTH','RAY','JUP','BONK','TRUMP','BOME','RENDER'];
  var allBybit=['SOL','JTO','WIF','W','RENDER','PNUT','PENGU','JUP','BONK','TRUMP','BOME','GOAT'];
  var skipOKX=st&&st.skipOKX||[],skipBybit=st&&st.skipBybit||[];
  document.getElementById('ov').innerHTML=allOKX.map(function(t){return '<span class="badge '+(skipOKX.indexOf(t)<0?'bg':'br')+'">'+t+'</span>';}).join('');
  document.getElementById('byv').innerHTML=allBybit.map(function(t){return '<span class="badge '+(skipBybit.indexOf(t)<0?'bg':'br')+'">'+t+'</span>';}).join('');
  var pend=(st&&st.pendingDex||[]).concat(st&&st.pendingOkx||[]).concat(st&&st.pendingBybit||[]);
  if(pend.length>0){
    document.getElementById('ifsec').style.display='';
    document.getElementById('ifc').textContent=pend.length+' trade(s)';
    document.getElementById('ifl').innerHTML=pend.map(function(t){var el=Math.round((Date.now()-t.startTime)/60000);var pct=Math.min(100,Math.round(el/120*100));return '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #0f0f1a"><span><b class="purple">'+t.symbol+'</b> <span class="dim">'+t.direction+'</span></span><span style="color:#eab308">'+el+'min ('+pct+'%)</span></div>';}).join('');
  }else document.getElementById('ifsec').style.display='none';
  // Spreads
  var lb=document.getElementById('lt');
  if(d.live&&d.live.pairs&&d.live.pairs.length>0){
    lb.innerHTML=d.live.pairs.map(function(p){
      var oc='<span style="color:'+sc(p.spreadOKX,1.0)+'">'+(p.spreadOKX>0?'+':'')+p.spreadOKX.toFixed(2)+'%</span>';
      var bc=p.spreadBybit!=null?'<span style="color:'+sc(p.spreadBybit,1.0)+'">'+(p.spreadBybit>0?'+':'')+p.spreadBybit.toFixed(2)+'%</span>':'<span class="dim">--</span>';
      var dc='<span style="color:'+sc(p.spreadDex,1.0)+'">'+(p.spreadDex>0?'+':'')+p.spreadDex.toFixed(2)+'%</span>';
      var fire=Math.max(p.spreadOKX,p.spreadBybit||0,p.spreadDex)>=1.0?'<span class="badge by">FIRE</span>':'';
      return '<tr><td><b>'+p.name.replace('/USDT','')+'</b></td><td class="dim">'+(p.okxBid?'$'+p.okxBid:'--')+'</td><td class="dim">'+(p.bybitBid?'$'+p.bybitBid:'--')+'</td><td style="text-align:right">'+oc+'</td><td style="text-align:right">'+bc+'</td><td style="text-align:right">'+dc+'</td><td>'+fire+'</td></tr>';
    }).join('');
  }else lb.innerHTML='<tr><td colspan="7" class="dim" style="padding:12px;text-align:center">Waiting for price feeds...</td></tr>';
  // Fires
  document.getElementById('ft').innerHTML=d.recentFires.map(function(f){
    var time=new Date(f.date).toLocaleString('en-GB',{month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'});
    var oc=f.outcome==='success'?'<span class="badge bg">WIN</span>':f.outcome==='loss'?'<span class="badge br">LOSS</span>':f.outcome==='fired'?'<span class="badge by">FIRED</span>':'<span class="badge br">FAIL</span>';
    return '<tr><td class="dim" style="white-space:nowrap">'+time+'</td><td>'+(f.pair||'').replace('/USDT','')+'</td><td><span class="badge bn">'+(f.direction||'').replace('BUY_','')+'</span></td><td class="dim">'+(f.spreadPct?f.spreadPct.toFixed(2)+'%':'--')+'</td><td>'+oc+'</td><td class="dim" style="font-size:.65rem">'+(f.reason||'').slice(0,40)+'</td></tr>';
  }).join('');
  // Trades tab
  document.getElementById('t-total').textContent=d.allTrades;
  document.getElementById('t-wins').textContent=d.allWinPct+'%';
  document.getElementById('t-pnl').textContent=(d.tradingProfit>=0?'+':'')+'$'+d.tradingProfit.toFixed(2);
  document.getElementById('t-pnl').className='val '+(d.tradingProfit>=0?'green':'red');
  document.getElementById('tt').innerHTML=d.recentTrades.map(function(t){
    var profit=t.profit||0;
    var date=new Date(t.date).toLocaleString('en-GB',{month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'});
    return '<tr><td class="dim" style="white-space:nowrap">'+date+'</td><td>'+(t.pair||'').replace('/USDT','')+'</td><td><span class="badge bn">'+(t.direction||'').replace('BUY_','')+'</span></td><td>'+(t.spreadPct||0).toFixed(2)+'%</td><td class="dim">'+(t.durationMin||0)+'min</td><td class="'+(profit>=0?'green':'red')+'">'+(profit>=0?'+':'')+'$'+profit.toFixed(2)+'</td></tr>';
  }).join('');
  document.getElementById('pt').innerHTML=Object.entries(d.pairStats).sort(function(a,b){return b[1].fires-a[1].fires;}).map(function(e){
    var p=e[0],s=e[1],wr=s.fires?Math.round(s.wins/s.fires*100):0;
    return '<tr><td>'+p.replace('/USDT','')+'</td><td>'+s.fires+'</td><td class="'+(wr>=50?'green':wr>0?'yellow':'red')+'">'+wr+'%</td><td class="dim">-</td><td class="'+(s.pnl>=0?'green':'red')+'">'+(s.pnl>=0?'+':'')+'$'+s.pnl.toFixed(2)+'</td></tr>';
  }).join('');
  // Agent feed
  loadAgentFeed();

  // Chart
  var labels=d.balHistory.map(function(b){return b.time.slice(5,16);});
  var totals=d.balHistory.map(function(b){return b.total;});
  var chEl=document.getElementById('ch');
  if(chEl){
    var ctx=chEl.getContext('2d');
    if(chart)chart.destroy();
    if(typeof Chart!=='undefined'){chart=new Chart(ctx,{type:'line',data:{labels:labels,datasets:[{label:'Total',data:totals,borderColor:'#7c3aed',backgroundColor:'rgba(124,58,237,0.1)',borderWidth:2,pointRadius:1,fill:true,tension:0.3}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#333',maxTicksLimit:5,font:{size:9}},grid:{color:'#0f0f1a'}},y:{ticks:{color:'#555',font:{size:9},callback:function(v){return'$'+v.toFixed(0);}},grid:{color:'#0f0f1a'}}}}});}
  }
}

doRefresh();
doLiveBalances();
setInterval(doRefresh,3000);
setInterval(loadStatus,30000);
setInterval(doLiveBalances,60000);
setInterval(loadAgentFeed,10000);
</script>
</body>
</html>`;
}

const server = http.createServer(async function(req,res) {
  const url=req.url.split('?')[0];
  res.setHeader('Access-Control-Allow-Origin','*');

  if(url==='/api/data'){
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(getData()));

  }else if(url==='/api/live-balances'){
    res.writeHead(200,{'Content-Type':'application/json'});
    try{
      const config=readJSON(CONFIG_FILE)||{};
      const krakenEnabled=config.KRAKEN_ENABLED||false;
      const coinbaseEnabled=config.COINBASE_ENABLED||false;
      const [sol,okxData,bybitData]=await Promise.all([fetchSolana(),fetchOKX(),fetchBybit()]);
      let kraken=null,coinbase=null;
      if(krakenEnabled){
        try{kraken=await fetchKraken();}catch{kraken=0;}
      }
      if(coinbaseEnabled){
        try{coinbase=await fetchCoinbase();}catch{coinbase=0;}
      }
      res.end(JSON.stringify({
        solana:sol.usdc,solanaTokens:sol.tokens,
        okx:okxData.usdt,okxTokens:okxData.tokens,
        bybit:bybitData.usdt,bybitTokens:bybitData.tokens,
        kraken,krakenEnabled,
        coinbase,coinbaseEnabled,
        fetchedAt:new Date().toISOString()
      }));
    }catch(e){res.end(JSON.stringify({error:e.message}));}

  }else if(url==='/api/deploy-status'){
    res.writeHead(200,{'Content-Type':'application/json'});
    const st=readJSON(STATUS_FILE)||{};
    const s2=readJSON(STATE_FILE)||{};
    const hasBackup=fs.existsSync(path.join(__dirname,'arb-state.json.deploy-bak'));
    res.end(JSON.stringify({version:st.version||'unknown',timestamp:st.timestamp,uptime:st.timestamp?Math.round((Date.now()-new Date(st.timestamp).getTime())/1000):null,hasBackup,trades:s2.totalTrades||0,pnl:s2.totalProfit||0}));

  }else if(url==='/api/resync'&&req.method==='POST'){
    res.writeHead(200,{'Content-Type':'application/json'});
    try{
      const s3=readJSON(STATE_FILE)||{};
      const t3=readJSON(TRADES_FILE)||[];
      const real=t3.filter(t=>t.direction!=='RECOVERY');
      const wins=real.filter(t=>t.profit>0).length;
      const pnl=real.reduce((a,t)=>a+(t.profit||0),0);
      let c=0;for(let i=real.length-1;i>=0;i--){if(real[i].profit>0)c++;else break;}
      const corrected={...s3,totalTrades:real.length,winningTrades:wins,totalProfit:pnl,consecutiveWins:c,lastResync:new Date().toISOString()};
      fs.writeFileSync(STATE_FILE,JSON.stringify(corrected,null,2));
      await sendTG('Resynced from dashboard. Trades:'+real.length+' Wins:'+wins+' P&L:'+(pnl>=0?'+':'')+'$'+pnl.toFixed(2));
      res.end(JSON.stringify({ok:true,trades:real.length,wins,pnl,consec:c}));
    }catch(e){res.end(JSON.stringify({ok:false,error:e.message}));}

  }else if(url==='/api/restart'&&req.method==='POST'){
    res.writeHead(200,{'Content-Type':'application/json'});
    await sendTG('Bot restart triggered from dashboard');
    res.end(JSON.stringify({ok:true}));

  }else if(url==='/api/rollback'&&req.method==='POST'){
    res.writeHead(200,{'Content-Type':'application/json'});
    try{
      const restored=[];
      const bak=path.join(__dirname,'arb-state.json.deploy-bak');
      const bakT=path.join(__dirname,'trades.json.deploy-bak');
      if(fs.existsSync(bak)){fs.copyFileSync(bak,STATE_FILE);restored.push('arb-state.json');}
      if(fs.existsSync(bakT)){fs.copyFileSync(bakT,TRADES_FILE);restored.push('trades.json');}
      await sendTG('Rollback from dashboard. Restored: '+restored.join(', '));
      res.end(JSON.stringify({ok:true,restored}));
    }catch(e){res.end(JSON.stringify({ok:false,error:e.message}));}

  }else if(url==='/api/rebalance-check'){
    res.writeHead(200,{'Content-Type':'application/json'});
    try{
      const cfg=readJSON(CONFIG_FILE)||{};
      const tSol=cfg.REBALANCE_TARGET_SOLANA||200,tOKX=cfg.REBALANCE_TARGET_OKX||350,tBybit=cfg.REBALANCE_TARGET_BYBIT||300;
      const tKraken=cfg.REBALANCE_TARGET_KRAKEN||300,tCoinbase=cfg.REBALANCE_TARGET_COINBASE||200;
      const [sol,okxData,bybitData]=await Promise.all([fetchSolana(),fetchOKX(),fetchBybit()]);
      const lb=readJSON(path.join(__dirname,'bot-status.json'))?.liveBalances||{};
      const solana=sol.usdc||0,okx=okxData.usdt||0,bybit=bybitData.usdt||0;
      const kraken=lb.kraken||0,coinbase=lb.coinbase||0;
      const buf=0.05;
      const solEx=Math.max(0,solana-tSol*(1+buf)),okxEx=Math.max(0,okx-tOKX*(1+buf)),bybitEx=Math.max(0,bybit-tBybit*(1+buf));
      const solSh=Math.max(0,tSol-solana),okxSh=Math.max(0,tOKX-okx),bybitSh=Math.max(0,tBybit-bybit);
      const krakenSh=Math.max(0,tKraken-kraken),krakenEx=Math.max(0,kraken-tKraken*(1+buf));
      const coinbaseSh=Math.max(0,tCoinbase-coinbase),coinbaseEx=Math.max(0,coinbase-tCoinbase*(1+buf));
      const moves=[];
      if(bybitEx>20&&okxSh>20)moves.push({from:'Bybit',to:'OKX',amount:Math.round(Math.min(bybitEx,okxSh))});
      if(bybitEx>20&&solSh>20)moves.push({from:'Bybit',to:'Solana',amount:Math.round(Math.min(bybitEx,solSh))});
      if(okxEx>20&&bybitSh>20)moves.push({from:'OKX',to:'Bybit',amount:Math.round(Math.min(okxEx,bybitSh))});
      if(okxEx>20&&solSh>20)moves.push({from:'OKX',to:'Solana',amount:Math.round(Math.min(okxEx,solSh))});
      if(solEx>20&&okxSh>20)moves.push({from:'Solana',to:'OKX',amount:Math.round(Math.min(solEx,okxSh))});
      if(solEx>20&&bybitSh>20)moves.push({from:'Solana',to:'Bybit',amount:Math.round(Math.min(solEx,bybitSh))});
      if(okxEx>20&&krakenSh>20)moves.push({from:'OKX',to:'Kraken',amount:Math.round(Math.min(okxEx,krakenSh)),note:'via ERC-20'});
      if(krakenEx>20)moves.push({from:'Kraken',to:'Solana',amount:Math.round(krakenEx),note:'USDT withdrawal'});
      if(coinbaseEx>20)moves.push({from:'Coinbase',to:'Solana',amount:Math.round(coinbaseEx),note:'USDC withdrawal'});
      if(coinbaseSh>20)moves.push({from:'Manual',to:'Coinbase',amount:Math.round(coinbaseSh),note:'Manual deposit required'});
      res.end(JSON.stringify({solana,okx,bybit,kraken,coinbase,targetSolana:tSol,targetOKX:tOKX,targetBybit:tBybit,targetKraken:tKraken,targetCoinbase:tCoinbase,moves,needed:moves.length>0}));
    }catch(e){res.end(JSON.stringify({error:e.message}));}

  }else if(url==='/api/rebalance-execute'&&req.method==='POST'){
    res.writeHead(200,{'Content-Type':'application/json'});
    await sendTG('/rb confirm');
    res.end(JSON.stringify({ok:true}));

  }else if(url==='/api/agent-feed'){
    res.writeHead(200,{'Content-Type':'application/json'});
    try{
      const agentState=readJSON(path.join(__dirname,'agent-state.json'))||{};
      const agentLog=require('fs').existsSync(path.join(__dirname,'agent.log'))
        ?require('fs').readFileSync(path.join(__dirname,'agent.log'),'utf8').split('\n').filter(Boolean).slice(-30)
        :[];
      // Parse log lines into structured entries
      const entries=agentLog.map(function(line){
        const m=line.match(/\[(\d{4}-\d{2}-\d{2}T[\d:]+)\] \[(\w+)\] (.+)/);
        if(!m)return null;
        return {time:m[1].slice(11,16),date:m[1],level:m[2],msg:m[3]};
      }).filter(Boolean).reverse().slice(0,20);
      res.end(JSON.stringify({
        entries,
        lastRun:agentState.lastRun,
        actionsToday:agentState.actionsToday||0,
        paused:agentState.paused||false,
        version:'v1.1'
      }));
    }catch(e){res.end(JSON.stringify({entries:[],error:e.message}));}

  }else{
    res.writeHead(200,{'Content-Type':'text/html'});
    res.end(buildHTML());
  }
});

server.on('error',function(err){
  if(err.code==='EADDRINUSE'){console.error('Port '+PORT+' in use. Kill: taskkill //F //IM node.exe //T');process.exit(1);}
  else throw err;
});

server.listen(PORT,'0.0.0.0',function(){
  console.log('Dashboard '+VERSION+' running at http://localhost:'+PORT);
});
