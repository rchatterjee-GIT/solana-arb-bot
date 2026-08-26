const fs = require('fs');
let src = fs.readFileSync('agent.js', 'utf8');
const old = "  if (text === '/agent skip-thresholds') {";
const patch = `  if (text === '/agent strategy') {
    try{const sm=require('./strategy-manager');return sm.generateReport();}catch(e){return '❌ '+e.message;}
  }
  if (text === '/agent strategy check') {
    sendTG('🔍 Running regime check...').catch(()=>{});
    require('./strategy-manager').checkAndSwap(sendTG).then(s=>sendTG('✅ Regime: '+s.regime+' BTC $'+s.btcPrice?.toLocaleString()+'('+s.btcChange24h?.toFixed(1)+'%)').catch(()=>{})).catch(e=>sendTG('❌ '+e.message).catch(()=>{}));
    return null;
  }
  if (text === '/agent funding') {
    sendTG('📡 Checking funding rates...').catch(()=>{});
    const fa=require('./funding-arb');
    fa.generateFundingReport(['SOL','JTO','WIF','PENGU','PNUT','W','GOAT']).then(r=>sendTG(r).catch(()=>{})).catch(e=>sendTG('❌ '+e.message).catch(()=>{}));
    return null;
  }
  if (text === '/agent listings') {
    try{const lm=require('./listing-monitor');return lm.generateListingReport();}catch(e){return '❌ '+e.message;}
  }
  if (text === '/agent scan-okx') {
    sendTG('🔍 Starting OKX universe scan...').catch(()=>{});
    require('./listing-monitor').scanFullOKXUniverse(sendTG).then(r=>sendTG('🔍 OKX scan: '+r.added+' new from '+r.total).catch(()=>{})).catch(e=>sendTG('❌ '+e.message).catch(()=>{}));
    return null;
  }
  if (text === '/agent calibrate') {
    try{const te=require('./threshold-engine');te.calibrateFromHistory();return te.generateReport();}catch(e){return '❌ '+e.message;}
  }
  if (text === '/agent pair-thresholds') {
    try{const te=require('./threshold-engine');return te.generateReport();}catch(e){return '❌ '+e.message;}
  }
  if (text === '/agent dex-arb on') {
    const c=JSON.parse(fs.readFileSync(require('path').join(__dirname,'arb-config.json'),'utf8'));
    c.DEX_ARB_ENABLED=true;fs.writeFileSync(require('path').join(__dirname,'arb-config.json'),JSON.stringify(c,null,2));
    return '⚡ DEX-ARB enabled';
  }
  if (text === '/agent dex-arb off') {
    const c=JSON.parse(fs.readFileSync(require('path').join(__dirname,'arb-config.json'),'utf8'));
    c.DEX_ARB_ENABLED=false;fs.writeFileSync(require('path').join(__dirname,'arb-config.json'),JSON.stringify(c,null,2));
    return '⚡ DEX-ARB disabled';
  }
  if (text === '/agent skip-thresholds') {`;
if (src.includes(old)) {
  fs.writeFileSync('agent.js', src.replace(old, patch));
  console.log('All commands added');
} else { console.log('FAILED - anchor not found'); }
