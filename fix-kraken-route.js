const fs = require('fs');
let src = fs.readFileSync('okx-arb.js', 'utf8');
// Comment out Kraken route until API key has withdraw permission
src = src.replace(
  "'OKX-Kraken':      'okx-to-kraken',",
  "// 'OKX-Kraken': 'okx-to-kraken', // disabled - needs Kraken withdraw permission"
);
src = src.replace(
  "'Kraken-Solana':   'kraken-to-sol',",
  "// 'Kraken-Solana': 'kraken-to-sol', // disabled - needs Kraken withdraw permission"
);
fs.writeFileSync('okx-arb.js', src);
console.log('Kraken routes disabled');
