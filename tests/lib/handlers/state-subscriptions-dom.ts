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
  entryDelayBarsRow: 'polymarketEntryDelayBarsRow',
  entryPriceFilterCentsRow: 'polymarketEntryPriceFilterCentsRow',
  backtestSlippageCentsRow: 'polymarketBacktestSlippageCentsRow',
  exitModeRow: 'polymarketExitModeRow',
  signalExitAllowMultipleTradesPerEventRow: 'polymarketSignalExitAllowMultipleTradesPerEventRow',
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
  signalExitAllowMultipleTradesPerEventToggle: 'polymarketSignalExitAllowMultipleTradesPerEvent',
  postSignalLimitEntryToggle: 'polymarketPostSignalLimitEntryEnabled',
  postSignalLimitEntryModeSelect: 'polymarketPostSignalLimitEntryMode',
  postSignalLimitExitToggle: 'polymarketPostSignalLimitExitEnabled',
  postSignalLimitExitModeSelect: 'polymarketPostSignalLimitExitMode',
  executionModelSelect: 'executionModel',
} as const;

export const FINDER_POLYMARKET_IDS = {
  finderRankMode: 'finderPolymarketRankMode',
} as const;

const POLYMARKET_SETTINGS_ROW_IDS = {
  outcomeIntervalRow: POLYMARKET_SETTINGS_IDS.outcomeIntervalRow,
  entrySelectionModeRow: POLYMARKET_SETTINGS_IDS.entrySelectionModeRow,
  offsetRow: POLYMARKET_SETTINGS_IDS.entryOffsetRow,
  entryDelayBarsRow: POLYMARKET_SETTINGS_IDS.entryDelayBarsRow,
  entryPriceFilterCentsRow: POLYMARKET_SETTINGS_IDS.entryPriceFilterCentsRow,
  backtestSlippageCentsRow: POLYMARKET_SETTINGS_IDS.backtestSlippageCentsRow,
  exitModeRow: POLYMARKET_SETTINGS_IDS.exitModeRow,
  signalExitAllowMultipleTradesPerEventRow: POLYMARKET_SETTINGS_IDS.signalExitAllowMultipleTradesPerEventRow,
  postSignalLimitEntryEnabledRow: POLYMARKET_SETTINGS_IDS.postSignalLimitEntryEnabledRow,
  postSignalLimitEntryModeRow: POLYMARKET_SETTINGS_IDS.postSignalLimitEntryModeRow,
  postSignalLimitEntryPriceCentsRow: POLYMARKET_SETTINGS_IDS.postSignalLimitEntryPriceCentsRow,
  postSignalLimitEntryOffsetCentsRow: POLYMARKET_SETTINGS_IDS.postSignalLimitEntryOffsetCentsRow,
  postSignalLimitExitEnabledRow: POLYMARKET_SETTINGS_IDS.postSignalLimitExitEnabledRow,
  postSignalLimitExitModeRow: POLYMARKET_SETTINGS_IDS.postSignalLimitExitModeRow,
  postSignalLimitExitPriceCentsRow: POLYMARKET_SETTINGS_IDS.postSignalLimitExitPriceCentsRow,
  postSignalLimitExitOffsetCentsRow: POLYMARKET_SETTINGS_IDS.postSignalLimitExitOffsetCentsRow,
  outcomeSymbolRow: POLYMARKET_SETTINGS_IDS.outcomeSymbolRow,
} as const;

export const STATE_SUBSCRIPTIONS_REQUIRED_IDS = [
  ...Object.values(CHART_MODE_IDS),
  ...Object.values(POLYMARKET_SETTINGS_IDS),
  ...Object.values(FINDER_POLYMARKET_IDS),
] as const;

function getTypedElement<T extends HTMLElement>(
  id: string,
  constructor: { new(): T }
): T | null {
  const el = document.getElementById(id);
  return el instanceof constructor ? el : null;
}

function getElements<TIds extends Record<string, string>>(ids: TIds): {
  [K in keyof TIds]: HTMLElement | null;
} {
  const elements = {} as { [K in keyof TIds]: HTMLElement | null };
  for (const key of Object.keys(ids) as Array<keyof TIds>) {
    elements[key] = document.getElementById(ids[key]);
  }
  return elements;
}

export function getPolymarketAnnotationToggle(): HTMLInputElement | null {
  return getTypedElement(POLYMARKET_SETTINGS_IDS.annotationToggle, HTMLInputElement);
}

export function getPolymarketExitModeSelect(): HTMLSelectElement | null {
  return getTypedElement(POLYMARKET_SETTINGS_IDS.exitModeSelect, HTMLSelectElement);
}

export function getPolymarketSignalExitAllowMultipleTradesToggle(): HTMLInputElement | null {
  return getTypedElement(POLYMARKET_SETTINGS_IDS.signalExitAllowMultipleTradesPerEventToggle, HTMLInputElement);
}

export function getPolymarketEntrySelectionModeSelect(): HTMLSelectElement | null {
  return getTypedElement(POLYMARKET_SETTINGS_IDS.entrySelectionModeSelect, HTMLSelectElement);
}

export function getPolymarketOutcomeIntervalSelect(): HTMLSelectElement | null {
  return getTypedElement(POLYMARKET_SETTINGS_IDS.outcomeIntervalSelect, HTMLSelectElement);
}

export function getPolymarketPostSignalLimitEntryToggle(): HTMLInputElement | null {
  return getTypedElement(POLYMARKET_SETTINGS_IDS.postSignalLimitEntryToggle, HTMLInputElement);
}

export function getPolymarketPostSignalLimitEntryModeSelect(): HTMLSelectElement | null {
  return getTypedElement(POLYMARKET_SETTINGS_IDS.postSignalLimitEntryModeSelect, HTMLSelectElement);
}

export function getPolymarketPostSignalLimitExitToggle(): HTMLInputElement | null {
  return getTypedElement(POLYMARKET_SETTINGS_IDS.postSignalLimitExitToggle, HTMLInputElement);
}

export function getPolymarketPostSignalLimitExitModeSelect(): HTMLSelectElement | null {
  return getTypedElement(POLYMARKET_SETTINGS_IDS.postSignalLimitExitModeSelect, HTMLSelectElement);
}

export function getExecutionModelSelect(): HTMLSelectElement | null {
  return getTypedElement(POLYMARKET_SETTINGS_IDS.executionModelSelect, HTMLSelectElement);
}

export function getPolymarketSettingsRows(): {
  outcomeIntervalRow: HTMLElement | null;
  entrySelectionModeRow: HTMLElement | null;
  offsetRow: HTMLElement | null;
  entryDelayBarsRow: HTMLElement | null;
  entryPriceFilterCentsRow: HTMLElement | null;
  backtestSlippageCentsRow: HTMLElement | null;
  exitModeRow: HTMLElement | null;
  signalExitAllowMultipleTradesPerEventRow: HTMLElement | null;
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
  return getElements(POLYMARKET_SETTINGS_ROW_IDS);
}

export function getFinderPolymarketRankModeSelect(): HTMLSelectElement | null {
  return getTypedElement(FINDER_POLYMARKET_IDS.finderRankMode, HTMLSelectElement);
}
