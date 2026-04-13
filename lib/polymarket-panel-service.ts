import { createPolymarketPanelDom, type PolymarketPanelDom } from "./polymarket-panel-dom";
import {
    getSupportedPolymarket5mSymbolsLabel,
    supportsPolymarketOutcomeBridgeRun,
} from "./polymarket-btc5m";
import type { PolymarketFillScope } from "./polymarket-fill-analysis";
import { parseTimeToUnixSeconds } from "./time-normalization";
import { state } from "./state";
import { setVisible } from "./dom-utils";
import type { BacktestResult, ExpectancyBreakdownSection } from "./types/strategies";
import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";
import { resolveBacktestResultMarketContext } from "./backtest-result-context";
import { resolvePolymarketDomSettings } from "./polymarket-dom-reader";
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
            readCurrentPolymarketExitMode: () => this.readCurrentPolymarketExitMode(),
            readCurrentPolymarketOutcomeSymbol: () => this.readCurrentPolymarketOutcomeSymbol(),
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

    private readCurrentPolymarketExitMode(): "resolve_hold" | "signal_exit_same_event" | undefined {
        return resolvePolymarketDomSettings().exitMode;
    }

    private readCurrentExecutionModel(): string | undefined {
        return resolvePolymarketDomSettings().executionModel;
    }

    private readCurrentPolymarketOutcomeSymbol(): string | null {
        return resolvePolymarketDomSettings().outcomeSymbol;
    }

    private render(): void {
        if (!this.isPanelVisible()) {
            return;
        }

        const loader = this.outcomeLoader!;
        const result = loader.lastResult;
        const resultContext = resolveBacktestResultMarketContext(result);
        const supportedRun = resultContext
            ? supportsPolymarketOutcomeBridgeRun(
                resultContext.symbol,
                resultContext.interval,
                result ? loader.resolveActivePolymarketOutcomeSymbol(result) : this.readCurrentPolymarketOutcomeSymbol()
            )
            : supportsPolymarketOutcomeBridgeRun(state.currentSymbol, state.currentInterval, this.readCurrentPolymarketOutcomeSymbol());

        this.bridgeExport!.renderBridgeControls();

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
                    ${this.renderStatCard("Avg Entry Price", formatProbability(summary.avgEntryPrice))}
                    ${this.renderStatCard("Break-even Win", formatPercent(summary.breakEvenWinRate))}
                    ${this.renderStatCard("Poly Win Rate", formatPercent(summary.winRate), summary.edgeVsBreakEven)}
                    ${this.renderStatCard("Poly Exp / Trade", formatPolymarketCents(summary.expectancy), summary.expectancy)}
                    ${this.renderStatCard("Poly Profit Factor", formatProfitFactor(summary.profitFactor))}
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
            ? `Best minute ${summary.bestTimingProfile.entryOffset} at ${formatPercent(summary.bestTimingProfile.winRate)}`
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
                    ${this.renderStatCard(isSignalExit ? "Poly Profitable %" : "Poly Win Rate", formatPercent(summary.winRate), summary.winRate - 0.5)}
                    ${this.renderStatCard("Scored Trade Share", formatPercent(summary.coverage))}
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
