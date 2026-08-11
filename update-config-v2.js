// update-config-v2.js — Kraken threshold + Bybit trade size
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('arb-config.json','utf8'));

// 1. Add Bybit-specific trade size ($200 vs $120 default)
config.TRADE_SIZE_BYBIT = 200;
console.log('TRADE_SIZE_BYBIT set to $200');
console.log('  (Bybit withdrawal fee $0.74 = 0.37% of $200 vs 0.62% of $120)');
console.log('  (Break-even spread: 0.77% vs 1.02% — much more viable)');

// 2. Add Kraken-specific min spread (lower than CEX threshold)
config.MIN_SPREAD_KRAKEN = 1.2;
console.log('\nMIN_SPREAD_KRAKEN set to 1.2%');
console.log('  (Fires when net spread > 1.44% with 20% buffer)');
console.log('  (Gross spread needed: 1.44% + 0.70% fees = 2.14%)');
console.log('  (Previously needed 2.5% gross — was too tight for PENGU window)');

fs.writeFileSync('arb-config.json', JSON.stringify(config, null, 2));
console.log('\n✅ Config updated');
