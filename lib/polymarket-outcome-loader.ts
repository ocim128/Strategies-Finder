import type { PolymarketPanelDom } from "./polymarket-panel-dom";
import {
    isSupportedPolymarketOutcomeRun,
    loadPolymarketOutcomesForTimeRange,
} from "./polymarket-btc5m";
import { parseTimeToUnixSeconds } from "./time-normalization";
import { state } from "./state";
import type { BacktestResult } from "./types/strategies";
import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";
import { debugLogger } from "./debug-logger";
import { isSameEventPolymarketExitMode, type PolymarketExitMode } from "./polymarket-exit-mode";
import {
    isActualPolymarketEntryMinuteMode,
    resolvePolymarketEntrySelectionModeForDisplay,
    type PolymarketEntrySelectionMode,
} from "./polymarket-entry-selection-mode";
import { resolveBacktestResultMarketContext } from "./backtest-result-context";
import { resolvePolymarketOutcomeInterval, type PolymarketOutcomeInterval } from "./polymarket-outcome-interval";
import { rebuildPolymarketAnnotations } from "./polymarket-annotation-rebuilder";
import type { PolymarketDomSettings } from "./polymarket-dom-reader";

export interface PolymarketOutcomeLoaderDeps {
    getDom: () => PolymarketPanelDom;
    readCurrentExecutionModel: () => string | undefined;
    readCurrentPolymarketEntryOffset: () => number | null;
    readCurrentPolymarketEntryPriceFilterCents: () => number;
    readCurrentPolymarketBacktestSlippageCents: () => number;
    readCurrentPolymarketEntryCutoffEnabled: () => boolean;
    readCurrentPolymarketEntryCutoffSeconds: () => number;
    readCurrentPolymarketEntrySelectionMode: () => PolymarketEntrySelectionMode;
    readCurrentPolymarketExitMode: () => PolymarketExitMode | undefined;
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
        if (!resultContext) {
            return result;
        }

        const settingsSnapshot: PolymarketDomSettings = {
            entryOffset: this.deps.readCurrentPolymarketEntryOffset(),
            entrySelectionMode: this.deps.readCurrentPolymarketEntrySelectionMode(),
            outcomeSymbol: this.deps.readCurrentPolymarketOutcomeSymbol(),
            outcomeInterval: this.deps.readCurrentPolymarketOutcomeInterval(),
            entryDelayBars: 0,
            entryPriceFilterCents: this.deps.readCurrentPolymarketEntryPriceFilterCents(),
            backtestSlippageCents: this.deps.readCurrentPolymarketBacktestSlippageCents(),
            entryCutoffEnabled: this.deps.readCurrentPolymarketEntryCutoffEnabled(),
            entryCutoffSeconds: this.deps.readCurrentPolymarketEntryCutoffSeconds(),
            exitMode: this.deps.readCurrentPolymarketExitMode(),
            signalExitAllowMultipleTradesPerEvent: this.deps.readCurrentPolymarketSignalExitAllowMultipleTradesPerEvent(),
            postSignalLimitEntryEnabled: false,
            postSignalLimitEntryMode: "fixed_price",
            postSignalLimitEntryPriceCents: 50,
            postSignalLimitEntryOffsetCents: 0,
            postSignalLimitExitEnabled: false,
            postSignalLimitExitMode: "entry_offset",
            postSignalLimitExitPriceCents: 0,
            postSignalLimitExitOffsetCents: 0,
            protectionTakeProfitEnabled: false,
            protectionTakeProfitCents: 0,
            protectionStopLossEnabled: false,
            protectionStopLossCents: 0,
            executionModel: this.deps.readCurrentExecutionModel() as any,
        };

        const rebuildResult = await rebuildPolymarketAnnotations({
            result,
            marketContext: resultContext,
            settingsSnapshot,
            executionModel: this.deps.readCurrentExecutionModel(),
            preferStoredSummary: true,
            allowSecondMarket: false,
            caller: "panel",
            outcomes,
        });

        const summary = rebuildResult.result.polymarketTradeSummary;
        debugLogger.info("polymarket_panel.annotation_success", {
            path: "outcome_loader",
            symbol: resultContext.symbol,
            interval: resultContext.interval,
            requestedMode: this.deps.readCurrentPolymarketExitMode() ?? "resolve_hold",
            effectiveMode: rebuildResult.effectiveExitMode,
            outcomeInterval: this.resolveActivePolymarketOutcomeInterval(result),
            outcomesLoaded: rebuildResult.outcomesLoaded,
            pricePointsLoaded: rebuildResult.pricePointsLoaded,
            missingPriceTrades: summary?.limitEntryMissingPriceTrades ?? 0,
            duplicateTradesIgnored: summary?.duplicateTradesIgnored ?? 0,
            durationMs: rebuildResult.durationMs,
            usedSecondMarket: rebuildResult.usedSecondMarket,
            usedPricePointEnsure: rebuildResult.usedPricePointEnsure,
            usedFallback: rebuildResult.usedFallback,
        });

        return rebuildResult.result;
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
        const allowMultipleTradesPerEvent = result.polymarketTradeSummary && isSameEventPolymarketExitMode(result.polymarketTradeSummary.evaluationMode)
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

    private resolveSelectedPolymarketEntrySelectionMode(result: BacktestResult): PolymarketEntrySelectionMode {
        return resolvePolymarketEntrySelectionModeForDisplay(
            result.polymarketTradeSummary?.entrySelectionMode,
            this.deps.readCurrentPolymarketEntrySelectionMode(),
            result.trades
        );
    }
}
