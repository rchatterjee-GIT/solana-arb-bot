const fs = require('fs');
let src = fs.readFileSync('okx-arb.js', 'utf8');

// Find all broken statusMsg lines with literal newlines
const lines = src.split('\n');
let fixes = 0;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('statusMsg') && lines[i].includes('Rebalance') && lines[i].includes("'")) {
    console.log('Found broken statusMsg at line', i+1);
    // Replace just this line - split the string properly
    lines[i] = "    const statusMsg = '<b>Rebalance</b>\\n' + 'Equal share: $' + Math.round(equalShare) + ' each\\n' + 'Sol:$' + solana.toFixed(0) + ' OKX:$' + okx.toFixed(0) + ' By:$' + bybit.toFixed(0) + '\\n' + 'Kr:$' + krakenBal.toFixed(0) + ' CB:$' + coinbaseBal2.toFixed(0) + '\\n\\n';";
    // Remove next lines that are continuation of the broken string
    let j = i + 1;
    while (j < lines.length && (lines[j].includes("each") || lines[j].includes("Sol:") || lines[j].includes("Kr:")) && !lines[j].includes('const ') && !lines[j].includes('if ') && !lines[j].includes('await ')) {
      console.log('  Removing continuation line', j+1, ':', lines[j].slice(0,40));
      lines.splice(j, 1);
    }
    fixes++;
  }
}
console.log('Total fixes:', fixes);
fs.writeFileSync('okx-arb.js', lines.join('\n'));
