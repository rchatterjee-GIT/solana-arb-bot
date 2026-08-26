const fs = require('fs');
let src = fs.readFileSync('okx-arb.js', 'utf8');
const idx = src.indexOf("const statusMsg = '\u2696\ufe0f");
if (idx < 0) { console.log('Not found'); process.exit(1); }
const end = src.indexOf(";\n", idx) + 2;
const oldMsg = src.slice(idx, end);
console.log('Found:', oldMsg.slice(0, 60));
const newMsg = `const statusMsg = '<b>Rebalance</b>\\nEqual share: $' + Math.round(equalShare) + ' each\\n' +
      'Sol:$' + solana.toFixed(0) + ' OKX:$' + okx.toFixed(0) + ' By:$' + bybit.toFixed(0) + '\\n' +
      'Kr:$' + krakenBal.toFixed(0) + ' CB:$' + coinbaseBal2.toFixed(0) + ' Total:$' + Math.round(total5) + '\\n\\n';
`;
src = src.slice(0, idx) + newMsg + src.slice(end);
fs.writeFileSync('okx-arb.js', src);
console.log('Done');
