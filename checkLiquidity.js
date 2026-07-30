require('dotenv').config();

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const TOKENS = {
  SOL:  'So11111111111111111111111111111111111111112',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  PYTH: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
  JUP:  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
};

const DEXES = ['Raydium', 'RaydiumCLMM', 'Whirlpool', 'Meteora', 'MeteoraDLMM', 'Orca'];

async function checkQuote(mint, dex) {
  const amount = 20 * 1e6;
  const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${USDC}&outputMint=${mint}&amount=${amount}&slippageBps=100&dexes=${dex}`;
  try {
    const res  = await fetch(url);
    const data = await res.json();
    if (data.outAmount && data.outAmount > 0) return '✅';
    return '❌';
  } catch {
    return '❌';
  }
}

async function main() {
  console.log('Checking liquidity ($20 USDC trades)...\n');

  // Header
  const dexLabels = DEXES.map(d => d.padEnd(14)).join(' ');
  console.log(`${'Token'.padEnd(8)} ${dexLabels}`);
  console.log('─'.repeat(8 + DEXES.length * 15));

  for (const [symbol, mint] of Object.entries(TOKENS)) {
    // Stagger requests to avoid rate limiting
    const results = [];
    for (const dex of DEXES) {
      const result = await checkQuote(mint, dex);
      results.push(result.padEnd(14));
      await new Promise(r => setTimeout(r, 300));
    }
    console.log(`${symbol.padEnd(8)} ${results.join(' ')}`);
  }

  console.log('\nDone. Only add pairs/DEXs marked ✅');
}

main().catch(console.error);