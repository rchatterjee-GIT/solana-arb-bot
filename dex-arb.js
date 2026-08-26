/**
 * dex-arb.js — Pure DEX-DEX Arbitrage Bot
 * 
 * Monitors price differences between DEX routes on Solana:
 *   Jupiter (best aggregate) vs Raydium direct vs Orca direct
 * 
 * When the same token pair prices differently across DEXes:
 *   Buy on cheaper DEX → immediately sell on more expensive DEX
 *   Both transactions in same block (~400ms) — no withdrawal risk
 * 
 * Runs alongside existing CEX-DEX bot — same wallet, no interference.
 * Uses a separate USDC allocation (DEX_ARB_CAPITAL from .env)
 */

'use strict';
require('dotenv').config();
const {
  Connection, Keypair, PublicKey, VersionedTransaction,
} = require('@solana/web3.js');
const { getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');
const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const RPC_URL         = process.env.RPC_URL;
const PRIVATE_KEY     = JSON.parse(process.env.PRIVATE_KEY);
const TRADE_SIZE_USD  = parseFloat(process.env.DEX_ARB_CAPITAL || '200'); // separate capital pool
const MIN_SPREAD_PCT  = 0.15;  // 0.15% minimum spread to be worth it
const MAX_SLIPPAGE    = 50;    // 0.5% max slippage in bps
const SCAN_INTERVAL   = 15000;  // scan every 2 seconds
const COOLDOWN_MS     = 30000; // 10s cooldown per pair after trade

const TRADES_FILE     = path.join(__dirname, 'dex-arb-trades.json');
const STATUS_FILE     = path.join(__dirname, 'dex-arb-status.json');

const connection = new Connection(RPC_URL, 'confirmed');
const wallet     = Keypair.fromSecretKey(Uint8Array.from(PRIVATE_KEY));

// ── Token registry (Solana mints) ─────────────────────────────────────────────
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKENS = {
  JTO:   { mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',  decimals: 9 },
  SOL:   { mint: 'So11111111111111111111111111111111111111112',      decimals: 9 },
  WIF:   { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',  decimals: 6 },
  PENGU: { mint: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv',  decimals: 6 },
  BONK:  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',  decimals: 5 },
  W:     { mint: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ',  decimals: 6 },
  PNUT:  { mint: '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump',  decimals: 6 },
};

// DEX identifiers for Jupiter API dexes parameter
const DEX_ROUTES = {
  'Jupiter':  '',          // all routes (best aggregate)
  'Raydium':  'Raydium',
  'Orca':     'Orca',
  'Meteora':  'Meteora',
};

// State
let executing  = false;
let lastSpreads = {};
let paused     = false;
let totalPnl   = 0;
let totalTrades = 0;
let lastTrade  = {};  // symbol → timestamp (cooldown tracking)

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTG(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text, parse_mode: 'HTML' }),
    });
  } catch {}
}

// ── Jupiter quote ─────────────────────────────────────────────────────────────
async function getJupiterQuote(inputMint, outputMint, amountRaw, dex = '') {
  const dexParam = dex ? `&dexes=${encodeURIComponent(dex)}` : '';
  const url = `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${MAX_SLIPPAGE}${dexParam}&onlyDirectRoutes=${dex ? 'true' : 'false'}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(3000), headers: { "x-api-key": process.env.JUPITER_API_KEY } });
  if (!r.ok) throw new Error(`Jupiter quote HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`Jupiter: ${j.error}`);
  return j;
}

// ── Jupiter swap ──────────────────────────────────────────────────────────────
async function executeJupiterSwap(quoteResponse) {
  const r = await fetch('https://api.jup.ag/swap/v1/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: wallet.publicKey.toString(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
    signal: AbortSignal.timeout(5000),
  });
  const { swapTransaction, error } = await r.json();
  if (error) throw new Error(`Jupiter swap: ${error}`);

  const txBuf  = Buffer.from(swapTransaction, 'base64');
  const tx     = VersionedTransaction.deserialize(txBuf);
  tx.sign([wallet]);
  const sig    = await connection.sendTransaction(tx, { maxRetries: 2 });
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

// ── Scan for DEX-DEX opportunities ───────────────────────────────────────────
async function scanPair(symbol) {
  const token = TOKENS[symbol];
  if (!token) return null;

  const amountRaw = Math.floor(TRADE_SIZE_USD * 1_000_000); // USDC input (6 decimals)

  // Get prices from multiple DEX routes simultaneously
  const quotes = await Promise.allSettled(
    Object.entries(DEX_ROUTES).map(async ([name, dex]) => {
      const q = await getJupiterQuote(USDC_MINT, token.mint, amountRaw, dex);
      return { name, dex, outAmount: parseInt(q.outAmount), quote: q };
    })
  );

  const results = quotes
    .filter(q => q.status === 'fulfilled')
    .map(q => q.value)
    .sort((a, b) => b.outAmount - a.outAmount);

  if (results.length < 2) return null;

  const best  = results[0];  // most tokens out (buy here)
  const worst = results[results.length - 1]; // fewest tokens out

  // Spread = how much more best gives vs worst, as % of worst
  const spreadPct = (best.outAmount - worst.outAmount) / worst.outAmount * 100;

  // Now check reverse: sell best's tokens back to USDC
  // If we bought on best route, we have (best.outAmount) tokens
  // Sell those tokens on worst route's DEX for USDC
  if (spreadPct < MIN_SPREAD_PCT) return null;

  // Get reverse quote: token → USDC on the worst (most expensive) route
  const reverseQuote = await getJupiterQuote(
    token.mint, USDC_MINT, best.outAmount, worst.dex
  ).catch(() => null);

  if (!reverseQuote) return null;

  const usdcBack  = parseInt(reverseQuote.outAmount) / 1_000_000;
  const profit    = usdcBack - TRADE_SIZE_USD;
  const profitPct = profit / TRADE_SIZE_USD * 100;

  return {
    symbol, spreadPct, profit, profitPct,
    buyRoute: best.name, sellRoute: worst.name,
    buyQuote: best.quote, sellQuote: reverseQuote,
    tokensOut: best.outAmount / Math.pow(10, token.decimals),
    usdcBack,
  };
}

// ── Execute DEX-DEX arb ───────────────────────────────────────────────────────
async function executeArb(opp) {
  executing = true;
  const { symbol, spreadPct, profit, profitPct, buyRoute, sellRoute, buyQuote, sellQuote } = opp;

  try {
    await sendTG(
      `⚡ [DEX-ARB] ${symbol}\n` +
      `Spread: ${spreadPct.toFixed(3)}% | Est: +$${profit.toFixed(4)}\n` +
      `Buy: ${buyRoute} → Sell: ${sellRoute}\n` +
      `[1/2] Executing buy swap...`
    );

    // Step 1: Buy token on best route
    const buySig = await executeJupiterSwap(buyQuote);
    console.log(`[dex-arb] Buy confirmed: ${buySig}`);

    await sendTG(`⚡ [DEX-ARB] ${symbol} [2/2] Buy confirmed — executing sell...`);

    // Step 2: Sell token on sell route
    const sellSig = await executeJupiterSwap(sellQuote);
    console.log(`[dex-arb] Sell confirmed: ${sellSig}`);

    // Calculate actual profit
    const usdcMint = new PublicKey(USDC_MINT);
    const ata      = await getAssociatedTokenAddress(usdcMint, wallet.publicKey);
    const acc      = await getAccount(connection, ata);
    const actualUsdcOut = Number(acc.amount) / 1_000_000;

    const actualProfit = opp.usdcBack - TRADE_SIZE_USD;
    totalPnl    += actualProfit;
    totalTrades++;
    lastTrade[symbol] = Date.now();

    // Log trade
    const trade = {
      date: new Date().toISOString(), symbol, spreadPct, profit: actualProfit,
      profitPct, buyRoute, sellRoute, buySig, sellSig,
      outcome: actualProfit > 0 ? 'WIN' : 'LOSS',
    };
    const trades = JSON.parse(fs.existsSync(TRADES_FILE) ? fs.readFileSync(TRADES_FILE) : '[]');
    trades.push(trade);
    fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));

    await sendTG(
      `⚡ [DEX-ARB] ${symbol} COMPLETE\n` +
      `P&L: ${actualProfit >= 0 ? '+' : ''}$${actualProfit.toFixed(4)}\n` +
      `Total DEX arb P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(4)}`
    );

    return actualProfit;

  } catch(err) {
    console.error(`[dex-arb] Error: ${err.message}`);
    await sendTG(`❌ [DEX-ARB] ${symbol} failed: ${err.message.slice(0, 100)}`);
    lastTrade[symbol] = Date.now(); // still apply cooldown
    return null;
  } finally {
    executing = false;
  }
}

// ── Main scan loop ────────────────────────────────────────────────────────────
async function scan() {
  if (executing || paused) return;

  const opportunities = [];
  const spreads = {};

  for (const symbol of Object.keys(TOKENS)) {
    // Check cooldown
    if (lastTrade[symbol] && Date.now() - lastTrade[symbol] < COOLDOWN_MS) continue;

    try {
      const opp = await scanPair(symbol);
      if (opp) {
        spreads[symbol] = { spread: opp.spreadPct.toFixed(4)+'%', buy: opp.buyRoute, sell: opp.sellRoute, profit: opp.profit.toFixed(4) };
        if (opp.profit > 0) opportunities.push(opp);
      }
    } catch(e) {
      spreads[symbol] = 'error: '+e.message.slice(0,40);
    }
    await new Promise(r=>setTimeout(r,1000)); // 1s between pairs
  }

  // Update status
  lastSpreads = spreads;
  const status = {
    timestamp: new Date().toISOString(),
    scanning: Object.keys(TOKENS),
    opportunities: opportunities.map(o => ({
      symbol: o.symbol, spread: o.spreadPct.toFixed(3),
      estProfit: o.profit.toFixed(4), buy: o.buyRoute, sell: o.sellRoute,
    })),
    lastSpreads: lastSpreads,
    totalTrades, totalPnl, paused,
  };
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));

  if (opportunities.length > 0) {
    // Take best opportunity
    const best = opportunities.sort((a, b) => b.profit - a.profit)[0];
    console.log(`[dex-arb] Opportunity: ${best.symbol} ${best.spreadPct.toFixed(3)}% est $${best.profit.toFixed(4)} (${best.buyRoute} → ${best.sellRoute})`);
    await executeArb(best);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('⚡ DEX-DEX Arb Bot starting...');
  console.log(`   Wallet: ${wallet.publicKey.toString()}`);
  console.log(`   Trade size: $${TRADE_SIZE_USD}`);
  console.log(`   Min spread: ${MIN_SPREAD_PCT}%`);
  console.log(`   Pairs: ${Object.keys(TOKENS).join(', ')}`);

  // Check USDC balance
  const usdcMint = new PublicKey(USDC_MINT);
  const ata      = await getAssociatedTokenAddress(usdcMint, wallet.publicKey);
  const acc      = await getAccount(connection, ata);
  const balance  = Number(acc.amount) / 1_000_000;
  console.log(`   USDC balance: $${balance.toFixed(2)}`);

  if (balance < TRADE_SIZE_USD) {
    console.warn(`⚠️  USDC balance ($${balance}) below trade size ($${TRADE_SIZE_USD})`);
  }

  await sendTG(
    `⚡ [DEX-ARB] Bot started\n` +
    `Trade size: $${TRADE_SIZE_USD} | Min spread: ${MIN_SPREAD_PCT}%\n` +
    `Pairs: ${Object.keys(TOKENS).join(', ')}\n` +
    `USDC: $${balance.toFixed(2)}`
  );

  // Start scan loop
  setInterval(scan, SCAN_INTERVAL);
  scan(); // immediate first scan
}

main().catch(err => {
  console.error('DEX-ARB fatal:', err.message);
  process.exit(1);
});
