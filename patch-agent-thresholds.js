const fs = require('fs');
let src = fs.readFileSync('agent.js', 'utf8');
const old = "  if (text === '/agent listings') {";
const patch = `  if (text === '/agent calibrate') {
    try { const te=require('./threshold-engine'); te.calibrateFromHistory(); return te.generateReport(); }
    catch(e) { return '🔍 [AGENT] Calibration error: '+e.message; }
  }
  if (text === '/agent pair-thresholds') {
    try { const te=require('./threshold-engine'); return te.generateReport(); }
    catch(e) { return '🔍 [AGENT] Error: '+e.message; }
  }
  if (text === '/agent listings') {`;
if (src.includes(old)) {
  fs.writeFileSync('agent.js', src.replace(old, patch));
  console.log('Done');
} else {
  console.log('Pattern not found');
}
