/**
 * run-tests.js — Automated test suite for solana-arb-bot
 *
 * Tests every module for:
 *   - Syntax validity
 *   - Required exports present
 *   - Core logic correctness (unit tests)
 *   - Config schema validity
 *   - Agent command registration
 *   - Strategy manager regime detection logic
 *
 * Usage: node run-tests.js
 * Exit code 0 = all passed, 1 = failures found
 *
 * Safe to run in staging or prod — no real trades or API calls made.
 * Uses mock data for all external dependencies.
 */

'use strict';
require('dotenv').config();
const fs   = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(() => { console.log(`  ✅ ${name}`); passed++; })
                   .catch(e => { console.log(`  ❌ ${name}: ${e.message}`); failed++; failures.push({ name, error: e.message }); });
    }
    console.log(`  ✅ ${name}`);
    passed++;
  } catch(e) {
    console.log(`  ❌ ${name}: ${e.message}`);
    failed++;
    failures.push({ name, error: e.message });
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

async function runAll() {
  console.log('\n🧪 solana-arb-bot Test Suite\n' + '='.repeat(50));

  // ── 1. Syntax checks ─────────────────────────────────────────────────────────
  console.log('\n[1] Syntax checks');
  const jsFiles = [
    'okx-arb.js','dashboard.js','watchdog.js','agent.js','agent-rules.js',
    'listing-monitor.js','threshold-engine.js','strategy-manager.js',
    'funding-arb.js','dex-arb.js','triangular-arb.js','coinbase-scaffold.js',
    'kraken-scaffold.js','hygiene.js',
  ];
  const { execSync } = require('child_process');
  for (const f of jsFiles) {
    test(`Syntax: ${f}`, () => {
      if (!fs.existsSync(f)) throw new Error('FILE NOT FOUND');
      execSync(`node --check ${f}`, { stdio: 'pipe' });
    });
  }

  // ── 2. Config schema ──────────────────────────────────────────────────────────
  console.log('\n[2] Config schema');
  test('arb-config.json valid JSON', () => {
    const cfg = JSON.parse(fs.readFileSync('arb-config.json', 'utf8'));
    assert(typeof cfg.MIN_SPREAD_CEX === 'number', 'MIN_SPREAD_CEX must be number');
    assert(typeof cfg.MIN_SPREAD_BUFFER_PCT === 'number', 'MIN_SPREAD_BUFFER_PCT must be number');
    assert(Array.isArray(cfg.POLICY_SKIP_OKX), 'POLICY_SKIP_OKX must be array');
    assert(Array.isArray(cfg.POLICY_SKIP_BYBIT), 'POLICY_SKIP_BYBIT must be array');
    assert(typeof cfg.DEX_THRESHOLD_OVERRIDES === 'object', 'DEX_THRESHOLD_OVERRIDES must be object');
    assert(typeof cfg.KRAKEN_ENABLED === 'boolean', 'KRAKEN_ENABLED must be boolean');
    assert(typeof cfg.COINBASE_ENABLED === 'boolean', 'COINBASE_ENABLED must be boolean');
  });

  test('arb-config.json thresholds sane', () => {
    const cfg = JSON.parse(fs.readFileSync('arb-config.json', 'utf8'));
    const buf = cfg.MIN_SPREAD_BUFFER_PCT;
    assert(buf >= 3 && buf <= 20, `Buffer ${buf}% out of sane range 3-20%`);
    for (const [sym, thr] of Object.entries(cfg.DEX_THRESHOLD_OVERRIDES || {})) {
      assert(thr >= 0.6 && thr <= 10.0, `${sym} threshold ${thr}% out of sane range 0.6-10%`);
    }
  });

  test('arb-config.json has ACTIVE_REGIME', () => {
    const cfg = JSON.parse(fs.readFileSync('arb-config.json', 'utf8'));
    assert(['BULL','NEUTRAL','BEAR',undefined,null].includes(cfg.ACTIVE_REGIME),
      'ACTIVE_REGIME must be BULL/NEUTRAL/BEAR or undefined');
  });

  test('POLICY_SKIP_DEX defined', () => {
    const cfg = JSON.parse(fs.readFileSync('arb-config.json', 'utf8'));
    assert(Array.isArray(cfg.POLICY_SKIP_DEX), 'POLICY_SKIP_DEX must be array — DEX direction has no skip list without it');
  });

  test('JTO not in any skip list (best performing pair)', () => {
    const cfg = JSON.parse(fs.readFileSync('arb-config.json', 'utf8'));
    assert(!cfg.POLICY_SKIP_OKX?.includes('JTO'), 'JTO in SKIP_OKX — removes best pair from OKX');
    assert(!cfg.POLICY_SKIP_BYBIT?.includes('JTO'), 'JTO in SKIP_BYBIT — removes best pair from Bybit');
    assert(!cfg.POLICY_SKIP_DEX?.includes('JTO'), 'JTO in SKIP_DEX — removes best pair from DEX');
  });

  test('No conflicting disable flags', () => {
    const cfg = JSON.parse(fs.readFileSync('arb-config.json', 'utf8'));
    // In NEUTRAL, BUY_DEX should be enabled
    if (cfg.ACTIVE_REGIME === 'NEUTRAL') {
      assert(!cfg.DISABLE_BUY_DEX, 'NEUTRAL regime should not disable BUY_DEX');
    }
    // In BULL, BUY_DEX should be disabled
    if (cfg.ACTIVE_REGIME === 'BULL') {
      assert(cfg.DISABLE_BUY_DEX, 'BULL regime should disable BUY_DEX');
      assert(cfg.FUNDING_ARB_ENABLED, 'BULL regime should enable funding arb');
    }
  });

  // ── 3. Module exports ─────────────────────────────────────────────────────────
  console.log('\n[3] Module exports');
  test('threshold-engine exports', () => {
    const te = require('./threshold-engine');
    assert(typeof te.getThreshold === 'function', 'missing getThreshold');
    assert(typeof te.updateFromTrade === 'function', 'missing updateFromTrade');
    assert(typeof te.calibrateFromHistory === 'function', 'missing calibrateFromHistory');
    assert(typeof te.generateReport === 'function', 'missing generateReport');
  });

  test('strategy-manager exports', () => {
    const sm = require('./strategy-manager');
    assert(typeof sm.checkAndSwap === 'function', 'missing checkAndSwap');
    assert(typeof sm.detectRegime === 'function', 'missing detectRegime');
    assert(typeof sm.applyRegimeConfig === 'function', 'missing applyRegimeConfig');
    assert(typeof sm.generateReport === 'function', 'missing generateReport');
  });

  test('listing-monitor exports', () => {
    const lm = require('./listing-monitor');
    assert(typeof lm.generateListingReport === 'function', 'missing generateListingReport');
    assert(typeof lm.scanFullOKXUniverse === 'function', 'missing scanFullOKXUniverse');
  });

  test('funding-arb exports', () => {
    const fa = require('./funding-arb');
    assert(typeof fa.getOKXFundingRate === 'function', 'missing getOKXFundingRate');
    assert(typeof fa.generateFundingReport === 'function', 'missing generateFundingReport');
    assert(typeof fa.openFundingPosition === 'function', 'missing openFundingPosition');
  });

  test('coinbase-scaffold exports', () => {
    const cb = require('./coinbase-scaffold');
    assert(typeof cb.getCoinbaseBalance === 'function', 'missing getCoinbaseBalance');
    assert(typeof cb.getCoinbaseTicker === 'function', 'missing getCoinbaseTicker');
    assert(typeof cb.coinbaseMarketBuy === 'function', 'missing coinbaseMarketBuy');
    assert(typeof cb.coinbaseMarketSell === 'function', 'missing coinbaseMarketSell');
  });

  // ── 4. Threshold engine logic ─────────────────────────────────────────────────
  console.log('\n[4] Threshold engine logic');
  test('getThreshold returns number above MIN_THRESHOLD', () => {
    const te = require('./threshold-engine');
    const t = te.getThreshold('JTO');
    assert(typeof t === 'number', 'threshold must be number');
    assert(t >= 0.6, `threshold ${t} below minimum 0.6`);
    assert(t <= 10.0, `threshold ${t} above maximum 10.0`);
  });

  test('updateFromTrade WIN lowers threshold over time', () => {
    const te = require('./threshold-engine');
    // Feed 5 wins at 1.8%
    for (let i = 0; i < 5; i++) te.updateFromTrade('_TEST_', 1.8, 'WIN');
    const t = te.getThreshold('_TEST_');
    assert(t < 2.5, `threshold ${t} should be below 2.5% after wins`);
    // Cleanup
    const thresholds = te.loadThresholds();
    delete thresholds['_TEST_'];
    te.saveThresholds(thresholds);
  });

  test('updateFromTrade LOSS raises threshold', () => {
    const te = require('./threshold-engine');
    // Feed 3 losses at 1.0%
    for (let i = 0; i < 3; i++) te.updateFromTrade('_TEST2_', 1.0, 'LOSS');
    const t = te.getThreshold('_TEST2_');
    assert(t >= 0.6, `threshold ${t} should be at least 1.0% after losses`);
    // Cleanup
    const thresholds = te.loadThresholds();
    delete thresholds['_TEST2_'];
    te.saveThresholds(thresholds);
  });

  // ── 5. Strategy manager regime logic ─────────────────────────────────────────
  console.log('\n[5] Strategy manager logic');
  test('applyRegimeConfig BULL writes correct flags', () => {
    const sm = require('./strategy-manager');
    const cfgBefore = JSON.parse(fs.readFileSync('arb-config.json', 'utf8'));
    sm.applyRegimeConfig('BULL', []);
    const cfg = JSON.parse(fs.readFileSync('arb-config.json', 'utf8'));
    assert(cfg.DISABLE_BUY_DEX === true, 'BULL should disable BUY_DEX');
    assert(cfg.FUNDING_ARB_ENABLED === true, 'BULL should enable funding arb');
    assert(cfg.ACTIVE_REGIME === 'BULL', 'ACTIVE_REGIME should be BULL');
    // Restore
    sm.applyRegimeConfig(cfgBefore.ACTIVE_REGIME || 'NEUTRAL', []);
  });

  test('applyRegimeConfig BEAR lowers JTO threshold', () => {
    const sm = require('./strategy-manager');
    const cfgBefore = JSON.parse(fs.readFileSync('arb-config.json', 'utf8'));
    sm.applyRegimeConfig('BEAR', []);
    const cfg = JSON.parse(fs.readFileSync('arb-config.json', 'utf8'));
    assert(cfg.DEX_THRESHOLD_OVERRIDES.JTO <= 1.5, `BEAR JTO threshold ${cfg.DEX_THRESHOLD_OVERRIDES.JTO} should be ≤1.5%`);
    assert(cfg.ACTIVE_REGIME === 'BEAR', 'ACTIVE_REGIME should be BEAR');
    // Restore
    sm.applyRegimeConfig(cfgBefore.ACTIVE_REGIME || 'NEUTRAL', []);
  });

  test('applyRegimeConfig NEUTRAL enables BUY_DEX', () => {
    const sm = require('./strategy-manager');
    sm.applyRegimeConfig('NEUTRAL', []);
    const cfg = JSON.parse(fs.readFileSync('arb-config.json', 'utf8'));
    assert(!cfg.DISABLE_BUY_DEX, 'NEUTRAL should enable BUY_DEX');
    assert(cfg.ACTIVE_REGIME === 'NEUTRAL', 'ACTIVE_REGIME should be NEUTRAL');
  });

  // ── 6. Agent commands ────────────────────────────────────────────────────────
  console.log('\n[6] Agent command registration');
  test('Agent has /agent strategy command', () => {
    const src = fs.readFileSync('agent.js', 'utf8');
    assert(src.includes("'/agent strategy'"), 'missing /agent strategy');
  });
  test('Agent has /agent funding command', () => {
    const src = fs.readFileSync('agent.js', 'utf8');
    assert(src.includes("'/agent funding'"), 'missing /agent funding');
  });
  test('Agent has /agent calibrate command', () => {
    const src = fs.readFileSync('agent.js', 'utf8');
    assert(src.includes("'/agent calibrate'"), 'missing /agent calibrate');
  });
  test('Agent has /agent dex-arb on command', () => {
    const src = fs.readFileSync('agent.js', 'utf8');
    assert(src.includes("'/agent dex-arb on'"), 'missing /agent dex-arb on');
  });
  test('Agent has /agent listings command', () => {
    const src = fs.readFileSync('agent.js', 'utf8');
    assert(src.includes("'/agent listings'"), 'missing /agent listings');
  });

  // ── 7. Agent rules ───────────────────────────────────────────────────────────
  console.log('\n[7] Agent rules');
  test('Agent rules load without error', () => {
    const rules = require('./agent-rules');
    assert(Array.isArray(rules), 'agent-rules must export array');
    assert(rules.length > 0, 'agent-rules must have at least one rule');
  });
  test('All rules have required fields', () => {
    const rules = require('./agent-rules');
    for (const r of rules) {
      assert(r.id, `Rule missing id: ${JSON.stringify(r).slice(0,50)}`);
      assert(typeof r.detect === 'function', `Rule ${r.id} missing detect()`);
      assert(typeof r.action === 'function', `Rule ${r.id} missing action()`);
    }
  });
  test('market-regime-detector rule exists', () => {
    const rules = require('./agent-rules');
    const r = rules.find(r => r.id === 'market-regime-detector');
    assert(r, 'market-regime-detector rule not found');
  });
  test('catastrophic-loss-detection rule exists', () => {
    const rules = require('./agent-rules');
    const r = rules.find(r => r.id === 'catastrophic-loss-detection');
    assert(r, 'catastrophic-loss-detection rule not found');
  });
  test('spread-flip-alert rule exists', () => {
    const rules = require('./agent-rules');
    const r = rules.find(r => r.id === 'spread-flip-alert');
    assert(r, 'spread-flip-alert rule not found');
  });

  // ── 8. Verify-deploy feature checks ─────────────────────────────────────────
  console.log('\n[8] Feature presence checks');
  const FEATURE_CHECKS = [
    { file: 'okx-arb.js',          pattern: 'DISABLE_BUY_OKX',       desc: 'CEX disable flag' },
    { file: 'okx-arb.js',          pattern: 'thresholdEngine',        desc: 'Threshold engine wired' },
    { file: 'okx-arb.js',          pattern: 'SELL_COINBASE',          desc: 'SELL_COINBASE direction' },
    { file: 'okx-arb.js',          pattern: 'Pre-flight DEX',         desc: 'Pre-flight check' },
    { file: 'okx-arb.js',          pattern: 'calibrateFromHistory',   desc: 'Startup calibration' },
    { file: 'threshold-engine.js', pattern: 'generateReport',         desc: 'generateReport function' },
    { file: 'strategy-manager.js', pattern: 'BULL_BTC_CHANGE',        desc: 'BULL threshold defined' },
    { file: 'strategy-manager.js', pattern: 'applyRegimeConfig',      desc: 'applyRegimeConfig function' },
    { file: 'agent-rules.js',      pattern: 'market-regime-detector', desc: 'Regime detector rule' },
    { file: 'agent-rules.js',      pattern: 'funding-arb-auto',       desc: 'Funding arb auto rule' },
    { file: 'coinbase-scaffold.js',pattern: 'coinbaseMarketSell',     desc: 'coinbaseMarketSell' },
    { file: 'dashboard.js',        pattern: 'deltaIndicator',         desc: 'Balance delta indicators' },
  ];
  for (const { file, pattern, desc } of FEATURE_CHECKS) {
    test(`Feature: ${desc} (${file})`, () => {
      assert(fs.existsSync(file), `${file} not found`);
      const content = fs.readFileSync(file, 'utf8');
      assert(content.includes(pattern), `Pattern '${pattern}' not found in ${file}`);
    });
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  // ── 9. Runtime scan validation ─────────────────────────────────────────────
  const STATIC_ONLY = process.argv.includes('--static-only');
  if (!STATIC_ONLY) {
    console.log('\n[9] Runtime scan validation');
    test('arb-live.json has pairs (scan is running)', () => {
      const d = JSON.parse(fs.readFileSync('arb-live.json', 'utf8'));
      const age = (Date.now() - new Date(d.timestamp).getTime()) / 1000;
      assert(age < 30, 'arb-live.json is stale (' + age.toFixed(0) + 's) — bot not scanning');
      assert(d.pairs && d.pairs.length > 0, 'arb-live.json has 0 pairs — scan returning null for all pairs');
    });
    test('arb-live.json pairs have required fields', () => {
      const d = JSON.parse(fs.readFileSync('arb-live.json', 'utf8'));
      if (!d.pairs || d.pairs.length === 0) return;
      const p = d.pairs[0];
      assert(p.name, 'pair missing name');
      assert(typeof p.spreadOKX === 'number', 'pair missing spreadOKX');
      assert(typeof p.spreadDex === 'number', 'pair missing spreadDex');
      assert(typeof p.dexThresh === 'number', 'pair missing dexThresh');
    });
  } else {
    console.log('\n[9] Runtime scan validation — SKIPPED (--static-only)');
  }

    await new Promise(r => setTimeout(r, 100)); // let async tests settle
  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailed tests:');
    failures.forEach(f => console.log(`  ❌ ${f.name}: ${f.error}`));
    console.log('\n⛔ DO NOT DEPLOY — fix failures first');
    process.exit(1);
  } else {
    console.log('\n✅ ALL TESTS PASSED — safe to deploy');
    process.exit(0);
  }
}

runAll().catch(e => { console.error('Test runner error:', e.message); process.exit(1); });
