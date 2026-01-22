import { Time } from "lightweight-charts";
import { OHLCVData } from "./strategies/index";
import { resampleOHLCV } from "./strategies/resample-utils";
import { state, type MockChartModel } from "./state";
import { debugLogger } from "./debugLogger";

/**
 * Binance API Kline data format:
 * [
 *   0: Open time,
 *   1: Open,
 *   2: High,
 *   3: Low,
 *   4: Close,
 *   5: Volume,
 *   ...
 * ]
 */
type BinanceKline = [number, string, string, string, string, string, ...any[]];

type MockChartConfig = {
    barsCount: number;
    volatility: number;
    startPrice: number;
    intervalSeconds: number;
};

export class DataManager {
    private readonly LIMIT_PER_REQUEST = 1000;
    private readonly TOTAL_LIMIT = 30000;
    private readonly MAX_REQUESTS = 15;
    private readonly MIN_MOCK_BARS = 100;
    private readonly MAX_MOCK_BARS = 30000000;
    private readonly BINANCE_INTERVALS = new Set([
        '1m', '3m', '5m', '15m', '30m',
        '1h', '2h', '4h', '6h', '8h', '12h',
        '1d', '3d', '1w', '1M'
    ]);
    private currentAbort: AbortController | null = null;
    private currentLoadId = 0;
    private readonly MOCK_SYMBOLS = new Set(['AAPL', 'GOOGL', 'MSFT', 'TSLA', 'EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'XAGUSD', 'WTIUSD']);

    // Real-time WebSocket streaming
    private ws: WebSocket | null = null;
    private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    private isStreaming = false;
    private streamSymbol: string = '';
    private streamInterval: string = '';
    private reconnectAttempts = 0;
    private readonly MAX_RECONNECT_ATTEMPTS = 10;
    private readonly RECONNECT_DELAY_BASE = 1000; // Base delay in ms


    public async fetchData(symbol: string, interval: string, signal?: AbortSignal): Promise<OHLCVData[]> {
        if (this.isMockSymbol(symbol)) {
            await new Promise(resolve => setTimeout(resolve, 600)); // Simulate latency
            if (signal?.aborted) return [];
            return this.generateMockData(symbol, interval);
        }

        try {
            const batches: BinanceKline[][] = [];
            const { sourceInterval, needsResample } = this.resolveFetchInterval(interval);
            let endTime: number | undefined;
            let requestCount = 0;
            let totalDataLength = 0;

            while (totalDataLength < this.TOTAL_LIMIT && requestCount < this.MAX_REQUESTS) {
                if (signal?.aborted) return [];
                const remaining = this.TOTAL_LIMIT - totalDataLength;
                const limit = Math.min(remaining, this.LIMIT_PER_REQUEST);

                const data = await this.fetchKlinesBatch(symbol, sourceInterval, limit, endTime, signal);

                if (data.length === 0) break;

                batches.push(data);
                totalDataLength += data.length;
                endTime = data[0][0] - 1;
                requestCount++;

                if (data.length < limit) break;
            }

            const allRawData = batches.reverse().flat();
            const mapped = this.mapToOHLCV(allRawData);

            if (needsResample) {
                const resampled = resampleOHLCV(mapped, interval);
                debugLogger.info('data.resample', {
                    symbol,
                    interval,
                    sourceInterval,
                    sourceCandles: mapped.length,
                    targetCandles: resampled.length,
                });
                return resampled;
            }

            return mapped;
        } catch (error) {
            if (this.isAbortError(error)) {
                return [];
            }
            debugLogger.error('data.fetch.error', {
                symbol,
                interval,
                error: this.formatError(error),
            });
            console.error('Failed to fetch data:', error);
            return [];
        }
    }

    private async fetchKlinesBatch(
        symbol: string,
        interval: string,
        limit: number,
        endTime?: number,
        signal?: AbortSignal
    ): Promise<BinanceKline[]> {
        let url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        if (endTime) url += `&endTime=${endTime}`;

        const response = await fetch(url, { signal });
        if (!response.ok) {
            debugLogger.warn('data.fetch.http_error', {
                symbol,
                interval,
                status: response.status,
            });
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        return Array.isArray(data) ? data : [];
    }

    private mapToOHLCV(rawData: BinanceKline[]): OHLCVData[] {
        return rawData.map(d => ({
            time: (d[0] / 1000) as Time,
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4]),
            volume: parseFloat(d[5]),
        }));
    }

    public async loadData(symbol: string = state.currentSymbol, interval: string = state.currentInterval) {
        const loadId = ++this.currentLoadId;
        const startedAt = Date.now();
        debugLogger.event('data.load.start', { loadId, symbol, interval });

        // Stop any existing stream when loading new data
        this.stopStreaming();

        if (this.currentAbort) {
            this.currentAbort.abort();
        }
        const abortController = new AbortController();
        this.currentAbort = abortController;

        const data = await this.fetchData(symbol, interval, abortController.signal);
        const durationMs = Date.now() - startedAt;
        if (this.currentAbort === abortController) {
            this.currentAbort = null;
        }
        if (abortController.signal.aborted || loadId !== this.currentLoadId) {
            debugLogger.warn('data.load.aborted', { loadId, symbol, interval, durationMs });
            return;
        }
        if (symbol !== state.currentSymbol || interval !== state.currentInterval) {
            debugLogger.warn('data.load.stale', { loadId, symbol, interval, durationMs });
            return;
        }
        if (data.length === 0) return;

        debugLogger.event('data.load.success', {
            loadId,
            symbol,
            interval,
            candles: data.length,
            durationMs,
        });
        state.set('ohlcvData', data);

        // Start real-time streaming after data is loaded
        this.startStreaming(symbol, interval);
    }

    private isAbortError(error: unknown): boolean {
        if (error instanceof DOMException) {
            return error.name === 'AbortError';
        }
        return (error as { name?: string }).name === 'AbortError';
    }

    private formatError(error: unknown): string {
        if (error instanceof Error) {
            return `${error.name}: ${error.message}`;
        }
        return String(error);
    }

    private generateMockData(symbol: string, interval: string): OHLCVData[] {
        const rawBars = Number.isFinite(state.mockChartBars) ? Math.floor(state.mockChartBars) : this.TOTAL_LIMIT;
        const barsCount = Math.min(this.MAX_MOCK_BARS, Math.max(this.MIN_MOCK_BARS, rawBars));
        const config: MockChartConfig = {
            barsCount,
            volatility: 1.5,
            startPrice: this.getMockPrice(symbol),
            intervalSeconds: this.getIntervalSeconds(interval),
        };

        const model: MockChartModel = state.mockChartModel ?? 'simple';
        if (model === 'hard') {
            return this.generateChallengingMockData(config, this.createRandomSeed());
        }
        if (model === 'v3') {
            return this.generateAdversarialMockData(config, this.createRandomSeed());
        }

        return this.generateSimpleMockData(config);
    }

    private generateSimpleMockData(config: MockChartConfig): OHLCVData[] {
        const data: OHLCVData[] = [];
        let price = config.startPrice;
        const now = Math.floor(Date.now() / 1000);

        // Start 'barsCount' periods ago
        let time = (now - (config.barsCount * config.intervalSeconds)) as Time;

        for (let i = 0; i < config.barsCount; i++) {
            const volatility = price * (config.volatility / 100);
            const change = (Math.random() - 0.5) * volatility;
            const open = price;
            const close = price + change;
            const high = Math.max(open, close) + Math.random() * volatility * 0.5;
            const low = Math.min(open, close) - Math.random() * volatility * 0.5;
            const volume = Math.floor(Math.random() * 1000000) + 100000;

            data.push({
                time,
                open,
                high,
                low,
                close,
                volume,
            });

            price = close;
            if (price < config.startPrice * 0.1) {
                price = config.startPrice * 0.1;
            }
            time = (Number(time) + config.intervalSeconds) as Time;
        }

        return data;
    }

    private generateChallengingMockData(config: MockChartConfig, seed: number): OHLCVData[] {
        type Regime = {
            length: number;
            drift: number;
            volMult: number;
            meanReversion: number;
            jumpProb: number;
            jumpSize: number;
            gapProb: number;
            gapStd: number;
            anchor: number;
        };

        const data: OHLCVData[] = [];
        const now = Math.floor(Date.now() / 1000);
        let time = (now - (config.barsCount * config.intervalSeconds)) as Time;

        const rng = this.makeRng(seed * 1000003 + 0x9e3779b9);
        const baseVol = Math.max(0.0001, config.volatility / 100);
        const floor = Math.max(0.01, config.startPrice * 0.05);
        const ceiling = Math.max(floor * 2, config.startPrice * 50);
        const logFloor = Math.log(floor);
        const logCeil = Math.log(ceiling);
        const clampLog = (value: number): number => {
            if (!Number.isFinite(value)) return logFloor;
            if (value < logFloor) return logFloor;
            if (value > logCeil) return logCeil;
            return value;
        };
        const clampReturn = (value: number): number => {
            const limit = 0.35;
            if (!Number.isFinite(value)) return 0;
            if (value < -limit) return -limit;
            if (value > limit) return limit;
            return value;
        };

        let logPrice = Math.log(Math.max(config.startPrice, floor));
        let vol = baseVol;
        let prevRet = 0;

        const pickRegime = (): Regime => {
            const roll = rng();
            const length = this.randInt(rng, 120, 1400);
            const anchor = clampLog(logPrice + (rng() - 0.5) * baseVol * 10);

            if (roll < 0.25) {
                const dir = rng() < 0.5 ? -1 : 1;
                return {
                    length,
                    drift: dir * baseVol * 0.15,
                    volMult: 0.8,
                    meanReversion: 0.02,
                    jumpProb: 0.002,
                    jumpSize: baseVol * 3,
                    gapProb: 0.003,
                    gapStd: baseVol * 1.5,
                    anchor
                };
            }

            if (roll < 0.55) {
                return {
                    length,
                    drift: 0,
                    volMult: 0.7,
                    meanReversion: 0.08,
                    jumpProb: 0.001,
                    jumpSize: baseVol * 2.5,
                    gapProb: 0.002,
                    gapStd: baseVol * 1.2,
                    anchor
                };
            }

            if (roll < 0.8) {
                return {
                    length,
                    drift: 0,
                    volMult: 1.6,
                    meanReversion: 0.01,
                    jumpProb: 0.004,
                    jumpSize: baseVol * 4,
                    gapProb: 0.006,
                    gapStd: baseVol * 2.2,
                    anchor
                };
            }

            return {
                length,
                drift: 0,
                volMult: 0.5,
                meanReversion: 0.03,
                jumpProb: 0.0005,
                jumpSize: baseVol * 2,
                gapProb: 0.001,
                gapStd: baseVol,
                anchor
            };
        };

        let regime = pickRegime();
        let regimeLeft = regime.length;

        const omega = baseVol * baseVol * 0.05;
        const alpha = 0.12;
        const beta = 0.85;

        for (let i = 0; i < config.barsCount; i++) {
            if (regimeLeft-- <= 0) {
                regime = pickRegime();
                regimeLeft = regime.length;
            }

            const minuteOfDay = ((Math.floor(Number(time) / 60) % 1440) + 1440) % 1440;
            const season =
                0.85 +
                0.3 * Math.sin((2 * Math.PI * minuteOfDay) / 1440) +
                0.15 * Math.sin((4 * Math.PI * minuteOfDay) / 1440);
            const seasonMult = Math.max(0.4, season);

            vol = Math.sqrt(omega + alpha * prevRet * prevRet + beta * vol * vol);

            const gap = rng() < regime.gapProb ? this.randNormal(rng) * regime.gapStd : 0;
            logPrice = clampLog(logPrice + gap);
            let open = Math.exp(logPrice);

            const eps = this.randNormal(rng);
            const meanRevert = regime.meanReversion * (regime.anchor - logPrice);
            let ret = regime.drift + meanRevert + (vol * regime.volMult * seasonMult) * eps;

            if (rng() < regime.jumpProb) {
                const jumpDir = rng() < 0.5 ? -1 : 1;
                ret += jumpDir * regime.jumpSize * (0.5 + rng());
            }

            ret = clampReturn(ret);
            logPrice = clampLog(logPrice + ret);
            let close = Math.exp(logPrice);

            if (close < floor) {
                close = floor;
                logPrice = Math.log(close);
            }
            if (open < floor) open = floor;

            const rangeBase = Math.max(baseVol * 0.25, Math.abs(ret) + vol * 0.5);
            const wick = Math.abs(this.randNormal(rng)) * rangeBase * open;
            let high = Math.max(open, close) + wick;
            let low = Math.min(open, close) - wick;

            const lowFloor = floor * 0.8;
            const highCeil = ceiling * 1.2;
            if (low < lowFloor) low = lowFloor;
            if (high > highCeil) high = highCeil;
            if (high < low) high = Math.max(open, close);

            const volFactor = Math.min(5, 0.5 + Math.abs(ret) / baseVol);
            const volume = Math.floor(100000 * (1 + volFactor) * (0.7 + rng() * 0.6));

            data.push({
                time,
                open,
                high,
                low,
                close,
                volume,
            });

            prevRet = ret;
            time = (Number(time) + config.intervalSeconds) as Time;
        }

        return data;
    }

    private generateAdversarialMockData(config: MockChartConfig, seed: number): OHLCVData[] {
        type Regime = {
            length: number;
            drift: number;
            meanReversion: number;
            volMult: number;
            antiPersist: number;
            trapProb: number;
            spikeProb: number;
            gapProb: number;
            gapStd: number;
        };

        const data: OHLCVData[] = [];
        const now = Math.floor(Date.now() / 1000);
        let time = (now - (config.barsCount * config.intervalSeconds)) as Time;

        const rng = this.makeRng(seed * 1000003 + 0x85ebca6b);
        const baseVol = Math.max(0.0001, config.volatility / 100);
        const floor = Math.max(0.01, config.startPrice * 0.05);
        const ceiling = Math.max(floor * 2, config.startPrice * 50);
        const logFloor = Math.log(floor);
        const logCeil = Math.log(ceiling);
        const clampLog = (value: number): number => {
            if (!Number.isFinite(value)) return logFloor;
            if (value < logFloor) return logFloor;
            if (value > logCeil) return logCeil;
            return value;
        };
        const clampReturn = (value: number): number => {
            const limit = Math.max(0.08, baseVol * 8);
            if (!Number.isFinite(value)) return 0;
            if (value < -limit) return -limit;
            if (value > limit) return limit;
            return value;
        };

        let logPrice = Math.log(Math.max(config.startPrice, floor));
        let anchor = logPrice;
        let vol = baseVol;
        let prevRet = 0;
        let revertBias = 0;

        const pickRegime = (): Regime => {
            const roll = rng();
            const length = this.randInt(rng, 30, 220);

            if (roll < 0.45) {
                return {
                    length,
                    drift: 0,
                    meanReversion: 0.18,
                    volMult: 1.4,
                    antiPersist: 0.8,
                    trapProb: 0.85,
                    spikeProb: 0.06,
                    gapProb: 0.02,
                    gapStd: baseVol * 2.0
                };
            }

            if (roll < 0.75) {
                const dir = rng() < 0.5 ? -1 : 1;
                return {
                    length,
                    drift: dir * baseVol * 0.12,
                    meanReversion: 0.03,
                    volMult: 1.0,
                    antiPersist: 0.25,
                    trapProb: 0.4,
                    spikeProb: 0.03,
                    gapProb: 0.01,
                    gapStd: baseVol * 1.2
                };
            }

            return {
                length,
                drift: 0,
                meanReversion: 0.1,
                volMult: 1.8,
                antiPersist: 0.6,
                trapProb: 0.95,
                spikeProb: 0.08,
                gapProb: 0.025,
                gapStd: baseVol * 2.5
            };
        };

        let regime = pickRegime();
        let regimeLeft = regime.length;

        const omega = baseVol * baseVol * 0.08;
        const alpha = 0.18;
        const beta = 0.8;

        for (let i = 0; i < config.barsCount; i++) {
            if (regimeLeft-- <= 0) {
                regime = pickRegime();
                regimeLeft = regime.length;
            }

            anchor = clampLog(anchor + (rng() - 0.5) * baseVol * 0.25);

            const minuteOfDay = ((Math.floor(Number(time) / 60) % 1440) + 1440) % 1440;
            const season =
                0.9 +
                0.25 * Math.sin((2 * Math.PI * minuteOfDay) / 1440) +
                0.1 * Math.sin((4 * Math.PI * minuteOfDay) / 1440);
            const seasonMult = Math.max(0.35, season);

            vol = Math.sqrt(omega + alpha * prevRet * prevRet + beta * vol * vol);

            const gap = rng() < regime.gapProb ? this.randNormal(rng) * regime.gapStd : 0;
            logPrice = clampLog(logPrice + gap);
            const open = Math.exp(logPrice);

            const dist = logPrice - anchor;
            const meanRevert = -regime.meanReversion * dist;
            let ret = regime.drift + meanRevert + (vol * regime.volMult * seasonMult) * this.randNormal(rng);

            if (revertBias !== 0) {
                ret += revertBias;
                revertBias *= 0.45;
                if (Math.abs(revertBias) < baseVol * 0.005) {
                    revertBias = 0;
                }
            }

            if (rng() < regime.antiPersist) {
                ret -= 0.6 * prevRet;
            }

            const band = baseVol * (2.5 + rng() * 3.5);
            if (dist > band && rng() < regime.trapProb) {
                ret -= Math.abs(dist) * (0.4 + rng() * 0.5);
            } else if (dist < -band && rng() < regime.trapProb) {
                ret += Math.abs(dist) * (0.4 + rng() * 0.5);
            }

            if (rng() < regime.spikeProb) {
                const spikeDir = rng() < 0.5 ? -1 : 1;
                const spike = spikeDir * baseVol * (2 + rng() * 5);
                ret += spike;
                revertBias = -spikeDir * baseVol * (1.2 + rng() * 2);
            }

            ret = clampReturn(ret);
            logPrice = clampLog(logPrice + ret);
            let close = Math.exp(logPrice);

            if (close < floor) {
                close = floor;
                logPrice = Math.log(close);
            }

            const rangeBase = Math.max(baseVol * 0.3, Math.abs(ret) + vol * 0.6);
            const wickNoise = Math.abs(this.randNormal(rng)) * rangeBase * open;
            const wickBoost = rng() < 0.05 ? 1.5 + rng() * 3 : 0;
            const wick = wickNoise * (1 + wickBoost);

            let high = Math.max(open, close) + wick;
            let low = Math.min(open, close) - wick;

            const lowFloor = floor * 0.8;
            const highCeil = ceiling * 1.2;
            if (low < lowFloor) low = lowFloor;
            if (high > highCeil) high = highCeil;
            if (high < low) high = Math.max(open, close);

            const volFactor = Math.min(6, 0.6 + Math.abs(ret) / baseVol);
            const volume = Math.floor(120000 * (1 + volFactor) * (0.5 + rng() * 0.7));

            data.push({
                time,
                open,
                high,
                low,
                close,
                volume,
            });

            prevRet = ret;
            time = (Number(time) + config.intervalSeconds) as Time;
        }

        return data;
    }

    private getMockPrice(symbol: string): number {
        switch (symbol) {
            case 'AAPL': return 175;
            case 'GOOGL': return 140;
            case 'MSFT': return 380;
            case 'TSLA': return 220;
            case 'EURUSD': return 1.09;
            case 'GBPUSD': return 1.27;
            case 'USDJPY': return 148;
            case 'XAUUSD': return 2050;
            case 'XAGUSD': return 23.5;
            case 'WTIUSD': return 75;
            default: return 100;
        }
    }

    public isMockSymbol(symbol: string): boolean {
        return this.MOCK_SYMBOLS.has(symbol);
    }

    private isBinanceInterval(interval: string): boolean {
        return this.BINANCE_INTERVALS.has(interval);
    }

    private parseCustomMinutes(interval: string): number | null {
        if (this.isBinanceInterval(interval)) return null;
        if (!interval.endsWith('m')) return null;
        const minutes = parseInt(interval.slice(0, -1), 10);
        if (!Number.isFinite(minutes) || minutes <= 0) return null;
        return minutes;
    }

    private resolveFetchInterval(interval: string): { sourceInterval: string; needsResample: boolean } {
        if (this.isBinanceInterval(interval)) {
            return { sourceInterval: interval, needsResample: false };
        }
        const customMinutes = this.parseCustomMinutes(interval);
        if (customMinutes) {
            const targetSeconds = customMinutes * 60;
            let bestInterval = '1m';
            let bestSeconds = 60;

            for (const candidate of this.BINANCE_INTERVALS) {
                if (candidate === '1M') continue;
                const seconds = this.getIntervalSeconds(candidate);
                if (!Number.isFinite(seconds) || seconds <= 0) continue;
                if (seconds > targetSeconds) continue;
                if (targetSeconds % seconds !== 0) continue;
                if (seconds > bestSeconds) {
                    bestSeconds = seconds;
                    bestInterval = candidate;
                }
            }

            return { sourceInterval: bestInterval, needsResample: true };
        }
        return { sourceInterval: interval, needsResample: false };
    }

    private getIntervalSeconds(interval: string): number {
        const unit = interval.slice(-1);
        const value = parseInt(interval.slice(0, -1)) || 1;
        switch (unit) {
            case 'm': return value * 60;
            case 'h': return value * 3600;
            case 'd': return value * 86400;
            case 'w': return value * 604800;
            default: return 86400; // Default to 1d
        }
    }

    private createRandomSeed(): number {
        return Math.floor(Math.random() * 1000000000);
    }

    private makeRng(seed: number): () => number {
        let t = seed >>> 0;
        return () => {
            t += 0x6D2B79F5;
            let r = Math.imul(t ^ (t >>> 15), 1 | t);
            r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
            return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
        };
    }

    private randInt(rng: () => number, min: number, max: number): number {
        return Math.floor(rng() * (max - min + 1)) + min;
    }

    private randNormal(rng: () => number): number {
        let u = 0;
        let v = 0;
        while (u === 0) u = rng();
        while (v === 0) v = rng();
        return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    }

    // ============================================================================
    // Real-time WebSocket Streaming for Live Candle Updates
    // ============================================================================

    /**
     * Start real-time streaming for the given symbol and interval
     * Uses Binance WebSocket stream for live kline/candlestick updates
     */
    public startStreaming(symbol: string = state.currentSymbol, interval: string = state.currentInterval): void {
        // Don't stream for mock symbols
        if (this.isMockSymbol(symbol)) {
            debugLogger.info('data.stream.skip_mock', { symbol });
            return;
        }
        if (!this.isBinanceInterval(interval)) {
            debugLogger.info('data.stream.skip_interval', { symbol, interval });
            return;
        }

        // If already streaming the same symbol/interval, do nothing
        if (this.isStreaming && this.streamSymbol === symbol && this.streamInterval === interval) {
            debugLogger.info('data.stream.already_active', { symbol, interval });
            return;
        }

        // Stop any existing stream first
        this.stopStreaming();

        this.streamSymbol = symbol;
        this.streamInterval = interval;
        this.reconnectAttempts = 0;
        this.connectWebSocket();
    }

    /**
     * Stop the real-time streaming and clean up WebSocket connection
     */
    public stopStreaming(): void {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        if (this.ws) {
            this.isStreaming = false;
            this.ws.close(1000, 'Stream stopped by user');
            this.ws = null;
            debugLogger.info('data.stream.stopped', {
                symbol: this.streamSymbol,
                interval: this.streamInterval
            });
        }

        this.streamSymbol = '';
        this.streamInterval = '';
        this.reconnectAttempts = 0;
    }

    /**
     * Connect to Binance WebSocket stream
     */
    private connectWebSocket(): void {
        const symbol = this.streamSymbol.toLowerCase();
        const interval = this.streamInterval;
        const streamName = `${symbol}@kline_${interval}`;
        const wsUrl = `wss://stream.binance.com:9443/ws/${streamName}`;

        debugLogger.info('data.stream.connecting', { symbol: this.streamSymbol, interval, wsUrl });

        try {
            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                this.isStreaming = true;
                this.reconnectAttempts = 0;
                debugLogger.event('data.stream.connected', {
                    symbol: this.streamSymbol,
                    interval: this.streamInterval
                });
            };

            this.ws.onmessage = (event) => {
                this.handleStreamMessage(event.data);
            };

            this.ws.onerror = (error) => {
                debugLogger.error('data.stream.error', {
                    symbol: this.streamSymbol,
                    interval: this.streamInterval,
                    error: String(error)
                });
            };

            this.ws.onclose = (event) => {
                this.isStreaming = false;
                debugLogger.warn('data.stream.closed', {
                    symbol: this.streamSymbol,
                    interval: this.streamInterval,
                    code: event.code,
                    reason: event.reason
                });

                // Attempt reconnection if not intentionally closed
                if (event.code !== 1000 && this.streamSymbol && this.streamInterval) {
                    this.attemptReconnect();
                }
            };
        } catch (error) {
            debugLogger.error('data.stream.connection_failed', {
                error: this.formatError(error)
            });
            this.attemptReconnect();
        }
    }

    /**
     * Attempt to reconnect with exponential backoff
     */
    private attemptReconnect(): void {
        if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
            debugLogger.error('data.stream.max_reconnects', {
                attempts: this.reconnectAttempts
            });
            return;
        }

        this.reconnectAttempts++;
        const delay = this.RECONNECT_DELAY_BASE * Math.pow(2, this.reconnectAttempts - 1);

        debugLogger.info('data.stream.reconnecting', {
            attempt: this.reconnectAttempts,
            delayMs: delay
        });

        this.reconnectTimeout = setTimeout(() => {
            if (this.streamSymbol && this.streamInterval) {
                this.connectWebSocket();
            }
        }, delay);
    }

    /**
     * Handle incoming WebSocket message and update chart data
     */
    private handleStreamMessage(data: string): void {
        try {
            const message = JSON.parse(data);

            // Binance kline stream format
            if (message.e === 'kline' && message.k) {
                const kline = message.k;

                // Skip updates during replay mode
                if (state.replayMode) {
                    return;
                }

                // Create OHLCV data from the stream
                const updatedCandle: OHLCVData = {
                    time: (kline.t / 1000) as Time, // Open time in seconds
                    open: parseFloat(kline.o),
                    high: parseFloat(kline.h),
                    low: parseFloat(kline.l),
                    close: parseFloat(kline.c),
                    volume: parseFloat(kline.v),
                };

                // Check if symbol/interval still matches
                if (kline.s !== this.streamSymbol || kline.i !== this.streamInterval) {
                    return;
                }

                // Update the candlestick series directly for real-time updates
                if (state.candlestickSeries) {
                    state.candlestickSeries.update(updatedCandle);
                }

                // Also update the state data array
                const currentData = [...state.ohlcvData];
                if (currentData.length > 0) {
                    const lastCandle = currentData[currentData.length - 1];

                    // Check if this is the same candle (update) or a new candle
                    if (lastCandle.time === updatedCandle.time) {
                        // Update the last candle
                        currentData[currentData.length - 1] = updatedCandle;
                    } else if (updatedCandle.time > lastCandle.time) {
                        // This is a new candle, append it
                        currentData.push(updatedCandle);

                        // Keep the array size manageable (optional: trim old data)
                        if (currentData.length > this.TOTAL_LIMIT) {
                            currentData.shift();
                        }
                    }

                    // Update state without triggering full re-render
                    // Using direct assignment to avoid state listener overhead for high-frequency updates
                    (state as any).ohlcvData = currentData;
                }

                // Log occasional updates (every 10 seconds based on time)
                const now = Date.now();
                if (!this.lastLogTime || now - this.lastLogTime > 10000) {
                    this.lastLogTime = now;
                    debugLogger.info('data.stream.update', {
                        symbol: kline.s,
                        interval: kline.i,
                        close: updatedCandle.close,
                        isClosed: kline.x, // Whether this candle is closed
                    });
                }
            }
        } catch (error) {
            debugLogger.error('data.stream.parse_error', {
                error: this.formatError(error)
            });
        }
    }

    private lastLogTime: number = 0;

}

export const dataManager = new DataManager();
