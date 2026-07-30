require('dotenv').config();
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────────
const CHECK_INTERVAL_MS      = 60_000;       // check every 60 seconds
const NEW_PAIR_MONITOR_HOURS = 24;           // monitor new pairs for 24hrs
const MAX_WITHDRAWAL_FEE_PCT = 5.0;
const TRADE_SIZE_USD         = 40;
const KNOWN_PAIRS_FILE       = path.join(__dirname, 'known-pairs.json');
const NEW_PAIRS_FILE         = path.join(__dirname, 'new-pairs.json');
const CRASH_LOG              = path.join(__dirname, 'crash.log');

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ── Tokens to always ignore ───────────────────────────────────────────────────
const IGNORE_LIST = new Set([
  // Stablecoins
  'USDT','USDC','BUSD','TUSD','USDP','GUSD','FRAX','LUSD','SUSD','DAI',
  // Wrapped/bridged
  'WBTC','WETH','WBNB','WMATIC','WAVAX',
  // Non-Solana tokens we already know aren't on Solana
  'BTC','ETH','BNB','XRP','ADA','MATIC','DOT','AVAX','LINK','UNI',
  'LTC','BCH','ATOM','FIL','VET','THETA','XLM','ALGO','ICP','FTM',
  'SAND','MANA','AXS','ENJ','CHZ','BAT','ZRX','COMP','AAVE','MKR',
  'SNX','YFI','SUSHI','CRV','BAL','DYDX','GRT','LRC','OMG','ZEC',
  // Leveraged/synthetic tokens
  'BTCUP','BTCDOWN','ETHUP','ETHDOWN',
  // Fiat-backed
  'EURT','GBPT','JPYT',
  // Already in bot
  'SOL','JTO','WIF','BONK','JUP','PYTH','RAY','W','POPCAT','MEW',
  'BOME','TRUMP','ZEUS','RENDER','PNUT','GOAT','PENGU',
]);

// ── Telegram ──────────────────────────────────────────────────────────────────
async function tgSend(text) {
  try {
    const token  = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (e) { /* ignore */ }
}

function logCrash(context, err) {
  const msg = `${new Date().toISOString()} [LISTING-MONITOR:${context}] ${err?.message || err}\n${err?.stack || ''}\n\n`;
  try { fs.appendFileSync(CRASH_LOG, msg); } catch (e) {}
  console.error(`💥 [${context}]`, err?.message || err);
}

// ── OKX signing ───────────────────────────────────────────────────────────────
function okxHeaders(method, path, body = '') {
  const timestamp = new Date().toISOString();
  const sign      = crypto.createHmac('sha256', process.env.OKX_API_SECRET)
    .update(timestamp + method + path + body).digest('base64');
  return {
    'Content-Type':         'application/json',
    'OK-ACCESS-KEY':        process.env.OKX_API_KEY,
    'OK-ACCESS-SIGN':       sign,
    'OK-ACCESS-TIMESTAMP':  timestamp,
    'OK-ACCESS-PASSPHRASE': process.env.OKX_PASSPHRASE,
  };
}

async function okxPrivate(method, path) {
  const res = await fetch(`https://www.okx.com${path}`, {
    method, headers: okxHeaders(method, path),
  });
  return res.json();
}

// ── Load/save known pairs ─────────────────────────────────────────────────────
function loadKnownPairs() {
  try {
    if (fs.existsSync(KNOWN_PAIRS_FILE)) {
      return JSON.parse(fs.readFileSync(KNOWN_PAIRS_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return { okx: [], bybit: [], lastUpdated: null };
}

function saveKnownPairs(data) {
  try {
    fs.writeFileSync(KNOWN_PAIRS_FILE, JSON.stringify({ ...data, lastUpdated: new Date().toISOString() }, null, 2));
  } catch (e) { /* ignore */ }
}

// ── Load/save new pairs ───────────────────────────────────────────────────────
function loadNewPairs() {
  try {
    if (fs.existsSync(NEW_PAIRS_FILE)) {
      return JSON.parse(fs.readFileSync(NEW_PAIRS_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return [];
}

function saveNewPairs(pairs) {
  try {
    fs.writeFileSync(NEW_PAIRS_FILE, JSON.stringify(pairs, null, 2));
  } catch (e) { /* ignore */ }
}

// ── Fetch all OKX SPOT pairs ──────────────────────────────────────────────────
async function fetchOKXPairs() {
  try {
    const r = await fetch('https://www.okx.com/api/v5/market/tickers?instType=SPOT');
    const j = await r.json();
    return new Set(
      (j.data || [])
        .filter(t => t.instId.endsWith('-USDT'))
        .map(t => t.instId.replace('-USDT', ''))
    );
  } catch (err) {
    logCrash('fetchOKXPairs', err);
    return new Set();
  }
}

// ── Fetch all Bybit SPOT pairs ────────────────────────────────────────────────
async function fetchBybitPairs() {
  try {
    const r = await fetch('https://api.bybit.com/v5/market/tickers?category=spot');
    const j = await r.json();
    return new Set(
      (j.result?.list || [])
        .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('X'))
        .map(t => t.symbol.replace('USDT', ''))
    );
  } catch (err) {
    logCrash('fetchBybitPairs', err);
    return new Set();
  }
}

// ── Check OKX Solana withdrawal ───────────────────────────────────────────────
async function checkOKXWithdrawal(ccy) {
  try {
    const path = `/api/v5/asset/currencies?ccy=${ccy}`;
    const r    = await okxPrivate('GET', path);
    const sol  = (r.data || []).find(d => d.chain?.includes('Solana'));
    if (!sol) return null;

    const priceR = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${ccy}-USDT`);
    const priceJ = await priceR.json();
    const price  = parseFloat(priceJ.data?.[0]?.last || '0');
    if (!price) return null;

    const fee       = parseFloat(sol.minFee);
    const minWd     = parseFloat(sol.minWd);
    const precision = parseInt(sol.wdTickSz) || 8;
    const bought    = TRADE_SIZE_USD / price;
    const feePct    = (fee / bought) * 100;

    return {
      chain: sol.chain,
      fee:   sol.minFee,
      minWd,
      precision,
      feePct: parseFloat(feePct.toFixed(2)),
      viable: bought >= minWd && feePct <= MAX_WITHDRAWAL_FEE_PCT,
      price,
    };
  } catch (err) {
    return null;
  }
}

// ── Check Bybit Solana withdrawal ─────────────────────────────────────────────
async function checkBybitWithdrawal(ccy) {
  try {
    const r      = await fetch(`https://api.bybit.com/v5/asset/coin/query-info?coin=${ccy}`);
    const j      = await r.json();
    const chains = j.result?.rows?.[0]?.chains || [];
    const sol    = chains.find(c => c.chain === 'SOL' || c.chainType?.includes('Solana'));
    if (!sol) return null;

    const priceR = await fetch(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${ccy}USDT`);
    const priceJ = await priceR.json();
    const price  = parseFloat(priceJ.result?.list?.[0]?.lastPrice || '0');
    if (!price) return null;

    const fee    = parseFloat(sol.withdrawFee || '0');
    const minWd  = parseFloat(sol.minWithdraw || '0');
    const bought = TRADE_SIZE_USD / price;
    const feePct = (fee / bought) * 100;

    return {
      chain:  sol.chain,
      fee:    sol.withdrawFee,
      minWd,
      feePct: parseFloat(feePct.toFixed(2)),
      viable: bought >= minWd && feePct <= MAX_WITHDRAWAL_FEE_PCT,
      price,
    };
  } catch (err) {
    return null;
  }
}

// ── Check Jupiter liquidity ───────────────────────────────────────────────────
async function checkJupiterLiquidity(mint, decimals) {
  try {
    const r = await fetch(
      `https://api.jup.ag/swap/v1/quote?inputMint=${USDC_MINT}&outputMint=${mint}&amount=40000000&slippageBps=100`,
      { headers: { 'x-api-key': process.env.JUPITER_API_KEY } }
    );
    const j = await r.json();
    if (!j.outAmount) return null;
    return {
      outAmount: j.outAmount,
      tokens:    j.outAmount / Math.pow(10, decimals),
    };
  } catch (err) {
    return null;
  }
}

// ── Lookup token mint from Jupiter token list ─────────────────────────────────
async function lookupMint(ccy) {
  try {
    // Try Jupiter token list
    const r = await fetch(`https://tokens.jup.ag/token/${ccy}`);
    if (r.ok) {
      const j = await r.json();
      if (j.address) return { mint: j.address, decimals: j.decimals || 6 };
    }

    // Try Jupiter search
    const r2 = await fetch(`https://tokens.jup.ag/tokens?tags=verified`);
    const j2 = await r2.json();
    const match = (j2 || []).find(t =>
      t.symbol?.toUpperCase() === ccy.toUpperCase() &&
      t.chainId === 101  // Solana mainnet
    );
    if (match) return { mint: match.address, decimals: match.decimals || 6 };

    return null;
  } catch (err) {
    return null;
  }
}

// ── Process a newly detected token ───────────────────────────────────────────
async function processNewToken(ccy, sources) {
  console.log(`\n🆕 New token detected: ${ccy} on ${sources.join(', ')}`);

  try {
    // Step 1 — find mint address
    const mintInfo = await lookupMint(ccy);
    if (!mintInfo) {
      console.log(`  ❌ ${ccy}: Could not find Solana mint address`);
      return null;
    }
    console.log(`  ✅ Mint: ${mintInfo.mint} (${mintInfo.decimals} decimals)`);

    // Step 2 — check Jupiter liquidity
    const jup = await checkJupiterLiquidity(mintInfo.mint, mintInfo.decimals);
    if (!jup) {
      console.log(`  ❌ ${ccy}: No Jupiter liquidity`);
      return null;
    }
    console.log(`  ✅ Jupiter: $40 buys ${jup.tokens.toFixed(4)} tokens`);

    // Step 3 — check OKX withdrawal
    let okxInfo   = null;
    let bybitInfo = null;

    if (sources.includes('OKX')) {
      okxInfo = await checkOKXWithdrawal(ccy);
      if (okxInfo) {
        console.log(`  ${okxInfo.viable ? '✅' : '⚠️ '} OKX: chain=${okxInfo.chain} fee=${okxInfo.feePct}% ${okxInfo.viable ? 'viable' : 'HIGH FEE'}`);
      } else {
        console.log(`  ❌ OKX: No Solana withdrawal`);
      }
    }

    if (sources.includes('Bybit')) {
      bybitInfo = await checkBybitWithdrawal(ccy);
      if (bybitInfo) {
        console.log(`  ${bybitInfo.viable ? '✅' : '⚠️ '} Bybit: chain=${bybitInfo.chain} fee=${bybitInfo.feePct}% ${bybitInfo.viable ? 'viable' : 'HIGH FEE'}`);
      } else {
        console.log(`  ❌ Bybit: No Solana withdrawal`);
      }
    }

    // At least one exchange must have viable withdrawal
    const okxViable   = okxInfo?.viable === true;
    const bybitViable = bybitInfo?.viable === true;

    if (!okxViable && !bybitViable) {
      console.log(`  ❌ ${ccy}: No viable withdrawal on any exchange`);
      return null;
    }

    const newPair = {
      ccy,
      mint:          mintInfo.mint,
      decimals:      mintInfo.decimals,
      detectedAt:    new Date().toISOString(),
      expiresAt:     new Date(Date.now() + NEW_PAIR_MONITOR_HOURS * 60 * 60 * 1000).toISOString(),
      sources,
      okx:           okxInfo,
      bybit:         bybitInfo,
      okxViable,
      bybitViable,
      okxInstId:     `${ccy}-USDT`,
      bybitInstId:   bybitInfo ? `${ccy}USDT` : null,
      okxChain:      okxInfo?.chain || null,
      bybitChain:    bybitInfo ? 'SOL' : null,
    };

    // Alert Telegram
    const exchangeStr = [
      okxViable   ? `OKX (fee=${okxInfo.feePct}%)`   : null,
      bybitViable ? `Bybit (fee=${bybitInfo.feePct}%)` : null,
    ].filter(Boolean).join(', ');

    await tgSend(
      `🆕 <b>New listing detected: ${ccy}/USDT</b>\n\n` +
      `Price: $${okxInfo?.price || bybitInfo?.price}\n` +
      `Mint: <code>${mintInfo.mint}</code>\n` +
      `Jupiter: ✅ $40 buys ${jup.tokens.toFixed(2)} tokens\n` +
      `Exchanges: ${exchangeStr}\n\n` +
      `<b>Bot now monitoring for ${NEW_PAIR_MONITOR_HOURS}hrs</b>\n` +
      `BUY_CEX threshold: ≥1.2%\n` +
      `BUY_DEX threshold: ≥3.0%`
    );

    console.log(`  ✅ ${ccy} added to monitoring for ${NEW_PAIR_MONITOR_HOURS}hrs`);
    return newPair;

  } catch (err) {
    logCrash(`processNewToken:${ccy}`, err);
    return null;
  }
}

// ── Write new pairs to shared file for bot to read ───────────────────────────
function updateSharedPairsFile(activePairs) {
  try {
    const botPairs = activePairs.map(p => ({
      name:        `${p.ccy}/USDT`,
      okxInstId:   p.okxInstId,
      bybitInstId: p.bybitInstId,
      outputMint:  p.mint,
      decimals:    p.decimals,
      dex:         null,
      isNative:    false,
      okxCcy:      p.ccy,
      okxChain:    p.okxChain,
      bybitCcy:    p.bybitViable ? p.ccy : null,
      bybitChain:  p.bybitChain,
      isNew:       true,
      expiresAt:   p.expiresAt,
    }));
    fs.writeFileSync(NEW_PAIRS_FILE, JSON.stringify(botPairs, null, 2));
    console.log(`  📝 Shared pairs file updated: ${botPairs.length} new pairs`);
  } catch (err) {
    logCrash('updateSharedPairsFile', err);
  }
}

// ── Main check loop ───────────────────────────────────────────────────────────
async function check() {
  try {
    const [okxPairs, bybitPairs] = await Promise.all([
      fetchOKXPairs(),
      fetchBybitPairs(),
    ]);

    const known    = loadKnownPairs();
    const newPairs = loadNewPairs();

    // First run — just save known pairs, don't alert
    const isFirstRun = !known.lastUpdated;
    if (isFirstRun) {
      console.log(`📋 First run — recording ${okxPairs.size} OKX + ${bybitPairs.size} Bybit pairs as baseline`);
      saveKnownPairs({ okx: [...okxPairs], bybit: [...bybitPairs] });
      await tgSend(
        `👁️ <b>Listing monitor started</b>\n` +
        `Watching ${okxPairs.size} OKX pairs + ${bybitPairs.size} Bybit pairs\n` +
        `Checking every 60 seconds for new Solana listings`
      );
      return;
    }

    const knownOKX   = new Set(known.okx || []);
    const knownBybit = new Set(known.bybit || []);

    // Find new tokens
    const newOnOKX   = [...okxPairs].filter(t => !knownOKX.has(t) && !IGNORE_LIST.has(t));
    const newOnBybit = [...bybitPairs].filter(t => !knownBybit.has(t) && !IGNORE_LIST.has(t));

    // Combine — token may appear on one or both
    const newTokens = new Map();
    for (const t of newOnOKX)   newTokens.set(t, [...(newTokens.get(t) || []), 'OKX']);
    for (const t of newOnBybit) newTokens.set(t, [...(newTokens.get(t) || []), 'Bybit']);

    if (newTokens.size > 0) {
      console.log(`\n🔔 ${newTokens.size} new token(s) detected: ${[...newTokens.keys()].join(', ')}`);
    }

    // Process each new token
    const updatedNewPairs = [...newPairs];
    for (const [ccy, sources] of newTokens.entries()) {
      // Skip if already being monitored
      if (updatedNewPairs.find(p => p.okxCcy === ccy)) {
        console.log(`  ⏭️  ${ccy} already monitored`);
        continue;
      }

      await new Promise(r => setTimeout(r, 1000));
      const result = await processNewToken(ccy, sources);
      if (result) {
        updatedNewPairs.push(result);
      }
    }

    // Remove expired pairs
    const now     = Date.now();
    const expired = updatedNewPairs.filter(p => new Date(p.expiresAt).getTime() < now);
    if (expired.length > 0) {
      console.log(`\n⏰ Expiring ${expired.length} pair(s): ${expired.map(p => p.ccy).join(', ')}`);
      for (const p of expired) {
        await tgSend(`⏰ <b>${p.ccy}/USDT monitoring expired</b>\nRemoved after ${NEW_PAIR_MONITOR_HOURS}hrs`);
        IGNORE_LIST.add(p.ccy);
      }
    }
    const activePairs = updatedNewPairs.filter(p => new Date(p.expiresAt).getTime() >= now);

    // Save state
    saveNewPairs(activePairs);
    updateSharedPairsFile(activePairs);
    saveKnownPairs({ okx: [...okxPairs], bybit: [...bybitPairs] });

    const ts = new Date().toLocaleTimeString();
    console.log(`[${ts}] ✅ Check complete — OKX: ${okxPairs.size} pairs | Bybit: ${bybitPairs.size} pairs | Monitoring: ${activePairs.length} new`);

  } catch (err) {
    logCrash('check', err);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  const msg = `${new Date().toISOString()} LISTING-MONITOR CRASH: ${err.message}\n${err.stack}\n\n`;
  console.error('💥 Listing monitor crash:', err.message);
  try { fs.appendFileSync(CRASH_LOG, msg); } catch (e) {}
});

process.on('unhandledRejection', (reason) => {
  const msg = `${new Date().toISOString()} LISTING-MONITOR REJECTION: ${reason}\n\n`;
  console.error('💥 Listing monitor rejection:', reason);
  try { fs.appendFileSync(CRASH_LOG, msg); } catch (e) {}
});

console.log('👁️  Listing monitor started');
console.log(`   Check interval:  ${CHECK_INTERVAL_MS / 1000}s`);
console.log(`   Monitor period:  ${NEW_PAIR_MONITOR_HOURS}hrs per new listing`);
console.log(`   Max fee:         ${MAX_WITHDRAWAL_FEE_PCT}%`);
console.log(`   Ignore list:     ${IGNORE_LIST.size} tokens\n`);

check();
setInterval(check, CHECK_INTERVAL_MS);