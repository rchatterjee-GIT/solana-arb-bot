const fs = require('fs');
let src = fs.readFileSync('okx-arb.js', 'utf8');
// Fix the return object to only include variables that are actually defined
const old = `return { pair, okx, bybit, quoteBuy, tokenOut, dexAsk, bestBidCex, dexThresh, dexEnabled, okxViable, bybitViable, spreadOKX, netOKX, spreadBybit, netBybit, spreadDex, netDex, estOKX, estBybit, estDex, cbBid, cbAsk, spreadSellCoinbase, estSellCoinbase, cbViable };`;
const newRet = `// Calculate DEX spread and estimates
        const bestBidCex2 = Math.max(okx.bid, bybit?.bid || 0);
        const spreadDex2 = ((dexBid - bestBidCex2) / bestBidCex2) * 100;
        const netDex2 = spreadDex2 - DEX_FEE * 200;
        const estDex2 = (spreadDex2 / 100) * TRADE_SIZE_USD - DEX_FEE * 2 * TRADE_SIZE_USD - 0.15;
        const cbViable2b = COINBASE_PAIRS.has(pair.okxCcy) && dexEnabled && !(liveConfig.POLICY_SKIP_COINBASE||[]).includes(pair.okxCcy);
        return { pair, okx, bybit, quoteBuy, tokenOut, dexAsk, bestBidCex: bestBidCex2, dexThresh, dexEnabled, okxViable, bybitViable, spreadOKX, netOKX, spreadBybit, netBybit, spreadDex: spreadDex2, netDex: netDex2, estOKX, estBybit, estDex: estDex2, cbViable: cbViable2b };`;
if (src.includes(old)) {
  src = src.replace(old, newRet);
  fs.writeFileSync('okx-arb.js', src);
  console.log('Fixed return object');
} else {
  console.log('Pattern not found');
}
