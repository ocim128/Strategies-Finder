import type { Time } from "lightweight-charts";
import { state } from "./state";
import { setCurrentInterval, setCurrentSymbol } from "./state-actions";
import { uiManager } from "./ui-manager";
import { dataManager } from "./data-manager";
import { SYMBOL_MAP } from "./constants";
import { debugLogger } from "./debug-logger";
import { clearAll } from "./app-actions";
import { commitOhlcvData } from "./state-actions";
import { OHLCVData, HistoricalFetchProgress } from "./types/index";

import { parseTimeToUnixSeconds } from "./time-normalization";
import { formatPolymarketDisplayName, parsePolymarketEventInput } from "./dataProviders/polymarket";
import { queryDataMiningDom, type DataMiningDom } from "./data-mining-dom";

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

    private dom: DataMiningDom | null = null;
    private lastUpdatedAt: number | null = null;
    private isFetching = false;
    private isImporting = false;
    private lastSymbolValue: string | null = null;
    private lastIntervalValue: string | null = null;

    private isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    public init(): void {
        const dom = queryDataMiningDom();
        if (!dom) return;
        this.dom = dom;

        this.bindActions();
        this.subscribeState();
        this.updateAll();
    }

    private bindActions(): void {
        this.dom?.downloadCsvButton?.addEventListener('click', () => this.downloadCsv());
        this.dom?.downloadJsonButton?.addEventListener('click', () => this.downloadJson());
        this.dom?.fetchCsvButton?.addEventListener('click', () => this.fetchAndStoreSqlite());
        this.dom?.fetchJsonButton?.addEventListener('click', () => this.fetchHistorical('json'));
        this.dom?.importButton?.addEventListener('click', () => this.importJsonFile());
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
        const dom = this.dom;
        if (!dom) return;

        if (dom.pairEl) {
            dom.pairEl.textContent = this.formatSymbolDisplay(state.currentSymbol);
        }
        if (dom.intervalEl) {
            dom.intervalEl.textContent = state.currentInterval.toUpperCase();
        }
        if (dom.providerEl) {
            dom.providerEl.textContent = this.getProviderLabel(state.currentSymbol);
        }
        if (dom.symbolInput) {
            if (!dom.symbolInput.value || dom.symbolInput.value === this.lastSymbolValue) {
                dom.symbolInput.value = state.currentSymbol;
            }
            this.lastSymbolValue = state.currentSymbol;
        }
        if (dom.intervalInput) {
            if (!dom.intervalInput.value || dom.intervalInput.value === this.lastIntervalValue) {
                dom.intervalInput.value = state.currentInterval;
            }
            this.lastIntervalValue = state.currentInterval;
        }
    }

    private updateDataset(): void {
        const dom = this.dom;
        if (!dom) return;

        const data = state.ohlcvData;
        const bars = data.length;

        if (dom.barsEl) {
            dom.barsEl.textContent = bars.toLocaleString();
        }

        if (bars === 0) {
            this.setText(dom.rangeStartEl, '--');
            this.setText(dom.rangeEndEl, '--');
            this.setText(dom.lastUpdateEl, '--');
            this.setStatus('No data loaded.', 'warning');
            return;
        }

        const first = data[0];
        const last = data[data.length - 1];
        const startLabel = uiManager.formatDate(first.time);
        const endLabel = uiManager.formatDate(last.time);

        this.setText(dom.rangeStartEl, startLabel);
        this.setText(dom.rangeEndEl, endLabel);

        if (!this.lastUpdatedAt) {
            this.lastUpdatedAt = Date.now();
        }
        if (dom.lastUpdateEl) {
            const label = this.lastUpdatedAt ? new Date(this.lastUpdatedAt).toLocaleString() : 'Ready';
            dom.lastUpdateEl.textContent = label;
        }

        this.setStatus(`Loaded ${bars.toLocaleString()} bars.`, 'success');
    }

    private updateChartMode(): void {
        if (!this.dom?.chartModeEl) return;
        this.dom.chartModeEl.textContent = state.chartMode === 'heikin-ashi' ? 'Heikin Ashi' : 'Candlestick';
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

    private async fetchHistorical(format: 'csv' | 'json'): Promise<void> {
        if (this.isFetching) return;

        const request = this.getHistoricalRequest();
        if (!request) return;

        const { symbol, interval, bars } = request;
        const provider = dataManager.getProvider(symbol);
        if (provider !== 'binance' && provider !== 'binance-futures' && provider !== 'bybit-tradfi' && provider !== 'polymarket') {
            uiManager.showToast('Historical bulk download is supported for Binance / Bybit TradFi / Polymarket symbols only.', 'error');
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
            debugLogger.error('data_mining.historical_download_failed', {
                error: error instanceof Error ? error.message : String(error),
            });
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
        const provider = dataManager.getProvider(symbol);
        if (provider !== 'binance' && provider !== 'binance-futures' && provider !== 'bybit-tradfi' && provider !== 'polymarket') {
            uiManager.showToast('Historical SQLite sync is supported for Binance / Bybit TradFi / Polymarket symbols only.', 'error');
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
            dataManager.invalidateCacheEntry(symbol, interval);
        } catch (error) {
            debugLogger.error('data_mining.sqlite_sync_failed', {
                error: error instanceof Error ? error.message : String(error),
            });
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
        const parsed = parseTimeToUnixSeconds(time);
        if (parsed === null) {
            throw new Error(`Cannot export candle with invalid time: ${String(time)}`);
        }
        return parsed;
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
        const polymarketLabel = formatPolymarketDisplayName(symbol);
        if (polymarketLabel) return polymarketLabel;

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

        const provider = dataManager.getProvider(symbol);
        if (provider === 'binance') return 'Binance Spot';
        if (provider === 'binance-futures') return 'Binance Futures';
        if (provider === 'bybit-tradfi') return 'Bybit TradFi';
        if (provider === 'polymarket') return 'Polymarket';
        if (provider === 'local-daily') return 'Local Daily';

        if (provider === 'mock') return 'Mock';
        return provider;
    }

    private getHistoricalRequest(): { symbol: string; interval: string; bars: number } | null {
        const rawSymbol = this.dom?.symbolInput?.value?.trim() || state.currentSymbol;
        const parsedPolymarket = parsePolymarketEventInput(rawSymbol);
        const symbol = parsedPolymarket?.canonicalSymbol ?? rawSymbol;
        const interval = this.dom?.intervalInput?.value?.trim() || state.currentInterval;
        const barsRaw = this.dom?.barsInput?.value?.trim() ?? '';
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
        if (this.dom?.fetchCsvButton) this.dom.fetchCsvButton.disabled = disabled;
        if (this.dom?.fetchJsonButton) this.dom.fetchJsonButton.disabled = disabled;
    }

    private setText(element: HTMLElement | null, value: string): void {
        if (element) element.textContent = value;
    }

    private setStatus(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
        if (!this.dom?.statusEl) return;
        this.dom.statusEl.textContent = message;
        this.dom.statusEl.className = `data-mining-status ${type}`;
    }

    private async importJsonFile(): Promise<void> {
        if (this.isImporting) return;
        const file = this.dom?.importFileInput?.files?.[0];
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
            const parsed: unknown = JSON.parse(text);
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
                setCurrentSymbol(symbol);
            }
            if (intervalChanged && interval) {
                setCurrentInterval(interval);
            }
            commitOhlcvData(bars, 'data_mining_import');
            dataManager.registerImportedData(state.currentSymbol, state.currentInterval, bars);

            const metaNote = meta ? ` (${meta})` : '';
            this.setStatus(`Loaded ${bars.length.toLocaleString()} bars from JSON${metaNote}.`, 'success');
            debugLogger.event('data.import', { bars: bars.length });
        } catch (error) {
            debugLogger.error('data_mining.import_failed', {
                error: error instanceof Error ? error.message : String(error),
            });
            uiManager.showToast('Failed to import JSON data.', 'error');
            this.setStatus('Failed to import JSON data.', 'error');
        } finally {
            this.isImporting = false;
            this.toggleImportButton(false);
        }
    }

    private extractBarsFromJson(payload: unknown): {
        bars: OHLCVData[];
        meta: string | null;
        symbol: string | null;
        interval: string | null;
    } {
        let rawData: unknown[] = [];
        let meta: string | null = null;
        let symbol: string | null = null;
        let interval: string | null = null;

        if (this.isRecord(payload) && typeof payload.symbol === 'string') {
            const value = payload.symbol.trim();
            symbol = value.length > 0 ? value : null;
        }
        if (this.isRecord(payload) && typeof payload.interval === 'string') {
            const value = payload.interval.trim();
            interval = value.length > 0 ? value : null;
        }

        if (Array.isArray(payload)) {
            rawData = payload;
        } else if (this.isRecord(payload) && Array.isArray(payload.data)) {
            rawData = payload.data;
            if (symbol || interval) {
                meta = `${symbol ?? 'unknown'} ${interval ?? ''}`.trim();
            }
        } else if (this.isRecord(payload) && Array.isArray(payload.ohlcv)) {
            rawData = payload.ohlcv;
        } else if (this.isRecord(payload) && Array.isArray(payload.candles)) {
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

    private parseBar(row: unknown): OHLCVData | null {
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

        if (this.isRecord(row)) {
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

    private normalizeTime(value: unknown): number | null {
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
        if (this.dom?.importButton) this.dom.importButton.disabled = disabled;
    }
}

export const dataMiningManager = new DataMiningManager();
