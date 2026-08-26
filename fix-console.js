const fs = require('fs');
let src = fs.readFileSync('okx-arb.js', 'utf8');

// Fix the console.log line removing kraken references
const old = `→Kr:\${kraken?spreadKraken.toFixed(2):'--'}% →DEX:`;
const newStr = `→DEX:`;
src = src.replace(old, newStr);

// Fix return object removing kraken references  
const oldReturn = `return { pair, okx, bybit, kraken, quoteBuy, tokenOut, dexAsk, bestBidCex, dexThresh, dexEnabled, okxViable, bybitViable, krakenViable, spreadOKX, netOKX, spreadBybit, netBybit, spreadKraken, netKraken, spreadDex, netDex, estOKX, estBybit, estKraken, estDex, cbBid, cbAsk, spreadSellCoinbase, estSellCoinbase, cbViable };`;
const newReturn = `return { pair, okx, bybit, quoteBuy, tokenOut, dexAsk, bestBidCex, dexThresh, dexEnabled, okxViable, bybitViable, spreadOKX, netOKX, spreadBybit, netBybit, spreadDex, netDex, estOKX, estBybit, estDex, cbBid, cbAsk, spreadSellCoinbase, estSellCoinbase, cbViable };`;
src = src.replace(oldReturn, newReturn);

// Fix bestKraken references
src = src.replace(', bestKraken = null', '');
src = src.replace(', bestSellCoinbase, bestKraken].filter(Boolean)', ', bestSellCoinbase].filter(Boolean)');

fs.writeFileSync('okx-arb.js', src);
console.log('Fixed');
