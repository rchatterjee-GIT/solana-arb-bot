// agent-rules.js — rule library for autonomous trading agent
// Each rule: { id, name, detect(ctx), action(ctx), severity }
// severity: 'info' | 'warn' | 'critical'

module.exports = [

  // ── PAIR PERFORMANCE RULES ────────────────────────────────────────────────

  {
    id: 'pair-consecutive-losses',
    name: 'Pair consecutive losses',
    severity: 'warn',
    detect(ctx) {
      const issues = [];
      for (const [pair, stats] of Object.entries(ctx.pairStats)) {
        const ccy = pair.replace('/USDT','');
        if (stats.recentLosses >= 3 && !ctx.config.POLICY_SKIP_OKX?.includes(ccy) && !ctx.config.POLICY_SKIP_BYBIT?.includes(ccy)) {
          issues.push({ pair, ccy, recentLosses: stats.recentLosses, exchange: stats.lastExchange });
        }
      }
      return issues.length ? issues : null;
    },
    async action(ctx, issues) {
      const changes = [];
      for (const issue of issues) {
        const { ccy, exchange } = issue;
        // Add to appropriate skip list for 24 hours
        const skipKey = exchange === 'OKX' ? 'POLICY_SKIP_OKX' : exchange === 'Bybit' ? 'POLICY_SKIP_BYBIT' : null;
        if (skipKey && !ctx.config[skipKey].includes(ccy)) {
          ctx.config[skipKey].push(ccy);
          // Schedule re-enable after 24hrs
          if (!ctx.config.TEMP_SKIPS) ctx.config.TEMP_SKIPS = {};
          ctx.config.TEMP_SKIPS[`${ccy}:${skipKey}`] = Date.now() + 24 * 60 * 60 * 1000;
          changes.push(`${ccy} added to ${skipKey} (24hr temp skip — 3 consecutive losses)`);
        }
      }
      return changes;
    }
  },

  {
    id: 'pair-high-loss-rate',
    name: 'Pair high loss rate',
    severity: 'warn',
    detect(ctx) {
      const issues = [];
      for (const [pair, stats] of Object.entries(ctx.pairStats)) {
        const ccy = pair.replace('/USDT','');
        if (stats.total >= 4 && stats.lossRate > 0.75) {
          issues.push({ pair, ccy, lossRate: stats.lossRate, total: stats.total, exchange: stats.lastExchange });
        }
      }
      return issues.length ? issues : null;
    },
    async action(ctx, issues) {
      const changes = [];
      for (const issue of issues) {
        const { ccy, lossRate, exchange } = issue;
        const skipKey = exchange === 'OKX' ? 'POLICY_SKIP_OKX' : exchange === 'Bybit' ? 'POLICY_SKIP_BYBIT' : null;
        if (skipKey && !ctx.config[skipKey].includes(ccy)) {
          ctx.config[skipKey].push(ccy);
          if (!ctx.config.TEMP_SKIPS) ctx.config.TEMP_SKIPS = {};
          ctx.config.TEMP_SKIPS[`${ccy}:${skipKey}`] = Date.now() + 24 * 60 * 60 * 1000;
          changes.push(`${ccy} added to ${skipKey} (24hr — ${Math.round(lossRate*100)}% loss rate over ${issue.total} trades)`);
        }
      }
      return changes;
    }
  },

  {
    id: 'pair-threshold-too-low',
    name: 'Pair threshold may be too low',
    severity: 'info',
    detect(ctx) {
      // If a pair is losing despite high spread, threshold needs raising
      const issues = [];
      for (const [pair, stats] of Object.entries(ctx.pairStats)) {
        const ccy = pair.replace('/USDT','');
        if (stats.total >= 3 && stats.lossRate > 0.6 && stats.avgSpread > 1.5) {
          const currentMin = ctx.config.PAIR_MIN_SPREAD?.[ccy] || ctx.config.MIN_SPREAD_CEX || 1.0;
          const suggested = parseFloat((stats.avgSpread * 1.2).toFixed(1));
          if (suggested > currentMin + 0.3) {
            issues.push({ ccy, currentMin, suggested, avgSpread: stats.avgSpread, lossRate: stats.lossRate });
          }
        }
      }
      return issues.length ? issues : null;
    },
    async action(ctx, issues) {
      const changes = [];
      for (const issue of issues) {
        const { ccy, currentMin, suggested } = issue;
        if (!ctx.config.PAIR_MIN_SPREAD) ctx.config.PAIR_MIN_SPREAD = {};
        ctx.config.PAIR_MIN_SPREAD[ccy] = suggested;
        changes.push(`${ccy} PAIR_MIN_SPREAD raised: ${currentMin}% → ${suggested}% (losses at high spread)`);
      }
      return changes;
    }
  },

  // ── TEMP SKIP EXPIRY ──────────────────────────────────────────────────────

  {
    id: 'temp-skip-expiry',
    name: 'Re-enable temporarily skipped pairs',
    severity: 'info',
    detect(ctx) {
      if (!ctx.config.TEMP_SKIPS) return null;
      const expired = Object.entries(ctx.config.TEMP_SKIPS).filter(([,t]) => Date.now() > t);
      return expired.length ? expired : null;
    },
    async action(ctx, expired) {
      const changes = [];
      for (const [key] of expired) {
        const [ccy, skipKey] = key.split(':');
        if (ctx.config[skipKey]) {
          ctx.config[skipKey] = ctx.config[skipKey].filter(c => c !== ccy);
          delete ctx.config.TEMP_SKIPS[key];
          changes.push(`${ccy} removed from ${skipKey} (24hr temp skip expired)`);
        }
      }
      return changes;
    }
  },

  // ── BALANCE RULES ─────────────────────────────────────────────────────────

  {
    id: 'okx-critically-low',
    name: 'OKX balance critically low',
    severity: 'critical',
    detect(ctx) {
      if (ctx.balances.okx != null && ctx.balances.okx < ctx.config.TRADE_SIZE_USD * 0.9) {
        return [{ okx: ctx.balances.okx, minimum: ctx.config.TRADE_SIZE_USD }];
      }
      return null;
    },
    async action(ctx, issues) {
      // Trigger rebalance via Telegram
      await ctx.sendTG(`⚠️ Agent: OKX critically low $${issues[0].okx.toFixed(0)} — triggering rebalance`);
      await ctx.sendTG('/rb confirm');
      return [`OKX $${issues[0].okx.toFixed(0)} below minimum — rebalance triggered`];
    }
  },

  {
    id: 'exchange-severely-imbalanced',
    name: 'Exchange severely imbalanced',
    severity: 'warn',
    detect(ctx) {
      const issues = [];
      const checks = [
        { ex: 'solana', target: ctx.config.REBALANCE_TARGET_SOLANA || 200 },
        { ex: 'okx',    target: ctx.config.REBALANCE_TARGET_OKX    || 350 },
        { ex: 'bybit',  target: ctx.config.REBALANCE_TARGET_BYBIT  || 300 },
      ];
      for (const { ex, target } of checks) {
        const bal = ctx.balances[ex];
        if (bal != null && Math.abs(bal - target) / target > 0.30) {
          issues.push({ ex, bal, target, pct: Math.round(Math.abs(bal-target)/target*100) });
        }
      }
      return issues.length ? issues : null;
    },
    async action(ctx, issues) {
      const msgs = issues.map(i => `${i.ex}: $${i.bal.toFixed(0)} vs target $${i.target} (${i.pct}% off)`);
      await ctx.sendTG(`⚖️ Agent: Exchange imbalance detected\n${msgs.join('\n')}\nSending /rb`);
      await ctx.sendTG('/rb confirm');
      return [`Rebalance triggered: ${msgs.join(', ')}`];
    }
  },

  // ── OPERATIONAL RULES ─────────────────────────────────────────────────────

  {
    id: 'stuck-trade',
    name: 'Trade stuck > 90 minutes',
    severity: 'critical',
    detect(ctx) {
      const stuck = (ctx.pending || []).filter(t => Date.now() - t.startTime > 90 * 60 * 1000);
      return stuck.length ? stuck : null;
    },
    async action(ctx, stuck) {
      const msgs = stuck.map(t => `${t.symbol} ${t.direction} started ${Math.round((Date.now()-t.startTime)/60000)}min ago`);
      await ctx.sendTG(`🚨 Agent: Stuck trade(s) detected:\n${msgs.join('\n')}\nCheck exchange withdrawal status.`);
      return [`Stuck trade alert: ${msgs.join(', ')}`];
    }
  },

  {
    id: 'bot-stale',
    name: 'Bot status stale > 3 minutes',
    severity: 'critical',
    detect(ctx) {
      if (!ctx.botStatus?.timestamp) return null;
      const age = Date.now() - new Date(ctx.botStatus.timestamp).getTime();
      if (age > 3 * 60 * 1000) return [{ age: Math.round(age/1000) }];
      return null;
    },
    async action(ctx, issues) {
      await ctx.sendTG(`🚨 Agent: Bot status stale ${issues[0].age}s — bot may be crashed. Check watchdog.`);
      return [`Bot stale ${issues[0].age}s — alert sent`];
    }
  },

  {
    id: 'state-drift',
    name: 'State drift detected',
    severity: 'warn',
    detect(ctx) {
      const stateTrades = ctx.state.totalTrades || 0;
      const actualTrades = ctx.realTradeCount || 0;
      if (Math.abs(stateTrades - actualTrades) > 2) {
        return [{ stateTrades, actualTrades }];
      }
      return null;
    },
    async action(ctx, issues) {
      // Auto-resync state
      const { stateTrades, actualTrades } = issues[0];
      await ctx.sendTG(`⚠️ Agent: State drift detected (state:${stateTrades} vs actual:${actualTrades}) — auto-resyncing`);
      await ctx.resyncState();
      return [`State resynced: ${stateTrades} → ${actualTrades}`];
    }
  },

  {
    id: 'crash-log-precision-error',
    name: 'Known precision error in crash log',
    severity: 'warn',
    detect(ctx) {
      const patterns = [
        { pattern: 'too many decimals', fix: 'precision', exchange: 'Bybit' },
        { pattern: 'Invalid quantity precision', fix: 'precision', exchange: 'OKX' },
      ];
      const found = [];
      const recentCrashes = ctx.recentCrashLines || [];
      for (const p of patterns) {
        if (recentCrashes.some(line => line.includes(p.pattern))) {
          found.push(p);
        }
      }
      return found.length ? found : null;
    },
    async action(ctx, issues) {
      // Alert — precision fixes are in hygiene.js, just notify
      await ctx.sendTG(`⚠️ Agent: Precision error detected in crash log — hygiene.js should handle on next cycle`);
      return ['Precision error detected — hygiene cycle will fix'];
    }
  },

  // ── LEARNING RULES ────────────────────────────────────────────────────────

  {
    id: 'winning-pair-threshold-opportunity',
    name: 'Winning pair may fire more at lower threshold',
    severity: 'info',
    detect(ctx) {
      // If a pair has >60% win rate and >5 trades, check if threshold could be lowered
      const opportunities = [];
      for (const [pair, stats] of Object.entries(ctx.pairStats)) {
        const ccy = pair.replace('/USDT','');
        if (stats.total >= 5 && stats.winRate > 0.60 && stats.avgWinSpread > 0) {
          const currentMin = ctx.config.PAIR_MIN_SPREAD?.[ccy] || ctx.config.MIN_SPREAD_CEX || 1.5;
          // If wins cluster well above current threshold, we might be too conservative
          if (stats.minWinSpread > currentMin * 1.5) {
            opportunities.push({ ccy, currentMin, minWinSpread: stats.minWinSpread, winRate: stats.winRate });
          }
        }
      }
      return opportunities.length ? opportunities : null;
    },
    async action(ctx, opps) {
      const msgs = opps.map(o => `${o.ccy}: ${Math.round(o.winRate*100)}% win rate, all wins above ${o.minWinSpread.toFixed(2)}% (threshold: ${o.currentMin}%)`);
      await ctx.sendTG(`💡 Agent recommendation:\n${msgs.join('\n')}\nConsider raising thresholds for more selective firing.`);
      return [`Threshold opportunity identified: ${opps.map(o=>o.ccy).join(', ')}`];
    }
  },

  {
    id: 'daily-performance-report',
    name: 'Daily performance report',
    severity: 'info',
    detect(ctx) {
      // Fire once per day at 06:00 UTC
      const now = new Date();
      const lastReport = ctx.agentState.lastDailyReport || 0;
      const todayReport = new Date().setUTCHours(6,0,0,0);
      if (now.getUTCHours() === 6 && Date.now() - lastReport > 20 * 60 * 60 * 1000) {
        return [{ date: now.toISOString().slice(0,10) }];
      }
      return null;
    },
    async action(ctx, issues) {
      const since = Date.now() - 24*60*60*1000;
      const trades = ctx.trades.filter(t => new Date(t.date).getTime() > since && t.direction !== 'RECOVERY');
      const wins = trades.filter(t => t.profit > 0);
      const pnl = trades.reduce((a,t) => a+(t.profit||0), 0);
      const fires = ctx.fires.filter(f => new Date(f.date).getTime() > since);
      const failed = fires.filter(f => f.outcome === 'failed');

      const msg = `📊 <b>Daily Report ${issues[0].date}</b>\n` +
        `Fires: ${fires.length} | Failed: ${failed.length}\n` +
        `Trades: ${trades.length} | Wins: ${wins.length}\n` +
        `P&L: ${pnl>=0?'+':''}$${pnl.toFixed(2)}\n` +
        `Total P&L: ${ctx.state.totalProfit>=0?'+':''}$${(ctx.state.totalProfit||0).toFixed(2)}\n` +
        `ConsecWins: ${ctx.state.consecutiveWins||0}/10 | Clean: ${ctx.state.consecutiveClean||0}/20\n` +
        `OKX: $${(ctx.balances.okx||0).toFixed(0)} | By: $${(ctx.balances.bybit||0).toFixed(0)} | Sol: $${(ctx.balances.solana||0).toFixed(0)}`;

      await ctx.sendTG(msg);
      ctx.agentState.lastDailyReport = Date.now();
      return ['Daily report sent'];
    }
  },

];
