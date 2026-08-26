/**
 * funding-arb.js — Funding Rate Arbitrage Scaffold
 * 
 * Strategy: Delta-neutral position capturing perpetual futures funding payments
 * 
 * When BTC/alts rally hard, perp funding rates go very positive (longs pay shorts).
 * We:
 *   1. SHORT the perp on OKX/Bybit (collect funding payment every 8hrs)
 *   2. LONG the spot (hold the token, price-neutral)
 *   3. Net: collect funding rate as yield, no directional exposure
 * 
 * Current funding rates for Solana ecosystem tokens:
 *   OKX:   GET /api/v5/public/funding-rate?instId=JTO-USDT-SWAP
 *   Bybit:  GET /v5/market/tickers?category=linear&symbol=JTOUSDT
 * 
 * Break-even: funding rate > (2 × taker fee + borrow rate)
 * At 0.1% funding/8hrs = 0.3%/day = 10.9%/month — very profitable
 */

'use strict';
require('dotenv').config();
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const POSITIONS_FILE = path.join(__dirname, 'funding-positions.json');
const MIN_FUNDING_RATE = 0.0005; // 0.05% per 8hrs minimum to open position
const POSITION_SIZE_USD = 200;   // $ per position
const MAX_POSITIONS = 3;         // max simultaneous funding arb positions

// ── Fetch current funding rates ───────────────────────────────────────────────
async function getOKXFundingRate(symbol) {
  const instId = symbol + '-USDT-SWAP';
  const ts = new Date().toISOString();
  const path2 = '/api/v5/public/funding-rate?instId=' + instId;
  const r = await fetch('https://www.okx.com' + path2, { signal: AbortSignal.timeout(5000) });
  const j = await r.json();
  const rate = parseFloat(j.data?.[0]?.fundingRate || '0');
  const nextTime = j.data?.[0]?.nextFundingTime;
  return { rate, nextTime, annualized: rate * 3 * 365 * 100 }; // 3 payments/day × 365 days
}

async function getBybitFundingRate(symbol) {
  const instId = symbol + 'USDT';
  const r = await fetch('https://api.bybit.com/v5/market/tickers?category=linear&symbol=' + instId, { signal: AbortSignal.timeout(5000) });
  const j = await r.json();
  const ticker = j.result?.list?.[0];
  const rate = parseFloat(ticker?.fundingRate || '0');
  const nextTime = ticker?.nextFundingTime;
  return { rate, nextTime, annualized: rate * 3 * 365 * 100 };
}

// ── Scan all pairs for funding opportunities ──────────────────────────────────
async function scanFundingOpportunities(pairs, sendTG) {
  const opportunities = [];

  for (const sym of pairs) {
    try {
      const [okx, bybit] = await Promise.allSettled([
        getOKXFundingRate(sym),
        getBybitFundingRate(sym),
      ]);

      const okxRate   = okx.status   === 'fulfilled' ? okx.value   : null;
      const bybitRate = bybit.status === 'fulfilled' ? bybit.value : null;

      const bestRate = okxRate && bybitRate
        ? (okxRate.rate > bybitRate.rate ? { ...okxRate, exchange: 'OKX' } : { ...bybitRate, exchange: 'Bybit' })
        : okxRate ? { ...okxRate, exchange: 'OKX' }
        : bybitRate ? { ...bybitRate, exchange: 'Bybit' }
        : null;

      if (!bestRate) continue;

      // Taker fee + spot hold cost
      const TAKER_FEE = 0.001; // 0.1%
      const breakEven = TAKER_FEE * 2; // open + close
      const netRate   = bestRate.rate - breakEven / 3; // per payment period

      if (bestRate.rate >= MIN_FUNDING_RATE) {
        opportunities.push({
          symbol: sym,
          exchange: bestRate.exchange,
          fundingRate: bestRate.rate,
          annualized: bestRate.annualized,
          nextPayment: bestRate.nextTime,
          netRate,
          viable: netRate > 0,
        });
      }
    } catch(e) {
      // Rate unavailable — skip
    }
  }

  // Sort by funding rate descending
  opportunities.sort((a, b) => b.fundingRate - a.fundingRate);
  return opportunities;
}

// ── Generate funding rate report ──────────────────────────────────────────────
async function generateFundingReport(pairs) {
  const opps = await scanFundingOpportunities(pairs, null);
  if (!opps.length) return '📡 [MARKET] No significant funding rates found';

  const lines = opps.slice(0, 8).map(o =>
    o.symbol.padEnd(7) +
    o.exchange.padEnd(7) +
    (o.fundingRate * 100).toFixed(4) + '%/8hr ' +
    '(' + o.annualized.toFixed(1) + '%/yr) ' +
    (o.viable ? '✅' : '❌')
  );

  return '📡 [MARKET] Funding Rates\n' +
    'Symbol  Exch   Rate/8hr  Annual   Viable\n' +
    lines.join('\n') + '\n\n' +
    'Strategy: short perp + long spot = collect funding\n' +
    'Min threshold: ' + (MIN_FUNDING_RATE * 100).toFixed(3) + '%/8hr';
}

// ── OKX authenticated request ─────────────────────────────────────────────────
async function okxRequest(method, endpoint, body) {
  const ts  = new Date().toISOString();
  const bodyStr = body ? JSON.stringify(body) : '';
  const sign = require('crypto').createHmac('sha256', process.env.OKX_API_SECRET)
    .update(ts + method + endpoint + bodyStr).digest('base64');
  const r = await fetch('https://www.okx.com' + endpoint, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'OK-ACCESS-KEY': process.env.OKX_API_KEY,
      'OK-ACCESS-SIGN': sign,
      'OK-ACCESS-TIMESTAMP': ts,
      'OK-ACCESS-PASSPHRASE': process.env.OKX_PASSPHRASE,
    },
    body: bodyStr || undefined,
    signal: AbortSignal.timeout(8000),
  });
  return r.json();
}

// ── Open a funding arb position ───────────────────────────────────────────────
async function openFundingPosition(symbol, exchange) {
  const positions = loadPositions();
  if (positions.length >= MAX_POSITIONS) throw new Error('Max positions (' + MAX_POSITIONS + ') already open');

  // Check current funding rate first
  const rate = exchange === 'OKX' ? await getOKXFundingRate(symbol) : await getBybitFundingRate(symbol);
  if (rate.rate < MIN_FUNDING_RATE) throw new Error('Funding rate ' + (rate.rate*100).toFixed(4) + '% below minimum ' + (MIN_FUNDING_RATE*100).toFixed(4) + '%');

  const instId = exchange === 'OKX' ? symbol + '-USDT-SWAP' : null;
  const spotPair = exchange === 'OKX' ? symbol + '-USDT' : null;

  // 1. Verify margin balance
  const balJ = await okxRequest('GET', '/api/v5/account/balance?ccy=USDT', null);
  const usdtBal = parseFloat(balJ.data?.[0]?.details?.find(d=>d.ccy==='USDT')?.availBal || '0');
  if (usdtBal < POSITION_SIZE_USD * 2) throw new Error('Insufficient USDT: $' + usdtBal.toFixed(2));

  // 2. Open SHORT perp (collects funding when positive)
  const perpSizeContracts = Math.floor(POSITION_SIZE_USD / 10); // OKX contract = 10 USDT notional for most tokens
  const perpJ = await okxRequest('POST', '/api/v5/trade/order', {
    instId, tdMode: 'cross', side: 'sell', ordType: 'market',
    sz: perpSizeContracts.toString(), posSide: 'short',
  });
  if (perpJ.code !== '0') throw new Error('Perp order failed: ' + JSON.stringify(perpJ));

  // 3. Buy SPOT (long hedge — delta neutral)
  // Use Jupiter to buy token on Solana DEX (already have wallet infrastructure)
  // Alternatively buy spot on OKX directly
  const spotJ = await okxRequest('POST', '/api/v5/trade/order', {
    instId: spotPair, tdMode: 'cash', side: 'buy', ordType: 'market',
    sz: POSITION_SIZE_USD.toString(), tgtCcy: 'quote_ccy',
  });
  if (spotJ.code !== '0') throw new Error('Spot order failed: ' + JSON.stringify(spotJ));

  const position = {
    id: symbol + '-' + Date.now(),
    symbol, exchange,
    openedAt: new Date().toISOString(),
    sizeUsd: POSITION_SIZE_USD,
    fundingRate: rate.rate,
    perpOrderId: perpJ.data?.[0]?.ordId,
    spotOrderId: spotJ.data?.[0]?.ordId,
    status: 'open',
    paymentsCollected: 0,
    totalFunding: 0,
  };

  positions.push(position);
  savePositions(positions);
  console.log('[funding-arb] Opened: ' + symbol + ' on ' + exchange + ' funding: ' + (rate.rate*100).toFixed(4) + '%/8hr');
  return position;
}

// ── Close a funding arb position ──────────────────────────────────────────────
async function closeFundingPosition(positionId) {
  const positions = loadPositions();
  const pos = positions.find(p => p.id === positionId);
  if (!pos) throw new Error('Position not found: ' + positionId);

  // 1. Sell spot (close long)
  // 2. Close short perp
  pos.status = 'closed';
  pos.closedAt = new Date().toISOString();
  savePositions(positions);

  console.log('[funding-arb] Closed position: ' + positionId + ' total funding: $' + pos.totalFunding.toFixed(4));
  return pos;
}

// ── Persistence ───────────────────────────────────────────────────────────────
function loadPositions() {
  try { return JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8')); }
  catch { return []; }
}

function savePositions(positions) {
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

module.exports = {
  getOKXFundingRate,
  getBybitFundingRate,
  scanFundingOpportunities,
  generateFundingReport,
  openFundingPosition,
  closeFundingPosition,
  loadPositions,
  MIN_FUNDING_RATE,
  POSITION_SIZE_USD,
};
