// funding-monitor.js — perpetual funding rate monitoring
// High funding rates on perps predict spot spread opportunities
// Sources: OKX, Bybit perpetual funding rates

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_FILE = path.join(__dirname, 'funding-cache.json');
const AGENT_LOG  = path.join(__dirname, 'agent.log');

function fundingLog(msg) {
  const line = '['+new Date().toISOString().slice(0,19)+'] [INFO] Funding: '+msg;
  console.log('[funding] '+msg);
  try {
    const existing = require('fs').existsSync(AGENT_LOG) ? require('fs').readFileSync(AGENT_LOG,'utf8') : '';
    const lines = existing.split('\n').filter(Boolean);
    lines.push(line);
    require('fs').writeFileSync(AGENT_LOG, lines.slice(-1000).join('\n')+'\n');
  } catch {}
}
const CACHE_TTL  = 15 * 60 * 1000; // 15 minutes

// Pairs we trade spot — check their perp funding rates
const PERP_PAIRS = ['JTO','SOL','WIF','PENGU','W','RENDER','PNUT','GOAT','RAY','BONK'];

// Funding rate thresholds
const HIGH_FUNDING   =  0.05; // >0.05% per 8hr = high long pressure
const LOW_FUNDING    = -0.05; // <-0.05% per 8hr = high short pressure
const EXTREME_FUNDING = 0.10; // >0.10% = extreme — spread opportunity very likely

function readCache() { try { return JSON.parse(fs.readFileSync(CACHE_FILE,'utf8')); } catch { return null; } }
function writeCache(d) { fs.writeFileSync(CACHE_FILE, JSON.stringify(d,null,2)); }

// ── OKX funding rates ─────────────────────────────────────────────────────────
async function getOKXFundingRates() {
  const rates = {};
  try {
    for (const sym of PERP_PAIRS) {
      try {
        const r = await fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${sym}-USDT-SWAP`);
        const j = await r.json();
        const d = j.data?.[0];
        if (d) {
          rates[sym] = {
            rate: parseFloat(d.fundingRate || 0),
            nextRate: parseFloat(d.nextFundingRate || 0),
            nextTime: parseInt(d.nextFundingTime || 0),
            exchange: 'OKX'
          };
        }
      } catch {}
    }
  } catch(e) { console.log('[funding] OKX error:', e.message); }
  return rates;
}

// ── Bybit funding rates ───────────────────────────────────────────────────────
async function getBybitFundingRates() {
  const rates = {};
  try {
    for (const sym of PERP_PAIRS) {
      try {
        const r = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}USDT`);
        const j = await r.json();
        const d = j.result?.list?.[0];
        if (d) {
          rates[sym] = {
            rate: parseFloat(d.fundingRate || 0),
            nextTime: parseInt(d.nextFundingTime || 0),
            exchange: 'Bybit'
          };
        }
      } catch {}
    }
  } catch(e) { console.log('[funding] Bybit error:', e.message); }
  return rates;
}

// ── Analyse funding rates for signals ────────────────────────────────────────
function analyseRates(okxRates, bybitRates) {
  const signals = [];
  const summary = {};

  for (const sym of PERP_PAIRS) {
    const okx   = okxRates[sym];
    const bybit = bybitRates[sym];
    if (!okx && !bybit) continue;

    // Average rate across exchanges
    const rates = [okx?.rate, bybit?.rate].filter(r => r != null);
    const avgRate = rates.reduce((a,b) => a+b, 0) / rates.length;
    const annualised = avgRate * 3 * 365 * 100; // 3 funding periods per day

    summary[sym] = {
      okxRate:   okx?.rate   || null,
      bybitRate: bybit?.rate || null,
      avgRate,
      annualised: parseFloat(annualised.toFixed(1)),
    };

    // Generate signal
    if (Math.abs(avgRate) >= EXTREME_FUNDING) {
      signals.push({
        sym, rate: avgRate, annualised,
        signal: 'extreme',
        direction: avgRate > 0 ? 'long-heavy' : 'short-heavy',
        implication: avgRate > 0
          ? 'Longs paying shorts — price may drop. DEX price likely above CEX. BUY_CEX opportunity.'
          : 'Shorts paying longs — price may pump. CEX price likely above DEX. BUY_DEX opportunity.',
        urgency: 'high'
      });
    } else if (Math.abs(avgRate) >= HIGH_FUNDING) {
      signals.push({
        sym, rate: avgRate, annualised,
        signal: 'elevated',
        direction: avgRate > 0 ? 'long-heavy' : 'short-heavy',
        implication: avgRate > 0
          ? 'Long pressure building — watch for spot spread widening'
          : 'Short pressure building — potential spot arb window',
        urgency: 'medium'
      });
    }
  }

  // Sort by absolute rate
  signals.sort((a,b) => Math.abs(b.rate) - Math.abs(a.rate));

  return { signals, summary };
}

async function fetchFundingRates() {
  fundingLog('Fetching funding rates...');
  const [okxRates, bybitRates] = await Promise.all([
    getOKXFundingRates(),
    getBybitFundingRates()
  ]);

  const { signals, summary } = analyseRates(okxRates, bybitRates);

  const result = {
    fetchedAt: new Date().toISOString(),
    summary,
    signals,
    highSignals: signals.filter(s => s.urgency === 'high'),
    mediumSignals: signals.filter(s => s.urgency === 'medium'),
  };

  writeCache(result);
  fundingLog(Object.keys(summary).length+' pairs, '+signals.length+' signal(s)');
  return result;
}

function getFundingData() {
  const cache = readCache();
  if (!cache) return null;
  const age = Date.now() - new Date(cache.fetchedAt).getTime();
  if (age > CACHE_TTL) return null;
  return cache;
}

function getTopSignals(n) {
  const data = getFundingData();
  if (!data) return [];
  return data.signals.slice(0, n || 3);
}

module.exports = { fetchFundingRates, getFundingData, getTopSignals };

if (require.main === module) {
  fetchFundingRates().then(data => {
    console.log('\n=== FUNDING RATE SIGNALS ===');
    if (data.signals.length === 0) {
      console.log('No elevated funding rates — market neutral');
    } else {
      data.signals.forEach(s => {
        console.log(`\n${s.sym}: ${(s.rate*100).toFixed(4)}%/8hr (${s.annualised.toFixed(0)}% annualised)`);
        console.log(`  Signal: ${s.signal} (${s.direction})`);
        console.log(`  → ${s.implication}`);
      });
    }
    console.log('\n=== ALL RATES ===');
    Object.entries(data.summary)
      .sort((a,b) => Math.abs(b[1].avgRate) - Math.abs(a[1].avgRate))
      .forEach(([sym,d]) => {
        const bar = d.avgRate > 0 ? '▲' : d.avgRate < 0 ? '▼' : '—';
        console.log(`${sym.padEnd(8)} ${bar} ${(d.avgRate*100).toFixed(4)}%/8hr  (${d.annualised.toFixed(0)}%/yr)`);
      });
  });
}
