const fs = require('fs');
let src = fs.readFileSync('threshold-engine.js', 'utf8');

// Fix: loss-only pairs get high threshold (effectively disabled)
src = src.replace(
  `    if (wins.length >= 1) {`,
  `    if (wins.length === 0 && losses.length >= 1) {
      // No wins at all — set very high threshold to prevent firing
      thresholds[symbol].threshold  = MAX_THRESHOLD;
      thresholds[symbol].source     = 'loss-only-disabled';
      thresholds[symbol].winRate    = 0;
      thresholds[symbol].updatedAt  = new Date().toISOString();
      updated++;
    } else if (wins.length >= 1) {`
);

// Fix: GOAT-like case (low win rate) — be more conservative
// When win rate < 50%, weight threshold toward min_win + larger buffer
src = src.replace(
  `      const winRate = wins.length / Math.max(1, wins.length + losses.length);`,
  `      const winRate = wins.length / Math.max(1, wins.length + losses.length);
      const conservativeFactor = winRate < 0.5 ? 1.15 : 0.95; // more conservative if win rate low`
);
src = src.replace(
  `        threshold = minWin * 0.95;`,
  `        threshold = minWin * conservativeFactor;`
);

fs.writeFileSync('threshold-engine.js', src);
console.log('Fixed');
