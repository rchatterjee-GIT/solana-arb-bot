const fs = require('fs');
let src = fs.readFileSync('okx-arb.js', 'utf8');

// Remove kraken from return object - restore original
src = src.replace(
  'const estKraken = (spreadKraken / 100) * TRADE_SIZE_USD - (KRAKEN_FEE + DEX_FEE) * TRADE_SIZE_USD - 0.15;\n        const krakenViable = kraken && liveConfig.KRAKEN_ENABLED && !(liveConfig.POLICY_SKIP_KRAKEN||[]).includes(pair.okxCcy);\n        return { pair, okx, bybit, kraken, quoteBuy, tokenOut, dexAsk, bestBidCex, dexThresh, dexEnabled, okxViable, bybitViable, krakenViable, spreadOKX, netOKX, spreadBybit, netBybit, spreadKraken, netKraken, spreadDex, netDex, estOKX, estBybit, estKraken, estDex, cbBid, cbAsk, spreadSellCoinbase, estSellCoinbase, cbViable };',
  'return { pair, okx, bybit, quoteBuy, tokenOut, dexAsk, bestBidCex, dexThresh, dexEnabled, okxViable, bybitViable, spreadOKX, netOKX, spreadBybit, netBybit, spreadDex, netDex, estOKX, estBybit, estDex, cbBid, cbAsk, spreadSellCoinbase, estSellCoinbase, cbViable };'
);

// Remove kraken spread calculation
src = src.replace(
  `        // Kraken spread
        const krakenKey  = pair.okxCcy + '/USDT';
        const kraken     = krakenPrices?.[krakenKey] || krakenPrices?.[pair.okxCcy + '/USD'] || null;
        const spreadKraken = kraken ? ((dexBid - kraken.ask) / kraken.ask) * 100 : -999;
        const KRAKEN_FEE = 0.004; // 0.4% taker
        const netKraken  = spreadKraken - (KRAKEN_FEE + DEX_FEE) * 100;`,
  ''
);

// Remove kraken from console log
src = src.replace('→Kr:${kraken?spreadKraken.toFixed(2):\'--\'}% →DEX:', '→DEX:');

// Remove kraken from bestKraken init and toFire
src = src.replace(', bestKraken = null', '');
src = src.replace(', bestSellCoinbase, bestKraken].filter(Boolean)', ', bestSellCoinbase].filter(Boolean)');

// Remove kraken fire logic block
src = src.replace(
  `      // Kraken fire logic
      const krakenThreshFinal = (liveConfig.MIN_SPREAD_KRAKEN || liveConfig.MIN_SPREAD_CEX || 1.5) * (1 + (liveConfig.MIN_SPREAD_BUFFER_PCT || 5) / 100);
      if (r.krakenViable && r.kraken && r.spreadKraken > krakenThreshFinal && r.netKraken > 0 && r.estKraken >= MIN_PROFIT) {
        if (!bestKraken || r.spreadKraken > bestKraken.spreadPct)
          bestKraken = { pair: r.pair, direction: 'BUY_KRAKEN', spreadPct: r.spreadKraken, quoteBuy: r.quoteBuy, tokenOut: r.tokenOut, exchange: 'Kraken', tradeSizeUsd: TRADE_SIZE_USD };
      }
      if (canBybit`,
  `      if (canBybit`
);

fs.writeFileSync('okx-arb.js', src);
console.log('Kraken scan changes reverted');
