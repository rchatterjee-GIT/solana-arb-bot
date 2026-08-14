// bitget-scaffold.js — Bitget exchange integration (scaffolded)
// Fee: 0.02% maker/taker (vs OKX 0.1%) — breaks even at ~0.35% spread
// Requires: BITGET_API_KEY, BITGET_API_SECRET, BITGET_PASSPHRASE in .env
// Status: SCAFFOLDED — set BITGET_ENABLED=true in arb-config.json to activate

require('dotenv').config();
const crypto = require('crypto');

const BASE_URL = 'https://api.bitget.com';
const FEE_RATE = 0.0002; // 0.02% maker/taker

function sign(ts, method, path, body) {
  const msg = ts + method.toUpperCase() + path + (body || '');
  return crypto.createHmac('sha256', process.env.BITGET_API_SECRET).update(msg).digest('base64');
}

async function bitgetRequest(method, path, body = null) {
  if (!process.env.BITGET_API_KEY) throw new Error('BITGET_API_KEY not configured');
  const ts = Date.now().toString();
  const bodyStr = body ? JSON.stringify(body) : '';
  const headers = {
    'ACCESS-KEY':        process.env.BITGET_API_KEY,
    'ACCESS-SIGN':       sign(ts, method, path, bodyStr),
    'ACCESS-TIMESTAMP':  ts,
    'ACCESS-PASSPHRASE': process.env.BITGET_PASSPHRASE,
    'Content-Type':      'application/json',
    'locale':            'en-US',
  };
  const r = await fetch(BASE_URL + path, {
    method, headers, body: bodyStr || undefined
  });
  return r.json();
}

// ── Account balance ───────────────────────────────────────────────────────────
async function getBitgetBalance(coin) {
  const j = await bitgetRequest('GET', '/api/v2/spot/account/assets');
  const asset = (j.data || []).find(a => a.coin === coin);
  return parseFloat(asset?.available || '0');
}

// ── Market price ──────────────────────────────────────────────────────────────
async function getBitgetTicker(symbol) {
  const j = await fetch(`${BASE_URL}/api/v2/spot/market/tickers?symbol=${symbol}USDT`).then(r=>r.json());
  const d = j.data?.[0];
  if (!d) throw new Error(`No Bitget ticker for ${symbol}`);
  return { bid: parseFloat(d.bidPr), ask: parseFloat(d.askPr), last: parseFloat(d.lastPr) };
}

// ── Place market buy ──────────────────────────────────────────────────────────
async function bitgetMarketBuy(symbol, usdtAmount) {
  const j = await bitgetRequest('POST', '/api/v2/spot/trade/place-order', {
    symbol: symbol + 'USDT',
    side: 'buy',
    orderType: 'market',
    force: 'gtc',
    size: usdtAmount.toFixed(2), // quote quantity for market buy
    quoteSize: usdtAmount.toFixed(2),
  });
  if (j.code !== '00000') throw new Error('Bitget buy failed: ' + j.msg);
  return j.data?.orderId;
}

// ── Check withdrawal availability ─────────────────────────────────────────────
async function getBitgetWithdrawalInfo(coin) {
  const j = await bitgetRequest('GET', `/api/v2/spot/public/coins?coin=${coin}`);
  const coinData = j.data?.[0];
  if (!coinData) return { canWithdraw: false };
  const chain = (coinData.chains || []).find(c => c.chain === 'SOL' || c.chain.includes('Solana'));
  if (!chain) return { canWithdraw: false, reason: 'No Solana chain' };
  return {
    canWithdraw: chain.withdrawable === 'true' || chain.withdrawable === true,
    minWithdraw: parseFloat(chain.minWithdrawAmount || '0'),
    fee: parseFloat(chain.withdrawFee || '0'),
    chain: chain.chain,
  };
}

// ── Withdraw to Solana ────────────────────────────────────────────────────────
async function bitgetWithdraw(coin, amount, toAddress) {
  const j = await bitgetRequest('POST', '/api/v2/spot/wallet/withdrawal', {
    coin,
    address: toAddress,
    chain: 'SOL',
    size: amount.toString(),
    transferType: 'on_chain',
  });
  if (j.code !== '00000') throw new Error('Bitget withdrawal failed: ' + j.msg);
  return j.data?.orderId;
}

// ── Spread calculation ────────────────────────────────────────────────────────
function calcSpread(bitgetAsk, dexBid) {
  // Buy on Bitget (ask), sell on DEX (bid)
  // Net = (dexBid - bitgetAsk) / bitgetAsk * 100 - fees
  const gross = (dexBid - bitgetAsk) / bitgetAsk * 100;
  const fees = FEE_RATE * 100 + 0.30; // 0.02% buy + ~0.30% DEX
  return gross - fees;
}

// ── Test suite ────────────────────────────────────────────────────────────────
async function runTests() {
  console.log('\n=== BITGET SCAFFOLD TEST ===\n');
  const configured = !!process.env.BITGET_API_KEY;
  console.log('API configured:', configured);
  if (!configured) {
    console.log('Add BITGET_API_KEY, BITGET_API_SECRET, BITGET_PASSPHRASE to .env');
    return;
  }

  // Test 1: Balance
  try {
    const bal = await getBitgetBalance('USDT');
    console.log('✅ USDT balance: $' + bal.toFixed(2));
  } catch(e) { console.log('❌ Balance:', e.message); }

  // Test 2: Ticker
  try {
    const t = await getBitgetTicker('JTO');
    console.log('✅ JTO bid: $' + t.bid + ' ask: $' + t.ask);
  } catch(e) { console.log('❌ Ticker:', e.message); }

  // Test 3: Withdrawal info
  try {
    const w = await getBitgetWithdrawalInfo('JTO');
    console.log('✅ JTO withdrawal:', w.canWithdraw ? 'enabled' : 'disabled', '| fee:', w.fee);
  } catch(e) { console.log('❌ Withdrawal info:', e.message); }

  // Test 4: Spread calc
  const t = await getBitgetTicker('JTO').catch(() => null);
  if (t) {
    const mockDexBid = t.bid * 1.02; // 2% above
    const spread = calcSpread(t.ask, mockDexBid);
    console.log('✅ Spread calc (2% mock DEX premium): ' + spread.toFixed(3) + '%');
    console.log('   Break-even: ~0.35% (vs OKX ~0.70%)');
  }

  console.log('\n=== To activate: ===');
  console.log('1. Open Bitget account at bitget.com');
  console.log('2. Complete KYC');
  console.log('3. Generate API keys (Trade + Withdraw)');
  console.log('4. Add to .env: BITGET_API_KEY=... BITGET_API_SECRET=... BITGET_PASSPHRASE=...');
  console.log('5. Deposit $200 USDT');
  console.log('6. Set BITGET_ENABLED=true in arb-config.json');
}

module.exports = { getBitgetBalance, getBitgetTicker, bitgetMarketBuy, bitgetWithdraw, getBitgetWithdrawalInfo, calcSpread, FEE_RATE };

if (require.main === module) {
  runTests().catch(e => console.error(e.message));
}
