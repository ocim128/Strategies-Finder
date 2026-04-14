import type { BacktestResult, Trade } from "../strategies/index";
import type { Time } from "lightweight-charts";
import { formatDisplayPrice } from "../price-format";
import type {
  QuickViewPolymarketSummary,
  QuickViewPolymarketExitReasonSummary,
  QuickViewPolymarketExpectancySummary,
} from "./quick-view-service";

export function buildShell(): string {
  return `
      <div class="qv-header">
          <div class="qv-title">
              <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
              </svg>
              Quick View
          </div>
          <div style="display:flex;align-items:center;gap:12px;">
              <span class="qv-hint">
                  <kbd>Esc</kbd> or click to close
              </span>
              <button class="qv-close-btn" id="qvCloseBtn" title="Close Quick View">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                      <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                  </svg>
              </button>
          </div>
      </div>
      <div class="qv-body">
          <div class="qv-results-pane" id="qvResultsPane">
              <div class="qv-empty" id="qvEmpty">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                      <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/>
                  </svg>
                  Run a backtest to see results
              </div>
              <div id="qvStatsContent" style="display:none;"></div>
          </div>
          <div class="qv-trades-pane">
              <div class="qv-trades-header">
                  <span class="qv-trades-title">
                      Trades
                      <span class="qv-trades-count" id="qvTradesCount">0</span>
                  </span>
                  <button class="qv-sort-btn" id="qvSortToggle" title="Toggle sort order">
                      <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                          <path d="M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z"/>
                      </svg>
                      <span id="qvSortLabel">Newest first</span>
                  </button>
              </div>
              <div class="qv-trades-list" id="qvTradesList"></div>
          </div>
      </div>
  `;
}

export function renderResultsHtml(
  result: BacktestResult,
  options: {
    polymarketPayoutSummary: { expectancy: number; profitFactor: number | null } | null;
    polymarketSectionHtml: string;
  }
): string {
  const { polymarketPayoutSummary, polymarketSectionHtml } = options;
  const performanceExpectancyLabel = polymarketPayoutSummary ? 'Polymarket Exp / Trade' : 'Expectancy';
  const performanceExpectancyValue = polymarketPayoutSummary
    ? formatPolymarketCents(polymarketPayoutSummary.expectancy)
    : `${result.expectancy >= 0 ? '+' : ''}$${result.expectancy.toFixed(2)}`;
  const performanceExpectancyTone = polymarketPayoutSummary
    ? polymarketPayoutSummary.expectancy
    : result.expectancy;
  const isPositive = result.netProfit >= 0;
  const pfText = result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2);

  return `
      <div class="qv-section-title">Performance</div>
      <div class="qv-stats-grid">
          <div class="qv-stat-card">
              <div class="qv-stat-label">Net Profit</div>
              <div class="qv-stat-value ${isPositive ? 'positive' : 'negative'}">
                  $${result.netProfit.toFixed(2)}
              </div>
          </div>
          <div class="qv-stat-card">
              <div class="qv-stat-label">Net Profit %</div>
              <div class="qv-stat-value ${isPositive ? 'positive' : 'negative'}">
                  ${result.netProfitPercent.toFixed(2)}%
              </div>
          </div>
          <div class="qv-stat-card">
              <div class="qv-stat-label">Win Rate</div>
              <div class="qv-stat-value">${result.winRate.toFixed(1)}%</div>
          </div>
          <div class="qv-stat-card">
              <div class="qv-stat-label">Profit Factor</div>
              <div class="qv-stat-value">${pfText}</div>
          </div>
          <div class="qv-stat-card">
              <div class="qv-stat-label">${performanceExpectancyLabel}</div>
              <div class="qv-stat-value ${performanceExpectancyTone >= 0 ? 'positive' : 'negative'}">
                  ${performanceExpectancyValue}
              </div>
          </div>
          <div class="qv-stat-card">
              <div class="qv-stat-label">Max Drawdown</div>
              <div class="qv-stat-value negative">${result.maxDrawdownPercent.toFixed(2)}%</div>
          </div>
      </div>

      <div class="qv-section-title">Trade Stats</div>
      <div class="qv-stats-grid">
          <div class="qv-stat-card">
              <div class="qv-stat-label">Total Trades</div>
              <div class="qv-stat-value">${result.totalTrades}</div>
          </div>
          <div class="qv-stat-card">
              <div class="qv-stat-label">Avg Trade</div>
              <div class="qv-stat-value ${result.avgTrade >= 0 ? 'positive' : 'negative'}">
                  $${result.avgTrade.toFixed(2)}
              </div>
          </div>
          <div class="qv-stat-card">
              <div class="qv-stat-label">Winning</div>
              <div class="qv-stat-value positive">${result.winningTrades}</div>
          </div>
          <div class="qv-stat-card">
              <div class="qv-stat-label">Losing</div>
              <div class="qv-stat-value negative">${result.losingTrades}</div>
          </div>
          <div class="qv-stat-card">
              <div class="qv-stat-label">Avg Win</div>
              <div class="qv-stat-value positive">$${result.avgWin.toFixed(2)}</div>
          </div>
          <div class="qv-stat-card">
              <div class="qv-stat-label">Avg Loss</div>
              <div class="qv-stat-value negative">$${result.avgLoss.toFixed(2)}</div>
          </div>
          <div class="qv-stat-card full-width">
              <div class="qv-stat-label">Sharpe Ratio</div>
              <div class="qv-stat-value">${result.sharpeRatio.toFixed(2)}</div>
          </div>
      </div>
      ${polymarketSectionHtml}
  `;
}

export function renderTradeChunkHtml(trades: Trade[], startIndex: number, endIndex: number): string {
  let html = '';
  for (let index = startIndex; index < endIndex; index += 1) {
    html += renderTradeItemHtml(trades[index]);
  }
  return html;
}

export function renderTradeItemHtml(trade: Trade): string {
  const isWin = trade.pnl > 0;
  const pnlClass = isWin ? 'positive' : 'negative';
  const pnlSign = isWin ? '+' : '';
  const entryDate = formatTradeTime(trade.entryTime);
  const exitReason = trade.exitReason ? formatExitReason(trade.exitReason) : '';

  return `
      <div class="qv-trade-item" data-entry-time="${typeof trade.entryTime === 'object' ? JSON.stringify(trade.entryTime) : trade.entryTime}" role="button" tabindex="0">
          <span class="qv-trade-type ${trade.type}">${trade.type}</span>
          <span class="qv-trade-prices">
              ${fmtPrice(trade.entryPrice)} -> ${fmtPrice(trade.exitPrice)}
          </span>
          <span class="qv-trade-date">
              ${entryDate}
              ${exitReason}
          </span>
          <span class="qv-trade-pnl ${pnlClass}">
              ${pnlSign}$${trade.pnl.toFixed(2)} (${pnlSign}${trade.pnlPercent.toFixed(2)}%)
          </span>
      </div>
  `;
}

export function renderTradesLimitNoticeHtml(totalTrades: number, maxRendered: number): string {
  return `<div class="qv-empty">Showing ${maxRendered} of ${totalTrades} trades</div>`;
}

export function renderEmptyTradesHtml(): string {
  return `
      <div class="qv-empty">
          <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6h-6z"/>
          </svg>
          No trades
      </div>
  `;
}

export function buildPolymarketSectionHtml(summary: QuickViewPolymarketSummary): string {
  if (!summary) return '';
  const isSignalExit = summary.evaluationMode === "signal_exit_same_event";
  const modeLabel = isSignalExit ? "Signal Exit (same event)" : (typeof summary.entryOffset === 'number' ? `Selected Offset: Minute ${summary.entryOffset}` : 'Run Mode: Native 5m scoring');
  const winCountLabel = isSignalExit ? "Profitable Trades" : "Poly Wins";
  const lossCountLabel = isSignalExit ? "Losing Trades" : "Poly Losses";
  const streakWinLabel = isSignalExit ? "Max Profit Streak" : "Max Win Streak";
  const streakLossLabel = isSignalExit ? "Max Loss Streak" : "Max Loss Streak";
  const recentFormLabel = isSignalExit ? "Last 50 P/L/F" : "Last 50 W/L";
  const recentFormValue = summary.recentFormTrades === 0
    ? "n/a"
    : isSignalExit
      ? `${summary.recentFormWins} profit - ${summary.recentFormLosses} loss${summary.recentFormFlats > 0 ? ` - ${summary.recentFormFlats} flat` : ""}`
      : `${summary.recentFormWins} win - ${summary.recentFormLosses} lose`;
  const recentFormToneClass = summary.recentFormTrades === 0
    ? ""
    : isSignalExit && summary.recentFormWins === 0 && summary.recentFormLosses === 0
      ? ""
      : summary.recentFormWinRate >= 0.5
        ? "positive"
        : "negative";
  const profitabilityToneClass = isSignalExit && summary.wins === 0 && summary.losses === 0
    ? ""
    : summary.winRate >= 0.5
      ? "positive"
      : "negative";
  const afterMaxHoldLabel = isSignalExit ? "Entry Profit % | After Max Hold" : "Entry Win % | After Max Hold";
  const afterTakeProfitLabel = isSignalExit ? "Entry Profit % | After TP" : "Entry Win % | After TP";
  const afterSignalLabel = isSignalExit ? "Entry Profit % | After Signal" : "Entry Win % | After Signal";
  const timingProfileSection = summary.timingProfile && summary.timingProfile.length > 0
    ? buildPolymarketTimingProfileSectionHtml(summary)
    : '';
  const diagnosticsNote = `
      <div class="qv-stat-card full-width qv-poly-meta-card">
          <div class="qv-stat-label">Detailed Diagnostics</div>
          <div class="qv-diagnostic-hint">Payout summary, timing buckets, and the snapshot profile now live in the Polymarket tab for readability.</div>
      </div>
  `;

  const signalExitCards = isSignalExit ? `
          <div class="qv-stat-card">
              <div class="qv-stat-label">Signal Exited</div>
              <div class="qv-stat-value">${summary.signalExitedTrades ?? 0}</div>
          </div>
          <div class="qv-stat-card">
              <div class="qv-stat-label">Resolved (Held)</div>
              <div class="qv-stat-value">${summary.resolvedTrades ?? 0}</div>
          </div>
          ${summary.neutralTrades > 0 ? `
          <div class="qv-stat-card">
              <div class="qv-stat-label">Neutral Trades</div>
              <div class="qv-stat-value">${summary.neutralTrades}</div>
          </div>
          ` : ""}
          ${summary.missingPriceTrades && summary.missingPriceTrades > 0 ? `
          <div class="qv-stat-card">
              <div class="qv-stat-label">Missing Price Trades</div>
              <div class="qv-stat-value">${summary.missingPriceTrades}</div>
          </div>
          ` : ""}
  ` : '';

  const baselineCard = isSignalExit ? '' : `
          <div class="qv-stat-card">
              <div class="qv-stat-label">Baseline Delta</div>
              <div class="qv-stat-value ${summary.baselineDelta >= 0 ? 'positive' : 'negative'}">
                  ${summary.baselineDelta >= 0 ? '+' : ''}${(summary.baselineDelta * 100).toFixed(1)}pp
              </div>
          </div>
  `;

  return `
      <div class="qv-section-title">Polymarket</div>
      <div class="qv-stats-grid">
          <div class="qv-stat-card full-width qv-poly-meta-card">
              <div class="qv-stat-label">${modeLabel}</div>
              <div class="qv-stat-value">${summary.bestTimingProfile ? `Best Minute ${summary.bestTimingProfile.entryOffset} (${(summary.bestTimingProfile.winRate * 100).toFixed(1)}%)` : 'See Polymarket tab for full diagnostics'}</div>
          </div>
          <div class="qv-stat-card">
              <div class="qv-stat-label">${isSignalExit ? 'Poly Profitable' : 'Poly Win Rate'}</div>
              <div class="qv-stat-value ${profitabilityToneClass}">
                  ${(summary.winRate * 100).toFixed(1)}%
              </div>
          </div>
          <div class="qv-stat-card">
              <div class="qv-stat-label">Poly Exp / Trade</div>
              <div class="qv-stat-value ${summary.expectancy === null ? '' : (summary.expectancy >= 0 ? 'positive' : 'negative')}">
                  ${summary.expectancy === null ? 'n/a' : formatPolymarketCents(summary.expectancy)}
              </div>
          </div>
          <div class="qv-stat-card">
              <div class="qv-stat-label">Poly Profit Factor</div>
              <div class="qv-stat-value">${formatProfitFactor(summary.profitFactor)}</div>
          </div>
          <div class="qv-stat-card">
              <div class="qv-stat-label">Scored Trade Share</div>
              <div class="qv-stat-value">${(summary.coverage * 100).toFixed(1)}%</div>
          </div>
          <div class="qv-stat-card">
              <div class="qv-stat-label">${winCountLabel}</div>
              <div class="qv-stat-value positive">${summary.wins}</div>
          </div>
          <div class="qv-stat-card">
              <div class="qv-stat-label">${lossCountLabel}</div>
              <div class="qv-stat-value negative">${summary.losses}</div>
          </div>
          ${baselineCard}
          ${signalExitCards}
          <div class="qv-stat-card">
              <div class="qv-stat-label">${streakWinLabel}</div>
              <div class="qv-stat-value positive">${summary.longestWinStreak}</div>
          </div>
          <div class="qv-stat-card">
              <div class="qv-stat-label">${streakLossLabel}</div>
              <div class="qv-stat-value negative">${summary.longestLossStreak}</div>
          </div>
          <div class="qv-stat-card">
              <div class="qv-stat-label">${recentFormLabel}</div>
              <div class="qv-stat-value ${recentFormToneClass}">
                  ${recentFormValue}
              </div>
          </div>
          ${renderPolymarketExitReasonWinRateCardHtml(afterMaxHoldLabel, summary.exitReasonWinRates.maxHold)}
          ${renderPolymarketExitReasonWinRateCardHtml(afterTakeProfitLabel, summary.exitReasonWinRates.takeProfit)}
          ${renderPolymarketExpectancyCardHtml('Entry Exp / Trade | After TP', summary.afterTakeProfitExpectancy)}
          ${renderPolymarketExitReasonWinRateCardHtml(afterSignalLabel, summary.exitReasonWinRates.signal)}
          <div class="qv-stat-card">
              <div class="qv-stat-label">Scored Trades</div>
              <div class="qv-stat-value">${summary.scoredTrades}</div>
          </div>
          <div class="qv-stat-card">
              <div class="qv-stat-label">Unscored Trades</div>
              <div class="qv-stat-value">${summary.unscoredTrades}</div>
          </div>
          ${summary.missingTrades > 0 ? `
          <div class="qv-stat-card">
              <div class="qv-stat-label">Missing Outcome Rows</div>
              <div class="qv-stat-value">${summary.missingTrades}</div>
          </div>
          ` : ''}
          <div class="qv-stat-card full-width qv-poly-meta-card">
              <div class="qv-stat-label">Outcome Rows Fetched</div>
              <div class="qv-stat-value">${summary.outcomeRowsLoaded}</div>
          </div>
          ${diagnosticsNote}
          ${timingProfileSection}
      </div>
  `;
}

function buildPolymarketTimingProfileSectionHtml(summary: QuickViewPolymarketSummary): string {
  const timingProfile = summary.timingProfile ?? [];
  if (timingProfile.length === 0) return '';
  const bestOffset = summary.bestTimingProfile?.entryOffset;
  const rows = timingProfile.map((entry) => `
      <div class="qv-poly-profile-row ${entry.entryOffset === bestOffset ? 'is-best' : ''} ${entry.entryOffset === summary.entryOffset ? 'is-selected' : ''}">
          <div class="qv-poly-profile-cell qv-poly-profile-cell--offset">Minute ${entry.entryOffset}</div>
          <div class="qv-poly-profile-cell">${(entry.winRate * 100).toFixed(1)}%</div>
          <div class="qv-poly-profile-cell">${entry.scoredTrades}</div>
          <div class="qv-poly-profile-cell">${(entry.coverage * 100).toFixed(1)}%</div>
          <div class="qv-poly-profile-cell">${entry.duplicateTradesIgnored}</div>
      </div>
  `).join('');
  return `
      <div class="qv-stat-card full-width qv-poly-meta-card">
          <div class="qv-stat-label">Entry Timing Profile (1m -> 5m)</div>
          <div class="qv-poly-profile-grid">
              <div class="qv-poly-profile-row qv-poly-profile-row--header">
                  <div class="qv-poly-profile-cell qv-poly-profile-cell--offset">Offset</div>
                  <div class="qv-poly-profile-cell">Win Rate</div>
                  <div class="qv-poly-profile-cell">Scored</div>
                  <div class="qv-poly-profile-cell">Coverage</div>
                  <div class="qv-poly-profile-cell">Dupes</div>
              </div>
              ${rows}
          </div>
      </div>
  `;
}

function renderPolymarketExitReasonWinRateCardHtml(
  label: string,
  summary: QuickViewPolymarketExitReasonSummary
): string {
  const value = summary.trades > 0
    ? `${(summary.winRate * 100).toFixed(1)}% | ${summary.trades}t`
    : 'n/a';
  const toneClass = summary.trades > 0
    ? (summary.wins === 0 && summary.losses === 0 ? '' : (summary.winRate >= 0.5 ? 'positive' : 'negative'))
    : '';

  return `
      <div class="qv-stat-card">
          <div class="qv-stat-label">${label}</div>
          <div class="qv-stat-value ${toneClass}">${value}</div>
      </div>
  `;
}

function renderPolymarketExpectancyCardHtml(
  label: string,
  summary: QuickViewPolymarketExpectancySummary
): string {
  const expectancyValue = summary.expectancy;
  const hasData = summary.pricedTrades > 0 && expectancyValue !== null;
  const value = hasData
    ? `${formatPolymarketCents(expectancyValue)} | ${summary.pricedTrades}t`
    : "n/a";
  const toneClass = hasData
    ? (expectancyValue >= 0 ? "positive" : "negative")
    : "";

  return `
      <div class="qv-stat-card">
          <div class="qv-stat-label">${label}</div>
          <div class="qv-stat-value ${toneClass}">${value}</div>
      </div>
  `;
}

export function fmtPrice(price: number): string {
  return formatDisplayPrice(price);
}

export function formatPolymarketCents(value: number): string {
  const prefix = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${prefix}${(Math.abs(value) * 100).toFixed(1)}c`;
}

export function formatProfitFactor(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return value === Infinity ? '∞' : 'n/a';
  }
  return value.toFixed(2);
}

export function formatTradeTime(time: Time): string {
  if (typeof time === 'number') {
    const d = new Date(time * 1000);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
  }
  if (typeof time === 'string') {
    return time;
  }
  const bd = time as { year: number; month: number; day: number };
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[bd.month - 1]} ${bd.day}, ${String(bd.year).slice(-2)}`;
}

export function formatExitReason(reason: string): string {
  const labels: Record<string, string> = {
    'stop_loss': 'SL',
    'take_profit': 'TP',
    'trailing_stop': 'TS',
    'end_of_data': 'EOD',
    'signal': 'SIG',
    'timeout': 'TO',
  };
  const label = labels[reason] || reason.slice(0, 4).toUpperCase();
  return `<span class="qv-exit-badge">${label}</span>`;
}
