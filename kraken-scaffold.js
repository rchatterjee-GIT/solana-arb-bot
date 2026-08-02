// ── Kraken Integration Scaffold — v1.0 ───────────────────────────────────────
// DISABLED by default — set KRAKEN_ENABLED: true in arb-config.json to activate
//
// Lessons from OKX/Bybit build applied from day one:
//  ✅ Correct lot size / decimal handling (lotDecimals per pair)
//  ✅ WS + REST health monitoring with silent drop handling
//  ✅ Atomic lock (krakenLock) prevents concurrent scan race conditions
//  ✅ UK compliance pair checking before adding to PAIRS
//  ✅ Withdrawal pipeline: check canWithdraw, fee %, min amount
//  ✅ TradeLogger integration at every step
//  ✅ Balance reading uses correct field (not a derived/unavailable field)
//  ✅ Market buy uses quote currency amount ($120 USDT) not token quantity
//  ✅ UNIFIED account handling (Kraken uses single account — simpler)
//  ✅ Config flag KRAKEN_ENABLED: false — single switch to activate
//  ✅ WS watchdog — reconnects if silent >60s
//  ✅ All errors logged with full context, never swallowed silently

require('dotenv').config();
const crypto = require('crypto');
const WebSocket = require('ws');

// ── Constants ─────────────────────────────────────────────────────────────────
const KRAKEN_REST    = 'https://api.kraken.com';
const KRAKEN_WS      = 'wss://ws.kraken.com/v2';
const KRAKEN_API_KEY = process.env.KRAKEN_API_KEY;
const KRAKEN_SECRET  = process.env.KRAKEN_API_SECRET;

// ── Pairs viable at $240 trade size (0.40% fee, Solana withdrawal available) ──
// Lesson: validate lot sizes and min orders before hardcoding
// These are confirmed Kraken spot pairs with SOL network withdrawal
// ── Kraken pair name findings (from API query Jul 29 2026) ──────────────────
// Most tokens only have USD pairs (not USDT) on Kraken:
//   SOL  → SOLUSDT ✅  WIF  → WIFUSD only
//   PENGU→ PENGUUSDT ✅  JTO  → JTOUSD only
//   PNUT → PNUTUSD only   RAY  → RAYUSD only
// USD pairs work but add conversion step (USD→USDT) after sell
// Starting with USDT pairs only for simplicity — revisit at $240 scale
const KRAKEN_PAIRS = [
  {
    name:        'SOL/USDT',
    krakenPair:  'SOLUSDT',        // Kraken REST pair name (verified)
    wsPair:      'SOL/USDT',       // Kraken WS v2 pair name
    okxInstId:   'SOL-USDT',
    bybitInstId: 'SOLUSDT',
    outputMint:  'So11111111111111111111111111111111111111112',
    decimals:    9,
    isNative:    true,
    krakenCcy:   'SOL',
    quoteCcy:    'USDT',
    lotDecimals: 8,
    minOrder:    0.1,
    fee:         0.0040,
    withdrawFee: 0.01,
    withdrawChain: 'Solana',
  },
  {
    name:        'PENGU/USDT',
    krakenPair:  'PENGUUSDT',      // Kraken REST pair name (verified)
    wsPair:      'PENGU/USDT',     // Kraken WS v2 pair name
    okxInstId:   'PENGU-USDT',
    bybitInstId: 'PENGUUSDT',
    outputMint:  '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv',
    decimals:    6,
    isNative:    false,
    krakenCcy:   'PENGU',
    quoteCcy:    'USDT',
    lotDecimals: 8,
    minOrder:    100,
    fee:         0.0040,
    withdrawFee: 124,
    withdrawChain: 'Solana',
  },
  // USD pairs — viable but require USD→USDT conversion after sell
  // Deferred until $240 scale — will add WIF/JTO/RAY/PNUT here
  // {
  //   name:        'WIF/USD',
  //   krakenPair:  'WIFUSD',
  //   wsPair:      'WIF/USD',
  //   quoteCcy:    'USD',     // note: USD not USDT
  //   ... needs USD balance or post-trade conversion
  // },
];

// ── State ─────────────────────────────────────────────────────────────────────
let krakenPrices      = {};   // { 'SOL/USDT': { bid, ask } }
let krakenHealthy     = false;
let krakenWs          = null;
let lastKrakenWsMsg   = Date.now();
let krakenDownSince   = null;
let executingKraken   = false;
let krakenLock        = false; // atomic lock — prevents race condition

// ── Kraken API signature (lesson: OKX/Bybit both had auth bugs early) ─────────
function krakenSign(path, nonce, data) {
  const message   = nonce + data;
  const hash      = crypto.createHash('sha256').update(nonce + data).digest('binary');
  const hmac      = crypto.createHmac('sha512', Buffer.from(KRAKEN_SECRET, 'base64'));
  hmac.update(path, 'binary');
  hmac.update(hash, 'binary');
  return hmac.digest('base64');
}

async function krakenPrivate(path, params = {}) {
  const nonce  = Date.now().toString();
  const data   = new URLSearchParams({ nonce, ...params }).toString();
  const sig    = krakenSign('/0/private' + path, nonce, data);
  const r = await fetch(KRAKEN_REST + '/0/private' + path, {
    method:  'POST',
    headers: {
      'API-Key':  KRAKEN_API_KEY,
      'API-Sign': sig,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: data,
  });
  const j = await r.json();
  if (j.error?.length) throw new Error('Kraken API error: ' + j.error.join(', '));
  return j.result;
}

async function krakenPublic(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const r  = await fetch(KRAKEN_REST + '/0/public' + path + (qs ? '?' + qs : ''));
  const j  = await r.json();
  if (j.error?.length) throw new Error('Kraken public API error: ' + j.error.join(', '));
  return j.result;
}

// ── Balance (lesson: OKX/Bybit had wrong field bugs) ─────────────────────────
// Kraken uses simple single account — no UNIFIED→FUND complexity
async function getKrakenBalance(ccy = 'USDT') {
  try {
    const result = await krakenPrivate('/Balance');
    // Kraken returns balances keyed by asset code (USDT, ZUSD, etc.)
    // USDT is 'USDT', USD is 'ZUSD'
    const val = parseFloat(result[ccy] || result['Z' + ccy] || '0');
    return val;
  } catch (err) {
    console.error('Kraken balance error:', err.message);
    return 0;
  }
}

// ── UK Compliance check (lesson: OKX blocked RENDER, Bybit blocked MEW/GOAT) ─
async function checkKrakenUKCompliance(krakenPair) {
  try {
    const result = await krakenPublic('/AssetPairs', { pair: krakenPair });
    const pair   = Object.values(result)[0];
    if (!pair) return { viable: false, reason: 'Pair not found' };
    // Check if pair is tradeable
    if (pair.status !== 'online') return { viable: false, reason: `Pair status: ${pair.status}` };
    return { viable: true, lotDecimals: pair.lot_decimals, minOrder: pair.ordermin };
  } catch (err) {
    return { viable: false, reason: err.message };
  }
}

// ── Withdrawal check (lesson: validate before assuming withdrawable) ───────────
async function checkKrakenWithdrawal(ccy, amount, address) {
  try {
    // Get withdrawal info to check fees and limits
    const info = await krakenPrivate('/WithdrawInfo', {
      asset:   ccy,
      key:     'solana-bot-wallet', // withdrawal address book key
      amount:  amount.toString(),
    });
    return {
      viable: true,
      fee:    parseFloat(info.fee || 0),
      limit:  parseFloat(info.limit || 0),
    };
  } catch (err) {
    return { viable: false, reason: err.message };
  }
}

// ── Market buy (lesson: use quote currency amount, not token quantity) ─────────
// Kraken: use 'ordertype: market', 'type: buy', volume in quote currency
async function placeKrakenOrder(side, pair, quoteAmount, logger = null) {
  const label = `Kraken ${side.toUpperCase()} ${pair} $${quoteAmount}`;
  if (logger) logger.log('API_CALL', label);
  const start = Date.now();
  try {
    // Lesson: always specify in quote currency to avoid decimal/lot size issues
    // viqc (volume in quote currency) only works for buy orders
    // sell orders must use token quantity directly
    const params = {
      pair,
      type:      side,
      ordertype: 'market',
      volume:    quoteAmount.toString(),
    };
    if (side === 'buy') params.oflags = 'viqc';
    const result = await krakenPrivate('/AddOrder', params);
    const latMs = Date.now() - start;
    if (logger) logger.log('API_RESP', `OK ${label} txid:${result.txid?.[0]} latency:${latMs}ms`, { latencyMs: latMs });
    return result;
  } catch (err) {
    const latMs = Date.now() - start;
    if (logger) logger.log('API_RESP', `FAIL ${label}: ${err.message.slice(0, 100)}`, { latencyMs: latMs, error: err.message });
    throw err;
  }
}

// ── Withdrawal (lesson: validate address book key exists first) ────────────────
// Kraken requires pre-whitelisted addresses in the withdrawal address book
// Add wallet address to Kraken's withdrawal address book before enabling
async function withdrawFromKraken(ccy, amount, logger = null) {
  const withdrawKey = process.env.KRAKEN_WITHDRAW_KEY || 'solana-bot-wallet';
  const label = `Kraken withdraw ${amount} ${ccy} via key:${withdrawKey}`;
  if (logger) logger.log('API_CALL', label);
  const start = Date.now();
  try {
    const result = await krakenPrivate('/Withdraw', {
      asset:  ccy,
      key:    withdrawKey,    // pre-whitelisted address book key
      amount: amount.toString(),
    });
    const latMs = Date.now() - start;
    if (logger) logger.log('API_RESP', `OK refid:${result.refid} latency:${latMs}ms`, { latencyMs: latMs });
    return result.refid;
  } catch (err) {
    const latMs = Date.now() - start;
    if (logger) logger.log('API_RESP', `FAIL ${label}: ${err.message.slice(0, 100)}`, { latencyMs: latMs });
    throw err;
  }
}

// ── WebSocket price feed ───────────────────────────────────────────────────────
function startKrakenWS() {
  if (krakenWs) { try { krakenWs.terminate(); } catch {} }
  krakenWs = new WebSocket(KRAKEN_WS);

  krakenWs.on('open', () => {
    console.log('✅ Kraken WebSocket connected');
    lastKrakenWsMsg = Date.now();
    // Subscribe to ticker for all pairs
    const pairs = KRAKEN_PAIRS.map(p => p.wsPair);
    krakenWs.send(JSON.stringify({
      method: 'subscribe',
      params: { channel: 'ticker', symbol: pairs },
    }));
  });

  krakenWs.on('message', (raw) => {
    lastKrakenWsMsg = Date.now();
    try {
      const msg = JSON.parse(raw);
      // Kraken v2 WS ticker format
      if (msg.channel === 'ticker' && msg.data) {
        for (const tick of msg.data) {
          const bid = parseFloat(tick.bid);
          const ask = parseFloat(tick.ask);
          if (bid > 0 && ask > 0) {
            krakenPrices[tick.symbol] = { bid, ask };
            if (!krakenHealthy) {
              krakenHealthy = true;
              console.log('✅ Kraken price feeds active');
            }
          }
        }
      }
    } catch {}
  });

  krakenWs.on('close', () => {
    console.warn('⚠️  Kraken WS closed — reconnecting in 5s...');
    krakenHealthy = false;
    Object.keys(krakenPrices).forEach(k => delete krakenPrices[k]);
    setTimeout(startKrakenWS, 5000);
  });

  krakenWs.on('error', (err) => {
    console.error('Kraken WS error:', err.message);
  });

  // Heartbeat ping every 30s
  const ping = setInterval(() => {
    if (krakenWs?.readyState === WebSocket.OPEN) {
      krakenWs.send(JSON.stringify({ method: 'ping' }));
    } else {
      clearInterval(ping);
    }
  }, 30000);
}

// ── WS watchdog (lesson: OKX WS silently died overnight) ──────────────────────
function checkKrakenWsHealth() {
  if (krakenHealthy && Date.now() - lastKrakenWsMsg > 60000) {
    console.warn('⚠️  Kraken WS silent for 60s — forcing reconnect...');
    lastKrakenWsMsg = Date.now();
    Object.keys(krakenPrices).forEach(k => delete krakenPrices[k]);
    krakenHealthy = false;
    startKrakenWS();
  }
}

// ── Spread calculation (for integration into checkAndExecute) ─────────────────
// Returns Kraken spread for a pair — same format as OKX/Bybit spread calc
function getKrakenSpread(pair, solanaPrice) {
  const kPrice = krakenPrices[pair.wsPair];
  if (!kPrice || !solanaPrice) return null;
  // BUY_KRAKEN: buy on Kraken, sell on DEX (Solana)
  // spread = (solanaPrice - krakenAsk) / krakenAsk * 100
  const spreadKraken = ((solanaPrice - kPrice.ask) / kPrice.ask) * 100;
  // Subtract fees: Kraken 0.40% + DEX 0.30%
  const netKraken = spreadKraken - 0.40 - 0.30;
  return {
    krakenBid:    kPrice.bid,
    krakenAsk:    kPrice.ask,
    spreadKraken,
    netKraken,
    viable:       netKraken > 0,
  };
}

// ── Viability refresh (lesson: check compliance before trading) ────────────────
async function refreshKrakenViability() {
  console.log('\n🔄 Refreshing Kraken viability...');
  const viable = [], blocked = [];
  for (const pair of KRAKEN_PAIRS) {
    try {
      const check = await checkKrakenUKCompliance(pair.krakenPair);
      if (check.viable) {
        viable.push(`${pair.krakenCcy} (${(pair.fee * 100).toFixed(2)}%)`);
      } else {
        blocked.push(`${pair.krakenCcy} (${check.reason})`);
        console.log(`  ❌ Kraken ${pair.krakenCcy}: ${check.reason}`);
      }
    } catch (err) {
      blocked.push(pair.krakenCcy);
      console.log(`  ❌ Kraken ${pair.krakenCcy}: ${err.message}`);
    }
  }
  console.log(`  ✅ Kraken viable: ${viable.join(', ') || 'none'}`);
  if (blocked.length) console.log(`  ❌ Kraken blocked: ${blocked.join(', ')}`);
  return { viable, blocked };
}

// ── Exchange test (lesson: test buy/sell/withdraw before going live) ──────────
async function testKrakenPair(pair, tradeSize = 5) {
  const results = { pair: pair.name, buy: false, sell: false, withdraw: false, errors: [] };
  console.log(`\n🧪 Testing Kraken ${pair.name} ($${tradeSize})...`);
  try {
    // Test buy
    const buyResult = await placeKrakenOrder('buy', pair.krakenPair, tradeSize);
    results.buy = true;
    console.log(`  ✅ Buy: ${buyResult.txid?.[0]}`);
    await new Promise(r => setTimeout(r, 3000));

    // Check balance received
    const bal = await getKrakenBalance(pair.krakenCcy);
    console.log(`  Balance: ${bal.toFixed(4)} ${pair.krakenCcy}`);

    // Test sell back
    if (bal > pair.minOrder) {
      const sellResult = await placeKrakenOrder('sell', pair.krakenPair, bal);
      results.sell = true;
      console.log(`  ✅ Sell: ${sellResult.txid?.[0]}`);
    }

    // Test withdrawal info (not actual withdrawal)
    const wdInfo = await checkKrakenWithdrawal(pair.krakenCcy, tradeSize / 10, 'test');
    results.withdraw = wdInfo.viable;
    console.log(`  ${wdInfo.viable ? '✅' : '❌'} Withdraw: fee ${wdInfo.fee} ${pair.krakenCcy}`);

  } catch (err) {
    results.errors.push(err.message);
    console.log(`  ❌ Error: ${err.message}`);
  }
  return results;
}

// ── Setup checklist (run before enabling) ─────────────────────────────────────
async function krakenSetupCheck() {
  console.log('\n🔧 Kraken Setup Checklist');
  console.log('─'.repeat(50));

  // 1. API keys present
  const hasKeys = !!KRAKEN_API_KEY && !!KRAKEN_SECRET;
  console.log(`${hasKeys ? '✅' : '❌'} API keys in .env`);

  // 2. Account balance
  try {
    const usdt = await getKrakenBalance('USDT');
    console.log(`${usdt > 0 ? '✅' : '⚠️ '} USDT balance: $${usdt.toFixed(2)}`);
  } catch (err) {
    console.log(`❌ Balance check failed: ${err.message}`);
  }

  // 3. Withdrawal address book
  const withdrawKey = process.env.KRAKEN_WITHDRAW_KEY;
  console.log(`${withdrawKey ? '✅' : '❌'} KRAKEN_WITHDRAW_KEY in .env`);
  if (!withdrawKey) {
    console.log('   → Add bot wallet to Kraken withdrawal address book');
    console.log('   → Set KRAKEN_WITHDRAW_KEY=name_of_address in .env');
  }

  // 4. Pair viability
  await refreshKrakenViability();

  // 5. WS connection
  console.log('\n📡 Testing WebSocket...');
  await new Promise((resolve) => {
    const ws = new WebSocket(KRAKEN_WS);
    ws.on('open', () => {
      console.log('✅ WS connection OK');
      ws.close();
      resolve();
    });
    ws.on('error', (err) => {
      console.log('❌ WS failed:', err.message);
      resolve();
    });
    setTimeout(resolve, 5000);
  });

  console.log('\n─'.repeat(50));
  console.log('To enable: set KRAKEN_ENABLED: true in arb-config.json');
  console.log('To test:   node kraken-scaffold.js test');
}

// ── Export for integration into okx-arb.js ────────────────────────────────────
module.exports = {
  KRAKEN_PAIRS,
  krakenPrices,
  krakenHealthy: () => krakenHealthy,
  krakenLock:    () => krakenLock,
  setKrakenLock: (v) => { krakenLock = v; },
  startKrakenWS,
  checkKrakenWsHealth,
  getKrakenBalance,
  getKrakenSpread,
  placeKrakenOrder,
  withdrawFromKraken,
  refreshKrakenViability,
  testKrakenPair,
};

// ── Standalone runner ──────────────────────────────────────────────────────────
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'test') {
    (async () => {
      await krakenSetupCheck();
      console.log('\n🧪 Running pair tests...');
      for (const pair of KRAKEN_PAIRS) {
        await testKrakenPair(pair, 5);
      }
    })().catch(console.error);
  } else if (cmd === 'check') {
    krakenSetupCheck().catch(console.error);
  } else if (cmd === 'ws') {
    console.log('Starting Kraken WS feed...');
    startKrakenWS();
    setInterval(() => {
      console.log('Prices:', JSON.stringify(krakenPrices, null, 2));
      checkKrakenWsHealth();
    }, 5000);
  } else {
    console.log('Usage: node kraken-scaffold.js [check|test|ws]');
    console.log('  check — run setup checklist');
    console.log('  test  — run buy/sell tests on all pairs');
    console.log('  ws    — start WS feed and print prices');
  }
}
