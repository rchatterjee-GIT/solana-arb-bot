// update-config.js — apply trading optimisations based on win analysis
const fs   = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'arb-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

console.log('\n=== Applying Trading Optimisations ===\n');

// 1. Raise MIN_SPREAD_CEX to 1.5% (fires at 1.8% with 20% buffer)
const oldCex = config.MIN_SPREAD_CEX;
config.MIN_SPREAD_CEX = 1.5;
console.log(`1. MIN_SPREAD_CEX: ${oldCex}% -> ${config.MIN_SPREAD_CEX}%`);
console.log(`   CEX fires at: ${(config.MIN_SPREAD_CEX * 1.2).toFixed(2)}% (with 20% buffer)`);

// 2. Add separate DEX threshold at 1.0%
const oldDex = config.MIN_SPREAD_DEX;
config.MIN_SPREAD_DEX = 1.0;
console.log(`\n2. MIN_SPREAD_DEX: ${oldDex||'(none)'}% -> ${config.MIN_SPREAD_DEX}%`);
console.log(`   DEX fires at: ${(config.MIN_SPREAD_DEX * 1.2).toFixed(2)}% (with 20% buffer)`);

// 3. Add per-pair minimum spreads for known drifters
if (!config.PAIR_MIN_SPREAD) config.PAIR_MIN_SPREAD = {};
config.PAIR_MIN_SPREAD['GOAT'] = 2.5;
config.PAIR_MIN_SPREAD['PENGU'] = 2.5;
config.PAIR_MIN_SPREAD['W'] = 2.5;
console.log('\n3. Per-pair minimums added:');
Object.entries(config.PAIR_MIN_SPREAD).forEach(([p,v]) => console.log(`   ${p}: ${v}%`));

// 4. Lower smart sell timeout from 2hrs to 30min
const oldHold = config.HOLD_MAX_HOURS;
config.HOLD_MAX_HOURS = 0.5;
console.log(`\n4. HOLD_MAX_HOURS: ${oldHold}hrs -> ${config.HOLD_MAX_HOURS}hrs (30 min)`);

// Write
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('\n✅ arb-config.json updated — bot will reload within 30 seconds');
console.log('\nFull config:');
console.log(`  MIN_SPREAD_CEX:  ${config.MIN_SPREAD_CEX}% (fires at ${(config.MIN_SPREAD_CEX*1.2).toFixed(2)}%)`);
console.log(`  MIN_SPREAD_DEX:  ${config.MIN_SPREAD_DEX}% (fires at ${(config.MIN_SPREAD_DEX*1.2).toFixed(2)}%)`);
console.log(`  HOLD_MAX_HOURS:  ${config.HOLD_MAX_HOURS}`);
console.log(`  PAIR_MIN_SPREAD: GOAT/PENGU/W require 2.5%+`);
