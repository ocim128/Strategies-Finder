import type { PolymarketPanelDom } from "./polymarket-panel-dom";
import {
    getEffectivePolymarketSeriesId,
    isSupportedPolymarketOutcomeRun,
    loadPolymarketOutcomesForTimeRange,
    resolvePolymarketOutcomeSymbol,
} from "./polymarket-btc5m";
import { parseTimeToUnixSeconds } from "./time-normalization";
import { state } from "./state";
import type { BacktestResult } from "./types/strategies";
import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";
import { debugLogger } from "./debug-logger";
import { resolveEffectivePolymarketExitMode, isSignalExitSameEventMode } from "./polymarket-exit-mode";
import {
    isActualPolymarketEntryMinuteMode,
    resolvePolymarketEntrySelectionModeForDisplay,
    type PolymarketEntrySelectionMode,
} from "./polymarket-entry-selection-mode";
import {
    buildSignalExitPolymarketTradeSummary,
    evaluateSignalExitTrades,
    buildTradeAnnotationFromSignalExitResult,
    indexSignalExitOutcomesForTrades,
} from "./polymarket-signal-exit-evaluator";
import { ensurePricePointsForOutcomes } from "./polymarket-price-points-ingest";
import { resolveBacktestResultMarketContext } from "./backtest-result-context";
import { resolvePolymarketOutcomeInterval, type PolymarketOutcomeInterval } from "./polymarket-outcome-interval";
import {
    annotateTradesWithPolymarketOutcomesForRun,
    summarizePolymarketTradesForRun,
} from "./polymarket-trade-annotations";

export interface PolymarketOutcomeLoaderDeps {
    getDom: () => PolymarketPanelDom;
    readCurrentExecutionModel: () => string | undefined;
    readCurrentPolymarketEntryOffset: () => number | null;
    readCurrentPolymarketEntryPriceFilterCents: () => number;
    readCurrentPolymarketBacktestSlippageCents: () => number;
    readCurrentPolymarketEntryCutoffEnabled: () => boolean;
    readCurrentPolymarketEntryCutoffSeconds: () => number;
    readCurrentPolymarketEntrySelectionMode: () => PolymarketEntrySelectionMode;
    readCurrentPolymarketExitMode: () => "resolve_hold" | "signal_exit_same_event" | undefined;
    readCurrentPolymarketSignalExitAllowMultipleTradesPerEvent: () => boolean;
    readCurrentPolymarketOutcomeSymbol: () => string | null;
    readCurrentPolymarketOutcomeInterval: () => PolymarketOutcomeInterval;
    isPanelVisible: () => boolean;
    scheduleRender: (delayMs?: number) => void;
}

export class PolymarketOutcomeLoader {
    loadedOutcomeRows: PolymarketOutcomeRow[] = [];
    lastResult: BacktestResult | null = null;
    isLoading = false;
    loadError: string | null = null;
    loadNonce = 0;
    loadedResultSignature = "";

    constructor(private deps: PolymarketOutcomeLoaderDeps) {}

    async handleBacktestResultChange(result: BacktestResult | null): Promise<void> {
        this.lastResult = result;
        this.loadError = null;
        const resultContext = resolveBacktestResultMarketContext(result);
        const outcomeSymbol = result ? this.resolveActivePolymarketOutcomeSymbol(result) : this.deps.readCurrentPolymarketOutcomeSymbol();
        const outcomeInterval = result ? this.resolveActivePolymarketOutcomeInterval(result) : this.deps.readCurrentPolymarketOutcomeInterval();

        if (!result || !resultContext || !isSupportedPolymarketOutcomeRun(resultContext.symbol, resultContext.interval, outcomeInterval, outcomeSymbol) || result.trades.length === 0) {
            this.resetLoadedRows(false);
            this.deps.scheduleRender();
            return;
        }

        if (!this.deps.isPanelVisible()) {
            this.resetLoadedRows(false);
            return;
        }

        await this.ensureOutcomeRowsForCurrentResult();
    }

    async ensureOutcomeRowsForCurrentResult(): Promise<void> {
        const result = this.lastResult;
        const resultContext = resolveBacktestResultMarketContext(result);
        const outcomeSymbol = result ? this.resolveActivePolymarketOutcomeSymbol(result) : this.deps.readCurrentPolymarketOutcomeSymbol();
        const outcomeInterval = result ? this.resolveActivePolymarketOutcomeInterval(result) : this.deps.readCurrentPolymarketOutcomeInterval();
        if (!result || !resultContext || !isSupportedPolymarketOutcomeRun(resultContext.symbol, resultContext.interval, outcomeInterval, outcomeSymbol) || result.trades.length === 0) {
            this.resetLoadedRows(false);
            this.deps.scheduleRender();
            return;
        }

        const resultSignature = this.getResultSignature(result);
        if (
            this.loadedResultSignature === resultSignature
            && !this.isLoading
            && !this.loadError
        ) {
            this.deps.scheduleRender();
            return;
        }

        const targetTimes = result.trades
            .map((trade) => trade.polymarketOutcome?.eventStartTs ?? parseTimeToUnixSeconds(trade.entryTime))
            .filter((value): value is number => value !== null);

        if (targetTimes.length === 0) {
            this.resetLoadedRows(false);
            this.deps.scheduleRender();
            return;
        }

        const requestId = ++this.loadNonce;
        this.isLoading = true;
        this.deps.scheduleRender();

        try {
            const rows = await loadPolymarketOutcomesForTimeRange(
                resultContext.symbol,
                Math.min(...targetTimes),
                Math.max(...targetTimes),
                outcomeSymbol,
                outcomeInterval
            );
            if (requestId !== this.loadNonce) {
                return;
            }
            this.lastResult = await this.attachLoadedPolymarketOutcomes(result, rows);
            this.loadedOutcomeRows = rows;
            this.isLoading = false;
            this.loadedResultSignature = resultSignature;
            this.deps.scheduleRender();
        } catch (error) {
            if (requestId !== this.loadNonce) {
                return;
            }

            this.loadedOutcomeRows = [];
            this.isLoading = false;
            this.loadError = error instanceof Error ? error.message : String(error);
            this.loadedResultSignature = resultSignature;
            this.deps.scheduleRender();
        }
    }

    async attachLoadedPolymarketOutcomes(result: BacktestResult, outcomes: readonly PolymarketOutcomeRow[]): Promise<BacktestResult> {
        const resultContext = resolveBacktestResultMarketContext(result);
        if (!resultContext || outcomes.length === 0) {
            return result;
        }

        const existingSummary = result.polymarketTradeSummary;
        const outcomeInterval = this.resolveActivePolymarketOutcomeInterval(result);
        const resolvedOutcomeSymbol = resolvePolymarketOutcomeSymbol(
            resultContext.symbol,
            existingSummary?.outcomeSymbol ?? this.deps.readCurrentPolymarketOutcomeSymbol()
        );
        const seriesId = existingSummary?.seriesId || getEffectivePolymarketSeriesId(resultContext.symbol, outcomeInterval, resolvedOutcomeSymbol) || outcomes[0]?.series_id || "";

        const effectiveExitMode = existingSummary?.evaluationMode ?? resolveEffectivePolymarketExitMode({
            requestedMode: this.deps.readCurrentPolymarketExitMode(),
            interval: resultContext.interval,
            executionModel: this.deps.readCurrentExecutionModel(),
            polymarketAnnotationEnabled: true,
        });
        const limitEntry = outcomeInterval === "5m" && existingSummary?.limitEntryEnabled === true
            ? {
                enabled: true,
                priceMode: existingSummary.limitEntryMode,
                priceCents: existingSummary.limitEntryPriceCents ?? 50,
                offsetCents: existingSummary.limitEntryOffsetCents,
                exitEnabled: existingSummary.limitExitEnabled === true,
                exitMode: existingSummary.limitExitMode,
                exitPriceCents: existingSummary.limitExitPriceCents,
                exitOffsetCents: existingSummary.limitExitOffsetCents,
            }
            : undefined;
        const allowMultipleTradesPerEvent = existingSummary?.evaluationMode === "signal_exit_same_event"
            ? existingSummary.signalExitAllowMultipleTradesPerEvent === true
            : this.deps.readCurrentPolymarketSignalExitAllowMultipleTradesPerEvent();

        if (isSignalExitSameEventMode(effectiveExitMode) && resultContext.interval === "1m") {
            const targetTimes = result.trades
                .map((trade) => parseTimeToUnixSeconds(trade.entryTime))
                .filter((value): value is number => value !== null);
            if (targetTimes.length > 0) {
                try {
                    const outcomeByEntryTs = indexSignalExitOutcomesForTrades(result.trades, outcomes);
                    const relevantOutcomeByStart = new Map<number, (typeof outcomes)[number]>();
                    for (const outcome of outcomeByEntryTs.values()) {
                        if (outcome) {
                            relevantOutcomeByStart.set(outcome.event_start_ts, outcome);
                        }
                    }
                    const pricePoints = await ensurePricePointsForOutcomes(
                        relevantOutcomeByStart.size > 0 ? [...relevantOutcomeByStart.values()] : outcomes,
                        seriesId
                    );
                    const { results: exitResults, summary: exitSummary } = evaluateSignalExitTrades({
                        trades: result.trades,
                        outcomes,
                        pricePoints,
                        outcomeByEntryTs,
                        allowMultipleTradesPerEvent,
                        entryPriceFilterCents: this.deps.readCurrentPolymarketEntryPriceFilterCents(),
                        backtestSlippageCents: this.deps.readCurrentPolymarketBacktestSlippageCents(),
                        entryCutoffEnabled: this.deps.readCurrentPolymarketEntryCutoffEnabled(),
                        entryCutoffSeconds: this.deps.readCurrentPolymarketEntryCutoffSeconds(),
                        limitEntry,
                    });
                    const exitResultMap = new Map(exitResults.map((r) => [r.trade, r]));
                    const annotatedTrades = result.trades.map((trade) => {
                        const exitResult = exitResultMap.get(trade);
                        if (!exitResult) return { ...trade, polymarketOutcome: null };
                        return { ...trade, polymarketOutcome: buildTradeAnnotationFromSignalExitResult(exitResult) };
                    });
                    return {
                        ...result,
                        trades: annotatedTrades,
                        polymarketTradeSummary: buildSignalExitPolymarketTradeSummary({
                            seriesId,
                            outcomeSymbol: existingSummary?.outcomeSymbol ?? resolvedOutcomeSymbol,
                            outcomeInterval,
                            outcomeRowsLoaded: outcomes.length,
                            summary: exitSummary,
                        }),
                    };
                } catch (error) {
                    debugLogger.warn("polymarket_panel.signal_exit_annotation_failed", {
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        }

        const entrySelectionMode = resultContext.interval === "1m" && outcomeInterval === "5m"
            ? this.resolveSelectedPolymarketEntrySelectionMode(result)
            : undefined;
        const selectedOffset = resultContext.interval === "1m" && outcomeInterval === "5m" && !isActualPolymarketEntryMinuteMode(entrySelectionMode)
            ? this.resolveSelectedPolymarketEntryOffset(result)
            : undefined;
        let limitEntryPricePoints: Awaited<ReturnType<typeof ensurePricePointsForOutcomes>> | undefined;
        if (limitEntry) {
            const targetTimes = result.trades
                .map((trade) => parseTimeToUnixSeconds(trade.entryTime))
                .filter((value): value is number => value !== null);
            if (targetTimes.length > 0) {
                try {
                    limitEntryPricePoints = await ensurePricePointsForOutcomes(outcomes, seriesId);
                } catch {
                    limitEntryPricePoints = [];
                }
            }
        }
        const annotatedTrades = annotateTradesWithPolymarketOutcomesForRun(
            result.trades,
            outcomes,
            resultContext.interval,
            selectedOffset,
            entrySelectionMode ?? "fixed_offset",
            {
                outcomeInterval,
                pricePoints: limitEntryPricePoints,
                entryPriceFilterCents: this.deps.readCurrentPolymarketEntryPriceFilterCents(),
                backtestSlippageCents: this.deps.readCurrentPolymarketBacktestSlippageCents(),
                entryCutoffEnabled: this.deps.readCurrentPolymarketEntryCutoffEnabled(),
                entryCutoffSeconds: this.deps.readCurrentPolymarketEntryCutoffSeconds(),
                limitEntry,
            }
        );
        const summary = summarizePolymarketTradesForRun({
            trades: annotatedTrades,
            outcomes,
            interval: resultContext.interval,
            selectedOffset,
            entrySelectionMode,
            timingProfile: existingSummary?.timingProfile,
            outcomeInterval,
            backtestSlippageCents: this.deps.readCurrentPolymarketBacktestSlippageCents(),
            limitEntry,
        });
        const totalTrades = result.totalTrades > 0 ? result.totalTrades : result.trades.length;

        return {
            ...result,
            trades: annotatedTrades,
            polymarketTradeSummary: {
                seriesId,
                outcomeSymbol: existingSummary?.outcomeSymbol ?? resolvedOutcomeSymbol ?? undefined,
                outcomeInterval,
                outcomeRowsLoaded: existingSummary?.outcomeRowsLoaded && existingSummary.outcomeRowsLoaded > 0
                    ? existingSummary.outcomeRowsLoaded
                    : outcomes.length,
                scoredTrades: existingSummary?.scoredTrades ?? summary.scoredTrades,
                missingOutcomeTrades: existingSummary?.missingOutcomeTrades ?? summary.missingOutcomeTrades,
                unscoredTrades: existingSummary?.unscoredTrades ?? summary.unscoredTrades ?? Math.max(0, totalTrades - summary.scoredTrades),
                duplicateTradesIgnored: existingSummary?.duplicateTradesIgnored ?? summary.duplicateTradesIgnored,
                entryPriceFilteredTrades: existingSummary?.entryPriceFilteredTrades ?? summary.entryPriceFilteredTrades,
                entryTimeFilteredTrades: existingSummary?.entryTimeFilteredTrades ?? summary.entryTimeFilteredTrades,
                entrySelectionMode: existingSummary?.entrySelectionMode ?? summary.entrySelectionMode,
                entryOffset: existingSummary?.entryOffset ?? summary.entryOffset,
                timingProfile: existingSummary?.timingProfile ?? summary.timingProfile,
                evaluationMode: "resolve_hold",
                backtestSlippageCents: existingSummary?.backtestSlippageCents ?? summary.backtestSlippageCents,
                targetExitedTrades: existingSummary?.targetExitedTrades ?? summary.targetExitedTrades,
                limitEntryEnabled: existingSummary?.limitEntryEnabled ?? summary.limitEntryEnabled,
                limitEntryMode: existingSummary?.limitEntryMode ?? summary.limitEntryMode,
                limitEntryPriceCents: existingSummary?.limitEntryPriceCents ?? summary.limitEntryPriceCents,
                limitEntryOffsetCents: existingSummary?.limitEntryOffsetCents ?? summary.limitEntryOffsetCents,
                limitEntryAttempts: existingSummary?.limitEntryAttempts ?? summary.limitEntryAttempts,
                limitEntryFilledTrades: existingSummary?.limitEntryFilledTrades ?? summary.limitEntryFilledTrades,
                limitEntryMissedTrades: existingSummary?.limitEntryMissedTrades ?? summary.limitEntryMissedTrades,
                limitEntryNotTouchedTrades: existingSummary?.limitEntryNotTouchedTrades ?? summary.limitEntryNotTouchedTrades,
                limitEntryLastMinuteOnlyTrades: existingSummary?.limitEntryLastMinuteOnlyTrades ?? summary.limitEntryLastMinuteOnlyTrades,
                limitEntryMissingPriceTrades: existingSummary?.limitEntryMissingPriceTrades ?? summary.limitEntryMissingPriceTrades,
                limitEntryInvalidWindowTrades: existingSummary?.limitEntryInvalidWindowTrades ?? summary.limitEntryInvalidWindowTrades,
                limitEntryFillRate: existingSummary?.limitEntryFillRate ?? summary.limitEntryFillRate,
                avgLimitEntryWaitSec: existingSummary?.avgLimitEntryWaitSec ?? summary.avgLimitEntryWaitSec,
                avgLimitEntryImprovement: existingSummary?.avgLimitEntryImprovement ?? summary.avgLimitEntryImprovement,
                limitExitEnabled: existingSummary?.limitExitEnabled ?? summary.limitExitEnabled,
                limitExitMode: existingSummary?.limitExitMode ?? summary.limitExitMode,
                limitExitPriceCents: existingSummary?.limitExitPriceCents ?? summary.limitExitPriceCents,
                limitExitOffsetCents: existingSummary?.limitExitOffsetCents ?? summary.limitExitOffsetCents,
                limitExitFilledTrades: existingSummary?.limitExitFilledTrades ?? summary.limitExitFilledTrades,
                limitExitFallbackTrades: existingSummary?.limitExitFallbackTrades ?? summary.limitExitFallbackTrades,
                limitExitUnreachableTrades: existingSummary?.limitExitUnreachableTrades ?? summary.limitExitUnreachableTrades,
            },
        };
    }

    resetLoadedRows(clearResult = true): void {
        this.loadNonce++;
        this.loadedOutcomeRows = [];
        this.isLoading = false;
        this.loadError = null;
        this.loadedResultSignature = "";
        if (clearResult) {
            this.lastResult = null;
        }
    }

    getResultSignature(result: BacktestResult): string {
        const resultContext = resolveBacktestResultMarketContext(result);
        const outcomeSymbol = this.resolveActivePolymarketOutcomeSymbol(result);
        const outcomeInterval = this.resolveActivePolymarketOutcomeInterval(result);
        const firstTrade = result.trades[0];
        const lastTrade = result.trades[result.trades.length - 1];
        const entrySelectionMode = this.resolveSelectedPolymarketEntrySelectionMode(result);
        const selectedOffset = isActualPolymarketEntryMinuteMode(entrySelectionMode)
            ? "auto"
            : (result.polymarketTradeSummary?.entryOffset ?? this.deps.readCurrentPolymarketEntryOffset() ?? "na");
        const evaluationMode = result.polymarketTradeSummary?.evaluationMode
            ?? this.deps.readCurrentPolymarketExitMode()
            ?? "resolve_hold";
        const executionModel = result.polymarketTradeSummary?.evaluationMode
            ? "stored"
            : (this.deps.readCurrentExecutionModel() ?? "na");
        const allowMultipleTradesPerEvent = result.polymarketTradeSummary?.evaluationMode === "signal_exit_same_event"
            ? result.polymarketTradeSummary.signalExitAllowMultipleTradesPerEvent === true
            : this.deps.readCurrentPolymarketSignalExitAllowMultipleTradesPerEvent();
        return [
            resultContext?.symbol ?? state.currentSymbol,
            resultContext?.interval ?? state.currentInterval,
            outcomeSymbol ?? "same",
            outcomeInterval,
            entrySelectionMode,
            selectedOffset,
            executionModel,
            evaluationMode,
            allowMultipleTradesPerEvent ? "multi" : "single",
            this.deps.readCurrentPolymarketEntryPriceFilterCents(),
            this.deps.readCurrentPolymarketBacktestSlippageCents(),
            this.deps.readCurrentPolymarketEntryCutoffEnabled() ? "cutoff" : "no-cutoff",
            this.deps.readCurrentPolymarketEntryCutoffSeconds(),
            result.polymarketTradeSummary?.limitEntryEnabled ? "limit" : "quote",
            result.polymarketTradeSummary?.limitEntryMode ?? "fixed_price",
            result.polymarketTradeSummary?.limitEntryPriceCents ?? "na",
            result.polymarketTradeSummary?.limitEntryOffsetCents ?? "na",
            result.polymarketTradeSummary?.limitExitEnabled ? "exit" : "hold",
            result.polymarketTradeSummary?.limitExitMode ?? "entry_offset",
            result.polymarketTradeSummary?.limitExitPriceCents ?? "na",
            result.polymarketTradeSummary?.limitExitOffsetCents ?? "na",
            result.trades.length,
            parseTimeToUnixSeconds(firstTrade?.entryTime) ?? "na",
            parseTimeToUnixSeconds(lastTrade?.entryTime) ?? "na",
        ].join("|");
    }

    resolveActivePolymarketOutcomeSymbol(result: BacktestResult): string | null {
        const summarySymbol = result.polymarketTradeSummary?.outcomeSymbol;
        if (typeof summarySymbol === "string" && summarySymbol.trim().length > 0) {
            return summarySymbol.trim().toUpperCase();
        }
        return this.deps.readCurrentPolymarketOutcomeSymbol();
    }

    resolveActivePolymarketOutcomeInterval(result: BacktestResult): PolymarketOutcomeInterval {
        return resolvePolymarketOutcomeInterval(
            result.polymarketTradeSummary?.outcomeInterval ?? this.deps.readCurrentPolymarketOutcomeInterval()
        );
    }

    private resolveSelectedPolymarketEntryOffset(_result: BacktestResult): number {
        return this.deps.readCurrentPolymarketEntryOffset() ?? 0;
    }

    private resolveSelectedPolymarketEntrySelectionMode(result: BacktestResult): PolymarketEntrySelectionMode {
        return resolvePolymarketEntrySelectionModeForDisplay(
            result.polymarketTradeSummary?.entrySelectionMode,
            this.deps.readCurrentPolymarketEntrySelectionMode(),
            result.trades
        );
    }
}
