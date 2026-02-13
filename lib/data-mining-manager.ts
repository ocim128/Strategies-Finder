import { Time } from "lightweight-charts";
import { state } from "./state";
import { uiManager } from "./ui-manager";
import { assetSearchService } from "./asset-search-service";
import { dataManager } from "./data-manager";
import { SYMBOL_MAP } from "./constants";
import { debugLogger } from "./debug-logger";
import { clearAll } from "./app-actions";
import { OHLCVData, HistoricalFetchProgress } from "./types/index";
import { buildFeatureLabDataset, buildFeatureLabMetadata, buildFeatureLabVerdictReport } from "./featureLab/featureLabService";
import { parseTimeToUnixSeconds } from "./time-normalization";

interface NormalizedCandle {
    time: number;
    datetime: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export class DataMiningManager {
    private readonly SQLITE_STORE_CHUNK_SIZE = 5000;

    private pairEl: HTMLElement | null = null;
    private intervalEl: HTMLElement | null = null;
    private barsEl: HTMLElement | null = null;
    private providerEl: HTMLElement | null = null;
    private rangeStartEl: HTMLElement | null = null;
    private rangeEndEl: HTMLElement | null = null;
    private lastUpdateEl: HTMLElement | null = null;
    private chartModeEl: HTMLElement | null = null;
    private statusEl: HTMLElement | null = null;
    private downloadCsvButton: HTMLButtonElement | null = null;
    private downloadJsonButton: HTMLButtonElement | null = null;
    private exportFeatureDatasetButton: HTMLButtonElement | null = null;
    private exportVerdictReportButton: HTMLButtonElement | null = null;
    private symbolInput: HTMLInputElement | null = null;
    private intervalInput: HTMLInputElement | null = null;
    private barsInput: HTMLInputElement | null = null;
    private fetchCsvButton: HTMLButtonElement | null = null;
    private fetchJsonButton: HTMLButtonElement | null = null;
    private importFileInput: HTMLInputElement | null = null;
    private importButton: HTMLButtonElement | null = null;
    private lastUpdatedAt: number | null = null;
    private isFetching = false;
    private isImporting = false;
    private lastSymbolValue: string | null = null;
    private lastIntervalValue: string | null = null;

    public init(): void {
        const tab = document.getElementById('dataminingTab');
        if (!tab) return;

        this.pairEl = document.getElementById('dataMiningPair');
        this.intervalEl = document.getElementById('dataMiningInterval');
        this.barsEl = document.getElementById('dataMiningBars');
        this.providerEl = document.getElementById('dataMiningProvider');
        this.rangeStartEl = document.getElementById('dataMiningRangeStart');
        this.rangeEndEl = document.getElementById('dataMiningRangeEnd');
        this.lastUpdateEl = document.getElementById('dataMiningLastUpdate');
        this.chartModeEl = document.getElementById('dataMiningChartMode');
        this.statusEl = document.getElementById('dataMiningStatus');
        this.downloadCsvButton = document.getElementById('dataMiningDownloadCsv') as HTMLButtonElement | null;
        this.downloadJsonButton = document.getElementById('dataMiningDownloadJson') as HTMLButtonElement | null;
        this.exportFeatureDatasetButton = document.getElementById('dataMiningExportFeatures') as HTMLButtonElement | null;
        this.exportVerdictReportButton = document.getElementById('dataMiningExportVerdict') as HTMLButtonElement | null;
        this.symbolInput = document.getElementById('dataMiningSymbolInput') as HTMLInputElement | null;
        this.intervalInput = document.getElementById('dataMiningIntervalInput') as HTMLInputElement | null;
        this.barsInput = document.getElementById('dataMiningBarsInput') as HTMLInputElement | null;
        this.fetchCsvButton = document.getElementById('dataMiningFetchCsv') as HTMLButtonElement | null;
        this.fetchJsonButton = document.getElementById('dataMiningFetchJson') as HTMLButtonElement | null;
        this.importFileInput = document.getElementById('dataMiningImportFile') as HTMLInputElement | null;
        this.importButton = document.getElementById('dataMiningImportBtn') as HTMLButtonElement | null;

        this.bindActions();
        this.subscribeState();
        this.updateAll();
    }

    private bindActions(): void {
        this.downloadCsvButton?.addEventListener('click', () => this.downloadCsv());
        this.downloadJsonButton?.addEventListener('click', () => this.downloadJson());
        this.exportFeatureDatasetButton?.addEventListener('click', () => this.exportFeatureDataset());
        this.exportVerdictReportButton?.addEventListener('click', () => this.exportVerdictReport());
        this.fetchCsvButton?.addEventListener('click', () => this.fetchAndStoreSqlite());
        this.fetchJsonButton?.addEventListener('click', () => this.fetchHistorical('json'));
        this.importButton?.addEventListener('click', () => this.importJsonFile());
    }

    private subscribeState(): void {
        state.subscribe('ohlcvData', () => {
            this.lastUpdatedAt = Date.now();
            this.updateDataset();
        });
        state.subscribe('currentSymbol', () => this.updateStatic());
        state.subscribe('currentInterval', () => this.updateStatic());
        state.subscribe('chartMode', () => this.updateChartMode());
    }

    private updateAll(): void {
        this.updateStatic();
        this.updateDataset();
        this.updateChartMode();
    }

    private updateStatic(): void {
        if (this.pairEl) {
            this.pairEl.textContent = this.formatSymbolDisplay(state.currentSymbol);
        }
        if (this.intervalEl) {
            this.intervalEl.textContent = state.currentInterval.toUpperCase();
        }
        if (this.providerEl) {
            this.providerEl.textContent = this.getProviderLabel(state.currentSymbol);
        }
        if (this.symbolInput) {
            if (!this.symbolInput.value || this.symbolInput.value === this.lastSymbolValue) {
                this.symbolInput.value = state.currentSymbol;
            }
            this.lastSymbolValue = state.currentSymbol;
        }
        if (this.intervalInput) {
            if (!this.intervalInput.value || this.intervalInput.value === this.lastIntervalValue) {
                this.intervalInput.value = state.currentInterval;
            }
            this.lastIntervalValue = state.currentInterval;
        }
    }

    private updateDataset(): void {
        const data = state.ohlcvData;
        const bars = data.length;

        if (this.barsEl) {
            this.barsEl.textContent = bars.toLocaleString();
        }

        if (bars === 0) {
            this.setText(this.rangeStartEl, '--');
            this.setText(this.rangeEndEl, '--');
            this.setText(this.lastUpdateEl, '--');
            this.setStatus('No data loaded.', 'warning');
            return;
        }

        const first = data[0];
        const last = data[data.length - 1];
        const startLabel = uiManager.formatDate(first.time);
        const endLabel = uiManager.formatDate(last.time);

        this.setText(this.rangeStartEl, startLabel);
        this.setText(this.rangeEndEl, endLabel);

        if (!this.lastUpdatedAt) {
            this.lastUpdatedAt = Date.now();
        }
        if (this.lastUpdateEl) {
            const label = this.lastUpdatedAt ? new Date(this.lastUpdatedAt).toLocaleString() : 'Ready';
            this.lastUpdateEl.textContent = label;
        }

        this.setStatus(`Loaded ${bars.toLocaleString()} bars.`, 'success');
    }

    private updateChartMode(): void {
        if (!this.chartModeEl) return;
        this.chartModeEl.textContent = state.chartMode === 'heikin-ashi' ? 'Heikin Ashi' : 'Candlestick';
    }

    private downloadCsv(): void {
        if (!this.ensureDataReady()) return;

        const normalized = this.normalizeData(state.ohlcvData);
        const header = 'time,datetime,open,high,low,close,volume';
        const rows = normalized.map(row => (
            `${row.time},${row.datetime},${row.open},${row.high},${row.low},${row.close},${row.volume}`
        ));
        const content = [header, ...rows].join('\n');

        this.triggerDownload(content, 'text/csv', 'csv');
        this.setStatus('CSV download prepared.', 'success');
    }

    private downloadJson(): void {
        if (!this.ensureDataReady()) return;

        const normalized = this.normalizeData(state.ohlcvData);
        const payload = {
            symbol: state.currentSymbol,
            interval: state.currentInterval,
            provider: this.getProviderLabel(state.currentSymbol),
            bars: normalized.length,
            range: {
                start: normalized[0]?.datetime ?? null,
                end: normalized[normalized.length - 1]?.datetime ?? null,
            },
            generatedAt: new Date().toISOString(),
            data: normalized,
        };

        const content = JSON.stringify(payload, null, 2);
        this.triggerDownload(content, 'application/json', 'json');
        this.setStatus('JSON download prepared.', 'success');
    }

    private exportFeatureDataset(): void {
        if (!this.ensureDataReady()) return;

        try {
            const dataset = buildFeatureLabDataset(state.ohlcvData);
            if (dataset.rows.length === 0) {
                uiManager.showToast('Not enough valid data to build feature dataset.', 'error');
                this.setStatus('Feature export skipped: insufficient valid rows.', 'warning');
                return;
            }

            const metadata = buildFeatureLabMetadata(dataset, state.currentSymbol, state.currentInterval);
            const content = JSON.stringify({
                metadata,
                rows: dataset.rows,
            }, null, 2);
            this.triggerDownload(
                content,
                'application/json',
                'json',
                state.currentSymbol,
                state.currentInterval,
                dataset.rows.length,
                'features_labels'
            );
            this.setStatus(`Feature dataset exported as JSON (${dataset.rows.length.toLocaleString()} rows).`, 'success');
            debugLogger.event('featureLab.export.dataset', {
                sourceBars: dataset.sourceBars,
                rows: dataset.rows.length,
                format: 'json',
            });
        } catch (error) {
            console.error('Feature dataset export failed:', error);
            uiManager.showToast('Feature dataset export failed. See console for details.', 'error');
            this.setStatus('Feature dataset export failed.', 'error');
        }
    }

    private exportVerdictReport(): void {
        if (!this.ensureDataReady()) return;

        try {
            const dataset = buildFeatureLabDataset(state.ohlcvData);
            if (dataset.rows.length === 0) {
                uiManager.showToast('Not enough valid data to build verdict report.', 'error');
                this.setStatus('Verdict export skipped: insufficient valid rows.', 'warning');
                return;
            }

            const report = buildFeatureLabVerdictReport(dataset.rows);
            const content = JSON.stringify({
                symbol: state.currentSymbol,
                interval: state.currentInterval,
                sourceBars: dataset.sourceBars,
                analyzedRows: dataset.rows.length,
                featureConfig: dataset.config,
                report,
            }, null, 2);

            this.triggerDownload(
                content,
                'application/json',
                'json',
                state.currentSymbol,
                state.currentInterval,
                dataset.rows.length,
                'verdict'
            );
            this.setStatus('Verdict report exported.', 'success');
            debugLogger.event('featureLab.export.verdict', {
                sourceBars: dataset.sourceBars,
                rows: dataset.rows.length,
                longTopBins: report.longTopBins.length,
                shortTopBins: report.shortTopBins.length,
            });
        } catch (error) {
            console.error('Verdict report export failed:', error);
            uiManager.showToast('Verdict export failed. See console for details.', 'error');
            this.setStatus('Verdict report export failed.', 'error');
        }
    }

    private async fetchHistorical(format: 'csv' | 'json'): Promise<void> {
        if (this.isFetching) return;

        const request = this.getHistoricalRequest();
        if (!request) return;

        const { symbol, interval, bars } = request;
        const provider = assetSearchService.getProvider(symbol);
        if (provider !== 'binance' && provider !== 'bybit-tradfi') {
            uiManager.showToast('Historical bulk download is supported for Binance / Bybit TradFi symbols only.', 'error');
            this.setStatus('Historical download not supported for this provider.', 'error');
            return;
        }

        this.isFetching = true;
        this.toggleHistoricalButtons(true);
        this.setStatus(`Fetching ${bars.toLocaleString()} bars (${interval})...`, 'info');

        try {
            const data = await dataManager.fetchHistoricalData(symbol, interval, bars, {
                requestDelayMs: 120,
                onProgress: ({ fetched, total, requestCount }: HistoricalFetchProgress) => {
                    const pct = total > 0 ? Math.min(100, Math.round((fetched / total) * 100)) : 0;
                    this.setStatus(`Downloading... ${fetched.toLocaleString()} / ${total.toLocaleString()} bars (${pct}%, ${requestCount} requests)`, 'info');
                },
            });

            if (data.length === 0) {
                uiManager.showToast('No historical data returned.', 'error');
                this.setStatus('No historical data returned.', 'error');
                return;
            }

            const normalized = this.normalizeData(data);
            if (format === 'csv') {
                const header = 'time,datetime,open,high,low,close,volume';
                const rows = normalized.map(row => (
                    `${row.time},${row.datetime},${row.open},${row.high},${row.low},${row.close},${row.volume}`
                ));
                const content = [header, ...rows].join('\n');
                this.triggerDownload(content, 'text/csv', 'csv', symbol, interval, normalized.length);
                this.setStatus('Historical CSV download prepared.', 'success');
            } else {
                const payload = {
                    symbol,
                    interval,
                    provider: this.getProviderLabel(symbol),
                    bars: normalized.length,
                    range: {
                        start: normalized[0]?.datetime ?? null,
                        end: normalized[normalized.length - 1]?.datetime ?? null,
                    },
                    generatedAt: new Date().toISOString(),
                    data: normalized,
                };
                const content = JSON.stringify(payload, null, 2);
                this.triggerDownload(content, 'application/json', 'json', symbol, interval, normalized.length);
                this.setStatus('Historical JSON download prepared.', 'success');
            }
        } catch (error) {
            console.error('Historical download failed:', error);
            uiManager.showToast('Historical download failed. See console for details.', 'error');
            this.setStatus('Historical download failed.', 'error');
        } finally {
            this.isFetching = false;
            this.toggleHistoricalButtons(false);
        }
    }

    private async fetchAndStoreSqlite(): Promise<void> {
        if (this.isFetching) return;

        const request = this.getHistoricalRequest();
        if (!request) return;

        const { symbol, interval, bars } = request;
        const provider = assetSearchService.getProvider(symbol);
        if (provider !== 'binance' && provider !== 'bybit-tradfi') {
            uiManager.showToast('Historical SQLite sync is supported for Binance / Bybit TradFi symbols only.', 'error');
            this.setStatus('SQLite sync not supported for this provider.', 'error');
            return;
        }

        this.isFetching = true;
        this.toggleHistoricalButtons(true);
        this.setStatus(`Fetching ${bars.toLocaleString()} bars (${interval})...`, 'info');

        try {
            const data = await dataManager.fetchHistoricalData(symbol, interval, bars, {
                requestDelayMs: 120,
                onProgress: ({ fetched, total, requestCount }: HistoricalFetchProgress) => {
                    const pct = total > 0 ? Math.min(100, Math.round((fetched / total) * 100)) : 0;
                    this.setStatus(`Fetching... ${fetched.toLocaleString()} / ${total.toLocaleString()} bars (${pct}%, ${requestCount} requests)`, 'info');
                },
            });

            if (data.length === 0) {
                uiManager.showToast('No historical data returned.', 'error');
                this.setStatus('No historical data returned.', 'error');
                return;
            }

            this.setStatus(`Storing ${data.length.toLocaleString()} bars to SQLite...`, 'info');
            const payload = await this.storeHistoricalToSqlite(
                symbol,
                interval,
                this.getProviderLabel(symbol),
                data,
                ({ chunkIndex, totalChunks, storedBars, totalBars }) => {
                    this.setStatus(
                        `Storing... chunk ${chunkIndex}/${totalChunks} (${storedBars.toLocaleString()} / ${totalBars.toLocaleString()} bars)`,
                        'info'
                    );
                }
            );
            this.setStatus(
                `SQLite updated: ${payload.upserted.toLocaleString()} bars written (${payload.totalBars.toLocaleString()} total in series).`,
                'success'
            );
            uiManager.showToast(`Stored to SQLite: ${payload.dbPath}`, 'success');
        } catch (error) {
            console.error('Historical SQLite sync failed:', error);
            uiManager.showToast('Historical SQLite sync failed. See console for details.', 'error');
            this.setStatus('Historical SQLite sync failed.', 'error');
        } finally {
            this.isFetching = false;
            this.toggleHistoricalButtons(false);
        }
    }

    private async storeHistoricalToSqlite(
        symbol: string,
        interval: string,
        providerLabel: string,
        data: OHLCVData[],
        onProgress?: (progress: {
            chunkIndex: number;
            totalChunks: number;
            chunkBars: number;
            storedBars: number;
            totalBars: number;
        }) => void
    ): Promise<{ upserted: number; totalBars: number; dbPath: string }> {
        const candles = this.normalizeData(data).map((row) => ({
            time: row.time,
            open: row.open,
            high: row.high,
            low: row.low,
            close: row.close,
            volume: row.volume,
        }));

        if (candles.length === 0) {
            return {
                upserted: 0,
                totalBars: 0,
                dbPath: 'price-data/market-data.sqlite',
            };
        }

        const chunkSize = Math.max(1, Math.floor(this.SQLITE_STORE_CHUNK_SIZE));
        const totalBars = candles.length;
        const totalChunks = Math.ceil(totalBars / chunkSize);
        let totalUpserted = 0;
        let seriesTotalBars = 0;
        let dbPath = 'price-data/market-data.sqlite';

        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
            const start = chunkIndex * chunkSize;
            const end = Math.min(start + chunkSize, totalBars);
            const chunk = candles.slice(start, end);

            onProgress?.({
                chunkIndex: chunkIndex + 1,
                totalChunks,
                chunkBars: chunk.length,
                storedBars: end,
                totalBars,
            });

            const response = await fetch('/api/sqlite/store-ohlcv', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    symbol,
                    interval,
                    provider: providerLabel,
                    source: 'data-menu-fetch',
                    candles: chunk,
                }),
            });

            const payload = await response.json() as {
                ok?: boolean;
                upserted?: number;
                totalBars?: number;
                dbPath?: string;
                error?: string;
            };

            if (!response.ok || !payload?.ok) {
                throw new Error(payload?.error || `SQLite store failed (${response.status})`);
            }

            totalUpserted += Math.max(0, Number(payload.upserted) || chunk.length);
            seriesTotalBars = Math.max(0, Number(payload.totalBars) || seriesTotalBars);
            dbPath = payload.dbPath || dbPath;
        }

        return {
            upserted: totalUpserted,
            totalBars: seriesTotalBars || totalBars,
            dbPath,
        };
    }

    private ensureDataReady(): boolean {
        if (state.ohlcvData.length === 0) {
            uiManager.showToast('No data loaded to export.', 'error');
            this.setStatus('No data loaded to export.', 'error');
            return false;
        }
        return true;
    }

    private normalizeData(data: typeof state.ohlcvData): NormalizedCandle[] {
        return data.map((bar) => {
            const time = this.toUnixSeconds(bar.time);
            return {
                time,
                datetime: new Date(time * 1000).toISOString(),
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: bar.volume ?? 0,
            };
        });
    }

    private toUnixSeconds(time: Time): number {
        if (typeof time === 'number') return time;
        if (typeof time === 'string') {
            const parsed = Date.parse(time);
            if (Number.isFinite(parsed)) {
                return Math.floor(parsed / 1000);
            }
        }
        if (typeof time === 'object' && time && 'year' in time) {
            return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000);
        }
        return Math.floor(Date.now() / 1000);
    }

    private triggerDownload(
        content: string,
        mime: string,
        extension: string,
        symbol: string = state.currentSymbol,
        interval: string = state.currentInterval,
        bars: number = state.ohlcvData.length,
        prefix: string = 'data'
    ): void {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = this.buildFilename(extension, symbol, interval, bars, prefix);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        debugLogger.event('data.export', { extension, bars, prefix });
    }

    private buildFilename(extension: string, symbol: string, interval: string, bars: number, prefix: string): string {
        const safeSymbol = symbol.replace(/[^a-z0-9_-]+/gi, '-');
        const safeInterval = interval.replace(/[^a-z0-9_-]+/gi, '-');
        const safePrefix = prefix.replace(/[^a-z0-9_-]+/gi, '-');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        return `${safePrefix}-${safeSymbol}-${safeInterval}-${bars}bars-${stamp}.${extension}`;
    }

    private formatSymbolDisplay(symbol: string): string {
        const mapped = SYMBOL_MAP[symbol];
        if (mapped) return mapped;

        if (symbol.endsWith('USDT')) return `${symbol.slice(0, -4)}/USDT`;
        if (symbol.endsWith('BUSD')) return `${symbol.slice(0, -4)}/BUSD`;
        if (symbol.endsWith('BTC')) return `${symbol.slice(0, -3)}/BTC`;
        if (symbol.endsWith('ETH')) return `${symbol.slice(0, -3)}/ETH`;
        if (symbol.endsWith('BNB')) return `${symbol.slice(0, -3)}/BNB`;
        if (symbol.endsWith('+')) {
            const base = symbol.slice(0, -1);
            return /^[A-Z]{6}$/.test(base)
                ? `${base.slice(0, 3)}/${base.slice(3, 6)}`
                : base;
        }
        if (symbol.toUpperCase().endsWith('.S')) return symbol.slice(0, -2);

        return symbol;
    }

    private getProviderLabel(symbol: string): string {
        if (dataManager.isMockSymbol(symbol)) return 'Mock';

        const provider = assetSearchService.getProvider(symbol);
        if (provider === 'binance') return 'Binance';
        if (provider === 'bybit-tradfi') return 'Bybit TradFi';

        if (provider === 'mock') return 'Mock';
        return provider;
    }

    private getHistoricalRequest(): { symbol: string; interval: string; bars: number } | null {
        const symbol = this.symbolInput?.value?.trim() || state.currentSymbol;
        const interval = this.intervalInput?.value?.trim() || state.currentInterval;
        const barsRaw = this.barsInput?.value?.trim() ?? '';
        const bars = Math.floor(Number(barsRaw));

        if (!symbol) {
            uiManager.showToast('Symbol is required.', 'error');
            this.setStatus('Symbol is required.', 'error');
            return null;
        }

        if (!interval) {
            uiManager.showToast('Interval is required (e.g., 1m).', 'error');
            this.setStatus('Interval is required.', 'error');
            return null;
        }

        if (!Number.isFinite(bars) || bars <= 0) {
            uiManager.showToast('Enter a valid bar count.', 'error');
            this.setStatus('Enter a valid bar count.', 'error');
            return null;
        }

        return { symbol, interval, bars };
    }

    private toggleHistoricalButtons(disabled: boolean): void {
        if (this.fetchCsvButton) this.fetchCsvButton.disabled = disabled;
        if (this.fetchJsonButton) this.fetchJsonButton.disabled = disabled;
    }

    private setText(element: HTMLElement | null, value: string): void {
        if (element) element.textContent = value;
    }

    private setStatus(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
        if (!this.statusEl) return;
        this.statusEl.textContent = message;
        this.statusEl.className = `data-mining-status ${type}`;
    }

    private async importJsonFile(): Promise<void> {
        if (this.isImporting) return;
        const file = this.importFileInput?.files?.[0];
        if (!file) {
            uiManager.showToast('Select a JSON file to import.', 'error');
            this.setStatus('Select a JSON file to import.', 'error');
            return;
        }

        this.isImporting = true;
        this.toggleImportButton(true);
        this.setStatus(`Loading ${file.name}...`, 'info');

        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            const { bars, meta, symbol, interval } = this.extractBarsFromJson(parsed);

            if (bars.length === 0) {
                uiManager.showToast('No valid candles found in JSON.', 'error');
                this.setStatus('No valid candles found in JSON.', 'error');
                return;
            }

            dataManager.stopStreaming();
            clearAll();
            const symbolChanged = Boolean(symbol && symbol !== state.currentSymbol);
            const intervalChanged = Boolean(interval && interval !== state.currentInterval);
            if (symbolChanged || intervalChanged) {
                dataManager.suppressNextAutoReload();
            }

            if (symbolChanged && symbol) {
                state.set('currentSymbol', symbol);
            }
            if (intervalChanged && interval) {
                state.set('currentInterval', interval);
            }
            state.set('ohlcvData', bars);

            const metaNote = meta ? ` (${meta})` : '';
            this.setStatus(`Loaded ${bars.length.toLocaleString()} bars from JSON${metaNote}.`, 'success');
            debugLogger.event('data.import', { bars: bars.length });
        } catch (error) {
            console.error('JSON import failed:', error);
            uiManager.showToast('Failed to import JSON data.', 'error');
            this.setStatus('Failed to import JSON data.', 'error');
        } finally {
            this.isImporting = false;
            this.toggleImportButton(false);
        }
    }

    private extractBarsFromJson(payload: any): {
        bars: OHLCVData[];
        meta: string | null;
        symbol: string | null;
        interval: string | null;
    } {
        let rawData: any[] = [];
        let meta: string | null = null;
        let symbol: string | null = null;
        let interval: string | null = null;

        if (payload && typeof payload.symbol === 'string') {
            const value = payload.symbol.trim();
            symbol = value.length > 0 ? value : null;
        }
        if (payload && typeof payload.interval === 'string') {
            const value = payload.interval.trim();
            interval = value.length > 0 ? value : null;
        }

        if (Array.isArray(payload)) {
            rawData = payload;
        } else if (payload && Array.isArray(payload.data)) {
            rawData = payload.data;
            if (symbol || interval) {
                meta = `${symbol ?? 'unknown'} ${interval ?? ''}`.trim();
            }
        } else if (payload && Array.isArray(payload.ohlcv)) {
            rawData = payload.ohlcv;
        } else if (payload && Array.isArray(payload.candles)) {
            rawData = payload.candles;
        }

        if (!meta && (symbol || interval)) {
            meta = `${symbol ?? 'unknown'} ${interval ?? ''}`.trim();
        }

        const bars = rawData
            .map((row) => this.parseBar(row))
            .filter((bar): bar is OHLCVData => !!bar)
            .sort((a, b) => Number(a.time) - Number(b.time));

        const deduped: OHLCVData[] = [];
        for (const bar of bars) {
            const last = deduped[deduped.length - 1];
            if (last && last.time === bar.time) {
                deduped[deduped.length - 1] = bar;
            } else {
                deduped.push(bar);
            }
        }

        return { bars: deduped, meta, symbol, interval };
    }

    private parseBar(row: any): OHLCVData | null {
        if (!row) return null;

        if (Array.isArray(row)) {
            if (row.length < 5) return null;
            const time = this.normalizeTime(row[0]);
            const open = Number(row[1]);
            const high = Number(row[2]);
            const low = Number(row[3]);
            const close = Number(row[4]);
            const volume = row.length > 5 ? Number(row[5]) : 0;
            return this.buildBar(time, open, high, low, close, volume);
        }

        if (typeof row === 'object') {
            const timeRaw =
                row.time ??
                row.t ??
                row.timestamp ??
                row.date ??
                row.datetime ??
                row.start ??
                row.openTime;
            const open = Number(row.open ?? row.o);
            const high = Number(row.high ?? row.h);
            const low = Number(row.low ?? row.l);
            const close = Number(row.close ?? row.c);
            const volume = Number(row.volume ?? row.v ?? 0);
            const time = this.normalizeTime(timeRaw ?? row.datetime);
            return this.buildBar(time, open, high, low, close, volume);
        }

        return null;
    }

    private normalizeTime(value: any): number | null {
        return parseTimeToUnixSeconds(value);
    }

    private buildBar(
        time: number | null,
        open: number,
        high: number,
        low: number,
        close: number,
        volume: number
    ): OHLCVData | null {
        if (!Number.isFinite(time) || time === null) return null;
        if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
            return null;
        }

        return {
            time: time as Time,
            open,
            high,
            low,
            close,
            volume: Number.isFinite(volume) ? volume : 0,
        };
    }

    private toggleImportButton(disabled: boolean): void {
        if (this.importButton) this.importButton.disabled = disabled;
    }
}

export const dataMiningManager = new DataMiningManager();
