import { createPolymarketPanelDom, type PolymarketPanelDom } from "./polymarket-panel-dom";
import {
    getSupportedPolymarket5mSymbolsLabel,
    isSupportedPolymarketOutcomeRun,
} from "./polymarket-btc5m";
import type { PolymarketFillScope } from "./polymarket-fill-analysis";
import { parseTimeToUnixSeconds } from "./time-normalization";
import { state } from "./state";
import { setVisible } from "./dom-utils";
import type { BacktestResult, ExpectancyBreakdownSection } from "./types/strategies";
import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";
import { resolveBacktestResultMarketContext } from "./backtest-result-context";
import { resolvePolymarketDomSettings } from "./polymarket-dom-reader";
import { resolvePolymarketOutcomeInterval, type PolymarketOutcomeInterval } from "./polymarket-outcome-interval";
import {
    analyzePolymarketDeployability,
    extractScoredTrades,
} from "./polymarket-deployability-analysis";
import {
    computePolymarketBestBaselineWinRate,
    countDistinctPolymarketOutcomeRows,
    getQuickViewDiagnosticSections,
    summarizePolymarketPayoutDiagnostics,
} from "./quick-view";
import {
    formatScopeLabel,
    formatPercent,
    formatProbability,
    formatPolymarketCents,
    formatProfitFactor,
    formatSignedUsd,
} from "./polymarket-formatting";
import { PolymarketBridgeExport } from "./polymarket-bridge-export";
import { PolymarketOutcomeLoader } from "./polymarket-outcome-loader";
import { isActualPolymarketEntryMinuteMode, type PolymarketEntrySelectionMode } from "./polymarket-entry-selection-mode";

class PolymarketPanelService {
    private dom: PolymarketPanelDom | null = null;
    private initialized = false;
    private outcomeLoader: PolymarketOutcomeLoader | null = null;
    private bridgeExport: PolymarketBridgeExport | null = null;
    private renderFrameId: number | null = null;
    private renderTimeoutId: number | null = null;
    private deployabilityCacheKey = "";
    private deployabilityCache: ReturnType<typeof analyzePolymarketDeployability> | null = null;

    public init(): void {
        if (this.initialized) {
            return;
        }

        this.dom = createPolymarketPanelDom();
        this.bridgeExport = new PolymarketBridgeExport(() => this.getDom());
        this.outcomeLoader = new PolymarketOutcomeLoader({
            getDom: () => this.getDom(),
            readCurrentExecutionModel: () => this.readCurrentExecutionModel(),
            readCurrentPolymarketEntryOffset: () => this.readCurrentPolymarketEntryOffset(),
            readCurrentPolymarketEntryPriceFilterCents: () => this.readCurrentPolymarketEntryPriceFilterCents(),
            readCurrentPolymarketEntrySelectionMode: () => this.readCurrentPolymarketEntrySelectionMode(),
            readCurrentPolymarketExitMode: () => this.readCurrentPolymarketExitMode(),
            readCurrentPolymarketSignalExitAllowMultipleTradesPerEvent: () => this.readCurrentPolymarketSignalExitAllowMultipleTradesPerEvent(),
            readCurrentPolymarketOutcomeSymbol: () => this.readCurrentPolymarketOutcomeSymbol(),
            readCurrentPolymarketOutcomeInterval: () => this.readCurrentPolymarketOutcomeInterval(),
            isPanelVisible: () => this.isPanelVisible(),
            scheduleRender: (delayMs?: number) => this.scheduleRender(delayMs),
            invalidateDeployabilityCache: () => {
                this.deployabilityCacheKey = "";
                this.deployabilityCache = null;
            },
        });
        this.outcomeLoader.lastResult = state.currentBacktestResult;
        void this.outcomeLoader.isEnrichingHistory;
        void this.outcomeLoader.enrichHistoryInBackground;
        void this.renderDeployabilityAnalysis;
        void formatScopeLabel;
        this.bindEvents();
        this.bindState();
        this.render();
        if (this.isPanelVisible()) {
            void this.outcomeLoader.ensureOutcomeRowsForCurrentResult();
        }
        this.initialized = true;
    }

    private bindEvents(): void {
        const dom = this.getDom();
        dom.polymarketBridgeConfig.addEventListener("focus", () => {
            this.bridgeExport!.ensureBridgeConfigOptions(true);
            this.bridgeExport!.renderBridgeControls();
        });
        dom.polymarketBridgeConfig.addEventListener("change", () => {
            this.bridgeExport!.selectedConfigName = dom.polymarketBridgeConfig.value;
            this.bridgeExport!.renderBridgeControls();
        });
        dom.polymarketBridgeDownloadScript.addEventListener("click", () => {
            void this.bridgeExport!.handleBridgeScriptDownload();
        });
        dom.polymarketBridgeCopyEnv.addEventListener("click", () => {
            void this.bridgeExport!.handleCopyBotEnv();
        });
        window.addEventListener("strategy-panel:tab-change", ((event: CustomEvent<{ tabId?: string }>) => {
            if (event.detail?.tabId !== "polymarket") {
                return;
            }
            this.scheduleRender();
            void this.outcomeLoader!.ensureOutcomeRowsForCurrentResult();
        }) as EventListener);
    }

    private bindState(): void {
        state.subscribe("currentBacktestResult", (result) => {
            void this.outcomeLoader!.handleBacktestResultChange(result);
        });

        state.subscribe("currentSymbol", () => {
            this.outcomeLoader!.resetLoadedRows();
            this.scheduleRender();
        });

        state.subscribe("currentInterval", () => {
            this.outcomeLoader!.resetLoadedRows();
            this.scheduleRender();
        });
    }

    private readCurrentPolymarketEntryOffset(): number | null {
        return resolvePolymarketDomSettings().entryOffset;
    }

    private readCurrentPolymarketEntrySelectionMode(): PolymarketEntrySelectionMode {
        return resolvePolymarketDomSettings().entrySelectionMode;
    }

    private readCurrentPolymarketEntryPriceFilterCents(): number {
        return resolvePolymarketDomSettings().entryPriceFilterCents;
    }

    private readCurrentPolymarketExitMode(): "resolve_hold" | "signal_exit_same_event" | undefined {
        return resolvePolymarketDomSettings().exitMode;
    }

    private readCurrentPolymarketSignalExitAllowMultipleTradesPerEvent(): boolean {
        return resolvePolymarketDomSettings().signalExitAllowMultipleTradesPerEvent;
    }

    private readCurrentExecutionModel(): string | undefined {
        return resolvePolymarketDomSettings().executionModel;
    }

    private readCurrentPolymarketOutcomeSymbol(): string | null {
        return resolvePolymarketDomSettings().outcomeSymbol;
    }

    private readCurrentPolymarketOutcomeInterval(): PolymarketOutcomeInterval {
        return resolvePolymarketDomSettings().outcomeInterval;
    }

    private render(): void {
        if (!this.isPanelVisible()) {
            return;
        }

        const loader = this.outcomeLoader!;
        const result = loader.lastResult;
        const resultContext = resolveBacktestResultMarketContext(result);
        const outcomeInterval = result ? loader.resolveActivePolymarketOutcomeInterval(result) : this.readCurrentPolymarketOutcomeInterval();
        const supportedRun = resultContext
            ? isSupportedPolymarketOutcomeRun(
                resultContext.symbol,
                resultContext.interval,
                outcomeInterval,
                result ? loader.resolveActivePolymarketOutcomeSymbol(result) : this.readCurrentPolymarketOutcomeSymbol()
            )
            : isSupportedPolymarketOutcomeRun(state.currentSymbol, state.currentInterval, outcomeInterval, this.readCurrentPolymarketOutcomeSymbol());

        this.bridgeExport!.renderBridgeControls();

        if (!result) {
            this.showEmpty("Run a backtest first to see Polymarket payout diagnostics and the snapshot profile.");
            return;
        }

        if (!supportedRun) {
            this.showEmpty(`This tab currently supports ${getSupportedPolymarket5mSymbolsLabel()} with native 5m, 15m, or 1h Polymarket sessions.`);
            return;
        }

        if (result.trades.length === 0) {
            this.showEmpty("The current backtest has no executed trades to evaluate.");
            return;
        }

        if (loader.isLoading) {
            this.showEmpty("Loading Polymarket outcome rows from local SQLite...");
            return;
        }

        if (loader.loadError) {
            this.showEmpty(`Failed to load Polymarket outcomes. ${loader.loadError}`);
            return;
        }

        this.renderPolymarketDiagnostics(result);
    }

    private renderPolymarketDiagnostics(result: BacktestResult): void {
        const dom = this.getDom();
        const payoutSummary = summarizePolymarketPayoutDiagnostics(result.trades);
        const summary = this.getPolymarketSummary(result);
        const sections = getQuickViewDiagnosticSections(result);

        if (!summary && !payoutSummary && sections.length === 0) {
            this.showEmpty("No scored Polymarket trades are available for the current result yet.");
            return;
        }

        dom.polymarketDiagnosticsContent.innerHTML = [
            payoutSummary ? this.buildPayoutSummarySection(
                payoutSummary,
                result.polymarketTradeSummary?.evaluationMode === "signal_exit_same_event"
                    || result.polymarketTradeSummary?.limitExitEnabled === true
            ) : "",
            summary ? this.buildPolymarketSummarySection(summary) : "",
            summary ? this.buildSizedBankrollSection(summary) : "",
            ...sections.map((section) => this.buildDiagnosticBucketSection(section)),
        ].filter(Boolean).join("");

        setVisible(dom.polymarketDiagnosticsEmpty, false);
        setVisible(dom.polymarketDiagnosticsContent, true);
    }

    private getPolymarketSummary(result: BacktestResult): {
        wins: number;
        losses: number;
        neutralTrades: number;
        scoredTrades: number;
        missingTrades: number;
        unscoredTrades: number;
        duplicateTradesIgnored?: number;
        entryPriceFilteredTrades?: number;
        coverage: number;
        winRate: number;
        outcomeRowsLoaded: number;
        baselineDelta: number;
        entrySelectionMode?: PolymarketEntrySelectionMode;
        entryOffset?: number;
        outcomeInterval?: PolymarketOutcomeInterval;
        bestTimingProfile?: NonNullable<NonNullable<BacktestResult["polymarketTradeSummary"]>["timingProfile"]>[number] | null;
        evaluationMode?: "resolve_hold" | "signal_exit_same_event";
        signalExitAllowMultipleTradesPerEvent?: boolean;
        missingPriceTrades?: number;
        targetExitedTrades?: number;
        signalExitedTrades?: number;
        resolvedTrades?: number;
        limitEntryEnabled?: boolean;
        limitEntryMode?: NonNullable<BacktestResult["polymarketTradeSummary"]>["limitEntryMode"];
        limitEntryPriceCents?: number;
        limitEntryOffsetCents?: number;
        limitEntryAttempts?: number;
        limitEntryFilledTrades?: number;
        limitEntryMissedTrades?: number;
        limitEntryNotTouchedTrades?: number;
        limitEntryLastMinuteOnlyTrades?: number;
        limitEntryMissingPriceTrades?: number;
        limitEntryFillRate?: number;
        avgLimitEntryWaitSec?: number;
        avgLimitEntryImprovement?: number;
        limitExitEnabled?: boolean;
        limitExitMode?: NonNullable<BacktestResult["polymarketTradeSummary"]>["limitExitMode"];
        limitExitPriceCents?: number;
        limitExitOffsetCents?: number;
        limitExitFilledTrades?: number;
        limitExitFallbackTrades?: number;
        limitExitUnreachableTrades?: number;
        sizedSizingMode?: NonNullable<BacktestResult["polymarketTradeSummary"]>["sizedSizingMode"];
        sizedInitialCapital?: number;
        sizedFinalEquity?: number;
        sizedNetProfit?: number;
        sizedNetProfitPercent?: number;
        sizedProfitFactor?: number;
        sizedExpectancy?: number;
        sizedMaxDrawdown?: number;
        sizedMaxDrawdownPercent?: number;
        sizedTrades?: number;
        sizedSkippedTrades?: number;
        sizedNoCapitalTrades?: number;
        sizedCappedTrades?: number;
        sizedAvgStake?: number;
        sizedMaxStake?: number;
    } | null {
        const summary = result.polymarketTradeSummary;
        const isSignalExit = summary?.evaluationMode === "signal_exit_same_event";
        const usesRealizedPnl = isSignalExit || summary?.limitExitEnabled === true;
        const hasLimitEntrySummary = summary?.limitEntryEnabled === true
            && (summary.limitEntryAttempts ?? 0) > 0;

        const wins = usesRealizedPnl
            ? (summary?.profitableTrades ?? result.trades.filter((t) => t.polymarketOutcome?.isProfitable === true).length)
            : result.trades.filter((trade) => trade.polymarketOutcome?.isWin === true).length;
        const losses = usesRealizedPnl
            ? (summary?.losingTrades ?? result.trades.filter((t) => t.polymarketOutcome?.isProfitable === false).length)
            : result.trades.filter((trade) => trade.polymarketOutcome?.isWin === false).length;
        const neutralTrades = usesRealizedPnl
            ? (summary?.neutralTrades ?? Math.max(0, (summary?.scoredTrades ?? wins + losses) - wins - losses))
            : 0;
        const scoredTrades = usesRealizedPnl ? (summary?.scoredTrades ?? wins + losses + neutralTrades) : wins + losses;

        if (!summary && scoredTrades === 0) {
            return null;
        }
        if (summary && scoredTrades === 0 && !hasLimitEntrySummary) {
            return null;
        }

        const totalTrades = result.totalTrades > 0 ? result.totalTrades : result.trades.length;
        const missingTrades = summary?.missingOutcomeTrades ?? Math.max(0, totalTrades - scoredTrades);
        const unscoredTrades = summary?.unscoredTrades ?? Math.max(0, totalTrades - scoredTrades);
        const derivedDuplicateTradesIgnored = result.trades.filter(
            (trade) => trade.polymarketOutcome?.marketExitSource === "duplicate"
        ).length;
        const duplicateTradesIgnored = summary?.duplicateTradesIgnored
            ?? (derivedDuplicateTradesIgnored > 0 ? derivedDuplicateTradesIgnored : undefined);
        const coverageBase = Math.max(0, scoredTrades + unscoredTrades);
        const coverage = coverageBase > 0 ? scoredTrades / coverageBase : 0;
        const baselineWinRate = isSignalExit ? 0 : computePolymarketBestBaselineWinRate(result.trades);
        const timingProfile = summary?.timingProfile ?? [];
        const bestTimingProfile = timingProfile.length > 0
            ? [...timingProfile]
                .filter((entry) => entry.scoredTrades > 0)
                .sort((left, right) => {
                    if (right.winRate !== left.winRate) return right.winRate - left.winRate;
                    if (right.scoredTrades !== left.scoredTrades) return right.scoredTrades - left.scoredTrades;
                    return left.entryOffset - right.entryOffset;
                })[0] ?? null
            : null;

        return {
            wins,
            losses,
            neutralTrades,
            scoredTrades,
            missingTrades,
            unscoredTrades,
            duplicateTradesIgnored,
            entryPriceFilteredTrades: summary?.entryPriceFilteredTrades,
            coverage,
            winRate: scoredTrades > 0 ? wins / scoredTrades : 0,
            outcomeRowsLoaded: summary?.outcomeRowsLoaded ?? countDistinctPolymarketOutcomeRows(result.trades),
            baselineDelta: usesRealizedPnl ? 0 : (scoredTrades > 0 ? wins / scoredTrades : 0) - baselineWinRate,
            entrySelectionMode: summary?.entrySelectionMode,
            entryOffset: summary?.entryOffset,
            outcomeInterval: summary?.outcomeInterval,
            bestTimingProfile,
            evaluationMode: isSignalExit ? "signal_exit_same_event" : undefined,
            signalExitAllowMultipleTradesPerEvent: summary?.signalExitAllowMultipleTradesPerEvent,
            missingPriceTrades: isSignalExit ? (summary?.missingPriceTrades ?? 0) : undefined,
            targetExitedTrades: summary?.targetExitedTrades,
            signalExitedTrades: isSignalExit ? (summary?.signalExitedTrades ?? 0) : undefined,
            resolvedTrades: isSignalExit ? (summary?.resolvedTrades ?? 0) : undefined,
            limitEntryEnabled: summary?.limitEntryEnabled,
            limitEntryMode: summary?.limitEntryMode,
            limitEntryPriceCents: summary?.limitEntryPriceCents,
            limitEntryOffsetCents: summary?.limitEntryOffsetCents,
            limitEntryAttempts: summary?.limitEntryAttempts,
            limitEntryFilledTrades: summary?.limitEntryFilledTrades,
            limitEntryMissedTrades: summary?.limitEntryMissedTrades,
            limitEntryNotTouchedTrades: summary?.limitEntryNotTouchedTrades,
            limitEntryLastMinuteOnlyTrades: summary?.limitEntryLastMinuteOnlyTrades,
            limitEntryMissingPriceTrades: summary?.limitEntryMissingPriceTrades,
            limitEntryFillRate: summary?.limitEntryFillRate,
            avgLimitEntryWaitSec: summary?.avgLimitEntryWaitSec,
            avgLimitEntryImprovement: summary?.avgLimitEntryImprovement,
            limitExitEnabled: summary?.limitExitEnabled,
            limitExitMode: summary?.limitExitMode,
            limitExitPriceCents: summary?.limitExitPriceCents,
            limitExitOffsetCents: summary?.limitExitOffsetCents,
            limitExitFilledTrades: summary?.limitExitFilledTrades,
            limitExitFallbackTrades: summary?.limitExitFallbackTrades,
            limitExitUnreachableTrades: summary?.limitExitUnreachableTrades,
            sizedSizingMode: summary?.sizedSizingMode,
            sizedInitialCapital: summary?.sizedInitialCapital,
            sizedFinalEquity: summary?.sizedFinalEquity,
            sizedNetProfit: summary?.sizedNetProfit,
            sizedNetProfitPercent: summary?.sizedNetProfitPercent,
            sizedProfitFactor: summary?.sizedProfitFactor,
            sizedExpectancy: summary?.sizedExpectancy,
            sizedMaxDrawdown: summary?.sizedMaxDrawdown,
            sizedMaxDrawdownPercent: summary?.sizedMaxDrawdownPercent,
            sizedTrades: summary?.sizedTrades,
            sizedSkippedTrades: summary?.sizedSkippedTrades,
            sizedNoCapitalTrades: summary?.sizedNoCapitalTrades,
            sizedCappedTrades: summary?.sizedCappedTrades,
            sizedAvgStake: summary?.sizedAvgStake,
            sizedMaxStake: summary?.sizedMaxStake,
        };
    }

    private buildPayoutSummarySection(
        summary: NonNullable<ReturnType<typeof summarizePolymarketPayoutDiagnostics>>,
        isSignalExit = false
    ): string {
        const profitabilityTone = isSignalExit ? summary.expectancy : summary.edgeVsBreakEven;
        return `
            <div class="deployability-section">
                <div class="section-subtitle">Payout Summary</div>
                <div class="entry-stats-hint polymarket-diagnostics__hint">Polymarket is a binary payout. Long trades buy YES, short trades buy NO. A short entered at 90c is a 90c NO entry and pays 10c on a win. Exp is shown in cents per $1 share.</div>
                <div class="stats-grid polymarket-panel__stats">
                    ${this.renderStatCard("Priced Trades", String(summary.pricedTrades))}
                    ${summary.unpricedScoredTrades > 0 ? this.renderStatCard("Unpriced Scored Trades", String(summary.unpricedScoredTrades)) : ""}
                    ${this.renderStatCard("Avg Entry Price", formatProbability(summary.avgEntryPrice))}
                    ${isSignalExit ? "" : this.renderStatCard("Break-even Win", formatPercent(summary.breakEvenWinRate))}
                    ${this.renderStatCard(isSignalExit ? "Poly Profit Rate" : "Poly Win Rate", formatPercent(summary.winRate), profitabilityTone)}
                    ${this.renderStatCard("Poly Exp / Trade", formatPolymarketCents(summary.expectancy), summary.expectancy)}
                    ${this.renderStatCard("Poly Profit Factor", formatProfitFactor(summary.profitFactor))}
                    ${isSignalExit ? "" : this.renderStatCard("Edge Vs Break-even", `${summary.edgeVsBreakEven >= 0 ? "+" : ""}${(summary.edgeVsBreakEven * 100).toFixed(1)}pp`, summary.edgeVsBreakEven)}
                </div>
            </div>
        `;
    }

    private buildPolymarketSummarySection(summary: NonNullable<ReturnType<PolymarketPanelService["getPolymarketSummary"]>>): string {
        const isSignalExit = summary.evaluationMode === "signal_exit_same_event";
        const usesRealizedPnl = isSignalExit || summary.limitExitEnabled === true;
        const usesActualEntryMinute = isActualPolymarketEntryMinuteMode(summary.entrySelectionMode);
        const outcomeInterval = resolvePolymarketOutcomeInterval(summary.outcomeInterval);
        const usesNativeLongSession = outcomeInterval !== "5m";
        const runModeLabel = isSignalExit ? "Exit Mode" : (
            usesActualEntryMinute
                ? "Entry Selection"
                : (!usesNativeLongSession && typeof summary.entryOffset === "number" ? "Selected Offset" : "Run Mode")
        );
        const runModeValue = isSignalExit
            ? (summary.signalExitAllowMultipleTradesPerEvent ? "Signal Exit (same event, multi-trade)" : "Signal Exit (same event)")
            : usesActualEntryMinute
                ? "Auto (actual trade minute)"
                : (!usesNativeLongSession && typeof summary.entryOffset === "number" ? `Minute ${summary.entryOffset}` : `Native ${outcomeInterval} scoring`);
        const winCountLabel = usesRealizedPnl ? "Profitable Trades" : "Poly Wins";
        const lossCountLabel = usesRealizedPnl ? "Losing Trades" : "Poly Losses";
        const profitabilityTone = usesRealizedPnl && summary.wins === 0 && summary.losses === 0
            ? 0
            : summary.winRate - 0.5;
        const timingContext = summary.bestTimingProfile
            ? `Best minute ${summary.bestTimingProfile.entryOffset} at ${formatPercent(summary.bestTimingProfile.winRate)}`
            : isSignalExit
                ? summary.signalExitAllowMultipleTradesPerEvent
                    ? `Signal-exit mode: every eligible chart trade can score inside the same ${outcomeInterval} session.`
                    : `Signal-exit mode: trades exit on chart sell signal inside the same ${outcomeInterval} session.`
                : usesActualEntryMinute
                    ? "Auto mode scores the first eligible trade in each 5m event and uses that trade's actual minute for entry pricing."
                    : (usesNativeLongSession ? `Full ${outcomeInterval} session timing diagnostics are available below.` : "Full timing profile is available in 1m bridge runs.");

        const signalExitCards = isSignalExit ? `
                    ${(summary.targetExitedTrades ?? 0) > 0 ? this.renderStatCard("Target Exited", String(summary.targetExitedTrades)) : ""}
                    ${this.renderStatCard("Signal Exited", String(summary.signalExitedTrades ?? 0))}
                    ${this.renderStatCard("Resolved (Held)", String(summary.resolvedTrades ?? 0))}
                    ${summary.neutralTrades > 0 ? this.renderStatCard("Neutral Trades", String(summary.neutralTrades)) : ""}
                    ${summary.missingPriceTrades && summary.missingPriceTrades > 0 ? this.renderStatCard("Missing Price Trades", String(summary.missingPriceTrades)) : ""}
        ` : '';

        const limitEntryCards = summary.limitEntryEnabled ? `
                    ${this.renderStatCard("Limit Attempts", String(summary.limitEntryAttempts ?? 0))}
                    ${this.renderStatCard("Limit Filled", String(summary.limitEntryFilledTrades ?? 0))}
                    ${this.renderStatCard("Limit Missed", String(summary.limitEntryMissedTrades ?? 0))}
                    ${this.renderStatCard("Limit Fill Rate", formatPercent(summary.limitEntryFillRate ?? 0))}
                    ${(summary.limitEntryNotTouchedTrades ?? 0) > 0 ? this.renderStatCard("Not Touched", String(summary.limitEntryNotTouchedTrades)) : ""}
                    ${(summary.limitEntryLastMinuteOnlyTrades ?? 0) > 0 ? this.renderStatCard("Last-Min Only", String(summary.limitEntryLastMinuteOnlyTrades)) : ""}
                    ${(summary.limitEntryMissingPriceTrades ?? 0) > 0 ? this.renderStatCard("Missing Limit Price", String(summary.limitEntryMissingPriceTrades)) : ""}
                    ${typeof summary.avgLimitEntryWaitSec === "number" ? this.renderStatCard("Avg Limit Wait", `${summary.avgLimitEntryWaitSec.toFixed(0)}s`) : ""}
                    ${typeof summary.avgLimitEntryImprovement === "number" ? this.renderStatCard("Avg Entry Improvement", formatProbability(summary.avgLimitEntryImprovement)) : ""}
                    ${summary.limitExitEnabled ? this.renderStatCard("Target Filled", String(summary.limitExitFilledTrades ?? 0)) : ""}
                    ${summary.limitExitEnabled ? this.renderStatCard("Target Fallback", String(summary.limitExitFallbackTrades ?? 0)) : ""}
                    ${summary.limitExitEnabled && (summary.limitExitUnreachableTrades ?? 0) > 0 ? this.renderStatCard("Target Unreachable", String(summary.limitExitUnreachableTrades)) : ""}
        ` : '';

        const baselineCard = usesRealizedPnl ? '' : `
                    ${this.renderStatCard("Baseline Delta", `${summary.baselineDelta >= 0 ? "+" : ""}${(summary.baselineDelta * 100).toFixed(1)}pp`, summary.baselineDelta)}
        `;

        return `
            <div class="deployability-section">
                <div class="section-subtitle">Polymarket Summary</div>
                <div class="entry-stats-hint polymarket-diagnostics__hint">${timingContext}</div>
                <div class="stats-grid polymarket-panel__stats">
                    ${this.renderStatCard(runModeLabel, runModeValue)}
                    ${this.renderStatCard(usesRealizedPnl ? "Poly Profitable %" : "Poly Win Rate", formatPercent(summary.winRate), profitabilityTone)}
                    ${this.renderStatCard("Scored Trade Share", formatPercent(summary.coverage))}
                    ${this.renderStatCard(winCountLabel, String(summary.wins), summary.wins > 0 ? 1 : 0)}
                    ${this.renderStatCard(lossCountLabel, String(summary.losses), summary.losses > 0 ? -1 : 0)}
                    ${baselineCard}
                    ${signalExitCards}
                    ${limitEntryCards}
                    ${this.renderStatCard("Scored Trades", String(summary.scoredTrades))}
                    ${this.renderStatCard("Unscored Trades", String(summary.unscoredTrades))}
                    ${summary.duplicateTradesIgnored && summary.duplicateTradesIgnored > 0 ? this.renderStatCard("Duplicate Trades Ignored", String(summary.duplicateTradesIgnored)) : ""}
                    ${summary.entryPriceFilteredTrades && summary.entryPriceFilteredTrades > 0 ? this.renderStatCard("Entry Price Filtered", String(summary.entryPriceFilteredTrades)) : ""}
                    ${summary.missingTrades > 0 ? this.renderStatCard("Missing Outcome Rows", String(summary.missingTrades)) : ""}
                    ${this.renderStatCard("Outcome Rows Fetched", String(summary.outcomeRowsLoaded))}
                </div>
            </div>
        `;
    }

    private buildSizedBankrollSection(summary: NonNullable<ReturnType<PolymarketPanelService["getPolymarketSummary"]>>): string {
        if (
            !summary.sizedSizingMode
            || summary.sizedSizingMode === "percent"
            || !summary.sizedTrades
        ) {
            return "";
        }

        const netProfit = summary.sizedNetProfit ?? 0;
        const returnPercent = summary.sizedNetProfitPercent ?? 0;
        const drawdown = summary.sizedMaxDrawdown ?? 0;
        const drawdownPercent = summary.sizedMaxDrawdownPercent ?? 0;
        const skipped = summary.sizedSkippedTrades ?? 0;
        const noCapital = summary.sizedNoCapitalTrades ?? 0;
        const capped = summary.sizedCappedTrades ?? 0;

        return `
            <div class="deployability-section">
                <div class="section-subtitle">Sized Polymarket Bankroll</div>
                <div class="entry-stats-hint polymarket-diagnostics__hint">Dollar results from the selected Alternative Sizing Mode. Chart backtest PnL is unchanged.</div>
                <div class="stats-grid polymarket-panel__stats">
                    ${this.renderStatCard("Sizing Mode", this.formatSizingModeLabel(summary.sizedSizingMode))}
                    ${this.renderStatCard("Final Equity", `$${(summary.sizedFinalEquity ?? 0).toFixed(2)}`, netProfit)}
                    ${this.renderStatCard("Net Profit", `${formatSignedUsd(netProfit)} (${returnPercent >= 0 ? "+" : ""}${returnPercent.toFixed(1)}%)`, netProfit)}
                    ${this.renderStatCard("Max Drawdown", `$${drawdown.toFixed(2)} (${drawdownPercent.toFixed(1)}%)`, -drawdown)}
                    ${this.renderStatCard("Profit Factor", formatProfitFactor(summary.sizedProfitFactor ?? 0))}
                    ${this.renderStatCard("Expectancy", formatSignedUsd(summary.sizedExpectancy ?? 0), summary.sizedExpectancy ?? 0)}
                    ${this.renderStatCard("Sized Trades", String(summary.sizedTrades))}
                    ${this.renderStatCard("Avg Stake", `$${(summary.sizedAvgStake ?? 0).toFixed(2)}`)}
                    ${this.renderStatCard("Max Stake", `$${(summary.sizedMaxStake ?? 0).toFixed(2)}`)}
                    ${skipped > 0 ? this.renderStatCard("Skipped Sizing", String(skipped)) : ""}
                    ${noCapital > 0 ? this.renderStatCard("No Capital", String(noCapital), -noCapital) : ""}
                    ${capped > 0 ? this.renderStatCard("Capped Stakes", String(capped)) : ""}
                </div>
            </div>
        `;
    }

    private formatSizingModeLabel(mode: string): string {
        if (mode === "fixed") {
            return "Fixed Amount";
        }
        return mode.replace(/_/g, " ");
    }

    private buildDiagnosticBucketSection(section: ExpectancyBreakdownSection): string {
        const rows = section.rows.map((row) => `
            <tr>
                <td>${row.label}</td>
                <td>${row.tradeCount}t</td>
                <td class="${(row.edgeVsBreakEven ?? (row.winRate - 50)) >= 0 ? "positive" : "negative"}">${row.winRate.toFixed(1)}%</td>
                <td class="${row.expectancy >= 0 ? "positive" : "negative"}">${row.avgEntryPrice !== undefined && row.avgEntryPrice !== null ? formatPolymarketCents(row.expectancy) : formatSignedUsd(row.expectancy)}</td>
            </tr>
        `).join("");

        return `
            <div class="deployability-section">
                <div class="section-subtitle">${section.title}</div>
                <div class="entry-stats-hint polymarket-diagnostics__hint">${section.hint}</div>
                <div class="analysis-finder-table-wrap">
                    <table class="analysis-finder-table polymarket-panel__table polymarket-diagnostics__table">
                        <thead>
                            <tr>
                                <th>Bucket</th>
                                <th>Trades</th>
                                <th>Win</th>
                                <th>Exp</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>
        `;
    }

    private renderStatCard(label: string, value: string, numericValue?: number): string {
        const toneClass = typeof numericValue === "number"
            ? (numericValue > 0 ? "positive" : numericValue < 0 ? "negative" : "")
            : "";
        return `
            <div class="stat-card">
                <div class="stat-label">${label}</div>
                <div class="stat-value ${toneClass}">${value}</div>
            </div>
        `;
    }

    private renderDeployabilityAnalysis(result: BacktestResult): void {
        const dom = this.getDom();
        const outcomeByStartTs = this.outcomeLoader!.outcomeByStartTs;
        const scoredTrades = extractScoredTrades(result.trades, outcomeByStartTs);
        const evaluationRows = this.getEvaluatedOutcomeRows();

        if (scoredTrades.length === 0) {
            dom.deployabilitySupport.textContent = "No scored Polymarket trades matched the current backtest. Run a supported 5m backtest with synced outcome rows first.";
            setVisible(dom.deployabilityEmpty, true);
            setVisible(dom.deployabilityContent, false);
            return;
        }

        const fillScope = this.readScope();
        const fillTargetPriceCents = this.readEntryPriceCents();
        const analysis = this.getDeployabilityAnalysis(
            result,
            scoredTrades,
            evaluationRows,
            fillScope,
            fillTargetPriceCents
        );

        // Render verdict
        const verdictBadge = dom.deployabilityVerdictBadge;
        const verdictText = dom.deployabilityVerdictText;
        verdictBadge.textContent = analysis.verdict.verdict;
        verdictBadge.className = `verdict-badge verdict-badge--${analysis.verdict.verdict.toLowerCase()}`;
        verdictText.textContent = this.getVerdictDescription(analysis.verdict.verdict);

        // Render confidence summary
        dom.deployWinRate.textContent = formatPercent(analysis.confidence.winRate);
        dom.deployWins.textContent = String(analysis.confidence.wins);
        dom.deployLosses.textContent = String(analysis.confidence.losses);
        dom.deployScoredTrades.textContent = String(analysis.confidence.scoredTrades);
        dom.deployCoverage.textContent = formatPercent(analysis.confidence.coverage);
        dom.deployWilsonLB.textContent = analysis.confidence.wilsonLowerBound.toFixed(3);
        dom.deployAlwaysYes.textContent = formatPercent(analysis.confidence.alwaysYesBaseline);
        dom.deployAlwaysNo.textContent = formatPercent(analysis.confidence.alwaysNoBaseline);

        const deltaYesPrefix = analysis.confidence.deltaVsAlwaysYes >= 0 ? "+" : "";
        const deltaNoPrefix = analysis.confidence.deltaVsAlwaysNo >= 0 ? "+" : "";
        dom.deployDeltaYes.textContent = `${deltaYesPrefix}${formatPercent(analysis.confidence.deltaVsAlwaysYes)}`;
        dom.deployDeltaNo.textContent = `${deltaNoPrefix}${formatPercent(analysis.confidence.deltaVsAlwaysNo)}`;

        // Render chronological blocks
        dom.deployBlocksBody.innerHTML = analysis.chronologicalBlocks.map((block) => `
            <tr>
                <td>${block.label}</td>
                <td>${block.scoredTrades}</td>
                <td>${block.wins}</td>
                <td>${block.losses}</td>
                <td>${formatPercent(block.winRate)}</td>
                <td>${block.wilsonLowerBound.toFixed(3)}</td>
            </tr>
        `).join("");

        // Render long/short breakdown
        dom.deployLongShortBody.innerHTML = analysis.regimeBreakdown.longShort.map((regime) => `
            <tr>
                <td>${regime.label}</td>
                <td>${regime.scoredTrades}</td>
                <td>${regime.wins}</td>
                <td>${regime.losses}</td>
                <td>${formatPercent(regime.winRate)}</td>
                <td>${regime.wilsonLowerBound.toFixed(3)}</td>
            </tr>
        `).join("");

        // Render entry price buckets (if available)
        const entryBucketsBody = analysis.regimeBreakdown.entryPriceBuckets ?? [];
        dom.deployEntryBucketsBody.innerHTML = entryBucketsBody.map((regime) => `
            <tr>
                <td>${regime.label}</td>
                <td>${regime.scoredTrades}</td>
                <td>${regime.wins}</td>
                <td>${regime.losses}</td>
                <td>${formatPercent(regime.winRate)}</td>
                <td>${regime.wilsonLowerBound.toFixed(3)}</td>
            </tr>
        `).join("");
        if (entryBucketsBody.length === 0) {
            dom.deployEntryBucketsBody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#888;">No entry price data available</td></tr>`;
        }

        // Render shuffle test
        dom.deployShuffleHint.textContent = analysis.significanceTest.hint;
        dom.deployShuffleSims.textContent = analysis.significanceTest.methodValue;
        dom.deployShuffleObserved.textContent = formatPercent(analysis.significanceTest.observedWinRate);
        dom.deployShuffleExceed.textContent = analysis.significanceTest.baselineValue;
        dom.deployShufflePValue.textContent = analysis.significanceTest.pValue.toFixed(3);
        dom.deployShuffleMean.textContent = formatPercent(analysis.significanceTest.expectedWinRate);
        dom.deployShuffleP95.textContent = analysis.significanceTest.diagnosticValue;

        // Render fill-adjusted metrics
        if (analysis.fillAdjusted) {
            dom.deployFillScored.textContent = String(analysis.fillAdjusted.scoredTrades);
            dom.deployFillWins.textContent = String(analysis.fillAdjusted.wins);
            dom.deployFillLosses.textContent = String(analysis.fillAdjusted.losses);
            dom.deployFillWinRate.textContent = formatPercent(analysis.fillAdjusted.winRate);
            dom.deployFillWilsonLB.textContent = analysis.fillAdjusted.wilsonLowerBound.toFixed(3);
            dom.deployFillRate.textContent = formatPercent(analysis.fillAdjusted.fillRate);
            if (analysis.significanceTest.mode === "one_sided_binomial" && analysis.significanceTest.constantPrediction) {
                const predictionLabel = analysis.significanceTest.constantPrediction.toUpperCase();
                const predictionBaseline = analysis.significanceTest.constantPrediction === "yes"
                    ? analysis.fillAdjusted.alwaysYesBaseline
                    : analysis.fillAdjusted.alwaysNoBaseline;
                dom.deployFillBestBaselineLabel.textContent = `Fill-Subset ${predictionLabel} Base`;
                dom.deployFillBestBaseline.textContent = `${predictionLabel} ${formatPercent(predictionBaseline)}`;
                dom.deployFillDeltaBaselineLabel.textContent = "Base Comparison";
                dom.deployFillDeltaBaseline.textContent = "One-sided: not informative";
            } else {
                dom.deployFillBestBaselineLabel.textContent = "Fill-Subset Best Base";
                dom.deployFillBestBaseline.textContent = `${analysis.fillAdjusted.bestBaselineLabel} ${formatPercent(analysis.fillAdjusted.bestBaseline)}`;
                dom.deployFillDeltaBaselineLabel.textContent = "Delta vs Best Base";
                dom.deployFillDeltaBaseline.textContent = `${analysis.fillAdjusted.deltaVsBestBaseline >= 0 ? "+" : ""}${formatPercent(analysis.fillAdjusted.deltaVsBestBaseline)}`;
            }
            dom.deployFillBreakEven.textContent = formatPercent(analysis.fillAdjusted.breakEvenWinRate);
            dom.deployFillEdgeBreakEven.textContent = `${analysis.fillAdjusted.edgeVsBreakEven >= 0 ? "+" : ""}${formatPercent(analysis.fillAdjusted.edgeVsBreakEven)}`;
        } else {
            dom.deployFillScored.textContent = "0";
            dom.deployFillWins.textContent = "0";
            dom.deployFillLosses.textContent = "0";
            dom.deployFillWinRate.textContent = "0.0%";
            dom.deployFillWilsonLB.textContent = "0.000";
            dom.deployFillRate.textContent = "0.0%";
            dom.deployFillBestBaselineLabel.textContent = "Fill-Subset Best Base";
            dom.deployFillBestBaseline.textContent = "N/A";
            dom.deployFillDeltaBaselineLabel.textContent = "Delta vs Best Base";
            dom.deployFillDeltaBaseline.textContent = "+0.0%";
            dom.deployFillBreakEven.textContent = "0.0%";
            dom.deployFillEdgeBreakEven.textContent = "+0.0%";
        }

        // Show deployability content, hide empty state
        setVisible(dom.deployabilityEmpty, false);
        setVisible(dom.deployabilityContent, true);
    }

    private getEvaluatedOutcomeRows(): PolymarketOutcomeRow[] {
        const loader = this.outcomeLoader!;
        if (loader.loadedOutcomeRows.length === 0) {
            return [];
        }

        const validTargetTs = new Set<number>();
        for (let index = 1; index < state.ohlcvData.length; index++) {
            const ts = parseTimeToUnixSeconds(state.ohlcvData[index]?.time);
            if (ts !== null) {
                validTargetTs.add(ts);
            }
        }

        if (validTargetTs.size === 0) {
            return [...loader.loadedOutcomeRows];
        }

        return loader.loadedOutcomeRows.filter((row) => validTargetTs.has(row.event_start_ts));
    }

    private getVerdictDescription(verdict: "Robust" | "Borderline" | "Weak"): string {
        switch (verdict) {
            case "Robust":
                return "Edge appears statistically credible and stable across time, regimes, and fill constraints.";
            case "Borderline":
                return "Some evidence of edge, but with caveats. Review details before deploying.";
            case "Weak":
                return "Edge is not statistically credible or collapses under scrutiny. Likely overfit or lucky.";
        }
    }

    private showEmpty(message: string): void {
        const dom = this.getDom();
        dom.polymarketDiagnosticsSupport.textContent = message;
        dom.polymarketDiagnosticsContent.innerHTML = "";
        setVisible(dom.polymarketDiagnosticsEmpty, true);
        setVisible(dom.polymarketDiagnosticsContent, false);
    }

    private isPanelVisible(): boolean {
        const dom = this.getDom();
        return !dom.polymarketTab.hidden && dom.polymarketTab.style.display !== "none";
    }

    private scheduleRender(delayMs = 0): void {
        if (!this.isPanelVisible()) {
            return;
        }

        if (this.renderTimeoutId !== null) {
            window.clearTimeout(this.renderTimeoutId);
            this.renderTimeoutId = null;
        }
        if (this.renderFrameId !== null) {
            window.cancelAnimationFrame(this.renderFrameId);
            this.renderFrameId = null;
        }

        const queueFrame = () => {
            this.renderTimeoutId = null;
            this.renderFrameId = window.requestAnimationFrame(() => {
                this.renderFrameId = null;
                this.render();
            });
        };

        if (delayMs > 0) {
            this.renderTimeoutId = window.setTimeout(queueFrame, delayMs);
            return;
        }

        queueFrame();
    }

    private getDeployabilityAnalysis(
        result: BacktestResult,
        scoredTrades: ReturnType<typeof extractScoredTrades>,
        evaluationRows: PolymarketOutcomeRow[],
        fillScope: PolymarketFillScope,
        fillTargetPriceCents: number
    ): ReturnType<typeof analyzePolymarketDeployability> {
        const loader = this.outcomeLoader!;
        const cacheKey = [
            loader.getResultSignature(result),
            scoredTrades.length,
            evaluationRows.length,
            loader.historySummaryByStartTs.size,
            fillScope,
            fillTargetPriceCents,
        ].join("|");

        if (this.deployabilityCacheKey === cacheKey && this.deployabilityCache) {
            return this.deployabilityCache;
        }

        const analysis = analyzePolymarketDeployability(scoredTrades, evaluationRows, {
            blockSize: 250,
            shuffleSimulations: 1000,
            shuffleSeed: 42,
            fillScope,
            fillTargetPriceCents,
            historySummaryByStartTs: loader.historySummaryByStartTs,
        });
        this.deployabilityCacheKey = cacheKey;
        this.deployabilityCache = analysis;
        return analysis;
    }

    private readEntryPriceCents(): number {
        const raw = Number(this.getDom().polymarketEntryPriceCents.value);
        if (!Number.isFinite(raw)) {
            return 40;
        }
        return Math.max(0, Math.min(100, raw));
    }

    private readScope(): PolymarketFillScope {
        const value = this.getDom().polymarketScope.value;
        return value === "long" || value === "short" ? value : "all";
    }

    private getDom(): PolymarketPanelDom {
        return this.dom ??= createPolymarketPanelDom();
    }
}

export const polymarketPanelService = new PolymarketPanelService();
