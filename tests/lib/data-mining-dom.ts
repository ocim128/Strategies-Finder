export const DATA_MINING_IDS = {
  tab: 'dataminingTab',
  pair: 'dataMiningPair',
  interval: 'dataMiningInterval',
  bars: 'dataMiningBars',
  provider: 'dataMiningProvider',
  rangeStart: 'dataMiningRangeStart',
  rangeEnd: 'dataMiningRangeEnd',
  lastUpdate: 'dataMiningLastUpdate',
  chartMode: 'dataMiningChartMode',
  status: 'dataMiningStatus',
  downloadCsv: 'dataMiningDownloadCsv',
  downloadJson: 'dataMiningDownloadJson',
  clearPriceDb: 'dataMiningClearPriceDb',
  symbolInput: 'dataMiningSymbolInput',
  intervalInput: 'dataMiningIntervalInput',
  barsInput: 'dataMiningBarsInput',
  fetchCsv: 'dataMiningFetchCsv',
  fetchJson: 'dataMiningFetchJson',
  importFile: 'dataMiningImportFile',
  importBtn: 'dataMiningImportBtn',
  synthBaseSymbol: 'dataMiningSynthBaseSymbol',
  synthQuoteSymbol: 'dataMiningSynthQuoteSymbol',
  synthInterval: 'dataMiningSynthInterval',
  synthDerived: 'dataMiningSynthDerived',
  synthGenerateBtn: 'dataMiningSynthGenerateBtn',
  diagnosticClear: 'dataMiningDiagnosticClear',
  diagnosticOutput: 'dataMiningDiagnosticOutput',
} as const;

export type DataMiningDom = {
  pairEl: HTMLElement | null;
  intervalEl: HTMLElement | null;
  barsEl: HTMLElement | null;
  providerEl: HTMLElement | null;
  rangeStartEl: HTMLElement | null;
  rangeEndEl: HTMLElement | null;
  lastUpdateEl: HTMLElement | null;
  chartModeEl: HTMLElement | null;
  statusEl: HTMLElement | null;
  downloadCsvButton: HTMLButtonElement | null;
  downloadJsonButton: HTMLButtonElement | null;
  clearPriceDbButton: HTMLButtonElement | null;
  symbolInput: HTMLInputElement | null;
  intervalInput: HTMLInputElement | null;
  barsInput: HTMLInputElement | null;
  fetchCsvButton: HTMLButtonElement | null;
  fetchJsonButton: HTMLButtonElement | null;
  importFileInput: HTMLInputElement | null;
  importButton: HTMLButtonElement | null;
  synthBaseSymbolInput: HTMLInputElement | null;
  synthQuoteSymbolInput: HTMLInputElement | null;
  synthIntervalInput: HTMLInputElement | null;
  synthDerivedEl: HTMLElement | null;
  synthGenerateButton: HTMLButtonElement | null;
  diagnosticClearButton: HTMLButtonElement | null;
  diagnosticOutputEl: HTMLElement | null;
};

export function queryDataMiningDom(): DataMiningDom | null {
  const tab = document.getElementById(DATA_MINING_IDS.tab);
  if (!tab) return null;

  return {
    pairEl: document.getElementById(DATA_MINING_IDS.pair),
    intervalEl: document.getElementById(DATA_MINING_IDS.interval),
    barsEl: document.getElementById(DATA_MINING_IDS.bars),
    providerEl: document.getElementById(DATA_MINING_IDS.provider),
    rangeStartEl: document.getElementById(DATA_MINING_IDS.rangeStart),
    rangeEndEl: document.getElementById(DATA_MINING_IDS.rangeEnd),
    lastUpdateEl: document.getElementById(DATA_MINING_IDS.lastUpdate),
    chartModeEl: document.getElementById(DATA_MINING_IDS.chartMode),
    statusEl: document.getElementById(DATA_MINING_IDS.status),
    downloadCsvButton: document.getElementById(DATA_MINING_IDS.downloadCsv) as HTMLButtonElement | null,
    downloadJsonButton: document.getElementById(DATA_MINING_IDS.downloadJson) as HTMLButtonElement | null,
    clearPriceDbButton: document.getElementById(DATA_MINING_IDS.clearPriceDb) as HTMLButtonElement | null,
    symbolInput: document.getElementById(DATA_MINING_IDS.symbolInput) as HTMLInputElement | null,
    intervalInput: document.getElementById(DATA_MINING_IDS.intervalInput) as HTMLInputElement | null,
    barsInput: document.getElementById(DATA_MINING_IDS.barsInput) as HTMLInputElement | null,
    fetchCsvButton: document.getElementById(DATA_MINING_IDS.fetchCsv) as HTMLButtonElement | null,
    fetchJsonButton: document.getElementById(DATA_MINING_IDS.fetchJson) as HTMLButtonElement | null,
    importFileInput: document.getElementById(DATA_MINING_IDS.importFile) as HTMLInputElement | null,
    importButton: document.getElementById(DATA_MINING_IDS.importBtn) as HTMLButtonElement | null,
    synthBaseSymbolInput: document.getElementById(DATA_MINING_IDS.synthBaseSymbol) as HTMLInputElement | null,
    synthQuoteSymbolInput: document.getElementById(DATA_MINING_IDS.synthQuoteSymbol) as HTMLInputElement | null,
    synthIntervalInput: document.getElementById(DATA_MINING_IDS.synthInterval) as HTMLInputElement | null,
    synthDerivedEl: document.getElementById(DATA_MINING_IDS.synthDerived),
    synthGenerateButton: document.getElementById(DATA_MINING_IDS.synthGenerateBtn) as HTMLButtonElement | null,
    diagnosticClearButton: document.getElementById(DATA_MINING_IDS.diagnosticClear) as HTMLButtonElement | null,
    diagnosticOutputEl: document.getElementById(DATA_MINING_IDS.diagnosticOutput),
  };
}
