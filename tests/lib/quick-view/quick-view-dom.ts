export const QV_IDS = {
  overlay: 'quickViewOverlay',
  closeBtn: 'qvCloseBtn',
  sortToggle: 'qvSortToggle',
  resultsPane: 'qvResultsPane',
  empty: 'qvEmpty',
  statsContent: 'qvStatsContent',
  tradesCount: 'qvTradesCount',
  sortLabel: 'qvSortLabel',
  tradesList: 'qvTradesList',
  quickViewBtn: 'quickViewBtn',
} as const;

export function getChartWrapper(): HTMLElement | null {
  return document.querySelector('.chart-wrapper');
}

export function getQuickViewBtn(): HTMLElement | null {
  return document.getElementById(QV_IDS.quickViewBtn);
}

export function getQvStatsContent(): HTMLElement | null {
  return document.getElementById(QV_IDS.statsContent);
}

export function getQvEmpty(): HTMLElement | null {
  return document.getElementById(QV_IDS.empty);
}

export function getQvTradesList(): HTMLElement | null {
  return document.getElementById(QV_IDS.tradesList);
}

export function getQvTradesCount(): HTMLElement | null {
  return document.getElementById(QV_IDS.tradesCount);
}

export function getQvSortLabel(): HTMLElement | null {
  return document.getElementById(QV_IDS.sortLabel);
}
