/**
 * Cross-symbol runtime resolver.
 *
 * Single shared helper that every supported runtime (backtest, Finder, WFA,
 * Polymarket evaluator) should call to resolve cross-symbol execution inputs.
 *
 * This module is the only place that fetches secondary data, aligns it to the
 * primary, and trims leading bars. Strategies never fetch data themselves.
 */

import type {
    BacktestSettings,
    OHLCVData,
    Strategy,
    StrategyExecutionContext,
} from './types/strategies';
import {
    alignSecondaryToPrimary,
    CrossSymbolAlignmentError,
    trimAlignedPair,
} from './strategies/lib/cross-symbol-helpers';

// ============================================================================
// Public API
// ============================================================================

export interface ResolvedCrossSymbolExecution {
    /** Primary data, possibly trimmed to align with the secondary. */
    primaryData: OHLCVData[];
    /** Execution context to pass into strategy.execute / prepareFinderData / executePrepared. */
    context?: StrategyExecutionContext;
}

export interface CrossSymbolDataFetcher {
    getProvider(symbol: string): string;
    fetchDataDetached(symbol: string, interval: string): Promise<OHLCVData[]>;
}

export interface ResolveCrossSymbolArgs {
    strategy: Strategy;
    primarySymbol: string;
    interval: string;
    primaryData: OHLCVData[];
    settings: BacktestSettings;
    dataFetcher: CrossSymbolDataFetcher;
}

/**
 * Resolve the effective secondary symbol for a cross-symbol strategy from the
 * current settings, or return null when the strategy is not cross-symbol.
 */
export function resolveCrossSymbolSecondaryForStrategy(
    strategy: Strategy,
    settings: Pick<BacktestSettings, "crossSymbolSecondary">
): string | null {
    const config = strategy.crossSymbolConfig;
    if (!config) {
        return null;
    }
    return resolveSecondarySymbol(settings.crossSymbolSecondary, config.defaultSymbol);
}

/**
 * Resolve cross-symbol execution inputs for a strategy.
 *
 * If the strategy does not declare `crossSymbolConfig`, returns the original
 * primary data with no context — existing single-symbol strategies are
 * completely unaffected.
 *
 * Steps:
 * 1. Read `strategy.crossSymbolConfig`
 * 2. Resolve `crossSymbolSecondary ?? defaultSymbol`
 * 3. Reject `primary === secondary`
 * 4. Reject provider mismatch
 * 5. Fetch secondary bars with the same interval
 * 6. Align secondary to primary by causal LOCF
 * 7. Trim leading bars until both arrays are fully populated
 * 8. Reject when aligned length is below `minBars`
 * 9. Return trimmed primary + context
 */
export async function resolveCrossSymbolExecution(
    args: ResolveCrossSymbolArgs
): Promise<ResolvedCrossSymbolExecution> {
    const { strategy, primarySymbol, interval, primaryData, settings, dataFetcher } = args;
    const config = strategy.crossSymbolConfig;

    // No cross-symbol config: pass through unchanged.
    if (!config) {
        return { primaryData };
    }

    // --- 1. Reject incompatible combinations ---
    if (settings.strategyTimeframeEnabled) {
        throw new CrossSymbolAlignmentError(
            'Cross-symbol strategies cannot be used with strategy timeframe resampling. ' +
            'Disable "Strategy Timeframe" before running this strategy.'
        );
    }

    // --- 2. Resolve secondary symbol ---
    const secondarySymbol = resolveCrossSymbolSecondaryForStrategy(strategy, settings);
    if (!secondarySymbol) {
        return { primaryData };
    }

    // --- 3. Reject primary === secondary ---
    const normalizedPrimary = primarySymbol.trim().toUpperCase();
    const normalizedSecondary = secondarySymbol.trim().toUpperCase();
    if (normalizedPrimary === normalizedSecondary) {
        throw new CrossSymbolAlignmentError(
            `Secondary symbol "${normalizedSecondary}" cannot be the same as the primary symbol "${normalizedPrimary}".`
        );
    }

    // --- 4. Reject provider mismatch ---
    const primaryProvider = dataFetcher.getProvider(normalizedPrimary);
    const secondaryProvider = dataFetcher.getProvider(normalizedSecondary);
    if (primaryProvider !== secondaryProvider) {
        throw new CrossSymbolAlignmentError(
            `Provider mismatch: primary "${normalizedPrimary}" uses "${primaryProvider}" ` +
            `but secondary "${normalizedSecondary}" uses "${secondaryProvider}". ` +
            'Cross-symbol strategies require both symbols from the same data provider.'
        );
    }

    // --- 5. Fetch secondary bars ---
    const secondaryData = await dataFetcher.fetchDataDetached(
        normalizedSecondary,
        interval
    );

    if (secondaryData.length === 0) {
        throw new CrossSymbolAlignmentError(
            `No data available for secondary symbol "${normalizedSecondary}" on interval "${interval}".`
        );
    }

    // --- 6. Align secondary to primary ---
    const aligned = alignSecondaryToPrimary(primaryData, secondaryData);

    // --- 7 & 8. Trim leading nulls and check minBars ---
    const minBars = config.minBars ?? 50;
    const trimmed = trimAlignedPair(primaryData, aligned, minBars);

    // --- 9. Return trimmed primary + context ---
    return {
        primaryData: trimmed.primaryData,
        context: {
            crossSymbol: {
                primarySymbol: normalizedPrimary,
                secondarySymbol: normalizedSecondary,
                secondaryData: trimmed.secondaryData,
                alignedLength: trimmed.primaryData.length,
                trimmedLeadingBars: trimmed.trimmedLeadingBars,
            },
        },
    };
}

// ============================================================================
// Synchronous variant for pre-fetched secondary data
// ============================================================================

export interface ResolveCrossSymbolSyncArgs {
    strategy: Strategy;
    primarySymbol: string;
    primaryData: OHLCVData[];
    secondarySymbol: string;
    secondaryData: OHLCVData[];
    settings: BacktestSettings;
}

/**
 * Synchronous cross-symbol resolution for callers that already have secondary
 * data fetched (Finder, WFA where secondary is fetched once per run).
 */
export function resolveCrossSymbolExecutionSync(
    args: ResolveCrossSymbolSyncArgs
): ResolvedCrossSymbolExecution {
    const { strategy, primarySymbol, primaryData, secondarySymbol, secondaryData, settings } = args;
    const config = strategy.crossSymbolConfig;

    if (!config) {
        return { primaryData };
    }

    if (settings.strategyTimeframeEnabled) {
        throw new CrossSymbolAlignmentError(
            'Cross-symbol strategies cannot be used with strategy timeframe resampling.'
        );
    }

    const normalizedPrimary = primarySymbol.trim().toUpperCase();
    const normalizedSecondary = secondarySymbol.trim().toUpperCase();
    if (normalizedPrimary === normalizedSecondary) {
        throw new CrossSymbolAlignmentError(
            `Secondary symbol "${normalizedSecondary}" cannot be the same as the primary symbol.`
        );
    }

    const aligned = alignSecondaryToPrimary(primaryData, secondaryData);
    const minBars = config.minBars ?? 50;
    const trimmed = trimAlignedPair(primaryData, aligned, minBars);

    return {
        primaryData: trimmed.primaryData,
        context: {
            crossSymbol: {
                primarySymbol: normalizedPrimary,
                secondarySymbol: normalizedSecondary,
                secondaryData: trimmed.secondaryData,
                alignedLength: trimmed.primaryData.length,
                trimmedLeadingBars: trimmed.trimmedLeadingBars,
            },
        },
    };
}

// ============================================================================
// Guards for unsupported surfaces
// ============================================================================

/**
 * Returns true if the strategy requires cross-symbol data.
 */
export function isCrossSymbolStrategy(strategy: Strategy): boolean {
    return strategy.crossSymbolConfig != null;
}

/**
 * Guard helper for unsupported surfaces. Throws a user-facing error if the
 * strategy is cross-symbol and the surface is not supported.
 */
export function guardCrossSymbolUnsupported(
    strategy: Strategy,
    surfaceName: string
): void {
    if (isCrossSymbolStrategy(strategy)) {
        throw new Error(
            `"${strategy.name}" is a cross-symbol strategy and is not supported in ${surfaceName}. ` +
            'Cross-symbol strategies require secondary symbol data that this feature does not provide.'
        );
    }
}

// ============================================================================
// Internal helpers
// ============================================================================

function resolveSecondarySymbol(
    override: string | undefined,
    defaultSymbol: string
): string {
    const resolved = override?.trim().toUpperCase();
    if (resolved && resolved.length > 0) {
        return resolved;
    }
    return defaultSymbol.trim().toUpperCase();
}
