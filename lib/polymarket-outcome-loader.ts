import type { PolymarketPanelDom } from "./polymarket-panel-dom";
import type { PolymarketFillHistorySummary } from "./polymarket-fill-history";
import { loadPolymarketFillHistorySummary } from "./polymarket-fill-history";
import {
    getEffectivePolymarket5mSeriesId,
    loadPolymarket5mOutcomesForTimeRange,
    resolvePolymarketOutcomeSymbol,
    supportsPolymarketOutcomeBridgeRun,
} from "./polymarket-btc5m";
import { parseTimeToUnixSeconds } from "./time-normalization";
import { state } from "./state";
import type { BacktestResult } from "./types/strategies";
import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";
import { debugLogger } from "./debug-logger";
import { resolveEffectivePolymarketExitMode, isSignalExitSameEventMode } from "./polymarket-exit-mode";
import { evaluateSignalExitTrades, buildTradeAnnotationFromSignalExitResult } from "./polymarket-signal-exit-evaluator";
import { ensurePricePointsForOutcomes } from "./polymarket-price-points-ingest";
import { resolveBacktestResultMarketContext } from "./backtest-result-context";
import { findContainingEvent } from "./polymarket-1m-5m-bridge";
import {
    annotateTradesWithPolymarketOutcomesForRun,
    summarizePolymarketTradesForRun,
} from "./polymarket-trade-annotations";

export interface PolymarketOutcomeLoaderDeps {
    getDom: () => PolymarketPanelDom;
    readCurrentExecutionModel: () => string | undefined;
    readCurrentPolymarketEntryOffset: () => number | null;
    readCurrentPolymarketExitMode: () => "resolve_hold" | "signal_exit_same_event" | undefined;
    readCurrentPolymarketOutcomeSymbol: () => string | null;
    isPanelVisible: () => boolean;
    scheduleRender: (delayMs?: number) => void;
    invalidateDeployabilityCache: () => void;
}

export class PolymarketOutcomeLoader {
    loadedOutcomeRows: PolymarketOutcomeRow[] = [];
    outcomeByStartTs = new Map<number, PolymarketOutcomeRow>();
    historySummaryByStartTs = new Map<number, PolymarketFillHistorySummary>();
    lastResult: BacktestResult | null = null;
    isLoading = false;
    isEnrichingHistory = false;
    loadError: string | null = null;
    loadNonce = 0;
    loadedResultSignature = "";

    constructor(private deps: PolymarketOutcomeLoaderDeps) {}

    async handleBacktestResultChange(result: BacktestResult | null): Promise<void> {
        this.lastResult = result;
        this.loadError = null;
        const resultContext = resolveBacktestResultMarketContext(result);
        const outcomeSymbol = result ? this.resolveActivePolymarketOutcomeSymbol(result) : this.deps.readCurrentPolymarketOutcomeSymbol();

        if (!result || !resultContext || !supportsPolymarketOutcomeBridgeRun(resultContext.symbol, resultContext.interval, outcomeSymbol) || result.trades.length === 0) {
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
        if (!result || !resultContext || !supportsPolymarketOutcomeBridgeRun(resultContext.symbol, resultContext.interval, outcomeSymbol) || result.trades.length === 0) {
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
            const rows = await loadPolymarket5mOutcomesForTimeRange(
                resultContext.symbol,
                Math.min(...targetTimes),
                Math.max(...targetTimes),
                outcomeSymbol
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
        const resolvedOutcomeSymbol = resolvePolymarketOutcomeSymbol(
            resultContext.symbol,
            existingSummary?.outcomeSymbol ?? this.deps.readCurrentPolymarketOutcomeSymbol()
        );
        const seriesId = existingSummary?.seriesId || getEffectivePolymarket5mSeriesId(resultContext.symbol, resolvedOutcomeSymbol) || outcomes[0]?.series_id || "";

        const effectiveExitMode = existingSummary?.evaluationMode ?? resolveEffectivePolymarketExitMode({
            requestedMode: this.deps.readCurrentPolymarketExitMode(),
            interval: resultContext.interval,
            executionModel: this.deps.readCurrentExecutionModel(),
            polymarketAnnotationEnabled: true,
        });

        if (isSignalExitSameEventMode(effectiveExitMode) && resultContext.interval === "1m") {
            const targetTimes = result.trades
                .map((trade) => parseTimeToUnixSeconds(trade.entryTime))
                .filter((value): value is number => value !== null);
            if (targetTimes.length > 0) {
                const startTs = Math.min(...targetTimes);
                const endTs = Math.max(...targetTimes);
                try {
                    const relevantOutcomeByStart = new Map<number, (typeof outcomes)[number]>();
                    for (const trade of result.trades) {
                        const entryTs = parseTimeToUnixSeconds(trade.entryTime);
                        if (entryTs === null) continue;
                        const outcome = findContainingEvent(entryTs, outcomes);
                        if (outcome) {
                            relevantOutcomeByStart.set(outcome.event_start_ts, outcome);
                        }
                    }
                    const pricePoints = await ensurePricePointsForOutcomes(
                        relevantOutcomeByStart.size > 0 ? [...relevantOutcomeByStart.values()] : outcomes,
                        seriesId,
                        {
                            startTs: startTs - 300,
                            endTs: endTs + 300,
                        }
                    );
                    const { results: exitResults, summary: exitSummary } = evaluateSignalExitTrades({
                        trades: result.trades,
                        outcomes,
                        pricePoints,
                    });
                    const exitResultMap = new Map(exitResults.map((r) => [r.trade, r]));
                    const annotatedTrades = result.trades.map((trade) => {
                        const exitResult = exitResultMap.get(trade);
                        if (!exitResult || exitResult.exitSource === "missing") return { ...trade, polymarketOutcome: null };
                        return { ...trade, polymarketOutcome: buildTradeAnnotationFromSignalExitResult(exitResult) };
                    });
                    return {
                        ...result,
                        trades: annotatedTrades,
                        polymarketTradeSummary: {
                            seriesId,
                            outcomeSymbol: existingSummary?.outcomeSymbol ?? resolvedOutcomeSymbol ?? undefined,
                            outcomeRowsLoaded: outcomes.length,
                            scoredTrades: exitSummary.scoredTrades,
                            missingOutcomeTrades: 0,
                            unscoredTrades: exitSummary.missingPriceTrades,
                            evaluationMode: "signal_exit_same_event",
                            profitableTrades: exitSummary.profitableTrades,
                            losingTrades: exitSummary.losingTrades,
                            signalExitedTrades: exitSummary.signalExitedTrades,
                            resolvedTrades: exitSummary.resolvedTrades,
                            missingPriceTrades: exitSummary.missingPriceTrades,
                            netPnl: exitSummary.netPnl,
                            grossProfit: exitSummary.grossProfit,
                            grossLoss: exitSummary.grossLoss,
                            profitFactor: exitSummary.profitFactor,
                            expectancy: exitSummary.expectancy,
                            avgEntryPrice: exitSummary.avgEntryPrice,
                            avgExitPrice: exitSummary.avgExitPrice,
                        },
                    };
                } catch (error) {
                    debugLogger.warn("polymarket_panel.signal_exit_annotation_failed", {
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        }

        const selectedOffset = resultContext.interval === "1m"
            ? this.resolveSelectedPolymarketEntryOffset(result)
            : undefined;
        const annotatedTrades = annotateTradesWithPolymarketOutcomesForRun(
            result.trades,
            outcomes,
            resultContext.interval,
            selectedOffset
        );
        const summary = summarizePolymarketTradesForRun({
            trades: result.trades,
            outcomes,
            interval: resultContext.interval,
            selectedOffset,
            timingProfile: existingSummary?.timingProfile,
        });
        const totalTrades = result.totalTrades > 0 ? result.totalTrades : result.trades.length;

        return {
            ...result,
            trades: annotatedTrades,
            polymarketTradeSummary: {
                seriesId,
                outcomeSymbol: existingSummary?.outcomeSymbol ?? resolvedOutcomeSymbol ?? undefined,
                outcomeRowsLoaded: existingSummary?.outcomeRowsLoaded && existingSummary.outcomeRowsLoaded > 0
                    ? existingSummary.outcomeRowsLoaded
                    : outcomes.length,
                scoredTrades: existingSummary?.scoredTrades ?? summary.scoredTrades,
                missingOutcomeTrades: existingSummary?.missingOutcomeTrades ?? summary.missingOutcomeTrades,
                unscoredTrades: existingSummary?.unscoredTrades ?? summary.unscoredTrades ?? Math.max(0, totalTrades - summary.scoredTrades),
                duplicateTradesIgnored: existingSummary?.duplicateTradesIgnored ?? summary.duplicateTradesIgnored,
                entryOffset: existingSummary?.entryOffset ?? selectedOffset,
                timingProfile: existingSummary?.timingProfile ?? summary.timingProfile,
                evaluationMode: "resolve_hold",
            },
        };
    }

    async enrichHistoryInBackground(requestId: number, rows: PolymarketOutcomeRow[]): Promise<void> {
        if (rows.length === 0) {
            this.isEnrichingHistory = false;
            this.deps.scheduleRender();
            return;
        }

        this.isEnrichingHistory = true;
        this.deps.scheduleRender();

        const pendingRows = [...rows];
        const concurrency = 6;
        const workers = Array.from({ length: Math.min(concurrency, pendingRows.length) }, async () => {
            while (pendingRows.length > 0) {
                const row = pendingRows.shift();
                if (!row) {
                    return;
                }

                try {
                    const summary = await loadPolymarketFillHistorySummary(row);
                    if (requestId !== this.loadNonce) {
                        return;
                    }
                    this.historySummaryByStartTs.set(row.event_start_ts, summary);
                    this.deps.invalidateDeployabilityCache();
                    this.deps.scheduleRender(120);
                } catch {
                    if (requestId !== this.loadNonce) {
                        return;
                    }
                }
            }
        });

        await Promise.allSettled(workers);
        if (requestId !== this.loadNonce) {
            return;
        }

        this.isEnrichingHistory = false;
        this.deps.scheduleRender();
    }

    resetLoadedRows(clearResult = true): void {
        this.loadNonce++;
        this.loadedOutcomeRows = [];
        this.outcomeByStartTs.clear();
        this.historySummaryByStartTs.clear();
        this.isLoading = false;
        this.isEnrichingHistory = false;
        this.loadError = null;
        this.loadedResultSignature = "";
        this.deps.invalidateDeployabilityCache();
        if (clearResult) {
            this.lastResult = null;
        }
    }

    getResultSignature(result: BacktestResult): string {
        const resultContext = resolveBacktestResultMarketContext(result);
        const outcomeSymbol = this.resolveActivePolymarketOutcomeSymbol(result);
        const firstTrade = result.trades[0];
        const lastTrade = result.trades[result.trades.length - 1];
        return [
            resultContext?.symbol ?? state.currentSymbol,
            resultContext?.interval ?? state.currentInterval,
            outcomeSymbol ?? "same",
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

    private resolveSelectedPolymarketEntryOffset(_result: BacktestResult): number {
        return this.deps.readCurrentPolymarketEntryOffset() ?? 0;
    }
}
