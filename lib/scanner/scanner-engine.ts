/**
 * Scanner Engine
 * Core scanning logic for multi-pair signal detection
 */

import { binanceSearchService, type BinanceSymbol } from '../binance-search-service';
import { strategyRegistry } from '../../strategyRegistry';
import { buildConfirmationStates, filterSignalsWithConfirmations, filterSignalsWithConfirmationsBoth } from '../confirmation-strategies';
import type { BacktestSettings, Signal, StrategyParams, TradeDirection, TradeFilterMode } from '../types/strategies';
import { getOpenPositionForScanner } from '../strategies/backtest';
import type {
    ScannerConfig,
    ScanResult,
    ScanProgress,
    PairScanData,
} from '../types/scanner';

// ============================================================================
// Constants
// ============================================================================

const BATCH_SIZE = 15;
const BATCH_DELAY_MS = 300;
const MIN_DATA_BARS = 200;
const DEFAULT_SCAN_LOOKBACK_BARS = 300;
const VALID_TRADE_FILTER_MODES = new Set<TradeFilterMode>(['none', 'close', 'volume', 'rsi', 'trend', 'adx']);
const VALID_TRADE_DIRECTIONS = new Set<TradeDirection>(['long', 'short', 'both', 'combined']);

// ============================================================================
// Scan Result Cache
// ============================================================================

interface CachedPairScan {
    /** Results for this symbol (empty array = scanned, no hits) */
    results: ScanResult[];
    /** Timestamp of the last candle when this was scanned */
    lastCandleTime: number;
    /** When this cache entry was created */
    cachedAt: number;
}

function toBooleanLike(rawValue: unknown): boolean | null {
    if (typeof rawValue === 'boolean') return rawValue;
    if (typeof rawValue !== 'string') return null;

    const normalized = rawValue.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
        return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
        return false;
    }
    return null;
}

function toFiniteNumber(rawValue: unknown): number | null {
    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) return rawValue;
    if (typeof rawValue !== 'string') return null;

    const trimmed = rawValue.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
}

function coerceScalar(rawValue: unknown): unknown {
    const asBoolean = toBooleanLike(rawValue);
    if (asBoolean !== null) return asBoolean;

    const asNumber = toFiniteNumber(rawValue);
    if (asNumber !== null) return asNumber;

    return rawValue;
}

function coerceDeepValue(rawValue: unknown): unknown {
    if (Array.isArray(rawValue)) {
        return rawValue.map((value) => coerceDeepValue(value));
    }
    if (rawValue && typeof rawValue === 'object') {
        const record = rawValue as Record<string, unknown>;
        const normalized: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(record)) {
            normalized[key] = coerceDeepValue(value);
        }
        return normalized;
    }
    return coerceScalar(rawValue);
}

function readBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value !== 0;
    }
    const parsed = toBooleanLike(value);
    return parsed !== null ? parsed : fallback;
}

function readNumber(raw: Record<string, unknown>, key: string, fallback: number): number {
    const parsed = toFiniteNumber(raw[key]);
    return parsed !== null ? parsed : fallback;
}

function readTradeFilterMode(rawValue: unknown, fallback: TradeFilterMode = 'none'): TradeFilterMode {
    if (typeof rawValue === 'string') {
        const mode = rawValue.trim().toLowerCase() as TradeFilterMode;
        if (VALID_TRADE_FILTER_MODES.has(mode)) return mode;
    }
    return fallback;
}

function readTradeDirection(rawValue: unknown, fallback: TradeDirection = 'long'): TradeDirection {
    if (typeof rawValue === 'string') {
        const direction = rawValue.trim().toLowerCase() as TradeDirection;
        if (VALID_TRADE_DIRECTIONS.has(direction)) return direction;
    }
    return fallback;
}

function readConfirmationStrategies(rawValue: unknown): string[] {
    if (!Array.isArray(rawValue)) return [];
    return rawValue.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function readConfirmationParams(rawValue: unknown): Record<string, StrategyParams> {
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
        return {};
    }

    const normalized: Record<string, StrategyParams> = {};
    for (const [strategyKey, params] of Object.entries(rawValue as Record<string, unknown>)) {
        if (!params || typeof params !== 'object' || Array.isArray(params)) continue;
        const normalizedParams: StrategyParams = {};
        for (const [paramKey, paramValue] of Object.entries(params as Record<string, unknown>)) {
            const parsed = toFiniteNumber(paramValue);
            if (parsed !== null) {
                normalizedParams[paramKey] = parsed;
            }
        }
        normalized[strategyKey] = normalizedParams;
    }
    return normalized;
}

function normalizeStrategyParams(defaultParams: StrategyParams, rawParams: unknown): StrategyParams {
    const normalized: StrategyParams = { ...defaultParams };
    if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
        return normalized;
    }

    for (const [key, value] of Object.entries(rawParams as Record<string, unknown>)) {
        const parsed = toFiniteNumber(value);
        if (parsed !== null) {
            normalized[key] = parsed;
        }
    }
    return normalized;
}

function hasUiToggleSettings(raw: Record<string, unknown>): boolean {
    return [
        'riskSettingsToggle',
        'tradeFilterSettingsToggle',
        'entrySettingsToggle',
        'confirmationStrategiesToggle',
        'snapshotAtrFilterToggle',
        'snapshotVolumeFilterToggle',
        'snapshotAdxFilterToggle',
        'snapshotEmaFilterToggle',
        'snapshotRsiFilterToggle',
        'snapshotPriceRangePosFilterToggle',
        'snapshotBarsFromHighFilterToggle',
        'snapshotBarsFromLowFilterToggle',
        'snapshotTrendEfficiencyFilterToggle',
        'snapshotAtrRegimeFilterToggle',
        'snapshotBodyPercentFilterToggle',
        'snapshotWickSkewFilterToggle',
        'snapshotVolumeTrendFilterToggle',
        'snapshotVolumeBurstFilterToggle',
        'snapshotVolumePriceDivergenceFilterToggle',
        'snapshotVolumeConsistencyFilterToggle',
        'snapshotCloseLocationFilterToggle',
        'snapshotOppositeWickFilterToggle',
        'snapshotRangeAtrFilterToggle',
        'snapshotMomentumFilterToggle',
        'snapshotBreakQualityFilterToggle',
        'snapshotTf60PerfFilterToggle',
        'snapshotTf90PerfFilterToggle',
        'snapshotTf120PerfFilterToggle',
        'snapshotTf480PerfFilterToggle',
        'snapshotEntryQualityScoreFilterToggle',
    ].some((key) => key in raw);
}

function readSnapshotValue(
    raw: Record<string, unknown>,
    toggleKey: string,
    valueKey: string
): number {
    return readBoolean(raw, toggleKey, false) ? readNumber(raw, valueKey, 0) : 0;
}

/**
 * Convert persisted UI config into the same effective BacktestSettings shape
 * used by BacktestService.getBacktestSettings().
 */
export function resolveScannerBacktestSettings(settings?: BacktestSettings): BacktestSettings {
    if (!settings) return {};

    const raw = settings as Record<string, unknown>;
    if (!hasUiToggleSettings(raw)) {
        return coerceDeepValue(settings) as BacktestSettings;
    }

    const riskEnabled = readBoolean(raw, 'riskSettingsToggle', false);
    const riskModeRaw = raw['riskMode'];
    const riskMode = riskModeRaw === 'advanced' || riskModeRaw === 'percentage' ? riskModeRaw : 'simple';
    const useAtrRisk = riskEnabled && (riskMode === 'simple' || riskMode === 'advanced');
    const usePercentRisk = riskEnabled && riskMode === 'percentage';

    const tradeFilterEnabled = readBoolean(raw, 'tradeFilterSettingsToggle', readBoolean(raw, 'entrySettingsToggle', false));
    const modeCandidate = raw['tradeFilterMode'] ?? raw['entryConfirmation'];
    const tradeFilterMode = tradeFilterEnabled ? readTradeFilterMode(modeCandidate, 'none') : 'none';

    const confirmationEnabled = readBoolean(raw, 'confirmationStrategiesToggle', false);
    const confirmationStrategies = confirmationEnabled
        ? readConfirmationStrategies(raw['confirmationStrategies'])
        : [];
    const confirmationStrategyParams = confirmationEnabled
        ? readConfirmationParams(raw['confirmationStrategyParams'])
        : {};

    const tradeDirection = readTradeDirection(raw['tradeDirection'], 'long');
    const executionModel = raw['executionModel'];
    const normalizedExecutionModel = executionModel === 'signal_close' || executionModel === 'next_open' || executionModel === 'next_close'
        ? executionModel
        : 'signal_close';

    const marketModeRaw = raw['marketMode'];
    const marketMode = marketModeRaw === 'uptrend' || marketModeRaw === 'downtrend' || marketModeRaw === 'sideway'
        ? marketModeRaw
        : 'all';

    return {
        atrPeriod: readNumber(raw, 'atrPeriod', 14),
        stopLossAtr: useAtrRisk ? readNumber(raw, 'stopLossAtr', 1.5) : 0,
        takeProfitAtr: useAtrRisk ? readNumber(raw, 'takeProfitAtr', 3) : 0,
        trailingAtr: useAtrRisk ? readNumber(raw, 'trailingAtr', 2) : 0,
        partialTakeProfitAtR: riskEnabled && riskMode === 'advanced' ? readNumber(raw, 'partialTakeProfitAtR', 1) : 0,
        partialTakeProfitPercent: riskEnabled && riskMode === 'advanced' ? readNumber(raw, 'partialTakeProfitPercent', 50) : 0,
        breakEvenAtR: riskEnabled && riskMode === 'advanced' ? readNumber(raw, 'breakEvenAtR', 1) : 0,
        timeStopBars: riskEnabled && riskMode === 'advanced' ? readNumber(raw, 'timeStopBars', 0) : 0,
        riskMode,
        stopLossPercent: usePercentRisk ? readNumber(raw, 'stopLossPercent', 5) : 0,
        takeProfitPercent: usePercentRisk ? readNumber(raw, 'takeProfitPercent', 10) : 0,
        stopLossEnabled: usePercentRisk ? readBoolean(raw, 'stopLossEnabled', true) : false,
        takeProfitEnabled: usePercentRisk ? readBoolean(raw, 'takeProfitEnabled', true) : false,
        marketMode,
        tradeFilterMode,
        entryConfirmation: tradeFilterMode,
        confirmLookback: tradeFilterEnabled ? readNumber(raw, 'confirmLookback', 1) : 1,
        volumeSmaPeriod: tradeFilterEnabled ? readNumber(raw, 'volumeSmaPeriod', 20) : 20,
        volumeMultiplier: tradeFilterEnabled ? readNumber(raw, 'volumeMultiplier', 1.5) : 1.5,
        rsiPeriod: tradeFilterEnabled ? readNumber(raw, 'rsiPeriod', readNumber(raw, 'confirmRsiPeriod', 14)) : 14,
        rsiBullish: tradeFilterEnabled ? readNumber(raw, 'rsiBullish', readNumber(raw, 'confirmRsiBullish', 55)) : 55,
        rsiBearish: tradeFilterEnabled ? readNumber(raw, 'rsiBearish', readNumber(raw, 'confirmRsiBearish', 45)) : 45,
        confirmationStrategies,
        confirmationStrategyParams,
        tradeDirection,
        executionModel: normalizedExecutionModel,
        allowSameBarExit: readBoolean(raw, 'allowSameBarExit', false),
        slippageBps: readNumber(raw, 'slippageBps', 5),
        strategyTimeframeEnabled: readBoolean(raw, 'strategyTimeframeEnabled', false),
        strategyTimeframeMinutes: readNumber(raw, 'strategyTimeframeMinutes', 120),
        captureSnapshots: false,
        snapshotAtrPercentMin: readSnapshotValue(raw, 'snapshotAtrFilterToggle', 'snapshotAtrPercentMin'),
        snapshotAtrPercentMax: readSnapshotValue(raw, 'snapshotAtrFilterToggle', 'snapshotAtrPercentMax'),
        snapshotVolumeRatioMin: readSnapshotValue(raw, 'snapshotVolumeFilterToggle', 'snapshotVolumeRatioMin'),
        snapshotVolumeRatioMax: readSnapshotValue(raw, 'snapshotVolumeFilterToggle', 'snapshotVolumeRatioMax'),
        snapshotAdxMin: readSnapshotValue(raw, 'snapshotAdxFilterToggle', 'snapshotAdxMin'),
        snapshotAdxMax: readSnapshotValue(raw, 'snapshotAdxFilterToggle', 'snapshotAdxMax'),
        snapshotEmaDistanceMin: readSnapshotValue(raw, 'snapshotEmaFilterToggle', 'snapshotEmaDistanceMin'),
        snapshotEmaDistanceMax: readSnapshotValue(raw, 'snapshotEmaFilterToggle', 'snapshotEmaDistanceMax'),
        snapshotRsiMin: readSnapshotValue(raw, 'snapshotRsiFilterToggle', 'snapshotRsiMin'),
        snapshotRsiMax: readSnapshotValue(raw, 'snapshotRsiFilterToggle', 'snapshotRsiMax'),
        snapshotPriceRangePosMin: readSnapshotValue(raw, 'snapshotPriceRangePosFilterToggle', 'snapshotPriceRangePosMin'),
        snapshotPriceRangePosMax: readSnapshotValue(raw, 'snapshotPriceRangePosFilterToggle', 'snapshotPriceRangePosMax'),
        snapshotBarsFromHighMax: readSnapshotValue(raw, 'snapshotBarsFromHighFilterToggle', 'snapshotBarsFromHighMax'),
        snapshotBarsFromLowMax: readSnapshotValue(raw, 'snapshotBarsFromLowFilterToggle', 'snapshotBarsFromLowMax'),
        snapshotTrendEfficiencyMin: readSnapshotValue(raw, 'snapshotTrendEfficiencyFilterToggle', 'snapshotTrendEfficiencyMin'),
        snapshotTrendEfficiencyMax: readSnapshotValue(raw, 'snapshotTrendEfficiencyFilterToggle', 'snapshotTrendEfficiencyMax'),
        snapshotAtrRegimeRatioMin: readSnapshotValue(raw, 'snapshotAtrRegimeFilterToggle', 'snapshotAtrRegimeRatioMin'),
        snapshotAtrRegimeRatioMax: readSnapshotValue(raw, 'snapshotAtrRegimeFilterToggle', 'snapshotAtrRegimeRatioMax'),
        snapshotBodyPercentMin: readSnapshotValue(raw, 'snapshotBodyPercentFilterToggle', 'snapshotBodyPercentMin'),
        snapshotBodyPercentMax: readSnapshotValue(raw, 'snapshotBodyPercentFilterToggle', 'snapshotBodyPercentMax'),
        snapshotWickSkewMin: readSnapshotValue(raw, 'snapshotWickSkewFilterToggle', 'snapshotWickSkewMin'),
        snapshotWickSkewMax: readSnapshotValue(raw, 'snapshotWickSkewFilterToggle', 'snapshotWickSkewMax'),
        snapshotVolumeTrendMin: readSnapshotValue(raw, 'snapshotVolumeTrendFilterToggle', 'snapshotVolumeTrendMin'),
        snapshotVolumeTrendMax: readSnapshotValue(raw, 'snapshotVolumeTrendFilterToggle', 'snapshotVolumeTrendMax'),
        snapshotVolumeBurstMin: readSnapshotValue(raw, 'snapshotVolumeBurstFilterToggle', 'snapshotVolumeBurstMin'),
        snapshotVolumeBurstMax: readSnapshotValue(raw, 'snapshotVolumeBurstFilterToggle', 'snapshotVolumeBurstMax'),
        snapshotVolumePriceDivergenceMin: readSnapshotValue(raw, 'snapshotVolumePriceDivergenceFilterToggle', 'snapshotVolumePriceDivergenceMin'),
        snapshotVolumePriceDivergenceMax: readSnapshotValue(raw, 'snapshotVolumePriceDivergenceFilterToggle', 'snapshotVolumePriceDivergenceMax'),
        snapshotVolumeConsistencyMin: readSnapshotValue(raw, 'snapshotVolumeConsistencyFilterToggle', 'snapshotVolumeConsistencyMin'),
        snapshotVolumeConsistencyMax: readSnapshotValue(raw, 'snapshotVolumeConsistencyFilterToggle', 'snapshotVolumeConsistencyMax'),
        snapshotCloseLocationMin: readSnapshotValue(raw, 'snapshotCloseLocationFilterToggle', 'snapshotCloseLocationMin'),
        snapshotCloseLocationMax: readSnapshotValue(raw, 'snapshotCloseLocationFilterToggle', 'snapshotCloseLocationMax'),
        snapshotOppositeWickMin: readSnapshotValue(raw, 'snapshotOppositeWickFilterToggle', 'snapshotOppositeWickMin'),
        snapshotOppositeWickMax: readSnapshotValue(raw, 'snapshotOppositeWickFilterToggle', 'snapshotOppositeWickMax'),
        snapshotRangeAtrMultipleMin: readSnapshotValue(raw, 'snapshotRangeAtrFilterToggle', 'snapshotRangeAtrMultipleMin'),
        snapshotRangeAtrMultipleMax: readSnapshotValue(raw, 'snapshotRangeAtrFilterToggle', 'snapshotRangeAtrMultipleMax'),
        snapshotMomentumConsistencyMin: readSnapshotValue(raw, 'snapshotMomentumFilterToggle', 'snapshotMomentumConsistencyMin'),
        snapshotMomentumConsistencyMax: readSnapshotValue(raw, 'snapshotMomentumFilterToggle', 'snapshotMomentumConsistencyMax'),
        snapshotBreakQualityMin: readSnapshotValue(raw, 'snapshotBreakQualityFilterToggle', 'snapshotBreakQualityMin'),
        snapshotBreakQualityMax: readSnapshotValue(raw, 'snapshotBreakQualityFilterToggle', 'snapshotBreakQualityMax'),
        snapshotTf60PerfMin: readSnapshotValue(raw, 'snapshotTf60PerfFilterToggle', 'snapshotTf60PerfMin'),
        snapshotTf60PerfMax: readSnapshotValue(raw, 'snapshotTf60PerfFilterToggle', 'snapshotTf60PerfMax'),
        snapshotTf90PerfMin: readSnapshotValue(raw, 'snapshotTf90PerfFilterToggle', 'snapshotTf90PerfMin'),
        snapshotTf90PerfMax: readSnapshotValue(raw, 'snapshotTf90PerfFilterToggle', 'snapshotTf90PerfMax'),
        snapshotTf120PerfMin: readSnapshotValue(raw, 'snapshotTf120PerfFilterToggle', 'snapshotTf120PerfMin'),
        snapshotTf120PerfMax: readSnapshotValue(raw, 'snapshotTf120PerfFilterToggle', 'snapshotTf120PerfMax'),
        snapshotTf480PerfMin: readSnapshotValue(raw, 'snapshotTf480PerfFilterToggle', 'snapshotTf480PerfMin'),
        snapshotTf480PerfMax: readSnapshotValue(raw, 'snapshotTf480PerfFilterToggle', 'snapshotTf480PerfMax'),
        snapshotEntryQualityScoreMin: readSnapshotValue(raw, 'snapshotEntryQualityScoreFilterToggle', 'snapshotEntryQualityScoreMin'),
        snapshotEntryQualityScoreMax: readSnapshotValue(raw, 'snapshotEntryQualityScoreFilterToggle', 'snapshotEntryQualityScoreMax'),
    };
}

// ============================================================================
// Scanner Engine Class
// ============================================================================

export class ScannerEngine {
    private abortController: AbortController | null = null;

    /** Per-symbol result cache keyed by `symbol:interval` */
    private scanCache = new Map<string, CachedPairScan>();
    /** Config fingerprint to auto-invalidate cache on config changes */
    private lastConfigFingerprint = '';

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
            // Invalidate cache if config changed since last scan
            const configFp = this.buildConfigFingerprint(config);
            if (configFp !== this.lastConfigFingerprint) {
                this.scanCache.clear();
                this.lastConfigFingerprint = configFp;
            }

            // 1. Build universe
            const pairs = await this.buildUniverse(config.maxPairs);
            if (pairs.length === 0) {
                throw new Error('No trading pairs available');
            }

            const results: ScanResult[] = [];
            const totalBatches = Math.ceil(pairs.length / BATCH_SIZE);
            let processedCount = 0;
            const scanLookbackBars = Number.isFinite(config.scanLookbackBars)
                ? Math.max(MIN_DATA_BARS, Math.floor(config.scanLookbackBars))
                : DEFAULT_SCAN_LOOKBACK_BARS;

            // 2. Process in batches
            for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
                if (signal.aborted) break;

                const batchStart = batchIdx * BATCH_SIZE;
                const batchEnd = Math.min(batchStart + BATCH_SIZE, pairs.length);
                const batch = pairs.slice(batchStart, batchEnd);

                // Fetch data for batch
                const { pairDataMap, hadNetworkFetch } = await this.fetchBatch(batch, config.interval, scanLookbackBars, signal);

                // Process each requested symbol in batch so progress reaches 100%
                // even when some pairs fail to fetch local/remote data.
                for (const pair of batch) {
                    if (signal.aborted) break;

                    processedCount++;
                    const symbol = pair.symbol;

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

                    const pairData = pairDataMap.get(symbol);
                    if (!pairData) {
                        continue;
                    }

                    // ── Phase 3: Delta scan — use cache if data unchanged ─────
                    const cacheKey = `${symbol}:${config.interval}`;
                    const lastCandleTime = this.getCandleTimeNum(pairData.data[pairData.data.length - 1]);
                    const cached = this.scanCache.get(cacheKey);

                    if (cached && cached.lastCandleTime === lastCandleTime) {
                        // Data hasn't changed since last scan — reuse cached results
                        results.push(...cached.results);
                        continue;
                    }

                    // Scan for signals (cache miss or stale)
                    const pairResults = this.scanPair(pairData, config);
                    results.push(...pairResults);

                    // Update cache
                    this.scanCache.set(cacheKey, {
                        results: pairResults,
                        lastCandleTime,
                        cachedAt: Date.now(),
                    });
                }

                // Smart delay: only pause between batches when network was hit
                if (hadNetworkFetch && batchIdx < totalBatches - 1 && !signal.aborted) {
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

    /**
     * Clear the scan result cache. Call when strategy settings change
     * or to force a full re-scan.
     */
    clearCache(): void {
        this.scanCache.clear();
        this.lastConfigFingerprint = '';
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
        lookbackBars: number,
        signal: AbortSignal
    ): Promise<{ pairDataMap: Map<string, PairScanData>; hadNetworkFetch: boolean }> {
        const pairDataMap = new Map<string, PairScanData>();
        const { dataManager } = await import('../data-manager');
        let hadNetworkFetch = false;

        const fetchPromises = pairs.map(async (pair) => {
            if (signal.aborted) return;

            try {
                // Scanner mode: prefer local cache (SQLite/seed) and only refresh
                // from network when cache is stale.
                const data = await dataManager.fetchDataForScan(pair.symbol, interval, signal, lookbackBars);
                if (data && data.length >= MIN_DATA_BARS) {
                    pairDataMap.set(pair.symbol, {
                        symbol: pair.symbol,
                        displayName: pair.displayName,
                        data,
                    });
                }
            } catch (err) {
                // Network fetch attempted but failed — flag it
                hadNetworkFetch = true;
                console.warn(`Failed to fetch data for ${pair.symbol}:`, err);
            }
        });

        await Promise.all(fetchPromises);
        return { pairDataMap, hadNetworkFetch };
    }

    /**
     * Scan a single pair for open positions across all configured strategies.
     * Uses the backtest engine to determine position state - only shows OPEN positions.
     * Closed trades are NOT included.
     *
     * Phase 2 optimization: before running a full backtest, check if any signal
     * is recent enough to possibly produce a fresh open position. If the newest
     * signal is too old, skip the expensive backtest entirely.
     */
    private scanPair(pairData: PairScanData, config: ScannerConfig): ScanResult[] {
        const results: ScanResult[] = [];
        const { data, symbol, displayName } = pairData;
        const dataLen = data.length;
        if (dataLen === 0) return results;

        const maxSignalAgeBars = Number.isFinite(config.signalFreshnessBars)
            ? Math.max(0, Math.floor(config.signalFreshnessBars))
            : Number.POSITIVE_INFINITY;

        for (const stratConfig of config.strategyConfigs) {
            const strategy = strategyRegistry.get(stratConfig.strategyKey);
            if (!strategy) {
                console.warn(`Strategy not found: ${stratConfig.strategyKey}`);
                continue;
            }

            try {
                // Use saved params from config, fall back to defaults
                const params = normalizeStrategyParams(strategy.defaultParams, stratConfig.strategyParams);
                const rawSignals = strategy.execute(data, params);

                // Early exit: no signals at all → skip
                if (rawSignals.length === 0) continue;

                // Normalize persisted UI config into effective backtest settings.
                const backtestSettings = resolveScannerBacktestSettings(stratConfig.backtestSettings);

                // Apply confirmation-strategy filtering to match backtest flow.
                const confirmationStrategies = backtestSettings.confirmationStrategies ?? [];
                const tradeFilterMode = readTradeFilterMode(
                    backtestSettings.tradeFilterMode ?? backtestSettings.entryConfirmation ?? 'none',
                    'none'
                );
                const confirmationStates = confirmationStrategies.length > 0
                    ? buildConfirmationStates(data, confirmationStrategies, backtestSettings.confirmationStrategyParams)
                    : [];
                const filteredSignals = confirmationStates.length > 0
                    ? ((strategy.metadata?.role === 'entry' || backtestSettings.tradeDirection === 'both' || backtestSettings.tradeDirection === 'combined')
                        ? filterSignalsWithConfirmationsBoth(data, rawSignals, confirmationStates, tradeFilterMode)
                        : filterSignalsWithConfirmations(
                            data,
                            rawSignals,
                            confirmationStates,
                            tradeFilterMode,
                            backtestSettings.tradeDirection ?? 'long'
                        ))
                    : rawSignals;

                // Early exit: no filtered signals → skip
                if (filteredSignals.length === 0) continue;

                // ── Phase 2: Early exit if newest signal is too old ───────────
                // A position opened N bars ago has barsInTrade = N. If the most
                // recent signal is older than maxSignalAgeBars, no position from
                // it can pass the freshness check, so we skip the full backtest.
                if (maxSignalAgeBars < Number.POSITIVE_INFINITY) {
                    const lastSignal = filteredSignals[filteredSignals.length - 1];
                    const lastSignalTime = lastSignal.time;
                    const lastBarTime = data[dataLen - 1].time;

                    // Compare times (both are numeric epoch seconds or ms)
                    const sigT = typeof lastSignalTime === 'number' ? lastSignalTime : Number(lastSignalTime);
                    const barT = typeof lastBarTime === 'number' ? lastBarTime : Number(lastBarTime);

                    if (Number.isFinite(sigT) && Number.isFinite(barT) && sigT < barT) {
                        // Find bar index of last signal by reverse-scanning
                        let lastSignalBarIdx = dataLen - 1;
                        for (let i = dataLen - 1; i >= 0; i--) {
                            const t = typeof data[i].time === 'number'
                                ? data[i].time as number
                                : Number(data[i].time);
                            if (t <= sigT) {
                                lastSignalBarIdx = i;
                                break;
                            }
                        }

                        const barsFromEnd = dataLen - 1 - lastSignalBarIdx;
                        if (barsFromEnd > maxSignalAgeBars) {
                            continue; // Signal too old, no fresh open position possible
                        }
                    }
                }

                // Run a backtest simulation to get the current open position (if any)
                const openPosition = getOpenPositionForScanner(data, filteredSignals, backtestSettings);

                // Only add to results if there's an open and fresh-enough position
                if (openPosition && openPosition.barsInTrade <= maxSignalAgeBars) {
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
                        strategyKey: stratConfig.strategyKey,
                        signal,
                        currentPrice: openPosition.currentPrice,
                        signalAge: openPosition.barsInTrade,
                        direction: openPosition.direction,
                        targetPrice: openPosition.takeProfitPrice,
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

    /**
     * Extract numeric timestamp from a candle's time field.
     */
    private getCandleTimeNum(candle: { time: unknown }): number {
        const t = candle.time;
        return typeof t === 'number' ? t : Number(t) || 0;
    }

    /**
     * Build a fingerprint string from config so we can detect changes.
     * Only includes fields that affect scan results.
     */
    private buildConfigFingerprint(config: ScannerConfig): string {
        return JSON.stringify([
            config.interval,
            config.maxPairs,
            config.signalFreshnessBars,
            config.scanLookbackBars,
            config.strategyConfigs.map(sc => [
                sc.strategyKey,
                sc.name,
                sc.strategyParams,
                sc.backtestSettings,
            ]),
        ]);
    }
}

// Export singleton instance
export const scannerEngine = new ScannerEngine();

