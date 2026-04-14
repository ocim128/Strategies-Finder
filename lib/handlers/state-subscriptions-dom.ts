export const CHART_MODE_IDS = {
  toggle: 'chartModeToggle',
  label: 'chartModeLabel',
} as const;

export function getChartModeToggle(): HTMLElement | null {
  return document.getElementById(CHART_MODE_IDS.toggle);
}

export function getChartModeLabel(): HTMLElement | null {
  return document.getElementById(CHART_MODE_IDS.label);
}

export const POLYMARKET_SETTINGS_IDS = {
  entryOffsetRow: 'polymarketEntryOffsetRow',
  exitModeRow: 'polymarketExitModeRow',
  outcomeSymbolRow: 'polymarketOutcomeSymbolRow',
  annotationToggle: 'polymarketAnnotationEnabled',
  exitModeSelect: 'polymarketExitMode',
} as const;

export const FINDER_POLYMARKET_IDS = {
  finderRankMode: 'finderPolymarketRankMode',
  huntRankMode: 'huntPolymarketRankMode',
} as const;

export function getPolymarketAnnotationToggle(): HTMLInputElement | null {
  const el = document.getElementById(POLYMARKET_SETTINGS_IDS.annotationToggle);
  return el instanceof HTMLInputElement ? el : null;
}

export function getPolymarketExitModeSelect(): HTMLSelectElement | null {
  const el = document.getElementById(POLYMARKET_SETTINGS_IDS.exitModeSelect);
  return el instanceof HTMLSelectElement ? el : null;
}

export function getPolymarketSettingsRows(): {
  offsetRow: HTMLElement | null;
  exitModeRow: HTMLElement | null;
  outcomeSymbolRow: HTMLElement | null;
} {
  return {
    offsetRow: document.getElementById(POLYMARKET_SETTINGS_IDS.entryOffsetRow),
    exitModeRow: document.getElementById(POLYMARKET_SETTINGS_IDS.exitModeRow),
    outcomeSymbolRow: document.getElementById(POLYMARKET_SETTINGS_IDS.outcomeSymbolRow),
  };
}

export function getPolymarketRankModeSelects(): HTMLSelectElement[] {
  const ids = [FINDER_POLYMARKET_IDS.finderRankMode, FINDER_POLYMARKET_IDS.huntRankMode];
  const results: HTMLSelectElement[] = [];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el instanceof HTMLSelectElement) {
      results.push(el);
    }
  }
  return results;
}
