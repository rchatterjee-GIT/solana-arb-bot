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
const TRADELOG    = path.join(__dirname, 'trade-log.json');
const SIMTRADES   = path.join(__dirname, 'sim-trades.json');

function readJSON(f) { try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch { return null; } }

async function fetchOKX() {
  try {
    const ts = new Date().toISOString();
    const sig = crypto.createHmac('sha256', process.env.OKX_API_SECRET).update(ts+'GET'+'/api/v5/account/balance').digest('base64');
    const r = await fetch('https://www.okx.com/api/v5/account/balance', {headers:{'OK-ACCESS-KEY':process.env.OKX_API_KEY,'OK-ACCESS-SIGN':sig,'OK-ACCESS-TIMESTAMP':ts,'OK-ACCESS-PASSPHRASE':process.env.OKX_PASSPHRASE}});
    const j = await r.json();
    return parseFloat(j.data?.[0]?.details?.find(d=>d.ccy==='USDT')?.availBal||'0');
  } catch(e) { return null; }
}

async function fetchBybit() {
  try {
    const ts=''+Date.now(), rw='5000', qs='accountType=UNIFIED&coin=USDT';
    const sig=crypto.createHmac('sha256',process.env.BYBIT_API_SECRET).update(ts+process.env.BYBIT_API_KEY+rw+qs).digest('hex');
    const r=await fetch('https://api.bybit.com/v5/account/wallet-balance?'+qs,{headers:{'X-BAPI-API-KEY':process.env.BYBIT_API_KEY,'X-BAPI-TIMESTAMP':ts,'X-BAPI-SIGN':sig,'X-BAPI-RECV-WINDOW':rw}});
    const j=await r.json();
    const coin=j.result?.list?.[0]?.coin?.find(c=>c.coin==='USDT');
    return Math.max(parseFloat(coin?.equity||'0'), parseFloat(coin?.walletBalance||'0')*0.95);
  } catch(e) { return null; }
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
  } catch(e) { return null; }
}

function getData() {
  const state   = readJSON(STATE_FILE) || {};
  const trades  = readJSON(TRADES_FILE) || [];
  const fires   = readJSON(FIRES_FILE) || [];
  const log     = readJSON(LOG_FILE) || {};
  const live    = readJSON(LIVE_FILE) || null;
  const status  = readJSON(STATUS_FILE) || null;
  const config  = readJSON(CONFIG_FILE) || {};
  const trLog   = readJSON(TRADELOG) || [];
  const simTr   = readJSON(SIMTRADES) || [];
  const recentTrades = trades.slice(-10).reverse();
  const recentFires  = fires.slice(-20).reverse();
  const pairStats = {};
  for (const t of trades) {
    if (!pairStats[t.pair]) pairStats[t.pair] = {fires:0,wins:0,pnl:0};
    pairStats[t.pair].fires++;
    if (t.profit>0) pairStats[t.pair].wins++;
    pairStats[t.pair].pnl += t.profit||0;
  }
  const balHistory = [];
  for (const [date,day] of Object.entries(log).slice(-7)) {
    for (const r of (day.reports||[])) balHistory.push({time:date+' '+r.time,total:r.total,okx:r.okxUsdt,solana:r.solanaUsdc,bybit:r.bybitUsdt});
  }
  const now=Date.now(), oneWeek=7*24*60*60*1000;
  const week=trades.filter(t=>new Date(t.date).getTime()>now-oneWeek);
  const allWins=trades.filter(t=>t.profit>0).length;
  const weekPnl=week.reduce((a,t)=>a+(t.profit||0),0);
  const startCapital=state.startCapital||0;
  const tradingProfit=state.totalProfit||0;
  const injRatio=startCapital?(tradingProfit/startCapital*100):0;
  const latest=balHistory[balHistory.length-1]||{};
  return {state,recentTrades,recentFires,pairStats,balHistory,live,status,config,tradeLog:trLog,simTrades:simTr,
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
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<title>Arb Bot ${VERSION}</title>
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
  <div class="card" id="kc" style="display:none"><div class="val" id="lk">-</div><div class="lbl">Kraken <span class="badge bp" style="font-size:.6rem">SIM</span></div></div>
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
var chart = null, tokCache = null, tokTime = 0, liveBal = null;

function fmt(n,d){return n!=null?'$'+parseFloat(n).toFixed(d||0):'-';}
function elapsed(ms){var s=Math.round((Date.now()-ms)/1000);if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m '+Math.floor(s%60)+'s';return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';}
function countdown(ms){var s=Math.round((ms-Date.now())/1000);if(s<=0)return 'now';if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m';return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';}
function sc(v,t){var p=v/t;if(p>=1)return'#eab308';if(p>=.8)return'#f97316';if(p>=.5)return'#a78bfa';if(v>0)return'#22c55e';return'#ef4444';}

async function doBalances(){
  var btn=document.querySelector('[onclick="doBalances()"]');
  btn.disabled=true;btn.textContent='Loading...';
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
setTimeout(function(){refresh();setInterval(refresh,3000);setInterval(loadStatus,30000);},100);
</script>
</body>
</html>`;
}

async function sendTelegram(text) {
  try {
    await fetch('https://api.telegram.org/bot'+process.env.TELEGRAM_TOKEN+'/sendMessage', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({chat_id: process.env.TELEGRAM_CHAT_ID, text: text, parse_mode:'HTML'})
    });
  } catch(e) {}
}


const server = http.createServer(async function(req, res) {
  var url = req.url.split('?')[0];
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url === '/api/data') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify(getData()));

  } else if (url === '/api/tokens') {
    res.writeHead(200, {'Content-Type':'application/json'});
    try {
      var rpc = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
      var wallet = 'wSyZPy2NrfFtUFqzwmDvurDrqw5JXysZ22uLnq1AQaa';
      var r1 = await fetch(rpc, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getTokenAccountsByOwner',params:[wallet,{programId:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'},{encoding:'jsonParsed'}]})});
      var j1 = await r1.json();
      var toks = {};
      (j1.result&&j1.result.value||[]).forEach(function(a) {
        var info = a.account.data.parsed&&a.account.data.parsed.info;
        if (info&&info.mint&&parseFloat(info.tokenAmount&&info.tokenAmount.uiAmount||0)>0) toks[info.mint]=parseFloat(info.tokenAmount.uiAmount);
      });
      var mints = Object.keys(toks).join(',');
      var prices = {};
      if (mints) {
        try { var r2=await fetch('https://api.jup.ag/price/v2?ids='+mints);var j2=await r2.json();prices=j2.data||{}; } catch(e) {}
      }
      res.end(JSON.stringify({toks:toks,prices:prices}));
    } catch(e) { res.end(JSON.stringify({toks:{},prices:{},error:e.message})); }

  } else if (url === '/api/live-balances') {
    res.writeHead(200, {'Content-Type':'application/json'});
    try {
      var config = readJSON(CONFIG_FILE)||{};
      var krakenEnabled = config.KRAKEN_ENABLED||false;
      var results = await Promise.all([fetchSolana(), fetchOKX(), fetchBybit()]);
      var solana=results[0], okx=results[1], bybit=results[2];
      var kraken = null;
      if (krakenEnabled) {
        try {
          var nonce=''+Date.now(), data2='nonce='+nonce;
          var hash2=crypto.createHash('sha256').update(nonce+data2).digest('binary');
          var hmac2=crypto.createHmac('sha512',Buffer.from(process.env.KRAKEN_API_SECRET,'base64'));
          hmac2.update('/0/private/Balance','binary');hmac2.update(hash2,'binary');
          var sig2=hmac2.digest('base64');
          var kr=await fetch('https://api.kraken.com/0/private/Balance',{method:'POST',headers:{'API-Key':process.env.KRAKEN_API_KEY,'API-Sign':sig2,'Content-Type':'application/x-www-form-urlencoded'},body:data2});
          var kj=await kr.json();
          kraken=parseFloat(kj.result&&(kj.result.USDT||kj.result.ZUSD)||'0');
        } catch(e) { kraken=0; }
      }
      res.end(JSON.stringify({solana:solana,okx:okx,bybit:bybit,kraken:kraken,krakenEnabled:krakenEnabled,fetchedAt:new Date().toISOString()}));
    } catch(e) { res.end(JSON.stringify({error:e.message})); }

  } else if (url === '/api/deploy-status') {
    res.writeHead(200, {'Content-Type':'application/json'});
    var status2 = readJSON(STATUS_FILE)||{};
    var state2  = readJSON(STATE_FILE)||{};
    var hasBackup = fs.existsSync(path.join(__dirname,'arb-state.json.deploy-bak'));
    res.end(JSON.stringify({version:status2.version||'unknown',timestamp:status2.timestamp,uptime:status2.timestamp?Math.round((Date.now()-new Date(status2.timestamp).getTime())/1000):null,hasBackup:hasBackup,trades:state2.totalTrades||0,pnl:state2.totalProfit||0}));

  } else if (url === '/api/resync' && req.method === 'POST') {
    res.writeHead(200, {'Content-Type':'application/json'});
    try {
      var s3=readJSON(STATE_FILE)||{};
      var t3=readJSON(TRADES_FILE)||[];
      var real3=t3.filter(function(t){return t.direction!=='RECOVERY';});
      var wins3=real3.filter(function(t){return t.profit>0;}).length;
      var pnl3=real3.reduce(function(a,t){return a+(t.profit||0);},0);
      var c3=0;
      for(var i3=real3.length-1;i3>=0;i3--){if(real3[i3].profit>0)c3++;else break;}
      var corrected={};
      Object.assign(corrected,s3,{totalTrades:real3.length,winningTrades:wins3,totalProfit:pnl3,consecutiveWins:c3,lastResync:new Date().toISOString()});
      fs.writeFileSync(STATE_FILE,JSON.stringify(corrected,null,2));
      fs.writeFileSync(STATE_FILE+'.bak',JSON.stringify(corrected,null,2));
      var winsBar3=''; for(var i=0;i<10;i++) winsBar3+=(i<c3?'WIN':'_');
      await sendTelegramLocal('Resynced from dashboard. Trades:'+real3.length+' Wins:'+wins3+' P&L:'+(pnl3>=0?'+':'')+'$'+pnl3.toFixed(2)+' Consec:'+c3+'/10');
      res.end(JSON.stringify({ok:true,trades:real3.length,wins:wins3,pnl:pnl3,consec:c3}));
    } catch(e) { res.end(JSON.stringify({ok:false,error:e.message})); }

  } else if (url === '/api/restart' && req.method === 'POST') {
    res.writeHead(200, {'Content-Type':'application/json'});
    await sendTelegramLocal('Bot restart triggered from dashboard');
    res.end(JSON.stringify({ok:true}));
    try { require('child_process').execSync('taskkill /F /IM node.exe /FI "WINDOWTITLE eq Watchdog*"',{stdio:'ignore'}); } catch(e) {}

  } else if (url === '/api/rollback' && req.method === 'POST') {
    res.writeHead(200, {'Content-Type':'application/json'});
    try {
      var restored=[];
      var bakState=path.join(__dirname,'arb-state.json.deploy-bak');
      var bakTrades=path.join(__dirname,'trades.json.deploy-bak');
      if(fs.existsSync(bakState)){fs.copyFileSync(bakState,path.join(__dirname,'arb-state.json'));restored.push('arb-state.json');}
      if(fs.existsSync(bakTrades)){fs.copyFileSync(bakTrades,path.join(__dirname,'trades.json'));restored.push('trades.json');}
      await sendTelegramLocal('Rollback executed from dashboard. Restored: '+restored.join(', '));
      res.end(JSON.stringify({ok:true,restored:restored}));
    } catch(e) { res.end(JSON.stringify({ok:false,error:e.message})); }

  } else if (url === '/api/rebalance-check') {
    res.writeHead(200, {'Content-Type':'application/json'});
    try {
      var config2=readJSON(CONFIG_FILE)||{};
      var tSol=config2.REBALANCE_TARGET_SOLANA||200, tOKX=config2.REBALANCE_TARGET_OKX||350, tBybit=config2.REBALANCE_TARGET_BYBIT||300;
      var r2=await Promise.all([fetchSolana(),fetchOKX(),fetchBybit()]);
      var sol=r2[0]||0, okx2=r2[1]||0, bybit2=r2[2]||0;
      var solEx=Math.max(0,sol-tSol), okxSh=Math.max(0,tOKX-okx2), bybitSh=Math.max(0,tBybit-bybit2);
      var total2=okxSh+bybitSh;
      var toOKX=0, toBybit=0;
      if(solEx>10&&total2>10){var budget=Math.min(solEx,total2);if(okxSh>=bybitSh){toOKX=Math.min(okxSh,budget);toBybit=Math.min(bybitSh,Math.max(0,budget-toOKX));}else{toBybit=Math.min(bybitSh,budget);toOKX=Math.min(okxSh,Math.max(0,budget-toBybit));}}
      res.end(JSON.stringify({solana:sol,okx:okx2,bybit:bybit2,targetSolana:tSol,targetOKX:tOKX,targetBybit:tBybit,toOKX:Math.round(toOKX),toBybit:Math.round(toBybit),needed:toOKX>5||toBybit>5}));
    } catch(e) { res.end(JSON.stringify({error:e.message})); }

  } else if (url === '/api/rebalance-execute' && req.method === 'POST') {
    res.writeHead(200, {'Content-Type':'application/json'});
    await sendTelegramLocal('/rebalance confirm');
    res.end(JSON.stringify({ok:true}));

  } else if (url === '/api/volatile' && req.method === 'POST') {
    res.writeHead(200, {'Content-Type':'application/json'});
    try {
      var mode=new URL('http://x'+req.url).searchParams.get('mode');
      var c4=readJSON(CONFIG_FILE)||{};
      c4.VOLATILE_MODE=mode==='on';
      fs.writeFileSync(CONFIG_FILE,JSON.stringify(c4,null,2));
      res.end(JSON.stringify({volatile:c4.VOLATILE_MODE}));
    } catch(e) { res.end(JSON.stringify({error:e.message})); }

  } else {
    res.writeHead(200, {'Content-Type':'text/html'});
    res.end(H());
  }
});

server.on('error', function(err) {
  if (err.code === 'EADDRINUSE') {
    console.error('\nPort '+PORT+' in use. Kill existing: taskkill //F //IM node.exe //T\n');
    process.exit(1);
  } else throw err;
});

server.listen(PORT, function() {
  console.log('\nDashboard '+VERSION+' - http://localhost:'+PORT);
  console.log('All JS uses string concatenation - no template literal issues\n');
});
