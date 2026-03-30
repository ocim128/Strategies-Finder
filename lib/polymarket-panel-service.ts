import { createPolymarketPanelDom, type PolymarketPanelDom } from "./polymarket-panel-dom";
import type { PolymarketFillHistorySummary } from "./polymarket-fill-history";
import { loadPolymarketFillHistorySummary } from "./polymarket-fill-history";
import {
    getSupportedPolymarket5mSymbolsLabel,
    isSupportedPolymarket5mRun,
    loadPolymarket5mOutcomesForTimeRange,
    supportsPolymarketOutcomeBridgeRun,
} from "./polymarket-btc5m";
import { analyzePolymarketFillability, type PolymarketFillScope } from "./polymarket-fill-analysis";
import { parseTimeToUnixSeconds } from "./time-normalization";
import { state } from "./state";
import { setVisible } from "./dom-utils";
import type { BacktestResult } from "./types/strategies";
import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";
import { settingsManager, type StrategyConfig } from "./settings-manager";
import { uiManager } from "./ui-manager";
import { strategyRegistry } from "../strategyRegistry";
import { resolveBacktestResultMarketContext } from "./backtest-result-context";
import {
    analyzePolymarketDeployability,
    extractScoredTrades,
} from "./polymarket-deployability-analysis";

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
        dom.polymarketEntryPriceCents.addEventListener("input", () => {
            this.deployabilityCacheKey = "";
            this.scheduleRender();
        });
        dom.polymarketScope.addEventListener("change", () => {
            this.deployabilityCacheKey = "";
            this.scheduleRender();
        });
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
        this.deployabilityCacheKey = "";
        const resultContext = resolveBacktestResultMarketContext(result);

        if (!result || !resultContext || !supportsPolymarketOutcomeBridgeRun(resultContext.symbol, resultContext.interval) || result.trades.length === 0) {
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
        if (!result || !resultContext || !supportsPolymarketOutcomeBridgeRun(resultContext.symbol, resultContext.interval) || result.trades.length === 0) {
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
                Math.max(...targetTimes)
            );
            if (requestId !== this.loadNonce) {
                return;
            }

            const targetSet = new Set(targetTimes);
            const matchedRows = rows.filter((row) => targetSet.has(row.event_start_ts));

            this.loadedOutcomeRows = rows;
            this.outcomeByStartTs = new Map(matchedRows.map((row) => [row.event_start_ts, row] as const));
            this.historySummaryByStartTs.clear();
            this.isLoading = false;
            this.loadedResultSignature = resultSignature;
            this.deployabilityCacheKey = "";
            this.scheduleRender();
            void this.enrichHistoryInBackground(requestId, matchedRows);
        } catch (error) {
            if (requestId !== this.loadNonce) {
                return;
            }

            this.loadedOutcomeRows = [];
            this.outcomeByStartTs.clear();
            this.historySummaryByStartTs.clear();
            this.isLoading = false;
            this.isEnrichingHistory = false;
            this.loadError = error instanceof Error ? error.message : String(error);
            this.loadedResultSignature = resultSignature;
            this.scheduleRender();
        }
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

        const dom = this.getDom();
        const result = this.lastResult;
        const supportedRun = supportsPolymarketOutcomeBridgeRun(state.currentSymbol, state.currentInterval);

        this.renderBridgeControls();

        if (!result) {
            this.showEmpty("Run a backtest first, then this tab will estimate Polymarket fills for the executed trades.");
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

        const scope = this.readScope();
        const targetPriceCents = this.readEntryPriceCents();
        const analysis = analyzePolymarketFillability({
            trades: result.trades,
            outcomeByStartTs: this.outcomeByStartTs,
            historySummaryByStartTs: this.historySummaryByStartTs,
            targetPriceCents,
            scope,
        });

        const finalWindow = analysis.windows.at(-1);
        const filledByLastWindow = finalWindow?.filledTrades ?? 0;
        const filledWinRate = finalWindow?.filledWinRate ?? 0;
        const missingPriceByLastWindow = finalWindow?.missingPriceTrades ?? 0;

        dom.polymarketEligibleTrades.textContent = String(analysis.eligibleTrades);
        dom.polymarketEnrichedTrades.textContent = String(analysis.enrichedEligibleTrades);
        dom.polymarketFilledTrades.textContent = String(filledByLastWindow);
        dom.polymarketFillRate.textContent = this.formatPercent(finalWindow?.fillRate ?? 0);
        dom.polymarketFilledWinRate.textContent = this.formatPercent(filledWinRate);

        dom.polymarketStatus.textContent = [
            `${this.formatScopeLabel(scope)} touch estimate at ${analysis.targetPriceCents.toFixed(1).replace(/\.0$/, "")}c.`,
            `${analysis.selectedTrades} selected trade${analysis.selectedTrades === 1 ? "" : "s"}, ${analysis.eligibleTrades} matched Polymarket row${analysis.eligibleTrades === 1 ? "" : "s"}.`,
            analysis.eligibleTrades > 0
                ? `${analysis.enrichedEligibleTrades} matched trade${analysis.enrichedEligibleTrades === 1 ? "" : "s"} use raw prices-history extrema, ${analysis.fallbackEligibleTrades} use synced checkpoint fallback.`
                : "No matched Polymarket rows to estimate fills from.",
            this.isEnrichingHistory ? "Raw history enrichment is still running in the background." : "",
            analysis.missingOutcomeTrades > 0 ? `${analysis.missingOutcomeTrades} trade${analysis.missingOutcomeTrades === 1 ? "" : "s"} missing outcome rows.` : "",
            missingPriceByLastWindow > 0 ? `${missingPriceByLastWindow} trade${missingPriceByLastWindow === 1 ? "" : "s"} missing fill history through +4m.` : "",
        ].filter(Boolean).join(" ");

        dom.polymarketTableBody.innerHTML = analysis.windows.map((window) => `
            <tr>
                <td>${window.label}</td>
                <td>${window.filledTrades}</td>
                <td>${this.formatPercent(window.fillRate)}</td>
                <td>${this.formatPercent(window.filledWinRate)}</td>
                <td>${window.missingPriceTrades}</td>
            </tr>
        `).join("");

        // Render deployability analysis
        this.renderDeployabilityAnalysis(result);

        setVisible(dom.polymarketEmpty, false);
        setVisible(dom.polymarketContent, true);
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
        dom.polymarketSupport.textContent = message;
        dom.deployabilitySupport.textContent = message;
        setVisible(dom.polymarketEmpty, true);
        setVisible(dom.polymarketContent, false);
        setVisible(dom.deployabilityEmpty, true);
        setVisible(dom.deployabilityContent, false);
        dom.polymarketStatus.textContent = "";
        dom.polymarketTableBody.innerHTML = "";
        dom.polymarketEligibleTrades.textContent = "0";
        dom.polymarketEnrichedTrades.textContent = "0";
        dom.polymarketFilledTrades.textContent = "0";
        dom.polymarketFillRate.textContent = "0.0%";
        dom.polymarketFilledWinRate.textContent = "0.0%";
        dom.deployShuffleHint.textContent = "Mixed-side strategies use a shuffle placebo test. One-sided strategies use a baseline significance test instead.";
        dom.deployShuffleSims.textContent = "Unavailable";
        dom.deployShuffleObserved.textContent = "0.0%";
        dom.deployShuffleExceed.textContent = "N/A";
        dom.deployShufflePValue.textContent = "1.000";
        dom.deployShuffleMean.textContent = "0.0%";
        dom.deployShuffleP95.textContent = "N/A";
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
        const firstTrade = result.trades[0];
        const lastTrade = result.trades[result.trades.length - 1];
        return [
            resultContext?.symbol ?? state.currentSymbol,
            resultContext?.interval ?? state.currentInterval,
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

    private getDom(): PolymarketPanelDom {
        return this.dom ??= createPolymarketPanelDom();
    }
}

export const polymarketPanelService = new PolymarketPanelService();
