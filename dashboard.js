require('dotenv').config();
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT        = 3001;
const VERSION     = 'v5.0';
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
    const ts = new Date().toISOString();
    const sig = crypto.createHmac('sha256',process.env.OKX_API_SECRET).update(ts+'GET'+'/api/v5/account/balance').digest('base64');
    const r = await fetch('https://www.okx.com/api/v5/account/balance',{headers:{'OK-ACCESS-KEY':process.env.OKX_API_KEY,'OK-ACCESS-SIGN':sig,'OK-ACCESS-TIMESTAMP':ts,'OK-ACCESS-PASSPHRASE':process.env.OKX_PASSPHRASE}});
    const j = await r.json();
    return parseFloat(j.data?.[0]?.details?.find(d=>d.ccy==='USDT')?.availBal||'0');
  } catch { return null; }
}

async function fetchBybit() {
  try {
    const ts=''+Date.now(),rw='5000',qs='accountType=UNIFIED&coin=USDT';
    const sig=crypto.createHmac('sha256',process.env.BYBIT_API_SECRET).update(ts+process.env.BYBIT_API_KEY+rw+qs).digest('hex');
    const r=await fetch('https://api.bybit.com/v5/account/wallet-balance?'+qs,{headers:{'X-BAPI-API-KEY':process.env.BYBIT_API_KEY,'X-BAPI-TIMESTAMP':ts,'X-BAPI-SIGN':sig,'X-BAPI-RECV-WINDOW':rw}});
    const j=await r.json();
    const coin=j.result?.list?.[0]?.coin?.find(c=>c.coin==='USDT');
    return Math.max(parseFloat(coin?.equity||'0'),parseFloat(coin?.walletBalance||'0')*0.95);
  } catch { return null; }
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
    return parseFloat((Number(acc.amount)/1e6).toFixed(2));
  } catch { return null; }
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
  const recentTrades=trades.slice(-10).reverse();
  const recentFires=fires.slice(-20).reverse();
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
body{font-family:monospace;background:#08080f;color:#e0e0e0;padding:12px;font-size:13px}
.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:10px}
.g5{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:10px}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
.card{background:#11111c;border:1px solid #1e1e30;border-radius:8px;padding:12px}
.val{font-size:1.3rem;font-weight:700;color:#7c3aed}
.lbl{font-size:.68rem;color:#555;margin-top:2px}
.sub{font-size:.72rem;color:#888;margin-top:4px}
.green{color:#22c55e}.red{color:#ef4444}.yellow{color:#eab308}.purple{color:#a78bfa}.dim{color:#444}
.badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:.65rem;font-weight:700;margin-right:3px}
.bg{background:#14532d;color:#22c55e}.br{background:#450a0a;color:#ef4444}
.by{background:#422006;color:#eab308}.bp{background:#2e1065;color:#a78bfa}.bn{background:#1e1e30;color:#666}
.wdot{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:2px}
.wf{background:#22c55e}.we{background:#2a2a3f}
.hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px}
.ver{background:#1e1e30;color:#a78bfa;border:1px solid #4c1d95;border-radius:4px;padding:2px 8px;font-size:.72rem;font-weight:bold}
.pill{border-radius:4px;padding:2px 8px;font-size:.72rem;font-weight:bold}
.pa{background:#14532d;color:#22c55e}.pq{background:#1e1e30;color:#666}
.btn{background:#1e1e30;border:1px solid #4c1d95;color:#a78bfa;border-radius:5px;padding:5px 12px;font-size:.72rem;cursor:pointer}
.btn:hover{background:#2e1065;color:#fff}
.btn:disabled{opacity:.4;cursor:not-allowed}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px}
.dg{background:#22c55e}.dr{background:#ef4444}
.pulse{animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.prog{height:6px;background:#1e1e30;border-radius:3px;overflow:hidden;margin-top:4px}
.pf{height:100%;border-radius:3px}
.sec{color:#a78bfa;font-size:.68rem;text-transform:uppercase;letter-spacing:.08em;margin:12px 0 6px;border-bottom:1px solid #1e1e30;padding-bottom:3px}
table{width:100%;border-collapse:collapse;font-size:.72rem}
th{padding:4px 6px;color:#444;border-bottom:1px solid #1e1e30;text-align:left;font-weight:normal}
td{padding:4px 6px;border-bottom:1px solid #0f0f1a}
tr:hover td{background:#14141f}
.modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.8);z-index:1000;align-items:center;justify-content:center}
.mbox{background:#11111c;border:1px solid #eab308;border-radius:10px;padding:24px;max-width:400px;width:90%}
</style>
</head>
<body>
<div class="hdr">
  <div style="display:flex;align-items:center;gap:12px">
    <span class="ver" id="vb">${VERSION}</span>
    <span class="pill" id="sp">loading...</span>
    <span style="font-size:.68rem;color:#444"><span class="dot dg pulse" id="ld"></span><span id="la">-</span></span>
  </div>
  <div style="display:flex;gap:6px;flex-wrap:wrap">
    <button class="btn" onclick="doBalances()">Refresh</button>
    <button class="btn" style="border-color:#eab308;color:#eab308" onclick="doRebalance()">Rebalance</button>
    <button class="btn" style="border-color:#22c55e;color:#22c55e" onclick="doResync()">Resync</button>
    <button class="btn" style="border-color:#ef4444;color:#ef4444" onclick="doRestart()">Restart</button>
  </div>
</div>

<div style="background:#0f0f1a;border:1px solid #1e1e30;border-radius:6px;padding:8px 12px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;font-size:.72rem">
  <span>
    <span style="color:#555">Version: </span><span id="dv" style="color:#a78bfa;font-weight:bold">-</span>
    <span style="color:#555;margin-left:12px">Uptime: </span><span id="du" style="color:#888">-</span>
    <span style="color:#555;margin-left:12px">Trades: </span><span id="dt" style="color:#888">-</span>
    <span style="color:#555;margin-left:12px">P&L: </span><span id="dp" style="color:#888">-</span>
  </span>
  <span id="dbk" style="display:none">
    <button class="btn" style="border-color:#666;color:#666;font-size:.65rem" onclick="doRollback()">Rollback</button>
  </span>
</div>

<div class="g5">
  <div class="card"><div class="val" id="tc">-</div><div class="lbl">Total Capital</div><div class="sub" id="cg">-</div></div>
  <div class="card"><div class="val" id="ls">-</div><div class="lbl">Solana USDC</div></div>
  <div class="card"><div class="val" id="lo">-</div><div class="lbl">OKX USDT</div><div class="sub" id="os">-</div></div>
  <div class="card"><div class="val" id="lb">-</div><div class="lbl">Bybit USDT</div></div>
  <div class="card" id="kc" style="display:none"><div class="val" id="lk">-</div><div class="lbl">Kraken <span class="badge bp" style="font-size:.6rem" id="kb">SIM</span></div></div>
</div>

<div class="g5">
  <div class="card"><div class="lbl" style="margin-bottom:5px">Consecutive Wins</div><div id="wb" style="display:flex;gap:2px"></div><div class="sub" id="wt">-</div></div>
  <div class="card"><div class="lbl" style="margin-bottom:5px">Consecutive Clean</div><div id="cb" style="display:flex;gap:2px"></div><div class="sub" id="ct">-</div></div>
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
    <div class="sec" style="margin-top:0">System Status</div>
    <table>
      <tr><td class="dim">Version</td><td id="sv">-</td></tr>
      <tr><td class="dim">OKX</td><td id="so">-</td></tr>
      <tr><td class="dim">Kraken</td><td id="sk">-</td></tr>
      <tr><td class="dim">Smart sell</td><td id="ss">-</td></tr>
      <tr><td class="dim">Volatile</td><td id="sv2">-</td></tr>
      <tr><td class="dim">Next clean</td><td id="sc">-</td></tr>
      <tr><td class="dim">Trade size</td><td id="sz">-</td></tr>
    </table>
  </div>
  <div class="card">
    <div class="sec" style="margin-top:0">Pair Viability</div>
    <div style="margin-bottom:6px"><span class="dim">OKX: </span><span id="ov"></span></div>
    <div style="margin-bottom:6px"><span class="dim">Bybit: </span><span id="bv"></span></div>
    <div id="kvr" style="display:none;margin-top:6px"><span class="dim">Kraken: </span><span id="kv"></span></div>
  </div>
</div>

<div class="sec">Live Spreads</div>
<div class="card" style="margin-bottom:10px">
  <table><thead><tr><th>Pair</th><th>OKX bid</th><th>Bybit bid</th><th style="text-align:right">OKX%</th><th style="text-align:right">Bybit%</th><th style="text-align:right">DEX%</th><th>Status</th></tr></thead>
  <tbody id="lt"></tbody></table>
</div>

<div class="sec">Solana Wallet</div>
<div class="card" style="margin-bottom:10px"><div id="tk" style="color:#444;font-size:.72rem">Loading...</div></div>

<div class="g2">
  <div class="card"><div class="sec" style="margin-top:0">Capital 7d</div><canvas id="ch" height="100"></canvas></div>
  <div class="card"><div class="sec" style="margin-top:0">Recent Fires</div>
    <table><thead><tr><th>Time</th><th>Pair</th><th>Dir</th><th>Result</th></tr></thead><tbody id="ft"></tbody></table>
  </div>
</div>

<div class="g2">
  <div class="card"><div class="sec" style="margin-top:0">Recent Trades</div>
    <table><thead><tr><th>Time</th><th>Pair</th><th>Dir</th><th>Spread</th><th>P&L</th></tr></thead><tbody id="tt"></tbody></table>
  </div>
  <div class="card"><div class="sec" style="margin-top:0">Pair Stats</div>
    <table><thead><tr><th>Pair</th><th>Fires</th><th>Win%</th><th>P&L</th></tr></thead><tbody id="pt"></tbody></table>
  </div>
</div>

<div id="rm" class="modal">
  <div class="mbox">
    <h3 style="color:#eab308;margin-bottom:16px">Rebalance Capital</h3>
    <div id="rc" style="color:#e0e0e0;font-size:.8rem;margin-bottom:16px">Loading...</div>
    <div style="display:flex;gap:8px">
      <button onclick="execRebalance()" id="re" class="btn" style="border-color:#22c55e;color:#22c55e;flex:1">Execute</button>
      <button onclick="closeR()" class="btn" style="flex:1">Cancel</button>
    </div>
  </div>
</div>

<script>
var chart=null,tokCache=null,tokTime=0,liveBal=null;
function sc(v,t){var p=v/t;if(p>=1)return'#eab308';if(p>=.8)return'#f97316';if(p>=.5)return'#a78bfa';if(v>0)return'#22c55e';return'#ef4444';}
function countdown(ms){var s=Math.round((ms-Date.now())/1000);if(s<=0)return'now';if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m';return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';}
async function doBalances(){
  var btn=document.querySelector('[onclick="doBalances()"]');btn.disabled=true;btn.textContent='Loading...';
  try{var r=await fetch('/api/live-balances');var d=await r.json();liveBal=d;renderBal(d);}catch(e){}
  btn.textContent='Refresh';btn.disabled=false;
}
function renderBal(d){
  if(!d)return;
  var k=d.krakenEnabled&&d.kraken?d.kraken:0;
  var total=(d.solana||0)+(d.okx||0)+(d.bybit||0)+k;
  document.getElementById('ls').textContent=d.solana!=null?'$'+d.solana.toFixed(2):'?';
  document.getElementById('lo').textContent=d.okx!=null?'$'+d.okx.toFixed(2):'?';
  document.getElementById('lb').textContent=d.bybit!=null?'$'+d.bybit.toFixed(2):'?';
  document.getElementById('tc').textContent='$'+total.toFixed(2);
  if(d.krakenEnabled){document.getElementById('kc').style.display='';document.getElementById('lk').textContent=d.kraken!=null?'$'+d.kraken.toFixed(2):'?';}
}
async function doRebalance(){
  document.getElementById('rm').style.display='flex';
  document.getElementById('rc').textContent='Fetching...';
  document.getElementById('re').disabled=true;
  try{
    var r=await fetch('/api/rebalance-check');var d=await r.json();
    if(d.error){document.getElementById('rc').innerHTML='<span class="red">'+d.error+'</span>';return;}
    var h='<table style="width:100%;border-collapse:collapse">';
    h+='<tr><td class="dim">Solana</td><td>$'+d.solana.toFixed(0)+'</td><td class="dim">target $'+d.targetSolana+'</td></tr>';
    h+='<tr><td class="dim">OKX</td><td>$'+d.okx.toFixed(0)+'</td><td class="dim">target $'+d.targetOKX+'</td></tr>';
    h+='<tr><td class="dim">Bybit</td><td>$'+d.bybit.toFixed(0)+'</td><td class="dim">target $'+d.targetBybit+'</td></tr>';
    h+='</table><hr style="border-color:#1e1e30;margin:12px 0">';
    if(!d.needed){h+='<span class="green">Balances OK</span>';document.getElementById('re').disabled=true;}
    else{h+='<b style="color:#eab308">Recommended:</b><br>';if(d.toOKX>5)h+='Move $'+d.toOKX+' to OKX<br>';if(d.toBybit>5)h+='Move $'+d.toBybit+' to Bybit<br>';document.getElementById('re').disabled=false;}
    document.getElementById('rc').innerHTML=h;
  }catch(e){document.getElementById('rc').innerHTML='<span class="red">'+e.message+'</span>';}
}
function closeR(){document.getElementById('rm').style.display='none';}
async function execRebalance(){
  document.getElementById('re').disabled=true;document.getElementById('re').textContent='Sending...';
  try{await fetch('/api/rebalance-execute',{method:'POST'});document.getElementById('rc').innerHTML='<span class="green">Sent. Check Telegram.</span>';}
  catch(e){document.getElementById('rc').innerHTML='<span class="red">'+e.message+'</span>';}
}
async function doResync(){
  if(!confirm('Resync state from trades.json?'))return;
  try{var r=await fetch('/api/resync',{method:'POST'});var d=await r.json();if(d.ok)refresh();else alert('Failed: '+d.error);}catch(e){alert(e.message);}
}
async function doRestart(){
  if(!confirm('Restart the bot?'))return;
  try{await fetch('/api/restart',{method:'POST'});}catch(e){}
}
async function doRollback(){
  if(!confirm('Rollback state to pre-deploy backup?'))return;
  try{var r=await fetch('/api/rollback',{method:'POST'});var d=await r.json();if(d.ok)alert('Done: '+d.restored.join(', '));else alert('Failed: '+d.error);}catch(e){alert(e.message);}
}
async function loadToks(){
  if(Date.now()-tokTime<15000&&tokCache)return tokCache;
  try{var r=await fetch('/api/tokens');tokCache=await r.json();tokTime=Date.now();}catch(e){tokCache=null;}
  return tokCache;
}
async function loadStatus(){
  try{
    var r=await fetch('/api/deploy-status');var d=await r.json();
    document.getElementById('dv').textContent=d.version||'-';
    var u=d.uptime;document.getElementById('du').textContent=u?(u<60?u+'s':u<3600?Math.floor(u/60)+'m':Math.floor(u/3600)+'h '+Math.floor((u%3600)/60)+'m'):'-';
    document.getElementById('dt').textContent=d.trades||0;
    var p=d.pnl||0;document.getElementById('dp').innerHTML='<span class="'+(p>=0?'green':'red')+'">'+(p>=0?'+':'')+'$'+p.toFixed(2)+'</span>';
    if(d.hasBackup)document.getElementById('dbk').style.display='';
  }catch(e){}
}
async function refresh(){
  try{
    var td=await loadToks();
    var r=await fetch('/api/data');var d=await r.json();
    render(d);renderToks(td);loadStatus();
    if(liveBal)renderBal(liveBal);
  }catch(e){console.error(e);}
}
function renderToks(data){
  var el=document.getElementById('tk');
  if(!data||data.error){el.innerHTML='<span class="dim">'+(data&&data.error||'Unable to fetch')+'</span>';return;}
  var SYMS={'So11111111111111111111111111111111111111112':'SOL','EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v':'USDC','Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB':'USDT','jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL':'JTO','EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm':'WIF','2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump':'PNUT','CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump':'GOAT','2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv':'PENGU'};
  var rows=[];
  for(var mint in data.toks){var sym=SYMS[mint]||mint.slice(0,6);var bal=data.toks[mint];var price=parseFloat(data.prices&&data.prices[mint]&&data.prices[mint].price||0);rows.push({sym,bal,usd:bal*price});}
  rows.sort(function(a,b){return b.usd-a.usd;});
  el.innerHTML=rows.map(function(r){return '<span style="display:inline-block;min-width:100px;margin:3px 6px 3px 0"><b class="purple">'+r.sym+'</b><br>'+(r.bal<1?r.bal.toFixed(4):r.bal.toFixed(2))+' <span class="green">'+(r.usd>0?'$'+r.usd.toFixed(2):'-')+'</span></span>';}).join('');
}
function render(d){
  var st=d.status;
  var ver=st&&st.version||'v5.0';
  document.getElementById('vb').textContent=ver;
  document.getElementById('sv').textContent=ver;
  if(st&&st.timestamp){var age=Math.round((Date.now()-new Date(st.timestamp).getTime())/1000);document.getElementById('la').textContent=age<5?'live':age+'s ago';document.getElementById('ld').className='dot '+(age>30?'dr pulse':'dg pulse');}
  var active=st&&st.activeTradeCount||0;
  var pill=document.getElementById('sp');
  if(active>0){pill.className='pill pa';pill.textContent=active+' active';}else{pill.className='pill pq';pill.textContent='watching';}
  var latest=d.latest||{},total=latest.total||0,gain=total-(d.startCapital||total);
  var gainPct=d.startCapital?((gain/d.startCapital)*100).toFixed(1):'0';
  if(!liveBal){document.getElementById('tc').textContent='$'+total.toFixed(2);document.getElementById('ls').textContent='$'+(latest.solana||0).toFixed(2);document.getElementById('lo').textContent='$'+(latest.okx||0).toFixed(2);document.getElementById('lb').textContent='$'+(latest.bybit||0).toFixed(2);}
  document.getElementById('cg').innerHTML='<span class="'+(gain>=0?'green':'red')+'">'+(gain>=0?'+':'')+'$'+gain.toFixed(2)+' ('+gainPct+'%)</span>';
  var okxOk=st&&st.okxHealthy!==false;
  document.getElementById('os').innerHTML=okxOk?'<span class="green">online</span>':'<span class="red">offline</span>';
  document.getElementById('so').innerHTML=okxOk?'<span class="green">online</span>':'<span class="red">offline</span>';
  var wins=d.state&&d.state.consecutiveWins||0,tgt=10,clean=d.state&&d.state.consecutiveClean||0;
  var wbar='';for(var i=0;i<tgt;i++)wbar+='<div class="wdot '+(i<wins?'wf':'we')+'"></div>';
  document.getElementById('wb').innerHTML=wbar;document.getElementById('wt').textContent=wins+'/'+tgt+' wins';
  var ctgt=20;
  var cbar='';for(var i=0;i<ctgt;i++)cbar+='<div class="wdot" style="background:'+(i<clean?'#22c55e':'#1e1e30')+'"></div>';
  document.getElementById('cb').innerHTML=cbar;document.getElementById('ct').textContent=clean+'/'+ctgt+' clean';
  var pnl=d.state&&d.state.totalProfit||0;
  document.getElementById('pl').textContent=(pnl>=0?'+':'')+'$'+pnl.toFixed(2);document.getElementById('pl').className='val '+(pnl>=0?'green':'red');
  document.getElementById('wr').textContent=d.allWinPct+'%';document.getElementById('wr').className='val '+(d.allWinPct>=50?'green':'yellow');
  document.getElementById('wd').textContent=d.allWins+'W / '+(d.allTrades-d.allWins)+'L';
  document.getElementById('ri').textContent=d.injRatio.toFixed(1)+'%';document.getElementById('ri').className='val '+(d.injRatio>=0?'green':'red');
  document.getElementById('rb').style.width=Math.min(100,Math.max(0,d.injRatio))+'%';
  document.getElementById('ss').textContent=st&&st.smartSell?'ON':'OFF';
  document.getElementById('sv2').textContent=st&&st.volatileMode?'ON':'OFF';
  document.getElementById('sz').textContent='$'+(d.config&&d.config.TRADE_SIZE_USD||120);
  if(st&&st.nextRebalanceCheck)document.getElementById('sc').textContent=countdown(st.nextRebalanceCheck);
  var krakenOn=d.config&&d.config.KRAKEN_ENABLED,krakenSim=d.config&&d.config.KRAKEN_SYNTHETIC;
  document.getElementById('sk').innerHTML=!krakenOn?'<span class="dim">disabled</span>':krakenSim?'<span class="purple">SIM</span>':'<span class="green">LIVE</span>';
  var kb=document.getElementById('kb');
  if(kb){kb.textContent=krakenSim?'SIM':'LIVE';kb.className=krakenSim?'badge bp':'badge bg';}
  var kvr=document.getElementById('kvr');if(krakenOn){kvr.style.display='';document.getElementById('kv').innerHTML='<span class="badge bg">SOL</span><span class="badge bg">PENGU</span>';}else kvr.style.display='none';
  var allOKX=['SOL','JTO','WIF','W','MEW','PNUT','GOAT','PENGU','PYTH','RAY'],allBybit=['SOL','JTO','WIF','W','RENDER','PNUT','PENGU'];
  var skipOKX=st&&st.skipOKX||[],skipBybit=st&&st.skipBybit||[];
  document.getElementById('ov').innerHTML=allOKX.map(function(t){return '<span class="badge '+(skipOKX.indexOf(t)<0?'bg':'br')+'">'+t+'</span>';}).join('');
  document.getElementById('bv').innerHTML=allBybit.map(function(t){return '<span class="badge '+(skipBybit.indexOf(t)<0?'bg':'br')+'">'+t+'</span>';}).join('');
  var pend=(st&&st.pendingDex||[]).concat(st&&st.pendingOkx||[]).concat(st&&st.pendingBybit||[]);
  if(pend.length>0){document.getElementById('ifsec').style.display='';document.getElementById('ifc').textContent=pend.length+' trade(s)';document.getElementById('ifl').innerHTML=pend.map(function(t){var el=Math.round((Date.now()-t.startTime)/60000);return '<div style="display:flex;justify-content:space-between;padding:6px 0"><span><b class="purple">'+t.symbol+'</b></span><span style="color:#eab308">'+el+'min</span></div>';}).join('');}
  else document.getElementById('ifsec').style.display='none';
  var lb=document.getElementById('lt');
  if(d.live&&d.live.pairs&&d.live.pairs.length>0){
    lb.innerHTML=d.live.pairs.map(function(p){
      var oc='<span style="color:'+sc(p.spreadOKX,1.0)+'">'+(p.spreadOKX>0?'+':'')+p.spreadOKX.toFixed(2)+'%</span>';
      var bc=p.spreadBybit!=null?'<span style="color:'+sc(p.spreadBybit,1.0)+'">'+(p.spreadBybit>0?'+':'')+p.spreadBybit.toFixed(2)+'%</span>':'<span class="dim">--</span>';
      var dc='<span style="color:'+sc(p.spreadDex,1.0)+'">'+(p.spreadDex>0?'+':'')+p.spreadDex.toFixed(2)+'%</span>';
      var fire=Math.max(p.spreadOKX,p.spreadBybit||0,p.spreadDex)>=1.0?'<span class="badge by">FIRE</span>':'';
      return '<tr><td><b>'+p.name.replace('/USDT','')+'</b></td><td class="dim">'+(p.okxBid?'$'+p.okxBid:'--')+'</td><td class="dim">'+(p.bybitBid?'$'+p.bybitBid:'--')+'</td><td style="text-align:right">'+oc+'</td><td style="text-align:right">'+bc+'</td><td style="text-align:right">'+dc+'</td><td>'+fire+'</td></tr>';
    }).join('');
  }else lb.innerHTML='<tr><td colspan="7" class="dim" style="padding:12px;text-align:center">Waiting...</td></tr>';
  document.getElementById('ft').innerHTML=d.recentFires.map(function(f){
    var time=new Date(f.date).toLocaleString('en-GB',{month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'});
    var oc=f.outcome==='success'?'<span class="badge bg">WIN</span>':f.outcome==='loss'?'<span class="badge br">LOSS</span>':f.outcome==='fired'?'<span class="badge by">FIRED</span>':'<span class="badge br">FAIL</span>';
    return '<tr><td class="dim">'+time+'</td><td>'+(f.pair||'').replace('/USDT','')+'</td><td><span class="badge bn">'+(f.direction||'').replace('BUY_','')+'</span></td><td>'+oc+'</td></tr>';
  }).join('');
  document.getElementById('tt').innerHTML=d.recentTrades.map(function(t){
    var profit=t.profit||0,date=new Date(t.date).toLocaleString('en-GB',{month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'});
    return '<tr><td class="dim">'+date+'</td><td>'+(t.pair||'').replace('/USDT','')+'</td><td><span class="badge bn">'+(t.direction||'').replace('BUY_','')+'</span></td><td>'+(t.spreadPct||0).toFixed(2)+'%</td><td class="'+(profit>=0?'green':'red')+'">'+(profit>=0?'+':'')+'$'+profit.toFixed(2)+'</td></tr>';
  }).join('');
  document.getElementById('pt').innerHTML=Object.entries(d.pairStats).sort(function(a,b){return b[1].fires-a[1].fires;}).map(function(e){
    var p=e[0],s=e[1],wr=s.fires?Math.round(s.wins/s.fires*100):0;
    return '<tr><td>'+p.replace('/USDT','')+'</td><td>'+s.fires+'</td><td class="'+(wr>=50?'green':wr>0?'yellow':'red')+'">'+wr+'%</td><td class="'+(s.pnl>=0?'green':'red')+'">'+(s.pnl>=0?'+':'')+'$'+s.pnl.toFixed(2)+'</td></tr>';
  }).join('');
  var labels=d.balHistory.map(function(b){return b.time.slice(5,16);});
  var totals=d.balHistory.map(function(b){return b.total;});
  var ctx=document.getElementById('ch').getContext('2d');
  if(chart)chart.destroy();
  if(typeof Chart!=='undefined'){chart=new Chart(ctx,{type:'line',data:{labels,datasets:[{label:'Total',data:totals,borderColor:'#7c3aed',backgroundColor:'rgba(124,58,237,0.1)',borderWidth:2,pointRadius:1,fill:true,tension:0.3}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#333',maxTicksLimit:6,font:{size:9}},grid:{color:'#0f0f1a'}},y:{ticks:{color:'#555',font:{size:9},callback:function(v){return'$'+v.toFixed(0);}},grid:{color:'#0f0f1a'}}}}});}
}
refresh();
setInterval(refresh,3000);
setInterval(loadStatus,30000);
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

  }else if(url==='/api/tokens'){
    res.writeHead(200,{'Content-Type':'application/json'});
    try{
      const rpc=process.env.RPC_URL||'https://api.mainnet-beta.solana.com';
      const wallet='wSyZPy2NrfFtUFqzwmDvurDrqw5JXysZ22uLnq1AQaa';
      const r1=await fetch(rpc,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getTokenAccountsByOwner',params:[wallet,{programId:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'},{encoding:'jsonParsed'}]})});
      const j1=await r1.json();
      const toks={};
      for(const a of(j1.result?.value||[])){const info=a.account.data.parsed?.info;if(info?.mint&&parseFloat(info?.tokenAmount?.uiAmount||0)>0)toks[info.mint]=parseFloat(info.tokenAmount.uiAmount);}
      const mints=Object.keys(toks).join(',');
      let prices={};
      if(mints){try{const r2=await fetch('https://api.jup.ag/price/v2?ids='+mints);const j2=await r2.json();prices=j2.data||{};}catch{}}
      res.end(JSON.stringify({toks,prices}));
    }catch(e){res.end(JSON.stringify({toks:{},prices:{},error:e.message}));}

  }else if(url==='/api/live-balances'){
    res.writeHead(200,{'Content-Type':'application/json'});
    try{
      const config=readJSON(CONFIG_FILE)||{};
      const krakenEnabled=config.KRAKEN_ENABLED||false;
      const [solana,okx,bybit]=await Promise.all([fetchSolana(),fetchOKX(),fetchBybit()]);
      let kraken=null;
      if(krakenEnabled){
        try{
          const kn=''+Date.now(),kd='nonce='+kn;
          const kh=crypto.createHash('sha256').update(kn+kd).digest('binary');
          const km=crypto.createHmac('sha512',Buffer.from(process.env.KRAKEN_API_SECRET,'base64'));
          km.update('/0/private/Balance','binary');km.update(kh,'binary');
          const ks=km.digest('base64');
          const kr2=await fetch('https://api.kraken.com/0/private/Balance',{method:'POST',headers:{'API-Key':process.env.KRAKEN_API_KEY,'API-Sign':ks,'Content-Type':'application/x-www-form-urlencoded'},body:kd});
          const kj=await kr2.json();
          kraken=parseFloat(kj.result&&(kj.result.USDT||kj.result.ZUSD)||'0');
        }catch(e){kraken=0;}
      }
      res.end(JSON.stringify({solana,okx,bybit,kraken,krakenEnabled,fetchedAt:new Date().toISOString()}));
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
      fs.writeFileSync(STATE_FILE+'.bak',JSON.stringify(corrected,null,2));
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
      const [sol,okx2,bybit2]=await Promise.all([fetchSolana(),fetchOKX(),fetchBybit()]);
      const solEx=Math.max(0,(sol||0)-tSol),okxSh=Math.max(0,tOKX-(okx2||0)),bybitSh=Math.max(0,tBybit-(bybit2||0));
      let toOKX=0,toBybit=0;
      const budget=Math.min(solEx,okxSh+bybitSh);
      if(budget>10){if(okxSh>=bybitSh){toOKX=Math.min(okxSh,budget);toBybit=Math.min(bybitSh,budget-toOKX);}else{toBybit=Math.min(bybitSh,budget);toOKX=Math.min(okxSh,budget-toBybit);}}
      res.end(JSON.stringify({solana:sol,okx:okx2,bybit:bybit2,targetSolana:tSol,targetOKX:tOKX,targetBybit:tBybit,toOKX:Math.round(toOKX),toBybit:Math.round(toBybit),needed:toOKX>5||toBybit>5}));
    }catch(e){res.end(JSON.stringify({error:e.message}));}

  }else if(url==='/api/rebalance-execute'&&req.method==='POST'){
    res.writeHead(200,{'Content-Type':'application/json'});
    await sendTG('/rebalance confirm');
    res.end(JSON.stringify({ok:true}));

  }else{
    res.writeHead(200,{'Content-Type':'text/html'});
    res.end(buildHTML());
  }
});

server.on('error',function(err){
  if(err.code==='EADDRINUSE'){console.error('Port '+PORT+' in use. Kill: taskkill //F //IM node.exe //T');process.exit(1);}
  else throw err;
});

server.listen(PORT,function(){
  console.log('Dashboard '+VERSION+' running at http://localhost:'+PORT);
});
