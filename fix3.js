const fs = require('fs');
const lines = fs.readFileSync('okx-arb.js', 'utf8').split('\n');
// Find the rogue } after the statusMsg block
for (let i = 2862; i < 2872; i++) {
  console.log(i+1 + ': ' + JSON.stringify(lines[i]));
}
// Remove the rogue closing brace at line 2867 (0-indexed: 2866)
// It's the } that appears right after the statusMsg
if (lines[2866].trim() === '}') {
  lines.splice(2866, 1);
  fs.writeFileSync('okx-arb.js', lines.join('\n'));
  console.log('Removed rogue }');
}
