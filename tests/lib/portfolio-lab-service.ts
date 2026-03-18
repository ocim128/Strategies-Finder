import { strategyRegistry } from "../strategyRegistry";
import { backtestService } from "./backtest-service";
import { sliceOhlcvByBlock } from "./block-selector";
import { trimToClosedCandles } from "./closed-candle-utils";
import { dataManager } from "./data-manager";
import { createPortfolioLabDom, type PortfolioLabDom } from "./feature-dom-contracts";
import { paramManager } from "./param-manager";
import {
    buildFilterRun,
    buildBreadthSweepRows,
    buildConsensusAnalysis,
    buildLiveContextSnapshot,
    buildOpenTradeForecast,
    buildOppositionSweepRows,
    buildPortfolioSignalPresenceLookup,
    buildRankingRows,
    buildRunnablePortfolioUniverse,
    buildSizingScenarios,
    buildTradeRanges,
    computeCloseReturnCorrelation,
    computeEquityReturnCorrelation,
    DEFAULT_FORECAST_ANCHOR,
    DEFAULT_LOOKBACK_BARS,
    findBestFilterRun,
    findSweepWinner,
    formatCurrency,
    formatDrawdownPercent,
    formatPercent,
    MAJOR_SYMBOLS,
    MAX_LOOKBACK_BARS,
    MAX_PORTFOLIO_SYMBOLS,
    MIN_LOOKBACK_BARS,
    type BreadthSweepRow,
    type CachedPairData,
    type ConsensusAnalysis,
    type LiveContextSnapshot,
    type OpenTradeForecast,
    type OppositionSweepRow,
    type PairAnalysisRow,
    type PairRankingRow,
    type PairRunArtifacts,
    type PortfolioRunContext,
    type PortfolioWindowMode,
    type SizingScenarioRow,
} from "./portfolioLab";
import { renderPortfolioLab } from "./portfolioLab/portfolio-lab-renderer";
import {
    renderBreadthSweep,
    renderConsensusSummary,
    renderConsensusTable,
    renderCorrelationMatrix,
    renderExecutionSummary,
    renderForecastDetails,
    renderForecastSummary,
    renderForecastTable,
    renderInsights,
    renderLiveContextDetails,
    renderLiveContextSummary,
    renderOppositionSweep,
    renderRankingSummary,
    renderRankingTable,
    renderRow,
    renderSizingSummary,
    renderSizingTable,
    renderSummary,
} from "./portfolioLab/portfolio-lab-html";
import { state } from "./state";
import { applySignalPolarity, timeKey, type OHLCVData, type Strategy, type StrategyParams } from "./strategies";
import { getTimeIndex } from "./strategies/backtest/backtest-utils";
import { strategyPanelController } from "./strategy-panel-controller";
import { parseTimeToUnixSeconds } from "./time-normalization";
import { uiManager } from "./ui-manager";

class PortfolioLabService {
    private dom: PortfolioLabDom | null = null;
    private initialized = false;
    private benchmarkDirty = false;
    private lastRunContext: PortfolioRunContext | null = null;

    private getDom(): PortfolioLabDom {
        return this.dom ??= createPortfolioLabDom();
    }

    public init(): void {
        if (this.initialized) {
            return;
        }

        const dom = this.getDom();
        this.bindEvents(dom);
        this.syncReadouts(dom);
        this.seedInitialUniverse(dom);
        this.setDerivedActionsEnabled(false);
        this.initialized = true;
    }

    private bindEvents(dom: PortfolioLabDom): void {
        dom.portfolioUseCurrentBtn.addEventListener("click", () => {
            dom.portfolioSymbolList.value = this.buildCurrentUniverse(dom.portfolioBenchmarkSymbol.value).join("\n");
            this.invalidateRunContext(`Universe reset to ${state.currentSymbol}. Run Portfolio Lab again.`);
        });

        dom.portfolioFillMajorsBtn.addEventListener("click", () => {
            dom.portfolioSymbolList.value = this.buildMajorUniverse().join("\n");
            this.invalidateRunContext("Universe filled with the current symbol plus major pairs. Run Portfolio Lab again.");
        });

        dom.portfolioRunBtn.addEventListener("click", () => { void this.run(); });
        dom.portfolioRunBreadthBacktestBtn.addEventListener("click", () => { void this.runBreadthBacktest(); });
        dom.portfolioRunFilterBacktestBtn.addEventListener("click", () => { void this.runFilterBacktest(); });
        dom.portfolioRunBreadthSweepBtn.addEventListener("click", () => { void this.runBreadthSweep(); });
        dom.portfolioRunOppositionSweepBtn.addEventListener("click", () => { void this.runOppositionSweep(); });

        dom.portfolioBenchmarkSymbol.addEventListener("input", () => {
            this.benchmarkDirty = dom.portfolioBenchmarkSymbol.value.trim().length > 0;
            this.invalidateRunContext("Benchmark changed. Run Portfolio Lab again.");
        });
        dom.portfolioAnchorSymbol.addEventListener("input", () => {
            this.invalidateRunContext("ETH anchor changed. Run Portfolio Lab again.");
        });
        dom.portfolioSymbolList.addEventListener("input", () => {
            this.invalidateRunContext("Universe changed. Run Portfolio Lab again.");
        });
        dom.portfolioLookbackBars.addEventListener("input", () => {
            this.invalidateRunContext("Lookback changed. Run Portfolio Lab again.");
        });
        dom.portfolioWindowMode.addEventListener("change", () => {
            this.invalidateRunContext("Window mode changed. Run Portfolio Lab again.");
        });
        dom.portfolioConsensusLagBars.addEventListener("input", () => {
            this.invalidateRunContext("Consensus lag changed. Run Portfolio Lab again.");
        });
        dom.portfolioConsensusMinSamples.addEventListener("input", () => {
            this.invalidateRunContext("Minimum sample threshold changed. Run Portfolio Lab again.");
        });

        state.subscribe("currentSymbol", () => {
            this.syncReadouts(dom);
            if (!this.benchmarkDirty || !dom.portfolioBenchmarkSymbol.value.trim()) {
                dom.portfolioBenchmarkSymbol.value = state.currentSymbol;
            }
            this.invalidateRunContext("Target symbol changed. Run Portfolio Lab again.");
        });
        state.subscribe("currentInterval", () => {
            this.syncReadouts(dom);
            this.invalidateRunContext("Timeframe changed. Run Portfolio Lab again.");
        });
        state.subscribe("currentStrategyKey", () => {
            this.syncReadouts(dom);
            this.invalidateRunContext("Strategy changed. Run Portfolio Lab again.");
        });
    }

    private syncReadouts(dom: PortfolioLabDom): void {
        dom.portfolioIntervalBadge.textContent = state.currentInterval;
        const strategy = strategyRegistry.get(state.currentStrategyKey);
        dom.portfolioStrategyBadge.textContent = strategy?.name ?? state.currentStrategyKey;
        if (!dom.portfolioBenchmarkSymbol.value.trim()) {
            dom.portfolioBenchmarkSymbol.value = state.currentSymbol;
        }
        if (!dom.portfolioAnchorSymbol.value.trim()) {
            dom.portfolioAnchorSymbol.value = DEFAULT_FORECAST_ANCHOR;
        }
    }

    private seedInitialUniverse(dom: PortfolioLabDom): void {
        if (!dom.portfolioSymbolList.value.trim()) {
            dom.portfolioSymbolList.value = this.buildMajorUniverse().join("\n");
        }
    }

    private buildMajorUniverse(): string[] {
        return Array.from(new Set<string>([state.currentSymbol, ...MAJOR_SYMBOLS])).slice(0, 6);
    }

    private buildCurrentUniverse(benchmarkInput: string): string[] {
        return buildRunnablePortfolioUniverse(state.currentSymbol, this.normalizeSymbol(benchmarkInput));
    }

    private async run(): Promise<void> {
        const dom = this.getDom();
        const strategy = strategyRegistry.get(state.currentStrategyKey);
        if (!strategy) {
            uiManager.showToast("Select a strategy first.", "error");
            return;
        }

        const symbols = this.parseSymbols(dom.portfolioSymbolList.value);
        if (symbols.length < 2) {
            uiManager.showToast("Add at least 2 symbols for portfolio analysis.", "error");
            this.updateStatus("Add at least 2 symbols for portfolio analysis.");
            return;
        }
        if (symbols.length > MAX_PORTFOLIO_SYMBOLS) {
            uiManager.showToast(`Portfolio Lab supports up to ${MAX_PORTFOLIO_SYMBOLS} pairs per run.`, "warning");
        }

        const selectedSymbols = symbols.slice(0, MAX_PORTFOLIO_SYMBOLS);
        const benchmarkSymbol = this.normalizeSymbol(dom.portfolioBenchmarkSymbol.value) || state.currentSymbol;
        const anchorSymbol = this.normalizeSymbol(dom.portfolioAnchorSymbol.value) || DEFAULT_FORECAST_ANCHOR;
        const lookbackBars = this.readLookbackBars(dom.portfolioLookbackBars.value);
        const windowMode = this.readWindowMode(dom.portfolioWindowMode.value);
        const lagBars = this.readClampedInt(dom.portfolioConsensusLagBars.value, 1, 0, 5);
        const minSamples = this.readClampedInt(dom.portfolioConsensusMinSamples.value, 8, 3, 200);
        const minAgree = this.readClampedInt(dom.portfolioBreadthMinAgree.value, 4, 0, Math.max(0, selectedSymbols.length));
        const maxOppose = this.readClampedInt(dom.portfolioMaxOppose.value, 1, 0, Math.max(0, selectedSymbols.length));
        const params = paramManager.getValues(strategy);
        const settings = backtestService.getBacktestSettings();
        const capitalSettings = backtestService.getCapitalSettings();

        dom.portfolioRunBtn.disabled = true;
        dom.portfolioRunBtn.setAttribute("aria-busy", "true");
        this.setDerivedActionsEnabled(false);
        this.updateStatus(
            `Running ${strategy.name} on ${selectedSymbols.length} pairs ` +
            `(${state.currentInterval}, ${windowMode === "common_overlap" ? "common overlap" : "latest bars"})...`
        );

        try {
            const dataCache = new Map<string, CachedPairData>();
            const runCache = new Map<string, PairRunArtifacts>();
            const requiredSymbols = Array.from(new Set<string>([...selectedSymbols, benchmarkSymbol]));

            for (const symbol of requiredSymbols) {
                await this.loadPairData(symbol, lookbackBars, dataCache);
            }
            if (anchorSymbol && !requiredSymbols.includes(anchorSymbol)) {
                try {
                    await this.loadPairData(anchorSymbol, lookbackBars, dataCache);
                } catch (error) {
                    console.warn(`[PortfolioLab] Forecast anchor ${anchorSymbol} unavailable:`, error);
                    uiManager.showToast(`Forecast anchor ${anchorSymbol} could not be loaded. Relative-strength forecast features will be reduced.`, "warning");
                }
            }
            this.applyWindowMode(
                dataCache,
                anchorSymbol && dataCache.has(anchorSymbol)
                    ? Array.from(new Set<string>([...requiredSymbols, anchorSymbol]))
                    : requiredSymbols,
                windowMode
            );

            const benchmarkData = dataCache.get(benchmarkSymbol)!;
            const benchmarkRun = benchmarkData.data.length >= MIN_LOOKBACK_BARS
                ? await this.runPair(strategy, params, benchmarkSymbol, benchmarkData.data, runCache, settings, capitalSettings)
                : null;

            const rows: PairAnalysisRow[] = [];
            const skipped: string[] = [];

            for (let index = 0; index < selectedSymbols.length; index += 1) {
                const symbol = selectedSymbols[index];
                this.updateStatus(`Running ${strategy.name} on ${symbol} (${index + 1}/${selectedSymbols.length})...`);

                try {
                    const pairData = await this.loadPairData(symbol, lookbackBars, dataCache);
                    if (pairData.data.length < MIN_LOOKBACK_BARS) {
                        skipped.push(`${symbol} (only ${pairData.data.length} bars)`);
                        continue;
                    }

                    const runResult = await this.runPair(strategy, params, symbol, pairData.data, runCache, settings, capitalSettings);
                    rows.push({
                        symbol,
                        displayName: symbol.endsWith("USDT") ? `${symbol.slice(0, -4)}/USDT` : symbol,
                        bars: pairData.data.length,
                        source: pairData.source,
                        result: runResult.result,
                        engineUsed: runResult.engineUsed,
                        marketCorrelation: benchmarkData.data.length >= MIN_LOOKBACK_BARS ? computeCloseReturnCorrelation(pairData.data, benchmarkData.data) : null,
                        strategyCorrelation: benchmarkRun ? computeEquityReturnCorrelation(runResult.result, benchmarkRun.result) : null,
                    });
                } catch (error) {
                    skipped.push(`${symbol} (${error instanceof Error ? error.message : String(error)})`);
                }
            }

            rows.sort((a, b) => b.result.netProfitPercent - a.result.netProfitPercent);
            const runContext: PortfolioRunContext = {
                strategy,
                params,
                settings,
                capitalSettings,
                interval: state.currentInterval,
                selectedSymbols,
                benchmarkSymbol,
                lagBars,
                windowMode,
                dataCache,
                runCache,
            };

            const consensus = buildConsensusAnalysis(rows, runCache, lagBars, minSamples);
            const breadthSweep = await buildBreadthSweepRows(runContext, { runPair: (...args) => this.runPair(...args) });
            const oppositionSweep = await buildOppositionSweepRows(runContext, minAgree, maxOppose, { runPair: (...args) => this.runPair(...args) });
            const rankingRows = buildRankingRows(rows, consensus, benchmarkSymbol);
            const sizingRows = buildSizingScenarios(runContext, rows, minAgree, maxOppose);
            const forecast = buildOpenTradeForecast(runContext, rows, anchorSymbol);
            const liveContext = buildLiveContextSnapshot(runContext, consensus);

            this.lastRunContext = runContext;
            this.setDerivedActionsEnabled(true);
            this.render(rows, selectedSymbols, dataCache, benchmarkSymbol, skipped, consensus, windowMode, breadthSweep, oppositionSweep, rankingRows, sizingRows, liveContext, forecast, minAgree, maxOppose);
        } catch (error) {
            console.error("[PortfolioLab] Run failed:", error);
            uiManager.showToast(`Portfolio Lab failed: ${error instanceof Error ? error.message : String(error)}`, "error");
            this.updateStatus("Portfolio Lab failed. Check console for details.");
            this.lastRunContext = null;
            this.setDerivedActionsEnabled(false);
        } finally {
            dom.portfolioRunBtn.disabled = false;
            dom.portfolioRunBtn.setAttribute("aria-busy", "false");
        }
    }

    private async runBreadthBacktest(): Promise<void> {
        const context = this.lastRunContext;
        if (!context) {
            uiManager.showToast("Run Portfolio Lab first.", "error");
            return;
        }

        const dom = this.getDom();
        const minAgree = this.readClampedInt(dom.portfolioBreadthMinAgree.value, Math.min(4, Math.max(0, context.selectedSymbols.length - 1)), 0, Math.max(0, context.selectedSymbols.length));
        dom.portfolioRunBreadthBacktestBtn.disabled = true;
        dom.portfolioRunBreadthBacktestBtn.setAttribute("aria-busy", "true");
        this.updateStatus(`Running breadth-filtered backtest on ${context.benchmarkSymbol} with min agree ${minAgree}...`);

        try {
            await this.runExecutionBacktest(context, { minAgree, maxOppose: null }, `breadth >= ${minAgree}`);
        } catch (error) {
            console.error("[PortfolioLab] Breadth backtest failed:", error);
            uiManager.showToast(`Breadth backtest failed: ${error instanceof Error ? error.message : String(error)}`, "error");
            this.updateStatus("Breadth backtest failed. Check console for details.");
        } finally {
            dom.portfolioRunBreadthBacktestBtn.disabled = false;
            dom.portfolioRunBreadthBacktestBtn.setAttribute("aria-busy", "false");
        }
    }

    private async runFilterBacktest(): Promise<void> {
        const context = this.lastRunContext;
        if (!context) {
            uiManager.showToast("Run Portfolio Lab first.", "error");
            return;
        }

        const dom = this.getDom();
        const minAgree = this.readClampedInt(dom.portfolioBreadthMinAgree.value, Math.min(4, Math.max(0, context.selectedSymbols.length - 1)), 0, Math.max(0, context.selectedSymbols.length));
        const maxOppose = this.readClampedInt(dom.portfolioMaxOppose.value, 1, 0, Math.max(0, context.selectedSymbols.length));
        dom.portfolioRunFilterBacktestBtn.disabled = true;
        dom.portfolioRunFilterBacktestBtn.setAttribute("aria-busy", "true");
        this.updateStatus(`Running filtered backtest on ${context.benchmarkSymbol} with agree >= ${minAgree} and oppose <= ${maxOppose}...`);

        try {
            await this.runExecutionBacktest(context, { minAgree, maxOppose }, `agree >= ${minAgree}, oppose <= ${maxOppose}`);
        } catch (error) {
            console.error("[PortfolioLab] Filter backtest failed:", error);
            uiManager.showToast(`Filter backtest failed: ${error instanceof Error ? error.message : String(error)}`, "error");
            this.updateStatus("Filter backtest failed. Check console for details.");
        } finally {
            dom.portfolioRunFilterBacktestBtn.disabled = false;
            dom.portfolioRunFilterBacktestBtn.setAttribute("aria-busy", "false");
        }
    }

    private async runBreadthSweep(): Promise<void> {
        const context = this.lastRunContext;
        if (!context) {
            uiManager.showToast("Run Portfolio Lab first.", "error");
            return;
        }

        const dom = this.getDom();
        dom.portfolioRunBreadthSweepBtn.disabled = true;
        dom.portfolioRunBreadthSweepBtn.setAttribute("aria-busy", "true");
        this.updateStatus(`Sweeping breadth thresholds for ${context.benchmarkSymbol}...`);

        try {
            const rows = await buildBreadthSweepRows(context, { runPair: (...args) => this.runPair(...args) });
            const nextMinAgree = this.readClampedInt(dom.portfolioBreadthMinAgree.value, 4, 0, Math.max(0, context.selectedSymbols.length));
            const nextMaxOppose = this.readClampedInt(dom.portfolioMaxOppose.value, 1, 0, Math.max(0, context.selectedSymbols.length));
            const oppositionRows = await buildOppositionSweepRows(context, nextMinAgree, nextMaxOppose, { runPair: (...args) => this.runPair(...args) });

            renderBreadthSweep(dom, rows);
            dom.portfolioExecutionSummary.innerHTML = renderExecutionSummary(
                rows,
                oppositionRows,
                findBestFilterRun(rows, oppositionRows, nextMinAgree, nextMaxOppose),
                context.benchmarkSymbol,
                nextMinAgree,
                nextMaxOppose
            );

            if (rows.length === 0) {
                uiManager.showToast(`No breadth thresholds produced usable signals for ${context.benchmarkSymbol}.`, "warning");
                this.updateStatus(`Breadth sweep found no usable thresholds for ${context.benchmarkSymbol}.`);
                return;
            }

            const bestExp = findSweepWinner(rows, (row) => row.result.expectancy, (row) => `>= ${row.minAgree} agree`);
            const bestNet = findSweepWinner(rows, (row) => row.result.netProfitPercent, (row) => `>= ${row.minAgree} agree`);
            const bestDd = findSweepWinner(rows, (row) => -Math.abs(row.result.maxDrawdownPercent), (row) => `>= ${row.minAgree} agree`);
            uiManager.showToast(`Breadth sweep complete for ${context.benchmarkSymbol}.`, "success");
            this.updateStatus(
                `Breadth sweep ready for ${context.benchmarkSymbol}. ` +
                `Best exp ${bestExp?.label ?? "-"} ${bestExp ? formatCurrency(bestExp.result.expectancy) : "-"}. ` +
                `Best net ${bestNet?.label ?? "-"} ${bestNet ? formatPercent(bestNet.result.netProfitPercent) : "-"}. ` +
                `Best DD ${bestDd?.label ?? "-"} ${bestDd ? formatDrawdownPercent(bestDd.result.maxDrawdownPercent) : "-"}.`
            );
        } catch (error) {
            console.error("[PortfolioLab] Breadth sweep failed:", error);
            uiManager.showToast(`Breadth sweep failed: ${error instanceof Error ? error.message : String(error)}`, "error");
            this.updateStatus("Breadth sweep failed. Check console for details.");
        } finally {
            dom.portfolioRunBreadthSweepBtn.disabled = false;
            dom.portfolioRunBreadthSweepBtn.setAttribute("aria-busy", "false");
        }
    }

    private async runOppositionSweep(): Promise<void> {
        const context = this.lastRunContext;
        if (!context) {
            uiManager.showToast("Run Portfolio Lab first.", "error");
            return;
        }

        const dom = this.getDom();
        const minAgree = this.readClampedInt(dom.portfolioBreadthMinAgree.value, Math.min(4, Math.max(0, context.selectedSymbols.length - 1)), 0, Math.max(0, context.selectedSymbols.length));
        const maxOppose = this.readClampedInt(dom.portfolioMaxOppose.value, 1, 0, Math.max(0, context.selectedSymbols.length));
        dom.portfolioRunOppositionSweepBtn.disabled = true;
        dom.portfolioRunOppositionSweepBtn.setAttribute("aria-busy", "true");
        this.updateStatus(`Sweeping opposition thresholds for ${context.benchmarkSymbol} at min agree ${minAgree}...`);

        try {
            const rows = await buildOppositionSweepRows(context, minAgree, maxOppose, { runPair: (...args) => this.runPair(...args) });
            renderOppositionSweep(dom, rows);
            const breadthRows = await buildBreadthSweepRows(context, { runPair: (...args) => this.runPair(...args) });
            dom.portfolioExecutionSummary.innerHTML = renderExecutionSummary(
                breadthRows,
                rows,
                findBestFilterRun(breadthRows, rows, minAgree, maxOppose),
                context.benchmarkSymbol,
                minAgree,
                maxOppose
            );

            if (rows.length === 0) {
                uiManager.showToast(`No opposition thresholds produced usable signals for ${context.benchmarkSymbol}.`, "warning");
                this.updateStatus(`Opposition sweep found no usable thresholds for ${context.benchmarkSymbol}.`);
                return;
            }

            const bestExp = findSweepWinner(rows, (row) => row.result.expectancy, (row) => `<= ${row.maxOppose} oppose`);
            const bestNet = findSweepWinner(rows, (row) => row.result.netProfitPercent, (row) => `<= ${row.maxOppose} oppose`);
            const bestDd = findSweepWinner(rows, (row) => -Math.abs(row.result.maxDrawdownPercent), (row) => `<= ${row.maxOppose} oppose`);
            uiManager.showToast(`Opposition sweep complete for ${context.benchmarkSymbol}.`, "success");
            this.updateStatus(
                `Opposition sweep ready for ${context.benchmarkSymbol}. ` +
                `Best exp ${bestExp?.label ?? "-"} ${bestExp ? formatCurrency(bestExp.result.expectancy) : "-"}. ` +
                `Best net ${bestNet?.label ?? "-"} ${bestNet ? formatPercent(bestNet.result.netProfitPercent) : "-"}. ` +
                `Best DD ${bestDd?.label ?? "-"} ${bestDd ? formatDrawdownPercent(bestDd.result.maxDrawdownPercent) : "-"}.`
            );
        } catch (error) {
            console.error("[PortfolioLab] Opposition sweep failed:", error);
            uiManager.showToast(`Opposition sweep failed: ${error instanceof Error ? error.message : String(error)}`, "error");
            this.updateStatus("Opposition sweep failed. Check console for details.");
        } finally {
            dom.portfolioRunOppositionSweepBtn.disabled = false;
            dom.portfolioRunOppositionSweepBtn.setAttribute("aria-busy", "false");
        }
    }

    private async runExecutionBacktest(
        context: PortfolioRunContext,
        filter: { minAgree: number; maxOppose: number | null },
        label: string
    ): Promise<void> {
        const filterRun = await buildFilterRun(context, filter, { runPair: (...args) => this.runPair(...args) });
        if (!filterRun) {
            uiManager.showToast(`No ${context.benchmarkSymbol} signals met ${label}.`, "warning");
            this.updateStatus(`Execution filter removed all ${context.benchmarkSymbol} signals at ${label}.`);
            return;
        }

        state.set("currentBacktestResultSource", "backtest");
        state.set("currentBacktestResult", filterRun.result);
        strategyPanelController.switchTab("results");
        uiManager.showToast(`Execution backtest complete: ${context.benchmarkSymbol} with ${label} (${filterRun.signals} signals).`, "success");
        this.updateStatus(
            `Execution backtest ready for ${context.benchmarkSymbol}: ${filterRun.result.totalTrades} trades, ` +
            `${filterRun.result.winRate.toFixed(1)}% win rate, ${formatCurrency(filterRun.result.expectancy)} expectancy.`
        );
    }

    private async loadPairData(
        symbol: string,
        lookbackBars: number,
        dataCache: Map<string, CachedPairData>
    ): Promise<CachedPairData> {
        const cached = dataCache.get(symbol);
        if (cached) {
            return cached;
        }

        const result = await dataManager.fetchDataForScanWithMeta(symbol, state.currentInterval, undefined, lookbackBars);
        const prepared: CachedPairData = {
            rawData: result.data,
            data: this.prepareAnalysisData(result.data),
            source: result.source,
        };
        dataCache.set(symbol, prepared);
        return prepared;
    }

    private async runPair(
        strategy: Strategy,
        params: StrategyParams,
        symbol: string,
        data: OHLCVData[],
        runCache: Map<string, PairRunArtifacts>,
        settings: PortfolioRunContext["settings"],
        capitalSettings: PortfolioRunContext["capitalSettings"]
    ): Promise<PairRunArtifacts> {
        const cached = runCache.get(symbol);
        if (cached) {
            return cached;
        }

        const runResult = await backtestService.evaluateStrategyOnData(data, state.currentInterval, strategy, params, settings, capitalSettings);
        const fullSignals = applySignalPolarity(strategy.execute(data, params), settings);
        const timeIndex = getTimeIndex(data);
        const artifacts: PairRunArtifacts = {
            result: runResult.result,
            engineUsed: runResult.engineUsed,
            fullSignals,
            signalPresenceByTime: buildPortfolioSignalPresenceLookup(fullSignals),
            timeKeys: data.map((candle) => timeKey(candle.time)),
            timeIndex,
            tradeRanges: buildTradeRanges(runResult.result.trades, data, timeIndex),
        };
        runCache.set(symbol, artifacts);
        return artifacts;
    }

    private render(
        rows: PairAnalysisRow[],
        selectedSymbols: string[],
        dataCache: Map<string, CachedPairData>,
        benchmarkSymbol: string,
        skipped: string[],
        consensus: ConsensusAnalysis,
        windowMode: PortfolioWindowMode,
        breadthSweep: BreadthSweepRow[],
        oppositionSweep: OppositionSweepRow[],
        rankingRows: PairRankingRow[],
        sizingRows: SizingScenarioRow[],
        liveContext: LiveContextSnapshot,
        forecast: OpenTradeForecast,
        minAgree: number,
        maxOppose: number
    ): void {
        renderPortfolioLab({
            renderSummary,
            renderLiveContextSummary,
            renderLiveContextDetails,
            renderForecastSummary,
            renderForecastDetails,
            renderForecastTable,
            renderInsights,
            renderExecutionSummary,
            renderConsensusSummary,
            renderConsensusTable,
            renderBreadthSweep: (nextRows) => renderBreadthSweep(this.getDom(), nextRows),
            renderOppositionSweep: (nextRows) => renderOppositionSweep(this.getDom(), nextRows),
            renderRankingSummary,
            renderRankingTable,
            renderSizingSummary,
            renderSizingTable,
            renderCorrelationMatrix,
            renderRow,
            bindRowActions: () => this.bindRowActions(),
            findBestFilterRun,
            updateStatus: (message) => this.updateStatus(message),
        }, {
            dom: this.getDom(),
            rows,
            selectedSymbols,
            dataCache,
            benchmarkSymbol,
            skipped,
            consensus,
            windowMode,
            breadthSweep,
            oppositionSweep,
            rankingRows,
            sizingRows,
            liveContext,
            forecast,
            minAgree,
            maxOppose,
            currentInterval: state.currentInterval,
        });
    }

    private bindRowActions(): void {
        const dom = this.getDom();
        const buttons = Array.from(dom.portfolioPairsTableBody.querySelectorAll<HTMLButtonElement>(".portfolio-lab__load-btn"))
            .concat(Array.from(dom.portfolioRankingTableBody.querySelectorAll<HTMLButtonElement>(".portfolio-lab__load-btn")));
        buttons.forEach((button) => {
            button.addEventListener("click", () => {
                const symbol = button.dataset.symbol;
                if (!symbol) {
                    return;
                }
                uiManager.showToast(`Loading ${symbol} on ${state.currentInterval}...`, "info");
                void dataManager.loadData(symbol, state.currentInterval);
            });
        });
    }

    private parseSymbols(raw: string): string[] {
        const unique = new Set<string>();
        raw
            .split(/[\s,;]+/)
            .map((value) => this.normalizeSymbol(value))
            .filter((value): value is string => Boolean(value))
            .forEach((symbol) => unique.add(symbol));
        return Array.from(unique);
    }

    private normalizeSymbol(raw: string): string | null {
        const normalized = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
        return normalized.length > 0 ? normalized : null;
    }

    private readLookbackBars(raw: string): number {
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed)) {
            return DEFAULT_LOOKBACK_BARS;
        }
        return Math.max(MIN_LOOKBACK_BARS, Math.min(MAX_LOOKBACK_BARS, parsed));
    }

    private readClampedInt(raw: string, fallback: number, min: number, max: number): number {
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed)) {
            return fallback;
        }
        return Math.max(min, Math.min(max, parsed));
    }

    private readWindowMode(raw: string): PortfolioWindowMode {
        return raw === "common_overlap" ? "common_overlap" : "latest_bars";
    }

    private prepareAnalysisData(data: OHLCVData[]): OHLCVData[] {
        return sliceOhlcvByBlock(trimToClosedCandles(data, state.currentInterval), state.blockRange);
    }

    private applyWindowMode(
        dataCache: Map<string, CachedPairData>,
        symbols: string[],
        windowMode: PortfolioWindowMode
    ): void {
        if (windowMode !== "common_overlap") {
            return;
        }

        const datasets = symbols
            .map((symbol) => ({ symbol, payload: dataCache.get(symbol) }))
            .filter((entry): entry is { symbol: string; payload: CachedPairData } => Boolean(entry.payload))
            .filter((entry) => entry.payload.data.length > 0);
        if (datasets.length < 2) {
            return;
        }

        const starts = datasets.map((entry) => this.getBoundaryTime(entry.payload.data[0])).filter((value): value is number => value !== null);
        const ends = datasets.map((entry) => this.getBoundaryTime(entry.payload.data[entry.payload.data.length - 1])).filter((value): value is number => value !== null);
        if (starts.length !== datasets.length || ends.length !== datasets.length) {
            return;
        }

        const overlapStart = Math.max(...starts);
        const overlapEnd = Math.min(...ends);
        if (!Number.isFinite(overlapStart) || !Number.isFinite(overlapEnd) || overlapStart >= overlapEnd) {
            return;
        }

        for (const entry of datasets) {
            entry.payload.data = entry.payload.data.filter((candle) => {
                const time = this.getBoundaryTime(candle);
                return time !== null && time >= overlapStart && time <= overlapEnd;
            });
        }
    }

    private getBoundaryTime(candle: OHLCVData | undefined): number | null {
        return candle ? parseTimeToUnixSeconds(candle.time) : null;
    }

    private invalidateRunContext(message: string): void {
        if (!this.lastRunContext) {
            return;
        }
        this.lastRunContext = null;
        this.setDerivedActionsEnabled(false);
        this.updateStatus(message);
    }

    private setDerivedActionsEnabled(enabled: boolean): void {
        const dom = this.getDom();
        const disabled = !enabled;
        dom.portfolioRunBreadthBacktestBtn.disabled = disabled;
        dom.portfolioRunFilterBacktestBtn.disabled = disabled;
        dom.portfolioRunBreadthSweepBtn.disabled = disabled;
        dom.portfolioRunOppositionSweepBtn.disabled = disabled;
    }

    private updateStatus(message: string): void {
        this.getDom().portfolioStatus.textContent = message;
    }
}

export const portfolioLabService = new PortfolioLabService();
