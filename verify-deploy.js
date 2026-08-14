// verify-deploy.js — run before every deployment
// Usage: node verify-deploy.js
// Checks: syntax, line counts, key functions, version bump, net changes vs git HEAD

const fs     = require('fs');
const path   = require('path');
const {execSync} = require('child_process');

const FILES = [
  {
    file: 'okx-arb.js',
    minLines: 2400,
    required: ['BOT_VERSION','TradeLogger','checkAndExecute','executeArb',
               'waitAndSwapBack','sendAlert','runStartupChecks',
               'okxLock','bybitLock','consecutiveClean','loadLiveConfig'],
  },
  {
    file: 'dashboard.js',
    minLines: 400,
    required: ['buildHTML','async function doRefresh','function render(d)',
               'async function loadStatus','function renderToks',
               'server.listen','doRebalance','doResync','doRestart'],
  },
  {
    file: 'kraken-scaffold.js',
    minLines: 200,
    required: ['KRAKEN_PAIRS','startKrakenWS','checkKrakenWsHealth',
               'placeKrakenOrder','withdrawFromKraken'],
  },
  {
    file: 'watchdog.js',
    minLines: 50,
    required: ['spawn','restart'],
  },
  {
    file: 'hygiene.js',
    minLines: 150,
    required: ['runHygiene','cleanOKXTrading','cleanBybitUnified','maintainBybitFund'],
  },
  {
    file: 'agent.js',
    minLines: 150,
    required: ['runCycle','buildPairStats','checkCommands','agent-rules'],
  },
  {
    file: 'agent-rules.js',
    minLines: 100,
    required: ['pair-consecutive-losses','daily-performance-report','okx-critically-low'],
  },
  {
    file: 'market-data.js',
    minLines: 150,
    required: ['fetchMarketData','getMarketData','getPairSignal','getBestOpportunities'],
  },
  {
    file: 'listing-monitor.js',
    minLines: 150,
    required: ['scanNewListings','checkNews','processNewListing','getKrakenPairs'],
  },
  {
    file: 'spread-analysis.js',
    minLines: 100,
    required: ['analyseSpreadDuration','printReport'],
  },
  {
    file: 'funding-monitor.js',
    minLines: 100,
    required: ['fetchFundingRates','getFundingData','getTopSignals'],
  },
  {
    file: 'bitget-scaffold.js',
    minLines: 100,
    required: ['getBitgetBalance','getBitgetTicker','bitgetWithdraw','calcSpread'],
  },
  {
    file: 'news-monitor.js',
    minLines: 150,
    required: ['runNewsTrawl','formatDigest','parseRSS','scoreItem'],
  },
];

let allOk = true;
const results = [];

console.log('\n=== DEPLOY VERIFICATION ===\n');

for (const {file, minLines, required} of FILES) {
  const result = { file, ok: true, issues: [] };

  // 1. File exists
  if (!fs.existsSync(file)) {
    result.ok = false;
    result.issues.push('FILE MISSING');
    results.push(result);
    allOk = false;
    continue;
  }

  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n').length;

  // 2. Node syntax check
  try {
    execSync(`node --check ${file}`, {stdio:'pipe'});
  } catch(e) {
    result.ok = false;
    result.issues.push('SYNTAX ERROR: ' + e.stderr.toString().split('\n')[0]);
  }

  // 3. Line count
  result.lines = lines;
  if (lines < minLines) {
    result.ok = false;
    result.issues.push(`TOO SHORT: ${lines} lines (min ${minLines}) — file may be truncated`);
  }

  // 4. Non-ASCII chars (only matters in dashboard.js - browser JS)
  const badChars = src.split('').filter(c => c.charCodeAt(0) > 127).length;
  if (badChars > 0 && file === 'dashboard.js') {
    result.ok = false;
    result.issues.push(`NON-ASCII: ${badChars} chars — may cause browser JS errors`);
  } else if (badChars > 0) {
    result.issues.push(`INFO non-ASCII: ${badChars} chars (emoji in console output - OK)`);
  }

  // 5. Required functions/strings
  for (const fn of required) {
    if (!src.includes(fn)) {
      result.ok = false;
      result.issues.push(`MISSING: ${fn}`);
    }
  }

  // 6. Git diff — lines added/removed vs HEAD
  try {
    const diff = execSync(`git diff HEAD -- ${file}`, {encoding:'utf8'});
    const added   = (diff.match(/^\+[^+]/gm) || []).length;
    const removed = (diff.match(/^-[^-]/gm) || []).length;
    result.added   = added;
    result.removed = removed;

    // Get HEAD line count
    try {
      const headSrc = execSync(`git show HEAD:${file}`, {encoding:'utf8'});
      result.headLines = headSrc.split('\n').length;
      result.lineDelta = lines - result.headLines;
    } catch { result.headLines = null; result.lineDelta = null; }

  } catch { result.added = null; result.removed = null; }

  // 7. Version check for okx-arb.js
  if (file === 'okx-arb.js') {
    const verMatch = src.match(/BOT_VERSION\s*=\s*'([^']+)'/);
    result.version = verMatch ? verMatch[1] : 'NOT FOUND';
    try {
      const headSrc = execSync(`git show HEAD:${file}`, {encoding:'utf8'});
      const headVer = (headSrc.match(/BOT_VERSION\s*=\s*'([^']+)'/) || [])[1] || '?';
      result.headVersion = headVer;
      if (result.version === headVer && (result.added || 0) > 0) {
        result.issues.push(`VERSION NOT BUMPED: still ${headVer} — bump before deploying`);
        result.ok = false;
      } else if (result.version === headVer) {
        result.issues.push(`INFO version ${headVer} unchanged (no code changes detected)`);
      }
    } catch { result.headVersion = null; }
  }

  results.push(result);
  if (!result.ok) allOk = false;
}

// Print results
for (const r of results) {
  const status = r.ok ? '\x1b[32mOK\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  const lines = r.lines ? `${r.lines} lines` : '';
  const delta = r.lineDelta != null ? `(${r.lineDelta >= 0 ? '+' : ''}${r.lineDelta} vs HEAD)` : '';
  const changes = r.added != null ? `+${r.added}/-${r.removed} lines changed` : '';
  const ver = r.version ? `version:${r.version}` : '';
  console.log(`[${status}] ${r.file.padEnd(22)} ${lines.padEnd(12)} ${delta.padEnd(16)} ${changes.padEnd(20)} ${ver}`);
  for (const issue of (r.issues||[])) {
    console.log(`        \x1b[33m! ${issue}\x1b[0m`);
  }
}

console.log('\n' + '─'.repeat(70));
if (allOk) {
  console.log('\x1b[32m✅ ALL CHECKS PASSED — safe to deploy\x1b[0m\n');
  process.exit(0);
} else {
  console.log('\x1b[31m❌ CHECKS FAILED — DO NOT DEPLOY until issues are resolved\x1b[0m\n');
  process.exit(1);
}
