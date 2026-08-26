const fs = require('fs');
let src = fs.readFileSync('okx-arb.js', 'utf8');
let count = 0;

// Add DISABLE check to OKX fire condition
const okx1 = 'if (canOkx && r.okxViable && r.spreadOKX > okxThreshFinal';
const okx2 = 'if (!liveConfig.DISABLE_BUY_OKX && canOkx && r.okxViable && r.spreadOKX > okxThreshFinal';
if (src.includes(okx1)) { src = src.replace(okx1, okx2); count++; }

// Add DISABLE check to Bybit fire condition  
const by1 = 'if (canBybit && r.bybitViable && r.spreadBybit > bybitThreshFinal';
const by2 = 'if (!liveConfig.DISABLE_BUY_BYBIT && canBybit && r.bybitViable && r.spreadBybit > bybitThreshFinal';
if (src.includes(by1)) { src = src.replace(by1, by2); count++; }

console.log('Applied', count, 'disable flags');
fs.writeFileSync('okx-arb.js', src);
