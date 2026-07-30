require('dotenv').config();

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const TOKENS = {
  WIF:   'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  RAY:   '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  ORCA:  'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
  PYTH:  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
  SAMO:  '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  MSOL:  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  JITO:  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  POPCAT:'7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
  BOME:  'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',
  MEW:   'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5',
};

const DEXES = ['Raydium', 'Meteora', 'Whirlpool'];

async function checkQuote(mint, dex) {
  const amount = 20 * 1e6;
  const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${USDC}&outputMint=${mint}&amount=${amount}&slippageBps=200&dexes=${dex}`;
  try {
    const res  = await fetch(url);
    const data = await res.json();
    if (data.outAmount && data.outAmount > 0) {
      const impact = parseFloat(data.priceImpactPct || '0');
      return impact < 2 ? '✅' : '⚠️ ';
    }
    return '❌';
  } catch {
    return '❌';
  }
}

async function main() {
  console.log('Checking liquidity for new token candidates ($20 USDC)...\n');

  const dexLabels = DEXES.map(d => d.padEnd(14)).join(' ');
  console.log(`${'Token'.padEnd(8)} ${dexLabels}`);
  console.log('─'.repeat(8 + DEXES.length * 15));

  for (const [symbol, mint] of Object.entries(TOKENS)) {
    const results = [];
    for (const dex of DEXES) {
      await new Promise(r => setTimeout(r, 400));
      const result = await checkQuote(mint, dex);
      results.push(result.padEnd(14));
    }
    console.log(`${symbol.padEnd(8)} ${results.join(' ')}`);
  }

  console.log('\n✅ = liquid  ⚠️  = high impact  ❌ = no liquidity');
}

main().catch(console.error);