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
      if (!ctx.config.TEMP_SKIPS || Object.keys(ctx.config.TEMP_SKIPS).length === 0) return null;
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

  // ── MARKET DATA RULES ─────────────────────────────────────────────────────

  {
    id: 'market-avoid-signal',
    name: 'Market signal: avoid pair',
    severity: 'warn',
    detect(ctx) {
      if (!ctx.marketData) return null;
      const { getPairSignal } = require('./market-data');
      const pairs = Object.keys(ctx.config.PAIR_MIN_SPREAD || {}).concat(['JTO','PENGU','GOAT','W','RENDER','RAY','PNUT']);
      const avoids = [];
      for (const sym of [...new Set(pairs)]) {
        const signal = getPairSignal(sym);
        if (signal?.signal === 'avoid') {
          avoids.push({ sym, reason: signal.reason });
        }
      }
      return avoids.length ? avoids : null;
    },
    async action(ctx, avoids) {
      const changes = [];
      for (const { sym, reason } of avoids) {
        // Temporarily raise threshold for this pair
        if (!ctx.config.PAIR_MIN_SPREAD) ctx.config.PAIR_MIN_SPREAD = {};
        const current = ctx.config.PAIR_MIN_SPREAD[sym] || ctx.config.MIN_SPREAD_CEX || 1.5;
        const raised = parseFloat((current + 1.0).toFixed(1));
        if (raised > current) {
          ctx.config.PAIR_MIN_SPREAD[sym] = raised;
          if (!ctx.config.TEMP_SKIPS) ctx.config.TEMP_SKIPS = {};
          ctx.config.TEMP_SKIPS[`${sym}:threshold`] = Date.now() + 4 * 60 * 60 * 1000; // 4hr
          changes.push(`${sym} threshold raised ${current}% → ${raised}% (market: ${reason})`);
        }
      }
      return changes;
    }
  },

  {
    id: 'market-active-window',
    name: 'Market: active trading window detected',
    severity: 'info',
    detect(ctx) {
      if (!ctx.marketData) return null;
      const { isActiveWindow, getBestOpportunities } = require('./market-data');
      if (!isActiveWindow()) {
        // Reset flag when window closes so next window fires again
        if (ctx.agentState.activeWindowAlerted) ctx.agentState.activeWindowAlerted = false;
        return null;
      }
      // Only alert once per active window session
      if (ctx.agentState.activeWindowAlerted) return null;
      const skipOKX   = ctx.config.POLICY_SKIP_OKX   || [];
      const skipBybit = ctx.config.POLICY_SKIP_BYBIT || [];
      const allSkipped = [...new Set([...skipOKX, ...skipBybit])];
      const opps = getBestOpportunities(5).filter(function(p) {
        return !allSkipped.includes(p.symbol) && p.symbol !== 'PYTH';
      });
      const highScore = opps.filter(function(p) { return p.score > 6; });
      if (highScore.length > 0) return [{ opps: highScore }];
      return null;
    },
    async action(ctx, issues) {
      const opps = issues[0].opps;
      const lines = opps.map(function(p){return p.symbol+': score '+p.score.toFixed(1)+', vol '+(p.volatility||0).toFixed(1)+', 24h '+(p.change24h||0).toFixed(1)+'%';});
      await ctx.sendTG('Active Window Alert\nHigh opportunity pairs:\n' + lines.join('\n') + '\nBot is scanning - opportunities likely.');
      ctx.agentState.activeWindowAlerted = true;
      return ['Active window: ' + opps.map(function(p){return p.symbol;}).join(', ') + ' showing high scores'];
    }
  },

  {
    id: 'market-sentiment-report',
    name: 'Market sentiment update',
    severity: 'info',
    detect(ctx) {
      if (!ctx.marketData) return null;
      const conditions = ctx.marketData.marketConditions;
      const lastSentiment = ctx.agentState.lastSentiment;
      const lastSentimentTime = ctx.agentState.lastSentimentTime || 0;
      // Only fire if sentiment changed AND at least 6hrs since last alert
      if (lastSentiment === conditions.sentiment) return null;
      if (Date.now() - lastSentimentTime < 6 * 60 * 60 * 1000) return null;
      return [{ conditions, lastSentiment }];
    },
    async action(ctx, issues) {
      const { conditions } = issues[0];
      ctx.agentState.lastSentiment = conditions.sentiment;
      ctx.agentState.lastSentimentTime = Date.now();
      const emoji = conditions.sentiment === 'bullish' ? '🟢' : conditions.sentiment === 'bearish' ? '🔴' : '🟡';
      await ctx.sendTG(emoji + ' <b>Market Sentiment: ' + conditions.sentiment.toUpperCase() + '</b>\nAvg 24h: ' + conditions.avg24hChange + '% | Volatility: ' + conditions.avgVolatility.toFixed(1) + '\nBullish: ' + conditions.bullishPairs + ' | Bearish: ' + conditions.bearishPairs);
      return ['Sentiment changed to ' + conditions.sentiment];
    }
  },


  // ── WIN GENERATION RULES ─────────────────────────────────────────────────

  {
    id: 'pre-session-threshold-optimisation',
    name: 'Pre-session: optimise thresholds for active window',
    severity: 'info',
    detect(ctx) {
      if (!ctx.marketData) return null;
      const h = new Date().getUTCHours();
      // 30 minutes before active windows: 04:30 UTC and 12:30 UTC
      const preWindow = (h === 4 && new Date().getUTCMinutes() >= 30) ||
                        (h === 12 && new Date().getUTCMinutes() >= 30);
      if (!preWindow) return null;
      // Only fire once per window
      const lastOpt = ctx.agentState.lastPreSessionOpt || 0;
      if (Date.now() - lastOpt < 6 * 60 * 60 * 1000) return null;
      const { getBestOpportunities } = require('./market-data');
      const opps = getBestOpportunities(5).filter(function(p) {
        return p.score > 4 && p.symbol !== 'PYTH';
      });
      return opps.length ? [{ opps }] : null;
    },
    async action(ctx, issues) {
      const opps = issues[0].opps;
      const changes = [];
      const skipOKX = ctx.config.POLICY_SKIP_OKX || [];
      const skipBybit = ctx.config.POLICY_SKIP_BYBIT || [];

      for (const opp of opps) {
        const sym = opp.symbol;
        // If pair is skipped but showing high opportunity, consider re-enabling
        if ((skipOKX.includes(sym) || skipBybit.includes(sym)) && opp.score > 6) {
          // Only re-enable if not a persistent loser (check win rate)
          const stats = ctx.pairStats[sym + '/USDT'];
          if (!stats || stats.winRate > 0.30) {
            ctx.config.POLICY_SKIP_OKX = skipOKX.filter(function(s) { return s !== sym; });
            ctx.config.POLICY_SKIP_BYBIT = skipBybit.filter(function(s) { return s !== sym; });
            changes.push(sym + ' re-enabled for session (score ' + opp.score.toFixed(1) + ', 24h ' + opp.change24h.toFixed(1) + '%)');
          }
        }
      }

      ctx.agentState.lastPreSessionOpt = Date.now();
      const topPairs = opps.slice(0,3).map(function(p) {
        return p.symbol + ' ' + p.score.toFixed(1);
      }).join(', ');
      await ctx.sendTG('Pre-session scan. Top pairs: ' + topPairs + (changes.length ? '\nEnabled: ' + changes.join(', ') : '\nNo changes needed'));
      return changes.length ? changes : ['Pre-session scan complete - ' + topPairs];
    }
  },

  {
    id: 'jto-threshold-dynamic',
    name: 'JTO DEX threshold: dynamically lower when conditions favourable',
    severity: 'info',
    detect(ctx) {
      if (!ctx.marketData) return null;
      const jto = ctx.marketData.pairs['JTO'];
      if (!jto) return null;
      const currentThreshold = ctx.agentState.jtoThresholdOverride || 2.5;
      // JTO is our best pair - if high volume + volatility, lower threshold slightly
      if (jto.volume24h > 50000000 && jto.volatility > 4 && jto.change24h > -5) {
        if (currentThreshold > 2.0) return [{ jto, currentThreshold, suggested: 2.0 }];
      } else {
        // Reset to default if conditions not favourable
        if (currentThreshold < 2.5) return [{ jto, currentThreshold, suggested: 2.5, reset: true }];
      }
      return null;
    },
    async action(ctx, issues) {
      const { currentThreshold, suggested, reset, jto } = issues[0];
      // Update BUY_DEX_THRESHOLDS dynamically via arb-config override
      if (!ctx.config.DEX_THRESHOLD_OVERRIDES) ctx.config.DEX_THRESHOLD_OVERRIDES = {};
      ctx.config.DEX_THRESHOLD_OVERRIDES['JTO'] = suggested;
      ctx.agentState.jtoThresholdOverride = suggested;
      const msg = reset
        ? 'JTO DEX threshold reset to ' + suggested + '% (low volume/volatility)'
        : 'JTO DEX threshold lowered to ' + suggested + '% (vol $' + Math.round(jto.volume24h/1e6) + 'M, volatility ' + jto.volatility.toFixed(1) + ')';
      await ctx.sendTG('Agent: ' + msg);
      return [msg];
    }
  },

  {
    id: 'dry-spell-analysis',
    name: 'Extended dry spell: analyse and adjust',
    severity: 'warn',
    detect(ctx) {
      // If no fires in 24 hours, investigate
      const since = Date.now() - 24 * 60 * 60 * 1000;
      const recentFires = ctx.fires.filter(function(f) {
        return new Date(f.date).getTime() > since && f.outcome !== 'failed';
      });
      if (recentFires.length > 0) return null;
      // Only alert once per 24hrs
      const lastDrySpell = ctx.agentState.lastDrySpellAlert || 0;
      if (Date.now() - lastDrySpell < 20 * 60 * 60 * 1000) return null;
      return [{ hoursSinceFire: Math.round((Date.now() - since) / 3600000) }];
    },
    async action(ctx, issues) {
      ctx.agentState.lastDrySpellAlert = Date.now();
      const { getBestOpportunities } = require('./market-data');
      const opps = getBestOpportunities(5);
      const topScores = opps.map(function(p) {
        return p.symbol + ':' + p.score.toFixed(1);
      }).join(' ');

      // Check if threshold is too high given current market
      const sentiment = ctx.marketData?.marketConditions?.sentiment || 'unknown';
      const avgVol = ctx.marketData?.marketConditions?.avgVolatility || 0;

      let recommendation = '';
      if (avgVol < 2) {
        recommendation = 'Market very quiet (avg volatility ' + avgVol.toFixed(1) + '). Consider waiting.';
      } else if (sentiment === 'bearish') {
        recommendation = 'Bearish market — spreads may not materialise. Holding thresholds.';
      } else {
        recommendation = 'Market conditions OK. Spreads not crossing threshold. Consider lowering CEX threshold to 1.5%.';
      }

      await ctx.sendTG(
        '24hr dry spell. No opportunities fired.\n' +
        'Sentiment: ' + sentiment + ' | Avg volatility: ' + avgVol.toFixed(1) + '\n' +
        'Top pairs: ' + topScores + '\n' +
        recommendation
      );
      return ['Dry spell alert sent — ' + recommendation];
    }
  },

  {
    id: 'kraken-window-prep',
    name: 'Kraken: prepare for PENGU window',
    severity: 'info',
    detect(ctx) {
      const h = new Date().getUTCHours();
      const m = new Date().getUTCMinutes();
      // Alert at 04:45 UTC — 15 minutes before the PENGU window
      if (h !== 4 || m < 45) return null;
      const lastPrep = ctx.agentState.lastKrakenPrep || 0;
      if (Date.now() - lastPrep < 20 * 60 * 60 * 1000) return null;
      if (!ctx.config.KRAKEN_ENABLED || ctx.config.KRAKEN_SYNTHETIC) return null;
      return [{ window: '05:00-06:00 UTC' }];
    },
    async action(ctx, issues) {
      ctx.agentState.lastKrakenPrep = Date.now();
      const pengu = ctx.marketData?.pairs['PENGU'];
      const krakenBal = ctx.balances.kraken || 0;
      const msg = 'Kraken PENGU window in 15min (05:00-06:00 UTC)\n' +
        'PENGU 24h: ' + (pengu ? pengu.change24h.toFixed(1) + '%' : 'unknown') +
        ' | Volatility: ' + (pengu ? pengu.volatility.toFixed(1) : '?') + '\n' +
        'Kraken balance: $' + krakenBal.toFixed(0) + '\n' +
        (krakenBal < 120 ? 'WARNING: Kraken balance below trade minimum!' : 'Ready to fire');
      await ctx.sendTG(msg);
      return ['Kraken window prep sent'];
    }
  },

  {
    id: 'win-streak-report',
    name: 'Win streak milestone',
    severity: 'info',
    detect(ctx) {
      const wins = ctx.state.consecutiveWins || 0;
      const lastMilestone = ctx.agentState.lastWinMilestone || 0;
      if (wins > lastMilestone && wins > 0 && wins % 2 === 0) {
        return [{ wins }];
      }
      return null;
    },
    async action(ctx, issues) {
      const { wins } = issues[0];
      ctx.agentState.lastWinMilestone = wins;
      await ctx.sendTG(
        'Win streak: ' + wins + '/10 consecutive wins\n' +
        'P&L: +$' + (ctx.state.totalProfit || 0).toFixed(2) + '\n' +
        (wins >= 10 ? 'TARGET REACHED - consider scaling to $200' : 'Keep going - ' + (10-wins) + ' more to scale')
      );
      return ['Win milestone: ' + wins + ' consecutive'];
    }
  },


  {
    id: 'macro-btc-eth-alert',
    name: 'BTC/ETH macro move detected',
    severity: 'warn',
    detect(ctx) {
      if (!ctx.marketData) return null;
      const mc = ctx.marketData.marketConditions;
      if (!mc.macroAlert) return null;
      const lastMacro = ctx.agentState.lastMacroAlert || 0;
      if (Date.now() - lastMacro < 2 * 60 * 60 * 1000) return null; // 2hr cooldown
      return [{ btc1h: mc.btc1h, eth1h: mc.eth1h, btc24h: mc.btc24h, sentiment: mc.macroSentiment }];
    },
    async action(ctx, issues) {
      const { btc1h, eth1h, btc24h, sentiment } = issues[0];
      ctx.agentState.lastMacroAlert = Date.now();
      const direction = Math.abs(btc1h) > 3 ? (btc1h > 0 ? 'pumping' : 'dumping') : 'moving';
      await ctx.sendTG(
        'Macro alert: BTC ' + direction + ' ' + btc1h.toFixed(1) + '% (1h)\n' +
        'ETH 1h: ' + eth1h.toFixed(1) + '% | BTC 24h: ' + btc24h.toFixed(1) + '%\n' +
        'Sentiment: ' + sentiment + '\n' +
        (Math.abs(btc1h) > 5 ? 'HIGH VOLATILITY - alt spread opportunities likely in next 15-30min' :
         'Monitor pairs for spread opening')
      );
      // If BTC moving hard, lower CEX threshold temporarily to catch spread windows
      if (Math.abs(btc1h) > 5) {
        const current = ctx.config.MIN_SPREAD_CEX || 1.5;
        ctx.config.MIN_SPREAD_CEX = Math.max(1.2, current - 0.3);
        if (!ctx.agentState.thresholdRestore) ctx.agentState.thresholdRestore = {};
        ctx.agentState.thresholdRestore.cex = { original: current, restoreAt: Date.now() + 30 * 60 * 1000 };
        return ['Macro BTC move ' + btc1h.toFixed(1) + '% - CEX threshold lowered to ' + ctx.config.MIN_SPREAD_CEX + '%'];
      }
      return ['Macro alert: BTC ' + btc1h.toFixed(1) + '% 1h'];
    }
  },

  {
    id: 'restore-macro-threshold',
    name: 'Restore threshold after macro window',
    severity: 'info',
    detect(ctx) {
      if (!ctx.agentState.thresholdRestore) return null;
      const restore = ctx.agentState.thresholdRestore.cex;
      if (!restore || Date.now() < restore.restoreAt) return null;
      return [restore];
    },
    async action(ctx, issues) {
      const { original } = issues[0];
      ctx.config.MIN_SPREAD_CEX = original;
      delete ctx.agentState.thresholdRestore;
      await ctx.sendTG('Macro window closed - CEX threshold restored to ' + original + '%');
      return ['CEX threshold restored to ' + original + '%'];
    }
  },


];
