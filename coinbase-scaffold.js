const COINBASE_VERSION = 'v1.0';
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
  const keyName   = process.env.COINBASE_API_KEY;
  const keySecret = process.env.COINBASE_API_SECRET.trim();
  const ts        = Math.floor(Date.now() / 1000);
  const nonce     = crypto.randomBytes(16).toString('hex');
  const uri       = method.toUpperCase() + ' api.coinbase.com' + path.split('?')[0];

  const header  = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'EdDSA', kid: keyName, nonce })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: keyName, iss: 'cdp', nbf: ts, exp: ts + 120, uri })).toString('base64url');
  const msg     = header + '.' + payload;

  // Coinbase Ed25519 key: 88-char base64 = 64 bytes (seed + pubkey)
  // Need to wrap as PKCS8 for Node.js crypto
  const rawKey = Buffer.from(keySecret, 'base64');
  // Ed25519 PKCS8 header: 302e020100300506032b657004220420
  const pkcs8Header = Buffer.from('302e020100300506032b657004220420', 'hex');
  const seed = rawKey.length >= 32 ? rawKey.slice(0, 32) : rawKey;
  const pkcs8 = Buffer.concat([pkcs8Header, seed]);
  const privateKey = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });

  const sig = crypto.sign(null, Buffer.from(msg), privateKey);
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

// ── Get fresh USDC deposit address ───────────────────────────────────────────
async function getCoinbaseDepositAddress() {
  // Get list of accounts first to find USDC account UUID
  const accounts = await cbRequest('GET', '/api/v3/brokerage/accounts');
  const usdcAccount = (accounts.accounts || []).find(a => a.currency === 'USDC');
  if (!usdcAccount) throw new Error('Coinbase USDC account not found');

  // Generate a fresh deposit address for the USDC account
  const result = await cbRequest('POST', '/api/v2/accounts/' + usdcAccount.uuid + '/addresses', {
    name: 'arb-bot-deposit'
  });
  const addr = result.data?.address;
  if (!addr) throw new Error('Coinbase deposit address generation failed: ' + JSON.stringify(result));
  console.log('[coinbase] Fresh deposit address:', addr.slice(0,12) + '...');
  return addr;
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

// ── Market sell (base currency → USDC) ───────────────────────────────────────
async function coinbaseMarketSell(symbol, baseAmount) {
  const productId = symbol + '-USDC';
  const clientOrderId = crypto.randomUUID();
  const j = await cbRequest('POST', '/api/v3/brokerage/orders', {
    client_order_id: clientOrderId,
    product_id: productId,
    side: 'SELL',
    order_configuration: {
      market_market_ioc: {
        base_size: baseAmount.toString(),
      }
    }
  });
  if (!j.success) throw new Error('Coinbase sell failed: ' + (j.error_response?.message || JSON.stringify(j)));
  return j.success_response?.order_id;
}

// ── Get filled order details ──────────────────────────────────────────────────
async function getCoinbaseOrder(orderId) {
  const j = await cbRequest('GET', '/api/v3/brokerage/orders/historical/' + orderId);
  return j.order;
}

// ── Withdraw to Solana ────────────────────────────────────────────────────────
async function coinbaseWithdraw(symbol, amount, toAddress) {
  // USDC account ID - verified 30 Aug 2026
  const USDC_ACCOUNT_ID = '12cf9d1c-5344-51aa-81ba-f5bd0a27d4f6';
  // Use v2 send with correct GB travel rule fields
  // Verified working format from docs.cdp.coinbase.com/coinbase-business/transfer-apis/travel-rule
  const j = await cbRequest('POST', '/v2/accounts/' + USDC_ACCOUNT_ID + '/transactions', {
    type: 'send',
    to: toAddress,
    amount: amount.toString(),
    currency: symbol,
    network: 'solana',
    travel_rule_data: {
      is_self: 'IS_SELF_TRUE',
      beneficiary_name: 'RC',
      beneficiary_address: { country: 'GB' },
      beneficiary_wallet_type: 'WALLET_TYPE_SELF_HOSTED',
    },
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
  const SOLANA_TOKENS = ['JTO','WIF','BONK','PENGU','RAY','SOL','PNUT','W','JUP','RENDER','GOAT','TRUMP','PYTH'];
  // Fetch all products in one call and filter
  const j = await cbRequest('GET', '/api/v3/brokerage/products?limit=500');
  const all = j.products || [];
  const matched = all.filter(p =>
    SOLANA_TOKENS.includes((p.base_currency_id||'').toUpperCase()) &&
    p.product_type === 'SPOT' &&
    p.status === 'online'
  );
  const results = { usdc: [], usd: [], usdt: [] };
  matched.forEach(p => {
    const q = (p.quote_currency_id||'').toUpperCase();
    if (q === 'USDC') results.usdc.push(p);
    else if (q === 'USD') results.usd.push(p);
    else if (q === 'USDT') results.usdt.push(p);
  });
  return results;
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
    const usdc = products.usdc.map(p => p.base_currency_id);
    const usd  = products.usd.map(p => p.base_currency_id);
    console.log('✅ USDC pairs ('+usdc.length+'):', usdc.join(', ') || 'none');
    console.log('   USD pairs  ('+usd.length+'):', usd.join(', ') || 'none');
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

module.exports = { getCoinbaseBalance, getCoinbaseTicker, coinbaseMarketBuy, coinbaseMarketSell, getCoinbaseOrder, coinbaseWithdraw, getCoinbaseWithdrawalStatus, calcCoinbaseSpread, getCoinbaseSolanaProducts, getFeeInfo, getCoinbaseDepositAddress, TAKER_FEE };

if (require.main === module) {
  runTests().catch(e => console.error(e.message));
}
