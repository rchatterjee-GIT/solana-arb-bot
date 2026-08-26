const fs = require('fs');
let src = fs.readFileSync('agent.js', 'utf8');
const old = "  if (text === '/agent funding') {";
const patch = `  if (text === '/agent strategy') {
    try { const sm=require('./strategy-manager'); return sm.generateReport(); }
    catch(e) { return '❌ Strategy error: '+e.message; }
  }
  if (text === '/agent strategy check') {
    sendTG('🔍 Running regime check...').catch(()=>{});
    require('./strategy-manager').checkAndSwap(sendTG)
      .then(s=>sendTG('✅ Regime: '+s.regime+' BTC $'+s.btcPrice?.toLocaleString()+'('+s.btcChange24h?.toFixed(1)+'%)').catch(()=>{}))
      .catch(e=>sendTG('❌ '+e.message).catch(()=>{}));
    return null;
  }
  if (text === '/agent funding') {`;
if (src.includes(old)) {
  fs.writeFileSync('agent.js', src.replace(old, patch));
  console.log('Done');
} else { console.log('FAILED'); }
