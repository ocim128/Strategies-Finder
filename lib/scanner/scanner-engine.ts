/**
 * Scanner Engine
 * Core scanning logic for multi-pair signal detection
 */

import { binanceSearchService, type BinanceSymbol } from '../binanceSearchService';
import { dataManager } from '../dataManager';
import { strategyRegistry } from '../../strategyRegistry';
import type { Signal } from '../strategies/types';
import { getOpenPositionForScanner } from '../strategies/backtest';
import type {
    ScannerConfig,
    ScanResult,
    ScanProgress,
    PairScanData,
} from './scanner-types';

// ============================================================================
// Constants
// ============================================================================

const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 1500;
const MIN_DATA_BARS = 200;

// ============================================================================
// Scanner Engine Class
// ============================================================================

export class ScannerEngine {
    private abortController: AbortController | null = null;

    /**
     * Scan multiple pairs for trading signals
     * Yields progress updates and returns final results
     */
    async *scan(
        config: ScannerConfig,
        onProgress?: (progress: ScanProgress) => void
    ): AsyncGenerator<ScanProgress, ScanResult[], void> {
        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        try {
            // 1. Build universe
            const pairs = await this.buildUniverse(config.maxPairs);
            if (pairs.length === 0) {
                throw new Error('No trading pairs available');
            }

            const results: ScanResult[] = [];
            const totalBatches = Math.ceil(pairs.length / BATCH_SIZE);
            let processedCount = 0;

            // 2. Process in batches
            for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
                if (signal.aborted) break;

                const batchStart = batchIdx * BATCH_SIZE;
                const batchEnd = Math.min(batchStart + BATCH_SIZE, pairs.length);
                const batch = pairs.slice(batchStart, batchEnd);

                // Fetch data for batch
                const pairDataMap = await this.fetchBatch(batch, config.interval, signal);

                // Process each pair in batch
                for (const [symbol, pairData] of pairDataMap) {
                    if (signal.aborted) break;

                    processedCount++;

                    // Report progress
                    const progress: ScanProgress = {
                        current: processedCount,
                        total: pairs.length,
                        currentSymbol: symbol,
                        estimatedRemainingMs: this.estimateRemainingTime(
                            processedCount,
                            pairs.length,
                            BATCH_DELAY_MS
                        ),
                    };
                    yield progress;
                    onProgress?.(progress);

                    // Scan for signals
                    const pairResults = this.scanPair(pairData, config);
                    results.push(...pairResults);
                }

                // Delay between batches (except last)
                if (batchIdx < totalBatches - 1 && !signal.aborted) {
                    await this.delay(BATCH_DELAY_MS);
                }
            }

            // 3. Sort results by freshness (newest first)
            results.sort((a, b) => a.signalAge - b.signalAge);

            return results;
        } finally {
            this.abortController = null;
        }
    }

    /**
     * Cancel an ongoing scan
     */
    cancel(): void {
        this.abortController?.abort();
    }

    /**
     * Check if a scan is currently running
     */
    isScanning(): boolean {
        return this.abortController !== null;
    }

    // ========================================================================
    // Private Methods
    // ========================================================================

    /**
     * Build the universe of pairs to scan
     */
    private async buildUniverse(maxPairs: number): Promise<BinanceSymbol[]> {
        const allSymbols = await binanceSearchService.getAllSymbols();
        // Filter to USDT trading pairs and limit to maxPairs
        return allSymbols
            .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING')
            .slice(0, maxPairs);
    }

    /**
     * Fetch OHLCV data for a batch of pairs
     */
    private async fetchBatch(
        pairs: BinanceSymbol[],
        interval: string,
        signal: AbortSignal
    ): Promise<Map<string, PairScanData>> {
        const results = new Map<string, PairScanData>();

        const fetchPromises = pairs.map(async (pair) => {
            if (signal.aborted) return;

            try {
                // Use public fetchData method which handles all providers
                const data = await dataManager.fetchData(pair.symbol, interval, signal);
                if (data && data.length >= MIN_DATA_BARS) {
                    results.set(pair.symbol, {
                        symbol: pair.symbol,
                        displayName: pair.displayName,
                        data,
                    });
                }
            } catch (err) {
                // Skip pairs that fail to fetch
                console.warn(`Failed to fetch data for ${pair.symbol}:`, err);
            }
        });

        await Promise.all(fetchPromises);
        return results;
    }

    /**
     * Scan a single pair for open positions across all configured strategies.
     * Uses the backtest engine to determine position state - only shows OPEN positions.
     * Closed trades are NOT included.
     */
    private scanPair(pairData: PairScanData, config: ScannerConfig): ScanResult[] {
        const results: ScanResult[] = [];
        const { data, symbol, displayName } = pairData;

        for (const stratConfig of config.strategyConfigs) {
            const strategy = strategyRegistry.get(stratConfig.strategyKey);
            if (!strategy) {
                console.warn(`Strategy not found: ${stratConfig.strategyKey}`);
                continue;
            }

            try {
                // Use saved params from config, fall back to defaults
                const params = { ...strategy.defaultParams, ...stratConfig.strategyParams };
                const rawSignals = strategy.execute(data, params);

                // Get the backtest settings for this strategy
                const backtestSettings = stratConfig.backtestSettings ?? {};

                // Run a backtest simulation to get the current open position (if any)
                const openPosition = getOpenPositionForScanner(data, rawSignals, backtestSettings);

                // Only add to results if there's an open position
                if (openPosition) {
                    // Create a signal-like object from the open position
                    const signal: Signal = {
                        time: openPosition.entryTime,
                        type: openPosition.direction === 'long' ? 'buy' : 'sell',
                        price: openPosition.entryPrice,
                        reason: 'open_position',
                    };

                    results.push({
                        symbol,
                        displayName,
                        strategy: stratConfig.name,
                        signal,
                        currentPrice: openPosition.currentPrice,
                        signalAge: openPosition.barsInTrade,
                        direction: openPosition.direction,
                    });
                }
            } catch (err) {
                console.warn(`Error running ${stratConfig.strategyKey} on ${symbol}:`, err);
            }
        }

        return results;
    }


    /**
     * Estimate remaining scan time
     */
    private estimateRemainingTime(
        processed: number,
        total: number,
        batchDelayMs: number
    ): number {
        const remaining = total - processed;
        const remainingBatches = Math.ceil(remaining / BATCH_SIZE);
        return remainingBatches * batchDelayMs;
    }

    /**
     * Async delay helper
     */
    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

// Export singleton instance
export const scannerEngine = new ScannerEngine();
