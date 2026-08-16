// news-monitor.js — automated crypto news trawl
// Sources: CoinDesk, CoinTelegraph, Decrypt, The Block RSS feeds
// Filters for strategy-relevant content and updates macro-context.json

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const MACRO_FILE  = path.join(__dirname, 'macro-context.json');
const NEWS_CACHE  = path.join(__dirname, 'news-cache.json');
const AGENT_LOG   = path.join(__dirname, 'agent.log');
const CACHE_TTL   = 4 * 60 * 60 * 1000; // 4 hours

// RSS sources — crypto native + macro/investment
const RSS_SOURCES = [
  // Crypto native
  { name: 'CoinDesk',      url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', weight: 1.0 },
  { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss', weight: 1.0 },
  { name: 'Decrypt',       url: 'https://decrypt.co/feed', weight: 0.9 },
  { name: 'The Block',     url: 'https://www.theblock.co/rss.xml', weight: 1.0 },
  { name: 'Blockworks',    url: 'https://blockworks.co/feed', weight: 0.9 },
  { name: 'DL News',       url: 'https://www.dlnews.com/rss/', weight: 0.8 },
  // Investment/macro with crypto coverage
  { name: 'Motley Fool Crypto', url: 'https://www.fool.com/feeds/index.aspx?id=cryptocurrency', weight: 0.8 },
  { name: 'Forbes Crypto', url: 'https://www.forbes.com/crypto-blockchain/feed/', weight: 0.7 },
  { name: 'Bloomberg Crypto', url: 'https://feeds.bloomberg.com/crypto/news.rss', weight: 1.0 },
  // Macro indicators
  { name: 'Reuters Finance', url: 'https://feeds.reuters.com/reuters/businessNews', weight: 0.6 },
  { name: 'FT Markets',    url: 'https://www.ft.com/markets?format=rss', weight: 0.7 },
];

// Keywords scored by relevance to our strategy
const KEYWORD_SCORES = {
  // High relevance — direct strategy impact
  'solana':           10, 'dex':              10, 'jupiter':          10,
  'arbitrage':         9, 'arb ':              9, 'spread':            8,
  'okx':               8, 'bybit':             8, 'kraken':            8,
  'listing':           8, 'new listing':       9, 'token launch':      8,
  'funding rate':      9, 'perpetual':         7,
  // Medium relevance — macro impact
  'bitcoin':           5, 'btc':               5, 'ethereum':          5,
  'eth ':              4, 'bull':              4, 'bear':              4,
  'volume':            5, 'liquidity':         5, 'volatility':        6,
  'defi':              5, 'on-chain':          6, 'blockchain':        3,
  // High urgency — immediate action
  'hack':             10, 'exploit':          10, 'hacked':           10,
  'ban':               9, 'sec':               7, 'regulatory':        6,
  'suspend':           8, 'delist':            9, 'halt':              8,
  'crash':             7, 'dump':              6, 'pump':              6,
  // Exchange specific
  'exchange':          5, 'centralized':       4, 'decentralized':     5,
  'cex':               6, 'spot':              5,
  // Macro/investment terms
  'interest rate':     5, 'federal reserve':   5, 'fed ':              4,
  'inflation':         4, 'recession':         6, 'gdp':               3,
  'institutional':     5, 'etf':               7, 'spot etf':          8,
  'adoption':          5, 'market cap':        4, 'all-time high':     6,
  'bear market':       6, 'bull market':       6, 'recovery':          5,
  'accumulation':      5, 'distribution':      4, 'halving':           7,
  'treasury':          5, 'microstrategy':     4, 'blackrock':         5,
  'tokenized':         6, 'rwa':               6, 'real world asset':  6,
};

// Negative keywords — reduce score
const NEGATIVE_KEYWORDS = ['nft', 'gaming', 'metaverse', 'celebrity', 'meme coin opinion'];

const URGENCY_KEYWORDS = ['hack', 'exploit', 'hacked', 'ban', 'suspend', 'delist', 'crash'];

function newsLog(msg) {
  const line = '['+new Date().toISOString().slice(0,19)+'] [INFO] News: '+msg;
  console.log('[news] '+msg);
  try {
    const existing = fs.existsSync(AGENT_LOG) ? fs.readFileSync(AGENT_LOG,'utf8') : '';
    const lines = existing.split('\n').filter(Boolean);
    lines.push(line);
    fs.writeFileSync(AGENT_LOG, lines.slice(-1000).join('\n')+'\n');
  } catch {}
}

function readJSON(f) { try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch { return null; } }
function writeJSON(f,d) { fs.writeFileSync(f, JSON.stringify(d,null,2)); }

// Simple RSS parser — no external deps
function parseRSS(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item[^>]*>[\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks) {
    const title   = (block.match(/<title[^>]*><!\[CDATA\[([^\]]*)\]\]><\/title>/i) || block.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
    const desc    = (block.match(/<description[^>]*><!\[CDATA\[([^\]]*)\]\]><\/description>/i) || block.match(/<description[^>]*>([^<]*)<\/description>/i) || [])[1] || '';
    const link    = (block.match(/<link[^>]*>([^<]*)<\/link>/i) || [])[1] || '';
    const pubDate = (block.match(/<pubDate[^>]*>([^<]*)<\/pubDate>/i) || [])[1] || '';
    const clean = (s) => s.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').trim();
    if (title) items.push({ title: clean(title), desc: clean(desc).slice(0,300), link: clean(link), pubDate });
  }
  return items;
}

function scoreItem(item) {
  const text = (item.title + ' ' + item.desc).toLowerCase();
  const sourceWeight = (RSS_SOURCES.find(s => s.name === item.source) || {}).weight || 1.0;
  let score = 0;

  // Apply positive keywords
  for (const [kw, pts] of Object.entries(KEYWORD_SCORES)) {
    if (text.includes(kw)) score += pts;
  }

  // Apply negative keywords
  for (const kw of NEGATIVE_KEYWORDS) {
    if (text.includes(kw)) score -= 5;
  }

  // Check urgency
  const urgent = URGENCY_KEYWORDS.some(kw => text.includes(kw));

  // Recency boost — last 2 hours
  const age = pubDate => {
    if (!pubDate) return 999;
    return (Date.now() - new Date(pubDate).getTime()) / 3600000;
  };
  const ageHrs = age(item.pubDate);
  if (ageHrs < 1) score += 5;
  else if (ageHrs < 2) score += 3;
  else if (ageHrs > 24) score -= 3;

  return { score: Math.max(0, Math.round(score * sourceWeight)), urgent };
}

function extractImplications(item) {
  const text = (item.title + ' ' + item.desc).toLowerCase();
  const implications = [];

  if (text.includes('dex') || text.includes('decentralized')) {
    implications.push('DEX activity update — monitor Jupiter liquidity');
  }
  if (text.includes('solana') && text.includes('volume')) {
    implications.push('Solana volume movement — may affect DEX spread windows');
  }
  if (text.includes('listing') || text.includes('new token')) {
    implications.push('New listing detected — check if available on OKX/Bybit for arb');
  }
  if (text.includes('funding rate') || text.includes('perpetual')) {
    implications.push('Perpetuals market moving — check funding rates for spot spread signal');
  }
  if (URGENCY_KEYWORDS.some(kw => text.includes(kw))) {
    const affected = ['okx','bybit','kraken'].filter(ex => text.includes(ex));
    implications.push('URGENT: ' + (affected.length ? affected.join('/').toUpperCase()+' affected' : 'Market impact') + ' — review positions');
  }
  if (text.includes('bull') && (text.includes('market') || text.includes('recovery'))) {
    implications.push('Bullish macro signal — increased arb activity expected');
  }
  if (text.includes('ban') || text.includes('regulatory') || text.includes('sec')) {
    implications.push('Regulatory development — monitor exchange availability');
  }

  return implications.length ? implications : ['General market development — monitor for spread impact'];
}

async function fetchRSS(source) {
  try {
    const r = await fetch(source.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 ArbitrageBot/1.0' },
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) return [];
    const xml = await r.text();
    return parseRSS(xml).map(item => ({ ...item, source: source.name }));
  } catch(e) {
    newsLog(source.name + ' fetch error: ' + e.message);
    return [];
  }
}

async function runNewsTrawl(sendTG) {
  const cache = readJSON(NEWS_CACHE) || { lastRun: 0, seen: [] };
  const age = Date.now() - cache.lastRun;
  if (age < CACHE_TTL) {
    newsLog('Cache fresh (' + Math.round(age/60000) + 'min old) — skipping');
    return null;
  }

  newsLog('Starting news trawl from ' + RSS_SOURCES.length + ' sources...');

  // Fetch all sources in parallel
  const allItems = (await Promise.all(RSS_SOURCES.map(fetchRSS))).flat();
  newsLog('Fetched ' + allItems.length + ' total articles');

  // Filter out seen items
  const newItems = allItems.filter(item => !cache.seen.includes(item.link));

  // Score and filter
  const scored = newItems.map(item => ({
    ...item,
    ...scoreItem(item),
    implications: extractImplications(item),
  })).filter(item => item.score >= 10).sort((a,b) => b.score - a.score);

  newsLog('Relevant articles: ' + scored.length + ' (threshold: 10pts)');

  // Update cache
  cache.lastRun = Date.now();
  cache.seen = [...new Set([...cache.seen, ...allItems.map(i=>i.link)])].slice(-500);
  writeJSON(NEWS_CACHE, cache);

  if (scored.length === 0) return null;

  // Handle urgent items immediately
  const urgent = scored.filter(i => i.urgent);
  if (urgent.length > 0 && sendTG) {
    for (const item of urgent.slice(0,2)) {
      await sendTG('🚨 [ALERT] Urgent News\n' + item.title + '\n' + item.implications.join('\n') + '\n' + item.link);
    }
  }

  // Update macro context with top items
  const top = scored.slice(0,5);
  const macro = readJSON(MACRO_FILE) || { themes: [], structuralInsights: {} };

  for (const item of top) {
    // Check if we already have this theme
    const exists = macro.themes.some(t => t.headline === item.title);
    if (!exists) {
      macro.themes.unshift({
        date: new Date().toISOString().slice(0,10),
        source: item.source,
        headline: item.title,
        implications: item.implications,
        botActions: [],
        sentiment: item.score > 20 ? 'high_impact' : 'moderate_impact',
        score: item.score,
        link: item.link,
      });
    }
  }

  // Keep last 10 themes
  macro.themes = macro.themes.slice(0,10);
  macro.lastNewsRun = new Date().toISOString();
  writeJSON(MACRO_FILE, macro);

  return {
    total: allItems.length,
    relevant: scored.length,
    urgent: urgent.length,
    top: top.slice(0,3),
  };
}

function formatDigest(result) {
  if (!result || result.relevant === 0) return null;
  let msg = '📡 [MARKET] News Digest\n';
  msg += result.relevant + ' relevant articles from ' + RSS_SOURCES.length + ' sources\n\n';
  result.top.forEach(function(item) {
    msg += '<b>[' + item.source + ']</b> ' + item.title + '\n';
    if (item.implications[0]) msg += '→ ' + item.implications[0] + '\n';
    msg += '\n';
  });
  return msg;
}

module.exports = { runNewsTrawl, formatDigest };

if (require.main === module) {
  runNewsTrawl(null).then(r => {
    if (r) {
      console.log('\nResults:', r.total, 'fetched,', r.relevant, 'relevant,', r.urgent, 'urgent');
      r.top.forEach(i => console.log('\n['+i.score+'pts] ['+i.source+']', i.title, '\n  →', i.implications[0]));
    } else {
      console.log('No new relevant articles');
    }
  }).catch(e => console.error(e.message));
}
