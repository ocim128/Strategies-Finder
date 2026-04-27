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
  outcomeIntervalRow: 'polymarketOutcomeIntervalRow',
  entrySelectionModeRow: 'polymarketEntrySelectionModeRow',
  entryOffsetRow: 'polymarketEntryOffsetRow',
  exitModeRow: 'polymarketExitModeRow',
  outcomeSymbolRow: 'polymarketOutcomeSymbolRow',
  annotationToggle: 'polymarketAnnotationEnabled',
  outcomeIntervalSelect: 'polymarketOutcomeInterval',
  entrySelectionModeSelect: 'polymarketEntrySelectionMode',
  exitModeSelect: 'polymarketExitMode',
} as const;

export const FINDER_POLYMARKET_IDS = {
  finderRankMode: 'finderPolymarketRankMode',
} as const;

export function getPolymarketAnnotationToggle(): HTMLInputElement | null {
  const el = document.getElementById(POLYMARKET_SETTINGS_IDS.annotationToggle);
  return el instanceof HTMLInputElement ? el : null;
}

export function getPolymarketExitModeSelect(): HTMLSelectElement | null {
  const el = document.getElementById(POLYMARKET_SETTINGS_IDS.exitModeSelect);
  return el instanceof HTMLSelectElement ? el : null;
}

export function getPolymarketEntrySelectionModeSelect(): HTMLSelectElement | null {
  const el = document.getElementById(POLYMARKET_SETTINGS_IDS.entrySelectionModeSelect);
  return el instanceof HTMLSelectElement ? el : null;
}

export function getPolymarketOutcomeIntervalSelect(): HTMLSelectElement | null {
  const el = document.getElementById(POLYMARKET_SETTINGS_IDS.outcomeIntervalSelect);
  return el instanceof HTMLSelectElement ? el : null;
}

export function getPolymarketSettingsRows(): {
  outcomeIntervalRow: HTMLElement | null;
  entrySelectionModeRow: HTMLElement | null;
  offsetRow: HTMLElement | null;
  exitModeRow: HTMLElement | null;
  outcomeSymbolRow: HTMLElement | null;
} {
  return {
    outcomeIntervalRow: document.getElementById(POLYMARKET_SETTINGS_IDS.outcomeIntervalRow),
    entrySelectionModeRow: document.getElementById(POLYMARKET_SETTINGS_IDS.entrySelectionModeRow),
    offsetRow: document.getElementById(POLYMARKET_SETTINGS_IDS.entryOffsetRow),
    exitModeRow: document.getElementById(POLYMARKET_SETTINGS_IDS.exitModeRow),
    outcomeSymbolRow: document.getElementById(POLYMARKET_SETTINGS_IDS.outcomeSymbolRow),
  };
}

export function getFinderPolymarketRankModeSelect(): HTMLSelectElement | null {
  const el = document.getElementById(FINDER_POLYMARKET_IDS.finderRankMode);
  return el instanceof HTMLSelectElement ? el : null;
}
