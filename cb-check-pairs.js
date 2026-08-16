// cb-check-pairs.js — check all available Coinbase products for our tokens
require('dotenv').config();
const crypto = require('crypto');

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

(async () => {
  const TOKENS = ['JTO','WIF','BONK','RAY','PNUT','RENDER','GOAT','TRUMP','JUP','W','PYTH','PENGU'];
  const r = await fetch('https://api.coinbase.com/api/v3/brokerage/products?limit=500', {
    headers: { 'Authorization': 'Bearer ' + buildJWT('GET', '/api/v3/brokerage/products') }
  });
  const j = await r.json();
  const all = j.products || [];
  console.log('Total products:', all.length);
  const found = all.filter(p => TOKENS.some(t => (p.base_currency_id||'').toUpperCase() === t));
  console.log('\nMatching our tokens:');
  found.forEach(p => console.log(' ', p.product_id.padEnd(20), 'type:', (p.product_type||'').padEnd(10), 'status:', p.status));
  if (found.length === 0) console.log('None found — Coinbase may use different product IDs');
})().catch(e => console.error(e.message));
