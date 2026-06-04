import type { UiBacktestEndpointSnapshot } from "./backtest-endpoint-copy";
import {
    isSameEventPolymarketExitMode,
    resolveEffectivePolymarketExitMode,
    type PolymarketExitMode,
} from "./polymarket-exit-mode";
import { parseTimeToUnixSeconds } from "./time-normalization";
import type { BacktestResult, BacktestSettings, Time, Trade } from "./types/strategies";

export type BacktestDiagnosticSeverity = "info" | "warning";

export interface BacktestDiagnosticWarning {
    code: string;
    severity: BacktestDiagnosticSeverity;
    message: string;
}

export interface BacktestDiagnosticCountRow {
    key: string;
    count: number;
    pct: number;
}

export interface BacktestDiagnosticTradeExample {
    id: number;
    type: Trade["type"];
    entryTimeSec: number | null;
    exitTimeSec: number | null;
    chartExitReason: string;
    polymarketExitSource: string | null;
    polymarketEntryPrice: number | null;
    polymarketExitPrice: number | null;
    polymarketExitTimeSec: number | null;
    eventStartTs: number | null;
    eventEndTs: number | null;
}

export interface BacktestDiagnosticPolymarketFilters {
    entryPriceFilterCents?: number;
    entryPriceAllowedRange?: { minExclusive: number; maxExclusive: number } | null;
    backtestSlippageCents?: number;
    entryCutoffEnabled?: boolean;
    entryCutoffSeconds?: number;
    allowMultipleTradesPerEvent?: boolean;
    postSignalLimitEntryEnabled?: boolean;
    postSignalLimitEntryMode?: string;
    postSignalLimitEntryPriceCents?: number;
    postSignalLimitEntryOffsetCents?: number;
    postSignalLimitExitEnabled?: boolean;
    postSignalLimitExitMode?: string;
    postSignalLimitExitPriceCents?: number;
    postSignalLimitExitOffsetCents?: number;
    protectionTakeProfitEnabled?: boolean;
    protectionTakeProfitCents?: number;
    protectionStopLossEnabled?: boolean;
    protectionStopLossCents?: number;
}

export interface BacktestDiagnosticEntryPriceFilterBreakdown {
    low: number;
    high: number;
    unknown: number;
    minEntryPrice: number | null;
    maxEntryPrice: number | null;
    avgEntryPrice: number | null;
}

export interface BacktestDiagnosticOutput {
    schema: "backtest.diagnostics.v1";
    generatedAtIso: string;
    run: {
        source?: string;
        symbol?: string;
        interval?: string;
        strategyKey?: string;
        engineUsed?: string;
        executionModel?: string;
        tradeDirection?: string;
        candleCount?: number;
        firstCandleTimeSec: number | null;
        lastCandleTimeSec: number | null;
        totalTrades: number;
        winRate: number;
        netProfit: number;
        blockRange?: { from: number; to: number } | null;
    };
    chartExits: {
        counts: Record<string, number>;
        top: BacktestDiagnosticCountRow[];
        signalTrades: number;
        nonSignalTrades: number;
    };
    polymarket: {
        annotationEnabled: boolean | null;
        requestedExitMode?: PolymarketExitMode;
        effectiveExitMode?: PolymarketExitMode;
        storedEvaluationMode?: PolymarketExitMode;
        outcomeInterval?: string;
        entrySelectionMode?: string;
        scoredTrades: number | null;
        unscoredTrades: number | null;
        missingOutcomeTrades: number | null;
        scoredPct: number | null;
        unscoredPct: number | null;
        filters: BacktestDiagnosticPolymarketFilters;
        exitSourceCounts: Record<string, number>;
        exitSourceTop: BacktestDiagnosticCountRow[];
        entryStatusCounts: Record<string, number>;
        entryPriceFilterBreakdown: BacktestDiagnosticEntryPriceFilterBreakdown;
        chartExitReasonsForResolvedSameEventExit: Record<string, number>;
        chartExitReasonsForResolvedSameEventExitTop: BacktestDiagnosticCountRow[];
        chartExitReasonsForResolvedSignalExit: Record<string, number>;
        chartExitReasonsForResolvedSignalExitTop: BacktestDiagnosticCountRow[];
        sameEventExitedTrades: number;
        chartExitedTrades: number;
        signalExitedTrades: number;
        resolvedTrades: number;
        missingPriceTrades: number;
        duplicateTradesIgnored: number;
        openPositionBlockedTrades: number;
        entryPriceFilteredTrades: number;
        entryTimeFilteredTrades: number;
        unscoredExamplesBySource: Record<string, BacktestDiagnosticTradeExample[]>;
        examples: BacktestDiagnosticTradeExample[];
    } | null;
    engineDiagnostics?: BacktestResult["diagnostics"];
    warnings: BacktestDiagnosticWarning[];
    recommendations: string[];
}

export interface BuildBacktestDiagnosticOutputInput {
    result: BacktestResult;
    snapshot?: UiBacktestEndpointSnapshot | null;
    resultSource?: string;
    generatedAtIso?: string;
    maxExamples?: number;
}

const UNSCORED_POLYMARKET_EXIT_SOURCES = new Set([
    "duplicate",
    "open_position",
    "filtered",
    "entry_price_filtered",
    "entry_time_filtered",
    "no_event",
    "missing",
]);

function incrementCount(counts: Record<string, number>, key: string): void {
    counts[key] = (counts[key] ?? 0) + 1;
}

function toCountRows(counts: Record<string, number>, total: number): BacktestDiagnosticCountRow[] {
    const denominator = Math.max(1, total);
    return Object.entries(counts)
        .map(([key, count]) => ({
            key,
            count,
            pct: Number(((count / denominator) * 100).toFixed(2)),
        }))
        .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function roundPct(value: number): number {
    return Number((value * 100).toFixed(2));
}

function roundPrice(value: number): number {
    return Number(value.toFixed(4));
}

function timeToDiagnosticSeconds(time: Time | null | undefined): number | null {
    if (time === null || time === undefined) {
        return null;
    }
    return parseTimeToUnixSeconds(time);
}

function resolveAnnotationEnabled(settings: BacktestSettings | undefined, result: BacktestResult): boolean | null {
    if (typeof settings?.polymarketAnnotationEnabled === "boolean") {
        return settings.polymarketAnnotationEnabled;
    }
    if (result.polymarketTradeSummary || result.trades.some((trade) => trade.polymarketOutcome !== undefined)) {
        return true;
    }
    return null;
}

function resolveStoredEvaluationMode(result: BacktestResult): PolymarketExitMode | undefined {
    const summaryMode = result.polymarketTradeSummary?.evaluationMode;
    if (summaryMode) {
        return summaryMode;
    }

    for (const trade of result.trades) {
        const mode = trade.polymarketOutcome?.evaluationMode;
        if (mode) {
            return mode;
        }
    }

    return undefined;
}

function buildTradeExample(trade: Trade): BacktestDiagnosticTradeExample {
    const outcome = trade.polymarketOutcome;
    return {
        id: trade.id,
        type: trade.type,
        entryTimeSec: timeToDiagnosticSeconds(trade.entryTime),
        exitTimeSec: timeToDiagnosticSeconds(trade.exitTime),
        chartExitReason: trade.exitReason ?? "unknown",
        polymarketExitSource: outcome?.marketExitSource ?? null,
        polymarketEntryPrice: typeof outcome?.marketEntryPrice === "number" && Number.isFinite(outcome.marketEntryPrice)
            ? outcome.marketEntryPrice
            : null,
        polymarketExitPrice: typeof outcome?.marketExitPrice === "number" && Number.isFinite(outcome.marketExitPrice)
            ? outcome.marketExitPrice
            : null,
        polymarketExitTimeSec: typeof outcome?.marketExitTs === "number" && Number.isFinite(outcome.marketExitTs)
            ? outcome.marketExitTs
            : null,
        eventStartTs: typeof outcome?.eventStartTs === "number" && Number.isFinite(outcome.eventStartTs)
            ? outcome.eventStartTs
            : null,
        eventEndTs: typeof outcome?.eventEndTs === "number" && Number.isFinite(outcome.eventEndTs)
            ? outcome.eventEndTs
            : null,
    };
}

function buildChartExitDiagnostics(trades: readonly Trade[]): BacktestDiagnosticOutput["chartExits"] {
    const counts: Record<string, number> = {};
    for (const trade of trades) {
        incrementCount(counts, trade.exitReason ?? "unknown");
    }

    const signalTrades = counts.signal ?? 0;
    return {
        counts,
        top: toCountRows(counts, trades.length),
        signalTrades,
        nonSignalTrades: Math.max(0, trades.length - signalTrades),
    };
}

function resolveDiagnosticPolymarketExitSource(
    trade: Trade,
    storedEvaluationMode: PolymarketExitMode | undefined
): string {
    const outcome = trade.polymarketOutcome;
    const source = outcome?.marketExitSource ?? "unknown";
    const evaluationMode = outcome?.evaluationMode ?? storedEvaluationMode;
    if (
        evaluationMode === "chart_exit_same_event"
        && source === "signal"
        && trade.exitReason !== "signal"
    ) {
        return "chart_exit";
    }
    return source;
}

function buildPolymarketFilters(
    settings: BacktestSettings | undefined,
    summary: BacktestResult["polymarketTradeSummary"] | undefined
): BacktestDiagnosticPolymarketFilters {
    const entryPriceFilterCents = settings?.polymarketEntryPriceFilterCents;
    const entryPriceAllowedRange = typeof entryPriceFilterCents === "number" && entryPriceFilterCents > 0
        ? {
            minExclusive: roundPrice(entryPriceFilterCents / 100),
            maxExclusive: roundPrice(1 - entryPriceFilterCents / 100),
        }
        : null;
    return {
        entryPriceFilterCents,
        entryPriceAllowedRange,
        backtestSlippageCents: settings?.polymarketBacktestSlippageCents ?? summary?.backtestSlippageCents,
        entryCutoffEnabled: settings?.polymarketEntryCutoffEnabled,
        entryCutoffSeconds: settings?.polymarketEntryCutoffSeconds,
        allowMultipleTradesPerEvent: settings?.polymarketSignalExitAllowMultipleTradesPerEvent
            ?? summary?.signalExitAllowMultipleTradesPerEvent,
        postSignalLimitEntryEnabled: settings?.polymarketPostSignalLimitEntryEnabled ?? summary?.limitEntryEnabled,
        postSignalLimitEntryMode: settings?.polymarketPostSignalLimitEntryMode ?? summary?.limitEntryMode,
        postSignalLimitEntryPriceCents: settings?.polymarketPostSignalLimitEntryPriceCents ?? summary?.limitEntryPriceCents,
        postSignalLimitEntryOffsetCents: settings?.polymarketPostSignalLimitEntryOffsetCents ?? summary?.limitEntryOffsetCents,
        postSignalLimitExitEnabled: settings?.polymarketPostSignalLimitExitEnabled ?? summary?.limitExitEnabled,
        postSignalLimitExitMode: settings?.polymarketPostSignalLimitExitMode ?? summary?.limitExitMode,
        postSignalLimitExitPriceCents: settings?.polymarketPostSignalLimitExitPriceCents ?? summary?.limitExitPriceCents,
        postSignalLimitExitOffsetCents: settings?.polymarketPostSignalLimitExitOffsetCents ?? summary?.limitExitOffsetCents,
        protectionTakeProfitEnabled: settings?.polymarketProtectionTakeProfitEnabled ?? summary?.protectionTakeProfitEnabled,
        protectionTakeProfitCents: settings?.polymarketProtectionTakeProfitCents ?? summary?.protectionTakeProfitCents,
        protectionStopLossEnabled: settings?.polymarketProtectionStopLossEnabled ?? summary?.protectionStopLossEnabled,
        protectionStopLossCents: settings?.polymarketProtectionStopLossCents ?? summary?.protectionStopLossCents,
    };
}

function buildEntryPriceFilterBreakdown(
    trades: readonly Trade[],
    storedEvaluationMode: PolymarketExitMode | undefined,
    entryPriceFilterCents: number | undefined
): BacktestDiagnosticEntryPriceFilterBreakdown {
    let low = 0;
    let high = 0;
    let unknown = 0;
    let count = 0;
    let total = 0;
    let minEntryPrice = Infinity;
    let maxEntryPrice = -Infinity;
    const lower = typeof entryPriceFilterCents === "number" && entryPriceFilterCents > 0
        ? entryPriceFilterCents / 100
        : null;
    const upper = lower !== null ? 1 - lower : null;

    for (const trade of trades) {
        if (resolveDiagnosticPolymarketExitSource(trade, storedEvaluationMode) !== "entry_price_filtered") {
            continue;
        }
        const entryPrice = trade.polymarketOutcome?.marketEntryPrice;
        if (typeof entryPrice !== "number" || !Number.isFinite(entryPrice)) {
            unknown++;
            continue;
        }
        count++;
        total += entryPrice;
        minEntryPrice = Math.min(minEntryPrice, entryPrice);
        maxEntryPrice = Math.max(maxEntryPrice, entryPrice);
        if (lower !== null && entryPrice <= lower) {
            low++;
        } else if (upper !== null && entryPrice >= upper) {
            high++;
        } else {
            unknown++;
        }
    }

    return {
        low,
        high,
        unknown,
        minEntryPrice: count > 0 ? roundPrice(minEntryPrice) : null,
        maxEntryPrice: count > 0 ? roundPrice(maxEntryPrice) : null,
        avgEntryPrice: count > 0 ? roundPrice(total / count) : null,
    };
}

function deriveScoredPolymarketTrades(trades: readonly Trade[]): number {
    let scoredTrades = 0;
    for (const trade of trades) {
        const source = trade.polymarketOutcome?.marketExitSource;
        if (!trade.polymarketOutcome || !source || UNSCORED_POLYMARKET_EXIT_SOURCES.has(source)) {
            continue;
        }
        scoredTrades++;
    }
    return scoredTrades;
}

function buildPolymarketDiagnostics(
    result: BacktestResult,
    snapshot: UiBacktestEndpointSnapshot | null | undefined,
    effectiveExitMode: PolymarketExitMode | undefined,
    storedEvaluationMode: PolymarketExitMode | undefined,
    annotationEnabled: boolean | null,
    maxExamples: number
): NonNullable<BacktestDiagnosticOutput["polymarket"]> | null {
    const hasPolymarketData = Boolean(result.polymarketTradeSummary)
        || result.trades.some((trade) => trade.polymarketOutcome !== undefined);
    if (!hasPolymarketData && !snapshot?.backtestSettings?.polymarketAnnotationEnabled) {
        return null;
    }

    const summary = result.polymarketTradeSummary;
    const filters = buildPolymarketFilters(snapshot?.backtestSettings, summary);
    const exitSourceCounts: Record<string, number> = {};
    const entryStatusCounts: Record<string, number> = {};
    const chartExitReasonsForResolvedSameEventExit: Record<string, number> = {};
    const unscoredExamplesBySource: Record<string, BacktestDiagnosticTradeExample[]> = {};
    const examples: BacktestDiagnosticTradeExample[] = [];
    const maxExamplesPerSource = Math.max(1, Math.min(5, maxExamples));

    for (const trade of result.trades) {
        const outcome = trade.polymarketOutcome;
        if (!outcome) {
            continue;
        }

        const exitSource = resolveDiagnosticPolymarketExitSource(trade, storedEvaluationMode);
        incrementCount(exitSourceCounts, exitSource);
        if (UNSCORED_POLYMARKET_EXIT_SOURCES.has(exitSource)) {
            const sourceExamples = unscoredExamplesBySource[exitSource] ?? [];
            if (sourceExamples.length < maxExamplesPerSource) {
                sourceExamples.push(buildTradeExample(trade));
                unscoredExamplesBySource[exitSource] = sourceExamples;
            }
        }

        if (outcome.marketEntryStatus) {
            incrementCount(entryStatusCounts, outcome.marketEntryStatus);
        }

        const isResolvedSignalExit = isSameEventPolymarketExitMode(outcome.evaluationMode ?? storedEvaluationMode)
            && outcome.marketExitSource === "resolution";
        if (isResolvedSignalExit) {
            incrementCount(chartExitReasonsForResolvedSameEventExit, trade.exitReason ?? "unknown");
            if (examples.length < maxExamples) {
                examples.push(buildTradeExample(trade));
            }
        }
    }

    const derivedScoredTrades = deriveScoredPolymarketTrades(result.trades);
    const resolvedTrades = summary?.resolvedTrades ?? (exitSourceCounts.resolution ?? 0);
    const normalizedSignalExitedTrades = exitSourceCounts.signal ?? 0;
    const chartExitedTrades = exitSourceCounts.chart_exit ?? 0;
    const sameEventExitedTrades = summary?.signalExitedTrades ?? (normalizedSignalExitedTrades + chartExitedTrades);
    const signalExitedTrades = storedEvaluationMode === "chart_exit_same_event"
        ? normalizedSignalExitedTrades
        : summary?.signalExitedTrades ?? normalizedSignalExitedTrades;
    const missingPriceTrades = summary?.missingPriceTrades ?? (exitSourceCounts.missing ?? 0);
    const duplicateTradesIgnored = summary?.duplicateTradesIgnored ?? (exitSourceCounts.duplicate ?? 0);
    const openPositionBlockedTrades = exitSourceCounts.open_position ?? 0;
    const entryPriceFilteredTrades = summary?.entryPriceFilteredTrades ?? (exitSourceCounts.entry_price_filtered ?? 0);
    const entryTimeFilteredTrades = summary?.entryTimeFilteredTrades ?? (exitSourceCounts.entry_time_filtered ?? 0);
    const scoredTrades = summary?.scoredTrades ?? (derivedScoredTrades > 0 ? derivedScoredTrades : null);
    const unscoredTrades = summary?.unscoredTrades ?? null;
    const coverageBase = (scoredTrades ?? 0) + (unscoredTrades ?? 0);
    const entryPriceFilterBreakdown = buildEntryPriceFilterBreakdown(
        result.trades,
        storedEvaluationMode,
        filters.entryPriceFilterCents
    );

    return {
        annotationEnabled,
        requestedExitMode: snapshot?.backtestSettings?.polymarketExitMode,
        effectiveExitMode,
        storedEvaluationMode,
        outcomeInterval: summary?.outcomeInterval ?? snapshot?.backtestSettings?.polymarketOutcomeInterval,
        entrySelectionMode: summary?.entrySelectionMode ?? snapshot?.backtestSettings?.polymarketEntrySelectionMode,
        scoredTrades,
        unscoredTrades,
        missingOutcomeTrades: summary?.missingOutcomeTrades ?? null,
        scoredPct: coverageBase > 0 && scoredTrades !== null ? roundPct(scoredTrades / coverageBase) : null,
        unscoredPct: coverageBase > 0 && unscoredTrades !== null ? roundPct(unscoredTrades / coverageBase) : null,
        filters,
        exitSourceCounts,
        exitSourceTop: toCountRows(exitSourceCounts, Math.max(1, Object.values(exitSourceCounts).reduce((sum, value) => sum + value, 0))),
        entryStatusCounts,
        entryPriceFilterBreakdown,
        chartExitReasonsForResolvedSameEventExit,
        chartExitReasonsForResolvedSameEventExitTop: toCountRows(
            chartExitReasonsForResolvedSameEventExit,
            Math.max(1, resolvedTrades)
        ),
        chartExitReasonsForResolvedSignalExit: chartExitReasonsForResolvedSameEventExit,
        chartExitReasonsForResolvedSignalExitTop: toCountRows(
            chartExitReasonsForResolvedSameEventExit,
            Math.max(1, resolvedTrades)
        ),
        sameEventExitedTrades,
        chartExitedTrades,
        signalExitedTrades,
        resolvedTrades,
        missingPriceTrades,
        duplicateTradesIgnored,
        openPositionBlockedTrades,
        entryPriceFilteredTrades,
        entryTimeFilteredTrades,
        unscoredExamplesBySource,
        examples,
    };
}

function addWarning(
    warnings: BacktestDiagnosticWarning[],
    code: string,
    severity: BacktestDiagnosticSeverity,
    message: string
): void {
    warnings.push({ code, severity, message });
}

function formatTopReasons(rows: readonly BacktestDiagnosticCountRow[]): string {
    return rows
        .slice(0, 3)
        .map((row) => `${row.key}: ${row.count}`)
        .join(", ");
}

function filterCountRows(
    rows: readonly BacktestDiagnosticCountRow[],
    excludedKeys: ReadonlySet<string>
): BacktestDiagnosticCountRow[] {
    return rows.filter((row) => !excludedKeys.has(row.key));
}

function sumCountRows(rows: readonly BacktestDiagnosticCountRow[]): number {
    return rows.reduce((sum, row) => sum + row.count, 0);
}

function formatEntryPriceFilterDirection(breakdown: BacktestDiagnosticEntryPriceFilterBreakdown): string {
    const directionalCount = breakdown.high + breakdown.low;
    if (directionalCount <= 0) {
        return `unknown-side entries (${breakdown.unknown} unknown)`;
    }

    const highShare = breakdown.high / directionalCount;
    const lowShare = breakdown.low / directionalCount;
    if (highShare >= 2 / 3) {
        return `mostly high-priced entries (${breakdown.high} high vs ${breakdown.low} low)`;
    }
    if (lowShare >= 2 / 3) {
        return `mostly low-priced entries (${breakdown.low} low vs ${breakdown.high} high)`;
    }
    if (breakdown.high > breakdown.low) {
        return `mixed high/low entries, slight high skew (${breakdown.high} high vs ${breakdown.low} low)`;
    }
    if (breakdown.low > breakdown.high) {
        return `mixed high/low entries, slight low skew (${breakdown.low} low vs ${breakdown.high} high)`;
    }
    return `mixed high/low entries (${breakdown.high} high, ${breakdown.low} low)`;
}

function buildWarnings(args: {
    snapshot?: UiBacktestEndpointSnapshot | null;
    result: BacktestResult;
    effectiveExitMode?: PolymarketExitMode;
    storedEvaluationMode?: PolymarketExitMode;
    chartExits: BacktestDiagnosticOutput["chartExits"];
    polymarket: BacktestDiagnosticOutput["polymarket"];
}): BacktestDiagnosticWarning[] {
    const warnings: BacktestDiagnosticWarning[] = [];
    const requestedExitMode = args.snapshot?.backtestSettings?.polymarketExitMode;

    if (isSameEventPolymarketExitMode(requestedExitMode) && !isSameEventPolymarketExitMode(args.effectiveExitMode)) {
        addWarning(
            warnings,
            "same_event_exit_not_effective",
            "warning",
            `${requestedExitMode} was requested, but the resolved run mode is resolve_hold for this interval, execution model, or annotation setting.`
        );
    }

    const isSameEventExitResult = isSameEventPolymarketExitMode(args.storedEvaluationMode)
        || isSameEventPolymarketExitMode(args.effectiveExitMode);
    const sameEventExitedTrades = args.polymarket?.sameEventExitedTrades ?? args.polymarket?.signalExitedTrades ?? 0;
    const resolvedSameEventReasons = args.polymarket?.chartExitReasonsForResolvedSameEventExitTop ?? [];
    const actionableResolvedReasons = filterCountRows(resolvedSameEventReasons, new Set(["end_of_data"]));
    const actionableResolvedTrades = sumCountRows(actionableResolvedReasons);
    if (isSameEventExitResult && actionableResolvedTrades > 0) {
        const reasonText = formatTopReasons(actionableResolvedReasons);
        addWarning(
            warnings,
            "same_event_exit_settled_at_resolution",
            "warning",
            reasonText
                ? `${actionableResolvedTrades} same-event Polymarket trades settled at final outcome. Chart exit reasons among those trades: ${reasonText}.`
                : `${actionableResolvedTrades} same-event Polymarket trades settled at final outcome.`
        );
    }

    if (isSameEventExitResult && sameEventExitedTrades === 0 && actionableResolvedTrades > 0) {
        addWarning(
            warnings,
            "no_polymarket_same_event_exits",
            "warning",
            "No Polymarket trades exited from same-event chart timing; settlement fallbacks dominate this run."
        );
    }

    if (
        (args.storedEvaluationMode === "signal_exit_same_event" || args.effectiveExitMode === "signal_exit_same_event")
        && args.chartExits.signalTrades === 0
        && args.result.trades.length > 0
    ) {
        addWarning(
            warnings,
            "no_chart_signal_exits",
            "warning",
            "The backtest produced no chart trades with exitReason=signal, so signal-exit pricing cannot fire. Use chart_exit_same_event if time_stop, TP, or SL chart closes should exit Polymarket."
        );
    }

    if (
        args.snapshot?.backtestSettings
        && args.storedEvaluationMode
        && args.effectiveExitMode
        && args.storedEvaluationMode !== args.effectiveExitMode
    ) {
        addWarning(
            warnings,
            "stored_mode_differs_from_current_settings",
            "info",
            `Stored Polymarket annotations are ${args.storedEvaluationMode}, while current settings resolve to ${args.effectiveExitMode}.`
        );
    }

    const interval = args.snapshot?.interval ?? args.result.marketContext?.interval;
    if (
        interval === "1s"
        && isSameEventPolymarketExitMode(requestedExitMode)
        && isSameEventPolymarketExitMode(args.effectiveExitMode)
        && !args.storedEvaluationMode
    ) {
        addWarning(
            warnings,
            "missing_stored_one_second_same_event_exit_summary",
            "warning",
            "This 1s same-event exit run has no stored Polymarket summary; verify that the second-market CLOB annotation path ran before trusting Trades-only reloads."
        );
    }

    return warnings;
}

function buildRecommendations(args: {
    result: BacktestResult;
    effectiveExitMode?: PolymarketExitMode;
    storedEvaluationMode?: PolymarketExitMode;
    chartExits: BacktestDiagnosticOutput["chartExits"];
    polymarket: BacktestDiagnosticOutput["polymarket"];
}): string[] {
    const recommendations: string[] = [];
    const mode = args.storedEvaluationMode ?? args.effectiveExitMode;
    const polymarket = args.polymarket;
    if (!polymarket) {
        return recommendations;
    }

    if (
        mode === "signal_exit_same_event"
        && args.chartExits.signalTrades === 0
        && args.result.trades.length > 0
    ) {
        recommendations.push(
            "Switch Polymarket Exit Mode to chart_exit_same_event for this run if time_stop chart closes should exit the Polymarket leg; signal_exit_same_event only exits on chart exitReason=signal."
        );
    }

    if (polymarket.entryPriceFilteredTrades > 0) {
        const filterCents = polymarket.filters.entryPriceFilterCents;
        const breakdown = polymarket.entryPriceFilterBreakdown;
        const direction = formatEntryPriceFilterDirection(breakdown);
        const filterText = typeof filterCents === "number" && filterCents > 0
            ? `the ${filterCents}c entry price filter`
            : "the entry price filter";
        recommendations.push(
            `Review ${filterText}: it excluded ${polymarket.entryPriceFilteredTrades} trades, ${direction}. For coverage testing, reduce or disable this filter before comparing strategy quality.`
        );
    }

    if (polymarket.entryTimeFilteredTrades > 0 && polymarket.filters.entryCutoffEnabled) {
        recommendations.push(
            `Entry cutoff skipped ${polymarket.entryTimeFilteredTrades} trades inside the final ${polymarket.filters.entryCutoffSeconds ?? "?"}s of the event; lower it only if late-event fills are acceptable.`
        );
    }

    if (polymarket.openPositionBlockedTrades > 0) {
        recommendations.push(
            `Open-position skips (${polymarket.openPositionBlockedTrades}) mean resolve-hold scoring rejected chart trades while an earlier Polymarket leg was still open; compare against Execution Lab entries, not raw chart trades.`
        );
    }

    if (polymarket.missingPriceTrades > 0) {
        recommendations.push(
            `Missing-price trades remain (${polymarket.missingPriceTrades}); inspect unscoredExamplesBySource.missing and refresh/re-mine local CLOB quotes around those event windows before tuning thresholds.`
        );
    }

    if (
        polymarket.storedEvaluationMode === "resolve_hold"
        && polymarket.filters.allowMultipleTradesPerEvent === true
        && polymarket.openPositionBlockedTrades > 0
    ) {
        recommendations.push(
            "The multi-trade toggle is a same-event exit setting; resolve-hold still allows only one active Polymarket leg at a time."
        );
    }

    return recommendations;
}

export function buildBacktestDiagnosticOutput(
    input: BuildBacktestDiagnosticOutputInput
): BacktestDiagnosticOutput {
    const { result, snapshot } = input;
    const settings = snapshot?.backtestSettings;
    const interval = snapshot?.interval ?? result.marketContext?.interval;
    const annotationEnabled = resolveAnnotationEnabled(settings, result);
    const storedEvaluationMode = resolveStoredEvaluationMode(result);
    const effectiveExitMode = interval
        ? settings
            ? resolveEffectivePolymarketExitMode({
                requestedMode: settings?.polymarketExitMode,
                interval,
                executionModel: settings?.executionModel,
                polymarketAnnotationEnabled: annotationEnabled ?? false,
            })
            : storedEvaluationMode
        : undefined;
    const chartExits = buildChartExitDiagnostics(result.trades);
    const polymarket = buildPolymarketDiagnostics(
        result,
        snapshot,
        effectiveExitMode,
        storedEvaluationMode,
        annotationEnabled,
        input.maxExamples ?? 20
    );
    const warnings = buildWarnings({
        snapshot,
        result,
        effectiveExitMode,
        storedEvaluationMode,
        chartExits,
        polymarket,
    });
    const recommendations = buildRecommendations({
        result,
        effectiveExitMode,
        storedEvaluationMode,
        chartExits,
        polymarket,
    });

    return {
        schema: "backtest.diagnostics.v1",
        generatedAtIso: input.generatedAtIso ?? new Date().toISOString(),
        run: {
            source: input.resultSource,
            symbol: snapshot?.symbol ?? result.marketContext?.symbol,
            interval,
            strategyKey: snapshot?.strategyKey,
            engineUsed: snapshot?.engineUsed,
            executionModel: settings?.executionModel,
            tradeDirection: settings?.tradeDirection,
            candleCount: result.marketContext?.candleCount,
            firstCandleTimeSec: timeToDiagnosticSeconds(result.marketContext?.firstCandleTime ?? null),
            lastCandleTimeSec: timeToDiagnosticSeconds(result.marketContext?.lastCandleTime ?? null),
            totalTrades: result.totalTrades,
            winRate: result.winRate,
            netProfit: result.netProfit,
            blockRange: snapshot?.blockRange,
        },
        chartExits,
        polymarket,
        engineDiagnostics: result.diagnostics,
        warnings,
        recommendations,
    };
}
