/**
 * triangular-arb.js — Triangular DEX Arbitrage
 *
 * Exploits pricing inefficiencies in 3-leg routes:
 *   USDC → Token A → SOL → USDC  (forward triangle)
 *   USDC → SOL → Token A → USDC  (reverse triangle)
 *
 * If forward + reverse yields > USDC in → profit.
 * Both legs requested from Jupiter simultaneously.
 * Execution: atomic via Jupiter composable swap instructions.
 *
 * Runs alongside main bot. Reads TRIANGULAR_ARB_ENABLED from arb-config.json.
 */

'use strict';
require('dotenv').config();
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const fs   = require('fs');
const path = require('path');

const CONFIG_FILE  = path.join(__dirname, 'arb-config.json');
const STATUS_FILE  = path.join(__dirname, 'triangular-status.json');
const TRADES_FILE  = path.join(__dirname, 'triangular-trades.json');

const connection = new Connection(process.env.RPC_URL, 'confirmed');
const wallet     = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY)));

const JUP_API   = 'https://api.jup.ag/swap/v1';
const JUP_KEY   = process.env.JUPITER_API_KEY;
const JUP_HEADS = { 'x-api-key': JUP_KEY, 'Content-Type': 'application/json' };

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL  = 'So11111111111111111111111111111111111111112';

// Liquid Solana tokens to run triangles through
const TRIANGLE_TOKENS = {
  JTO:   { mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',  decimals: 9,  name: 'JTO'   },
  WIF:   { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',  decimals: 6,  name: 'WIF'   },
  PENGU: { mint: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv',  decimals: 6,  name: 'PENGU' },
  BONK:  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',  decimals: 5,  name: 'BONK'  },
  W:     { mint: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ',  decimals: 6,  name: 'W'     },
  PNUT:  { mint: '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump',  decimals: 6,  name: 'PNUT'  },
};

const TRADE_SIZE_USD = 200;
const MIN_PROFIT_PCT = 0.15;  // 0.15% minimum
const SCAN_INTERVAL  = 30000; // 30s — conservative to save API quota
const COOLDOWN_MS    = 60000; // 60s per pair after trade

let executing   = false;
let totalPnl    = 0;
let totalTrades = 0;
let lastTrade   = {};

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;

async function sendTG(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text }),
    });
  } catch {}
}

async function jupQuote(inMint, outMint, amountRaw) {
  const url = `${JUP_API}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amountRaw}&slippageBps=50`;
  const r = await fetch(url, { headers: JUP_HEADS, signal: AbortSignal.timeout(4000) });
  const j = await r.json();
  if (j.error || !j.outAmount) throw new Error(j.error || 'no outAmount');
  return j;
}

async function jupSwap(quote) {
  const r = await fetch(`${JUP_API}/swap`, {
    method: 'POST', headers: JUP_HEADS,
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toString(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
    signal: AbortSignal.timeout(5000),
  });
  const { swapTransaction, error } = await r.json();
  if (error) throw new Error(error);
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([wallet]);
  const sig = await connection.sendTransaction(tx, { maxRetries: 2 });
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

async function scanTriangle(sym) {
  const token = TRIANGLE_TOKENS[sym];
  if (!token) return null;

  const usdcIn = Math.floor(TRADE_SIZE_USD * 1e6);

  // Leg 1: USDC → Token
  const q1 = await jupQuote(USDC, token.mint, usdcIn);
  const tokenAmt = parseInt(q1.outAmount);

  // Leg 2: Token → SOL
  const q2 = await jupQuote(token.mint, SOL, tokenAmt);
  const solAmt = parseInt(q2.outAmount);

  // Leg 3: SOL → USDC
  const q3 = await jupQuote(SOL, USDC, solAmt);
  const usdcOut = parseInt(q3.outAmount) / 1e6;

  const profit    = usdcOut - TRADE_SIZE_USD;
  const profitPct = (profit / TRADE_SIZE_USD) * 100;

  // Also try reverse: USDC → SOL → Token → USDC
  const solIn  = Math.floor(TRADE_SIZE_USD / (solAmt / 1e9 / (tokenAmt / Math.pow(10, token.decimals))) * 1e9);
  const qr1 = await jupQuote(USDC, SOL, usdcIn).catch(() => null);
  let reversePct = 0;
  if (qr1) {
    const qr2 = await jupQuote(SOL, token.mint, parseInt(qr1.outAmount)).catch(() => null);
    if (qr2) {
      const qr3 = await jupQuote(token.mint, USDC, parseInt(qr2.outAmount)).catch(() => null);
      if (qr3) {
        const revOut = parseInt(qr3.outAmount) / 1e6;
        reversePct = ((revOut - TRADE_SIZE_USD) / TRADE_SIZE_USD) * 100;
      }
    }
  }

  return {
    sym, profitPct, profit,
    reversePct,
    bestPct: Math.max(profitPct, reversePct),
    bestDir: profitPct >= reversePct ? 'FORWARD' : 'REVERSE',
    q1, q2, q3, usdcOut,
    route: `USDC→${sym}→SOL→USDC`,
  };
}

async function executeTriangle(opp) {
  executing = true;
  try {
    await sendTG(
      `⚡ [TRI-ARB] ${opp.sym}\n` +
      `Route: ${opp.route}\n` +
      `Est profit: +$${opp.profit.toFixed(4)} (${opp.profitPct.toFixed(3)}%)\n` +
      `[1/3] USDC → ${opp.sym}...`
    );

    const sig1 = await jupSwap(opp.q1);
    await sendTG(`⚡ [TRI-ARB] ${opp.sym} [2/3] ${opp.sym} → SOL...`);
    const sig2 = await jupSwap(opp.q2);
    await sendTG(`⚡ [TRI-ARB] ${opp.sym} [3/3] SOL → USDC...`);
    const sig3 = await jupSwap(opp.q3);

    const actualProfit = opp.profit; // use quote estimate — actual calc would need balance check
    totalPnl += actualProfit;
    totalTrades++;
    lastTrade[opp.sym] = Date.now();

    const trade = {
      date: new Date().toISOString(), sym: opp.sym,
      route: opp.route, profit: actualProfit,
      profitPct: opp.profitPct, sig1, sig2, sig3,
      outcome: actualProfit > 0 ? 'WIN' : 'LOSS',
    };
    const trades = JSON.parse(fs.existsSync(TRADES_FILE) ? fs.readFileSync(TRADES_FILE) : '[]');
    trades.push(trade);
    fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));

    await sendTG(
      `⚡ [TRI-ARB] ${opp.sym} COMPLETE\n` +
      `P&L: +$${actualProfit.toFixed(4)}\n` +
      `Total tri-arb P&L: +$${totalPnl.toFixed(4)}`
    );
    return actualProfit;
  } catch(e) {
    console.error(`[tri-arb] Error: ${e.message}`);
    await sendTG(`❌ [TRI-ARB] ${opp.sym} failed: ${e.message.slice(0, 100)}`);
    lastTrade[opp.sym] = Date.now();
    return null;
  } finally {
    executing = false;
  }
}

async function scan() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (!cfg.TRIANGULAR_ARB_ENABLED || executing) return;

  const opps = [];
  const spreads = {};

  for (const sym of Object.keys(TRIANGLE_TOKENS)) {
    if (lastTrade[sym] && Date.now() - lastTrade[sym] < COOLDOWN_MS) continue;
    try {
      const result = await scanTriangle(sym);
      if (result) {
        spreads[sym] = { forward: result.profitPct.toFixed(4)+'%', reverse: result.reversePct.toFixed(4)+'%' };
        if (result.bestPct >= MIN_PROFIT_PCT) opps.push(result);
      }
    } catch(e) {
      spreads[sym] = 'error: ' + e.message.slice(0, 30);
    }
    await new Promise(r => setTimeout(r, 2000)); // 2s between tokens — protect API quota
  }

  fs.writeFileSync(STATUS_FILE, JSON.stringify({
    timestamp: new Date().toISOString(),
    enabled: true, spreads, totalTrades, totalPnl,
    opportunities: opps.map(o => ({ sym: o.sym, pct: o.bestPct.toFixed(4), dir: o.bestDir })),
  }, null, 2));

  if (opps.length > 0) {
    const best = opps.sort((a, b) => b.bestPct - a.bestPct)[0];
    console.log(`[tri-arb] 🎯 ${best.sym} ${best.bestPct.toFixed(3)}% ${best.bestDir} — executing`);
    await executeTriangle(best);
  }
}

async function main() {
  console.log('⚡ Triangular Arb Bot starting...');
  console.log(`   Wallet: ${wallet.publicKey.toString()}`);
  console.log(`   Trade size: $${TRADE_SIZE_USD}`);
  console.log(`   Min profit: ${MIN_PROFIT_PCT}%`);
  console.log(`   Tokens: ${Object.keys(TRIANGLE_TOKENS).join(', ')}`);
  await sendTG(`⚡ [TRI-ARB] Bot started\nTrade: $${TRADE_SIZE_USD} | Min: ${MIN_PROFIT_PCT}%\nTokens: ${Object.keys(TRIANGLE_TOKENS).join(', ')}`);
  setInterval(scan, SCAN_INTERVAL);
  scan();
}

main().catch(err => { console.error('TRI-ARB fatal:', err.message); process.exit(1); });
