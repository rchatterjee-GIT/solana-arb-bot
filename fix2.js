const fs = require('fs');
let src = fs.readFileSync('okx-arb.js', 'utf8');
// Find the line with the broken emoji statusMsg and replace
const broken = /const statusMsg = '[^']*<b>Rebalance Check<\/b>[^\n]*\n[^\n]*\n[^\n]*;/;
const fixed = `const statusMsg =
      '<b>Rebalance</b>\\n' +
      'Equal share: $' + Math.round(equalShare) + ' each\\n' +
      'Sol:$' + solana.toFixed(0) + ' OKX:$' + okx.toFixed(0) + ' By:$' + bybit.toFixed(0) + '\\n' +
      'Kr:$' + krakenBal.toFixed(0) + ' CB:$' + coinbaseBal2.toFixed(0) + '\\n\\n';`;
if (broken.test(src)) {
  src = src.replace(broken, fixed);
  fs.writeFileSync('okx-arb.js', src);
  console.log('Fixed');
} else {
  // Try line by line
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('statusMsg') && lines[i].includes('Rebalance Check')) {
      console.log('Found at line', i+1, ':', lines[i].slice(0,60));
      lines[i] = "    const statusMsg =";
      lines[i+1] = "      '<b>Rebalance</b>\\n' +";
      lines[i+2] = "      'Equal share: $' + Math.round(equalShare) + ' each\\n' +";
      lines[i+3] = "      'Sol:$' + solana.toFixed(0) + ' OKX:$' + okx.toFixed(0) + ' By:$' + bybit.toFixed(0) + '\\n' +";
      lines[i+4] = "      'Kr:$' + krakenBal.toFixed(0) + ' CB:$' + coinbaseBal2.toFixed(0) + '\\n\\n';";
      fs.writeFileSync('okx-arb.js', lines.join('\n'));
      console.log('Fixed via line replacement');
      break;
    }
  }
}
