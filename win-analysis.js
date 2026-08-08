// win-analysis.js — deep analysis of all winning trades
require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const trades   = JSON.parse(fs.readFileSync(path.join(__dirname,'trades.json'),'utf8'));
const tradelog = JSON.parse(fs.readFileSync(path.join(__dirname,'trade-log.json'),'utf8'));

const real = trades.filter(t => t.direction !== 'RECOVERY');
const wins = real.filter(t => t.profit > 0);
const losses = real.filter(t => t.profit <= 0);

console.log('\n=== WIN ANALYSIS ===');
console.log(`Total real trades: ${real.length} | Wins: ${wins.length} | Losses: ${losses.length}`);
console.log(`Win rate: ${Math.round(wins.length/real.length*100)}%`);

console.log('\n--- All Wins ---');
wins.forEach(t => {
  const log = tradelog.find(l => l.tradeId === t.tradeId);
  const dur = t.durationMin;
  const date = new Date(t.date);
  const utcH = date.getUTCHours();
  console.log(`\n${t.date.slice(0,16)} UTC | ${t.direction.replace('BUY_','')} | ${t.pair.replace('/USDT','')} | spread:${t.spreadPct?.toFixed(3)}% | dur:${dur}min | profit:+$${t.profit?.toFixed(4)} | UTC hour:${utcH}h`);
  if(log) {
    const start = log.events?.find(e=>e.event==='TRADE_START');
    const arrive = log.events?.find(e=>e.event==='TOKEN_ARRIVED');
    const swap = log.events?.find(e=>e.event==='SWAP_SUCCESS');
    if(arrive&&start) console.log(`  Withdrawal time: ${Math.round((arrive.ms-start.ms)/1000)}s`);
    if(swap&&arrive)  console.log(`  Smart sell hold: ${Math.round((swap.ms-arrive.ms)/1000)}s`);
  }
});

console.log('\n--- Win Patterns ---');
const byExchange = {};
const byPair = {};
const byHour = {};
wins.forEach(t => {
  const ex = t.direction.replace('BUY_','');
  const pair = t.pair.replace('/USDT','');
  const h = new Date(t.date).getUTCHours();
  byExchange[ex] = (byExchange[ex]||0) + 1;
  byPair[pair] = (byPair[pair]||{count:0,pnl:0,spreads:[]});
  byPair[pair].count++;
  byPair[pair].pnl += t.profit||0;
  byPair[pair].spreads.push(t.spreadPct||0);
  byHour[h] = (byHour[h]||0) + 1;
});

console.log('\nBy exchange:', JSON.stringify(byExchange));
console.log('By pair:');
Object.entries(byPair).forEach(([p,d]) => {
  const avg = d.spreads.reduce((a,b)=>a+b,0)/d.spreads.length;
  console.log(`  ${p}: ${d.count} wins, avg spread ${avg.toFixed(3)}%, total +$${d.pnl.toFixed(2)}`);
});
console.log('By UTC hour:', Object.entries(byHour).sort((a,b)=>a[0]-b[0]).map(([h,c])=>`${h}h:${c}`).join(', '));

console.log('\n--- Spread Analysis ---');
const winSpreads = wins.map(t=>t.spreadPct||0);
const lossSpreads = losses.map(t=>t.spreadPct||0);
const avgWin = winSpreads.reduce((a,b)=>a+b,0)/winSpreads.length;
const avgLoss = lossSpreads.reduce((a,b)=>a+b,0)/lossSpreads.length;
console.log(`Avg spread on WINS:   ${avgWin.toFixed(3)}%`);
console.log(`Avg spread on LOSSES: ${avgLoss.toFixed(3)}%`);
console.log(`Min winning spread:   ${Math.min(...winSpreads).toFixed(3)}%`);
console.log(`Max winning spread:   ${Math.max(...winSpreads).toFixed(3)}%`);

console.log('\n--- Loss Analysis ---');
losses.forEach(t => {
  console.log(`${t.date.slice(0,16)} | ${t.direction.replace('BUY_','')} | ${t.pair.replace('/USDT','')} | spread:${t.spreadPct?.toFixed(3)}% | dur:${t.durationMin}min | loss:$${t.profit?.toFixed(4)}`);
});

console.log('\n--- Profit Maximisation ---');
const totalWinPnl = wins.reduce((a,t)=>a+(t.profit||0),0);
const totalLossPnl = losses.reduce((a,t)=>a+(t.profit||0),0);
console.log(`Total from wins:   +$${totalWinPnl.toFixed(2)}`);
console.log(`Total from losses: $${totalLossPnl.toFixed(2)}`);
console.log(`Net P&L:           $${(totalWinPnl+totalLossPnl).toFixed(2)}`);
console.log(`Avg profit per win: $${(totalWinPnl/wins.length).toFixed(2)}`);
console.log(`Avg loss per loss:  $${(totalLossPnl/losses.length).toFixed(2)}`);
