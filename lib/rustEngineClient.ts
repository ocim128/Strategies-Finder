/**
 * Rust Trading Engine Client
 * 
 * Provides interface to the high-performance Rust backend for:
 * - Backtesting (100x faster than TypeScript)
 * - Walk-forward optimization
 * - Strategy finder
 * 
 * Falls back to TypeScript implementation when Rust server is unavailable.
 */

import { OHLCVData, Signal, BacktestResult, BacktestSettings } from './strategies/types';

// ============================================================================
// Types
// ============================================================================

interface RustHealthResponse {
    status: string;
    version: string;
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
        mode: 'percent' | 'fixed';
        fixedTradeAmount: number;
    };
}

interface WalkForwardConfig {
    optimizationWindow: number;
    testWindow: number;
    stepSize: number;
    parameterRanges: Array<{
        name: string;
        min: number;
        max: number;
        step: number;
    }>;
    topN?: number;
    minTrades?: number;
}

interface RustWalkForwardRequest {
    data: OHLCVData[];
    strategyName: string;
    baseParams: Record<string, number>;
    initialCapital: number;
    positionSizePercent: number;
    commissionPercent: number;
    settings: BacktestSettings;
    config: WalkForwardConfig;
}

interface FinderOptions {
    mode: 'grid' | 'random';
    sortPriority: string[];
    useAdvancedSort: boolean;
    topN: number;
    steps: number;
    rangePercent: number;
    maxRuns: number;
    tradeFilterEnabled: boolean;
    minTrades: number;
    maxTrades: number;
}

interface RustFinderRequest {
    data: OHLCVData[];
    strategyName: string;
    baseParams: Record<string, number>;
    initialCapital: number;
    positionSizePercent: number;
    commissionPercent: number;
    settings: BacktestSettings;
    options: FinderOptions;
}

interface ProgressUpdate {
    percent: number;
    status: string;
    currentWindow?: number;
    totalWindows?: number;
}

type ProgressCallback = (update: ProgressUpdate) => void;

// ============================================================================
// Rust Engine Client
// ============================================================================

export class RustEngineClient {
    private readonly baseUrl: string;
    private isAvailable: boolean = false;
    private lastHealthCheck: number = 0;
    private readonly healthCheckInterval = 30000; // 30 seconds
    private ws: WebSocket | null = null;

    // Data caching for large datasets
    private cachedDataId: string | null = null;
    private cachedDataHash: string | null = null;

    constructor(baseUrl: string = 'http://127.0.0.1:3030') {
        this.baseUrl = baseUrl;
    }

    /**
     * Generate a simple hash for OHLCV data to detect changes
     */
    private generateDataHash(data: OHLCVData[]): string {
        if (data.length === 0) return 'empty';
        const first = data[0];
        const last = data[data.length - 1];
        return `${first.time}-${last.time}-${data.length}`;
    }

    // ========================================================================
    // Connection Management
    // ========================================================================

    /**
     * Check if the Rust server is available
     */
    async checkHealth(): Promise<boolean> {
        const now = Date.now();

        // Use cached result if recent
        if (now - this.lastHealthCheck < this.healthCheckInterval && this.isAvailable) {
            return true;
        }

        try {
            const response = await fetch(`${this.baseUrl}/api/health`, {
                method: 'GET',
                signal: AbortSignal.timeout(2000), // 2 second timeout
            });

            if (response.ok) {
                const data: RustHealthResponse = await response.json();
                this.isAvailable = data.status === 'healthy';
                this.lastHealthCheck = now;
                console.log(`[RustEngine] Connected: v${data.version}`);
                return this.isAvailable;
            }
        } catch (error) {
            this.isAvailable = false;
            console.warn('[RustEngine] Server not available, using TypeScript fallback');
        }

        return false;
    }

    /**
     * Get whether Rust engine is currently available
     */
    get available(): boolean {
        return this.isAvailable;
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
        sizing?: { mode: 'percent' | 'fixed'; fixedTradeAmount: number }
    ): Promise<BacktestResult | null> {
        if (!await this.checkHealth()) {
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
            });

            if (!response.ok) {
                console.error('[RustEngine] Backtest failed:', response.statusText);
                return null;
            }

            const result: BacktestResult = await response.json();
            const elapsed = performance.now() - startTime;

            console.log(`[RustEngine] Backtest completed in ${elapsed.toFixed(2)}ms (${data.length} bars)`);

            return result;
        } catch (error) {
            console.error('[RustEngine] Backtest error:', error);
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
        sizing?: { mode: 'percent' | 'fixed'; fixedTradeAmount: number },
        compact: boolean = true
    ): Promise<{ results: Array<{ id: string; result: BacktestResult }>; processingTimeMs: number } | null> {
        if (!await this.checkHealth()) {
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
            });

            if (!response.ok) {
                console.error('[RustEngine] Batch backtest failed:', response.statusText);
                return null;
            }

            const result = await response.json();
            const elapsed = performance.now() - startTime;

            console.log(`[RustEngine] Batch backtest: ${items.length} runs in ${elapsed.toFixed(2)}ms (Rust: ${result.processingTimeMs}ms)`);

            return result;
        } catch (error) {
            console.error('[RustEngine] Batch backtest error:', error);
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
        if (this.cachedDataHash === dataHash && this.cachedDataId) {
            console.log(`[RustEngine] Using existing cache ID: ${this.cachedDataId}`);
            return this.cachedDataId;
        }

        try {
            console.log(`[RustEngine] Caching ${data.length} bars...`);
            const startTime = performance.now();

            const response = await fetch(`${this.baseUrl}/api/data/cache`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data }),
            });

            if (!response.ok) {
                console.error('[RustEngine] Cache data failed:', response.statusText);
                return null;
            }

            const result = await response.json();
            const elapsed = performance.now() - startTime;

            this.cachedDataId = result.cacheId;
            this.cachedDataHash = dataHash;

            console.log(`[RustEngine] Cached ${result.barCount} bars in ${elapsed.toFixed(2)}ms, ID: ${result.cacheId}`);

            return result.cacheId;
        } catch (error) {
            console.error('[RustEngine] Cache data error:', error);
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
        sizing?: { mode: 'percent' | 'fixed'; fixedTradeAmount: number },
        compact: boolean = true
    ): Promise<{ results: Array<{ id: string; result: BacktestResult }>; processingTimeMs: number } | null> {
        if (!await this.checkHealth()) {
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
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error('[RustEngine] Cached batch backtest failed:', response.statusText, errorText);
                return null;
            }

            const result = await response.json();
            const elapsed = performance.now() - startTime;

            console.log(`[RustEngine] Cached batch: ${items.length} runs in ${elapsed.toFixed(2)}ms (Rust: ${result.processingTimeMs}ms)`);

            return result;
        } catch (error) {
            console.error('[RustEngine] Cached batch backtest error:', error);
            return null;
        }
    }

    /**
     * Clear the local cache tracking (server cache is managed automatically)
     */
    clearLocalCache(): void {
        this.cachedDataId = null;
        this.cachedDataHash = null;
    }

    // ========================================================================
    // Walk-Forward API
    // ========================================================================

    /**
     * Run walk-forward analysis on Rust engine with progress streaming
     */
    async runWalkForward(
        data: OHLCVData[],
        strategyName: string,
        baseParams: Record<string, number>,
        initialCapital: number,
        positionSizePercent: number,
        commissionPercent: number,
        settings: BacktestSettings,
        config: WalkForwardConfig,
        onProgress?: ProgressCallback
    ): Promise<any | null> {
        if (!await this.checkHealth()) {
            return null;
        }

        try {
            // Connect WebSocket for progress updates
            if (onProgress) {
                this.connectProgressSocket(onProgress);
            }

            const request: RustWalkForwardRequest = {
                data,
                strategyName,
                baseParams,
                initialCapital,
                positionSizePercent,
                commissionPercent,
                settings,
                config,
            };

            const startTime = performance.now();

            const response = await fetch(`${this.baseUrl}/api/walk-forward`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
            });

            // Disconnect WebSocket
            this.disconnectProgressSocket();

            if (!response.ok) {
                console.error('[RustEngine] Walk-forward failed:', response.statusText);
                return null;
            }

            const result = await response.json();
            const elapsed = performance.now() - startTime;

            console.log(`[RustEngine] Walk-forward completed in ${elapsed.toFixed(2)}ms`);

            return result;
        } catch (error) {
            this.disconnectProgressSocket();
            console.error('[RustEngine] Walk-forward error:', error);
            return null;
        }
    }

    // ========================================================================
    // Finder API
    // ========================================================================

    /**
     * Run strategy finder on Rust engine with progress streaming
     */
    async runFinder(
        data: OHLCVData[],
        strategyName: string,
        baseParams: Record<string, number>,
        initialCapital: number,
        positionSizePercent: number,
        commissionPercent: number,
        settings: BacktestSettings,
        options: FinderOptions,
        onProgress?: ProgressCallback
    ): Promise<any[] | null> {
        if (!await this.checkHealth()) {
            return null;
        }

        try {
            // Connect WebSocket for progress updates
            if (onProgress) {
                this.connectProgressSocket(onProgress);
            }

            const request: RustFinderRequest = {
                data,
                strategyName,
                baseParams,
                initialCapital,
                positionSizePercent,
                commissionPercent,
                settings,
                options,
            };

            const startTime = performance.now();

            const response = await fetch(`${this.baseUrl}/api/finder`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
            });

            // Disconnect WebSocket
            this.disconnectProgressSocket();

            if (!response.ok) {
                console.error('[RustEngine] Finder failed:', response.statusText);
                return null;
            }

            const result = await response.json();
            const elapsed = performance.now() - startTime;

            console.log(`[RustEngine] Finder completed in ${elapsed.toFixed(2)}ms`);

            return result;
        } catch (error) {
            this.disconnectProgressSocket();
            console.error('[RustEngine] Finder error:', error);
            return null;
        }
    }

    // ========================================================================
    // WebSocket Progress Streaming
    // ========================================================================

    private connectProgressSocket(onProgress: ProgressCallback): void {
        try {
            const wsUrl = this.baseUrl.replace('http://', 'ws://').replace('https://', 'wss://');
            this.ws = new WebSocket(`${wsUrl}/ws/optimizer`);

            this.ws.onmessage = (event) => {
                try {
                    const update: ProgressUpdate = JSON.parse(event.data);
                    onProgress(update);
                } catch (e) {
                    console.warn('[RustEngine] Invalid progress message:', event.data);
                }
            };

            this.ws.onerror = (error) => {
                console.warn('[RustEngine] WebSocket error:', error);
            };
        } catch (error) {
            console.warn('[RustEngine] Failed to connect WebSocket:', error);
        }
    }

    private disconnectProgressSocket(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
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
        return { engine: 'rust', version: '0.1.0' };
    }
    return { engine: 'typescript' };
}
