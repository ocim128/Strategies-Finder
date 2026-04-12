import { createPolymarketPanelDom, type PolymarketPanelDom } from "./polymarket-panel-dom";
import type { PolymarketFillHistorySummary } from "./polymarket-fill-history";
import { loadPolymarketFillHistorySummary } from "./polymarket-fill-history";
import {
    getEffectivePolymarket5mSeriesId,
    getSupportedPolymarket5mSymbolsLabel,
    isSupportedPolymarket5mRun,
    loadPolymarket5mOutcomesForTimeRange,
    resolvePolymarketOutcomeSymbol,
    supportsPolymarketOutcomeBridgeRun,
} from "./polymarket-btc5m";
import type { PolymarketFillScope } from "./polymarket-fill-analysis";
import { parseTimeToUnixSeconds } from "./time-normalization";
import { state } from "./state";
import { setVisible } from "./dom-utils";
import type { BacktestResult, ExpectancyBreakdownSection } from "./types/strategies";
import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";
import { settingsManager, type StrategyConfig } from "./settings-manager";
import { uiManager } from "./ui-manager";
import { strategyRegistry } from "../strategyRegistry";
import { resolveEffectivePolymarketExitMode, isSignalExitSameEventMode } from "./polymarket-exit-mode";
import { evaluateSignalExitTrades, buildTradeAnnotationFromSignalExitResult } from "./polymarket-signal-exit-evaluator";
import { ensurePricePointsForOutcomes } from "./polymarket-price-points-ingest";
import { resolveBacktestResultMarketContext } from "./backtest-result-context";
import { findContainingEvent } from "./polymarket-1m-5m-bridge";
import {
    annotateTradesWithPolymarketOutcomesForRun,
    summarizePolymarketTradesForRun,
} from "./polymarket-trade-annotations";
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

class PolymarketPanelService {
    private dom: PolymarketPanelDom | null = null;
    private initialized = false;
    private loadedOutcomeRows: PolymarketOutcomeRow[] = [];
    private outcomeByStartTs = new Map<number, PolymarketOutcomeRow>();
    private historySummaryByStartTs = new Map<number, PolymarketFillHistorySummary>();
    private lastResult: BacktestResult | null = null;
    private isLoading = false;
    private isEnrichingHistory = false;
    private loadError: string | null = null;
    private loadNonce = 0;
    private bridgeConfigSignature = "";
    private selectedBridgeConfigName = "";
    private loadedResultSignature = "";
    private renderFrameId: number | null = null;
    private renderTimeoutId: number | null = null;
    private deployabilityCacheKey = "";
    private deployabilityCache: ReturnType<typeof analyzePolymarketDeployability> | null = null;

    public init(): void {
        if (this.initialized) {
            return;
        }

        this.dom = createPolymarketPanelDom();
        this.lastResult = state.currentBacktestResult;
        void this.isEnrichingHistory;
        void this.enrichHistoryInBackground;
        void this.renderDeployabilityAnalysis;
        void this.formatScopeLabel;
        this.bindEvents();
        this.bindState();
        this.render();
        if (this.isPanelVisible()) {
            void this.ensureOutcomeRowsForCurrentResult();
        }
        this.initialized = true;
    }

    private bindEvents(): void {
        const dom = this.getDom();
        dom.polymarketBridgeConfig.addEventListener("focus", () => {
            this.ensureBridgeConfigOptions(true);
            this.renderBridgeControls();
        });
        dom.polymarketBridgeConfig.addEventListener("change", () => {
            this.selectedBridgeConfigName = dom.polymarketBridgeConfig.value;
            this.renderBridgeControls();
        });
        dom.polymarketBridgeDownloadScript.addEventListener("click", () => {
            void this.handleBridgeScriptDownload();
        });
        dom.polymarketBridgeCopyEnv.addEventListener("click", () => {
            void this.handleCopyBotEnv();
        });
        window.addEventListener("strategy-panel:tab-change", ((event: CustomEvent<{ tabId?: string }>) => {
            if (event.detail?.tabId !== "polymarket") {
                return;
            }
            this.scheduleRender();
            void this.ensureOutcomeRowsForCurrentResult();
        }) as EventListener);
    }

    private bindState(): void {
        state.subscribe("currentBacktestResult", (result) => {
            void this.handleBacktestResultChange(result);
        });

        state.subscribe("currentSymbol", () => {
            this.resetLoadedRows();
            this.scheduleRender();
        });

        state.subscribe("currentInterval", () => {
            this.resetLoadedRows();
            this.scheduleRender();
        });
    }

    private async handleBacktestResultChange(result: BacktestResult | null): Promise<void> {
        this.lastResult = result;
        this.loadError = null;
        const resultContext = resolveBacktestResultMarketContext(result);
        const outcomeSymbol = result ? this.resolveActivePolymarketOutcomeSymbol(result) : this.readCurrentPolymarketOutcomeSymbol();

        if (!result || !resultContext || !supportsPolymarketOutcomeBridgeRun(resultContext.symbol, resultContext.interval, outcomeSymbol) || result.trades.length === 0) {
            this.resetLoadedRows(false);
            this.scheduleRender();
            return;
        }

        if (!this.isPanelVisible()) {
            this.resetLoadedRows(false);
            return;
        }

        await this.ensureOutcomeRowsForCurrentResult();
    }

    private async ensureOutcomeRowsForCurrentResult(): Promise<void> {
        const result = this.lastResult;
        const resultContext = resolveBacktestResultMarketContext(result);
        const outcomeSymbol = result ? this.resolveActivePolymarketOutcomeSymbol(result) : this.readCurrentPolymarketOutcomeSymbol();
        if (!result || !resultContext || !supportsPolymarketOutcomeBridgeRun(resultContext.symbol, resultContext.interval, outcomeSymbol) || result.trades.length === 0) {
            this.resetLoadedRows(false);
            this.scheduleRender();
            return;
        }

        const resultSignature = this.getResultSignature(result);
        if (
            this.loadedResultSignature === resultSignature
            && !this.isLoading
            && !this.loadError
        ) {
            this.scheduleRender();
            return;
        }

        const targetTimes = result.trades
            .map((trade) => trade.polymarketOutcome?.eventStartTs ?? parseTimeToUnixSeconds(trade.entryTime))
            .filter((value): value is number => value !== null);

        if (targetTimes.length === 0) {
            this.resetLoadedRows(false);
            this.scheduleRender();
            return;
        }

        const requestId = ++this.loadNonce;
        this.isLoading = true;
        this.scheduleRender();

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
            this.scheduleRender();
        } catch (error) {
            if (requestId !== this.loadNonce) {
                return;
            }

            this.loadedOutcomeRows = [];
            this.isLoading = false;
            this.loadError = error instanceof Error ? error.message : String(error);
            this.loadedResultSignature = resultSignature;
            this.scheduleRender();
        }
    }

    private async attachLoadedPolymarketOutcomes(result: BacktestResult, outcomes: readonly PolymarketOutcomeRow[]): Promise<BacktestResult> {
        const resultContext = resolveBacktestResultMarketContext(result);
        if (!resultContext || outcomes.length === 0) {
            return result;
        }

        const existingSummary = result.polymarketTradeSummary;
        const resolvedOutcomeSymbol = resolvePolymarketOutcomeSymbol(
            resultContext.symbol,
            existingSummary?.outcomeSymbol ?? this.readCurrentPolymarketOutcomeSymbol()
        );
        const seriesId = existingSummary?.seriesId || getEffectivePolymarket5mSeriesId(resultContext.symbol, resolvedOutcomeSymbol) || outcomes[0]?.series_id || "";

        const effectiveExitMode = existingSummary?.evaluationMode ?? resolveEffectivePolymarketExitMode({
            requestedMode: this.readCurrentPolymarketExitMode(),
            interval: resultContext.interval,
            executionModel: this.readCurrentExecutionModel(),
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
                    const annotatedTrades = result.trades.map((trade) => {
                        const exitResult = exitResults.find((r) => r.trade === trade);
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
                } catch {
                    // Fall through to resolve_hold
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

    private resolveSelectedPolymarketEntryOffset(_result: BacktestResult): number {
        return this.readCurrentPolymarketEntryOffset() ?? 0;
    }

    private readCurrentPolymarketEntryOffset(): number | null {
        const element = document.getElementById("polymarketEntryOffset");
        if (!(element instanceof HTMLSelectElement)) {
            return null;
        }
        const value = Number(element.value);
        return Number.isFinite(value) ? value : null;
    }

    private readCurrentPolymarketExitMode(): "resolve_hold" | "signal_exit_same_event" | undefined {
        const element = document.getElementById("polymarketExitMode");
        if (!(element instanceof HTMLSelectElement)) {
            return undefined;
        }
        return element.value === "signal_exit_same_event" ? "signal_exit_same_event" : "resolve_hold";
    }

    private readCurrentExecutionModel(): string | undefined {
        const element = document.getElementById("executionModel");
        return element instanceof HTMLSelectElement ? element.value : undefined;
    }

    private readCurrentPolymarketOutcomeSymbol(): string | null {
        const element = document.getElementById("polymarketOutcomeSymbol");
        if (!(element instanceof HTMLSelectElement)) {
            return null;
        }
        const value = element.value.trim().toUpperCase();
        return value.length > 0 ? value : null;
    }

    private resolveActivePolymarketOutcomeSymbol(result: BacktestResult): string | null {
        const summarySymbol = result.polymarketTradeSummary?.outcomeSymbol;
        if (typeof summarySymbol === "string" && summarySymbol.trim().length > 0) {
            return summarySymbol.trim().toUpperCase();
        }
        return this.readCurrentPolymarketOutcomeSymbol();
    }

    private async enrichHistoryInBackground(requestId: number, rows: PolymarketOutcomeRow[]): Promise<void> {
        if (rows.length === 0) {
            this.isEnrichingHistory = false;
            this.scheduleRender();
            return;
        }

        this.isEnrichingHistory = true;
        this.scheduleRender();

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
                    this.deployabilityCacheKey = "";
                    this.scheduleRender(120);
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
        this.scheduleRender();
    }

    private render(): void {
        if (!this.isPanelVisible()) {
            return;
        }

        const result = this.lastResult;
        const resultContext = resolveBacktestResultMarketContext(result);
        const supportedRun = resultContext
            ? supportsPolymarketOutcomeBridgeRun(
                resultContext.symbol,
                resultContext.interval,
                result ? this.resolveActivePolymarketOutcomeSymbol(result) : this.readCurrentPolymarketOutcomeSymbol()
            )
            : supportsPolymarketOutcomeBridgeRun(state.currentSymbol, state.currentInterval, this.readCurrentPolymarketOutcomeSymbol());

        this.renderBridgeControls();

        if (!result) {
            this.showEmpty("Run a backtest first to see Polymarket payout diagnostics and snapshot filter suggestions.");
            return;
        }

        if (!supportedRun) {
            this.showEmpty(`This tab currently supports ${getSupportedPolymarket5mSymbolsLabel()} on the 5m chart or on 1m via the 5m outcome bridge.`);
            return;
        }

        if (result.trades.length === 0) {
            this.showEmpty("The current backtest has no executed trades to evaluate.");
            return;
        }

        if (this.isLoading) {
            this.showEmpty("Loading Polymarket outcome rows from local SQLite...");
            return;
        }

        if (this.loadError) {
            this.showEmpty(`Failed to load Polymarket outcomes. ${this.loadError}`);
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
            payoutSummary ? this.buildPayoutSummarySection(payoutSummary) : "",
            summary ? this.buildPolymarketSummarySection(summary) : "",
            ...sections.map((section) => this.buildDiagnosticBucketSection(section)),
        ].filter(Boolean).join("");

        setVisible(dom.polymarketDiagnosticsEmpty, false);
        setVisible(dom.polymarketDiagnosticsContent, true);
    }

    private getPolymarketSummary(result: BacktestResult): {
        wins: number;
        losses: number;
        scoredTrades: number;
        missingTrades: number;
        unscoredTrades: number;
        coverage: number;
        winRate: number;
        outcomeRowsLoaded: number;
        baselineDelta: number;
        entryOffset?: number;
        bestTimingProfile?: NonNullable<NonNullable<BacktestResult["polymarketTradeSummary"]>["timingProfile"]>[number] | null;
        evaluationMode?: "resolve_hold" | "signal_exit_same_event";
        signalExitedTrades?: number;
        resolvedTrades?: number;
    } | null {
        const summary = result.polymarketTradeSummary;
        const isSignalExit = summary?.evaluationMode === "signal_exit_same_event";

        const wins = isSignalExit
            ? (summary?.profitableTrades ?? result.trades.filter((t) => t.polymarketOutcome?.isProfitable === true).length)
            : result.trades.filter((trade) => trade.polymarketOutcome?.isWin === true).length;
        const losses = isSignalExit
            ? (summary?.losingTrades ?? result.trades.filter((t) => t.polymarketOutcome?.isProfitable === false).length)
            : result.trades.filter((trade) => trade.polymarketOutcome?.isWin === false).length;
        const scoredTrades = isSignalExit ? (summary?.scoredTrades ?? wins + losses) : wins + losses;

        if (!summary && scoredTrades === 0) {
            return null;
        }

        const totalTrades = result.totalTrades > 0 ? result.totalTrades : result.trades.length;
        const missingTrades = summary?.missingOutcomeTrades ?? Math.max(0, totalTrades - scoredTrades);
        const unscoredTrades = summary?.unscoredTrades ?? Math.max(0, totalTrades - scoredTrades);
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
            scoredTrades,
            missingTrades,
            unscoredTrades,
            coverage,
            winRate: scoredTrades > 0 ? wins / scoredTrades : 0,
            outcomeRowsLoaded: summary?.outcomeRowsLoaded ?? countDistinctPolymarketOutcomeRows(result.trades),
            baselineDelta: isSignalExit ? 0 : (scoredTrades > 0 ? wins / scoredTrades : 0) - baselineWinRate,
            entryOffset: summary?.entryOffset,
            bestTimingProfile,
            evaluationMode: isSignalExit ? "signal_exit_same_event" : undefined,
            signalExitedTrades: isSignalExit ? (summary?.signalExitedTrades ?? 0) : undefined,
            resolvedTrades: isSignalExit ? (summary?.resolvedTrades ?? 0) : undefined,
        };
    }

    private buildPayoutSummarySection(summary: NonNullable<ReturnType<typeof summarizePolymarketPayoutDiagnostics>>): string {
        return `
            <div class="deployability-section">
                <div class="section-subtitle">Payout Summary</div>
                <div class="entry-stats-hint polymarket-diagnostics__hint">Polymarket is a binary payout. Long trades buy YES, short trades buy NO. A short entered at 90c is a 90c NO entry and pays 10c on a win. Exp is shown in cents per $1 share.</div>
                <div class="stats-grid polymarket-panel__stats">
                    ${this.renderStatCard("Priced Trades", String(summary.pricedTrades))}
                    ${summary.unpricedScoredTrades > 0 ? this.renderStatCard("Unpriced Scored Trades", String(summary.unpricedScoredTrades)) : ""}
                    ${this.renderStatCard("Avg Entry Price", this.formatProbability(summary.avgEntryPrice))}
                    ${this.renderStatCard("Break-even Win", this.formatPercent(summary.breakEvenWinRate))}
                    ${this.renderStatCard("Poly Win Rate", this.formatPercent(summary.winRate), summary.edgeVsBreakEven)}
                    ${this.renderStatCard("Poly Exp / Trade", this.formatPolymarketCents(summary.expectancy), summary.expectancy)}
                    ${this.renderStatCard("Poly Profit Factor", this.formatProfitFactor(summary.profitFactor))}
                    ${this.renderStatCard("Edge Vs Break-even", `${summary.edgeVsBreakEven >= 0 ? "+" : ""}${(summary.edgeVsBreakEven * 100).toFixed(1)}pp`, summary.edgeVsBreakEven)}
                </div>
            </div>
        `;
    }

    private buildPolymarketSummarySection(summary: NonNullable<ReturnType<PolymarketPanelService["getPolymarketSummary"]>>): string {
        const isSignalExit = summary.evaluationMode === "signal_exit_same_event";
        const runModeLabel = isSignalExit ? "Exit Mode" : (typeof summary.entryOffset === "number" ? "Selected Offset" : "Run Mode");
        const runModeValue = isSignalExit ? "Signal Exit (same event)" : (typeof summary.entryOffset === "number" ? `Minute ${summary.entryOffset}` : "Native 5m scoring");
        const timingContext = summary.bestTimingProfile
            ? `Best minute ${summary.bestTimingProfile.entryOffset} at ${this.formatPercent(summary.bestTimingProfile.winRate)}`
            : isSignalExit ? "Signal-exit mode: trades exit on chart sell signal inside the same 5m event." : "Full timing profile is available in 1m bridge runs.";

        const signalExitCards = isSignalExit ? `
                    ${this.renderStatCard("Signal Exited", String(summary.signalExitedTrades ?? 0))}
                    ${this.renderStatCard("Resolved (Held)", String(summary.resolvedTrades ?? 0))}
        ` : '';

        const baselineCard = isSignalExit ? '' : `
                    ${this.renderStatCard("Baseline Delta", `${summary.baselineDelta >= 0 ? "+" : ""}${(summary.baselineDelta * 100).toFixed(1)}pp`, summary.baselineDelta)}
        `;

        return `
            <div class="deployability-section">
                <div class="section-subtitle">Polymarket Summary</div>
                <div class="entry-stats-hint polymarket-diagnostics__hint">${timingContext}</div>
                <div class="stats-grid polymarket-panel__stats">
                    ${this.renderStatCard(runModeLabel, runModeValue)}
                    ${this.renderStatCard(isSignalExit ? "Poly Profitable %" : "Poly Win Rate", this.formatPercent(summary.winRate), summary.winRate - 0.5)}
                    ${this.renderStatCard("Scored Trade Share", this.formatPercent(summary.coverage))}
                    ${this.renderStatCard("Poly Wins", String(summary.wins), summary.wins > 0 ? 1 : 0)}
                    ${this.renderStatCard("Poly Losses", String(summary.losses), summary.losses > 0 ? -1 : 0)}
                    ${baselineCard}
                    ${signalExitCards}
                    ${this.renderStatCard("Scored Trades", String(summary.scoredTrades))}
                    ${this.renderStatCard("Unscored Trades", String(summary.unscoredTrades))}
                    ${summary.missingTrades > 0 ? this.renderStatCard("Missing Outcome Rows", String(summary.missingTrades)) : ""}
                    ${this.renderStatCard("Outcome Rows Fetched", String(summary.outcomeRowsLoaded))}
                </div>
            </div>
        `;
    }

    private buildDiagnosticBucketSection(section: ExpectancyBreakdownSection): string {
        const rows = section.rows.map((row) => `
            <tr>
                <td>${row.label}</td>
                <td>${row.tradeCount}t</td>
                <td class="${(row.edgeVsBreakEven ?? (row.winRate - 50)) >= 0 ? "positive" : "negative"}">${row.winRate.toFixed(1)}%</td>
                <td class="${row.expectancy >= 0 ? "positive" : "negative"}">${row.avgEntryPrice !== undefined && row.avgEntryPrice !== null ? this.formatPolymarketCents(row.expectancy) : this.formatSignedUsd(row.expectancy)}</td>
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
        const outcomeByStartTs = this.outcomeByStartTs;
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
        dom.deployWinRate.textContent = this.formatPercent(analysis.confidence.winRate);
        dom.deployWins.textContent = String(analysis.confidence.wins);
        dom.deployLosses.textContent = String(analysis.confidence.losses);
        dom.deployScoredTrades.textContent = String(analysis.confidence.scoredTrades);
        dom.deployCoverage.textContent = this.formatPercent(analysis.confidence.coverage);
        dom.deployWilsonLB.textContent = analysis.confidence.wilsonLowerBound.toFixed(3);
        dom.deployAlwaysYes.textContent = this.formatPercent(analysis.confidence.alwaysYesBaseline);
        dom.deployAlwaysNo.textContent = this.formatPercent(analysis.confidence.alwaysNoBaseline);

        const deltaYesPrefix = analysis.confidence.deltaVsAlwaysYes >= 0 ? "+" : "";
        const deltaNoPrefix = analysis.confidence.deltaVsAlwaysNo >= 0 ? "+" : "";
        dom.deployDeltaYes.textContent = `${deltaYesPrefix}${this.formatPercent(analysis.confidence.deltaVsAlwaysYes)}`;
        dom.deployDeltaNo.textContent = `${deltaNoPrefix}${this.formatPercent(analysis.confidence.deltaVsAlwaysNo)}`;

        // Render chronological blocks
        dom.deployBlocksBody.innerHTML = analysis.chronologicalBlocks.map((block) => `
            <tr>
                <td>${block.label}</td>
                <td>${block.scoredTrades}</td>
                <td>${block.wins}</td>
                <td>${block.losses}</td>
                <td>${this.formatPercent(block.winRate)}</td>
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
                <td>${this.formatPercent(regime.winRate)}</td>
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
                <td>${this.formatPercent(regime.winRate)}</td>
                <td>${regime.wilsonLowerBound.toFixed(3)}</td>
            </tr>
        `).join("");
        if (entryBucketsBody.length === 0) {
            dom.deployEntryBucketsBody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#888;">No entry price data available</td></tr>`;
        }

        // Render shuffle test
        dom.deployShuffleHint.textContent = analysis.significanceTest.hint;
        dom.deployShuffleSims.textContent = analysis.significanceTest.methodValue;
        dom.deployShuffleObserved.textContent = this.formatPercent(analysis.significanceTest.observedWinRate);
        dom.deployShuffleExceed.textContent = analysis.significanceTest.baselineValue;
        dom.deployShufflePValue.textContent = analysis.significanceTest.pValue.toFixed(3);
        dom.deployShuffleMean.textContent = this.formatPercent(analysis.significanceTest.expectedWinRate);
        dom.deployShuffleP95.textContent = analysis.significanceTest.diagnosticValue;

        // Render fill-adjusted metrics
        if (analysis.fillAdjusted) {
            dom.deployFillScored.textContent = String(analysis.fillAdjusted.scoredTrades);
            dom.deployFillWins.textContent = String(analysis.fillAdjusted.wins);
            dom.deployFillLosses.textContent = String(analysis.fillAdjusted.losses);
            dom.deployFillWinRate.textContent = this.formatPercent(analysis.fillAdjusted.winRate);
            dom.deployFillWilsonLB.textContent = analysis.fillAdjusted.wilsonLowerBound.toFixed(3);
            dom.deployFillRate.textContent = this.formatPercent(analysis.fillAdjusted.fillRate);
            if (analysis.significanceTest.mode === "one_sided_binomial" && analysis.significanceTest.constantPrediction) {
                const predictionLabel = analysis.significanceTest.constantPrediction.toUpperCase();
                const predictionBaseline = analysis.significanceTest.constantPrediction === "yes"
                    ? analysis.fillAdjusted.alwaysYesBaseline
                    : analysis.fillAdjusted.alwaysNoBaseline;
                dom.deployFillBestBaselineLabel.textContent = `Fill-Subset ${predictionLabel} Base`;
                dom.deployFillBestBaseline.textContent = `${predictionLabel} ${this.formatPercent(predictionBaseline)}`;
                dom.deployFillDeltaBaselineLabel.textContent = "Base Comparison";
                dom.deployFillDeltaBaseline.textContent = "One-sided: not informative";
            } else {
                dom.deployFillBestBaselineLabel.textContent = "Fill-Subset Best Base";
                dom.deployFillBestBaseline.textContent = `${analysis.fillAdjusted.bestBaselineLabel} ${this.formatPercent(analysis.fillAdjusted.bestBaseline)}`;
                dom.deployFillDeltaBaselineLabel.textContent = "Delta vs Best Base";
                dom.deployFillDeltaBaseline.textContent = `${analysis.fillAdjusted.deltaVsBestBaseline >= 0 ? "+" : ""}${this.formatPercent(analysis.fillAdjusted.deltaVsBestBaseline)}`;
            }
            dom.deployFillBreakEven.textContent = this.formatPercent(analysis.fillAdjusted.breakEvenWinRate);
            dom.deployFillEdgeBreakEven.textContent = `${analysis.fillAdjusted.edgeVsBreakEven >= 0 ? "+" : ""}${this.formatPercent(analysis.fillAdjusted.edgeVsBreakEven)}`;
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
        if (this.loadedOutcomeRows.length === 0) {
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
            return [...this.loadedOutcomeRows];
        }

        return this.loadedOutcomeRows.filter((row) => validTargetTs.has(row.event_start_ts));
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

    private resetLoadedRows(clearResult = true): void {
        this.loadNonce++;
        this.loadedOutcomeRows = [];
        this.outcomeByStartTs.clear();
        this.historySummaryByStartTs.clear();
        this.isLoading = false;
        this.isEnrichingHistory = false;
        this.loadError = null;
        this.loadedResultSignature = "";
        this.deployabilityCacheKey = "";
        this.deployabilityCache = null;
        if (clearResult) {
            this.lastResult = null;
        }
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

    private getResultSignature(result: BacktestResult): string {
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

    private getDeployabilityAnalysis(
        result: BacktestResult,
        scoredTrades: ReturnType<typeof extractScoredTrades>,
        evaluationRows: PolymarketOutcomeRow[],
        fillScope: PolymarketFillScope,
        fillTargetPriceCents: number
    ): ReturnType<typeof analyzePolymarketDeployability> {
        const cacheKey = [
            this.getResultSignature(result),
            scoredTrades.length,
            evaluationRows.length,
            this.historySummaryByStartTs.size,
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
            historySummaryByStartTs: this.historySummaryByStartTs,
        });
        this.deployabilityCacheKey = cacheKey;
        this.deployabilityCache = analysis;
        return analysis;
    }

    private renderBridgeControls(): void {
        const dom = this.getDom();
        const supportedRun = isSupportedPolymarket5mRun(state.currentSymbol, state.currentInterval);
        const configs = this.ensureBridgeConfigOptions();
        const selectedConfig = this.getSelectedBridgeConfig(configs);
        const botSymbol = this.resolveExternalSignalSymbol(state.currentSymbol);
        const strategyAvailable = selectedConfig ? strategyRegistry.has(selectedConfig.strategyKey) : false;
        const canExport = Boolean(supportedRun && botSymbol && selectedConfig && strategyAvailable);

        dom.polymarketBridgeDownloadScript.disabled = !canExport;
        dom.polymarketBridgeCopyEnv.disabled = !canExport;

        if (configs.length === 0) {
            dom.polymarketBridgeStatus.textContent = "Save a configuration in Settings first. Bridge export uses saved strategy params, backtest settings, and capital settings.";
            return;
        }

        if (!selectedConfig) {
            dom.polymarketBridgeStatus.textContent = "Select a saved configuration to generate the bridge bundle.";
            return;
        }

        if (!strategyAvailable) {
            dom.polymarketBridgeStatus.textContent = `Saved config "${selectedConfig.name}" references unavailable strategy "${selectedConfig.strategyKey}".`;
            return;
        }

        if (!supportedRun || !botSymbol) {
            dom.polymarketBridgeStatus.textContent = `Bridge export currently supports ${getSupportedPolymarket5mSymbolsLabel()} on the 5m chart. Current chart: ${state.currentSymbol} ${state.currentInterval}.`;
            return;
        }

        dom.polymarketBridgeStatus.textContent = `Ready: "${selectedConfig.name}" -> ${selectedConfig.strategyKey} on ${state.currentSymbol} ${state.currentInterval}. The script writes bridge JSON files, exports the latest signal, generates a reusable refresh script, and writes a bot env snippet.`;
    }

    private ensureBridgeConfigOptions(force = false): StrategyConfig[] {
        const dom = this.getDom();
        const configs = [...settingsManager.loadAllStrategyConfigs()].sort((left, right) => {
            const timeDelta = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
            if (Number.isFinite(timeDelta) && timeDelta !== 0) {
                return timeDelta;
            }
            return left.name.localeCompare(right.name);
        });
        const signature = configs
            .map((config) => `${config.name}|${config.updatedAt}|${config.strategyKey}`)
            .join("||");

        if (
            !force
            && signature === this.bridgeConfigSignature
            && dom.polymarketBridgeConfig.options.length > 0
        ) {
            return configs;
        }

        const preferredName = dom.polymarketBridgeConfig.value || this.selectedBridgeConfigName;
        dom.polymarketBridgeConfig.innerHTML = "";

        const placeholderOption = document.createElement("option");
        placeholderOption.value = "";
        placeholderOption.textContent = "Select saved configuration";
        dom.polymarketBridgeConfig.appendChild(placeholderOption);

        for (const config of configs) {
            const option = document.createElement("option");
            option.value = config.name;
            option.textContent = `${config.name} | ${config.strategyKey}`;
            option.title = `Updated ${config.updatedAt}`;
            dom.polymarketBridgeConfig.appendChild(option);
        }

        const nextSelection = preferredName && configs.some((config) => config.name === preferredName)
            ? preferredName
            : configs[0]?.name ?? "";

        dom.polymarketBridgeConfig.value = nextSelection;
        this.selectedBridgeConfigName = nextSelection;
        this.bridgeConfigSignature = signature;
        return configs;
    }

    private getSelectedBridgeConfig(configs = this.ensureBridgeConfigOptions()): StrategyConfig | null {
        const selectedName = this.getDom().polymarketBridgeConfig.value || this.selectedBridgeConfigName;
        if (!selectedName) {
            return null;
        }
        return configs.find((config) => config.name === selectedName) ?? null;
    }

    private async handleBridgeScriptDownload(): Promise<void> {
        const context = this.getBridgeExportContext();
        if (!context) {
            uiManager.showToast("Select a supported 5m chart and a valid saved config first.", "error");
            return;
        }

        const fileName = `run-polymarket-bridge-${context.slug}.ps1`;
        const script = this.buildBridgeScript(context.config, context.slug, context.botSymbol);
        this.downloadTextFile(fileName, script, "text/plain;charset=utf-8");
        this.getDom().polymarketBridgeStatus.textContent = `Downloaded ${fileName}. Run it in PowerShell to write the bridge bundle, generate the refresh helper, and export the latest signal.`;
        uiManager.showToast(`Downloaded ${fileName}`, "success");
    }

    private async handleCopyBotEnv(): Promise<void> {
        const context = this.getBridgeExportContext();
        if (!context) {
            uiManager.showToast("Select a supported 5m chart and a valid saved config first.", "error");
            return;
        }

        const snippet = this.buildBotEnvSnippet(context.slug, context.botSymbol, context.config.name);
        const copied = await this.copyToClipboard(snippet);
        if (!copied) {
            uiManager.showToast("Failed to copy bot env snippet.", "error");
            return;
        }

        this.getDom().polymarketBridgeStatus.textContent = `Copied bot env snippet for "${context.config.name}". The downloaded script will also generate a matching .env snippet file with the resolved signal and refresh-script paths.`;
        uiManager.showToast("Copied bot env snippet", "success");
    }

    private getBridgeExportContext(): { config: StrategyConfig; slug: string; botSymbol: string } | null {
        const supportedRun = isSupportedPolymarket5mRun(state.currentSymbol, state.currentInterval);
        if (!supportedRun) {
            return null;
        }

        const config = this.getSelectedBridgeConfig();
        if (!config || !strategyRegistry.has(config.strategyKey)) {
            return null;
        }

        const strategy = strategyRegistry.get(config.strategyKey)!;
        if (strategy.crossSymbolConfig) {
            this.getDom().polymarketBridgeStatus.textContent = `"${config.name}" uses cross-symbol strategy "${config.strategyKey}" which is not supported by bridge export.`;
            return null;
        }

        const botSymbol = this.resolveExternalSignalSymbol(state.currentSymbol);
        if (!botSymbol) {
            return null;
        }

        return {
            config,
            slug: this.slugifyConfigName(config.name),
            botSymbol,
        };
    }

    private buildBridgeScript(config: StrategyConfig, slug: string, botSymbol: string): string {
        const paramsJson = JSON.stringify(config.strategyParams, null, 2);
        const backtestJson = JSON.stringify(config.backtestSettings, null, 2);
        const capitalJson = JSON.stringify(settingsManager.resolveCapitalFromConfig(config), null, 2);
        const configName = this.toPowerShellSingleQuoted(config.name);
        const strategyKey = this.toPowerShellSingleQuoted(config.strategyKey);
        const symbol = this.toPowerShellSingleQuoted(state.currentSymbol);
        const interval = this.toPowerShellSingleQuoted(state.currentInterval);
        const slugLiteral = this.toPowerShellSingleQuoted(slug);
        const botSymbolLiteral = this.toPowerShellSingleQuoted(botSymbol);
        const refreshScriptBody = [
            "param(",
            "    [string]$StrategyFinderRoot = '',",
            "    [int]$Bars = 500,",
            "    [int]$FreshnessBars = 0",
            ")",
            "",
            "$ErrorActionPreference = 'Stop'",
            "",
            `function Test-StrategyFinderRoot {`,
            "    param([string]$CandidatePath)",
            "    if ([string]::IsNullOrWhiteSpace($CandidatePath)) { return $false }",
            "    $resolved = Resolve-Path -LiteralPath $CandidatePath -ErrorAction SilentlyContinue",
            "    if (-not $resolved) { return $false }",
            "    $root = $resolved.Path",
            "    return (Test-Path (Join-Path $root 'package.json')) -and (Test-Path (Join-Path $root 'scripts\\export-latest-entry-signal.ts'))",
            "}",
            "",
            "function Resolve-StrategyFinderRoot {",
            "    param([string]$ExplicitPath)",
            "    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {",
            "        if (Test-StrategyFinderRoot $ExplicitPath) {",
            "            return (Resolve-Path -LiteralPath $ExplicitPath).Path",
            "        }",
            "        throw ('Invalid StrategyFinderRoot: ' + $ExplicitPath)",
            "    }",
            "    if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {",
            "        throw 'PSScriptRoot is empty. Pass -StrategyFinderRoot explicitly.'",
            "    }",
            "    $signalsDir = Split-Path -Path $PSScriptRoot -Parent",
            "    if ([string]::IsNullOrWhiteSpace($signalsDir)) {",
            "        throw 'Could not resolve signals directory from bridge refresh script.'",
            "    }",
            "    $candidateRoot = Split-Path -Path $signalsDir -Parent",
            "    if (Test-StrategyFinderRoot $candidateRoot) {",
            "        return (Resolve-Path -LiteralPath $candidateRoot).Path",
            "    }",
            "    throw ('Could not resolve Strategies-Finder root from ' + $PSScriptRoot + '. Pass -StrategyFinderRoot explicitly.')",
            "}",
            "",
            `$StrategyKey = ${strategyKey}`,
            `$Symbol = ${symbol}`,
            `$Interval = ${interval}`,
            `$ConfigSlug = ${slugLiteral}`,
            "",
            "$ResolvedRoot = Resolve-StrategyFinderRoot -ExplicitPath $StrategyFinderRoot",
            "$BridgeDir = Join-Path $ResolvedRoot 'signals\\bridge'",
            "$ParamsPath = Join-Path $BridgeDir ($ConfigSlug + '.params.json')",
            "$BacktestPath = Join-Path $BridgeDir ($ConfigSlug + '.backtest.json')",
            "$CapitalPath = Join-Path $BridgeDir ($ConfigSlug + '.capital.json')",
            "$SignalPath = Join-Path $BridgeDir ($ConfigSlug + '.latest-entry-signal.json')",
            "",
            "$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue",
            "if (-not $npmCommand) {",
            "    $npmCommand = Get-Command npm -ErrorAction SilentlyContinue",
            "}",
            "if (-not $npmCommand) {",
            "    throw 'npm was not found on PATH.'",
            "}",
            "",
            "Push-Location $ResolvedRoot",
            "try {",
            "    & $npmCommand.Source run signal:export -- --strategy $StrategyKey --symbol $Symbol --interval $Interval --bars $Bars --freshness-bars $FreshnessBars --params-file $ParamsPath --backtest-settings-file $BacktestPath --capital-settings-file $CapitalPath --out $SignalPath",
            "    if ($LASTEXITCODE -ne 0) {",
            "        throw ('signal:export exited with code ' + $LASTEXITCODE)",
            "    }",
            "}",
            "finally {",
            "    Pop-Location",
            "}",
            "",
            "Write-Host ('Signal refreshed: ' + $SignalPath)",
            "",
        ].join("\r\n");

        return [
            "param(",
            "    [string]$StrategyFinderRoot = '',",
            "    [int]$Bars = 500,",
            "    [int]$FreshnessBars = 0",
            ")",
            "",
            "$ErrorActionPreference = 'Stop'",
            "",
            `$ConfigName = ${configName}`,
            `$ConfigSlug = ${slugLiteral}`,
            `$StrategyKey = ${strategyKey}`,
            `$Symbol = ${symbol}`,
            `$Interval = ${interval}`,
            `$BotSymbol = ${botSymbolLiteral}`,
            "",
            "function Test-StrategyFinderRoot {",
            "    param([string]$CandidatePath)",
            "    if ([string]::IsNullOrWhiteSpace($CandidatePath)) { return $false }",
            "    $resolved = Resolve-Path -LiteralPath $CandidatePath -ErrorAction SilentlyContinue",
            "    if (-not $resolved) { return $false }",
            "    $root = $resolved.Path",
            "    return (Test-Path (Join-Path $root 'package.json')) -and (Test-Path (Join-Path $root 'scripts\\export-latest-entry-signal.ts'))",
            "}",
            "",
            "function Find-StrategyFinderRootFromSeed {",
            "    param([string]$SeedPath)",
            "    if ([string]::IsNullOrWhiteSpace($SeedPath)) { return $null }",
            "    $current = $SeedPath",
            "    while (-not [string]::IsNullOrWhiteSpace($current)) {",
            "        if (Test-StrategyFinderRoot $current) {",
            "            return (Resolve-Path -LiteralPath $current).Path",
            "        }",
            "        $parent = Split-Path -Path $current -Parent",
            "        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $current) {",
            "            break",
            "        }",
            "        $current = $parent",
            "    }",
            "    return $null",
            "}",
            "",
            "function Resolve-StrategyFinderRoot {",
            "    param([string]$ExplicitPath)",
            "    $candidates = @()",
            "    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) { $candidates += $ExplicitPath }",
            "    if (-not [string]::IsNullOrWhiteSpace($env:STRATEGY_FINDER_ROOT)) { $candidates += $env:STRATEGY_FINDER_ROOT }",
            "    if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) { $candidates += $PSScriptRoot }",
            "    $candidates += (Get-Location).Path",
            "    $userProfile = [Environment]::GetFolderPath('UserProfile')",
            "    if (-not [string]::IsNullOrWhiteSpace($userProfile)) {",
            "        $candidates += (Join-Path $userProfile 'Documents\\Repo\\Experimental\\lightweight-charts\\debug\\playground\\Strategies-Finder')",
            "        $candidates += (Join-Path $userProfile 'Documents\\Strategies-Finder')",
            "    }",
            "    foreach ($candidate in $candidates) {",
            "        $resolved = Find-StrategyFinderRootFromSeed $candidate",
            "        if (-not [string]::IsNullOrWhiteSpace($resolved)) {",
            "            return $resolved",
            "        }",
            "    }",
            "    throw 'Could not locate the Strategies-Finder repo. Run this script from the repo, pass -StrategyFinderRoot, or set STRATEGY_FINDER_ROOT.'",
            "}",
            "",
            "function Write-Utf8NoBomFile {",
            "    param(",
            "        [string]$Path,",
            "        [string]$Content",
            "    )",
            "    $encoding = New-Object System.Text.UTF8Encoding($false)",
            "    [System.IO.File]::WriteAllText($Path, $Content, $encoding)",
            "}",
            "",
            "$StrategyFinderRoot = Resolve-StrategyFinderRoot -ExplicitPath $StrategyFinderRoot",
            "$BridgeDir = Join-Path $StrategyFinderRoot 'signals\\bridge'",
            "$ParamsPath = Join-Path $BridgeDir ($ConfigSlug + '.params.json')",
            "$BacktestPath = Join-Path $BridgeDir ($ConfigSlug + '.backtest.json')",
            "$CapitalPath = Join-Path $BridgeDir ($ConfigSlug + '.capital.json')",
            "$SignalPath = Join-Path $BridgeDir ($ConfigSlug + '.latest-entry-signal.json')",
            "$RefreshScriptPath = Join-Path $BridgeDir ($ConfigSlug + '.refresh.ps1')",
            "$BotEnvPath = Join-Path $BridgeDir ($ConfigSlug + '.bot.env')",
            "$SignalPathForEnv = $SignalPath -replace '\\\\', '/'",
            "$RefreshScriptPathForEnv = $RefreshScriptPath -replace '\\\\', '/'",
            "New-Item -ItemType Directory -Path $BridgeDir -Force | Out-Null",
            "",
            "$ParamsJson = @'",
            paramsJson,
            "'@",
            "",
            "$BacktestJson = @'",
            backtestJson,
            "'@",
            "",
            "$CapitalJson = @'",
            capitalJson,
            "'@",
            "",
            "Write-Utf8NoBomFile -Path $ParamsPath -Content $ParamsJson",
            "Write-Utf8NoBomFile -Path $BacktestPath -Content $BacktestJson",
            "Write-Utf8NoBomFile -Path $CapitalPath -Content $CapitalJson",
            "",
            "$RefreshScript = @'",
            refreshScriptBody,
            "'@",
            "",
            "Write-Utf8NoBomFile -Path $RefreshScriptPath -Content $RefreshScript",
            "",
            '$BotEnv = @"',
            "TRADING_MODE=external_signal",
            "DRY_RUN=true",
            "EXTERNAL_SIGNAL_SYMBOL=$BotSymbol",
            "EXTERNAL_SIGNAL_FILE=$SignalPathForEnv",
            "EXTERNAL_SIGNAL_POLL_INTERVAL_MS=2000",
            "EXTERNAL_SIGNAL_MAX_SIGNAL_LAG_SECS=600",
            "EXTERNAL_SIGNAL_LOG_FILE=logs/external_signal.jsonl",
            "EXTERNAL_SIGNAL_REFRESH_SCRIPT=$RefreshScriptPathForEnv",
            "EXTERNAL_SIGNAL_REFRESH_DELAY_SECS=2",
            "EXTERNAL_SIGNAL_REFRESH_TIMEOUT_SECS=120",
            "MULTI_WALLET_NON_INTERACTIVE=true",
            "WALLET_1_STRATEGY=external_signal",
            '"@',
            "Write-Utf8NoBomFile -Path $BotEnvPath -Content $BotEnv",
            "",
            "& $RefreshScriptPath -StrategyFinderRoot $StrategyFinderRoot -Bars $Bars -FreshnessBars $FreshnessBars",
            "",
            "Write-Host ('Bridge ready for ' + $ConfigName)",
            "Write-Host ('Signal file: ' + $SignalPath)",
            "Write-Host ('Refresh script: ' + $RefreshScriptPath)",
            "Write-Host ('Bot env snippet: ' + $BotEnvPath)",
            "",
        ].join("\r\n");
    }

    private buildBotEnvSnippet(slug: string, botSymbol: string, configName: string): string {
        return [
            `# ${configName}`,
            "# Replace <STRATEGY_FINDER_ROOT> with your local Strategies-Finder path, using forward slashes, or run the downloaded script and use the generated .bot.env file.",
            "TRADING_MODE=external_signal",
            "DRY_RUN=true",
            `EXTERNAL_SIGNAL_SYMBOL=${botSymbol}`,
            `EXTERNAL_SIGNAL_FILE=<STRATEGY_FINDER_ROOT>/signals/bridge/${slug}.latest-entry-signal.json`,
            "EXTERNAL_SIGNAL_POLL_INTERVAL_MS=2000",
            "EXTERNAL_SIGNAL_MAX_SIGNAL_LAG_SECS=600",
            "EXTERNAL_SIGNAL_LOG_FILE=logs/external_signal.jsonl",
            `EXTERNAL_SIGNAL_REFRESH_SCRIPT=<STRATEGY_FINDER_ROOT>/signals/bridge/${slug}.refresh.ps1`,
            "EXTERNAL_SIGNAL_REFRESH_DELAY_SECS=2",
            "EXTERNAL_SIGNAL_REFRESH_TIMEOUT_SECS=120",
            "MULTI_WALLET_NON_INTERACTIVE=true",
            "WALLET_1_STRATEGY=external_signal",
        ].join("\r\n");
    }

    private resolveExternalSignalSymbol(symbol: string): string | null {
        const normalized = symbol.trim().toUpperCase();
        if (normalized === "BTCUSDT") return "btc";
        if (normalized === "ETHUSDT") return "eth";
        if (normalized === "SOLUSDT") return "sol";
        if (normalized === "XRPUSDT") return "xrp";
        return null;
    }

    private slugifyConfigName(name: string): string {
        const slug = name
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
        return slug || "saved-config";
    }

    private toPowerShellSingleQuoted(value: string): string {
        return `'${value.replace(/'/g, "''")}'`;
    }

    private downloadTextFile(fileName: string, content: string, mime: string): void {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    private async copyToClipboard(text: string): Promise<boolean> {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            const textarea = document.createElement("textarea");
            textarea.value = text;
            textarea.style.position = "fixed";
            textarea.style.left = "-9999px";
            document.body.appendChild(textarea);
            textarea.select();
            const copied = document.execCommand("copy");
            document.body.removeChild(textarea);
            return copied;
        }
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

    private formatScopeLabel(scope: PolymarketFillScope): string {
        if (scope === "long") return "YES-only fills";
        if (scope === "short") return "NO-only fills";
        return "All executed trades";
    }

    private formatPercent(value: number): string {
        return `${(value * 100).toFixed(1)}%`;
    }

    private formatProbability(value: number): string {
        return `${(Math.abs(value) * 100).toFixed(1)}c`;
    }

    private formatPolymarketCents(value: number): string {
        const prefix = value > 0 ? "+" : value < 0 ? "-" : "";
        return `${prefix}${(Math.abs(value) * 100).toFixed(1)}c`;
    }

    private formatProfitFactor(value: number | null): string {
        if (value === null || !Number.isFinite(value)) {
            return value === Infinity ? "âˆž" : "n/a";
        }
        return value.toFixed(2);
    }

    private formatSignedUsd(value: number): string {
        const prefix = value > 0 ? "+" : value < 0 ? "-" : "";
        return `${prefix}$${Math.abs(value).toFixed(2)}`;
    }

    private getDom(): PolymarketPanelDom {
        return this.dom ??= createPolymarketPanelDom();
    }
}

export const polymarketPanelService = new PolymarketPanelService();
