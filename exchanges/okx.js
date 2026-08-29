/**
 * exchanges/okx.js — OKX API wrapper
 * Single responsibility: price data, order placement, withdrawal.
 * No business logic. All functions return plain objects or throw.
 */
'use strict';
const crypto = require('crypto');

const BASE = 'https://www.okx.com';
const TIMEOUT_MS = 6000;

function sign(ts, method, path, body, secret) {
  return crypto.createHmac('sha256', secret)
    .update(ts + method + path + (body || '')).digest('base64');
}

function headers(key, secret, passphrase, method, path, body) {
  const ts = new Date().toISOString();
  return {
    'Content-Type': 'application/json',
    'OK-ACCESS-KEY': key,
    'OK-ACCESS-SIGN': sign(ts, method, path, body, secret),
    'OK-ACCESS-TIMESTAMP': ts,
    'OK-ACCESS-PASSPHRASE': passphrase,
  };
}

async function request(method, path, body, creds) {
  const bodyStr = body ? JSON.stringify(body) : '';
  const r = await fetch(BASE + path, {
    method,
    headers: creds ? headers(creds.key, creds.secret, creds.passphrase, method, path, bodyStr) : { 'Content-Type': 'application/json' },
    body: bodyStr || undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = await r.json();
  if (j.code && j.code !== '0') throw new Error(`OKX ${path}: ${j.msg || j.code}`);
  return j.data;
}

// ── Public ────────────────────────────────────────────────────────────────────
async function getTicker(instId) {
  const data = await request('GET', `/api/v5/market/ticker?instId=${instId}`, null, null);
  const d = data?.[0];
  if (!d) throw new Error(`No ticker for ${instId}`);
  return { bid: parseFloat(d.bidPx), ask: parseFloat(d.askPx), last: parseFloat(d.last), open24h: parseFloat(d.open24h) };
}

async function getFundingRate(instId) {
  const data = await request('GET', `/api/v5/public/funding-rate?instId=${instId}`, null, null);
  const d = data?.[0];
  if (!d) throw new Error(`No funding rate for ${instId}`);
  return { rate: parseFloat(d.fundingRate), nextTime: d.nextFundingTime };
}

async function getWithdrawalInfo(ccy) {
  const data = await request('GET', `/api/v5/asset/currencies?ccy=${ccy}`, null, null);
  return (data || []).filter(c => c.ccy === ccy);
}

// ── Private (requires creds) ──────────────────────────────────────────────────
async function getBalance(ccy, creds) {
  const data = await request('GET', `/api/v5/account/balance?ccy=${ccy}`, null, creds);
  return parseFloat(data?.[0]?.details?.find(d => d.ccy === ccy)?.availBal || '0');
}

async function getFundingBalance(ccy, creds) {
  const data = await request('GET', `/api/v5/asset/balances?ccy=${ccy}`, null, creds);
  return parseFloat(data?.[0]?.availBal || '0');
}

async function marketBuy(instId, usdtAmount, creds) {
  const data = await request('POST', '/api/v5/trade/order', {
    instId, tdMode: 'cash', side: 'buy', ordType: 'market',
    sz: usdtAmount.toString(), tgtCcy: 'quote_ccy',
  }, creds);
  return data?.[0]?.ordId;
}

async function getOrder(instId, ordId, creds) {
  const data = await request('GET', `/api/v5/trade/order?instId=${instId}&ordId=${ordId}`, null, creds);
  const d = data?.[0];
  if (!d) throw new Error(`Order ${ordId} not found`);
  return { filledQty: parseFloat(d.fillSz), avgPrice: parseFloat(d.avgPx), state: d.state };
}

async function transferToFunding(ccy, amount, creds) {
  await request('POST', '/api/v5/asset/transfer', {
    ccy, amt: amount.toString(), from: '18', to: '6', type: '0',
  }, creds);
}

async function withdraw(ccy, amount, toAddress, chain, creds, fee) {
  const data = await request('POST', '/api/v5/asset/withdrawal', {
    ccy, amt: amount.toString(), dest: '4', toAddr: toAddress,
    chain: `${ccy}-${chain}`, fee: fee || '0.29',
  }, creds);
  return data?.[0]?.wdId;
}

async function getWithdrawalStatus(wdId, creds) {
  const data = await request('GET', `/api/v5/asset/deposit-withdraw-status?wdId=${wdId}`, null, creds);
  return data?.[0]?.state;
}

module.exports = {
  getTicker, getFundingRate, getWithdrawalInfo,
  getBalance, getFundingBalance, marketBuy, getOrder,
  transferToFunding, withdraw, getWithdrawalStatus,
};
