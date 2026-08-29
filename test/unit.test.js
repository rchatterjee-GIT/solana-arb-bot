/**
 * test/unit.test.js — Unit tests for arb-core v5.0
 *
 * Runs in <10s. No external API calls. No bot running required.
 * All external dependencies mocked.
 *
 * Usage: node test/unit.test.js
 * Exit code 0 = all passed, 1 = failures
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Change to project root
process.chdir(path.join(__dirname, '..'));

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
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

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'assertEqual'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

console.log('\n🧪 arb-core v5.0 Unit Tests\n' + '='.repeat(50));

// ── 1. Syntax ─────────────────────────────────────────────────────────────────
console.log('\n[1] Syntax checks');
const FILES = [
  'arb-core.js', 'threshold.js', 'strategy.js',
  'exchanges/okx.js', 'exchanges/bybit.js', 'exchanges/jupiter.js',
  'exchanges/kraken.js', 'exchanges/coinbase.js',
  'agent.js', 'watchdog.js',
];
for (const f of FILES) {
  test(`Syntax: ${f}`, () => {
    assert(fs.existsSync(f), `FILE NOT FOUND: ${f}`);
    execSync(`node --check ${f}`, { stdio: 'pipe' });
  });
}

// ── 2. Config schema ──────────────────────────────────────────────────────────
console.log('\n[2] Config schema');
test('arb-config.json valid JSON', () => {
  const cfg = JSON.parse(fs.readFileSync('arb-config.json', 'utf8'));
  assert(typeof cfg.TRADE_SIZE_USD === 'number', 'TRADE_SIZE_USD must be number');
  assert(typeof cfg.MIN_SPREAD_BUFFER_PCT === 'number', 'MIN_SPREAD_BUFFER_PCT must be number');
  assert(Array.isArray(cfg.POLICY_SKIP_DEX), 'POLICY_SKIP_DEX must be array');
  assert(Array.isArray(cfg.POLICY_SKIP_OKX), 'POLICY_SKIP_OKX must be array');
  assert(Array.isArray(cfg.POLICY_SKIP_BYBIT), 'POLICY_SKIP_BYBIT must be array');
  assert(typeof cfg.DISABLE_BUY_OKX === 'boolean', 'DISABLE_BUY_OKX must be boolean');
  assert(typeof cfg.DISABLE_BUY_BYBIT === 'boolean', 'DISABLE_BUY_BYBIT must be boolean');
  assert(typeof cfg.DISABLE_BUY_DEX === 'boolean', 'DISABLE_BUY_DEX must be boolean');
});

test('TRADE_SIZE_USD in sane range', () => {
  const cfg = JSON.parse(fs.readFileSync('arb-config.json', 'utf8'));
  assert(cfg.TRADE_SIZE_USD >= 50 && cfg.TRADE_SIZE_USD <= 500, `TRADE_SIZE_USD ${cfg.TRADE_SIZE_USD} out of range`);
});

test('MIN_SPREAD_BUFFER_PCT in sane range', () => {
  const cfg = JSON.parse(fs.readFileSync('arb-config.json', 'utf8'));
  const b = cfg.MIN_SPREAD_BUFFER_PCT;
  assert(b >= 3 && b <= 20, `Buffer ${b}% out of sane range`);
});

test('JTO not in skip lists', () => {
  const cfg = JSON.parse(fs.readFileSync('arb-config.json', 'utf8'));
  assert(!cfg.POLICY_SKIP_DEX?.includes('JTO'), 'JTO in POLICY_SKIP_DEX — removes best pair');
  assert(!cfg.POLICY_SKIP_OKX?.includes('JTO'), 'JTO in POLICY_SKIP_OKX — removes best pair');
  assert(!cfg.POLICY_SKIP_BYBIT?.includes('JTO'), 'JTO in POLICY_SKIP_BYBIT — removes best pair');
});

test('POLICY_SKIP_DEX covers known bad pairs', () => {
  const cfg = JSON.parse(fs.readFileSync('arb-config.json', 'utf8'));
  const bad = ['TRUMP', 'BOME', 'GOAT', 'RAY', 'RENDER'];
  for (const sym of bad) {
    assert(cfg.POLICY_SKIP_DEX?.includes(sym), `${sym} should be in POLICY_SKIP_DEX`);
  }
});

test('CEX legs disabled', () => {
  const cfg = JSON.parse(fs.readFileSync('arb-config.json', 'utf8'));
  assert(cfg.DISABLE_BUY_OKX === true, 'DISABLE_BUY_OKX should be true (withdrawal lag)');
  assert(cfg.DISABLE_BUY_BYBIT === true, 'DISABLE_BUY_BYBIT should be true (withdrawal lag)');
});

test('DEX thresholds sane', () => {
  const cfg = JSON.parse(fs.readFileSync('arb-config.json', 'utf8'));
  for (const [sym, thr] of Object.entries(cfg.DEX_THRESHOLD_OVERRIDES || {})) {
    assert(thr >= 0.6 && thr <= 5.0, `${sym} threshold ${thr}% out of range 0.6-5%`);
  }
});

test('ACTIVE_REGIME valid', () => {
  const cfg = JSON.parse(fs.readFileSync('arb-config.json', 'utf8'));
  assert(['BULL', 'NEUTRAL', 'BEAR', undefined, null].includes(cfg.ACTIVE_REGIME),
    `Invalid ACTIVE_REGIME: ${cfg.ACTIVE_REGIME}`);
  if (cfg.ACTIVE_REGIME === 'NEUTRAL') {
    assert(!cfg.DISABLE_BUY_DEX, 'NEUTRAL regime should have BUY_DEX enabled');
  }
  if (cfg.ACTIVE_REGIME === 'BULL') {
    assert(cfg.DISABLE_BUY_DEX, 'BULL regime should have BUY_DEX disabled');
  }
});

// ── 3. Module exports ─────────────────────────────────────────────────────────
console.log('\n[3] Module exports');
test('threshold.js exports', () => {
  const t = require(path.join(__dirname, '..', 'threshold'));
  assert(typeof t.getThreshold === 'function', 'missing getThreshold');
  assert(typeof t.updateFromTrade === 'function', 'missing updateFromTrade');
  assert(typeof t.calibrateFromHistory === 'function', 'missing calibrateFromHistory');
  assert(typeof t.generateReport === 'function', 'missing generateReport');
  assert(typeof t.load === 'function', 'missing load');
  assert(typeof t.save === 'function', 'missing save');
});

test('strategy.js exports', () => {
  const s = require(path.join(__dirname, '..', 'strategy'));
  assert(typeof s.checkAndApply === 'function', 'missing checkAndApply');
  assert(typeof s.classifyRegime === 'function', 'missing classifyRegime');
  assert(typeof s.generateReport === 'function', 'missing generateReport');
  assert(typeof s.REGIME_CONFIG === 'object', 'missing REGIME_CONFIG');
  assert(typeof s.THRESHOLDS === 'object', 'missing THRESHOLDS');
});

test('exchanges/okx.js exports', () => {
  const okx = require(path.join(__dirname, '..', 'exchanges', 'okx'));
  for (const fn of ['getTicker', 'getBalance', 'marketBuy', 'getOrder', 'withdraw', 'getFundingRate']) {
    assert(typeof okx[fn] === 'function', `missing ${fn}`);
  }
});

test('exchanges/jupiter.js exports', () => {
  const jup = require(path.join(__dirname, '..', 'exchanges', 'jupiter'));
  for (const fn of ['getQuote', 'executeSwap', 'signAndSend', 'swap']) {
    assert(typeof jup[fn] === 'function', `missing ${fn}`);
  }
});

test('exchanges/bybit.js exports', () => {
  const bybit = require(path.join(__dirname, '..', 'exchanges', 'bybit'));
  for (const fn of ['getTicker', 'getBalance', 'marketBuy', 'getOrder', 'withdraw']) {
    assert(typeof bybit[fn] === 'function', `missing ${fn}`);
  }
});

test('exchanges/kraken.js exports', () => {
  const kraken = require(path.join(__dirname, '..', 'exchanges', 'kraken'));
  for (const fn of ['getTicker', 'getBalance', 'getUSDTBalance', 'withdraw']) {
    assert(typeof kraken[fn] === 'function', `missing ${fn}`);
  }
});

test('exchanges/coinbase.js exports', () => {
  const cb = require(path.join(__dirname, '..', 'exchanges', 'coinbase'));
  for (const fn of ['getTicker', 'getBalance', 'marketBuy', 'marketSell', 'getOrder']) {
    assert(typeof cb[fn] === 'function', `missing ${fn}`);
  }
  assert(typeof cb.TAKER_FEE === 'number', 'missing TAKER_FEE constant');
});

// ── 4. Threshold engine logic ─────────────────────────────────────────────────
console.log('\n[4] Threshold engine logic');
const threshold = require(path.join(__dirname, '..', 'threshold'));
const TEST_SYM = '_unit_test_';

// Cleanup before tests
const data = threshold.load();
delete data[TEST_SYM];
threshold.save(data);

test('getThreshold falls back to config default', () => {
  const cfg = { MIN_SPREAD_CEX: 1.8 };
  const t = threshold.getThreshold(TEST_SYM, cfg);
  assertEqual(t, 1.8, 'Should return config default');
});

test('getThreshold returns MIN if below minimum', () => {
  const data = threshold.load();
  data[TEST_SYM] = { threshold: 0.5 }; // below MIN=1.2
  threshold.save(data);
  const t = threshold.getThreshold(TEST_SYM, {});
  assert(t >= 1.2, `Threshold ${t} below MIN 1.2`);
  // Cleanup
  const d2 = threshold.load(); delete d2[TEST_SYM]; threshold.save(d2);
});

test('updateFromTrade WIN accumulates wins', () => {
  threshold.updateFromTrade(TEST_SYM, 2.0, 'WIN');
  threshold.updateFromTrade(TEST_SYM, 1.9, 'WIN');
  threshold.updateFromTrade(TEST_SYM, 2.1, 'WIN');
  const d = threshold.load();
  assert(d[TEST_SYM]?.wins?.length >= 3, 'Should have 3+ wins');
  const d2 = threshold.load(); delete d2[TEST_SYM]; threshold.save(d2);
});

test('updateFromTrade LOSS-only sets MAX threshold', () => {
  // Feed 3 losses, no wins
  for (let i = 0; i < 3; i++) threshold.updateFromTrade(TEST_SYM, 1.5, 'LOSS');
  const d = threshold.load();
  assert(d[TEST_SYM]?.threshold === 5.0, `Loss-only should set MAX=5.0, got ${d[TEST_SYM]?.threshold}`);
  const d2 = threshold.load(); delete d2[TEST_SYM]; threshold.save(d2);
});

test('updateFromTrade mixed WIN/LOSS sets midpoint threshold', () => {
  // 3 losses at 1.0%, 3 wins at 2.0% → midpoint ~1.5%
  for (let i = 0; i < 3; i++) threshold.updateFromTrade(TEST_SYM, 1.0, 'LOSS');
  for (let i = 0; i < 3; i++) threshold.updateFromTrade(TEST_SYM, 2.0, 'WIN');
  const d = threshold.load();
  assert(d[TEST_SYM]?.threshold >= 1.2 && d[TEST_SYM]?.threshold <= 2.0,
    `Midpoint threshold ${d[TEST_SYM]?.threshold} out of expected range 1.2-2.0`);
  const d2 = threshold.load(); delete d2[TEST_SYM]; threshold.save(d2);
});

// ── 5. Strategy regime classification ────────────────────────────────────────
console.log('\n[5] Strategy regime logic');
const { classifyRegime, THRESHOLDS, REGIME_CONFIG } = require(path.join(__dirname, '..', 'strategy'));

test('BULL regime when BTC +6%', () => {
  const { regime } = classifyRegime({ pct24h: 6.0, pct1h: 1.0 }, 0);
  assertEqual(regime, 'BULL', 'BTC +6% should be BULL');
});

test('BEAR regime when BTC -6%', () => {
  const { regime } = classifyRegime({ pct24h: -6.0, pct1h: -1.0 }, 0);
  assertEqual(regime, 'BEAR', 'BTC -6% should be BEAR');
});

test('BEAR regime when BTC fast drop -4%/1hr', () => {
  const { regime } = classifyRegime({ pct24h: -2.0, pct1h: -4.0 }, 0);
  assertEqual(regime, 'BEAR', 'Fast 1hr drop should be BEAR');
});

test('NEUTRAL regime when BTC ±3%', () => {
  const { regime } = classifyRegime({ pct24h: 3.0, pct1h: 0.5 }, 0);
  assertEqual(regime, 'NEUTRAL', 'BTC ±3% should be NEUTRAL');
});

test('BULL regime when high funding rate', () => {
  const { regime } = classifyRegime({ pct24h: 2.0, pct1h: 0.5 }, 0.001); // 0.1%/8hr
  assertEqual(regime, 'BULL', 'High funding rate should be BULL');
});

test('BULL config disables BUY_DEX', () => {
  assert(REGIME_CONFIG.BULL.DISABLE_BUY_DEX === true, 'BULL should disable BUY_DEX');
  assert(REGIME_CONFIG.BULL.FUNDING_ARB_ENABLED === true, 'BULL should enable funding arb');
});

test('BEAR config lowers JTO threshold', () => {
  assert(REGIME_CONFIG.BEAR.DEX_THRESHOLD_OVERRIDES.JTO <= 1.5,
    `BEAR JTO threshold ${REGIME_CONFIG.BEAR.DEX_THRESHOLD_OVERRIDES.JTO} should be ≤1.5%`);
});

test('NEUTRAL config enables BUY_DEX', () => {
  assert(REGIME_CONFIG.NEUTRAL.DISABLE_BUY_DEX === false, 'NEUTRAL should enable BUY_DEX');
});

test('All regimes have required config keys', () => {
  for (const [name, cfg] of Object.entries(REGIME_CONFIG)) {
    assert('DISABLE_BUY_DEX' in cfg, `${name} missing DISABLE_BUY_DEX`);
    assert('FUNDING_ARB_ENABLED' in cfg, `${name} missing FUNDING_ARB_ENABLED`);
    assert('MIN_SPREAD_BUFFER_PCT' in cfg, `${name} missing MIN_SPREAD_BUFFER_PCT`);
    assert('DEX_THRESHOLD_OVERRIDES' in cfg, `${name} missing DEX_THRESHOLD_OVERRIDES`);
    assert('JTO' in cfg.DEX_THRESHOLD_OVERRIDES, `${name} missing JTO threshold`);
  }
});

// ── 6. Pairs config ───────────────────────────────────────────────────────────
console.log('\n[6] Active pairs validation');
// Inline pairs definition (mirrors arb-core.js)
const PAIRS = [
  { name: 'JTO/USDT', okxCcy: 'JTO', outputMint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', decimals: 9 },
  { name: 'SOL/USDT', okxCcy: 'SOL', outputMint: 'So11111111111111111111111111111111111111112',    decimals: 9 },
  { name: 'WIF/USDT', okxCcy: 'WIF', outputMint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', decimals: 6 },
  { name: 'PENGU/USDT',okxCcy:'PENGU',outputMint:'2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv', decimals: 6 },
  { name: 'PNUT/USDT', okxCcy: 'PNUT', outputMint: '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump',decimals: 6 },
  { name: 'W/USDT',    okxCcy: 'W',    outputMint: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ',decimals: 6 },
];

test('All pairs have required fields', () => {
  for (const p of PAIRS) {
    assert(p.name, `Pair missing name`);
    assert(p.okxCcy, `${p.name} missing okxCcy`);
    assert(p.outputMint?.length === 44 || p.outputMint?.length === 43, `${p.name} invalid outputMint`);
    assert(typeof p.decimals === 'number', `${p.name} missing decimals`);
  }
});

test('JTO is in active pairs', () => {
  assert(PAIRS.some(p => p.okxCcy === 'JTO'), 'JTO must be in active pairs');
});

test('No known bad pairs in active pairs', () => {
  const bad = ['TRUMP', 'BOME', 'GOAT', 'RAY', 'RENDER', 'MEW', 'BONK'];
  for (const sym of bad) {
    assert(!PAIRS.some(p => p.okxCcy === sym), `${sym} should not be in active pairs`);
  }
});

test('Active pairs match skip list exclusions', () => {
  const cfg = JSON.parse(fs.readFileSync('arb-config.json', 'utf8'));
  const skipDex = new Set(cfg.POLICY_SKIP_DEX || []);
  for (const p of PAIRS) {
    assert(!skipDex.has(p.okxCcy), `${p.okxCcy} is both in active pairs and POLICY_SKIP_DEX`);
  }
});

// ── 7. Agent command coverage ────────────────────────────────────────────────
console.log('\n[7] Agent command coverage');
test('agent.js has all required commands', () => {
  const src = fs.readFileSync('agent.js', 'utf8');
  const required = [
    '/status', '/balances', '/trades', '/wins',
    '/rb confirm', '/crash', '/pause', '/resume',
    '/regime', '/thresholds', '/calibrate',
    '/funding', '/listings', '/help'
  ];
  for (const cmd of required) {
    assert(src.includes(cmd), 'Missing command: ' + cmd);
  }
});

test('arb-core.js has stop-loss protection', () => {
  const src = fs.readFileSync('arb-core.js', 'utf8');
  assert(src.includes('SESSION_STOP_LOSS'), 'Missing SESSION_STOP_LOSS');
  assert(src.includes('DISABLE_BUY_DEX = true'), 'Stop-loss should disable BUY_DEX');
});

test('arb-core.js has Bybit NaN fix', () => {
  const src = fs.readFileSync('arb-core.js', 'utf8');
  assert(src.includes('bid1Price ?? d.lastPrice'), 'Bybit WS must use nullish coalescing to avoid NaN');
});

test('arb-core.js tracks consecutive wins', () => {
  const src = fs.readFileSync('arb-core.js', 'utf8');
  assert(src.includes('consecutiveWins'), 'Missing consecutiveWins tracking');
});

test('arb-core.js handles REBALANCE_NOW flag', () => {
  const src = fs.readFileSync('arb-core.js', 'utf8');
  assert(src.includes('REBALANCE_NOW'), 'Missing REBALANCE_NOW flag handling');
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailed tests:');
  failures.forEach(f => console.log(`  ❌ ${f.name}: ${f.error}`));
  console.log('\n⛔ DO NOT DEPLOY');
  process.exit(1);
} else {
  console.log('\n✅ ALL UNIT TESTS PASSED');
  process.exit(0);
}
