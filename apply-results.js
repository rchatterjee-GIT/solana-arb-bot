// apply-results.js — reads exchange-test-results.json and updates arb-config.json
require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const RESULTS_FILE = path.join(__dirname, 'exchange-test-results.json');
const CONFIG_FILE  = path.join(__dirname, 'arb-config.json');

// Withdrawal fee threshold — above this % at $120 = skip
const MAX_FEE_PCT = 5.0;

// Base policy blocks that are always kept regardless of test results
const ALWAYS_SKIP_OKX   = ['TRUMP', 'POPCAT', 'BONK', 'JUP', 'BOME'];
const ALWAYS_SKIP_BYBIT = ['TRUMP', 'POPCAT', 'BONK', 'JUP', 'BOME'];

function applyResults(resultsPath, configPath, dryRun = false) {
  if (!fs.existsSync(resultsPath)) {
    console.error('❌ Results file not found:', resultsPath);
    process.exit(1);
  }

  const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  const config  = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  const changes   = [];
  const skipOKX   = new Set(ALWAYS_SKIP_OKX);
  const skipBybit = new Set(ALWAYS_SKIP_BYBIT);

  // Build a map of test results by exchange+pair+test
  const resultMap = {};
  for (const r of results.results) {
    const key = `${r.exchange}:${r.pair}:${r.test}`;
    resultMap[key] = r;
  }

  // Get unique pairs tested per exchange
  const bybitPairs = [...new Set(results.results.filter(r => r.exchange === 'Bybit').map(r => r.pair))];
  const okxPairs   = [...new Set(results.results.filter(r => r.exchange === 'OKX').map(r => r.pair))];

  // ── Analyse Bybit results ──────────────────────────────────────────────────
  console.log('\n📊 Analysing Bybit results...');
  for (const pair of bybitPairs) {
    const buyResult      = resultMap[`Bybit:${pair}:buy`];
    const withdrawResult = resultMap[`Bybit:${pair}:withdraw`];
    const reason         = [];
    let   shouldSkip     = false;

    // UK compliance block
    if (buyResult?.status === 'FAIL' && buyResult?.detail?.includes('United Kingdom')) {
      shouldSkip = true;
      reason.push('UK compliance blocked');
    }

    // Withdrawal disabled
    if (withdrawResult?.status === 'FAIL' && withdrawResult?.detail?.includes('canWd:false')) {
      shouldSkip = true;
      reason.push('withdrawals disabled');
    }

    // Fee too high at $120
    if (withdrawResult?.detail) {
      const feeMatch = withdrawResult.detail.match(/feePct@?\$?120?:?([\d.]+)%/);
      if (feeMatch && parseFloat(feeMatch[1]) > MAX_FEE_PCT) {
        shouldSkip = true;
        reason.push(`fee ${feeMatch[1]}% > ${MAX_FEE_PCT}% max`);
      }
    }

    // Buy fails (non-compliance, non-test-size issue)
    if (buyResult?.status === 'FAIL' && !buyResult?.detail?.includes('United Kingdom') && !buyResult?.detail?.includes('lower limit')) {
      shouldSkip = true;
      reason.push(`buy failed: ${buyResult.detail?.slice(0, 50)}`);
    }

    const wasSkipped = (config.POLICY_SKIP_BYBIT || []).includes(pair);

    if (shouldSkip) {
      skipBybit.add(pair);
      if (!wasSkipped) {
        changes.push({ exchange: 'Bybit', pair, action: 'SKIP', reason: reason.join(', ') });
        console.log(`  ➕ Skip Bybit ${pair} — ${reason.join(', ')}`);
      } else {
        console.log(`  ✓  Bybit ${pair} already skipped`);
      }
    } else {
      if (wasSkipped && !ALWAYS_SKIP_BYBIT.includes(pair)) {
        changes.push({ exchange: 'Bybit', pair, action: 'ENABLE', reason: 'tests passed' });
        console.log(`  ✅ Enable Bybit ${pair} — tests passed`);
      } else {
        console.log(`  ✓  Bybit ${pair} tradeable`);
      }
    }
  }

  // ── Analyse OKX results ────────────────────────────────────────────────────
  console.log('\n📊 Analysing OKX results...');
  for (const pair of okxPairs) {
    const buyResult      = resultMap[`OKX:${pair}:buy`];
    const withdrawResult = resultMap[`OKX:${pair}:withdraw`];
    const reason         = [];
    let   shouldSkip     = false;

    // UK compliance block
    if (buyResult?.status === 'FAIL' && (
      buyResult?.detail?.includes('compliance') ||
      buyResult?.detail?.includes('United Kingdom') ||
      buyResult?.detail?.includes('51155')
    )) {
      shouldSkip = true;
      reason.push('UK compliance blocked');
    }

    // canWd false
    if (withdrawResult?.status === 'FAIL' && withdrawResult?.detail?.includes('canWd:false')) {
      shouldSkip = true;
      reason.push('withdrawals disabled');
    }

    // Fee too high
    if (withdrawResult?.detail) {
      const feeMatch = withdrawResult.detail.match(/feePct@\$120:([\d.]+)%/);
      if (feeMatch && parseFloat(feeMatch[1]) > MAX_FEE_PCT) {
        shouldSkip = true;
        reason.push(`fee ${feeMatch[1]}% > ${MAX_FEE_PCT}% max`);
      }
    }

    // Buy fails (non-compliance)
    if (buyResult?.status === 'FAIL' && !shouldSkip) {
      shouldSkip = true;
      reason.push(`buy failed: ${buyResult.detail?.slice(0, 50)}`);
    }

    const wasSkipped = (config.POLICY_SKIP_OKX || []).includes(pair);

    if (shouldSkip) {
      skipOKX.add(pair);
      if (!wasSkipped) {
        changes.push({ exchange: 'OKX', pair, action: 'SKIP', reason: reason.join(', ') });
        console.log(`  ➕ Skip OKX ${pair} — ${reason.join(', ')}`);
      } else {
        console.log(`  ✓  OKX ${pair} already skipped`);
      }
    } else {
      if (wasSkipped && !ALWAYS_SKIP_OKX.includes(pair)) {
        changes.push({ exchange: 'OKX', pair, action: 'ENABLE', reason: 'tests passed' });
        console.log(`  ✅ Enable OKX ${pair} — tests passed`);
      } else {
        console.log(`  ✓  OKX ${pair} tradeable`);
      }
    }
  }

  // ── Apply changes ──────────────────────────────────────────────────────────
  const newSkipOKX   = [...skipOKX].sort();
  const newSkipBybit = [...skipBybit].sort();

  console.log('\n📋 New config:');
  console.log('  OKX skip:   ', newSkipOKX.join(', '));
  console.log('  Bybit skip: ', newSkipBybit.join(', '));

  const okxTradeable   = okxPairs.filter(p => !skipOKX.has(p));
  const bybitTradeable = bybitPairs.filter(p => !skipBybit.has(p));
  console.log('\n✅ OKX tradeable:  ', okxTradeable.join(', '));
  console.log('✅ Bybit tradeable:', bybitTradeable.join(', '));

  if (!dryRun) {
    config.POLICY_SKIP_OKX   = newSkipOKX;
    config.POLICY_SKIP_BYBIT = newSkipBybit;
    config.lastTestDate       = results.date;
    config.lastTestSummary    = results.summary;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('\n✅ arb-config.json updated');
  } else {
    console.log('\n⚠️  Dry run — no changes written');
  }

  return { changes, skipOKX: newSkipOKX, skipBybit: newSkipBybit, okxTradeable, bybitTradeable };
}

// ── Telegram summary builder ───────────────────────────────────────────────────
function buildTelegramSummary(applyResult, testSummary) {
  const { changes, okxTradeable, bybitTradeable } = applyResult;
  const added   = changes.filter(c => c.action === 'SKIP');
  const enabled = changes.filter(c => c.action === 'ENABLE');

  let msg = `🧪 <b>Exchange Test Complete</b>\n`;
  msg += `✅ ${testSummary.passed} pass | ❌ ${testSummary.failed} fail\n\n`;

  if (changes.length === 0) {
    msg += `No config changes needed\n\n`;
  } else {
    if (added.length > 0) {
      msg += `<b>Pairs blocked:</b>\n`;
      added.forEach(c => msg += `  ❌ ${c.exchange} ${c.pair} — ${c.reason}\n`);
      msg += '\n';
    }
    if (enabled.length > 0) {
      msg += `<b>Pairs re-enabled:</b>\n`;
      enabled.forEach(c => msg += `  ✅ ${c.exchange} ${c.pair}\n`);
      msg += '\n';
    }
  }

  msg += `<b>OKX trading:</b> ${okxTradeable.join(', ') || 'none'}\n`;
  msg += `<b>Bybit trading:</b> ${bybitTradeable.join(', ') || 'none'}`;
  return msg;
}

// ── CLI usage ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  const dryRun = process.argv.includes('--dry');
  if (dryRun) console.log('🔍 Dry run mode — no changes will be written\n');

  const result = applyResults(RESULTS_FILE, CONFIG_FILE, dryRun);

  const testResults = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
  const msg = buildTelegramSummary(result, testResults.summary);
  console.log('\n📱 Telegram message preview:');
  console.log('─'.repeat(50));
  console.log(msg);
  console.log('─'.repeat(50));
}

module.exports = { applyResults, buildTelegramSummary };
