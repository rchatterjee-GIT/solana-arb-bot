const fs = require('fs');
let src = fs.readFileSync('agent-rules.js', 'utf8');
src = src.replace(
  'if (now.getUTCDay() !== 0 || now.getUTCHours() !== 8) return null;',
  'if (now.getUTCHours() !== 2) return null; // 02:00 UTC daily'
);
src = src.replace(
  'if (Date.now() - lastScan < 6 * 24 * 60 * 60 * 1000) return null;',
  'if (Date.now() - lastScan < 23 * 60 * 60 * 1000) return null;'
);
fs.writeFileSync('agent-rules.js', src);
console.log('Done');
