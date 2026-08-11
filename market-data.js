// market-data.js — live market intelligence for the agent
// Fetches and caches: price, volume, volatility, trend data
// Sources: CoinGecko (free), Jupiter DEX, on-chain via RPC

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'market-cache.json');
const AGENT_LOG  = path.join(__dirname, 'agent.log');

function marketLog(msg) {
  const line = '['+new Date().toISOString().slice(0,19)+'] [INFO] Market: '+msg;
  console.log('[market-data] '+msg);
  try {
    const existing = fs.existsSync(AGENT_LOG) ? fs.readFileSync(AGENT_LOG,'utf8') : '';
    const lines = existing.split('\n').filter(Boolean);
    lines.push(line);
    fs.writeFileSync(AGENT_LOG, lines.slice(-1000).join('\n')+'\n');
  } catch {}
}
const CACHE_TTL  = 30 * 60 * 1000; // 30 minutes

// Pair → CoinGecko ID mapping
const COINGECKO_IDS = {
  'BTC':    'bitcoin',
  'ETH':    'ethereum',
  'SOL':    'solana',
  'JTO':    'jito-governance-token',
  'WIF':    'dogwifcoin',
  'PENGU':  'pudgy-penguins',
  'GOAT':   'goat',
  'W':      'wormhole',
  'RENDER': 'render-token',
  'RAY':    'raydium',
  'PNUT':   'peanut-the-squirrel',
  'MEW':    'cat-in-a-dogs-world',
  'PYTH':   'pyth-network',
  'BONK':   'bonk',
  'TRUMP':  'maga',
  'JUP':    'jupiter-exchange-solana',
};

// Jupiter mint addresses for DEX liquidity check
const JUPITER_MINTS = {
  'JTO':    'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
  'WIF':    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  'PENGU':  '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv',
  'GOAT':   'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump',
  'W':      '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ',
  'RAY':    '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  'PNUT':   '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump',
};

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE,'utf8')); } catch { return null; }
}

function writeCache(data) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
}

async function fetchCoinGecko(ids) {
  const idStr = ids.join(',');
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${idStr}&order=market_cap_desc&per_page=50&page=1&sparkline=false&price_change_percentage=1h,24h,7d`;
  try {
    const r = await fetch(url, {
      headers: { 'Accept': 'application/json' }
    });
    if (!r.ok) throw new Error(`CoinGecko HTTP ${r.status}`);
    return await r.json();
  } catch(e) {
    marketLog('CoinGecko error: '+e.message);
    return null;
  }
}

async function fetchJupiterLiquidity(symbol, mint, tradeSize) {
  try {
    // Get quote for our trade size to estimate price impact
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const amountIn  = Math.floor(tradeSize * 1e6); // USDC decimals
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${USDC_MINT}&outputMint=${mint}&amount=${amountIn}&slippageBps=100`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) return null;
    const priceImpact = parseFloat(j.priceImpactPct || 0) * 100;
    const routeCount  = j.routePlan?.length || 0;
    return { priceImpact, routeCount, liquid: priceImpact < 0.5 };
  } catch { return null; }
}

async function fetchMarketData(tradeSize = 120) {
  marketLog('Fetching fresh market data...');

  const ids = Object.values(COINGECKO_IDS);
  const cgData = await fetchCoinGecko(ids);

  const result = {
    fetchedAt: new Date().toISOString(),
    pairs: {},
    marketConditions: {},
    opportunityScore: {},
  };

  // Process CoinGecko data
  if (cgData) {
    for (const coin of cgData) {
      const symbol = Object.keys(COINGECKO_IDS).find(k => COINGECKO_IDS[k] === coin.id);
      if (!symbol) continue;

      const change1h  = coin.price_change_percentage_1h_in_currency || 0;
      const change24h = coin.price_change_percentage_24h || 0;
      const change7d  = coin.price_change_percentage_7d_in_currency || 0;
      const volume24h = coin.total_volume || 0;
      const marketCap = coin.market_cap || 0;

      // Volatility score: higher = more arb opportunities
      const volatility = Math.abs(change1h) * 3 + Math.abs(change24h) * 1;

      // Momentum: positive = price going up (bad for CEX buy → DEX sell)
      //           negative = price going down (bad for us)
      const momentum = change1h;

      // Volume score: higher volume = tighter spreads but more opportunities
      const volumeScore = Math.log10(Math.max(volume24h, 1));

      // Opportunity score: volatile + high volume + neutral momentum = best
      const oppScore = (volatility * 0.5) + (volumeScore * 0.3) - (Math.abs(momentum) > 3 ? 2 : 0);

      result.pairs[symbol] = {
        price: coin.current_price,
        change1h,
        change24h,
        change7d,
        volume24h,
        marketCap,
        volatility: parseFloat(volatility.toFixed(3)),
        momentum: parseFloat(momentum.toFixed(3)),
        volumeScore: parseFloat(volumeScore.toFixed(2)),
        oppScore: parseFloat(oppScore.toFixed(2)),
      };

      result.opportunityScore[symbol] = parseFloat(oppScore.toFixed(2));
    }
  }

  // Fetch Jupiter liquidity for key pairs
  for (const [symbol, mint] of Object.entries(JUPITER_MINTS)) {
    const liq = await fetchJupiterLiquidity(symbol, mint, tradeSize);
    if (liq && result.pairs[symbol]) {
      result.pairs[symbol].dexPriceImpact = liq.priceImpact;
      result.pairs[symbol].dexRoutes      = liq.routeCount;
      result.pairs[symbol].dexLiquid      = liq.liquid;
    }
  }

  // Overall market conditions
  const prices = Object.values(result.pairs);
  const btc = result.pairs['BTC'];
  const eth = result.pairs['ETH'];
  if (prices.length > 0) {
    const altPrices = prices.filter(p => p !== btc && p !== eth);
    const avg24h  = altPrices.reduce((a,p) => a + p.change24h, 0) / Math.max(altPrices.length, 1);
    const avgVol  = altPrices.reduce((a,p) => a + p.volatility, 0) / Math.max(altPrices.length, 1);
    const bullish = altPrices.filter(p => p.change24h > 2).length;
    const bearish = altPrices.filter(p => p.change24h < -2).length;

    // Macro conditions from BTC/ETH
    const btc1h  = btc?.change1h  || 0;
    const eth1h  = eth?.change1h  || 0;
    const btc24h = btc?.change24h || 0;
    const eth24h = eth?.change24h || 0;
    const macroAlert = Math.abs(btc1h) > 3 || Math.abs(eth1h) > 3;
    const macroSentiment = btc24h > 2 ? 'bullish' : btc24h < -2 ? 'bearish' : 'neutral';

    result.marketConditions = {
      avg24hChange:    parseFloat(avg24h.toFixed(2)),
      avgVolatility:   parseFloat(avgVol.toFixed(2)),
      bullishPairs:    bullish,
      bearishPairs:    bearish,
      sentiment:       avg24h > 1 ? 'bullish' : avg24h < -1 ? 'bearish' : 'neutral',
      activeWindow:    isActiveWindow(),
      btc1h:           parseFloat(btc1h.toFixed(2)),
      btc24h:          parseFloat(btc24h.toFixed(2)),
      eth1h:           parseFloat(eth1h.toFixed(2)),
      eth24h:          parseFloat(eth24h.toFixed(2)),
      macroAlert:      macroAlert,
      macroSentiment:  macroSentiment,
    };
  }

  writeCache(result);
  marketLog('Fetched '+Object.keys(result.pairs).length+' pairs | Sentiment: '+result.marketConditions.sentiment+' | BTC 1h: '+(result.marketConditions.btc1h||0).toFixed(2)+'% | Top: '+Object.entries(result.opportunityScore||{}).sort(function(a,b){return b[1]-a[1];}).slice(0,3).map(function(e){return e[0]+':'+e[1].toFixed(1);}).join(', '));
  return result;
}

function isActiveWindow() {
  const h = new Date().getUTCHours();
  // Asian session: 00-08 UTC, US open: 13-17 UTC
  return (h >= 0 && h < 8) || (h >= 13 && h < 17);
}

function getMarketData() {
  const cache = readCache();
  if (!cache) return null;
  const age = Date.now() - new Date(cache.fetchedAt).getTime();
  if (age > CACHE_TTL) return null; // stale
  return cache;
}

function getBestOpportunities(topN = 5) {
  const data = getMarketData();
  if (!data) return [];
  return Object.entries(data.opportunityScore)
    .sort((a,b) => b[1] - a[1])
    .slice(0, topN)
    .map(([sym, score]) => ({ symbol: sym, score, ...data.pairs[sym] }));
}

function getPairSignal(symbol) {
  const data = getMarketData();
  if (!data || !data.pairs[symbol]) return null;
  const p = data.pairs[symbol];

  // Generate signal
  let signal = 'neutral';
  let reason = '';

  if (Math.abs(p.change1h) > 5) {
    signal = 'avoid';
    reason = `High 1h volatility (${p.change1h.toFixed(1)}%) — spread may close before withdrawal`;
  } else if (p.change24h < -10) {
    signal = 'avoid';
    reason = `Strong downtrend (${p.change24h.toFixed(1)}% 24h) — momentum against us`;
  } else if (p.volatility > 8 && p.volume24h > 10000000) {
    signal = 'favourable';
    reason = `High volatility + volume — spread opportunities likely`;
  } else if (p.dexLiquid === false) {
    signal = 'avoid';
    reason = `Low DEX liquidity (impact ${p.dexPriceImpact?.toFixed(2)}%) — slippage risk`;
  } else if (p.oppScore > 5) {
    signal = 'watch';
    reason = `Good opportunity score (${p.oppScore})`;
  }

  return { signal, reason, data: p };
}

module.exports = { fetchMarketData, getMarketData, getBestOpportunities, getPairSignal, isActiveWindow };

// Run standalone
if (require.main === module) {
  fetchMarketData(120).then(data => {
    console.log('\n=== MARKET CONDITIONS ===');
    console.log('Sentiment:', data.marketConditions.sentiment);
    console.log('Active window:', data.marketConditions.activeWindow);
    console.log('Avg 24h change:', data.marketConditions.avg24hChange + '%');
    console.log('\n=== TOP OPPORTUNITIES ===');
    getBestOpportunities(5).forEach(p => {
      console.log(`${p.symbol.padEnd(8)} score:${p.score.toFixed(1)} vol:${(p.volatility||0).toFixed(2)} 24h:${(p.change24h||0).toFixed(2)}% liq:${p.dexLiquid!==undefined?(p.dexLiquid?'OK':'LOW'):'-'}`);
    });
    console.log('\n=== PAIR SIGNALS ===');
    ['JTO','PENGU','GOAT','W','RENDER'].forEach(sym => {
      const s = getPairSignal(sym);
      if (s) console.log(`${sym.padEnd(8)} [${s.signal}] ${s.reason}`);
    });
  });
}
