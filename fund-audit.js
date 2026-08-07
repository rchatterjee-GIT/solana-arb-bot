// fund-audit.js — complete picture of where all funds are
require('dotenv').config();
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');

function okxSign(ts,m,p,b){b=b||'';return crypto.createHmac('sha256',process.env.OKX_API_SECRET).update(ts+m+p+b).digest('base64');}
async function okxGet(ep){const ts=new Date().toISOString();const r=await fetch('https://www.okx.com'+ep,{headers:{'OK-ACCESS-KEY':process.env.OKX_API_KEY,'OK-ACCESS-SIGN':okxSign(ts,'GET',ep),'OK-ACCESS-TIMESTAMP':ts,'OK-ACCESS-PASSPHRASE':process.env.OKX_PASSPHRASE}});return r.json();}

function bybitSign(ts,rw,p){return crypto.createHmac('sha256',process.env.BYBIT_API_SECRET).update(ts+process.env.BYBIT_API_KEY+rw+p).digest('hex');}
async function bybitGet(ep,qs){const ts=''+Date.now(),rw='5000';const sig=bybitSign(ts,rw,qs);const r=await fetch('https://api.bybit.com'+ep+'?'+qs,{headers:{'X-BAPI-API-KEY':process.env.BYBIT_API_KEY,'X-BAPI-TIMESTAMP':ts,'X-BAPI-SIGN':sig,'X-BAPI-RECV-WINDOW':rw}});return r.json();}

async function krakenGet(){
  const nonce=''+Date.now(),data='nonce='+nonce;
  const hash=crypto.createHash('sha256').update(nonce+data).digest('binary');
  const hmac=crypto.createHmac('sha512',Buffer.from(process.env.KRAKEN_API_SECRET,'base64'));
  hmac.update('/0/private/Balance','binary');hmac.update(hash,'binary');
  const sig=hmac.digest('base64');
  const r=await fetch('https://api.kraken.com/0/private/Balance',{method:'POST',headers:{'API-Key':process.env.KRAKEN_API_KEY,'API-Sign':sig,'Content-Type':'application/x-www-form-urlencoded'},body:data});
  return r.json();
}

(async()=>{
  console.log('\n=== FUND AUDIT ===', new Date().toISOString().slice(0,19), '\n');
  let total = 0;

  // OKX Trading
  try {
    const j = await okxGet('/api/v5/account/balance');
    const details = j.data?.[0]?.details || [];
    const usdt = details.find(d=>d.ccy==='USDT');
    const nonUsdt = details.filter(d=>d.ccy!=='USDT'&&parseFloat(d.eqUsd)>0.01);
    console.log('OKX Trading:');
    console.log('  USDT: $'+parseFloat(usdt?.availBal||0).toFixed(2));
    nonUsdt.forEach(d=>console.log('  '+d.ccy+': '+parseFloat(d.availBal).toFixed(4)+' (~$'+parseFloat(d.eqUsd).toFixed(2)+')'));
    total += parseFloat(usdt?.eqUsd||0) + nonUsdt.reduce((a,d)=>a+parseFloat(d.eqUsd||0),0);
  } catch(e){console.log('OKX error:',e.message);}

  // OKX Funding
  try {
    const j = await okxGet('/api/v5/asset/balances');
    const nonZero = j.data?.filter(d=>parseFloat(d.availBal)>0.01)||[];
    if(nonZero.length>0){
      console.log('OKX Funding:');
      nonZero.forEach(d=>console.log('  '+d.ccy+': '+parseFloat(d.availBal).toFixed(4)));
    }
  } catch(e){}

  // Bybit
  try {
    const j = await bybitGet('/v5/account/wallet-balance','accountType=UNIFIED');
    const coins = j.result?.list?.[0]?.coin||[];
    const nonZero = coins.filter(c=>parseFloat(c.equity)>0.01);
    console.log('\nBybit Unified:');
    nonZero.forEach(c=>console.log('  '+c.coin+': $'+parseFloat(c.usdValue).toFixed(2)+' ('+parseFloat(c.walletBalance).toFixed(4)+')'));
    total += nonZero.reduce((a,c)=>a+parseFloat(c.usdValue||0),0);
  } catch(e){console.log('Bybit error:',e.message);}

  // Kraken
  try {
    const j = await krakenGet();
    const balances = j.result||{};
    console.log('\nKraken:');
    Object.entries(balances).forEach(([k,v])=>{if(parseFloat(v)>0.01)console.log('  '+k+': '+parseFloat(v).toFixed(4));});
    total += parseFloat(balances.USDT||0)+parseFloat(balances.ZUSD||0);
  } catch(e){console.log('Kraken error:',e.message);}

  // Solana wallet
  try {
    const {Connection,Keypair,PublicKey}=require('@solana/web3.js');
    const {getAssociatedTokenAddress,getAccount}=require('@solana/spl-token');
    const conn=new Connection(process.env.RPC_URL,'confirmed');
    const wallet=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY)));
    const USDC=new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const ata=await getAssociatedTokenAddress(USDC,wallet.publicKey);
    const acc=await getAccount(conn,ata);
    const usdc=Number(acc.amount)/1e6;
    console.log('\nSolana Wallet:');
    console.log('  USDC: $'+usdc.toFixed(2));
    total += usdc;

    // Check for non-USDC tokens
    const rpc=process.env.RPC_URL;
    const r=await fetch(rpc,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getTokenAccountsByOwner',params:[wallet.publicKey.toString(),{programId:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'},{encoding:'jsonParsed'}]})});
    const j=await r.json();
    const SYMS={'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL':'JTO','EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm':'WIF','85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ':'W','2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump':'PNUT','CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump':'GOAT','2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv':'PENGU','4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R':'RAY'};
    const toks=(j.result?.value||[]).filter(a=>{const ui=a.account.data.parsed?.info?.tokenAmount?.uiAmount||0;return ui>0.001&&a.account.data.parsed?.info?.mint!=='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';});
    if(toks.length>0){
      toks.forEach(a=>{
        const info=a.account.data.parsed?.info;
        const sym=SYMS[info.mint]||info.mint.slice(0,8);
        console.log('  '+sym+': '+parseFloat(info.tokenAmount.uiAmount).toFixed(4)+' (value unknown)');
      });
    }
  } catch(e){console.log('Solana error:',e.message);}

  // State
  const state=JSON.parse(fs.readFileSync(path.join(__dirname,'arb-state.json')));
  console.log('\n=== SUMMARY ===');
  console.log('Liquid USDT/USDC total: ~$'+total.toFixed(2));
  console.log('P&L (from state):       $'+state.totalProfit?.toFixed(2));
  console.log('Start capital:          $'+state.startCapital?.toFixed(2));
  console.log('Trades:                 '+state.totalTrades);
})();
