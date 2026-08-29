/**
 * rebalance.js — Omni-directional rebalance v5.0
 *
 * Ported from v4 okx-arb.js with clean separation of concerns.
 *
 * Supported routes:
 *   OKX    → Solana    USDT-Solana withdrawal → swap USDT→USDC
 *   OKX    → Bybit     Pre-whitelisted Bybit address
 *   OKX    → Kraken    Pre-whitelisted Kraken Solana address
 *   Bybit  → Solana    USDT-SOL withdrawal
 *   Bybit  → OKX       USDT to OKX deposit address
 *   Kraken → Solana    Named withdrawal key 'solana-bot'
 *   Solana → OKX       USDC→USDT swap then send to OKX deposit address
 *   Solana → Bybit     USDC→USDT swap then send to Bybit deposit address
 *
 * Usage:
 *   const rb = require('./rebalance');
 *   const plan = await rb.buildPlan(balances);  // shows what would move
 *   await rb.execute(plan, tg);                  // executes moves
 */

'use strict';
require('dotenv').config();
const { Connection, Keypair, PublicKey, Transaction } = require('@solana/web3.js');
const { getAssociatedTokenAddress, getAccount, createTransferInstruction, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const crypto = require('crypto');
const path   = require('path');

const okx    = require('./exchanges/okx');
const bybit  = require('./exchanges/bybit');
const kraken = require('./exchanges/kraken');
const jup    = require('./exchanges/jupiter');

const connection = new Connection(process.env.RPC_URL, 'confirmed');
const wallet     = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY)));

const OKX_CREDS    = { key: process.env.OKX_API_KEY, secret: process.env.OKX_API_SECRET, passphrase: process.env.OKX_PASSPHRASE };
const BYBIT_CREDS  = { key: process.env.BYBIT_API_KEY, secret: process.env.BYBIT_API_SECRET };
const KRAKEN_CREDS = { key: process.env.KRAKEN_API_KEY, secret: process.env.KRAKEN_API_SECRET };
const JUP_KEY      = process.env.JUPITER_API_KEY;

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

// Pre-whitelisted addresses (configured in OKX address book)
const BYBIT_USDT_ADDR   = '6VmfatJMwwPqbvMuqKzgZhcyQWgHLJDwiJCpdcA28Kwt';
const KRAKEN_USDT_ADDR  = 'CJoM8s3uaPRV4gfAB1Ru2QXp8E6AVm8uWyWnHxFYnaSL';
const COINBASE_USDC_ADDR = process.env.COINBASE_DEPOSIT_ADDRESS || 'CnggS74Y3VoFkmNZyqasSjhoLYFzpiKBgdxeNveKHrUC';

const OKX_SOLANA_FEE = 0.29;   // USDT fee for USDT-Solana withdrawal
const THRESHOLD      = 0.08;   // 8% tolerance
const MIN_MOVE       = 20;     // minimum $20 to bother moving

let rebalancing = false;

// ── Route map ─────────────────────────────────────────────────────────────────
const ROUTES = {
  'OKX-Solana':      'okx-to-sol',
  'OKX-Bybit':       'okx-to-bybit',
  'OKX-Kraken':      'okx-to-kraken',
  'Bybit-Solana':    'bybit-to-sol',
  'Bybit-OKX':       'bybit-to-okx',
  'Solana-OKX':      'sol-to-okx',
  'Solana-Bybit':    'sol-to-bybit',
  'Kraken-Solana':   'kraken-to-sol',
  'Coinbase-Solana': 'coinbase-to-sol',
  'Solana-Coinbase': 'sol-to-coinbase',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getOKXDepositAddress(ccy, chain) {
  const ts  = new Date().toISOString();
  const p   = '/api/v5/asset/deposit-address?ccy=' + ccy;
  const sig = crypto.createHmac('sha256', OKX_CREDS.secret).update(ts + 'GET' + p).digest('base64');
  const r   = await fetch('https://www.okx.com' + p, {
    headers: { 'OK-ACCESS-KEY': OKX_CREDS.key, 'OK-ACCESS-SIGN': sig, 'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': OKX_CREDS.passphrase },
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  const addr = (j.data || []).find(a => a.chain === chain)?.addr;
  if (!addr) throw new Error('No OKX deposit address for ' + ccy + ' on ' + chain);
  return addr;
}

async function withdrawFromOKX(ccy, amount, toAddress, chain) {
  const fee    = OKX_SOLANA_FEE;
  const netAmt = (amount - fee).toFixed(2);

  // 1. Transfer to funding account
  console.log('[rebalance] OKX: transferring $' + amount + ' to funding...');
  await okx.transferToFunding(ccy, amount.toFixed(2), OKX_CREDS);

  // 2. Poll until funding balance confirms
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const fundBal = await okx.getFundingBalance(ccy, OKX_CREDS);
    if (fundBal >= amount * 0.99) break;
    console.log('[rebalance] OKX funding: $' + fundBal.toFixed(2) + ' (waiting...)');
  }

  await new Promise(r => setTimeout(r, 10000)); // extra wait for settlement

  // 3. Withdraw
  console.log('[rebalance] OKX: withdrawing $' + netAmt + ' to ' + toAddress.slice(0, 12) + '...');
  const wdId = await okx.withdraw(ccy, netAmt, toAddress, 'Solana', OKX_CREDS, fee.toString());
  console.log('[rebalance] OKX withdrawal ID: ' + wdId);
  return wdId;
}

async function pollForUSDT(expectedUsd, timeoutMs = 300000) {
  console.log('[rebalance] Polling for USDT arrival on Solana...');
  const usdtMint = new PublicKey(USDT_MINT);
  const ata      = await getAssociatedTokenAddress(usdtMint, wallet.publicKey);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10000));
    try {
      const acc = await getAccount(connection, ata);
      const bal = Number(acc.amount) / 1e6;
      console.log('[rebalance] Solana USDT: $' + bal.toFixed(2) + ' (waiting for $' + expectedUsd.toFixed(2) + ')');
      if (bal >= expectedUsd * 0.90) return bal;
    } catch {}
  }
  throw new Error('USDT did not arrive on Solana within ' + (timeoutMs / 60000).toFixed(0) + ' minutes');
}

async function swapUSDTtoUSDC(amount) {
  console.log('[rebalance] Swapping USDT→USDC on Jupiter...');
  const rawIn = Math.floor(amount * 1e6);
  const { sig, outAmount } = await jup.swap(USDT_MINT, USDC_MINT, rawIn, wallet, connection, JUP_KEY, 100);
  const usdcOut = outAmount / 1e6;
  console.log('[rebalance] Swapped: $' + amount.toFixed(2) + ' USDT → $' + usdcOut.toFixed(2) + ' USDC | ' + sig);
  return usdcOut;
}

async function swapUSDCtoUSDT(amount) {
  console.log('[rebalance] Swapping USDC→USDT on Jupiter...');
  const rawIn = Math.floor(amount * 1e6);
  const { sig, outAmount } = await jup.swap(USDC_MINT, USDT_MINT, rawIn, wallet, connection, JUP_KEY, 100);
  const usdtOut = outAmount / 1e6;
  console.log('[rebalance] Swapped: $' + amount.toFixed(2) + ' USDC → $' + usdtOut.toFixed(2) + ' USDT | ' + sig);
  return usdtOut;
}

async function sendUSDTOnSolana(amount, toAddress) {
  console.log('[rebalance] Sending $' + amount.toFixed(2) + ' USDT to ' + toAddress.slice(0, 12) + '...');
  const mint    = new PublicKey(USDT_MINT);
  const fromAta = await getAssociatedTokenAddress(mint, wallet.publicKey);
  const toAta   = await getAssociatedTokenAddress(mint, new PublicKey(toAddress));
  const rawAmt  = Math.floor(amount * 1e6);

  // Create destination ATA if needed
  try { await getAccount(connection, toAta); }
  catch {
    const tx = new Transaction();
    tx.add(createAssociatedTokenAccountInstruction(wallet.publicKey, toAta, new PublicKey(toAddress), mint));
    const sig = await connection.sendTransaction(tx, [wallet]);
    await connection.confirmTransaction(sig, 'confirmed');
  }

  const tx = new Transaction();
  tx.add(createTransferInstruction(fromAta, toAta, wallet.publicKey, rawAmt));
  const sig = await connection.sendTransaction(tx, [wallet]);
  await connection.confirmTransaction(sig, 'confirmed');
  console.log('[rebalance] USDT sent: ' + sig);
  return sig;
}

async function sendUSDCOnSolana(amount, toAddress) {
  console.log('[rebalance] Sending $' + amount.toFixed(2) + ' USDC to ' + toAddress.slice(0, 12) + '...');
  const mint    = new PublicKey(USDC_MINT);
  const fromAta = await getAssociatedTokenAddress(mint, wallet.publicKey);
  const toAta   = await getAssociatedTokenAddress(mint, new PublicKey(toAddress));
  const rawAmt  = Math.floor(amount * 1e6);

  try { await getAccount(connection, toAta); }
  catch {
    const tx = new Transaction();
    tx.add(createAssociatedTokenAccountInstruction(wallet.publicKey, toAta, new PublicKey(toAddress), mint));
    const sig = await connection.sendTransaction(tx, [wallet]);
    await connection.confirmTransaction(sig, 'confirmed');
  }

  const tx = new Transaction();
  tx.add(createTransferInstruction(fromAta, toAta, wallet.publicKey, rawAmt));
  const sig = await connection.sendTransaction(tx, [wallet]);
  await connection.confirmTransaction(sig, 'confirmed');
  console.log('[rebalance] USDC sent: ' + sig);
  return sig;
}

// ── Execute a single rebalance move ──────────────────────────────────────────
async function executeMove(move) {
  console.log('[rebalance] Executing: $' + move.amount + ' ' + move.from + ' → ' + move.to + ' via ' + move.method);

  switch(move.method) {

    case 'okx-to-sol':
      await withdrawFromOKX('USDT', move.amount, wallet.publicKey.toString(), 'Solana');
      await pollForUSDT(move.amount - OKX_SOLANA_FEE);
      await swapUSDTtoUSDC(move.amount - OKX_SOLANA_FEE);
      break;

    case 'okx-to-bybit':
      await withdrawFromOKX('USDT', move.amount, BYBIT_USDT_ADDR, 'Solana');
      break;

    case 'okx-to-kraken':
      await withdrawFromOKX('USDT', move.amount, KRAKEN_USDT_ADDR, 'Solana');
      break;

    case 'bybit-to-sol': {
      const wdId = await bybit.withdraw('USDT', move.amount.toString(), wallet.publicKey.toString(), 'SOL', BYBIT_CREDS);
      console.log('[rebalance] Bybit withdrawal ID: ' + wdId);
      await pollForUSDT(move.amount * 0.95);
      await swapUSDTtoUSDC(move.amount * 0.95);
      break;
    }

    case 'bybit-to-okx': {
      const depositAddr = await getOKXDepositAddress('USDT', 'USDT-Solana');
      const wdId = await bybit.withdraw('USDT', move.amount.toString(), depositAddr, 'SOL', BYBIT_CREDS);
      console.log('[rebalance] Bybit→OKX withdrawal ID: ' + wdId);
      break;
    }

    case 'kraken-to-sol':
      await kraken.withdraw('USDT', 'solana-bot', move.amount.toString(), KRAKEN_CREDS);
      await pollForUSDT(move.amount * 0.95);
      await swapUSDTtoUSDC(move.amount * 0.95);
      break;

    case 'sol-to-okx': {
      await swapUSDCtoUSDT(move.amount);
      const depositAddr = await getOKXDepositAddress('USDT', 'USDT-Solana');
      await sendUSDTOnSolana(move.amount * 0.995, depositAddr);
      break;
    }

    case 'sol-to-bybit': {
      await swapUSDCtoUSDT(move.amount);
      // Get Bybit USDT deposit address
      const ts = Date.now().toString();
      const recv = '5000';
      const params = 'chainType=SOL&coin=USDT';
      const sign = crypto.createHmac('sha256', BYBIT_CREDS.secret)
        .update(ts + BYBIT_CREDS.key + recv + params).digest('hex');
      const r = await fetch('https://api.bybit.com/v5/asset/deposit/query-address?' + params, {
        headers: { 'X-BAPI-API-KEY': BYBIT_CREDS.key, 'X-BAPI-SIGN': sign, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': recv }
      });
      const j = await r.json();
      const addr = j.result?.chains?.[0]?.addressDeposit;
      if (!addr) throw new Error('No Bybit USDT Solana deposit address');
      await sendUSDTOnSolana(move.amount * 0.995, addr);
      break;
    }

    case 'sol-to-coinbase':
      await sendUSDCOnSolana(move.amount, COINBASE_USDC_ADDR);
      break;

    case 'coinbase-to-sol':
      throw new Error('Coinbase→Solana requires manual withdrawal — Coinbase API does not support crypto withdrawals');

    default:
      throw new Error('Unknown route: ' + move.method);
  }
}

// ── Build rebalance plan ──────────────────────────────────────────────────────
function buildPlan(balances) {
  const keys       = Object.keys(balances).filter(k => balances[k] > 0);
  const total      = keys.reduce((a, k) => a + balances[k], 0);
  const equalShare = total / keys.length;

  const over  = keys.filter(k => balances[k] > equalShare * (1 + THRESHOLD))
    .sort((a, b) => balances[b] - balances[a]);
  const under = keys.filter(k => balances[k] < equalShare * (1 - THRESHOLD))
    .sort((a, b) => balances[a] - balances[b]);

  const moves = [];
  const remainders = { ...balances };

  for (const from of over) {
    let excess = remainders[from] - equalShare;
    for (const to of under) {
      if (excess < MIN_MOVE) break;
      const needed    = equalShare - remainders[to];
      if (needed < MIN_MOVE) continue;
      const routeKey  = from + '-' + to;
      const method    = ROUTES[routeKey];
      if (!method) { console.log('[rebalance] No direct route: ' + routeKey); continue; }
      const amt = Math.min(Math.floor(excess), Math.floor(needed));
      if (amt < MIN_MOVE) continue;
      moves.push({ from, to, amount: amt, method });
      remainders[from] -= amt;
      remainders[to]   += amt;
      excess           -= amt;
    }
  }

  return { balances, equalShare, total, over, under, moves };
}

// ── Execute rebalance plan ────────────────────────────────────────────────────
async function execute(plan, tg) {
  if (rebalancing) { await tg('⚠️ Rebalance already in progress'); return; }
  if (!plan.moves.length) { await tg('✅ All exchanges within 8% tolerance — no rebalance needed'); return; }

  rebalancing = true;
  try {
    const planLines = plan.moves.map(m => '$' + m.amount + ' ' + m.from + ' → ' + m.to).join('\n');
    await tg('⚖️ <b>Rebalancing</b>\nTarget: $' + Math.round(plan.equalShare) + ' per exchange\n' + planLines + '\n\nExecuting...');

    for (const move of plan.moves) {
      try {
        await executeMove(move);
        await tg('✅ $' + move.amount + ' ' + move.from + ' → ' + move.to + ' complete');
      } catch(e) {
        console.error('[rebalance] Move failed:', e.message);
        await tg('❌ $' + move.amount + ' ' + move.from + ' → ' + move.to + ' failed: ' + e.message.slice(0, 100));
      }
    }

    await tg('✅ Rebalance complete');
  } finally {
    rebalancing = false;
  }
}

module.exports = { buildPlan, execute, executeMove, ROUTES, THRESHOLD, MIN_MOVE, isRebalancing: () => rebalancing };
