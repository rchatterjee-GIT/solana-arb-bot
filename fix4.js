const fs = require('fs');
const lines = fs.readFileSync('okx-arb.js', 'utf8').split('\n');
// Line 2869 (0-indexed: 2868) is the rogue }
if (lines[2868].trim() === '}' || lines[2868].trim() === '}\r') {
  lines.splice(2868, 1);
  fs.writeFileSync('okx-arb.js', lines.join('\n'));
  console.log('Removed rogue } at line 2869');
} else {
  console.log('Not found:', JSON.stringify(lines[2868]));
}
