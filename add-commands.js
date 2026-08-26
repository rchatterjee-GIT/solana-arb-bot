const fs = require('fs');
let src = fs.readFileSync('agent.js', 'utf8');
const anchor = "  if (text === '/agent skip-thresholds') {";
if (!src.includes(anchor)) { console.log('anchor not found'); process.exit(1); }
const cmds = [
  "  if (text === '/agent strategy') { try{const sm=require('./strategy-manager');return sm.generateReport();}catch(e){return 'Strategy error: '+e.message;} }",
  "  if (text === '/agent strategy check') { require('./strategy-manager').checkAndSwap(sendTG).catch(()=>{}); return null; }",
  "  if (text === '/agent funding') { require('./funding-arb').generateFundingReport(['SOL','JTO','WIF','PENGU','PNUT']).then(r=>sendTG(r)).catch(e=>sendTG('Error: '+e.message)); return null; }",
  "  if (text === '/agent listings') { try{const lm=require('./listing-monitor');return lm.generateListingReport();}catch(e){return 'Error: '+e.message;} }",
  "  if (text === '/agent scan-okx') { require('./listing-monitor').scanFullOKXUniverse(sendTG).catch(()=>{}); return null; }",
  "  if (text === '/agent calibrate') { try{const te=require('./threshold-engine');te.calibrateFromHistory();return te.generateReport();}catch(e){return 'Error: '+e.message;} }",
  "  if (text === '/agent pair-thresholds') { try{const te=require('./threshold-engine');return te.generateReport();}catch(e){return 'Error: '+e.message;} }",
  "  if (text === '/agent dex-arb on') { const c=JSON.parse(require('fs').readFileSync('arb-config.json'));c.DEX_ARB_ENABLED=true;require('fs').writeFileSync('arb-config.json',JSON.stringify(c,null,2));return 'DEX-ARB enabled'; }",
  "  if (text === '/agent dex-arb off') { const c=JSON.parse(require('fs').readFileSync('arb-config.json'));c.DEX_ARB_ENABLED=false;require('fs').writeFileSync('arb-config.json',JSON.stringify(c,null,2));return 'DEX-ARB disabled'; }",
].join('\n');
src = src.replace(anchor, cmds + '\n' + anchor);
fs.writeFileSync('agent.js', src);
console.log('Done');
