require('dotenv').config();
const { Connection, Keypair, PublicKey, Transaction } = require('@solana/web3.js');
const { getAssociatedTokenAddress, getAccount, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');

const connection = new Connection(process.env.RPC_URL, 'confirmed');
const wallet     = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY)));

const MINTS = [
  // Tokens we trade
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'So11111111111111111111111111111111111111112',     // WSOL
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  // USDT
  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', // PYTH
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  // JUP
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK

  // Common Jupiter intermediate routing tokens
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', // RAY
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // stSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',  // bSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL
  'EPeUFDgHRxs9xxEPVaL6kfGQvCon7jmAWKVUHuux1Tpz', // BSOL
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF
];

async function main() {
  console.log('Creating token accounts...');
  const ixs = [];

  for (const mintAddress of MINTS) {
    const mint = new PublicKey(mintAddress);
    const ata  = await getAssociatedTokenAddress(mint, wallet.publicKey);
    try {
      await getAccount(connection, ata);
      console.log(`✅ Exists: ${mintAddress.slice(0,8)}...`);
    } catch {
      console.log(`➕ Creating: ${mintAddress.slice(0,8)}...`);
      ixs.push(createAssociatedTokenAccountInstruction(
        wallet.publicKey, ata, wallet.publicKey, mint
      ));
    }
  }

  if (ixs.length === 0) {
    console.log('All accounts already exist.');
    return;
  }

  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  ixs.forEach(ix => tx.add(ix));
  tx.sign(wallet);

  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, 'confirmed');
  console.log(`✅ Done: ${sig.slice(0,20)}...`);
}

main().catch(console.error);