import type { BacktestResult, Trade } from "../strategies/index";
import type { Time } from "lightweight-charts";
import { formatDisplayPrice } from "../price-format";
import { renderLabeledCard } from "../ui-render-helpers";
import {
  formatProfitFactor as formatUiProfitFactor,
} from "../ui-formatters";

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

export function renderResultsHtml(result: BacktestResult): string {
  const performanceExpectancyLabel = 'Expectancy';
  const performanceExpectancyValue = `${result.expectancy >= 0 ? '+' : ''}${result.expectancy.toFixed(2)}`;
  const performanceExpectancyTone = result.expectancy;
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
  const encodedEntryTime = encodeURIComponent(JSON.stringify(trade.entryTime));

  return `
      <div class="qv-trade-item" data-entry-time="${encodedEntryTime}" role="button" tabindex="0">
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

export function fmtPrice(price: number): string {
  return formatDisplayPrice(price);
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
    'path_exit': 'PTH',
  };
  const label = labels[reason] || reason.slice(0, 4).toUpperCase();
  return `<span class="qv-exit-badge">${label}</span>`;
}
