const fs = require('fs');
let src = fs.readFileSync('okx-arb.js', 'utf8');

// Remove the entire Coinbase ticker fetch block from scan loop
const old = `        // SELL_COINBASE: buy on DEX, send token to Coinbase, sell on Coinbase
        // Need Coinbase price — fetch from scaffold
        let cbBid = null, cbAsk = null, spreadSellCoinbase = -999, estSellCoinbase = -999;
        if (cbViable && liveConfig.COINBASE_ENABLED && getCoinbase()) {
          try {
            const cbTicker = await Promise.race([getCoinbase().getCoinbaseTicker(pair.okxCcy),new Promise((_,r)=>setTimeout(()=>r(new Error('CB timeout')),2000))]);
            if (cbTicker?.bid && cbTicker?.ask) {
              cbBid = parseFloat(cbTicker.bid);
              cbAsk = parseFloat(cbTicker.ask);
              // Spread: buy on DEX at dexAsk, sell on Coinbase at cbBid
              spreadSellCoinbase = ((cbBid - dexAsk) / dexAsk) * 100;
              const CB_TAKER_FEE = 0.006; // Coinbase 0.6% taker fee
              estSellCoinbase = (spreadSellCoinbase / 100) * TRADE_SIZE_USD - (CB_TAKER_FEE + DEX_FEE) * TRADE_SIZE_USD - 0.15;
            }
          } catch {}
        }`;

const newBlock = `        // SELL_COINBASE disabled in scan (causes timeout) — use separate monitor
        let cbBid = null, cbAsk = null, spreadSellCoinbase = -999, estSellCoinbase = -999;`;

if (src.includes('getCoinbaseTicker')) {
  src = src.replace(old, newBlock);
  console.log('SELL_CB fetch removed');
} else {
  console.log('Pattern not found');
}

fs.writeFileSync('okx-arb.js', src);
