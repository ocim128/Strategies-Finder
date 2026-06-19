/**
 * Rust Trading Engine Client
 *
 * Provides interface to the high-performance Rust backend for:
 * - Backtesting (100x faster than TypeScript)
 *
 * Falls back to TypeScript implementation when Rust server is unavailable.
 */

import { OHLCVData, Signal, BacktestResult, BacktestSettings } from './types/strategies';
import { debugLogger } from './debug-logger';
import { isSmartTradeSizingMode, type AdvancedSizingSettings, type TradeSizingMode } from './types/backtest';

const rustLog = {
    info: (message: string, ...data: unknown[]) => debugLogger.info(message, data.length <= 1 ? data[0] : data),
    warn: (message: string, ...data: unknown[]) => debugLogger.warn(message, data.length <= 1 ? data[0] : data),
    error: (message: string, ...data: unknown[]) => debugLogger.error(message, data.length <= 1 ? data[0] : data),
};

// ============================================================================
// Types
// ============================================================================

interface RustHealthResponse {
    status: string;
    version?: string;
    engine: string;
}

interface RustBacktestRequest {
    data: OHLCVData[];
    signals: Signal[];
    initialCapital: number;
    positionSizePercent: number;
    commissionPercent: number;
    settings: BacktestSettings;
    sizing?: {
        mode: TradeSizingMode;
        fixedTradeAmount: number;
        advancedSizing?: AdvancedSizingSettings;
    };
}

// ============================================================================
// Rust Engine Client
// ============================================================================

export class RustEngineClient {
    private readonly baseUrl: string;
    private isAvailable: boolean = false;
    private engineVersion: string | null = null;
    private lastHealthCheck: number = 0;
    private readonly healthCheckInterval = 30000; // 30 seconds
    private readonly healthCheckFailureBackoff = 5000; // 5 seconds negative cache
    private lastHealthCheckFailed: boolean = false;
    private readonly backtestTimeoutMs = 30_000;
    private readonly batchBacktestTimeoutMs = 120_000;
    private readonly cacheTimeoutMs = 180_000;

    // Data caching for large datasets
    private readonly maxCachedDataEntries = 4;
    private readonly cachedDataIdsByHash = new Map<string, string>();

    constructor(baseUrl: string = 'http://127.0.0.1:3030') {
        this.baseUrl = baseUrl;
    }

    /**
     * Generate a simple hash for OHLCV data to detect changes
     */
    private generateDataHash(data: OHLCVData[]): string {
        if (data.length === 0) return 'empty';
        const maxSamples = 200_000;
        const stride = Math.max(1, Math.floor(data.length / maxSamples));
        let hash = 0x811c9dc5;

        for (let i = 0; i < data.length; i += stride) {
            hash = this.hashBar(hash, data[i], i);
        }

        const lastIndex = data.length - 1;
        if (lastIndex % stride !== 0) {
            hash = this.hashBar(hash, data[lastIndex], lastIndex);
        }

        const firstTime = this.normalizeTimeForHash(data[0].time);
        const lastTime = this.normalizeTimeForHash(data[lastIndex].time);
        return `${data.length}-${firstTime}-${lastTime}-${hash.toString(16)}`;
    }

    private hashBar(hash: number, bar: OHLCVData, index: number): number {
        let next = hash;
        next = this.mixHash(next, index);
        next = this.mixHash(next, this.normalizeTimeForHash(bar.time));
        next = this.mixHash(next, bar.open);
        next = this.mixHash(next, bar.high);
        next = this.mixHash(next, bar.low);
        next = this.mixHash(next, bar.close);
        next = this.mixHash(next, bar.volume);
        return next;
    }

    private normalizeTimeForHash(time: OHLCVData['time']): number {
        if (typeof time === 'number' && Number.isFinite(time)) {
            return Math.round(time);
        }
        if (typeof time === 'string') {
            let hash = 0;
            for (let i = 0; i < time.length; i++) {
                hash = ((hash * 31) + time.charCodeAt(i)) >>> 0;
            }
            return hash;
        }
        if (time && typeof time === 'object') {
            const businessDay = time as { year?: number; month?: number; day?: number };
            const year = Number.isFinite(businessDay.year) ? Number(businessDay.year) : 0;
            const month = Number.isFinite(businessDay.month) ? Number(businessDay.month) : 0;
            const day = Number.isFinite(businessDay.day) ? Number(businessDay.day) : 0;
            return (year * 10000) + (month * 100) + day;
        }
        return 0;
    }

    private mixHash(hash: number, value: number): number {
        const normalized = Number.isFinite(value) ? Math.round(value * 1_000_000) : 0;
        const mixed = hash ^ (normalized + 0x9e3779b9 + ((hash << 6) >>> 0) + (hash >>> 2));
        return mixed >>> 0;
    }

    private getCachedDataId(dataHash: string): string | null {
        const cacheId = this.cachedDataIdsByHash.get(dataHash);
        if (!cacheId) return null;
        this.cachedDataIdsByHash.delete(dataHash);
        this.cachedDataIdsByHash.set(dataHash, cacheId);
        return cacheId;
    }

    private rememberCachedDataId(dataHash: string, cacheId: string): void {
        this.cachedDataIdsByHash.delete(dataHash);
        this.cachedDataIdsByHash.set(dataHash, cacheId);
        while (this.cachedDataIdsByHash.size > this.maxCachedDataEntries) {
            const oldestHash = this.cachedDataIdsByHash.keys().next().value;
            if (oldestHash === undefined) break;
            this.cachedDataIdsByHash.delete(oldestHash);
        }
    }

    private forgetCachedDataId(cacheId: string): void {
        for (const [dataHash, cachedId] of this.cachedDataIdsByHash) {
            if (cachedId === cacheId) {
                this.cachedDataIdsByHash.delete(dataHash);
                return;
            }
        }
    }

    // ========================================================================
    // Connection Management
    // ========================================================================

    /**
     * Check if the Rust server is available
     */
    async checkHealth(): Promise<boolean> {
        const now = Date.now();

        // Use cached positive result if recent
        if (now - this.lastHealthCheck < this.healthCheckInterval && this.isAvailable) {
            return true;
        }

        // Use cached negative result for shorter backoff (avoid repeated timeouts while down)
        if (now - this.lastHealthCheck < this.healthCheckFailureBackoff && this.lastHealthCheckFailed) {
            return false;
        }

        try {
            const response = await fetch(`${this.baseUrl}/api/health`, {
                method: 'GET',
                signal: AbortSignal.timeout(2000), // 2 second timeout
            });

            if (response.ok) {
                const data: RustHealthResponse = await response.json();
                this.isAvailable = data.status === 'healthy';
                this.engineVersion = typeof data.version === 'string' ? data.version : null;
                this.lastHealthCheckFailed = !this.isAvailable;
                this.lastHealthCheck = now;
                if (this.isAvailable) {
                    rustLog.info(`[RustEngine] Connected: v${this.engineVersion ?? 'unknown'}`);
                } else {
                    rustLog.warn(`[RustEngine] Health check returned status "${data.status}", using TypeScript fallback`);
                }
                return this.isAvailable;
            }
            this.isAvailable = false;
            this.engineVersion = null;
            this.lastHealthCheckFailed = true;
            this.lastHealthCheck = now;
        } catch (error) {
            this.isAvailable = false;
            this.engineVersion = null;
            this.lastHealthCheckFailed = true;
            this.lastHealthCheck = now;
            rustLog.warn('[RustEngine] Server not available, using TypeScript fallback');
        }

        return false;
    }

    /**
     * Get whether Rust engine is currently available
     */
    get available(): boolean {
        return this.isAvailable;
    }

    get version(): string | null {
        return this.engineVersion;
    }

    // ========================================================================
    // Backtest API
    // ========================================================================

    /**
     * Run backtest on Rust engine
     */
    async runBacktest(
        data: OHLCVData[],
        signals: Signal[],
        initialCapital: number,
        positionSizePercent: number,
        commissionPercent: number,
        settings: BacktestSettings,
        sizing?: { mode: TradeSizingMode; fixedTradeAmount: number; advancedSizing?: AdvancedSizingSettings }
    ): Promise<BacktestResult | null> {
        if (!await this.checkHealth()) {
            return null;
        }
        if (sizing && isSmartTradeSizingMode(sizing.mode)) {
            rustLog.warn(`[RustEngine] ${sizing.mode} sizing is not supported on Rust backend, using TypeScript fallback`);
            return null;
        }

        try {
            const request: RustBacktestRequest = {
                data,
                signals,
                initialCapital,
                positionSizePercent,
                commissionPercent,
                settings,
                sizing,
            };

            const startTime = performance.now();

            const response = await fetch(`${this.baseUrl}/api/backtest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
                signal: AbortSignal.timeout(this.backtestTimeoutMs),
            });

            if (!response.ok) {
                rustLog.error('[RustEngine] Backtest failed:', response.statusText);
                return null;
            }

            const result: BacktestResult = await response.json();
            const elapsed = performance.now() - startTime;

            rustLog.info(`[RustEngine] Backtest completed in ${elapsed.toFixed(2)}ms (${data.length} bars)`);

            return result;
        } catch (error) {
            rustLog.error('[RustEngine] Backtest error:', error);
            return null;
        }
    }

    /**
     * Run batch backtests on Rust engine - all backtests run in parallel
     * This is MUCH faster than individual backtest calls due to:
     * 1. Single HTTP request (no per-request overhead)
     * 2. OHLCV data sent only once
     * 3. All backtests run in parallel using Rayon
     */
    async runBatchBacktest(
        data: OHLCVData[],
        items: Array<{
            id: string;
            signals: Signal[];
            settings?: BacktestSettings;
        }>,
        initialCapital: number,
        positionSizePercent: number,
        commissionPercent: number,
        baseSettings: BacktestSettings,
        sizing?: { mode: TradeSizingMode; fixedTradeAmount: number; advancedSizing?: AdvancedSizingSettings },
        compact: boolean = true
    ): Promise<{ results: Array<{ id: string; result: BacktestResult }>; processingTimeMs: number } | null> {
        if (!await this.checkHealth()) {
            return null;
        }
        if (sizing && isSmartTradeSizingMode(sizing.mode)) {
            rustLog.warn(`[RustEngine] ${sizing.mode} sizing is not supported on Rust batch backtests, using TypeScript fallback`);
            return null;
        }

        try {
            const request = {
                data,
                items,
                initialCapital,
                positionSizePercent,
                commissionPercent,
                baseSettings,
                sizing,
                compact,
            };

            const startTime = performance.now();

            const response = await fetch(`${this.baseUrl}/api/backtest/batch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
                signal: AbortSignal.timeout(this.batchBacktestTimeoutMs),
            });

            if (!response.ok) {
                rustLog.error('[RustEngine] Batch backtest failed:', response.statusText);
                return null;
            }

            const result = await response.json();
            const elapsed = performance.now() - startTime;

            rustLog.info(`[RustEngine] Batch backtest: ${items.length} runs in ${elapsed.toFixed(2)}ms (Rust: ${result.processingTimeMs}ms)`);

            return result;
        } catch (error) {
            rustLog.error('[RustEngine] Batch backtest error:', error);
            return null;
        }
    }

    // ========================================================================
    // Data Caching API (for large datasets)
    // ========================================================================

    /**
     * Cache OHLCV data on the Rust server for reuse in subsequent batch requests.
     * This is critical for large datasets (1M+ bars) where sending data once
     * is much more efficient than sending it with every batch.
     * 
     * Returns cache ID to use in runCachedBatchBacktest.
     */
    async cacheData(data: OHLCVData[]): Promise<string | null> {
        if (!await this.checkHealth()) {
            return null;
        }

        const dataHash = this.generateDataHash(data);

        // If we already have this data cached, return existing ID
        const cachedDataId = this.getCachedDataId(dataHash);
        if (cachedDataId) {
            rustLog.info(`[RustEngine] Using existing cache ID: ${cachedDataId}`);
            return cachedDataId;
        }

        try {
            rustLog.info(`[RustEngine] Caching ${data.length} bars...`);
            const startTime = performance.now();

            const response = await fetch(`${this.baseUrl}/api/data/cache`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data }),
                signal: AbortSignal.timeout(this.cacheTimeoutMs),
            });

            if (!response.ok) {
                rustLog.error('[RustEngine] Cache data failed:', response.statusText);
                return null;
            }

            const result = await response.json();
            const elapsed = performance.now() - startTime;
            const cacheId = typeof result?.cacheId === "string" && result.cacheId.length > 0
                ? result.cacheId
                : null;
            if (!cacheId) {
                rustLog.error('[RustEngine] Cache data returned an invalid cache ID');
                return null;
            }
            const barCount = Number.isFinite(result?.barCount) ? result.barCount : data.length;

            this.rememberCachedDataId(dataHash, cacheId);

            rustLog.info(`[RustEngine] Cached ${barCount} bars in ${elapsed.toFixed(2)}ms, ID: ${cacheId}`);

            return cacheId;
        } catch (error) {
            rustLog.error('[RustEngine] Cache data error:', error);
            return null;
        }
    }

    /**
     * Run batch backtests using previously cached OHLCV data.
     * Much faster for large datasets as data is only sent once.
     */
    async runCachedBatchBacktest(
        cacheId: string,
        items: Array<{
            id: string;
            signals: Signal[];
            settings?: BacktestSettings;
        }>,
        initialCapital: number,
        positionSizePercent: number,
        commissionPercent: number,
        baseSettings: BacktestSettings,
        sizing?: { mode: TradeSizingMode; fixedTradeAmount: number; advancedSizing?: AdvancedSizingSettings },
        compact: boolean = true
    ): Promise<{ results: Array<{ id: string; result: BacktestResult }>; processingTimeMs: number } | null> {
        if (!await this.checkHealth()) {
            return null;
        }
        if (sizing && isSmartTradeSizingMode(sizing.mode)) {
            rustLog.warn(`[RustEngine] ${sizing.mode} sizing is not supported on cached Rust batch backtests, using TypeScript fallback`);
            return null;
        }

        try {
            const request = {
                cacheId,
                items,
                initialCapital,
                positionSizePercent,
                commissionPercent,
                baseSettings,
                sizing,
                compact,
            };

            const startTime = performance.now();

            const response = await fetch(`${this.baseUrl}/api/backtest/batch/cached`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
                signal: AbortSignal.timeout(this.batchBacktestTimeoutMs),
            });

            if (!response.ok) {
                const errorText = await response.text();
                rustLog.error('[RustEngine] Cached batch backtest failed:', response.statusText, errorText);
                this.forgetCachedDataId(cacheId);
                return null;
            }

            const result = await response.json();
            const elapsed = performance.now() - startTime;

            rustLog.info(`[RustEngine] Cached batch: ${items.length} runs in ${elapsed.toFixed(2)}ms (Rust: ${result.processingTimeMs}ms)`);

            return result;
        } catch (error) {
            rustLog.error('[RustEngine] Cached batch backtest error:', error);
            this.forgetCachedDataId(cacheId);
            return null;
        }
    }

    /**
     * Clear the local cache tracking (server cache is managed automatically)
     */
    clearLocalCache(): void {
        this.cachedDataIdsByHash.clear();
    }
}

// ============================================================================
// Singleton Instance
// ============================================================================

/** Global Rust engine client instance */
export const rustEngine = new RustEngineClient();

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if Rust engine is available and return it, otherwise return null
 */
export async function getRustEngine(): Promise<RustEngineClient | null> {
    if (await rustEngine.checkHealth()) {
        return rustEngine;
    }
    return null;
}

/**
 * Get engine status for display
 */
export async function getEngineStatus(): Promise<{
    engine: 'rust' | 'typescript';
    version?: string;
}> {
    if (await rustEngine.checkHealth()) {
        return { engine: 'rust', version: rustEngine.version ?? undefined };
    }
    return { engine: 'typescript' };
}



