const fs = require('fs');
let src = fs.readFileSync('dex-arb.js', 'utf8');

// Add spread logging to status file even when no opportunity
const old = `  const status = {
    timestamp: new Date().toISOString(),
    scanning: Object.keys(TOKENS),
    opportunities: opportunities.map(o => ({
      symbol: o.symbol, spread: o.spreadPct.toFixed(3),
      estProfit: o.profit.toFixed(4), buy: o.buyRoute, sell: o.sellRoute,
    })),
    totalTrades, totalPnl, paused,
  };`;

const newStatus = `  const status = {
    timestamp: new Date().toISOString(),
    scanning: Object.keys(TOKENS),
    opportunities: opportunities.map(o => ({
      symbol: o.symbol, spread: o.spreadPct.toFixed(3),
      estProfit: o.profit.toFixed(4), buy: o.buyRoute, sell: o.sellRoute,
    })),
    lastSpreads: lastSpreads,
    totalTrades, totalPnl, paused,
  };`;

src = src.replace(old, newStatus);

// Add lastSpreads tracking to scan function
const old2 = `  const opportunities = [];

  for (const symbol of Object.keys(TOKENS)) {`;
const new2 = `  const opportunities = [];
  const spreads = {};

  for (const symbol of Object.keys(TOKENS)) {`;
src = src.replace(old2, new2);

// Log spread after scanPair
const old3 = `    try {
      const opp = await scanPair(symbol);
      if (opp && opp.profit > 0) {
        opportunities.push(opp);
      }
    } catch(e) {`;
const new3 = `    try {
      const opp = await scanPair(symbol);
      if (opp) {
        spreads[symbol] = { spread: opp.spreadPct.toFixed(4)+'%', buy: opp.buyRoute, sell: opp.sellRoute, profit: opp.profit.toFixed(4) };
        if (opp.profit > 0) opportunities.push(opp);
      }
    } catch(e) {
      spreads[symbol] = 'error: '+e.message.slice(0,40);`;
src = src.replace(old3, new3);

// Fix closing catch bracket
src = src.replace(
  `      spreads[symbol] = 'error: '+e.message.slice(0,40);
      // Silently ignore — pair unavailable
    }`,
  `      spreads[symbol] = 'error: '+e.message.slice(0,40);
    }`
);

// Add lastSpreads to module scope
src = src.replace(
  'let executing  = false;',
  'let executing  = false;\nlet lastSpreads = {};'
);

// Update lastSpreads after scan
src = src.replace(
  'const status = {',
  'lastSpreads = spreads;\n  const status = {'
);

fs.writeFileSync('dex-arb.js', src);
console.log('Verbose logging added');
