// update-skips.js — migrate hardcoded skip lists to arb-config.json
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('arb-config.json','utf8'));

// Preserve existing config skip lists, merge with hardcoded defaults
const defaultOKX   = ['TRUMP','POPCAT','BONK','JUP','BOME'];
const defaultBybit = ['JUP','TRUMP','POPCAT','BONK','BOME'];

// Merge without duplicates
config.POLICY_SKIP_OKX   = [...new Set([...(config.POLICY_SKIP_OKX||[]), ...defaultOKX])];
config.POLICY_SKIP_BYBIT = [...new Set([...(config.POLICY_SKIP_BYBIT||[]), ...defaultBybit])];

fs.writeFileSync('arb-config.json', JSON.stringify(config, null, 2));
console.log('OKX skip list:', config.POLICY_SKIP_OKX.join(', '));
console.log('Bybit skip list:', config.POLICY_SKIP_BYBIT.join(', '));
console.log('Done — agent now fully manages skip lists');
