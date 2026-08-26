const fs = require('fs');
let src = fs.readFileSync('threshold-engine.js', 'utf8');

// Replace the entire threshold calculation block in calibrateFromHistory
const old = `    if (wins.length === 0 && losses.length >= 1) {
      // No wins at all — set very high threshold to prevent firing
      thresholds[symbol].threshold  = MAX_THRESHOLD;
      thresholds[symbol].source     = 'loss-only-disabled';
      thresholds[symbol].winRate    = 0;
      thresholds[symbol].updatedAt  = new Date().toISOString();
      updated++;
    } else if (wins.length >= 1) {
      const minWin  = Math.min(...wins);
      const maxLoss = losses.length ? Math.max(...losses) : 0;
      let threshold;
      if (maxLoss > 0 && minWin > maxLoss) {
        threshold = (minWin + maxLoss) / 2;
      } else {
        threshold = minWin * 0.95;
      }
      thresholds[symbol].threshold  = parseFloat(Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, threshold)).toFixed(3));
      thresholds[symbol].source     = 'history-calibration';
      const winRate = wins.length / Math.max(1, wins.length + losses.length);
      const conservativeFactor = winRate < 0.5 ? 1.15 : 0.95; // more conservative if win rate low
      thresholds[symbol].winRate    = wins.length / Math.max(1, wins.length + losses.length);
      thresholds[symbol].updatedAt  = new Date().toISOString();
      updated++;
    }`;

const newBlock = `    if (wins.length === 0 && losses.length >= 1) {
      // No wins — disable pair with high threshold
      thresholds[symbol].threshold  = MAX_THRESHOLD;
      thresholds[symbol].source     = 'loss-only-disabled';
      thresholds[symbol].winRate    = 0;
      thresholds[symbol].updatedAt  = new Date().toISOString();
      updated++;
    } else if (wins.length >= 1) {
      const minWin  = Math.min(...wins);
      const maxLoss = losses.length ? Math.max(...losses) : 0;
      const winRate = wins.length / Math.max(1, wins.length + losses.length);
      const conservativeFactor = winRate < 0.5 ? 1.15 : 0.95;
      let threshold;
      if (maxLoss > 0 && minWin > maxLoss) {
        threshold = (minWin + maxLoss) / 2;
      } else {
        threshold = minWin * conservativeFactor;
      }
      thresholds[symbol].threshold  = parseFloat(Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, threshold)).toFixed(3));
      thresholds[symbol].source     = 'history-calibration';
      thresholds[symbol].winRate    = winRate;
      thresholds[symbol].updatedAt  = new Date().toISOString();
      updated++;
    }`;

if (src.includes(old)) {
  src = src.replace(old, newBlock);
  fs.writeFileSync('threshold-engine.js', src);
  console.log('Fixed');
} else {
  console.log('Pattern not found');
}
