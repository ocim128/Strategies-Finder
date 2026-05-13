import type { BacktestResult, Trade } from "../strategies/index";
import type { Time } from "lightweight-charts";
import { formatDisplayPrice } from "../price-format";
import { renderLabeledCard } from "../ui-render-helpers";
import {
  formatCount,
  formatPolymarketCents,
  formatProbabilityCents,
  formatProfitFactor as formatUiProfitFactor,
  formatSignedCompactDollar,
  formatSignedCompactPercentPoints,
} from "../ui-formatters";
import type {
  QuickViewPolymarketSummary,
  QuickViewPolymarketExitReasonSummary,
  QuickViewPolymarketExpectancySummary,
} from "./quick-view-service";

interface QvStatCard {
  label: string;
  value: string;
  toneClass?: string;
  extraClass?: string;
}

function renderQvStatCard(card: QvStatCard): string {
  return renderLabeledCard({
    label: card.label,
    value: card.value,
    cardClass: "qv-stat-card",
    labelClass: "qv-stat-label",
    valueClass: "qv-stat-value",
    toneClass: card.toneClass,
    extraClass: card.extraClass,
  });
}

function renderQvStatCards(cards: readonly QvStatCard[]): string {
  return cards.map(renderQvStatCard).join("");
}

function formatQvProfitFactor(value: number | null | undefined): string {
  return formatUiProfitFactor(value, "∞");
}

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
  const profitTone = result.netProfit >= 0 ? 'positive' : 'negative';
  const performanceCards: QvStatCard[] = [
    { label: 'Net Profit', value: `$${result.netProfit.toFixed(2)}`, toneClass: profitTone },
    { label: 'Net Profit %', value: `${result.netProfitPercent.toFixed(2)}%`, toneClass: profitTone },
    { label: 'Win Rate', value: `${result.winRate.toFixed(1)}%` },
    { label: 'Profit Factor', value: formatQvProfitFactor(result.profitFactor) },
    {
      label: performanceExpectancyLabel,
      value: performanceExpectancyValue,
      toneClass: performanceExpectancyTone >= 0 ? 'positive' : 'negative',
    },
    { label: 'Max Drawdown', value: `${result.maxDrawdownPercent.toFixed(2)}%`, toneClass: 'negative' },
  ];
  const tradeCards: QvStatCard[] = [
    { label: 'Total Trades', value: String(result.totalTrades) },
    { label: 'Avg Trade', value: `$${result.avgTrade.toFixed(2)}`, toneClass: result.avgTrade >= 0 ? 'positive' : 'negative' },
    { label: 'Winning', value: String(result.winningTrades), toneClass: 'positive' },
    { label: 'Losing', value: String(result.losingTrades), toneClass: 'negative' },
    { label: 'Avg Win', value: `$${result.avgWin.toFixed(2)}`, toneClass: 'positive' },
    { label: 'Avg Loss', value: `$${result.avgLoss.toFixed(2)}`, toneClass: 'negative' },
    { label: 'Sharpe Ratio', value: result.sharpeRatio.toFixed(2), extraClass: 'full-width' },
  ];

  return `
      <div class="qv-section-title">Performance</div>
      <div class="qv-stats-grid">
          ${renderQvStatCards(performanceCards)}
      </div>

      <div class="qv-section-title">Trade Stats</div>
      <div class="qv-stats-grid">
          ${renderQvStatCards(tradeCards)}
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
  const usesRealizedPnl = isSignalExit || summary.limitExitEnabled === true;
  const usesActualEntryMinute = summary.entrySelectionMode === "actual_entry_minute";
  const outcomeInterval = summary.outcomeInterval ?? "5m";
  const usesNativeLongSession = outcomeInterval !== "5m";
  const modeLabel = isSignalExit
    ? "Signal Exit (same event)"
    : usesActualEntryMinute
      ? "Entry Selection: Auto (actual trade minute)"
      : (!usesNativeLongSession && typeof summary.entryOffset === 'number'
          ? `Selected Offset: Minute ${summary.entryOffset}`
          : `Run Mode: Native ${outcomeInterval} scoring`);
  const winCountLabel = usesRealizedPnl ? "Profitable Trades" : "Poly Wins";
  const lossCountLabel = usesRealizedPnl ? "Losing Trades" : "Poly Losses";
  const streakWinLabel = usesRealizedPnl ? "Max Profit Streak" : "Max Win Streak";
  const streakLossLabel = usesRealizedPnl ? "Max Loss Streak" : "Max Loss Streak";
  const recentFormLabel = usesRealizedPnl ? "Last 50 P/L/F" : "Last 50 W/L";
  const recentFormValue = summary.recentFormTrades === 0
    ? "n/a"
    : usesRealizedPnl
      ? `${summary.recentFormWins} profit - ${summary.recentFormLosses} loss${summary.recentFormFlats > 0 ? ` - ${summary.recentFormFlats} flat` : ""}`
      : `${summary.recentFormWins} win - ${summary.recentFormLosses} lose`;
  const recentFormToneClass = summary.recentFormTrades === 0
    ? ""
    : usesRealizedPnl && summary.recentFormWins === 0 && summary.recentFormLosses === 0
      ? ""
      : summary.recentFormWinRate >= 0.5
        ? "positive"
        : "negative";
  const profitabilityToneClass = usesRealizedPnl && summary.wins === 0 && summary.losses === 0
    ? ""
    : summary.winRate >= 0.5
      ? "positive"
      : "negative";
  const afterMaxHoldLabel = usesRealizedPnl ? "Entry Profit % | After Max Hold" : "Entry Win % | After Max Hold";
  const afterTakeProfitLabel = usesRealizedPnl ? "Entry Profit % | After TP" : "Entry Win % | After TP";
  const afterSignalLabel = usesRealizedPnl ? "Entry Profit % | After Signal" : "Entry Win % | After Signal";
  const timingProfileSection = !usesNativeLongSession && summary.timingProfile && summary.timingProfile.length > 0
    ? buildPolymarketTimingProfileSectionHtml(summary)
    : '';
  const hasSizedBankroll = typeof summary.sizedNetProfit === 'number'
    && typeof summary.sizedTrades === 'number'
    && summary.sizedTrades > 0;
  const sizedTradeCount = summary.sizedTrades ?? 0;
  const sizedBankrollCards = hasSizedBankroll
    ? renderQvStatCards([
      {
        label: `Alternative Sizing: ${formatSizingModeLabel(summary.sizedSizingMode)}`,
        value: `${formatCount(sizedTradeCount)} sized${(summary.sizedSkippedTrades ?? 0) > 0 ? ` | ${formatCount(summary.sizedSkippedTrades ?? 0)} skipped` : ''}`,
        extraClass: 'full-width qv-poly-meta-card',
      },
      { label: 'Sized Net', value: formatSignedCompactDollar(summary.sizedNetProfit!), toneClass: summary.sizedNetProfit! >= 0 ? 'positive' : 'negative' },
      { label: 'Sized Return', value: formatSignedCompactPercentPoints(summary.sizedNetProfitPercent ?? 0), toneClass: (summary.sizedNetProfitPercent ?? 0) >= 0 ? 'positive' : 'negative' },
      { label: 'Sized PF', value: formatQvProfitFactor(summary.sizedProfitFactor ?? null) },
      { label: 'Sized Max DD', value: `${(summary.sizedMaxDrawdownPercent ?? 0).toFixed(2)}%`, toneClass: 'negative' },
      ...((summary.sizedNoCapitalTrades ?? 0) > 0 || (summary.sizedCappedTrades ?? 0) > 0
        ? [{ label: 'Sizing Constraints', value: `${formatCount(summary.sizedNoCapitalTrades ?? 0)} no capital | ${formatCount(summary.sizedCappedTrades ?? 0)} capped` }]
        : []),
    ])
    : '';
  const diagnosticsNote = `
      <div class="qv-stat-card full-width qv-poly-meta-card">
          <div class="qv-stat-label">Detailed Diagnostics</div>
          <div class="qv-diagnostic-hint">Payout summary, timing buckets, and the snapshot profile now live in the Polymarket tab for readability.</div>
      </div>
  `;

  const signalExitCards = isSignalExit
    ? renderQvStatCards([
      ...((summary.targetExitedTrades ?? 0) > 0 ? [{ label: 'Target Exited', value: String(summary.targetExitedTrades) }] : []),
      { label: 'Signal Exited', value: String(summary.signalExitedTrades ?? 0) },
      { label: 'Resolved (Held)', value: String(summary.resolvedTrades ?? 0) },
      ...(summary.neutralTrades > 0 ? [{ label: 'Neutral Trades', value: String(summary.neutralTrades) }] : []),
      ...((summary.missingPriceTrades ?? 0) > 0 ? [{ label: 'Missing Price Trades', value: String(summary.missingPriceTrades) }] : []),
    ])
    : '';

  const limitEntryCards = summary.limitEntryEnabled
    ? renderQvStatCards([
      { label: 'Limit Attempts', value: String(summary.limitEntryAttempts ?? 0) },
      { label: 'Limit Filled', value: String(summary.limitEntryFilledTrades ?? 0) },
      { label: 'Limit Missed', value: String(summary.limitEntryMissedTrades ?? 0) },
      { label: 'Limit Fill Rate', value: `${((summary.limitEntryFillRate ?? 0) * 100).toFixed(1)}%` },
      ...((summary.limitEntryNotTouchedTrades ?? 0) > 0 ? [{ label: 'Not Touched', value: String(summary.limitEntryNotTouchedTrades) }] : []),
      ...((summary.limitEntryLastMinuteOnlyTrades ?? 0) > 0 ? [{ label: 'Last-Min Only', value: String(summary.limitEntryLastMinuteOnlyTrades) }] : []),
      ...((summary.limitEntryMissingPriceTrades ?? 0) > 0 ? [{ label: 'Missing Limit Price', value: String(summary.limitEntryMissingPriceTrades) }] : []),
      ...(summary.limitExitEnabled ? [
        { label: 'Target Filled', value: String(summary.limitExitFilledTrades ?? 0) },
        { label: 'Target Fallback', value: String(summary.limitExitFallbackTrades ?? 0) },
        ...((summary.limitExitUnreachableTrades ?? 0) > 0 ? [{ label: 'Target Unreachable', value: String(summary.limitExitUnreachableTrades) }] : []),
      ] : []),
    ])
    : '';

  const baselineCard = usesRealizedPnl
    ? ''
    : renderQvStatCard({
      label: 'Baseline Delta',
      value: `${summary.baselineDelta >= 0 ? '+' : ''}${(summary.baselineDelta * 100).toFixed(1)}pp`,
      toneClass: summary.baselineDelta >= 0 ? 'positive' : 'negative',
    });
  const modeCard = renderQvStatCard({
    label: modeLabel,
    value: summary.bestTimingProfile
      ? `Best Minute ${summary.bestTimingProfile.entryOffset} (${(summary.bestTimingProfile.winRate * 100).toFixed(1)}%)`
      : (usesActualEntryMinute ? 'See Polymarket tab for auto-mode diagnostics' : 'See Polymarket tab for full diagnostics'),
    extraClass: 'full-width qv-poly-meta-card',
  });
  const corePolymarketCards = renderQvStatCards([
    { label: usesRealizedPnl ? 'Poly Profitable' : 'Poly Win Rate', value: `${(summary.winRate * 100).toFixed(1)}%`, toneClass: profitabilityToneClass },
    {
      label: 'Poly Exp / Trade',
      value: summary.expectancy === null ? 'n/a' : formatPolymarketCents(summary.expectancy),
      toneClass: summary.expectancy === null ? '' : (summary.expectancy >= 0 ? 'positive' : 'negative'),
    },
    { label: 'Poly Profit Factor', value: formatQvProfitFactor(summary.profitFactor) },
    { label: 'Avg Win', value: summary.avgWin === null ? 'n/a' : formatPolymarketCents(summary.avgWin), toneClass: summary.avgWin === null ? '' : 'positive' },
    { label: 'Avg Loss', value: summary.avgLoss === null ? 'n/a' : formatPolymarketCents(-summary.avgLoss), toneClass: summary.avgLoss === null ? '' : 'negative' },
    { label: 'Avg Entry Price', value: summary.avgEntryPrice === null ? 'n/a' : formatProbabilityCents(summary.avgEntryPrice) },
    { label: 'Scored Trade Share', value: `${(summary.coverage * 100).toFixed(1)}%` },
    { label: winCountLabel, value: String(summary.wins), toneClass: 'positive' },
    { label: lossCountLabel, value: String(summary.losses), toneClass: 'negative' },
  ]);
  const streakPolymarketCards = renderQvStatCards([
    { label: streakWinLabel, value: String(summary.longestWinStreak), toneClass: 'positive' },
    { label: streakLossLabel, value: String(summary.longestLossStreak), toneClass: 'negative' },
    { label: recentFormLabel, value: recentFormValue, toneClass: recentFormToneClass },
  ]);
  const footerPolymarketCards = renderQvStatCards([
    { label: 'Scored Trades', value: String(summary.scoredTrades) },
    { label: 'Unscored Trades', value: String(summary.unscoredTrades) },
    ...((summary.duplicateTradesIgnored ?? 0) > 0 ? [{ label: 'Duplicate Trades Ignored', value: String(summary.duplicateTradesIgnored) }] : []),
    ...(summary.missingTrades > 0 ? [{ label: 'Missing Outcome Rows', value: String(summary.missingTrades) }] : []),
    { label: 'Outcome Rows Fetched', value: String(summary.outcomeRowsLoaded), extraClass: 'full-width qv-poly-meta-card' },
  ]);

  return `
      <div class="qv-section-title">Polymarket</div>
      <div class="qv-stats-grid">
          ${modeCard}
          ${sizedBankrollCards}
          ${corePolymarketCards}
          ${baselineCard}
          ${signalExitCards}
          ${limitEntryCards}
          ${streakPolymarketCards}
          ${renderPolymarketExitReasonWinRateCardHtml(afterMaxHoldLabel, summary.exitReasonWinRates.maxHold)}
          ${renderPolymarketExitReasonWinRateCardHtml(afterTakeProfitLabel, summary.exitReasonWinRates.takeProfit)}
          ${renderPolymarketExpectancyCardHtml('Entry Exp / Trade | After TP', summary.afterTakeProfitExpectancy)}
          ${renderPolymarketExitReasonWinRateCardHtml(afterSignalLabel, summary.exitReasonWinRates.signal)}
          ${footerPolymarketCards}
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

  return renderQvStatCard({ label, value, toneClass });
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

  return renderQvStatCard({ label, value, toneClass });
}

export function fmtPrice(price: number): string {
  return formatDisplayPrice(price);
}

function formatSizingModeLabel(mode: string | undefined): string {
  if (!mode) return 'Unknown';
  const labels: Record<string, string> = {
    smart_fixed_velocity_memory: 'Smart Fixed Velocity Memory',
    smart_fixed_quality_x_velocity: 'Smart Fixed Quality x Velocity',
    kelly_criterion: 'Kelly Criterion',
    volatility_targeting: 'Volatility Targeting',
    risk_parity: 'Risk Parity',
    martingale: 'Martingale',
    anti_martingale: 'Anti-Martingale',
    optimal_f: 'Optimal f',
    secure_f: 'Secure f',
  };
  return labels[mode] ?? mode;
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
