// update-config-v3.js — lever 3-6 config changes
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('arb-config.json','utf8'));

// Lever 3: Remove JUP and BONK from skip lists (now DEX-only enabled)
// JUP: skip CEX only (too liquid, too fast), allow DEX
// BONK: same
config.POLICY_SKIP_OKX = (config.POLICY_SKIP_OKX||[]).filter(function(s){return s!=='JUP'&&s!=='BONK';});
config.POLICY_SKIP_BYBIT = (config.POLICY_SKIP_BYBIT||[]).filter(function(s){return s!=='JUP'&&s!=='BONK';});
// Keep them on CEX skip but allow DEX by not adding them back
config.POLICY_SKIP_OKX = [...new Set([...config.POLICY_SKIP_OKX,'JUP','BONK'])];
config.POLICY_SKIP_BYBIT = [...new Set([...config.POLICY_SKIP_BYBIT,'JUP','BONK'])];
console.log('JUP/BONK: CEX skipped, DEX enabled (buy DEX, sell CEX direction not needed - buy CEX sell DEX)');

// Lever 5: Reduce spread buffer from 15% to 12%
config.MIN_SPREAD_BUFFER_PCT = 12;
console.log('MIN_SPREAD_BUFFER_PCT: 15% -> 12%');
console.log('  CEX fires at: ' + (1.5 * 1.12).toFixed(3) + '% (was ' + (1.5 * 1.15).toFixed(3) + '%)');
console.log('  Kraken fires at: ' + (1.2 * 1.12).toFixed(3) + '% (was ' + (1.2 * 1.15).toFixed(3) + '%)');

// DEX threshold overrides — agent manages dynamically but set sensible defaults
if (!config.DEX_THRESHOLD_OVERRIDES) config.DEX_THRESHOLD_OVERRIDES = {};
config.DEX_THRESHOLD_OVERRIDES['JTO']   = 2.5;
config.DEX_THRESHOLD_OVERRIDES['RAY']   = 2.0;
config.DEX_THRESHOLD_OVERRIDES['PENGU'] = 3.5;
config.DEX_THRESHOLD_OVERRIDES['WIF']   = 2.0;
config.DEX_THRESHOLD_OVERRIDES['BONK']  = 3.0;
config.DEX_THRESHOLD_OVERRIDES['JUP']   = 2.5;
config.DEX_THRESHOLD_OVERRIDES['MEW']   = 3.0;
config.DEX_THRESHOLD_OVERRIDES['PNUT']  = 3.0;
config.DEX_THRESHOLD_OVERRIDES['GOAT']  = 3.0;
config.DEX_THRESHOLD_OVERRIDES['W']     = 2.5;
config.DEX_THRESHOLD_OVERRIDES['SOL']   = 2.0;
console.log('\nDEX_THRESHOLD_OVERRIDES set (agent will adjust dynamically)');
Object.entries(config.DEX_THRESHOLD_OVERRIDES).forEach(function(e){console.log('  '+e[0]+': '+e[1]+'%');});

fs.writeFileSync('arb-config.json', JSON.stringify(config, null, 2));
console.log('\n✅ Config updated');
