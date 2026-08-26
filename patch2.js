const fs = require('fs');
let src = fs.readFileSync('agent.js', 'utf8');
const old = "  if (text === '/agent skip-thresholds') {";
const patch = `  if (text === '/agent calibrate') {
    try{const te=require('./threshold-engine');te.calibrateFromHistory();return te.generateReport();}
    catch(e){return '🔍 Calibration error: '+e.message;}
  }
  if (text === '/agent pair-thresholds') {
    try{const te=require('./threshold-engine');return te.generateReport();}
    catch(e){return '🔍 Error: '+e.message;}
  }
  if (text === '/agent listings') {
    try{const lm=require('./listing-monitor');return lm.generateListingReport();}
    catch(e){return '🔍 Listing error: '+e.message;}
  }
  if (text === '/agent scan-okx') {
    sendTG('🔍 Starting OKX universe scan...').catch(()=>{});
    require('./listing-monitor').scanFullOKXUniverse(sendTG)
      .then(r=>sendTG('🔍 OKX scan: '+r.added+' new from '+r.total).catch(()=>{}))
      .catch(e=>sendTG('❌ '+e.message).catch(()=>{}));
    return null;
  }
  if (text === '/agent skip-thresholds') {`;
if (src.includes(old)) {
  fs.writeFileSync('agent.js', src.replace(old, patch));
  console.log('Done');
} else {
  console.log('FAILED - anchor not found');
}
