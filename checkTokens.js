require('dotenv').config();
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');

const connection = new Connection(process.env.RPC_URL, 'confirmed');
const wallet     = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY)));

const TOKENS = {
  WIF:  { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', decimals: 6 },
  JUP:  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  decimals: 6 },
  BONK: { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5 },
  RAY:  { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', decimals: 6 },
};

async function checkAll() {
  console.log(`Wallet: ${wallet.publicKey.toString()}\n`);

  for (const [symbol, { mint, decimals }] of Object.entries(TOKENS)) {
    try {
      const ata     = await getAssociatedTokenAddress(new PublicKey(mint), wallet.publicKey);
      const account = await getAccount(connection, ata);
      const balance = Number(account.amount) / Math.pow(10, decimals);
      if (balance > 0) {
        console.log(`${symbol.padEnd(6)} ${balance.toFixed(6)}`);
      }
    } catch {
      // No account = zero balance, skip
    }
  }
  console.log('\nDone.');
}

checkAll().catch(console.error);