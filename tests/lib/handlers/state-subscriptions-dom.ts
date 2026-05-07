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
  postSignalLimitEntryEnabledRow: 'polymarketPostSignalLimitEntryEnabledRow',
  postSignalLimitEntryModeRow: 'polymarketPostSignalLimitEntryModeRow',
  postSignalLimitEntryPriceCentsRow: 'polymarketPostSignalLimitEntryPriceCentsRow',
  postSignalLimitEntryOffsetCentsRow: 'polymarketPostSignalLimitEntryOffsetCentsRow',
  postSignalLimitExitEnabledRow: 'polymarketPostSignalLimitExitEnabledRow',
  postSignalLimitExitModeRow: 'polymarketPostSignalLimitExitModeRow',
  postSignalLimitExitPriceCentsRow: 'polymarketPostSignalLimitExitPriceCentsRow',
  postSignalLimitExitOffsetCentsRow: 'polymarketPostSignalLimitExitOffsetCentsRow',
  outcomeSymbolRow: 'polymarketOutcomeSymbolRow',
  annotationToggle: 'polymarketAnnotationEnabled',
  outcomeIntervalSelect: 'polymarketOutcomeInterval',
  entrySelectionModeSelect: 'polymarketEntrySelectionMode',
  exitModeSelect: 'polymarketExitMode',
  postSignalLimitEntryToggle: 'polymarketPostSignalLimitEntryEnabled',
  postSignalLimitEntryModeSelect: 'polymarketPostSignalLimitEntryMode',
  postSignalLimitExitToggle: 'polymarketPostSignalLimitExitEnabled',
  postSignalLimitExitModeSelect: 'polymarketPostSignalLimitExitMode',
} as const;

export const FINDER_POLYMARKET_IDS = {
  finderRankMode: 'finderPolymarketRankMode',
} as const;

export const STATE_SUBSCRIPTIONS_REQUIRED_IDS = [
  ...Object.values(CHART_MODE_IDS),
  ...Object.values(POLYMARKET_SETTINGS_IDS),
  ...Object.values(FINDER_POLYMARKET_IDS),
] as const;

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

export function getPolymarketPostSignalLimitEntryToggle(): HTMLInputElement | null {
  const el = document.getElementById(POLYMARKET_SETTINGS_IDS.postSignalLimitEntryToggle);
  return el instanceof HTMLInputElement ? el : null;
}

export function getPolymarketPostSignalLimitEntryModeSelect(): HTMLSelectElement | null {
  const el = document.getElementById(POLYMARKET_SETTINGS_IDS.postSignalLimitEntryModeSelect);
  return el instanceof HTMLSelectElement ? el : null;
}

export function getPolymarketPostSignalLimitExitToggle(): HTMLInputElement | null {
  const el = document.getElementById(POLYMARKET_SETTINGS_IDS.postSignalLimitExitToggle);
  return el instanceof HTMLInputElement ? el : null;
}

export function getPolymarketPostSignalLimitExitModeSelect(): HTMLSelectElement | null {
  const el = document.getElementById(POLYMARKET_SETTINGS_IDS.postSignalLimitExitModeSelect);
  return el instanceof HTMLSelectElement ? el : null;
}

export function getPolymarketSettingsRows(): {
  outcomeIntervalRow: HTMLElement | null;
  entrySelectionModeRow: HTMLElement | null;
  offsetRow: HTMLElement | null;
  exitModeRow: HTMLElement | null;
  postSignalLimitEntryEnabledRow: HTMLElement | null;
  postSignalLimitEntryModeRow: HTMLElement | null;
  postSignalLimitEntryPriceCentsRow: HTMLElement | null;
  postSignalLimitEntryOffsetCentsRow: HTMLElement | null;
  postSignalLimitExitEnabledRow: HTMLElement | null;
  postSignalLimitExitModeRow: HTMLElement | null;
  postSignalLimitExitPriceCentsRow: HTMLElement | null;
  postSignalLimitExitOffsetCentsRow: HTMLElement | null;
  outcomeSymbolRow: HTMLElement | null;
} {
  return {
    outcomeIntervalRow: document.getElementById(POLYMARKET_SETTINGS_IDS.outcomeIntervalRow),
    entrySelectionModeRow: document.getElementById(POLYMARKET_SETTINGS_IDS.entrySelectionModeRow),
    offsetRow: document.getElementById(POLYMARKET_SETTINGS_IDS.entryOffsetRow),
    exitModeRow: document.getElementById(POLYMARKET_SETTINGS_IDS.exitModeRow),
    postSignalLimitEntryEnabledRow: document.getElementById(POLYMARKET_SETTINGS_IDS.postSignalLimitEntryEnabledRow),
    postSignalLimitEntryModeRow: document.getElementById(POLYMARKET_SETTINGS_IDS.postSignalLimitEntryModeRow),
    postSignalLimitEntryPriceCentsRow: document.getElementById(POLYMARKET_SETTINGS_IDS.postSignalLimitEntryPriceCentsRow),
    postSignalLimitEntryOffsetCentsRow: document.getElementById(POLYMARKET_SETTINGS_IDS.postSignalLimitEntryOffsetCentsRow),
    postSignalLimitExitEnabledRow: document.getElementById(POLYMARKET_SETTINGS_IDS.postSignalLimitExitEnabledRow),
    postSignalLimitExitModeRow: document.getElementById(POLYMARKET_SETTINGS_IDS.postSignalLimitExitModeRow),
    postSignalLimitExitPriceCentsRow: document.getElementById(POLYMARKET_SETTINGS_IDS.postSignalLimitExitPriceCentsRow),
    postSignalLimitExitOffsetCentsRow: document.getElementById(POLYMARKET_SETTINGS_IDS.postSignalLimitExitOffsetCentsRow),
    outcomeSymbolRow: document.getElementById(POLYMARKET_SETTINGS_IDS.outcomeSymbolRow),
  };
}

export function getFinderPolymarketRankModeSelect(): HTMLSelectElement | null {
  const el = document.getElementById(FINDER_POLYMARKET_IDS.finderRankMode);
  return el instanceof HTMLSelectElement ? el : null;
}
