require('dotenv').config();

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const TOKENS = {
  JUP:  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  RAY:  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
};

const DEXES = ['Raydium', 'Orca', 'Meteora', 'Whirlpool', 'RaydiumCLMM'];

async function checkQuote(symbol, mint, dex) {
  const amount = 5 * 1e6; // $5 USDC
  const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${USDC}&outputMint=${mint}&amount=${amount}&slippageBps=100&dexes=${dex}`;

  try {
    const res  = await fetch(url);
    const data = await res.json();
    if (data.outAmount) {
      const price = 5 / (data.outAmount / 1e6);
      return `$${price.toFixed(6)}`;
    }
    return 'no liquidity';
  } catch {
    return 'error';
  }
}

async function main() {
  console.log('Checking liquidity across DEXs...\n');
  console.log(`${'DEX'.padEnd(16)} ${'JUP'.padEnd(16)} ${'BONK'.padEnd(16)} RAY`);
  console.log('─'.repeat(60));

  for (const dex of DEXES) {
    const [jup, bonk, ray] = await Promise.all([
      checkQuote('JUP',  TOKENS.JUP,  dex),
      checkQuote('BONK', TOKENS.BONK, dex),
      checkQuote('RAY',  TOKENS.RAY,  dex),
    ]);
    console.log(`${dex.padEnd(16)} ${jup.padEnd(16)} ${bonk.padEnd(16)} ${ray}`);
    await new Promise(r => setTimeout(r, 500)); // avoid rate limiting
  }

  console.log('\nDone. Use DEXs that show prices, not "no liquidity".');
}

main().catch(console.error);