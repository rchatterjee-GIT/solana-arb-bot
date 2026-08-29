/**
 * exchanges/bybit.js — Bybit API wrapper
 * Single responsibility: price data, order placement, withdrawal.
 */
'use strict';
const crypto = require('crypto');

const BASE    = 'https://api.bybit.com';
const TIMEOUT = 6000;

function sign(params, secret) {
  const sorted = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  return crypto.createHmac('sha256', secret).update(sorted).digest('hex');
}

async function request(method, path, params, creds) {
  let url = BASE + path;
  let body;
  if (creds) {
    params = { ...params, api_key: creds.key, timestamp: Date.now(), recv_window: 5000 };
    params.sign = sign(params, creds.secret);
  }
  if (method === 'GET') {
    url += '?' + new URLSearchParams(params).toString();
  } else {
    body = JSON.stringify(params);
  }
  const r = await fetch(url, {
    method, body,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const j = await r.json();
  if (j.retCode && j.retCode !== 0) throw new Error(`Bybit ${path}: ${j.retMsg}`);
  return j.result;
}

async function getTicker(symbol) {
  const data = await request('GET', '/v5/market/tickers', { category: 'spot', symbol }, null);
  const d = data?.list?.[0];
  if (!d) throw new Error(`No ticker for ${symbol}`);
  return { bid: parseFloat(d.bid1Price), ask: parseFloat(d.ask1Price), last: parseFloat(d.lastPrice) };
}

async function getFundingRate(symbol) {
  const data = await request('GET', '/v5/market/tickers', { category: 'linear', symbol }, null);
  const d = data?.list?.[0];
  if (!d) throw new Error(`No funding rate for ${symbol}`);
  return { rate: parseFloat(d.fundingRate), nextTime: d.nextFundingTime };
}

async function getBalance(coin, creds) {
  const data = await request('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED', coin }, creds);
  const coinData = data?.list?.[0]?.coin?.find(c => c.coin === coin);
  // Try multiple field names Bybit uses
  return parseFloat(coinData?.availableToWithdraw || coinData?.walletBalance || coinData?.equity || '0');
}

async function marketBuy(symbol, usdtAmount, creds) {
  const data = await request('POST', '/v5/order/create', {
    category: 'spot', symbol, side: 'Buy', orderType: 'Market',
    qty: usdtAmount.toString(), marketUnit: 'quoteCoin',
  }, creds);
  return data?.orderId;
}

async function getOrder(orderId, symbol, creds) {
  const data = await request('GET', '/v5/order/realtime', { category: 'spot', symbol, orderId }, creds);
  const d = data?.list?.[0];
  if (!d) throw new Error(`Order ${orderId} not found`);
  return { filledQty: parseFloat(d.cumExecQty), avgPrice: parseFloat(d.avgPrice), state: d.orderStatus };
}

async function withdraw(coin, amount, toAddress, chain, creds) {
  const data = await request('POST', '/v5/asset/withdraw/create', {
    coin, chain, address: toAddress, amount: amount.toString(), timestamp: Date.now(),
  }, creds);
  return data?.id;
}

module.exports = { getTicker, getFundingRate, getBalance, marketBuy, getOrder, withdraw };
