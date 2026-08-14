// update-config-v4.js — full pair viability update
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('arb-config.json','utf8'));

// ── KILL: MEW and ZEUS — withdrawal fees eat the trade ──────────────────────
// MEW:  $3.61 fee = 3.0% of $120 trade — unprofitable
// ZEUS: $5.99 fee = 5.0% of $120 trade — unprofitable
if (!config.POLICY_SKIP_OKX.includes('MEW'))   config.POLICY_SKIP_OKX.push('MEW');
if (!config.POLICY_SKIP_BYBIT.includes('MEW'))  config.POLICY_SKIP_BYBIT.push('MEW');
if (!config.POLICY_SKIP_OKX.includes('ZEUS'))   config.POLICY_SKIP_OKX.push('ZEUS');
if (!config.POLICY_SKIP_BYBIT.includes('ZEUS')) config.POLICY_SKIP_BYBIT.push('ZEUS');
console.log('KILLED: MEW (3.0% fee), ZEUS (5.0% fee)');

// ── ENABLE: Remove viable pairs from skip lists ──────────────────────────────
const enableOKX   = ['JUP','BONK','GOAT','RENDER','TRUMP','BOME'];
const enableBybit = ['JUP','BONK','GOAT','TRUMP','BOME'];
// Note: RENDER stays on OKX skip (UK compliance 51155) but enable Bybit
config.POLICY_SKIP_OKX   = config.POLICY_SKIP_OKX.filter(s => !enableOKX.includes(s));
config.POLICY_SKIP_BYBIT = config.POLICY_SKIP_BYBIT.filter(s => !enableBybit.includes(s));
// RENDER: keep OKX skip, remove from Bybit skip
config.POLICY_SKIP_OKX.push('RENDER'); // UK compliance
console.log('ENABLED on OKX:',   enableOKX.filter(s => s !== 'RENDER').join(', '));
console.log('ENABLED on Bybit:', enableBybit.join(', '));
console.log('RENDER: Bybit only (OKX UK compliance blocked)');

// ── DEX threshold overrides — include newly enabled pairs ───────────────────
config.DEX_THRESHOLD_OVERRIDES = {
  // Proven winners — lower thresholds
  'SOL':    2.0,
  'JTO':    2.5,
  'RAY':    2.0,
  'WIF':    2.5,  // marginal — keep threshold higher
  // Good economics
  'W':      2.5,
  'JUP':    2.5,
  'BONK':   3.0,
  'PYTH':   2.5,
  'RENDER': 2.5,
  'PNUT':   3.0,
  // Moderate
  'GOAT':   3.0,
  'PENGU':  3.5,
  'TRUMP':  4.0,  // keep high — volatile
  'BOME':   3.5,
  // Killed
  'MEW':    99,   // effectively disabled
  'ZEUS':   99,   // effectively disabled
};

// ── PAIR_MIN_SPREAD: CEX thresholds for known drifters ──────────────────────
config.PAIR_MIN_SPREAD = {
  'GOAT':  3.0,
  'PENGU': 2.5,
  'W':     2.5,
  'BOME':  3.0,
  'TRUMP': 4.0,
  'BONK':  3.0,
};

fs.writeFileSync('arb-config.json', JSON.stringify(config, null, 2));

console.log('\n=== Final skip lists ===');
console.log('OKX skip:',   config.POLICY_SKIP_OKX);
console.log('Bybit skip:', config.POLICY_SKIP_BYBIT);
console.log('\n✅ Config updated — bot hot-reloads in 30s');
