import { strategyRegistry } from "../strategyRegistry";
import { backtestService } from "./backtest-service";
import { sliceOhlcvByBlock } from "./block-selector";
import { trimToClosedCandles } from "./closed-candle-utils";
import { dataManager } from "./data-manager";
import { createPortfolioLabDom, type PortfolioLabDom } from "./feature-dom-contracts";
import { paramManager } from "./param-manager";
import { state } from "./state";
import { applySignalPolarity, timeKey, type BacktestResult, type OHLCVData, type Signal, type Strategy, type StrategyParams, type Trade } from "./strategies";
import { strategyPanelController } from "./strategy-panel-controller";
import { parseTimeToUnixSeconds } from "./time-normalization";
import { uiManager } from "./ui-manager";

const MIN_LOOKBACK_BARS = 200;
const MAX_LOOKBACK_BARS = 20000;
const MAX_PORTFOLIO_SYMBOLS = 12;
const DEFAULT_LOOKBACK_BARS = 1500;
const MAJOR_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"];

type DataSource = "mock" | "local" | "network";
type PortfolioWindowMode = "latest_bars" | "common_overlap";

interface CachedPairData {
    rawData: OHLCVData[];
    data: OHLCVData[];
    source: DataSource;
}

interface PairRunArtifacts {
    result: BacktestResult;
    engineUsed: "rust" | "typescript";
    fullSignals: ReturnType<typeof applySignalPolarity>;
    signalByTime: Map<string, Signal["type"]>;
    timeKeys: string[];
    timeIndex: Map<string, number>;
}

interface PairAnalysisRow {
    symbol: string;
    displayName: string;
    bars: number;
    source: DataSource;
    result: BacktestResult;
    engineUsed: "rust" | "typescript";
    marketCorrelation: number | null;
    strategyCorrelation: number | null;
}

interface ConsensusTradeSample {
    symbol: string;
    direction: Trade["type"];
    isWin: boolean;
    pnl: number;
    pnlPercent: number;
    sameCount: number;
    oppositeCount: number;
}

interface ConsensusBucketSummary {
    label: string;
    sortValue: number;
    samples: number;
    winRate: number;
    lossRate: number;
    avgExpectancy: number;
    avgNetPct: number;
    avgOppose: number;
    longWinRate: number | null;
    shortWinRate: number | null;
    longSamples: number;
    shortSamples: number;
}

interface ConsensusAnalysis {
    qualifyingBuckets: ConsensusBucketSummary[];
    allSamples: ConsensusTradeSample[];
    qualifyingSampleCount: number;
    lagBars: number;
    minSamples: number;
    bestBucket: ConsensusBucketSummary | null;
    bestLongBucket: ConsensusBucketSummary | null;
    bestShortBucket: ConsensusBucketSummary | null;
    baselineBucket: ConsensusBucketSummary | null;
}

interface PortfolioRunContext {
    strategy: Strategy;
    params: StrategyParams;
    settings: ReturnType<typeof backtestService.getBacktestSettings>;
    capitalSettings: ReturnType<typeof backtestService.getCapitalSettings>;
    interval: string;
    selectedSymbols: string[];
    benchmarkSymbol: string;
    lagBars: number;
    windowMode: PortfolioWindowMode;
    dataCache: Map<string, CachedPairData>;
    runCache: Map<string, PairRunArtifacts>;
}

interface BreadthSweepRow {
    minAgree: number;
    signals: number;
    result: BacktestResult;
    engineUsed: "rust" | "typescript";
}

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
        this.initialized = true;
    }

    private bindEvents(dom: PortfolioLabDom): void {
        dom.portfolioUseCurrentBtn.addEventListener("click", () => {
            dom.portfolioSymbolList.value = state.currentSymbol;
            this.updateStatus(`Universe reset to ${state.currentSymbol}.`);
        });

        dom.portfolioFillMajorsBtn.addEventListener("click", () => {
            dom.portfolioSymbolList.value = this.buildMajorUniverse().join("\n");
            this.updateStatus("Universe filled with the current symbol plus major pairs.");
        });

        dom.portfolioRunBtn.addEventListener("click", () => {
            void this.run();
        });
        dom.portfolioRunBreadthBacktestBtn.addEventListener("click", () => {
            void this.runBreadthBacktest();
        });
        dom.portfolioRunBreadthSweepBtn.addEventListener("click", () => {
            void this.runBreadthSweep();
        });

        dom.portfolioBenchmarkSymbol.addEventListener("input", () => {
            this.benchmarkDirty = dom.portfolioBenchmarkSymbol.value.trim().length > 0;
        });

        state.subscribe("currentSymbol", () => {
            this.syncReadouts(dom);
            if (!this.benchmarkDirty || !dom.portfolioBenchmarkSymbol.value.trim()) {
                dom.portfolioBenchmarkSymbol.value = state.currentSymbol;
            }
        });

        state.subscribe("currentInterval", () => {
            this.syncReadouts(dom);
        });

        state.subscribe("currentStrategyKey", () => {
            this.syncReadouts(dom);
        });
    }

    private syncReadouts(dom: PortfolioLabDom): void {
        dom.portfolioIntervalBadge.textContent = state.currentInterval;
        const strategy = strategyRegistry.get(state.currentStrategyKey);
        dom.portfolioStrategyBadge.textContent = strategy?.name ?? state.currentStrategyKey;
        if (!dom.portfolioBenchmarkSymbol.value.trim()) {
            dom.portfolioBenchmarkSymbol.value = state.currentSymbol;
        }
    }

    private seedInitialUniverse(dom: PortfolioLabDom): void {
        if (dom.portfolioSymbolList.value.trim()) {
            return;
        }
        dom.portfolioSymbolList.value = this.buildMajorUniverse().join("\n");
    }

    private buildMajorUniverse(): string[] {
        const unique = new Set<string>([state.currentSymbol, ...MAJOR_SYMBOLS]);
        return Array.from(unique).slice(0, 6);
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
        const lookbackBars = this.readLookbackBars(dom.portfolioLookbackBars.value);
        const windowMode = this.readWindowMode(dom.portfolioWindowMode.value);
        const lagBars = this.readClampedInt(dom.portfolioConsensusLagBars.value, 1, 0, 5);
        const minSamples = this.readClampedInt(dom.portfolioConsensusMinSamples.value, 8, 3, 200);
        const params = paramManager.getValues(strategy);
        const settings = backtestService.getBacktestSettings();
        const capitalSettings = backtestService.getCapitalSettings();

        dom.portfolioRunBtn.disabled = true;
        dom.portfolioRunBtn.setAttribute("aria-busy", "true");
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
            this.applyWindowMode(dataCache, requiredSymbols, windowMode);

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

                    const runResult = await this.runPair(
                        strategy,
                        params,
                        symbol,
                        pairData.data,
                        runCache,
                        settings,
                        capitalSettings
                    );

                    rows.push({
                        symbol,
                        displayName: this.toDisplaySymbol(symbol),
                        bars: pairData.data.length,
                        source: pairData.source,
                        result: runResult.result,
                        engineUsed: runResult.engineUsed,
                        marketCorrelation: benchmarkData.data.length >= MIN_LOOKBACK_BARS
                            ? this.computeCloseReturnCorrelation(pairData.data, benchmarkData.data)
                            : null,
                        strategyCorrelation: benchmarkRun
                            ? this.computeEquityReturnCorrelation(runResult.result, benchmarkRun.result)
                            : null,
                    });
                } catch (error) {
                    skipped.push(`${symbol} (${error instanceof Error ? error.message : String(error)})`);
                }
            }

            rows.sort((a, b) => b.result.netProfitPercent - a.result.netProfitPercent);
            const consensus = this.buildConsensusAnalysis(rows, runCache, lagBars, minSamples);
            this.lastRunContext = {
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
            this.render(rows, selectedSymbols, dataCache, benchmarkSymbol, skipped, consensus, windowMode);
        } catch (error) {
            console.error("[PortfolioLab] Run failed:", error);
            uiManager.showToast(`Portfolio Lab failed: ${error instanceof Error ? error.message : String(error)}`, "error");
            this.updateStatus("Portfolio Lab failed. Check console for details.");
            this.lastRunContext = null;
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
        const minAgree = this.readClampedInt(
            dom.portfolioBreadthMinAgree.value,
            Math.min(4, Math.max(0, context.selectedSymbols.length - 1)),
            0,
            Math.max(0, context.selectedSymbols.length)
        );
        const targetSymbol = context.benchmarkSymbol;
        dom.portfolioRunBreadthBacktestBtn.disabled = true;
        dom.portfolioRunBreadthBacktestBtn.setAttribute("aria-busy", "true");
        this.updateStatus(`Running breadth-filtered backtest on ${targetSymbol} with min agree ${minAgree}...`);

        try {
            const breadthRun = await this.buildBreadthRun(context, minAgree);
            if (!breadthRun) {
                uiManager.showToast(`No ${targetSymbol} signals met breadth >= ${minAgree}.`, "warning");
                this.updateStatus(`Breadth filter removed all ${targetSymbol} signals at min agree ${minAgree}.`);
                return;
            }

            state.set('currentBacktestResultSource', 'backtest');
            state.set('currentBacktestResult', breadthRun.result);
            strategyPanelController.switchTab('results');
            uiManager.showToast(
                `Breadth backtest complete: ${targetSymbol} with breadth >= ${minAgree} (${breadthRun.signals} signals).`,
                'success'
            );
            this.updateStatus(
                `Breadth backtest ready for ${targetSymbol}: ${breadthRun.result.totalTrades} trades, ` +
                `${breadthRun.result.winRate.toFixed(1)}% win rate, ${this.formatCurrency(breadthRun.result.expectancy)} expectancy.`
            );
        } catch (error) {
            console.error("[PortfolioLab] Breadth backtest failed:", error);
            uiManager.showToast(`Breadth backtest failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
            this.updateStatus("Breadth backtest failed. Check console for details.");
        } finally {
            dom.portfolioRunBreadthBacktestBtn.disabled = false;
            dom.portfolioRunBreadthBacktestBtn.setAttribute("aria-busy", "false");
        }
    }

    private async runBreadthSweep(): Promise<void> {
        const context = this.lastRunContext;
        if (!context) {
            uiManager.showToast("Run Portfolio Lab first.", "error");
            return;
        }

        const dom = this.getDom();
        const targetSymbol = context.benchmarkSymbol;
        const maxAgree = Math.max(0, context.selectedSymbols.length - (context.selectedSymbols.includes(targetSymbol) ? 1 : 0));
        dom.portfolioRunBreadthSweepBtn.disabled = true;
        dom.portfolioRunBreadthSweepBtn.setAttribute("aria-busy", "true");
        this.updateStatus(`Sweeping breadth thresholds for ${targetSymbol}...`);

        try {
            const rows: BreadthSweepRow[] = [];
            for (let minAgree = 0; minAgree <= maxAgree; minAgree += 1) {
                this.updateStatus(`Sweeping breadth thresholds for ${targetSymbol} (${minAgree}/${maxAgree})...`);
                const breadthRun = await this.buildBreadthRun(context, minAgree);
                if (breadthRun) {
                    rows.push({
                        minAgree,
                        signals: breadthRun.signals,
                        result: breadthRun.result,
                        engineUsed: breadthRun.engineUsed,
                    });
                }
            }

            this.renderBreadthSweep(rows);
            if (rows.length === 0) {
                uiManager.showToast(`No breadth thresholds produced usable signals for ${targetSymbol}.`, "warning");
                this.updateStatus(`Breadth sweep found no usable thresholds for ${targetSymbol}.`);
                return;
            }

            const best = rows
                .slice()
                .sort((a, b) => {
                    if (b.result.expectancy !== a.result.expectancy) {
                        return b.result.expectancy - a.result.expectancy;
                    }
                    return b.result.netProfitPercent - a.result.netProfitPercent;
                })[0];

            uiManager.showToast(`Breadth sweep complete for ${targetSymbol}. Best expectancy at min agree ${best.minAgree}.`, "success");
            this.updateStatus(
                `Breadth sweep ready for ${targetSymbol}. Best threshold: ${best.minAgree} agree, ` +
                `${best.result.winRate.toFixed(1)}% win rate, ${this.formatCurrency(best.result.expectancy)} expectancy.`
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
        settings: ReturnType<typeof backtestService.getBacktestSettings>,
        capitalSettings: ReturnType<typeof backtestService.getCapitalSettings>
    ): Promise<PairRunArtifacts> {
        const cached = runCache.get(symbol);
        if (cached) {
            return cached;
        }

        const runResult = await backtestService.evaluateStrategyOnData(
            data,
            state.currentInterval,
            strategy,
            params,
            settings,
            capitalSettings
        );
        const fullSignals = applySignalPolarity(strategy.execute(data, params), settings);
        const signalByTime = this.buildSignalLookup(fullSignals);
        const timeKeys = data.map((candle) => timeKey(candle.time));
        const timeIndex = new Map<string, number>();
        timeKeys.forEach((key, index) => {
            timeIndex.set(key, index);
        });

        const artifacts: PairRunArtifacts = {
            result: runResult.result,
            engineUsed: runResult.engineUsed,
            fullSignals,
            signalByTime,
            timeKeys,
            timeIndex,
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
        windowMode: PortfolioWindowMode
    ): void {
        const dom = this.getDom();
        dom.portfolioContent.style.display = "";
        dom.portfolioEmpty.style.display = rows.length > 0 ? "none" : "";
        dom.portfolioResults.style.display = rows.length > 0 ? "" : "none";
        dom.portfolioInsightSection.style.display = rows.length > 0 ? "" : "none";
        dom.portfolioConsensusSection.style.display = rows.length > 0 ? "" : "none";
        dom.portfolioMatrixSection.style.display = rows.length > 1 ? "" : "none";

        if (rows.length === 0) {
            dom.portfolioSummary.innerHTML = "";
            dom.portfolioInsights.innerHTML = "";
            dom.portfolioConsensusSummary.innerHTML = "";
            dom.portfolioConsensusTableBody.innerHTML = `
                <tr>
                    <td colspan="9" style="text-align:center;color:var(--text-secondary);padding:16px;">
                        No usable pair runs. Check the symbol list and data availability.
                    </td>
                </tr>
            `;
            dom.portfolioBreadthSweepSection.style.display = "none";
            dom.portfolioBreadthSweepTableBody.innerHTML = `
                <tr>
                    <td colspan="8" style="text-align:center;color:var(--text-secondary);padding:16px;">
                        Run Breadth Sweep to compare agreement thresholds.
                    </td>
                </tr>
            `;
            dom.portfolioCorrelationMatrix.innerHTML = "";
            dom.portfolioPairsTableBody.innerHTML = `
                <tr>
                    <td colspan="10" style="text-align:center;color:var(--text-secondary);padding:20px;">
                        No usable pair runs. Check the symbol list and data availability.
                    </td>
                </tr>
            `;
            if (skipped.length > 0) {
                this.updateStatus(`No usable results. Skipped: ${skipped.join(", ")}`);
            } else {
                this.updateStatus("No usable results.");
            }
            return;
        }

        dom.portfolioSummary.innerHTML = this.renderSummary(rows, benchmarkSymbol);
        dom.portfolioInsights.innerHTML = this.renderInsights(rows, benchmarkSymbol, skipped, consensus, windowMode);
        dom.portfolioConsensusSummary.innerHTML = this.renderConsensusSummary(consensus);
        dom.portfolioConsensusTableBody.innerHTML = this.renderConsensusTable(consensus);
        dom.portfolioCorrelationMatrix.innerHTML = this.renderCorrelationMatrix(rows, selectedSymbols, dataCache);
        dom.portfolioPairsTableBody.innerHTML = rows.map((row) => this.renderRow(row, benchmarkSymbol)).join("");
        this.bindRowActions();

        const profitablePairs = rows.filter((row) => row.result.netProfitPercent > 0).length;
        const skippedSuffix = skipped.length > 0 ? ` Skipped ${skipped.length}.` : "";
        this.updateStatus(
            `${rows.length} pairs completed on ${state.currentInterval}. ` +
            `${profitablePairs}/${rows.length} profitable vs ${benchmarkSymbol}.${skippedSuffix}`
        );
    }

    private renderSummary(rows: PairAnalysisRow[], benchmarkSymbol: string): string {
        const profitablePairs = rows.filter((row) => row.result.netProfitPercent > 0).length;
        const avgNetPct = this.average(rows.map((row) => row.result.netProfitPercent));
        const avgTradeExpectancy = this.average(rows.map((row) => row.result.expectancy));
        const avgMarketCorr = this.average(rows.map((row) => row.marketCorrelation));
        const avgStrategyCorr = this.average(rows.map((row) => row.strategyCorrelation));
        const best = rows[0];
        const worst = rows[rows.length - 1];

        return [
            this.renderSummaryCard("Pairs", `${rows.length}`, `${profitablePairs} profitable`),
            this.renderSummaryCard("Avg Net", this.formatPercent(avgNetPct), "mean net return across pairs"),
            this.renderSummaryCard("Avg Expectancy", this.formatCurrency(avgTradeExpectancy), "mean trade expectancy"),
            this.renderSummaryCard("Avg Market Corr", this.formatCorrelation(avgMarketCorr), `vs ${benchmarkSymbol}`),
            this.renderSummaryCard("Avg Strategy Corr", this.formatCorrelation(avgStrategyCorr), `equity return corr vs ${benchmarkSymbol}`),
            this.renderSummaryCard("Best / Worst", `${best.displayName} / ${worst.displayName}`, `${this.formatPercent(best.result.netProfitPercent)} / ${this.formatPercent(worst.result.netProfitPercent)}`),
        ].join("");
    }

    private renderSummaryCard(label: string, value: string, delta: string): string {
        return `
            <div class="sim-card">
                <div class="sim-card-label">${label}</div>
                <div class="sim-card-value">${value}</div>
                <div class="sim-card-delta">${delta}</div>
            </div>
        `;
    }

    private renderInsights(
        rows: PairAnalysisRow[],
        benchmarkSymbol: string,
        skipped: string[],
        consensus: ConsensusAnalysis,
        windowMode: PortfolioWindowMode
    ): string {
        const profitablePairs = rows.filter((row) => row.result.netProfitPercent > 0).length;
        const avgMarketCorr = this.average(rows.map((row) => row.marketCorrelation));
        const avgStrategyCorr = this.average(rows.map((row) => row.strategyCorrelation));
        const dispersion = this.standardDeviation(rows.map((row) => row.result.netProfitPercent));
        const lowestCorrPositive = rows
            .filter((row) => row.result.netProfitPercent > 0 && typeof row.marketCorrelation === "number")
            .sort((a, b) => (a.marketCorrelation ?? 0) - (b.marketCorrelation ?? 0))[0];
        const highestStrategyCorr = rows
            .filter((row) => typeof row.strategyCorrelation === "number" && row.symbol !== benchmarkSymbol)
            .sort((a, b) => (b.strategyCorrelation ?? -Infinity) - (a.strategyCorrelation ?? -Infinity))[0];

        const insights: string[] = [];
        if (windowMode === "common_overlap") {
            insights.push("Common Overlap mode is active, so every pair was trimmed to the shared calendar window before backtesting and correlation analysis.");
        } else {
            insights.push("Latest N Bars mode is active, so each pair uses its own latest available history window.");
        }
        insights.push(`${profitablePairs}/${rows.length} pairs finished positive. Performance dispersion is ${dispersion.toFixed(2)} net-% points.`);

        if (avgMarketCorr !== null && avgStrategyCorr !== null) {
            if (avgMarketCorr >= 0.7 && avgStrategyCorr >= 0.7) {
                insights.push(`Both price action and strategy outcomes are tightly clustered versus ${benchmarkSymbol}. This behaves more like one market theme than a diversified basket.`);
            } else if (avgMarketCorr >= 0.7 && avgStrategyCorr < 0.4) {
                insights.push(`Pairs are still moving with ${benchmarkSymbol}, but strategy outcomes are less synchronized. The entry logic is adding selectivity beyond raw market beta.`);
            } else if (avgMarketCorr < 0.4 && avgStrategyCorr >= 0.6) {
                insights.push(`Price correlation is modest while strategy correlation stays high. The setup may be reacting to shared structural conditions across different pairs.`);
            } else {
                insights.push(`Price and strategy correlations are both moderate-to-low. This is the healthier profile if you want less redundant exposure.`);
            }
        }

        if (lowestCorrPositive) {
            insights.push(`${lowestCorrPositive.displayName} stayed profitable with only ${this.formatCorrelation(lowestCorrPositive.marketCorrelation)} market correlation to ${benchmarkSymbol}. That is a good diversification candidate.`);
        }

        if (highestStrategyCorr) {
            insights.push(`${highestStrategyCorr.displayName} has the closest strategy-path behavior to ${benchmarkSymbol} at ${this.formatCorrelation(highestStrategyCorr.strategyCorrelation)}. Treat those two as partially redundant.`);
        }

        if (consensus.bestBucket) {
            insights.push(
                `Best conditional bucket is ${consensus.bestBucket.label} with ${consensus.bestBucket.samples} samples, ` +
                `${consensus.bestBucket.winRate.toFixed(1)}% win rate, and ${this.formatCurrency(consensus.bestBucket.avgExpectancy)} average expectancy.`
            );
        }

        if (consensus.baselineBucket && consensus.bestBucket && consensus.bestBucket.label !== consensus.baselineBucket.label) {
            insights.push(
                `Baseline ${consensus.baselineBucket.label} win rate is ${consensus.baselineBucket.winRate.toFixed(1)}%. ` +
                `Compare that with stronger agreement buckets before treating consensus as a real edge.`
            );
        }

        if (skipped.length > 0) {
            insights.push(`Skipped pairs: ${skipped.join(", ")}.`);
        }

        return insights.map((item) => `<div class="portfolio-lab__insight">${item}</div>`).join("");
    }

    private renderCorrelationMatrix(
        rows: PairAnalysisRow[],
        selectedSymbols: string[],
        dataCache: Map<string, CachedPairData>
    ): string {
        const matrixSymbols = rows
            .map((row) => row.symbol)
            .filter((symbol, index, all) => all.indexOf(symbol) === index)
            .slice(0, Math.min(8, selectedSymbols.length));

        if (matrixSymbols.length < 2) {
            return `<div class="portfolio-lab__matrix-empty">Need at least 2 completed pairs for a matrix.</div>`;
        }

        const header = matrixSymbols.map((symbol) => `<th>${this.toDisplaySymbol(symbol)}</th>`).join("");
        const body = matrixSymbols.map((rowSymbol) => {
            const cells = matrixSymbols.map((colSymbol) => {
                const rowData = dataCache.get(rowSymbol)?.data ?? [];
                const colData = dataCache.get(colSymbol)?.data ?? [];
                const corr = rowSymbol === colSymbol ? 1 : this.computeCloseReturnCorrelation(rowData, colData);
                const style = `background:${this.getCorrelationCellColor(corr)};`;
                return `<td style="${style}">${this.formatCorrelation(corr)}</td>`;
            }).join("");

            return `
                <tr>
                    <th>${this.toDisplaySymbol(rowSymbol)}</th>
                    ${cells}
                </tr>
            `;
        }).join("");

        return `
            <table class="portfolio-lab__matrix-table">
                <thead>
                    <tr>
                        <th>Pair</th>
                        ${header}
                    </tr>
                </thead>
                <tbody>${body}</tbody>
            </table>
        `;
    }

    private renderRow(row: PairAnalysisRow, benchmarkSymbol: string): string {
        const netClass = row.result.netProfitPercent >= 0 ? "positive" : "negative";
        const expectancyClass = row.result.expectancy >= 0 ? "positive" : "negative";
        const benchmarkBadge = row.symbol === benchmarkSymbol ? " portfolio-lab__pair-badge--benchmark" : "";
        const engineHint = row.engineUsed === "rust" ? "Rust" : "TS";

        return `
            <tr>
                <td>
                    <div class="portfolio-lab__pair-cell">
                        <span>${row.displayName}</span>
                        <span class="portfolio-lab__pair-badge${benchmarkBadge}">${engineHint}</span>
                    </div>
                </td>
                <td>${row.result.totalTrades}</td>
                <td class="${netClass}">${this.formatPercent(row.result.netProfitPercent)}</td>
                <td>${row.result.winRate.toFixed(1)}%</td>
                <td>${this.formatProfitFactor(row.result.profitFactor)}</td>
                <td class="negative">${this.formatDrawdownPercent(row.result.maxDrawdownPercent)}</td>
                <td class="${expectancyClass}">${this.formatCurrency(row.result.expectancy)}</td>
                <td>${this.formatCorrelation(row.marketCorrelation)}</td>
                <td>${this.formatCorrelation(row.strategyCorrelation)}</td>
                <td><button class="btn-simulate portfolio-lab__load-btn" data-symbol="${row.symbol}" type="button">Load</button></td>
            </tr>
        `;
    }

    private renderConsensusSummary(consensus: ConsensusAnalysis): string {
        if (consensus.qualifyingBuckets.length === 0) {
            return `
                <div class="sim-card" style="grid-column: 1 / -1;">
                    <div class="sim-card-label">Pair Context Probability</div>
                    <div class="sim-card-value">Not enough samples</div>
                    <div class="sim-card-delta">Raise universe size or lower min samples from ${consensus.minSamples}.</div>
                </div>
            `;
        }

        return [
            this.renderSummaryCard(
                "Qualified Coverage",
                `${consensus.qualifyingSampleCount}/${consensus.allSamples.length}`,
                `lag window ${consensus.lagBars} bar${consensus.lagBars === 1 ? "" : "s"}`
            ),
            this.renderSummaryCard(
                "Best Overall",
                consensus.bestBucket?.label ?? "-",
                consensus.bestBucket
                    ? `${consensus.bestBucket.winRate.toFixed(1)}% win | ${this.formatCurrency(consensus.bestBucket.avgExpectancy)}`
                    : "No qualifying bucket"
            ),
            this.renderSummaryCard(
                "Best Long",
                consensus.bestLongBucket?.label ?? "-",
                consensus.bestLongBucket
                    ? `${this.formatNullableRate(consensus.bestLongBucket.longWinRate)} | ${consensus.bestLongBucket.longSamples} samples`
                    : "No qualifying long bucket"
            ),
            this.renderSummaryCard(
                "Best Short",
                consensus.bestShortBucket?.label ?? "-",
                consensus.bestShortBucket
                    ? `${this.formatNullableRate(consensus.bestShortBucket.shortWinRate)} | ${consensus.bestShortBucket.shortSamples} samples`
                    : "No qualifying short bucket"
            ),
            this.renderSummaryCard(
                "Baseline",
                consensus.baselineBucket?.label ?? "0 agree",
                consensus.baselineBucket
                    ? `${consensus.baselineBucket.winRate.toFixed(1)}% win | ${this.formatCurrency(consensus.baselineBucket.avgExpectancy)}`
                    : "No qualifying baseline bucket"
            ),
        ].join("");
    }

    private renderConsensusTable(consensus: ConsensusAnalysis): string {
        if (consensus.qualifyingBuckets.length === 0) {
            return `
                <tr>
                    <td colspan="9" style="text-align:center;color:var(--text-secondary);padding:16px;">
                        No agreement bucket reached the minimum sample threshold of ${consensus.minSamples}.
                    </td>
                </tr>
            `;
        }

        return consensus.qualifyingBuckets.map((bucket) => `
            <tr>
                <td>${bucket.label}</td>
                <td>${bucket.samples}</td>
                <td>${bucket.winRate.toFixed(1)}%</td>
                <td>${bucket.lossRate.toFixed(1)}%</td>
                <td class="${bucket.avgExpectancy >= 0 ? "positive" : "negative"}">${this.formatCurrency(bucket.avgExpectancy)}</td>
                <td class="${bucket.avgNetPct >= 0 ? "positive" : "negative"}">${this.formatPercent(bucket.avgNetPct)}</td>
                <td>${bucket.avgOppose.toFixed(2)}</td>
                <td>${this.formatNullableRate(bucket.longWinRate)}</td>
                <td>${this.formatNullableRate(bucket.shortWinRate)}</td>
            </tr>
        `).join("");
    }

    private bindRowActions(): void {
        const dom = this.getDom();
        dom.portfolioPairsTableBody.querySelectorAll<HTMLButtonElement>(".portfolio-lab__load-btn").forEach((button) => {
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

        const starts = datasets
            .map((entry) => this.getBoundaryTime(entry.payload.data[0]))
            .filter((value): value is number => value !== null);
        const ends = datasets
            .map((entry) => this.getBoundaryTime(entry.payload.data[entry.payload.data.length - 1]))
            .filter((value): value is number => value !== null);

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
        if (!candle) {
            return null;
        }
        return parseTimeToUnixSeconds(candle.time);
    }

    private buildSignalLookup(signals: ReturnType<typeof applySignalPolarity>): Map<string, Signal["type"]> {
        const lookup = new Map<string, Signal["type"]>();
        for (const signal of signals) {
            lookup.set(timeKey(signal.time), signal.type);
        }
        return lookup;
    }

    private async buildBreadthRun(
        context: PortfolioRunContext,
        minAgree: number
    ): Promise<{ signals: number; result: BacktestResult; engineUsed: "rust" | "typescript" } | null> {
        const targetSymbol = context.benchmarkSymbol;
        const targetData = context.dataCache.get(targetSymbol)?.data;
        if (!targetData || targetData.length < MIN_LOOKBACK_BARS) {
            uiManager.showToast(`No usable data for breadth backtest on ${targetSymbol}.`, "error");
            return null;
        }

        const targetArtifacts = context.runCache.get(targetSymbol)
            ?? await this.runPair(
                context.strategy,
                context.params,
                targetSymbol,
                targetData,
                context.runCache,
                context.settings,
                context.capitalSettings
            );

        const filteredSignals = this.buildBreadthFilteredSignals(
            targetSymbol,
            targetArtifacts,
            context.runCache,
            context.lagBars,
            minAgree
        );

        if (filteredSignals.length === 0) {
            return null;
        }

        const runResult = await backtestService.evaluateSignalsOnData(
            targetData,
            context.interval,
            filteredSignals,
            context.settings,
            context.capitalSettings
        );

        return {
            signals: filteredSignals.length,
            result: runResult.result,
            engineUsed: runResult.engineUsed,
        };
    }

    private buildBreadthFilteredSignals(
        targetSymbol: string,
        targetArtifacts: PairRunArtifacts,
        artifactsBySymbol: Map<string, PairRunArtifacts>,
        lagBars: number,
        minAgree: number
    ): ReturnType<typeof applySignalPolarity> {
        const filtered: ReturnType<typeof applySignalPolarity> = [];

        for (const [timeKeyValue, signalType] of targetArtifacts.signalByTime.entries()) {
            const entryIndex = targetArtifacts.timeIndex.get(timeKeyValue);
            if (entryIndex === undefined) {
                continue;
            }

            const startIndex = Math.max(0, entryIndex - lagBars);
            const windowKeys = targetArtifacts.timeKeys.slice(startIndex, entryIndex + 1);
            let sameCount = 0;

            for (const [symbol, artifacts] of artifactsBySymbol.entries()) {
                if (symbol === targetSymbol) {
                    continue;
                }

                let latestType: Signal["type"] | null = null;
                for (const key of windowKeys) {
                    const candidate = artifacts.signalByTime.get(key);
                    if (candidate) {
                        latestType = candidate;
                    }
                }

                if (latestType === signalType) {
                    sameCount += 1;
                }
            }

            if (sameCount >= minAgree) {
                const sourceSignal = this.findSignalByTime(targetArtifacts, timeKeyValue, signalType);
                if (sourceSignal) {
                    filtered.push(sourceSignal);
                }
            }
        }

        return filtered;
    }

    private findSignalByTime(
        artifacts: PairRunArtifacts,
        desiredTimeKey: string,
        desiredType: Signal["type"]
    ): Signal | null {
        return artifacts.fullSignals.find((signal) => timeKey(signal.time) === desiredTimeKey && signal.type === desiredType) ?? null;
    }

    private renderBreadthSweep(rows: BreadthSweepRow[]): void {
        const dom = this.getDom();
        dom.portfolioBreadthSweepSection.style.display = "";

        if (rows.length === 0) {
            dom.portfolioBreadthSweepTableBody.innerHTML = `
                <tr>
                    <td colspan="8" style="text-align:center;color:var(--text-secondary);padding:16px;">
                        No breadth thresholds produced usable filtered signals.
                    </td>
                </tr>
            `;
            return;
        }

        dom.portfolioBreadthSweepTableBody.innerHTML = rows.map((row) => `
            <tr>
                <td>${row.minAgree}</td>
                <td>${row.signals}</td>
                <td>${row.result.totalTrades}</td>
                <td>${row.result.winRate.toFixed(1)}%</td>
                <td class="${row.result.netProfitPercent >= 0 ? "positive" : "negative"}">${this.formatPercent(row.result.netProfitPercent)}</td>
                <td class="${row.result.expectancy >= 0 ? "positive" : "negative"}">${this.formatCurrency(row.result.expectancy)}</td>
                <td>${this.formatProfitFactor(row.result.profitFactor)}</td>
                <td class="negative">${this.formatDrawdownPercent(row.result.maxDrawdownPercent)}</td>
            </tr>
        `).join("");
    }

    private buildConsensusAnalysis(
        rows: PairAnalysisRow[],
        artifactsBySymbol: Map<string, PairRunArtifacts>,
        lagBars: number,
        minSamples: number
    ): ConsensusAnalysis {
        const allSamples: ConsensusTradeSample[] = [];
        const relevantArtifacts = new Map<string, PairRunArtifacts>();

        for (const row of rows) {
            const artifacts = artifactsBySymbol.get(row.symbol);
            if (artifacts) {
                relevantArtifacts.set(row.symbol, artifacts);
            }
        }

        for (const row of rows) {
            const targetArtifacts = relevantArtifacts.get(row.symbol);
            if (!targetArtifacts) {
                continue;
            }

            for (const trade of row.result.trades) {
                const sample = this.buildConsensusTradeSample(row.symbol, trade, relevantArtifacts, targetArtifacts, lagBars);
                if (sample) {
                    allSamples.push(sample);
                }
            }
        }

        const maxSameCount = allSamples.reduce((max, sample) => Math.max(max, sample.sameCount), 0);
        const bucketMap = new Map<string, { sortValue: number; samples: ConsensusTradeSample[] }>();

        for (const sample of allSamples) {
            const bucket = this.getConsensusBucket(sample.sameCount, maxSameCount);
            const existing = bucketMap.get(bucket.label);
            if (existing) {
                existing.samples.push(sample);
            } else {
                bucketMap.set(bucket.label, { sortValue: bucket.sortValue, samples: [sample] });
            }
        }

        const summaries = Array.from(bucketMap.entries())
            .map(([label, value]) => this.summarizeConsensusBucket(label, value.sortValue, value.samples))
            .sort((a, b) => a.sortValue - b.sortValue);

        const qualifyingBuckets = summaries.filter((bucket) => bucket.samples >= minSamples);
        const qualifyingSampleCount = qualifyingBuckets.reduce((sum, bucket) => sum + bucket.samples, 0);
        const baselineBucket = qualifyingBuckets.find((bucket) => bucket.sortValue === 0) ?? null;

        const bestBucket = qualifyingBuckets
            .slice()
            .sort((a, b) => this.compareConsensusBuckets(a, b))[0] ?? null;
        const bestLongBucket = qualifyingBuckets
            .filter((bucket) => bucket.longSamples >= minSamples)
            .sort((a, b) => this.compareDirectionBuckets(a.longWinRate, a.avgExpectancy, b.longWinRate, b.avgExpectancy))[0] ?? null;
        const bestShortBucket = qualifyingBuckets
            .filter((bucket) => bucket.shortSamples >= minSamples)
            .sort((a, b) => this.compareDirectionBuckets(a.shortWinRate, a.avgExpectancy, b.shortWinRate, b.avgExpectancy))[0] ?? null;

        return {
            qualifyingBuckets,
            allSamples,
            qualifyingSampleCount,
            lagBars,
            minSamples,
            bestBucket,
            bestLongBucket,
            bestShortBucket,
            baselineBucket,
        };
    }

    private buildConsensusTradeSample(
        targetSymbol: string,
        trade: Trade,
        artifactsBySymbol: Map<string, PairRunArtifacts>,
        targetArtifacts: PairRunArtifacts,
        lagBars: number
    ): ConsensusTradeSample | null {
        const entryKey = timeKey(trade.entryTime);
        const entryIndex = targetArtifacts.timeIndex.get(entryKey);
        if (entryIndex === undefined) {
            return null;
        }

        const startIndex = Math.max(0, entryIndex - lagBars);
        const windowKeys = targetArtifacts.timeKeys.slice(startIndex, entryIndex + 1);
        const targetSignalType: Signal["type"] = trade.type === "long" ? "buy" : "sell";
        let sameCount = 0;
        let oppositeCount = 0;

        for (const [symbol, artifacts] of artifactsBySymbol.entries()) {
            if (symbol === targetSymbol) {
                continue;
            }

            let latestType: Signal["type"] | null = null;
            for (const key of windowKeys) {
                const candidate = artifacts.signalByTime.get(key);
                if (candidate) {
                    latestType = candidate;
                }
            }

            if (!latestType) {
                continue;
            }

            if (latestType === targetSignalType) {
                sameCount += 1;
            } else {
                oppositeCount += 1;
            }
        }

        return {
            symbol: targetSymbol,
            direction: trade.type,
            isWin: trade.pnl > 0,
            pnl: trade.pnl,
            pnlPercent: trade.pnlPercent,
            sameCount,
            oppositeCount,
        };
    }

    private getConsensusBucket(sameCount: number, maxSameCount: number): { label: string; sortValue: number } {
        if (maxSameCount >= 4 && sameCount >= 4) {
            return { label: "4+ agree", sortValue: 4 };
        }
        return { label: `${sameCount} agree`, sortValue: sameCount };
    }

    private summarizeConsensusBucket(label: string, sortValue: number, samples: ConsensusTradeSample[]): ConsensusBucketSummary {
        const wins = samples.filter((sample) => sample.isWin).length;
        const longs = samples.filter((sample) => sample.direction === "long");
        const shorts = samples.filter((sample) => sample.direction === "short");
        const longWins = longs.filter((sample) => sample.isWin).length;
        const shortWins = shorts.filter((sample) => sample.isWin).length;

        return {
            label,
            sortValue,
            samples: samples.length,
            winRate: (wins / samples.length) * 100,
            lossRate: ((samples.length - wins) / samples.length) * 100,
            avgExpectancy: samples.reduce((sum, sample) => sum + sample.pnl, 0) / samples.length,
            avgNetPct: samples.reduce((sum, sample) => sum + sample.pnlPercent, 0) / samples.length,
            avgOppose: samples.reduce((sum, sample) => sum + sample.oppositeCount, 0) / samples.length,
            longWinRate: longs.length > 0 ? (longWins / longs.length) * 100 : null,
            shortWinRate: shorts.length > 0 ? (shortWins / shorts.length) * 100 : null,
            longSamples: longs.length,
            shortSamples: shorts.length,
        };
    }

    private compareConsensusBuckets(a: ConsensusBucketSummary, b: ConsensusBucketSummary): number {
        if (b.winRate !== a.winRate) {
            return b.winRate - a.winRate;
        }
        if (b.avgExpectancy !== a.avgExpectancy) {
            return b.avgExpectancy - a.avgExpectancy;
        }
        return b.samples - a.samples;
    }

    private compareDirectionBuckets(
        aWinRate: number | null,
        aExpectancy: number,
        bWinRate: number | null,
        bExpectancy: number
    ): number {
        const safeA = aWinRate ?? -1;
        const safeB = bWinRate ?? -1;
        if (safeB !== safeA) {
            return safeB - safeA;
        }
        return bExpectancy - aExpectancy;
    }

    private computeCloseReturnCorrelation(a: OHLCVData[], b: OHLCVData[]): number | null {
        return this.computeCorrelation(
            this.buildCloseReturnSeries(a),
            this.buildCloseReturnSeries(b)
        );
    }

    private computeEquityReturnCorrelation(a: BacktestResult, b: BacktestResult): number | null {
        return this.computeCorrelation(
            this.buildEquityReturnSeries(a),
            this.buildEquityReturnSeries(b)
        );
    }

    private buildCloseReturnSeries(data: OHLCVData[]): Map<string, number> {
        const series = new Map<string, number>();
        for (let index = 1; index < data.length; index += 1) {
            const previousClose = data[index - 1]?.close;
            const currentClose = data[index]?.close;
            if (!Number.isFinite(previousClose) || !Number.isFinite(currentClose) || previousClose === 0) {
                continue;
            }
            series.set(timeKey(data[index].time), (currentClose - previousClose) / previousClose);
        }
        return series;
    }

    private buildEquityReturnSeries(result: BacktestResult): Map<string, number> {
        const series = new Map<string, number>();
        for (let index = 1; index < result.equityCurve.length; index += 1) {
            const previous = result.equityCurve[index - 1]?.value;
            const current = result.equityCurve[index]?.value;
            if (!Number.isFinite(previous) || !Number.isFinite(current) || previous === 0) {
                continue;
            }
            series.set(timeKey(result.equityCurve[index].time), (current - previous) / previous);
        }
        return series;
    }

    private computeCorrelation(a: Map<string, number>, b: Map<string, number>): number | null {
        const xs: number[] = [];
        const ys: number[] = [];

        const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
        for (const [key, value] of smaller.entries()) {
            const other = larger.get(key);
            if (!Number.isFinite(value) || !Number.isFinite(other)) {
                continue;
            }
            xs.push(value);
            ys.push(other as number);
        }

        if (xs.length < 3) {
            return null;
        }

        const meanX = this.average(xs) ?? 0;
        const meanY = this.average(ys) ?? 0;
        let numerator = 0;
        let denomX = 0;
        let denomY = 0;

        for (let index = 0; index < xs.length; index += 1) {
            const dx = xs[index] - meanX;
            const dy = ys[index] - meanY;
            numerator += dx * dy;
            denomX += dx * dx;
            denomY += dy * dy;
        }

        if (denomX === 0 || denomY === 0) {
            return null;
        }

        return numerator / Math.sqrt(denomX * denomY);
    }

    private average(values: Array<number | null>): number | null {
        const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
        if (finite.length === 0) {
            return null;
        }
        return finite.reduce((sum, value) => sum + value, 0) / finite.length;
    }

    private standardDeviation(values: number[]): number {
        if (values.length === 0) {
            return 0;
        }
        const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
        const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
        return Math.sqrt(variance);
    }

    private formatCurrency(value: number | null): string {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return "-";
        }
        return `${value >= 0 ? "+" : ""}$${value.toFixed(2)}`;
    }

    private formatPercent(value: number | null): string {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return "-";
        }
        return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
    }

    private formatDrawdownPercent(value: number | null): string {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return "-";
        }
        return `-${Math.abs(value).toFixed(2)}%`;
    }

    private formatCorrelation(value: number | null): string {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return "-";
        }
        return value.toFixed(2);
    }

    private formatNullableRate(value: number | null): string {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return "-";
        }
        return `${value.toFixed(1)}%`;
    }

    private formatProfitFactor(value: number): string {
        if (value === Infinity) {
            return "Inf";
        }
        return Number.isFinite(value) ? value.toFixed(2) : "-";
    }

    private getCorrelationCellColor(value: number | null): string {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return "rgba(255,255,255,0.03)";
        }
        const intensity = 0.08 + (Math.abs(value) * 0.28);
        if (value >= 0) {
            return `rgba(0, 200, 83, ${intensity.toFixed(3)})`;
        }
        return `rgba(255, 82, 82, ${intensity.toFixed(3)})`;
    }

    private toDisplaySymbol(symbol: string): string {
        if (symbol.endsWith("USDT") && symbol.length > 4) {
            return `${symbol.slice(0, -4)}/USDT`;
        }
        return symbol;
    }

    private updateStatus(message: string): void {
        this.getDom().portfolioStatus.textContent = message;
    }
}

export const portfolioLabService = new PortfolioLabService();
