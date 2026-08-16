// listing-monitor.js — new token listing detection and news monitoring
// Scans OKX, Bybit for new listings every 5 minutes
// Checks withdrawal availability, DEX liquidity, then alerts + optionally adds to bot

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const KNOWN_FILE  = path.join(__dirname, 'known-pairs.json');
const NEW_FILE    = path.join(__dirname, 'new-pairs.json');
const LOG_FILE    = path.join(__dirname, 'listing.log');
const CONFIG_FILE = path.join(__dirname, 'arb-config.json');

const LISTING_THRESHOLD = 5.0;   // % spread required to add new token
const LISTING_TRADE_SIZE = 60;   // smaller size for new/unknown tokens ($60 vs $120)
const LISTING_MAX_AGE_HRS = 4;   // remove new listing pairs after 4hrs if no opportunity
const MIN_DEX_LIQUIDITY = 50000; // minimum $50k DEX liquidity to consider

function log(msg) {
  const line = `[${new Date().toISOString().slice(0,19)}] ${msg}`;
  console.log(`📡 ${line}`);
  try {
    const existing = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE,'utf8') : '';
    const lines = existing.split('\n').filter(Boolean);
    lines.push(line);
    fs.writeFileSync(LOG_FILE, lines.slice(-500).join('\n') + '\n');
  } catch {}
}

function readJSON(f) { try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch { return null; } }
function writeJSON(f, d) { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

async function sendTG(text) {
  try {
    await fetch('https://api.telegram.org/bot'+process.env.TELEGRAM_TOKEN+'/sendMessage', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({chat_id: process.env.TELEGRAM_CHAT_ID, text, parse_mode:'HTML'})
    });
  } catch(e) { log('TG error: '+e.message); }
}

// ── OKX helpers ───────────────────────────────────────────────────────────────
function okxSign(ts, m, p) {
  return crypto.createHmac('sha256', process.env.OKX_API_SECRET).update(ts+m+p).digest('base64');
}
async function okxGet(ep) {
  const ts = new Date().toISOString();
  const r = await fetch('https://www.okx.com'+ep, {
    headers: {'OK-ACCESS-KEY':process.env.OKX_API_KEY,'OK-ACCESS-SIGN':okxSign(ts,'GET',ep),'OK-ACCESS-TIMESTAMP':ts,'OK-ACCESS-PASSPHRASE':process.env.OKX_PASSPHRASE}
  });
  return r.json();
}

// ── Bybit helpers ─────────────────────────────────────────────────────────────
async function bybitGet(ep, qs) {
  const r = await fetch('https://api.bybit.com'+ep+'?'+qs);
  return r.json();
}

// ── Fetch all OKX spot pairs ──────────────────────────────────────────────────
async function getOKXPairs() {
  try {
    const j = await fetch('https://www.okx.com/api/v5/public/instruments?instType=SPOT').then(r=>r.json());
    return (j.data||[])
      .filter(p => p.quoteCcy === 'USDT' && p.state === 'live')
      .map(p => ({ symbol: p.baseCcy, instId: p.instId, listTime: parseInt(p.listTime||'0') }));
  } catch(e) { log('OKX pairs error: '+e.message); return []; }
}

// ── Fetch all Bybit spot pairs ────────────────────────────────────────────────
async function getBybitPairs() {
  try {
    const j = await bybitGet('/v5/market/instruments-info', 'category=spot&status=Trading');
    return (j.result?.list||[])
      .filter(p => p.quoteCoin === 'USDT')
      .map(p => ({ symbol: p.baseCoin, instId: p.symbol }));
  } catch(e) { log('Bybit pairs error: '+e.message); return []; }
}

// ── Fetch all Kraken spot pairs ───────────────────────────────────────────────
async function getKrakenPairs() {
  try {
    const r = await fetch('https://api.kraken.com/0/public/AssetPairs');
    const j = await r.json();
    const pairs = j.result || {};
    return Object.entries(pairs)
      .filter(([,v]) => v.quote === 'ZUSD' || v.quote === 'USDT')
      .map(([key, v]) => ({ symbol: v.base.replace(/^[XZ]/, ''), instId: key }));
  } catch(e) { log('Kraken pairs error: '+e.message); return []; }
}



// ── Check OKX withdrawal status ───────────────────────────────────────────────
async function checkOKXWithdrawal(ccy) {
  try {
    const ep = `/api/v5/asset/currencies?ccy=${ccy}`;
    const j = await okxGet(ep);
    const chain = (j.data||[]).find(c => c.chain && c.chain.includes('Solana'));
    if (!chain) return { canWithdraw: false, reason: 'No Solana chain' };
    return {
      canWithdraw: chain.canWd === true || chain.canWd === '1',
      minWithdraw: parseFloat(chain.minWd || '0'),
      fee: parseFloat(chain.minFee || '0'),
      chain: chain.chain,
    };
  } catch(e) { return { canWithdraw: false, reason: e.message }; }
}

// ── Check DEX liquidity via Jupiter ──────────────────────────────────────────
async function checkDEXLiquidity(mint, tradeSize) {
  try {
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const amount = Math.floor(tradeSize * 1e6);
    const r = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${USDC}&outputMint=${mint}&amount=${amount}&slippageBps=200`);
    const j = await r.json();
    if (j.error) return { liquid: false, reason: j.error };
    const impact = parseFloat(j.priceImpactPct || 0) * 100;
    return {
      liquid: impact < 2.0,
      priceImpact: impact,
      outAmount: parseInt(j.outAmount || '0'),
    };
  } catch(e) { return { liquid: false, reason: e.message }; }
}

// ── Find Solana mint for a token ──────────────────────────────────────────────
async function findMint(symbol) {
  try {
    const r = await fetch(`https://api.jup.ag/tokens/v1/search?query=${symbol}&limit=5`);
    const j = await r.json();
    const tokens = j.tokens || j || [];
    // Find best match — prefer tokens with high liquidity
    const match = tokens.find(t =>
      t.symbol?.toUpperCase() === symbol.toUpperCase() &&
      t.chainId === 101 // Solana mainnet
    );
    return match?.address || null;
  } catch { return null; }
}

// ── Check current spread for a new pair ──────────────────────────────────────
async function checkSpread(symbol, exchange) {
  try {
    if (exchange === 'OKX') {
      const j = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${symbol}-USDT`).then(r=>r.json());
      const ticker = j.data?.[0];
      if (!ticker) return null;
      return { bid: parseFloat(ticker.bidPx), ask: parseFloat(ticker.askPx) };
    } else if (exchange === 'Bybit') {
      const j = await fetch(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${symbol}USDT`).then(r=>r.json());
      const ticker = j.result?.list?.[0];
      if (!ticker) return null;
      return { bid: parseFloat(ticker.bid1Price), ask: parseFloat(ticker.ask1Price) };
    }
  } catch { return null; }
}

// ── Main scan ─────────────────────────────────────────────────────────────────
async function scanNewListings() {
  const known = readJSON(KNOWN_FILE) || { okx: [], bybit: [], lastScan: null };
  const newPairs = readJSON(NEW_FILE) || [];
  const config = readJSON(CONFIG_FILE) || {};

  // Get current pair lists
  const [okxPairs, bybitPairs, krakenPairs, coinbasePairs] = await Promise.all([
    getOKXPairs(), getBybitPairs(), getKrakenPairs(), getCoinbasePairs()
  ]);

  const okxSymbols    = new Set(okxPairs.map(p => p.symbol));
  const bybitSymbols  = new Set(bybitPairs.map(p => p.symbol));
  const krakenSymbols = new Set(krakenPairs.map(p => p.symbol));

  // Find new listings on each exchange
  const newOKX      = okxPairs.filter(p => !(known.okx||[]).includes(p.symbol));
  const newBybit    = bybitPairs.filter(p => !(known.bybit||[]).includes(p.symbol));
  const newKraken   = krakenPairs.filter(p => !(known.kraken||[]).includes(p.symbol));
  const newCoinbase = coinbasePairs.filter(p => !(known.coinbase||[]).includes(p.symbol));

  // Process new listings — only if we have a previous baseline
  if (known.okx && known.okx.length > 0) {
    for (const pair of newOKX) {
      log('New OKX listing: ' + pair.symbol);
      await processNewListing(pair.symbol, 'OKX', okxSymbols, bybitSymbols, config, newPairs);
    }
  } else {
    log('First OKX scan — baseline set (' + okxPairs.length + ' pairs, no alerts)');
  }
  if (known.bybit && known.bybit.length > 0) {
    for (const pair of newBybit) {
      log('New Bybit listing: ' + pair.symbol);
      await processNewListing(pair.symbol, 'Bybit', okxSymbols, bybitSymbols, config, newPairs);
    }
  } else {
    log('First Bybit scan — baseline set (' + bybitPairs.length + ' pairs, no alerts)');
  }
  // Process new Coinbase listings
  if (known.coinbase && known.coinbase.length > 0 && newCoinbase.length > 0 && newCoinbase.length < 10) {
    const coinbaseSymbols = new Set(coinbasePairs.map(p => p.symbol));
    for (const pair of newCoinbase) {
      log('New Coinbase listing: ' + pair.symbol);
      await processNewListing(pair.symbol, 'Coinbase', config, newPairs, okxSymbols, bybitSymbols, coinbaseSymbols);
    }
  } else if (!known.coinbase || newCoinbase.length >= 10) {
    known.coinbase = coinbasePairs.map(p => p.symbol);
    log('Coinbase baseline set (' + coinbasePairs.length + ' pairs)');
  }

  // Process new Kraken listings through full viability framework
  if (known.kraken && known.kraken.length > 0 && newKraken.length > 0 && newKraken.length < 10) {
    for (const pair of newKraken) {
      log('New Kraken listing: ' + pair.symbol + ' — running viability check');
      await processKrakenListing(pair.symbol, okxSymbols, bybitSymbols, config, newPairs);
    }
  } else if (newKraken.length >= 10) {
    log('First Kraken scan — baseline set (' + krakenPairs.length + ' pairs, no alerts)');
  }


  // Clean up expired new pairs (older than LISTING_MAX_AGE_HRS)
  const cutoff = Date.now() - LISTING_MAX_AGE_HRS * 60 * 60 * 1000;
  const expired = newPairs.filter(p => p.addedAt < cutoff);
  if (expired.length > 0) {
    for (const p of expired) {
      log(`Removing expired new listing: ${p.symbol} (added ${Math.round((Date.now()-p.addedAt)/3600000)}hrs ago)`);
      // Remove from bot skip lists / special handling
    }
  }

  // Update known pairs for all exchanges
  known.okx    = okxPairs.map(p => p.symbol);
  known.bybit  = bybitPairs.map(p => p.symbol);
  known.kraken = krakenPairs.map(p => p.symbol);

  known.lastScan = new Date().toISOString();
  writeJSON(KNOWN_FILE, known);
  writeJSON(NEW_FILE, newPairs.filter(p => p.addedAt >= cutoff));

  return { newOKX: newOKX.length, newBybit: newBybit.length, newKraken: newKraken.length, newCoinbase: newCoinbase.length };
}

async function processNewListing(symbol, exchange, okxSymbols, bybitSymbols, config, newPairs) {
  try {
    // 1. Check withdrawal availability
    const wd = exchange === 'OKX' ? await checkOKXWithdrawal(symbol) : { canWithdraw: true }; // Bybit check TBD
    log(`${symbol} withdrawal: ${wd.canWithdraw ? 'enabled' : 'disabled'}`);

    // 2. Find Solana mint
    const mint = await findMint(symbol);
    log(`${symbol} mint: ${mint || 'not found'}`);

    // 3. Check DEX liquidity
    const dex = mint ? await checkDEXLiquidity(mint, LISTING_TRADE_SIZE) : { liquid: false, reason: 'No mint' };
    log(`${symbol} DEX: ${dex.liquid ? 'liquid (impact '+dex.priceImpact?.toFixed(2)+'%)' : 'illiquid ('+dex.reason+')'}`);

    // 4. Check current spread
    const cexTicker = await checkSpread(symbol, exchange);
    let spreadInfo = 'spread unknown';
    if (cexTicker && dex.outAmount && dex.liquid) {
      const dexPrice = (LISTING_TRADE_SIZE * 1e6) / dex.outAmount; // USDC per token
      const spreadPct = ((cexTicker.bid - dexPrice) / dexPrice) * 100;
      spreadInfo = `spread ${spreadPct.toFixed(2)}%`;
    }

    // 5. Check fee viability at $120 trade size
    let feeUsd = 0;
    let feePct = 0;
    if (wd.fee) {
      try {
        const cgr = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=' + symbol.toLowerCase() + '&vs_currencies=usd');
        const cgj = await cgr.json();
        const price = Object.values(cgj)[0]?.usd || 0;
        feeUsd = wd.fee * price;
        feePct = feeUsd / 120 * 100;
      } catch {}
    }
    const feeViable = feePct < 3.0 || feeUsd === 0;
    const viable = wd.canWithdraw && dex.liquid && feeViable;

    const alertMsg = (viable ? '[NEW]' : '[SKIP]') + ' New ' + exchange + ' Listing: ' + symbol + '\n' +
      'Withdrawal: ' + (wd.canWithdraw ? 'enabled' : 'disabled') + '\n' +
      'DEX: ' + (dex.liquid ? 'liquid (' + (dex.priceImpact||0).toFixed(2) + '% impact)' : 'illiquid') + '\n' +
      (feeUsd > 0 ? 'WD fee: $' + feeUsd.toFixed(2) + ' (' + feePct.toFixed(1) + '% of trade)\n' : '') +
      spreadInfo + '\n' +
      (viable ? '-> Adding to bot (threshold ' + LISTING_THRESHOLD + '%)' :
       !wd.canWithdraw ? '-> Withdrawal disabled' :
       !dex.liquid ? '-> No DEX liquidity' : '-> Fee too high');

    await sendTG(alertMsg);
    log(symbol + ' alert sent. Viable: ' + viable);

        // 6. Add to bot if viable
    if (viable && mint) {
      // Add to new-pairs.json in bot-compatible format
      const expiresAt = new Date(Date.now() + LISTING_MAX_AGE_HRS * 60 * 60 * 1000).toISOString();
      const newPair = {
        name: symbol + '/USDT',
        okxInstId: symbol + '-USDT',
        bybitInstId: bybitSymbols.has(symbol) ? symbol + 'USDT' : null,
        outputMint: mint,
        decimals: 6, // default — will be corrected on first trade
        dex: null,
        isNative: false,
        okxCcy: symbol,
        okxChain: symbol + '-Solana',
        bybitCcy: bybitSymbols.has(symbol) ? symbol : null,
        bybitChain: bybitSymbols.has(symbol) ? 'SOL' : null,
        buyDexEnabled: dex.liquid,
        addedAt: Date.now(),
        expiresAt,
        exchange,
        listingThreshold: LISTING_THRESHOLD,
      };
      newPairs.push(newPair);

      // Add threshold config for this pair
      if (!config.PAIR_MIN_SPREAD) config.PAIR_MIN_SPREAD = {};
      config.PAIR_MIN_SPREAD[symbol] = LISTING_THRESHOLD;
      writeJSON(CONFIG_FILE, config);
      log(symbol + ' added to dynamic pairs + PAIR_MIN_SPREAD at ' + LISTING_THRESHOLD + '%');
    }

  } catch(e) { log(`Error processing ${symbol}: ${e.message}`); }
}

// ── News monitoring via CryptoPanic ──────────────────────────────────────────
async function checkNews() {
  // Requires CRYPTOPANIC_API_KEY in .env — skip if not configured
  if (!process.env.CRYPTOPANIC_API_KEY) return;
  try {
    const token = process.env.CRYPTOPANIC_API_KEY;
    const r = await fetch('https://cryptopanic.com/api/free/v1/posts/?auth_token='+token+'&filter=hot&currencies=BTC,ETH,SOL,JTO,PENGU&kind=news');
    if (!r.ok) { log('News API error: HTTP '+r.status); return; }
    const text = await r.text();
    if (text.trim().startsWith('<')) { log('News API returned HTML - check API key'); return; }
    const j = JSON.parse(text);
    const results = j.results || [];

    const recent = results.filter(n => {
      const age = Date.now() - new Date(n.published_at).getTime();
      return age < 30 * 60 * 1000; // last 30 minutes
    });

    if (recent.length === 0) return;

    // Check for high-impact news
    const highImpact = recent.filter(n =>
      n.votes?.negative > 10 ||
      n.votes?.positive > 20 ||
      (n.title || '').toLowerCase().match(/hack|exploit|launch|listing|partnership|sec|ban|crash|surge|pump/)
    );

    if (highImpact.length > 0) {
      const headlines = highImpact.slice(0,3).map(n =>
        `• ${n.title?.slice(0,80)}`
      ).join('\n');

      await sendTG(
        '📰 <b>Crypto News Alert</b>\n' +
        headlines + '\n' +
        'Source: CryptoPanic | Monitor for spread opportunities'
      );
      log(`News alert sent: ${highImpact.length} high-impact items`);
    }
  } catch(e) { log('News check error: '+e.message); }
}

// ── Run ───────────────────────────────────────────────────────────────────────
async function processKrakenListing(symbol, okxSymbols, bybitSymbols, config, newPairs) {
  try {
    // Check if listed on OKX or Bybit (needed for arb)
    const onOKX   = okxSymbols.has(symbol);
    const onBybit = bybitSymbols.has(symbol);

    if (!onOKX && !onBybit) {
      log(symbol + ': Kraken only — no OKX/Bybit listing, cannot arb');
      await sendTG('New Kraken listing: ' + symbol + ' (Kraken only — not on OKX/Bybit, no arb possible)');
      return;
    }

    // Check DEX liquidity and mint
    const mint = await findMint(symbol);
    const dex  = mint ? await checkDEXLiquidity(mint, LISTING_TRADE_SIZE) : { liquid: false, reason: 'No mint' };

    // Check OKX withdrawal if listed there
    let wd = { canWithdraw: false };
    if (onOKX) wd = await checkOKXWithdrawal(symbol);

    // Fee viability
    let feeUsd = 0, feePct = 0;
    if (wd.fee) {
      try {
        const cgr = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=' + symbol.toLowerCase() + '&vs_currencies=usd');
        const cgj = await cgr.json();
        const price = Object.values(cgj)[0]?.usd || 0;
        feeUsd  = wd.fee * price;
        feePct  = feeUsd / 120 * 100;
      } catch {}
    }
    const feeViable = feePct < 3.0 || feeUsd === 0;
    const viable    = (wd.canWithdraw || onBybit) && dex.liquid && feeViable;

    const exchanges = [onOKX?'OKX':'', onBybit?'Bybit':''].filter(Boolean).join('+');
    const alertMsg =
      (viable ? '[NEW]' : '[SKIP]') + ' Kraken listing: ' + symbol + '\n' +
      'Also on: ' + (exchanges || 'nowhere') + '\n' +
      'Withdrawal: ' + (wd.canWithdraw ? 'enabled' : 'disabled') + '\n' +
      'DEX: ' + (dex.liquid ? 'liquid' : 'illiquid') + '\n' +
      (feeUsd > 0 ? 'Fee: $' + feeUsd.toFixed(2) + ' (' + feePct.toFixed(1) + '%)\n' : '') +
      (viable ? '-> Adding to bot scan list' : '-> Not viable for arb');

    await sendTG(alertMsg);

    if (viable && mint) {
      // Add to new-pairs.json for bot to pick up
      const expiresAt = new Date(Date.now() + LISTING_MAX_AGE_HRS * 60 * 60 * 1000).toISOString();
      newPairs.push({
        symbol, exchange: 'Kraken+' + exchanges, mint,
        addedAt: Date.now(), expiresAt,
        wd: wd.canWithdraw, dexLiquid: dex.liquid,
        listingThreshold: LISTING_THRESHOLD,
        name: symbol + '/USDT',
        okxInstId: onOKX ? symbol + '-USDT' : null,
        bybitInstId: onBybit ? symbol + 'USDT' : null,
        outputMint: mint, decimals: 6, isNative: false,
        okxCcy: onOKX ? symbol : null, okxChain: onOKX ? symbol + '-Solana' : null,
        bybitCcy: onBybit ? symbol : null, bybitChain: onBybit ? 'SOL' : null,
        buyDexEnabled: dex.liquid,
      });
      if (!config.PAIR_MIN_SPREAD) config.PAIR_MIN_SPREAD = {};
      config.PAIR_MIN_SPREAD[symbol] = LISTING_THRESHOLD;
      writeJSON(CONFIG_FILE, config);
      log(symbol + ' auto-added to bot via Kraken detection');
    }
  } catch(e) { log('Kraken listing process error for ' + symbol + ': ' + e.message); }
}

async function recheckExistingNewPairs() {
  // Re-check viability of previously detected pairs
  // Withdrawal may have been enabled, or conditions changed
  const newPairs = readJSON(NEW_FILE) || [];
  const config = readJSON(CONFIG_FILE) || {};
  if (newPairs.length === 0) return;

  log('Re-checking ' + newPairs.length + ' existing new pair(s)...');
  for (const pair of newPairs) {
    if (!pair.mint) continue;
    try {
      const wd = pair.exchange === 'OKX' ? await checkOKXWithdrawal(pair.symbol) : { canWithdraw: true };
      const dex = await checkDEXLiquidity(pair.mint, 60);
      const nowViable = wd.canWithdraw && dex.liquid;

      if (nowViable && !pair.wd) {
        // Became viable — add to config
        if (!config.PAIR_MIN_SPREAD) config.PAIR_MIN_SPREAD = {};
        config.PAIR_MIN_SPREAD[pair.symbol] = LISTING_THRESHOLD;
        writeJSON(CONFIG_FILE, config);
        pair.wd = true;
        pair.dexLiquid = true;
        await sendTG('[NEW] ' + pair.symbol + ' withdrawal now enabled — added to bot scan list');
        log(pair.symbol + ' became viable — added to config');
      }
    } catch(e) { log('Recheck error for ' + pair.symbol + ': ' + e.message); }
  }
  writeJSON(NEW_FILE, newPairs);
}

async function run() {
  const result = await scanNewListings();
  await recheckExistingNewPairs();
  await checkNews();
  return result;
}

module.exports = { run, scanNewListings, checkNews, getCoinbasePairs };

if (require.main === module) {
  run().then(r => console.log('Scan complete:', r)).catch(e => console.error(e.message));
}
