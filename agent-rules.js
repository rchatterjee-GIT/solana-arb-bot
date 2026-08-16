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

      const totalCap = (ctx.balances.solana||0)+(ctx.balances.okx||0)+(ctx.balances.bybit||0)+(ctx.balances.kraken||0)+(ctx.balances.coinbase||0);
      const startCap = 261.31; // initial capital
      const roiPct = ((totalCap - startCap) / startCap * 100).toFixed(1);
      const msg = '📊 <b>Daily Report ' + issues[0].date + '</b>\n' +
        'Capital: $' + totalCap.toFixed(0) + ' (' + (totalCap>=startCap?'+':'') + roiPct + '%)\n' +
        'Sol: $' + (ctx.balances.solana||0).toFixed(0) + ' | OKX: $' + (ctx.balances.okx||0).toFixed(0) + ' | Bybit: $' + (ctx.balances.bybit||0).toFixed(0) + '\n' +
        'Kraken: $' + (ctx.balances.kraken||0).toFixed(0) + ' | Coinbase: $' + (ctx.balances.coinbase||0).toFixed(0) + '\n' +
        '---\n' +
        'Fires: ' + fires.length + ' | Failed: ' + failed.length + '\n' +
        'Trades: ' + trades.length + ' | Wins: ' + wins.length + '\n' +
        'P&L today: ' + (pnl>=0?'+':'') + '$' + pnl.toFixed(2) + '\n' +
        'Total P&L: ' + (ctx.state.totalProfit>=0?'+':'') + '$' + (ctx.state.totalProfit||0).toFixed(2) + '\n' +
        'ConsecWins: ' + (ctx.state.consecutiveWins||0) + '/10 | Clean: ' + (ctx.state.consecutiveClean||0);

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
    id: 'dex-threshold-dynamic',
    name: 'DEX thresholds: adjust all pairs based on volume and volatility',
    severity: 'info',
    detect(ctx) {
      if (!ctx.marketData) return null;
      const lastAdjust = ctx.agentState.lastDexAdjust || 0;
      if (Date.now() - lastAdjust < 30 * 60 * 1000) return null; // max every 30min
      
      // DEX pairs with their base thresholds and volume tiers
      const DEX_PAIRS = [
        { sym: 'JTO',   base: 2.5, aggressive: 2.0, conservative: 3.0, minVol: 30e6,  minVol2: 50e6  },
        { sym: 'RAY',   base: 2.5, aggressive: 2.0, conservative: 3.0, minVol: 10e6,  minVol2: 25e6  },
        { sym: 'PENGU', base: 4.5, aggressive: 3.0, conservative: 5.0, minVol: 20e6,  minVol2: 50e6  },
        { sym: 'W',     base: 3.2, aggressive: 2.5, conservative: 3.5, minVol: 15e6,  minVol2: 40e6  },
        { sym: 'WIF',   base: 2.5, aggressive: 2.0, conservative: 3.0, minVol: 20e6,  minVol2: 50e6  },
        { sym: 'PNUT',  base: 3.5, aggressive: 2.5, conservative: 4.0, minVol: 10e6,  minVol2: 25e6  },
      ];

      const adjustments = [];
      for (const p of DEX_PAIRS) {
        const data = ctx.marketData.pairs[p.sym];
        if (!data) continue;
        const vol = data.volume24h || 0;
        const volat = data.volatility || 0;
        const change24h = data.change24h || 0;
        const current = ctx.config.DEX_THRESHOLD_OVERRIDES?.[p.sym] || p.base;

        let suggested = p.base;
        let reason = 'normal';

        if (vol > p.minVol2 && volat > 5 && Math.abs(change24h) < 10) {
          // High volume + high volatility + not in freefall = aggressive
          suggested = p.aggressive;
          reason = 'high vol $' + Math.round(vol/1e6) + 'M + volatility ' + volat.toFixed(1);
        } else if (vol > p.minVol && volat > 3 && Math.abs(change24h) < 15) {
          // Medium conditions = slightly below base
          suggested = parseFloat(((p.base + p.aggressive) / 2).toFixed(1));
          reason = 'medium vol $' + Math.round(vol/1e6) + 'M + volatility ' + volat.toFixed(1);
        } else if (vol < p.minVol * 0.3 || volat < 1.5 || Math.abs(change24h) > 20) {
          // Low volume or extreme move = conservative
          suggested = p.conservative;
          reason = 'low vol/extreme move';
        }

        if (Math.abs(suggested - current) >= 0.2) {
          adjustments.push({ sym: p.sym, current, suggested, reason, direction: suggested < current ? 'lowered' : 'raised' });
        }
      }

      return adjustments.length ? [{ adjustments }] : null;
    },
    async action(ctx, issues) {
      ctx.agentState.lastDexAdjust = Date.now();
      const adjustments = issues[0].adjustments;
      if (!ctx.config.DEX_THRESHOLD_OVERRIDES) ctx.config.DEX_THRESHOLD_OVERRIDES = {};

      const changes = [];
      const lowered = [];
      const raised = [];

      for (const adj of adjustments) {
        ctx.config.DEX_THRESHOLD_OVERRIDES[adj.sym] = adj.suggested;
        changes.push(adj.sym + ' DEX: ' + adj.current + '% -> ' + adj.suggested + '% (' + adj.reason + ')');
        if (adj.direction === 'lowered') lowered.push(adj.sym + ' ' + adj.suggested + '%');
        else raised.push(adj.sym + ' ' + adj.suggested + '%');
      }

      let msg = 'DEX threshold adjustments:\n';
      if (lowered.length) msg += 'Lowered (more active): ' + lowered.join(', ') + '\n';
      if (raised.length) msg += 'Raised (less active): ' + raised.join(', ') + '\n';

      await ctx.sendTG(msg);
      return changes;
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
      return ['Kraken window prep sent — $' + krakenBal.toFixed(0) + (krakenBal < 120 ? ' WARNING below minimum' : ' ready')];
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


  {
    id: 'spread-duration-analysis',
    name: 'Weekly spread duration analysis',
    severity: 'info',
    detect(ctx) {
      // Run when we have 5+ trades and haven't run in 7 days
      // Also run after any new loss to immediately diagnose
      const lastAnalysis = ctx.agentState.lastSpreadAnalysis || 0;
      const tradeCount = ctx.realTradeCount || 0;
      if (tradeCount < 5) return null;
      const lastTrade = ctx.trades.filter(function(t){return t.direction!=='RECOVERY';}).slice(-1)[0];
      const recentLoss = lastTrade && lastTrade.profit < 0 && (Date.now() - new Date(lastTrade.date).getTime()) < 5*60*1000;
      const weekMs = 7 * 24 * 60 * 60 * 1000;
      // Weekly: only if 7 days since last analysis
      if (!recentLoss && Date.now() - lastAnalysis < weekMs) return null;
      // Post-loss: only if 6hrs since last analysis and loss was in last 5min
      if (recentLoss && Date.now() - lastAnalysis < 6 * 60 * 60 * 1000) return null;
      return [{ trigger: recentLoss ? 'loss' : 'weekly', tradeCount }];
    },
    async action(ctx, issues) {
      ctx.agentState.lastSpreadAnalysis = Date.now();
      const { analyseSpreadDuration } = require('./spread-analysis');
      const results = analyseSpreadDuration();
      const o = results.overall;

      // Build summary message
      let msg = 'Spread Duration Analysis\n';
      msg += 'Trades: ' + o.totalAnalysed + ' | Avg withdrawal: ' + o.avgWithdrawSec + 's\n';
      msg += 'Win rate <2min: ' + Math.round(o.winRateFast*100) + '% vs >2min: ' + Math.round(o.winRateSlow*100) + '%\n';



      // Apply recommendations autonomously
      const changes = [];
      for (const warning of results.warnings) {
        const ccy = warning.pair;
        if (warning.type === 'persistent-loser') {
          // Add to skip list if not already there
          if (!ctx.config.POLICY_SKIP_OKX?.includes(ccy) && !ctx.config.POLICY_SKIP_BYBIT?.includes(ccy)) {
            if (!ctx.config.PAIR_MIN_SPREAD) ctx.config.PAIR_MIN_SPREAD = {};
            const recommended = parseFloat((results.byPair[ccy + '/USDT']?.avgLossSpread * 2 || 3.0).toFixed(1));
            ctx.config.PAIR_MIN_SPREAD[ccy] = recommended;
            changes.push(ccy + ' threshold raised to ' + recommended + '% (persistent loser)');
            msg += 'Action: ' + ccy + ' threshold raised to ' + recommended + '%\n';
          }
        }
      }

      for (const insight of results.insights) {
        msg += 'Insight [' + insight.pair + ']: ' + insight.message + '\n';
      }

      if (issues[0].trigger === 'loss') {
        msg = 'Post-loss analysis:\n' + msg;
      }

      await ctx.sendTG(msg);
      return changes.length ? changes : ['Spread analysis complete - ' + results.insights.length + ' insights'];
    }
  },


  {
    id: 'burst-event-monitor',
    name: 'Burst firing event detected and diagnosed',
    severity: 'warn',
    detect(ctx) {
      // Look for 3+ fires within a 5-second window in recent fires
      const recent = ctx.fires.slice(-50);
      if (recent.length < 3) return null;
      // Group by second
      const bySecond = {};
      recent.forEach(function(f) {
        const sec = f.date ? f.date.slice(0,19) : null;
        if (!sec) return;
        if (!bySecond[sec]) bySecond[sec] = [];
        bySecond[sec].push(f);
      });
      // Find seconds with 3+ fires
      const bursts = Object.entries(bySecond).filter(function(e) { return e[1].length >= 3; });
      if (bursts.length === 0) return null;
      // Only alert on bursts we haven't seen
      const lastBurst = ctx.agentState.lastBurstAlert || '';
      const latestBurst = bursts[bursts.length-1];
      if (latestBurst[0] === lastBurst) return null;
      return [{ time: latestBurst[0], fires: latestBurst[1] }];
    },
    async action(ctx, issues) {
      const { time, fires } = issues[0];
      ctx.agentState.lastBurstAlert = time;

      // Diagnose the burst
      const pairs    = fires.map(function(f) { return (f.pair||'').replace('/USDT',''); });
      const outcomes = { fired:0, success:0, failed:0, loss:0 };
      fires.forEach(function(f) { outcomes[f.outcome] = (outcomes[f.outcome]||0)+1; });
      const exchanges = [...new Set(fires.map(function(f) { return (f.direction||'').replace('BUY_',''); }))];

      // Check for race condition (same pair firing multiple times)
      const pairCounts = {};
      pairs.forEach(function(p) { pairCounts[p] = (pairCounts[p]||0)+1; });
      const duplicates = Object.entries(pairCounts).filter(function(e) { return e[1]>1; });

      // Check resulting trades
      const tradelog = require('fs').existsSync(require('path').join(__dirname,'trade-log.json')) ?
        JSON.parse(require('fs').readFileSync(require('path').join(__dirname,'trade-log.json'),'utf8')) : [];
      const burstTrades = tradelog.filter(function(t) {
        return t.events && t.events[0] && t.events[0].t && t.events[0].t.slice(0,19) === time;
      });

      // Check OKX/Solana impact
      const balBefore = burstTrades[0]?.balanceBefore || null;

      // Build diagnosis
      let diagnosis = 'Burst Event at ' + time + ' UTC\n';
      diagnosis += 'Pairs fired: ' + pairs.join(', ') + '\n';
      diagnosis += 'Exchanges: ' + exchanges.join(', ') + '\n';
      diagnosis += 'Outcomes: fired:' + (outcomes.fired||0) + ' success:' + (outcomes.success||0) + ' failed:' + (outcomes.failed||0) + '\n';

      if (duplicates.length > 0) {
        diagnosis += 'RACE CONDITION: ' + duplicates.map(function(d){return d[0]+'x'+d[1];}).join(', ') + '\n';
      } else {
        diagnosis += 'No duplicate pairs - concurrency guard held\n';
      }

      const failReasons = [...new Set(fires.filter(function(f){return f.reason;}).map(function(f){return f.reason.slice(0,50);}))];
      if (failReasons.length > 0) {
        diagnosis += 'Fail reasons: ' + failReasons.join(' | ') + '\n';
      }

      if (balBefore) {
        diagnosis += 'Balances at fire: Sol:$' + (balBefore.solana||0).toFixed(0) + ' OKX:$' + (balBefore.okx||0).toFixed(0) + ' By:$' + (balBefore.bybit||0).toFixed(0);
      }

      await ctx.sendTG('Burst event diagnosed:\n' + diagnosis);
      return ['Burst event at ' + time + ': ' + fires.length + ' fires, ' + duplicates.length + ' duplicates'];
    }
  },


  // ── FUNDING RATE RULES ────────────────────────────────────────────────────

  {
    id: 'funding-rate-extreme',
    name: 'Extreme funding rate — spread opportunity likely',
    severity: 'warn',
    detect(ctx) {
      if (!ctx.fundingData) return null;
      const extreme = ctx.fundingData.highSignals || [];
      if (extreme.length === 0) return null;
      const lastFunding = ctx.agentState.lastFundingAlert || 0;
      if (Date.now() - lastFunding < 4 * 60 * 60 * 1000) return null; // 4hr cooldown
      return extreme.length ? [{ signals: extreme }] : null;
    },
    async action(ctx, issues) {
      ctx.agentState.lastFundingAlert = Date.now();
      const signals = issues[0].signals;
      const lines = signals.map(function(s) {
        return s.sym + ': ' + (s.rate*100).toFixed(4) + '%/8hr (' + s.annualised.toFixed(0) + '%/yr) — ' + s.direction;
      });
      const implications = signals.map(function(s) { return s.sym + ': ' + s.implication; });

      // Lower threshold for affected pairs temporarily
      const changes = [];
      for (const s of signals) {
        const skipOKX = ctx.config.POLICY_SKIP_OKX || [];
        const skipBybit = ctx.config.POLICY_SKIP_BYBIT || [];
        if (!skipOKX.includes(s.sym) || !skipBybit.includes(s.sym)) {
          const current = ctx.config.PAIR_MIN_SPREAD?.[s.sym] || ctx.config.MIN_SPREAD_CEX || 1.5;
          const lowered = parseFloat(Math.max(1.2, current - 0.5).toFixed(1));
          if (lowered < current) {
            if (!ctx.config.PAIR_MIN_SPREAD) ctx.config.PAIR_MIN_SPREAD = {};
            ctx.config.PAIR_MIN_SPREAD[s.sym] = lowered;
            if (!ctx.config.TEMP_SKIPS) ctx.config.TEMP_SKIPS = {};
            ctx.config.TEMP_SKIPS[s.sym + ':threshold'] = Date.now() + 2 * 60 * 60 * 1000;
            changes.push(s.sym + ' threshold lowered to ' + lowered + '% for 2hrs (extreme funding)');
          }
        }
      }

      await ctx.sendTG(
        'Extreme funding rates detected — spread opportunity likely:\n' +
        lines.join('\n') + '\n\n' +
        implications.join('\n') +
        (changes.length ? '\nActions: ' + changes.join(', ') : '')
      );
      return changes.length ? changes : ['Funding alert sent: ' + signals.map(function(s){return s.sym;}).join(', ')];
    }
  },

  {
    id: 'funding-rate-elevated',
    name: 'Elevated funding rates — watch for spread opportunities',
    severity: 'info',
    detect(ctx) {
      if (!ctx.fundingData) return null;
      const elevated = ctx.fundingData.mediumSignals || [];
      if (elevated.length === 0) return null;
      const lastAlert = ctx.agentState.lastFundingElevatedAlert || 0;
      if (Date.now() - lastAlert < 6 * 60 * 60 * 1000) return null;
      return [{ signals: elevated }];
    },
    async action(ctx, issues) {
      ctx.agentState.lastFundingElevatedAlert = Date.now();
      const signals = issues[0].signals;
      const lines = signals.map(function(s) {
        return s.sym + ': ' + (s.rate*100).toFixed(4) + '%/8hr (' + s.direction + ')';
      }).join(', ');
      await ctx.sendTG('Elevated funding: ' + lines + '\nMonitor for spread widening — no action yet');
      return ['Elevated funding alert: ' + signals.map(function(s){return s.sym;}).join(', ')];
    }
  },


  {
    id: 'bybit-withdrawal-failure',
    name: 'Bybit withdrawal failure — trigger immediate hygiene',
    severity: 'critical',
    detect(ctx) {
      // Look for recent Bybit withdrawal failures in fires.json
      const since = Date.now() - 30 * 60 * 1000; // last 30min
      const recentFails = ctx.fires.filter(function(f) {
        return f.direction === 'BUY_BYBIT' &&
               f.outcome === 'failed' &&
               f.reason && (f.reason.includes('never arrived') || f.reason.includes('withdrawal')) &&
               new Date(f.date).getTime() > since;
      });
      if (recentFails.length === 0) return null;
      const lastAlert = ctx.agentState.lastBybitRecoveryAlert || 0;
      if (Date.now() - lastAlert < 60 * 60 * 1000) return null;
      return [{ fails: recentFails }];
    },
    async action(ctx, issues) {
      ctx.agentState.lastBybitRecoveryAlert = Date.now();
      const fails = issues[0].fails;
      const pairs = fails.map(function(f){return (f.pair||'').replace('/USDT','');}).join(', ');
      await ctx.sendTG(
        'Bybit withdrawal failure detected: ' + pairs + '\n' +
        'Triggering immediate hygiene to recover stuck tokens.\n' +
        'Tokens will be sold back to USDT automatically.'
      );
      // Trigger hygiene immediately
      try {
        const { runHygiene } = require('./hygiene');
        await runHygiene();
      } catch(e) {
        await ctx.sendTG('Hygiene trigger failed: ' + e.message);
      }
      return ['Bybit recovery triggered for: ' + pairs];
    }
  },


  {
    id: 'exchange-viability-scan',
    name: 'Weekly exchange landscape scan',
    severity: 'info',
    detect(ctx) {
      // Run once per week
      const lastScan = ctx.agentState.lastExchangeScan || 0;
      if (Date.now() - lastScan < 7 * 24 * 60 * 60 * 1000) return null;
      return [{ date: new Date().toISOString().slice(0,10) }];
    },
    async action(ctx, issues) {
      ctx.agentState.lastExchangeScan = Date.now();

      // Fetch exchange news from CryptoPanic if available
      const exchanges = [
        { name: 'Bitget',   url: 'https://www.bitget.com', note: 'FCA warning — parked' },
        { name: 'Binance',  url: 'https://www.binance.com', note: 'Best liquidity — UK restricted, monitor for changes' },
        { name: 'Coinbase', url: 'https://www.coinbase.com', note: 'ACTIVE — FCA+MiCA, 10 USDC pairs, 21s withdrawal, 1.03% break-even' },
        { name: 'Gate.io',  url: 'https://www.gate.io', note: 'Parked — KYC issues' },
        { name: 'MEXC',     url: 'https://www.mexc.com', note: 'Wide pair selection, check UK compliance' },
        { name: 'Kucoin',   url: 'https://www.kucoin.com', note: 'Solana pairs available, check UK FCA status' },
      ];

      // Check for recent news on each exchange via CoinGecko exchange data
      let exchangeStatus = '';
      try {
        const r = await fetch('https://api.coingecko.com/api/v3/exchanges?per_page=20&page=1');
        if (r.ok) {
          const j = await r.json();
          for (const ex of exchanges) {
            const found = j.find(function(e) {
              return e.name.toLowerCase().includes(ex.name.toLowerCase());
            });
            if (found) {
              const vol = found.trade_volume_24h_btc ? '$' + Math.round(found.trade_volume_24h_btc).toLocaleString() + ' BTC vol' : '';
              const trust = found.trust_score ? 'trust:' + found.trust_score + '/10' : '';
              exchangeStatus += ex.name + ': ' + [vol, trust].filter(Boolean).join(', ') + ' — ' + ex.note + '\n';
            } else {
              exchangeStatus += ex.name + ': ' + ex.note + '\n';
            }
          }
        }
      } catch(e) {
        exchanges.forEach(function(ex) {
          exchangeStatus += ex.name + ': ' + ex.note + '\n';
        });
      }

      await ctx.sendTG(
        'Weekly Exchange Landscape\n' +
        'Currently trading: OKX, Bybit, Kraken + DEX\n\n' +
        exchangeStatus +
        '\nReview: any exchange with improved UK compliance or Solana pairs worth adding?'
      );
      return ['Exchange viability report sent'];
    }
  },


  {
    id: 'daily-outlook-report',
    name: 'Daily forward-looking outlook report',
    severity: 'info',
    detect(ctx) {
      const h = new Date().getUTCHours();
      const m = new Date().getUTCMinutes();
      if (h !== 8 || m > 1) return null;
      const lastReport = ctx.agentState.lastOutlookReport || 0;
      if (Date.now() - lastReport < 20 * 60 * 60 * 1000) return null;
      return [{ date: new Date().toISOString().slice(0,10) }];
    },
    async action(ctx, issues) {
      ctx.agentState.lastOutlookReport = Date.now();
      const { getBestOpportunities, getPairSignal } = require('./market-data');
      const { getTopSignals } = require('./funding-monitor');
      const mc = ctx.marketData?.marketConditions || {};
      const pairs = ctx.marketData?.pairs || {};
      const trades = ctx.trades.filter(function(t){return t.direction!=='RECOVERY';});
      const since7d = Date.now() - 7*24*60*60*1000;
      const week = trades.filter(function(t){return new Date(t.date).getTime()>since7d;});
      const weekWins = week.filter(function(t){return t.profit>0;});
      const weekPnl = week.reduce(function(a,t){return a+(t.profit||0);},0);

      // ── MESSAGE 1: Market Overview ───────────────────────────────────────
      const btc = pairs['BTC'] || {};
      const eth = pairs['ETH'] || {};
      const sol = pairs['SOL'] || {};
      const sentEmoji = mc.sentiment==='bullish'?'[UP]':mc.sentiment==='bearish'?'[DN]':'[--]';

      let msg1 = '<b>Daily Outlook ' + issues[0].date + '</b>\n\n';
      msg1 += sentEmoji + ' <b>Market Sentiment: ' + (mc.sentiment||'unknown').toUpperCase() + '</b>\n';
      msg1 += 'BTC: ' + (btc.change24h>=0?'+':'') + (btc.change24h||0).toFixed(1) + '% (1h: ' + (btc.change1h>=0?'+':'') + (btc.change1h||0).toFixed(2) + '%)\n';
      msg1 += 'ETH: ' + (eth.change24h>=0?'+':'') + (eth.change24h||0).toFixed(1) + '% (1h: ' + (eth.change1h>=0?'+':'') + (eth.change1h||0).toFixed(2) + '%)\n';
      msg1 += 'SOL: ' + (sol.change24h>=0?'+':'') + (sol.change24h||0).toFixed(1) + '%\n';
      msg1 += 'Avg alt volatility: ' + (mc.avgVolatility||0).toFixed(1) + ' | Bullish pairs: ' + (mc.bullishPairs||0) + ' | Bearish: ' + (mc.bearishPairs||0) + '\n\n';

      // Prediction
      const predictedActivity = mc.avgVolatility > 5 ? 'HIGH' : mc.avgVolatility > 3 ? 'MODERATE' : 'LOW';
      const spreadLikelihood = mc.avgVolatility > 5 ? 'Spread opportunities likely today' :
                               mc.avgVolatility > 3 ? 'Possible spread windows — monitor closely' :
                               'Flat market expected — patience required';
      msg1 += '<b>Predicted Activity: ' + predictedActivity + '</b>\n';
      msg1 += spreadLikelihood + '\n';

      // Active windows prediction
      const activeHours = mc.activeWindow ? 'Currently in active window (05-08h or 13-17h UTC)' : 'Next active window: ' + (new Date().getUTCHours() < 5 ? '05:00' : new Date().getUTCHours() < 13 ? '13:00' : '05:00 tomorrow') + ' UTC';
      msg1 += activeHours;

      // Add macro context if available
      if (ctx.macroContext && ctx.macroContext.themes && ctx.macroContext.themes.length > 0) {
        const latest = ctx.macroContext.themes[0];
        const si = ctx.macroContext.structuralInsights || {};
        msg1 += '\n\n<b>Macro Context (' + latest.date + '):</b>\n';
        msg1 += latest.headline + '\n';
        msg1 += 'Phase: ' + (si.marketPhase||'unknown').replace(/_/g,' ') + ' | Preferred leg: ' + (si.preferredLeg||'both') + '\n';
        msg1 += 'Key signal: ' + (si.keySignal||'spreads').replace(/_/g,' ');
      }

      await ctx.sendTG(msg1);
      await new Promise(function(r){setTimeout(r,1000);});

      // ── MESSAGE 2: Top Pair Opportunities ───────────────────────────────
      const opps = getBestOpportunities(8).filter(function(p){return p.symbol!=='BTC'&&p.symbol!=='ETH';});
      const skipOKX = ctx.config.POLICY_SKIP_OKX || [];
      const skipBybit = ctx.config.POLICY_SKIP_BYBIT || [];

      let msg2 = '<b>Top Pair Opportunities Today</b>\n';
      for (const opp of opps.slice(0,6)) {
        const skipped = skipOKX.includes(opp.symbol) && skipBybit.includes(opp.symbol);
        const signal = getPairSignal(opp.symbol);
        const pairStats = ctx.pairStats[opp.symbol+'/USDT'] || {};
        const winRate = pairStats.total ? Math.round(pairStats.winRate*100) : null;
        const scoreBar = opp.score > 7 ? '[HOT]' : opp.score > 5 ? '[HIGH]' : opp.score > 3 ? '[MED]' : '[LOW]';
        const statusTag = skipped ? ' [SKIPPED]' : signal?.signal==='avoid' ? ' [AVOID]' : '';

        msg2 += scoreBar + ' <b>' + opp.symbol + '</b>' + statusTag + '\n';
        msg2 += '  Score: ' + opp.score.toFixed(1) + ' | 24h: ' + (opp.change24h>=0?'+':'') + opp.change24h.toFixed(1) + '% | Vol: ' + opp.volatility.toFixed(1) + '\n';
        msg2 += '  Vol 24h: $' + Math.round((opp.volume24h||0)/1e6) + 'M';
        if (winRate !== null) msg2 += ' | Historical: ' + winRate + '% win (' + pairStats.total + ' trades)';
        if (signal?.signal === 'avoid') msg2 += '\n  [AVOID] ' + signal.reason;
        msg2 += '\n';
      }

      await ctx.sendTG(msg2);
      await new Promise(function(r){setTimeout(r,1000);});

      // ── MESSAGE 3: Funding Rates & Profitability Forecast ────────────────
      const fundingSignals = getTopSignals(5);
      let msg3 = '<b>Funding Rates & Profitability Forecast</b>\n';

      if (fundingSignals.length > 0) {
        msg3 += '<b>Active Funding Signals:</b>\n';
        fundingSignals.forEach(function(s) {
          msg3 += (s.urgency==='high'?'🚨':'⚡') + ' ' + s.sym + ': ' + (s.rate*100).toFixed(4) + '%/8hr (' + s.direction + ')\n';
          msg3 += '  → ' + s.implication + '\n';
        });
        msg3 += '\n';
      } else {
        msg3 += 'Funding rates: neutral across all pairs\n';
      }

      // P&L forecast
      const avgProfitPerWin = trades.filter(function(t){return t.profit>0;}).reduce(function(a,t){return a+t.profit;},0) / Math.max(1,trades.filter(function(t){return t.profit>0;}).length);
      const winRate7d = week.length ? Math.round(weekWins.length/week.length*100) : 0;
      const expectedFires = mc.avgVolatility > 5 ? '5-10' : mc.avgVolatility > 3 ? '2-5' : '0-2';
      const expectedWins = mc.avgVolatility > 5 ? '2-4' : mc.avgVolatility > 3 ? '1-2' : '0-1';
      const expectedPnl = mc.avgVolatility > 5 ? '+$' + (avgProfitPerWin*3).toFixed(0) + ' to +$' + (avgProfitPerWin*6).toFixed(0) :
                          mc.avgVolatility > 3 ? '+$' + (avgProfitPerWin*1).toFixed(0) + ' to +$' + (avgProfitPerWin*3).toFixed(0) : '$0 (flat market)';

      msg3 += '<b>Profitability Forecast:</b>\n';
      msg3 += 'Expected fires today: ' + expectedFires + '\n';
      msg3 += 'Expected wins: ' + expectedWins + '\n';
      msg3 += 'Expected P&L: ' + expectedPnl + '\n';
      msg3 += 'Avg profit/win (historical): $' + avgProfitPerWin.toFixed(2) + '\n\n';

      msg3 += '<b>7-Day Performance:</b>\n';
      msg3 += 'Trades: ' + week.length + ' | Wins: ' + weekWins.length + ' (' + winRate7d + '%)\n';
      msg3 += 'P&L: ' + (weekPnl>=0?'+':'') + '$' + weekPnl.toFixed(2) + '\n';
      msg3 += 'Consecutive wins: ' + (ctx.state.consecutiveWins||0) + '/10';

      await ctx.sendTG(msg3);
      await new Promise(function(r){setTimeout(r,1000);});

      // ── MESSAGE 4: New Listings & Opportunities ──────────────────────────
      const newPairsFile = require('path').join(__dirname, 'new-pairs.json');
      const newPairs = require('fs').existsSync(newPairsFile) ?
        JSON.parse(require('fs').readFileSync(newPairsFile,'utf8')) : [];
      const activePairs = newPairs.filter(function(p){return p.expiresAt && new Date(p.expiresAt).getTime()>Date.now();});

      let msg4 = '<b>New Listings & Watch List</b>\n';

      if (activePairs.length > 0) {
        msg4 += '<b>Active New Listings (bot scanning):</b>\n';
        activePairs.forEach(function(p) {
          const age = Math.round((Date.now()-p.addedAt)/3600000);
          msg4 += '[NEW] ' + p.symbol + ' (' + p.exchange + ') — added ' + age + 'h ago, threshold: ' + p.listingThreshold + '%\n';
        });
        msg4 += '\n';
      } else {
        msg4 += 'No new listings currently active\n';
      }

      // Today's recommended focus
      const topTradeable = opps.filter(function(p){
        return !skipOKX.includes(p.symbol) || !skipBybit.includes(p.symbol);
      }).slice(0,3);

      msg4 += '<b>Recommended Focus Today:</b>\n';
      topTradeable.forEach(function(p) {
        const thresh = ctx.config.PAIR_MIN_SPREAD?.[p.symbol] || ctx.config.MIN_SPREAD_CEX || 1.5;
        msg4 += '• ' + p.symbol + ': watch for ' + thresh + '%+ spread (score ' + p.score.toFixed(1) + ')\n';
      });

      msg4 += '\n<b>Bot Status:</b>\n';
      msg4 += 'Capital: ~$' + Math.round((ctx.balances.solana||0)+(ctx.balances.okx||0)+(ctx.balances.bybit||0)+(ctx.balances.kraken||0)+(ctx.balances.coinbase||0)) + '\n';
      msg4 += 'OKX: $' + Math.round(ctx.balances.okx||0) + ' | Bybit: $' + Math.round(ctx.balances.bybit||0) + ' | Kraken: $' + Math.round(ctx.balances.kraken||0) + ' | CB: $' + Math.round(ctx.balances.coinbase||0) + '\n';
      msg4 += 'ConsecWins: ' + (ctx.state.consecutiveWins||0) + '/10 | ConsecClean: ' + (ctx.state.consecutiveClean||0);

      await ctx.sendTG(msg4);

      return ['Daily outlook report sent (4 messages)'];
    }
  },


  {
    id: 'macro-structural-insight',
    name: 'Macro context: act on structural insights',
    severity: 'info',
    detect(ctx) {
      if (!ctx.macroContext) return null;
      const si = ctx.macroContext.structuralInsights || {};
      const lastMacro = ctx.agentState.lastMacroInsight || 0;
      // Fire once per day
      if (Date.now() - lastMacro < 20 * 60 * 60 * 1000) return null;
      return [{ si, themes: ctx.macroContext.themes || [] }];
    },
    async action(ctx, issues) {
      ctx.agentState.lastMacroInsight = Date.now();
      const si = issues[0].si;
      const changes = [];

      // Act on structural insights
      if (si.preferredLeg === 'DEX') {
        // Lower DEX thresholds slightly to favour DEX trades
        const currentDex = ctx.config.MIN_SPREAD_DEX || 1.0;
        if (currentDex > 0.9) {
          ctx.config.MIN_SPREAD_DEX = 0.9;
          changes.push('DEX threshold lowered to 0.9% (macro: DEX structurally favoured)');
        }
      }

      if (si.keySignal === 'funding_rates') {
        // Already monitoring — just log
        console.log('[agent] Macro: funding rates identified as key signal — monitoring active');
      }

      if (si.marketPhase === 'late_bear_early_recovery') {
        // Slightly more aggressive — lower buffer
        const currentBuffer = ctx.config.MIN_SPREAD_BUFFER_PCT || 20;
        if (currentBuffer > 15) {
          ctx.config.MIN_SPREAD_BUFFER_PCT = 15;
          changes.push('Spread buffer lowered to 15% (macro: recovery phase, more aggressive)');
        }
      }

      if (changes.length > 0) {
        await ctx.sendTG('Macro insight applied:\n' + changes.join('\n'));
      }
      return changes.length ? changes : ['Macro context reviewed — no config changes needed'];
    }
  },


  {
    id: 'pair-viability-weekly-test',
    name: 'Weekly pair viability test',
    severity: 'info',
    detect(ctx) {
      const lastTest = ctx.agentState.lastViabilityTest || 0;
      if (Date.now() - lastTest < 7 * 24 * 60 * 60 * 1000) return null;
      // Run at 07:00 UTC Sunday
      const now = new Date();
      if (now.getUTCDay() !== 0 || now.getUTCHours() !== 7) return null;
      return [{ date: now.toISOString().slice(0,10) }];
    },
    async action(ctx, issues) {
      ctx.agentState.lastViabilityTest = Date.now();
      console.log('[agent] Starting weekly pair viability test...');

      const TRADE_SIZE = ctx.config.TRADE_SIZE_USD || 120;
      const pairs = ['SOL','JTO','WIF','BONK','JUP','PYTH','RAY','W','BOME','TRUMP','ZEUS','RENDER','PNUT','GOAT','PENGU'];
      const crypto = require('crypto');
      const results = [];

      for (const sym of pairs) {
        try {
          // Check OKX withdrawal
          const ts = new Date().toISOString();
          const path = '/api/v5/asset/currencies?ccy=' + sym;
          const sig = crypto.createHmac('sha256', process.env.OKX_API_SECRET).update(ts+'GET'+path).digest('base64');
          const r = await fetch('https://www.okx.com'+path, {
            headers: {'OK-ACCESS-KEY':process.env.OKX_API_KEY,'OK-ACCESS-SIGN':sig,'OK-ACCESS-TIMESTAMP':ts,'OK-ACCESS-PASSPHRASE':process.env.OKX_PASSPHRASE}
          });
          const j = await r.json();
          const chain = (j.data||[]).find(function(c){return c.chain&&c.chain.includes('Solana');});

          if (!chain) { results.push({ sym, status: 'NO_CHAIN', action: 'skip' }); continue; }

          const canWd = chain.canWd === true || chain.canWd === '1';
          const feeUsd = parseFloat(chain.minFee||'0') * (ctx.marketData?.pairs?.[sym]?.price || 1);
          const feePct = feeUsd / TRADE_SIZE * 100;

          let status, action;
          if (!canWd) { status = 'WD_DISABLED'; action = 'skip'; }
          else if (feePct > 3.0) { status = 'FEE_TOO_HIGH'; action = 'kill'; }
          else if (feePct > 1.5) { status = 'MARGINAL'; action = 'watch'; }
          else { status = 'VIABLE'; action = 'enable'; }

          results.push({ sym, status, feePct: parseFloat(feePct.toFixed(2)), canWd, action });

          // Apply actions
          if (action === 'kill') {
            if (!ctx.config.POLICY_SKIP_OKX.includes(sym)) ctx.config.POLICY_SKIP_OKX.push(sym);
            if (!ctx.config.POLICY_SKIP_BYBIT.includes(sym)) ctx.config.POLICY_SKIP_BYBIT.push(sym);
          } else if (action === 'enable' && status === 'VIABLE') {
            ctx.config.POLICY_SKIP_OKX = ctx.config.POLICY_SKIP_OKX.filter(function(s){return s!==sym;});
          }
        } catch(e) {
          results.push({ sym, status: 'ERROR', error: e.message, action: 'skip' });
        }
        await new Promise(function(r){setTimeout(r,250);});
      }

      // Build report
      const viable   = results.filter(function(r){return r.action==='enable';}).map(function(r){return r.sym+'('+r.feePct+'%)';}).join(', ');
      const marginal = results.filter(function(r){return r.action==='watch';}).map(function(r){return r.sym+'('+r.feePct+'%)';}).join(', ');
      const killed   = results.filter(function(r){return r.action==='kill';}).map(function(r){return r.sym;}).join(', ');
      const noChain  = results.filter(function(r){return r.status==='NO_CHAIN'||r.status==='WD_DISABLED';}).map(function(r){return r.sym;}).join(', ');

      const msg = 'Weekly Pair Viability Test\n' +
        'Viable: ' + (viable||'none') + '\n' +
        'Marginal: ' + (marginal||'none') + '\n' +
        'Killed: ' + (killed||'none') + '\n' +
        'No Solana chain: ' + (noChain||'none');

      await ctx.sendTG(msg);
      console.log('[agent] Viability test complete: ' + results.length + ' pairs checked');
      return ['Viability test: ' + results.filter(function(r){return r.action==='enable';}).length + ' viable, ' + results.filter(function(r){return r.action==='kill';}).length + ' killed'];
    }
  },


];
