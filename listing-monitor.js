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

// ── Fetch all Gate.io spot pairs (scaffolded — ready when API keys added) ────
async function getGatePairs() {
  if (!process.env.GATE_API_KEY) return []; // not configured yet
  try {
    const r = await fetch('https://api.gateio.ws/api/v4/spot/currency_pairs');
    const j = await r.json();
    return (j||[])
      .filter(p => p.quote === 'USDT' && p.trade_status === 'tradable')
      .map(p => ({ symbol: p.base, instId: p.id }));
  } catch(e) { log('Gate.io pairs error: '+e.message); return []; }
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
  const [okxPairs, bybitPairs, krakenPairs, gatePairs] = await Promise.all([
    getOKXPairs(), getBybitPairs(), getKrakenPairs(), getGatePairs()
  ]);

  const okxSymbols    = new Set(okxPairs.map(p => p.symbol));
  const bybitSymbols  = new Set(bybitPairs.map(p => p.symbol));
  const krakenSymbols = new Set(krakenPairs.map(p => p.symbol));
  const gateSymbols   = new Set(gatePairs.map(p => p.symbol));

  // Find new listings on each exchange
  const newOKX    = okxPairs.filter(p => !(known.okx||[]).includes(p.symbol));
  const newBybit  = bybitPairs.filter(p => !(known.bybit||[]).includes(p.symbol));
  const newKraken = krakenPairs.filter(p => !(known.kraken||[]).includes(p.symbol));
  const newGate   = gatePairs.filter(p => !(known.gate||[]).includes(p.symbol));

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
  // Only alert on Kraken new listings if we had a previous scan (not first run)
  if (known.kraken && known.kraken.length > 0 && newKraken.length > 0 && newKraken.length < 10) {
    for (const pair of newKraken) {
      log('New Kraken listing: ' + pair.symbol);
      await sendTG('New Kraken listing: ' + pair.symbol + ' — check if available on OKX/Bybit for arb');
    }
  } else if (newKraken.length >= 10) {
    log('First Kraken scan — baseline set (' + krakenPairs.length + ' pairs, no alerts)');
  }
  // Only alert on Gate.io if we had a previous scan
  if (known.gate && known.gate.length > 0 && newGate.length > 0 && newGate.length < 10) {
    for (const pair of newGate) {
      log('New Gate.io listing: ' + pair.symbol);
      await sendTG('New Gate.io listing: ' + pair.symbol + ' — check if available on OKX/Bybit/DEX for arb');
    }
  } else if (newGate.length >= 10) {
    log('First Gate.io scan — baseline set (' + gatePairs.length + ' pairs, no alerts)');
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
  known.gate   = gatePairs.map(p => p.symbol);
  known.lastScan = new Date().toISOString();
  writeJSON(KNOWN_FILE, known);
  writeJSON(NEW_FILE, newPairs.filter(p => p.addedAt >= cutoff));

  return { newOKX: newOKX.length, newBybit: newBybit.length, newKraken: newKraken.length, newGate: newGate.length };
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

    // 5. Build alert
    const viable = wd.canWithdraw && dex.liquid;
    const emoji = viable ? '🚀' : '⚠️';

    const alertMsg =
      `${emoji} <b>New ${exchange} Listing: ${symbol}</b>\n` +
      `Withdrawal: ${wd.canWithdraw ? '✅ enabled' : '❌ disabled'}\n` +
      `DEX liquidity: ${dex.liquid ? '✅ liquid' : '❌ '+dex.reason}\n` +
      `Mint: ${mint ? mint.slice(0,8)+'...' : 'not found'}\n` +
      `${spreadInfo}\n` +
      (viable ? '→ Adding to bot scan list (threshold '+LISTING_THRESHOLD+'%)' : '→ Monitor only - not adding to bot');

    await sendTG(alertMsg);
    log(`${symbol} alert sent. Viable: ${viable}`);

    // 6. Add to bot if viable
    if (viable && mint) {
      // Add to new pairs tracking
      newPairs.push({
        symbol, exchange, mint, addedAt: Date.now(),
        wd: wd.canWithdraw, dexLiquid: dex.liquid,
      });

      // Add threshold config for this pair
      if (!config.PAIR_MIN_SPREAD) config.PAIR_MIN_SPREAD = {};
      config.PAIR_MIN_SPREAD[symbol] = LISTING_THRESHOLD;
      writeJSON(CONFIG_FILE, config);
      log(`${symbol} added to PAIR_MIN_SPREAD at ${LISTING_THRESHOLD}%`);
    }

  } catch(e) { log(`Error processing ${symbol}: ${e.message}`); }
}

// ── News monitoring via CryptoPanic ──────────────────────────────────────────
async function checkNews() {
  try {
    // CryptoPanic public API - no key needed for basic access
    const r = await fetch('https://cryptopanic.com/api/free/v1/posts/?auth_token=public&filter=hot&currencies=BTC,ETH,SOL,JTO,PENGU&kind=news');
    const j = await r.json();
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
async function run() {
  const result = await scanNewListings();
  await checkNews();
  return result;
}

module.exports = { run, scanNewListings, checkNews };

if (require.main === module) {
  run().then(r => console.log('Scan complete:', r)).catch(e => console.error(e.message));
}
