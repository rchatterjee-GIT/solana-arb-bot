// coinbase-scaffold.js — Coinbase Advanced Trade integration
// Pairs: JTO/USDC, PENGU/USDC, WIF/USDC, BONK/USDC, RAY/USDC etc
// Fee: 0.60% taker (volume-based, reduces with volume)
// Withdrawal: ~21 seconds to Solana, ~$0.15 fee
// Requires: COINBASE_API_KEY, COINBASE_API_SECRET in .env
// Auth: CDP API key (Ed25519 JWT-based, different from old HMAC)

require('dotenv').config();
const crypto = require('crypto');
const path   = require('path');

const BASE_URL  = 'https://api.coinbase.com';
const TAKER_FEE = 0.006; // 0.60% taker — reduces at higher volume tiers

// ── JWT Auth (Coinbase CDP API key format) ────────────────────────────────────
function buildJWT(method, path) {
  if (!process.env.COINBASE_API_KEY || !process.env.COINBASE_API_SECRET) {
    throw new Error('COINBASE_API_KEY and COINBASE_API_SECRET required in .env');
  }
  const keyName   = process.env.COINBASE_API_KEY;
  const keySecret = process.env.COINBASE_API_SECRET;
  const ts        = Math.floor(Date.now() / 1000);
  const nonce     = crypto.randomBytes(16).toString('hex');
  const uri       = method.toUpperCase() + ' api.coinbase.com' + path;

  const header  = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256', kid: keyName, nonce })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: keyName, iss: 'cdp', nbf: ts, exp: ts + 120, uri })).toString('base64url');
  const msg     = header + '.' + payload;

  // Parse PEM private key
  const privateKey = crypto.createPrivateKey({ key: keySecret, format: 'pem' });
  const sig = crypto.sign('SHA256', Buffer.from(msg), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return msg + '.' + sig.toString('base64url');
}

async function cbRequest(method, epPath, body) {
  const jwt = buildJWT(method, epPath);
  const opts = {
    method,
    headers: { 'Authorization': 'Bearer ' + jwt, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(BASE_URL + epPath, opts);
  return r.json();
}

// ── Balance ───────────────────────────────────────────────────────────────────
async function getCoinbaseBalance(currency) {
  const j = await cbRequest('GET', '/api/v3/brokerage/accounts');
  const accounts = j.accounts || [];
  const acc = accounts.find(a => a.currency === currency);
  return parseFloat(acc?.available_balance?.value || '0');
}

// ── Ticker ────────────────────────────────────────────────────────────────────
async function getCoinbaseTicker(symbol) {
  // symbol e.g. 'JTO' — pairs against USDC
  const productId = symbol + '-USDC';
  const j = await fetch(BASE_URL + '/api/v3/brokerage/best_bid_ask?product_ids=' + productId, {
    headers: { 'Authorization': 'Bearer ' + buildJWT('GET', '/api/v3/brokerage/best_bid_ask') }
  }).then(r => r.json());
  const pricebook = j.pricebooks?.[0];
  if (!pricebook) throw new Error('No Coinbase ticker for ' + productId);
  return {
    bid: parseFloat(pricebook.bids?.[0]?.price || '0'),
    ask: parseFloat(pricebook.asks?.[0]?.price || '0'),
  };
}

// ── Market buy (quote currency = USDC) ───────────────────────────────────────
async function coinbaseMarketBuy(symbol, usdcAmount) {
  const productId = symbol + '-USDC';
  const clientOrderId = crypto.randomUUID();
  const j = await cbRequest('POST', '/api/v3/brokerage/orders', {
    client_order_id: clientOrderId,
    product_id: productId,
    side: 'BUY',
    order_configuration: {
      market_market_ioc: {
        quote_size: usdcAmount.toFixed(2),
      }
    }
  });
  if (!j.success) throw new Error('Coinbase buy failed: ' + (j.error_response?.message || JSON.stringify(j)));
  return j.success_response?.order_id;
}

// ── Get filled order details ──────────────────────────────────────────────────
async function getCoinbaseOrder(orderId) {
  const j = await cbRequest('GET', '/api/v3/brokerage/orders/historical/' + orderId);
  return j.order;
}

// ── Withdraw to Solana ────────────────────────────────────────────────────────
async function coinbaseWithdraw(symbol, amount, toAddress) {
  // Uses the v2 sends API for crypto withdrawals
  const j = await cbRequest('POST', '/v2/accounts/' + symbol + '/transactions', {
    type: 'send',
    to: toAddress,
    amount: amount.toString(),
    currency: symbol,
    network: 'solana',
  });
  if (j.errors) throw new Error('Coinbase withdrawal failed: ' + JSON.stringify(j.errors));
  return j.data?.id;
}

// ── Get withdrawal status ─────────────────────────────────────────────────────
async function getCoinbaseWithdrawalStatus(symbol, txId) {
  const j = await cbRequest('GET', '/v2/accounts/' + symbol + '/transactions/' + txId);
  return j.data?.status;
}

// ── Spread calculation ────────────────────────────────────────────────────────
function calcCoinbaseSpread(cbAsk, dexBid, tradeSizeUsd) {
  const gross    = (dexBid - cbAsk) / cbAsk * 100;
  const takerFee = TAKER_FEE * 100;
  const wdFee    = 0.15 / tradeSizeUsd * 100; // ~$0.15 network fee
  const dexFee   = 0.30; // Jupiter ~0.30%
  return parseFloat((gross - takerFee - wdFee - dexFee).toFixed(4));
}

// ── Get all available Solana-network products ─────────────────────────────────
async function getCoinbaseSolanaProducts() {
  const j = await cbRequest('GET', '/api/v3/brokerage/products?product_type=SPOT&quote_currency_id=USDC&limit=250');
  const products = j.products || [];
  // Filter to known Solana ecosystem tokens
  const SOLANA_TOKENS = ['JTO','WIF','BONK','PENGU','RAY','SOL','PNUT','W','JUP','RENDER','GOAT','TRUMP','PYTH'];
  return products.filter(p => SOLANA_TOKENS.includes(p.base_currency_id));
}

// ── Fee tier info ─────────────────────────────────────────────────────────────
function getFeeInfo() {
  return {
    taker: TAKER_FEE,
    note: 'Fee reduces with volume: >$10k/mo = 0.40%, >$50k = 0.25%, >$100k = 0.20%',
    breakevenSpread: (TAKER_FEE * 100 + 0.15/120*100 + 0.30).toFixed(2) + '%',
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────
async function runTests() {
  console.log('\n=== COINBASE SCAFFOLD TEST ===\n');
  const configured = !!(process.env.COINBASE_API_KEY && process.env.COINBASE_API_SECRET);
  console.log('API configured:', configured);
  if (!configured) {
    console.log('Add to .env: COINBASE_API_KEY=... COINBASE_API_SECRET=...');
    return;
  }

  // Test 1: Balance
  try {
    const usdc = await getCoinbaseBalance('USDC');
    const jto  = await getCoinbaseBalance('JTO');
    console.log('✅ USDC balance: $' + usdc.toFixed(2));
    console.log('✅ JTO balance: ' + jto.toFixed(4));
  } catch(e) { console.log('❌ Balance:', e.message); }

  // Test 2: Ticker
  try {
    const t = await getCoinbaseTicker('JTO');
    console.log('✅ JTO bid: $' + t.bid + ' ask: $' + t.ask);
  } catch(e) { console.log('❌ Ticker:', e.message); }

  // Test 3: Available Solana products
  try {
    const products = await getCoinbaseSolanaProducts();
    console.log('✅ Solana products available:', products.map(p => p.base_currency_id).join(', '));
  } catch(e) { console.log('❌ Products:', e.message); }

  // Test 4: Fee info
  const fees = getFeeInfo();
  console.log('\n=== FEE STRUCTURE ===');
  console.log('Taker fee:        ' + (fees.taker * 100).toFixed(2) + '%');
  console.log('Break-even spread:', fees.breakevenSpread);
  console.log('Note:', fees.note);

  console.log('\n=== ECONOMICS vs OKX ===');
  console.log('Coinbase break-even: ~1.03% spread (fires at 1.15% with 12% buffer)');
  console.log('OKX break-even:      ~1.30% spread (fires at 1.46% with 12% buffer)');
  console.log('Withdrawal time:     ~21s (vs OKX 45-90s)');
  console.log('');
  console.log('To activate: set COINBASE_ENABLED=true in arb-config.json');
  console.log('Deposit $200 USDC to Coinbase Advanced Trade account');
}

module.exports = { getCoinbaseBalance, getCoinbaseTicker, coinbaseMarketBuy, coinbaseWithdraw, getCoinbaseWithdrawalStatus, calcCoinbaseSpread, getCoinbaseSolanaProducts, getFeeInfo, TAKER_FEE };

if (require.main === module) {
  runTests().catch(e => console.error(e.message));
}
