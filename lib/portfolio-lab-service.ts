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
import { getOpenPositionForScanner, type OpenPosition } from "./strategies/backtest/signal-preparation";
import {
    buildPortfolioSignalPresenceLookup,
    buildRunnablePortfolioUniverse,
    resolveLatestPortfolioSignalType,
    resolvePortfolioSignalType,
    type PortfolioSignalPresence,
} from "./portfolio-lab-helpers";

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
    signalPresenceByTime: Map<string, PortfolioSignalPresence>;
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
    samplesBySymbol: Map<string, ConsensusTradeSample[]>;
    qualifyingSampleCount: number;
    lagBars: number;
    minSamples: number;
    bestBucket: ConsensusBucketSummary | null;
    bestLongBucket: ConsensusBucketSummary | null;
    bestShortBucket: ConsensusBucketSummary | null;
    baselineBucket: ConsensusBucketSummary | null;
    profilesBySymbol: Map<string, PairConsensusProfile>;
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

interface PairConsensusProfile {
    symbol: string;
    qualifyingBuckets: ConsensusBucketSummary[];
    baselineBucket: ConsensusBucketSummary | null;
    strongestBucket: ConsensusBucketSummary | null;
    bestBucket: ConsensusBucketSummary | null;
}

interface BreadthSweepRow {
    minAgree: number;
    signals: number;
    result: BacktestResult;
    engineUsed: "rust" | "typescript";
}

interface OppositionSweepRow {
    maxOppose: number;
    signals: number;
    result: BacktestResult;
    engineUsed: "rust" | "typescript";
}

interface SignalContext {
    timeKey: string;
    signalType: Signal["type"];
    sameCount: number;
    oppositeCount: number;
    agreeingSymbols: string[];
    opposingSymbols: string[];
}

interface ExecutionFilter {
    minAgree: number;
    maxOppose: number | null;
}

interface ExecutionFilterRun {
    filter: ExecutionFilter;
    signals: number;
    result: BacktestResult;
    engineUsed: "rust" | "typescript";
}

interface PairRankingRow {
    row: PairAnalysisRow;
    role: string;
    breadthLift: number | null;
    breadthExpectancyLift: number | null;
}

interface ScenarioSummary {
    totalTrades: number;
    winRate: number;
    netProfitPercent: number;
    expectancy: number;
    profitFactor: number;
    maxDrawdownPercent: number;
    avgMultiplier: number;
}

interface SizingScenarioRow {
    name: string;
    description: string;
    result: ScenarioSummary;
}

interface LiveContextOdds {
    sampleCount: number;
    winRate: number;
    lossRate: number;
    expectancy: number;
    label: string;
}

interface LiveContextSnapshot {
    basis: "open_trade" | "latest_signal" | "none";
    targetSymbol: string;
    direction: Trade["type"] | null;
    agreementCount: number;
    oppositionCount: number;
    agreeingSymbols: string[];
    opposingSymbols: string[];
    bucketLabel: string | null;
    odds: LiveContextOdds | null;
    openPosition: OpenPosition | null;
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

        dom.portfolioRunBtn.addEventListener("click", () => {
            void this.run();
        });
        dom.portfolioRunBreadthBacktestBtn.addEventListener("click", () => {
            void this.runBreadthBacktest();
        });
        dom.portfolioRunFilterBacktestBtn.addEventListener("click", () => {
            void this.runFilterBacktest();
        });
        dom.portfolioRunBreadthSweepBtn.addEventListener("click", () => {
            void this.runBreadthSweep();
        });
        dom.portfolioRunOppositionSweepBtn.addEventListener("click", () => {
            void this.runOppositionSweep();
        });

        dom.portfolioBenchmarkSymbol.addEventListener("input", () => {
            this.benchmarkDirty = dom.portfolioBenchmarkSymbol.value.trim().length > 0;
            this.invalidateRunContext("Benchmark changed. Run Portfolio Lab again.");
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

    private buildCurrentUniverse(benchmarkInput: string): string[] {
        return buildRunnablePortfolioUniverse(
            state.currentSymbol,
            this.normalizeSymbol(benchmarkInput)
        );
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
            const breadthSweep = await this.buildBreadthSweepRows({
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
            });
            const oppositionSweep = await this.buildOppositionSweepRows({
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
            }, minAgree, maxOppose);
            const rankingRows = this.buildRankingRows(rows, consensus, benchmarkSymbol);
            const sizingRows = this.buildSizingScenarios({
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
            }, rows, minAgree, maxOppose);
            const liveContext = this.buildLiveContextSnapshot({
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
            }, consensus);
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
            this.setDerivedActionsEnabled(true);
            this.render(
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
                minAgree,
                maxOppose
            );
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
        const minAgree = this.readClampedInt(
            dom.portfolioBreadthMinAgree.value,
            Math.min(4, Math.max(0, context.selectedSymbols.length - 1)),
            0,
            Math.max(0, context.selectedSymbols.length)
        );
        dom.portfolioRunBreadthBacktestBtn.disabled = true;
        dom.portfolioRunBreadthBacktestBtn.setAttribute("aria-busy", "true");
        this.updateStatus(`Running breadth-filtered backtest on ${context.benchmarkSymbol} with min agree ${minAgree}...`);

        try {
            await this.runExecutionBacktest(
                context,
                { minAgree, maxOppose: null },
                `breadth >= ${minAgree}`
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

    private async runFilterBacktest(): Promise<void> {
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
        const maxOppose = this.readClampedInt(
            dom.portfolioMaxOppose.value,
            1,
            0,
            Math.max(0, context.selectedSymbols.length)
        );
        dom.portfolioRunFilterBacktestBtn.disabled = true;
        dom.portfolioRunFilterBacktestBtn.setAttribute("aria-busy", "true");
        this.updateStatus(
            `Running filtered backtest on ${context.benchmarkSymbol} with agree >= ${minAgree} and oppose <= ${maxOppose}...`
        );

        try {
            await this.runExecutionBacktest(
                context,
                { minAgree, maxOppose },
                `agree >= ${minAgree}, oppose <= ${maxOppose}`
            );
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
        const targetSymbol = context.benchmarkSymbol;
        dom.portfolioRunBreadthSweepBtn.disabled = true;
        dom.portfolioRunBreadthSweepBtn.setAttribute("aria-busy", "true");
        this.updateStatus(`Sweeping breadth thresholds for ${targetSymbol}...`);

        try {
            const rows = await this.buildBreadthSweepRows(context);
            const oppositionRows = await this.buildOppositionSweepRows(
                context,
                this.readClampedInt(dom.portfolioBreadthMinAgree.value, 4, 0, Math.max(0, context.selectedSymbols.length)),
                this.readClampedInt(dom.portfolioMaxOppose.value, 1, 0, Math.max(0, context.selectedSymbols.length))
            );

            this.renderBreadthSweep(rows);
            dom.portfolioExecutionSummary.innerHTML = this.renderExecutionSummary(
                rows,
                oppositionRows,
                this.findBestFilterRun(rows, oppositionRows, this.readClampedInt(dom.portfolioBreadthMinAgree.value, 4, 0, Math.max(0, context.selectedSymbols.length)), this.readClampedInt(dom.portfolioMaxOppose.value, 1, 0, Math.max(0, context.selectedSymbols.length))),
                context.benchmarkSymbol,
                this.readClampedInt(dom.portfolioBreadthMinAgree.value, 4, 0, Math.max(0, context.selectedSymbols.length)),
                this.readClampedInt(dom.portfolioMaxOppose.value, 1, 0, Math.max(0, context.selectedSymbols.length))
            );
            if (rows.length === 0) {
                uiManager.showToast(`No breadth thresholds produced usable signals for ${targetSymbol}.`, "warning");
                this.updateStatus(`Breadth sweep found no usable thresholds for ${targetSymbol}.`);
                return;
            }

            const bestExp = this.findSweepWinner(rows, (row) => row.result.expectancy, (row) => `>= ${row.minAgree} agree`);
            const bestNet = this.findSweepWinner(rows, (row) => row.result.netProfitPercent, (row) => `>= ${row.minAgree} agree`);
            const bestDd = this.findSweepWinner(rows, (row) => -Math.abs(row.result.maxDrawdownPercent), (row) => `>= ${row.minAgree} agree`);

            uiManager.showToast(`Breadth sweep complete for ${targetSymbol}.`, "success");
            this.updateStatus(
                `Breadth sweep ready for ${targetSymbol}. ` +
                `Best exp ${bestExp?.label ?? "-"} ${bestExp ? this.formatCurrency(bestExp.result.expectancy) : "-"}. ` +
                `Best net ${bestNet?.label ?? "-"} ${bestNet ? this.formatPercent(bestNet.result.netProfitPercent) : "-"}. ` +
                `Best DD ${bestDd?.label ?? "-"} ${bestDd ? this.formatDrawdownPercent(bestDd.result.maxDrawdownPercent) : "-"}.`
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
        const minAgree = this.readClampedInt(
            dom.portfolioBreadthMinAgree.value,
            Math.min(4, Math.max(0, context.selectedSymbols.length - 1)),
            0,
            Math.max(0, context.selectedSymbols.length)
        );
        const maxOppose = this.readClampedInt(
            dom.portfolioMaxOppose.value,
            1,
            0,
            Math.max(0, context.selectedSymbols.length)
        );
        dom.portfolioRunOppositionSweepBtn.disabled = true;
        dom.portfolioRunOppositionSweepBtn.setAttribute("aria-busy", "true");
        this.updateStatus(`Sweeping opposition thresholds for ${context.benchmarkSymbol} at min agree ${minAgree}...`);

        try {
            const rows = await this.buildOppositionSweepRows(context, minAgree, maxOppose);
            this.renderOppositionSweep(rows);
            const breadthRows = await this.buildBreadthSweepRows(context);
            dom.portfolioExecutionSummary.innerHTML = this.renderExecutionSummary(
                breadthRows,
                rows,
                this.findBestFilterRun(breadthRows, rows, minAgree, maxOppose),
                context.benchmarkSymbol,
                minAgree,
                maxOppose
            );

            if (rows.length === 0) {
                uiManager.showToast(`No opposition thresholds produced usable signals for ${context.benchmarkSymbol}.`, "warning");
                this.updateStatus(`Opposition sweep found no usable thresholds for ${context.benchmarkSymbol}.`);
                return;
            }

            const bestExp = this.findSweepWinner(rows, (row) => row.result.expectancy, (row) => `<= ${row.maxOppose} oppose`);
            const bestNet = this.findSweepWinner(rows, (row) => row.result.netProfitPercent, (row) => `<= ${row.maxOppose} oppose`);
            const bestDd = this.findSweepWinner(rows, (row) => -Math.abs(row.result.maxDrawdownPercent), (row) => `<= ${row.maxOppose} oppose`);

            uiManager.showToast(`Opposition sweep complete for ${context.benchmarkSymbol}.`, "success");
            this.updateStatus(
                `Opposition sweep ready for ${context.benchmarkSymbol}. ` +
                `Best exp ${bestExp?.label ?? "-"} ${bestExp ? this.formatCurrency(bestExp.result.expectancy) : "-"}. ` +
                `Best net ${bestNet?.label ?? "-"} ${bestNet ? this.formatPercent(bestNet.result.netProfitPercent) : "-"}. ` +
                `Best DD ${bestDd?.label ?? "-"} ${bestDd ? this.formatDrawdownPercent(bestDd.result.maxDrawdownPercent) : "-"}.`
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
        const signalPresenceByTime = buildPortfolioSignalPresenceLookup(fullSignals);
        const timeKeys = data.map((candle) => timeKey(candle.time));
        const timeIndex = new Map<string, number>();
        timeKeys.forEach((key, index) => {
            timeIndex.set(key, index);
        });

        const artifacts: PairRunArtifacts = {
            result: runResult.result,
            engineUsed: runResult.engineUsed,
            fullSignals,
            signalPresenceByTime,
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
        windowMode: PortfolioWindowMode,
        breadthSweep: BreadthSweepRow[],
        oppositionSweep: OppositionSweepRow[],
        rankingRows: PairRankingRow[],
        sizingRows: SizingScenarioRow[],
        liveContext: LiveContextSnapshot,
        minAgree: number,
        maxOppose: number
    ): void {
        const dom = this.getDom();
        dom.portfolioContent.style.display = "";
        dom.portfolioEmpty.style.display = rows.length > 0 ? "none" : "";
        dom.portfolioResults.style.display = rows.length > 0 ? "" : "none";
        dom.portfolioLiveContextSection.style.display = rows.length > 0 ? "" : "none";
        dom.portfolioInsightSection.style.display = rows.length > 0 ? "" : "none";
        dom.portfolioExecutionSection.style.display = rows.length > 0 ? "" : "none";
        dom.portfolioConsensusSection.style.display = rows.length > 0 ? "" : "none";
        dom.portfolioRankingSection.style.display = rows.length > 0 ? "" : "none";
        dom.portfolioSizingSection.style.display = rows.length > 0 ? "" : "none";
        dom.portfolioMatrixSection.style.display = rows.length > 1 ? "" : "none";

        if (rows.length === 0) {
            dom.portfolioSummary.innerHTML = "";
            dom.portfolioLiveContextSummary.innerHTML = "";
            dom.portfolioLiveContextDetails.innerHTML = "";
            dom.portfolioInsights.innerHTML = "";
            dom.portfolioExecutionSummary.innerHTML = "";
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
            dom.portfolioOppositionSweepSection.style.display = "none";
            dom.portfolioOppositionSweepTableBody.innerHTML = `
                <tr>
                    <td colspan="8" style="text-align:center;color:var(--text-secondary);padding:16px;">
                        Run Sweep Opposition to compare conflict thresholds.
                    </td>
                </tr>
            `;
            dom.portfolioRankingSummary.innerHTML = "";
            dom.portfolioRankingTableBody.innerHTML = `
                <tr>
                    <td colspan="8" style="text-align:center;color:var(--text-secondary);padding:16px;">
                        Run Portfolio Lab to rank pairs by quality, diversification, and context response.
                    </td>
                </tr>
            `;
            dom.portfolioSizingSummary.innerHTML = "";
            dom.portfolioSizingTableBody.innerHTML = `
                <tr>
                    <td colspan="8" style="text-align:center;color:var(--text-secondary);padding:16px;">
                        Run Portfolio Lab to compare context-weighted sizing scenarios.
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
        dom.portfolioLiveContextSummary.innerHTML = this.renderLiveContextSummary(liveContext);
        dom.portfolioLiveContextDetails.innerHTML = this.renderLiveContextDetails(liveContext);
        dom.portfolioInsights.innerHTML = this.renderInsights(rows, benchmarkSymbol, skipped, windowMode);
        dom.portfolioExecutionSummary.innerHTML = this.renderExecutionSummary(
            breadthSweep,
            oppositionSweep,
            this.findBestFilterRun(breadthSweep, oppositionSweep, minAgree, maxOppose),
            benchmarkSymbol,
            minAgree,
            maxOppose
        );
        dom.portfolioConsensusSummary.innerHTML = this.renderConsensusSummary(consensus);
        dom.portfolioConsensusTableBody.innerHTML = this.renderConsensusTable(consensus);
        this.renderBreadthSweep(breadthSweep);
        this.renderOppositionSweep(oppositionSweep);
        dom.portfolioRankingSummary.innerHTML = this.renderRankingSummary(rankingRows);
        dom.portfolioRankingTableBody.innerHTML = this.renderRankingTable(rankingRows, benchmarkSymbol);
        dom.portfolioSizingSummary.innerHTML = this.renderSizingSummary(sizingRows);
        dom.portfolioSizingTableBody.innerHTML = this.renderSizingTable(sizingRows);
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

    private renderExecutionSummary(
        breadthRows: BreadthSweepRow[],
        oppositionRows: OppositionSweepRow[],
        currentFilter: ExecutionFilterRun | null,
        targetSymbol: string,
        minAgree: number,
        maxOppose: number
    ): string {
        const bestBreadth = this.renderBestBreadthSweep(breadthRows);
        const bestOpposition = this.renderBestOppositionSweep(oppositionRows);
        const breadthNet = this.findSweepWinner(
            breadthRows,
            (row) => row.result.netProfitPercent,
            (row) => `>= ${row.minAgree} agree`
        );
        const breadthDd = this.findSweepWinner(
            breadthRows,
            (row) => -Math.abs(row.result.maxDrawdownPercent),
            (row) => `>= ${row.minAgree} agree`
        );
        const oppositionNet = this.findSweepWinner(
            oppositionRows,
            (row) => row.result.netProfitPercent,
            (row) => `<= ${row.maxOppose} oppose`
        );
        const oppositionDd = this.findSweepWinner(
            oppositionRows,
            (row) => -Math.abs(row.result.maxDrawdownPercent),
            (row) => `<= ${row.maxOppose} oppose`
        );
        return [
            this.renderSummaryCard(
                "Target Pair",
                this.toDisplaySymbol(targetSymbol),
                `execution filters are evaluated on the benchmark/current target`
            ),
            this.renderSummaryCard(
                "Breadth Best Exp",
                bestBreadth ? `>= ${bestBreadth.minAgree} agree` : "-",
                bestBreadth
                    ? `${bestBreadth.result.winRate.toFixed(1)}% win | ${this.formatCurrency(bestBreadth.result.expectancy)}`
                    : "Run produced no valid breadth thresholds"
            ),
            this.renderSummaryCard(
                "Breadth Best Net",
                breadthNet?.label ?? "-",
                breadthNet ? `${this.formatPercent(breadthNet.result.netProfitPercent)} | ${this.formatDrawdownPercent(breadthNet.result.maxDrawdownPercent)}` : "Run produced no valid breadth thresholds"
            ),
            this.renderSummaryCard(
                "Breadth Best DD",
                breadthDd?.label ?? "-",
                breadthDd ? `${this.formatDrawdownPercent(breadthDd.result.maxDrawdownPercent)} | ${this.formatCurrency(breadthDd.result.expectancy)}` : "Run produced no valid breadth thresholds"
            ),
            this.renderSummaryCard(
                "Oppose Best Exp",
                bestOpposition ? `<= ${bestOpposition.maxOppose} oppose` : "-",
                bestOpposition
                    ? `${bestOpposition.result.winRate.toFixed(1)}% win | ${this.formatCurrency(bestOpposition.result.expectancy)}`
                    : "Run produced no valid opposition thresholds"
            ),
            this.renderSummaryCard(
                "Oppose Best Net",
                oppositionNet?.label ?? "-",
                oppositionNet ? `${this.formatPercent(oppositionNet.result.netProfitPercent)} | ${this.formatDrawdownPercent(oppositionNet.result.maxDrawdownPercent)}` : "Run produced no valid opposition thresholds"
            ),
            this.renderSummaryCard(
                "Oppose Best DD",
                oppositionDd?.label ?? "-",
                oppositionDd ? `${this.formatDrawdownPercent(oppositionDd.result.maxDrawdownPercent)} | ${this.formatCurrency(oppositionDd.result.expectancy)}` : "Run produced no valid opposition thresholds"
            ),
            this.renderSummaryCard(
                "Current Filter",
                `>= ${minAgree} agree, <= ${maxOppose} oppose`,
                currentFilter
                    ? `${currentFilter.result.winRate.toFixed(1)}% win | ${this.formatCurrency(currentFilter.result.expectancy)}`
                    : "Current threshold removed all signals"
            ),
        ].join("");
    }

    private renderLiveContextSummary(liveContext: LiveContextSnapshot): string {
        if (liveContext.basis === "none" || !liveContext.direction) {
            return `
                <div class="sim-card" style="grid-column: 1 / -1;">
                    <div class="sim-card-label">Current Context</div>
                    <div class="sim-card-value">No active setup</div>
                    <div class="sim-card-delta">No open trade or recent signal was available for the target symbol.</div>
                </div>
            `;
        }

        const basisLabel = liveContext.basis === "open_trade" ? "Open Trade" : "Latest Signal";
        return [
            this.renderSummaryCard("Context Basis", basisLabel, this.toDisplaySymbol(liveContext.targetSymbol)),
            this.renderSummaryCard("Direction", liveContext.direction.toUpperCase(), `${liveContext.bucketLabel ?? "No bucket"} | ${liveContext.agreementCount} agree / ${liveContext.oppositionCount} oppose`),
            this.renderSummaryCard(
                "Historical Odds",
                liveContext.odds ? `${liveContext.odds.winRate.toFixed(1)}% win` : "Not enough samples",
                liveContext.odds ? `${liveContext.odds.label} | ${liveContext.odds.sampleCount} samples` : "Need more historical matches for this context"
            ),
            this.renderSummaryCard(
                "Estimated Expectancy",
                liveContext.odds ? this.formatCurrency(liveContext.odds.expectancy) : "-",
                liveContext.openPosition
                    ? `${liveContext.openPosition.unrealizedPnlPercent >= 0 ? "+" : ""}${liveContext.openPosition.unrealizedPnlPercent.toFixed(2)}% unrealized | ${liveContext.openPosition.barsInTrade} bars held`
                    : "One-shot context estimate only; no live stream"
            ),
        ].join("");
    }

    private renderLiveContextDetails(liveContext: LiveContextSnapshot): string {
        if (liveContext.basis === "none" || !liveContext.direction) {
            return `<div class="portfolio-lab__insight">Run Portfolio Lab after loading enough data on the target symbol to calculate current agreement and historical odds.</div>`;
        }

        const details: string[] = [];
        const basisLabel = liveContext.basis === "open_trade" ? "open trade" : "latest signal";
        details.push(
            `<strong>Current ${basisLabel}:</strong> ${this.toDisplaySymbol(liveContext.targetSymbol)} ` +
            `${liveContext.direction.toUpperCase()} with ${liveContext.agreementCount} agreeing pair${liveContext.agreementCount === 1 ? "" : "s"} ` +
            `and ${liveContext.oppositionCount} opposing pair${liveContext.oppositionCount === 1 ? "" : "s"}.`
        );

        if (liveContext.agreeingSymbols.length > 0) {
            details.push(`<strong>Agreeing pairs:</strong> ${liveContext.agreeingSymbols.map((symbol) => this.toDisplaySymbol(symbol)).join(", ")}.`);
        }
        if (liveContext.opposingSymbols.length > 0) {
            details.push(`<strong>Opposing pairs:</strong> ${liveContext.opposingSymbols.map((symbol) => this.toDisplaySymbol(symbol)).join(", ")}.`);
        }
        if (liveContext.odds) {
            details.push(
                `<strong>Historical match:</strong> ${liveContext.odds.label} returned ${liveContext.odds.winRate.toFixed(1)}% win / ` +
                `${liveContext.odds.lossRate.toFixed(1)}% loss across ${liveContext.odds.sampleCount} closed trades, with ` +
                `${this.formatCurrency(liveContext.odds.expectancy)} average expectancy.`
            );
        } else {
            details.push(`<strong>Historical match:</strong> not enough similar closed trades yet for a reliable estimate.`);
        }
        if (liveContext.openPosition) {
            details.push(
                `<strong>Open-trade state:</strong> entry ${liveContext.openPosition.entryPrice.toFixed(4)}, current ${liveContext.openPosition.currentPrice.toFixed(4)}, ` +
                `${liveContext.openPosition.unrealizedPnlPercent >= 0 ? "+" : ""}${liveContext.openPosition.unrealizedPnlPercent.toFixed(2)}% unrealized.`
            );
        }

        return details.map((detail) => `<div class="portfolio-lab__insight">${detail}</div>`).join("");
    }

    private findSweepWinner<T extends BreadthSweepRow | OppositionSweepRow>(
        rows: T[],
        score: (row: T) => number,
        label: (row: T) => string
    ): { label: string; result: BacktestResult } | null {
        if (rows.length === 0) {
            return null;
        }
        const winner = rows
            .slice()
            .sort((a, b) => {
                const delta = score(b) - score(a);
                if (delta !== 0) {
                    return delta;
                }
                return b.result.expectancy - a.result.expectancy;
            })[0];
        return winner ? { label: label(winner), result: winner.result } : null;
    }

    private renderRankingSummary(rows: PairRankingRow[]): string {
        if (rows.length === 0) {
            return "";
        }

        const core = rows.find((row) => row.role === "Core" || row.role === "Target") ?? rows[0];
        const diversifier = rows
            .slice()
            .sort((a, b) => {
                const corrDelta = Math.abs(a.row.marketCorrelation ?? 0) - Math.abs(b.row.marketCorrelation ?? 0);
                if (corrDelta !== 0) {
                    return corrDelta;
                }
                return b.row.result.expectancy - a.row.result.expectancy;
            })[0] ?? rows[0];
        const responder = rows
            .filter((row) => typeof row.breadthExpectancyLift === "number" && row.breadthExpectancyLift > 0)
            .sort((a, b) => (b.breadthExpectancyLift ?? -Infinity) - (a.breadthExpectancyLift ?? -Infinity))[0] ?? rows[0];

        return [
            this.renderSummaryCard("Core Pair", core.row.displayName, `${this.formatCurrency(core.row.result.expectancy)} expectancy | ${this.formatDrawdownPercent(core.row.result.maxDrawdownPercent)} DD`),
            this.renderSummaryCard("Best Diversifier", diversifier.row.displayName, `${this.formatCorrelation(diversifier.row.marketCorrelation)} market corr | ${this.formatCurrency(diversifier.row.result.expectancy)}`),
            this.renderSummaryCard(
                "Strongest Responder",
                responder.row.displayName,
                responder.breadthExpectancyLift !== null
                    ? `${this.formatCurrency(responder.breadthExpectancyLift)} expectancy lift when breadth is strong`
                    : "No clear breadth-response edge"
            ),
        ].join("");
    }

    private renderRankingTable(rows: PairRankingRow[], benchmarkSymbol: string): string {
        if (rows.length === 0) {
            return `
                <tr>
                    <td colspan="8" style="text-align:center;color:var(--text-secondary);padding:16px;">
                        Run Portfolio Lab to rank pairs by quality, diversification, and context response.
                    </td>
                </tr>
            `;
        }

        return rows.map((item) => {
            const row = item.row;
            const roleClass = row.symbol === benchmarkSymbol ? " portfolio-lab__pair-badge--benchmark" : "";
            return `
                <tr>
                    <td>
                        <div class="portfolio-lab__pair-cell">
                            <span>${row.displayName}</span>
                            <span class="portfolio-lab__pair-badge${roleClass}">${row.engineUsed === "rust" ? "Rust" : "TS"}</span>
                        </div>
                    </td>
                    <td>${item.role}</td>
                    <td class="${row.result.expectancy >= 0 ? "positive" : "negative"}">${this.formatCurrency(row.result.expectancy)}</td>
                    <td class="negative">${this.formatDrawdownPercent(row.result.maxDrawdownPercent)}</td>
                    <td class="${(item.breadthExpectancyLift ?? 0) >= 0 ? "positive" : "negative"}">${this.formatCurrency(item.breadthExpectancyLift)}</td>
                    <td>${this.formatCorrelation(row.marketCorrelation)}</td>
                    <td>${this.formatCorrelation(row.strategyCorrelation)}</td>
                    <td><button class="btn-simulate portfolio-lab__load-btn" data-symbol="${row.symbol}" type="button">Load</button></td>
                </tr>
            `;
        }).join("");
    }

    private renderSizingSummary(rows: SizingScenarioRow[]): string {
        if (rows.length === 0) {
            return "";
        }

        const bestNet = rows.slice().sort((a, b) => b.result.netProfitPercent - a.result.netProfitPercent)[0];
        const bestDefensive = rows.slice().sort((a, b) => Math.abs(a.result.maxDrawdownPercent) - Math.abs(b.result.maxDrawdownPercent))[0];

        return [
            this.renderSummaryCard("Best Net Scenario", bestNet.name, `${this.formatPercent(bestNet.result.netProfitPercent)} | ${this.formatCurrency(bestNet.result.expectancy)}`),
            this.renderSummaryCard("Lowest DD Scenario", bestDefensive.name, `${this.formatDrawdownPercent(bestDefensive.result.maxDrawdownPercent)} | ${bestDefensive.result.winRate.toFixed(1)}% win`),
            this.renderSummaryCard("Sizing Note", "Context-weighted", "These scenarios scale trade size by pair context instead of filtering trades out."),
        ].join("");
    }

    private renderSizingTable(rows: SizingScenarioRow[]): string {
        if (rows.length === 0) {
            return `
                <tr>
                    <td colspan="8" style="text-align:center;color:var(--text-secondary);padding:16px;">
                        Run Portfolio Lab to compare context-weighted sizing scenarios.
                    </td>
                </tr>
            `;
        }

        return rows.map((row) => `
            <tr>
                <td>
                    <div>${row.name}</div>
                    <div class="portfolio-lab__table-caption">${row.description}</div>
                </td>
                <td>${row.result.avgMultiplier.toFixed(2)}x</td>
                <td>${row.result.totalTrades}</td>
                <td>${row.result.winRate.toFixed(1)}%</td>
                <td class="${row.result.netProfitPercent >= 0 ? "positive" : "negative"}">${this.formatPercent(row.result.netProfitPercent)}</td>
                <td class="${row.result.expectancy >= 0 ? "positive" : "negative"}">${this.formatCurrency(row.result.expectancy)}</td>
                <td>${this.formatProfitFactor(row.result.profitFactor)}</td>
                <td class="negative">${this.formatDrawdownPercent(row.result.maxDrawdownPercent)}</td>
            </tr>
        `).join("");
    }

    private renderInsights(
        rows: PairAnalysisRow[],
        benchmarkSymbol: string,
        skipped: string[],
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

    private async buildBreadthSweepRows(context: PortfolioRunContext): Promise<BreadthSweepRow[]> {
        const maxAgree = Math.max(0, context.selectedSymbols.length - (context.selectedSymbols.includes(context.benchmarkSymbol) ? 1 : 0));
        const rows: BreadthSweepRow[] = [];

        for (let minAgree = 0; minAgree <= maxAgree; minAgree += 1) {
            const breadthRun = await this.buildFilterRun(context, { minAgree, maxOppose: null });
            if (breadthRun) {
                rows.push({
                    minAgree,
                    signals: breadthRun.signals,
                    result: breadthRun.result,
                    engineUsed: breadthRun.engineUsed,
                });
            }
        }

        return rows;
    }

    private async buildOppositionSweepRows(
        context: PortfolioRunContext,
        minAgree: number,
        _maxOpposeHint: number
    ): Promise<OppositionSweepRow[]> {
        const maxOppose = Math.max(0, context.selectedSymbols.length - (context.selectedSymbols.includes(context.benchmarkSymbol) ? 1 : 0));
        const rows: OppositionSweepRow[] = [];

        for (let threshold = 0; threshold <= maxOppose; threshold += 1) {
            const filterRun = await this.buildFilterRun(context, { minAgree, maxOppose: threshold });
            if (filterRun) {
                rows.push({
                    maxOppose: threshold,
                    signals: filterRun.signals,
                    result: filterRun.result,
                    engineUsed: filterRun.engineUsed,
                });
            }
        }

        return rows;
    }

    private async runExecutionBacktest(
        context: PortfolioRunContext,
        filter: ExecutionFilter,
        label: string
    ): Promise<void> {
        const targetSymbol = context.benchmarkSymbol;
        const filterRun = await this.buildFilterRun(context, filter);
        if (!filterRun) {
            uiManager.showToast(`No ${targetSymbol} signals met ${label}.`, "warning");
            this.updateStatus(`Execution filter removed all ${targetSymbol} signals at ${label}.`);
            return;
        }

        state.set('currentBacktestResultSource', 'backtest');
        state.set('currentBacktestResult', filterRun.result);
        strategyPanelController.switchTab('results');
        uiManager.showToast(
            `Execution backtest complete: ${targetSymbol} with ${label} (${filterRun.signals} signals).`,
            'success'
        );
        this.updateStatus(
            `Execution backtest ready for ${targetSymbol}: ${filterRun.result.totalTrades} trades, ` +
            `${filterRun.result.winRate.toFixed(1)}% win rate, ${this.formatCurrency(filterRun.result.expectancy)} expectancy.`
        );
    }

    private async buildFilterRun(
        context: PortfolioRunContext,
        filter: ExecutionFilter
    ): Promise<ExecutionFilterRun | null> {
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

        const signalContexts = this.buildSignalContexts(
            targetSymbol,
            targetArtifacts,
            context.runCache,
            context.lagBars
        );
        const filteredSignals = this.buildFilteredSignals(
            targetArtifacts,
            signalContexts,
            filter
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
            filter,
            signals: filteredSignals.length,
            result: runResult.result,
            engineUsed: runResult.engineUsed,
        };
    }

    private buildFilteredSignals(
        targetArtifacts: PairRunArtifacts,
        signalContexts: Map<string, SignalContext>,
        filter: ExecutionFilter
    ): ReturnType<typeof applySignalPolarity> {
        const filtered: ReturnType<typeof applySignalPolarity> = [];

        for (const signal of targetArtifacts.fullSignals) {
            const context = signalContexts.get(this.buildSignalContextKey(timeKey(signal.time), signal.type));
            if (!context) {
                continue;
            }
            if (context.sameCount < filter.minAgree) {
                continue;
            }
            if (typeof filter.maxOppose === "number" && context.oppositeCount > filter.maxOppose) {
                continue;
            }
            filtered.push(signal);
        }

        return filtered;
    }

    private buildSignalContexts(
        targetSymbol: string,
        targetArtifacts: PairRunArtifacts,
        artifactsBySymbol: Map<string, PairRunArtifacts>,
        lagBars: number
    ): Map<string, SignalContext> {
        const contexts = new Map<string, SignalContext>();

        for (const [timeKeyValue, signalPresence] of targetArtifacts.signalPresenceByTime.entries()) {
            const signalType = resolvePortfolioSignalType(signalPresence);
            if (!signalType) {
                continue;
            }
            const entryIndex = targetArtifacts.timeIndex.get(timeKeyValue);
            if (entryIndex === undefined) {
                continue;
            }

            const startIndex = Math.max(0, entryIndex - lagBars);
            const windowKeys = targetArtifacts.timeKeys.slice(startIndex, entryIndex + 1);
            let sameCount = 0;
            let oppositeCount = 0;
            const agreeingSymbols: string[] = [];
            const opposingSymbols: string[] = [];

            for (const [symbol, artifacts] of artifactsBySymbol.entries()) {
                if (symbol === targetSymbol) {
                    continue;
                }

                const latestType = resolveLatestPortfolioSignalType(windowKeys, artifacts.signalPresenceByTime);

                if (latestType === signalType) {
                    sameCount += 1;
                    agreeingSymbols.push(symbol);
                } else if (latestType) {
                    oppositeCount += 1;
                    opposingSymbols.push(symbol);
                }
            }

            contexts.set(this.buildSignalContextKey(timeKeyValue, signalType), {
                timeKey: timeKeyValue,
                signalType,
                sameCount,
                oppositeCount,
                agreeingSymbols,
                opposingSymbols,
            });
        }

        return contexts;
    }

    private buildSignalContextKey(timeValue: string, signalType: Signal["type"]): string {
        return `${timeValue}|${signalType}`;
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

    private renderOppositionSweep(rows: OppositionSweepRow[]): void {
        const dom = this.getDom();
        dom.portfolioOppositionSweepSection.style.display = "";

        if (rows.length === 0) {
            dom.portfolioOppositionSweepTableBody.innerHTML = `
                <tr>
                    <td colspan="8" style="text-align:center;color:var(--text-secondary);padding:16px;">
                        No opposition thresholds produced usable filtered signals.
                    </td>
                </tr>
            `;
            return;
        }

        const displayRows = this.collapseOppositionSweepRows(rows);
        dom.portfolioOppositionSweepTableBody.innerHTML = displayRows.map(({ label, row }) => `
            <tr>
                <td>${label}</td>
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

    private renderBestBreadthSweep(rows: BreadthSweepRow[]): BreadthSweepRow | null {
        return rows
            .slice()
            .sort((a, b) => {
                if (b.result.expectancy !== a.result.expectancy) {
                    return b.result.expectancy - a.result.expectancy;
                }
                return b.result.netProfitPercent - a.result.netProfitPercent;
            })[0] ?? null;
    }

    private collapseOppositionSweepRows(rows: OppositionSweepRow[]): Array<{ label: string; row: OppositionSweepRow }> {
        if (rows.length === 0) {
            return [];
        }

        const collapsed: Array<{ start: number; end: number; row: OppositionSweepRow }> = [];
        for (const row of rows) {
            const last = collapsed[collapsed.length - 1];
            if (last && this.isEquivalentSweepResult(last.row.result, row.result) && last.row.signals === row.signals) {
                last.end = row.maxOppose;
            } else {
                collapsed.push({ start: row.maxOppose, end: row.maxOppose, row });
            }
        }

        return collapsed.map((entry) => ({
            label: entry.start === entry.end ? `${entry.start}` : `${entry.start}+`,
            row: entry.row,
        }));
    }

    private isEquivalentSweepResult(a: BacktestResult, b: BacktestResult): boolean {
        return a.totalTrades === b.totalTrades
            && Math.abs(a.netProfitPercent - b.netProfitPercent) < 0.0001
            && Math.abs(a.expectancy - b.expectancy) < 0.0001
            && Math.abs(a.profitFactor - b.profitFactor) < 0.0001
            && Math.abs(a.maxDrawdownPercent - b.maxDrawdownPercent) < 0.0001
            && Math.abs(a.winRate - b.winRate) < 0.0001;
    }

    private renderBestOppositionSweep(rows: OppositionSweepRow[]): OppositionSweepRow | null {
        return rows
            .slice()
            .sort((a, b) => {
                if (b.result.expectancy !== a.result.expectancy) {
                    return b.result.expectancy - a.result.expectancy;
                }
                return b.result.netProfitPercent - a.result.netProfitPercent;
            })[0] ?? null;
    }

    private findBestFilterRun(
        _breadthRows: BreadthSweepRow[],
        oppositionRows: OppositionSweepRow[],
        minAgree: number,
        maxOppose: number
    ): ExecutionFilterRun | null {
        const current = oppositionRows.find((row) => row.maxOppose === maxOppose);
        if (!current) {
            return null;
        }
        return {
            filter: { minAgree, maxOppose },
            signals: current.signals,
            result: current.result,
            engineUsed: current.engineUsed,
        };
    }

    private buildConsensusAnalysis(
        rows: PairAnalysisRow[],
        artifactsBySymbol: Map<string, PairRunArtifacts>,
        lagBars: number,
        minSamples: number
    ): ConsensusAnalysis {
        const allSamples: ConsensusTradeSample[] = [];
        const samplesBySymbol = new Map<string, ConsensusTradeSample[]>();
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
                    const symbolSamples = samplesBySymbol.get(row.symbol);
                    if (symbolSamples) {
                        symbolSamples.push(sample);
                    } else {
                        samplesBySymbol.set(row.symbol, [sample]);
                    }
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
        const profilesBySymbol = new Map<string, PairConsensusProfile>();

        for (const [symbol, samples] of samplesBySymbol.entries()) {
            const summaries = this.summarizeSymbolBuckets(samples, minSamples);
            profilesBySymbol.set(symbol, {
                symbol,
                qualifyingBuckets: summaries.qualifyingBuckets,
                baselineBucket: summaries.baselineBucket,
                strongestBucket: summaries.strongestBucket,
                bestBucket: summaries.bestBucket,
            });
        }

        return {
            qualifyingBuckets,
            allSamples,
            samplesBySymbol,
            qualifyingSampleCount,
            lagBars,
            minSamples,
            bestBucket,
            bestLongBucket,
            bestShortBucket,
            baselineBucket,
            profilesBySymbol,
        };
    }

    private summarizeSymbolBuckets(
        samples: ConsensusTradeSample[],
        minSamples: number
    ): {
        qualifyingBuckets: ConsensusBucketSummary[];
        baselineBucket: ConsensusBucketSummary | null;
        strongestBucket: ConsensusBucketSummary | null;
        bestBucket: ConsensusBucketSummary | null;
    } {
        const maxSameCount = samples.reduce((max, sample) => Math.max(max, sample.sameCount), 0);
        const bucketMap = new Map<string, { sortValue: number; samples: ConsensusTradeSample[] }>();

        for (const sample of samples) {
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
        const baselineBucket = qualifyingBuckets.find((bucket) => bucket.sortValue === 0) ?? null;
        const strongestBucket = qualifyingBuckets
            .slice()
            .sort((a, b) => b.sortValue - a.sortValue)[0] ?? null;
        const bestBucket = qualifyingBuckets
            .slice()
            .sort((a, b) => this.compareConsensusBuckets(a, b))[0] ?? null;

        return {
            qualifyingBuckets,
            baselineBucket,
            strongestBucket,
            bestBucket,
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

            const latestType = resolveLatestPortfolioSignalType(windowKeys, artifacts.signalPresenceByTime);

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

    private buildRankingRows(
        rows: PairAnalysisRow[],
        consensus: ConsensusAnalysis,
        benchmarkSymbol: string
    ): PairRankingRow[] {
        return rows
            .map((row) => {
                const profile = consensus.profilesBySymbol.get(row.symbol);
                const breadthLift = this.computeBreadthWinLift(profile);
                const breadthExpectancyLift = this.computeBreadthExpectancyLift(profile);
                return {
                    row,
                    role: this.classifyPairRole(row, profile, benchmarkSymbol),
                    breadthLift,
                    breadthExpectancyLift,
                };
            })
            .sort((a, b) => {
                if (b.row.result.expectancy !== a.row.result.expectancy) {
                    return b.row.result.expectancy - a.row.result.expectancy;
                }
                return Math.abs(a.row.result.maxDrawdownPercent) - Math.abs(b.row.result.maxDrawdownPercent);
            });
    }

    private computeBreadthWinLift(profile: PairConsensusProfile | undefined): number | null {
        if (!profile?.baselineBucket || !profile.strongestBucket) {
            return null;
        }
        return profile.strongestBucket.winRate - profile.baselineBucket.winRate;
    }

    private computeBreadthExpectancyLift(profile: PairConsensusProfile | undefined): number | null {
        if (!profile?.baselineBucket || !profile.strongestBucket) {
            return null;
        }
        return profile.strongestBucket.avgExpectancy - profile.baselineBucket.avgExpectancy;
    }

    private classifyPairRole(
        row: PairAnalysisRow,
        profile: PairConsensusProfile | undefined,
        benchmarkSymbol: string
    ): string {
        if (row.symbol === benchmarkSymbol) {
            return "Target";
        }

        const marketCorr = Math.abs(row.marketCorrelation ?? 0);
        const strategyCorr = Math.abs(row.strategyCorrelation ?? 0);
        const breadthLift = this.computeBreadthExpectancyLift(profile) ?? 0;

        if (marketCorr <= 0.5 && strategyCorr <= 0.3 && row.result.expectancy > 0) {
            return "Diversifier";
        }
        if (breadthLift >= 2) {
            return "Responder";
        }
        if (row.result.expectancy >= 0 && Math.abs(row.result.maxDrawdownPercent) <= 6) {
            return "Core";
        }
        return "Satellite";
    }

    private buildLiveContextSnapshot(
        context: PortfolioRunContext,
        consensus: ConsensusAnalysis
    ): LiveContextSnapshot {
        const targetArtifacts = context.runCache.get(context.benchmarkSymbol);
        const targetData = context.dataCache.get(context.benchmarkSymbol)?.data ?? [];
        if (!targetArtifacts || targetData.length === 0) {
            return {
                basis: "none",
                targetSymbol: context.benchmarkSymbol,
                direction: null,
                agreementCount: 0,
                oppositionCount: 0,
                agreeingSymbols: [],
                opposingSymbols: [],
                bucketLabel: null,
                odds: null,
                openPosition: null,
            };
        }

        const signalContexts = this.buildSignalContexts(
            context.benchmarkSymbol,
            targetArtifacts,
            context.runCache,
            context.lagBars
        );
        const openPosition = getOpenPositionForScanner(targetData, targetArtifacts.fullSignals, context.settings);
        const currentSetup = openPosition
            ? (() => {
                const currentContext = this.buildCurrentOpenPositionContext(
                    context,
                    openPosition.direction
                );
                return currentContext
                    ? { basis: "open_trade" as const, direction: openPosition.direction, context: currentContext }
                    : null;
            })()
            : this.findLatestSignalSetup(targetArtifacts, signalContexts);
        if (!currentSetup) {
            return {
                basis: "none",
                targetSymbol: context.benchmarkSymbol,
                direction: null,
                agreementCount: 0,
                oppositionCount: 0,
                agreeingSymbols: [],
                opposingSymbols: [],
                bucketLabel: null,
                odds: null,
                openPosition,
            };
        }

        const odds = this.estimateLiveContextOdds(
            consensus.samplesBySymbol.get(context.benchmarkSymbol) ?? [],
            currentSetup.direction,
            currentSetup.context,
            consensus.minSamples
        );

        return {
            basis: currentSetup.basis,
            targetSymbol: context.benchmarkSymbol,
            direction: currentSetup.direction,
            agreementCount: currentSetup.context.sameCount,
            oppositionCount: currentSetup.context.oppositeCount,
            agreeingSymbols: currentSetup.context.agreeingSymbols,
            opposingSymbols: currentSetup.context.opposingSymbols,
            bucketLabel: this.getConsensusBucket(currentSetup.context.sameCount, currentSetup.context.sameCount).label,
            odds,
            openPosition,
        };
    }

    private buildCurrentOpenPositionContext(
        context: PortfolioRunContext,
        targetDirection: Trade["type"]
    ): SignalContext | null {
        const targetArtifacts = context.runCache.get(context.benchmarkSymbol);
        if (!targetArtifacts || targetArtifacts.timeKeys.length === 0) {
            return null;
        }

        const agreeingSymbols: string[] = [];
        const opposingSymbols: string[] = [];
        let sameCount = 0;
        let oppositeCount = 0;

        for (const [symbol, artifacts] of context.runCache.entries()) {
            if (symbol === context.benchmarkSymbol) {
                continue;
            }

            const peerData = context.dataCache.get(symbol)?.data ?? [];
            if (peerData.length === 0) {
                continue;
            }

            const peerOpenPosition = getOpenPositionForScanner(peerData, artifacts.fullSignals, context.settings);
            if (!peerOpenPosition) {
                continue;
            }

            if (peerOpenPosition.direction === targetDirection) {
                sameCount += 1;
                agreeingSymbols.push(symbol);
            } else {
                oppositeCount += 1;
                opposingSymbols.push(symbol);
            }
        }

        return {
            timeKey: targetArtifacts.timeKeys[targetArtifacts.timeKeys.length - 1],
            signalType: targetDirection === "long" ? "buy" : "sell",
            sameCount,
            oppositeCount,
            agreeingSymbols,
            opposingSymbols,
        };
    }

    private findLatestSignalSetup(
        targetArtifacts: PairRunArtifacts,
        signalContexts: Map<string, SignalContext>
    ): { basis: "latest_signal"; direction: Trade["type"]; context: SignalContext } | null {
        for (let index = targetArtifacts.fullSignals.length - 1; index >= 0; index -= 1) {
            const signal = targetArtifacts.fullSignals[index];
            const latestContext = signalContexts.get(this.buildSignalContextKey(timeKey(signal.time), signal.type));
            if (!latestContext) {
                continue;
            }

            return {
                basis: "latest_signal",
                direction: signal.type === "buy" ? "long" : "short",
                context: latestContext,
            };
        }
        return null;
    }

    private estimateLiveContextOdds(
        samples: ConsensusTradeSample[],
        direction: Trade["type"],
        currentContext: SignalContext,
        minSamples: number
    ): LiveContextOdds | null {
        const exactDirectional = samples.filter((sample) =>
            sample.direction === direction &&
            sample.sameCount >= currentContext.sameCount &&
            sample.oppositeCount <= currentContext.oppositeCount
        );
        if (exactDirectional.length >= minSamples) {
            return this.summarizeLiveContextOdds(
                exactDirectional,
                `${direction.toUpperCase()} trades with >= ${currentContext.sameCount} agree and <= ${currentContext.oppositeCount} oppose`
            );
        }

        const bucketLabel = this.getConsensusBucket(currentContext.sameCount, currentContext.sameCount).label;
        const bucketDirectional = samples.filter((sample) =>
            sample.direction === direction &&
            this.getConsensusBucket(sample.sameCount, currentContext.sameCount).label === bucketLabel
        );
        if (bucketDirectional.length >= minSamples) {
            return this.summarizeLiveContextOdds(
                bucketDirectional,
                `${direction.toUpperCase()} trades in ${bucketLabel}`
            );
        }

        const bucketAll = samples.filter((sample) =>
            this.getConsensusBucket(sample.sameCount, currentContext.sameCount).label === bucketLabel
        );
        if (bucketAll.length >= minSamples) {
            return this.summarizeLiveContextOdds(bucketAll, `All ${bucketLabel} trades`);
        }

        return null;
    }

    private summarizeLiveContextOdds(samples: ConsensusTradeSample[], label: string): LiveContextOdds {
        const wins = samples.filter((sample) => sample.isWin).length;
        return {
            sampleCount: samples.length,
            winRate: (wins / samples.length) * 100,
            lossRate: ((samples.length - wins) / samples.length) * 100,
            expectancy: samples.reduce((sum, sample) => sum + sample.pnl, 0) / samples.length,
            label,
        };
    }

    private buildSizingScenarios(
        context: PortfolioRunContext,
        _rows: PairAnalysisRow[],
        minAgree: number,
        maxOppose: number
    ): SizingScenarioRow[] {
        const targetArtifacts = context.runCache.get(context.benchmarkSymbol);
        if (!targetArtifacts) {
            return [];
        }

        const signalContexts = this.buildSignalContexts(
            context.benchmarkSymbol,
            targetArtifacts,
            context.runCache,
            context.lagBars
        );
        const tradeContextByKey = new Map<string, SignalContext>();
        for (const trade of targetArtifacts.result.trades) {
            const signalType: Signal["type"] = trade.type === "long" ? "buy" : "sell";
            const contextKey = this.buildSignalContextKey(timeKey(trade.entryTime), signalType);
            const signalContext = signalContexts.get(contextKey);
            if (signalContext) {
                tradeContextByKey.set(`${timeKey(trade.entryTime)}|${trade.type}`, signalContext);
            }
        }

        const scenarios: Array<{ name: string; description: string; getMultiplier: (context: SignalContext | null) => number }> = [
            {
                name: "Base",
                description: "Current position sizing on every trade.",
                getMultiplier: () => 1,
            },
            {
                name: "Conflict Trim",
                description: `Cut size when opposition exceeds ${maxOppose}, keep normal size otherwise.`,
                getMultiplier: (signalContext) => {
                    if (!signalContext) return 1;
                    return signalContext.oppositeCount > maxOppose ? 0.45 : 1;
                },
            },
            {
                name: "Breadth Tilt",
                description: `Keep all trades, but reduce size below ${minAgree} agreement and stay full size on strong breadth.`,
                getMultiplier: (signalContext) => {
                    if (!signalContext) return 1;
                    return signalContext.sameCount >= minAgree ? 1 : 0.6;
                },
            },
            {
                name: "Clean Context",
                description: `Full size only when agree >= ${minAgree} and oppose <= ${maxOppose}; otherwise trade smaller.`,
                getMultiplier: (signalContext) => {
                    if (!signalContext) return 1;
                    if (signalContext.sameCount >= minAgree && signalContext.oppositeCount <= maxOppose) {
                        return 1;
                    }
                    if (signalContext.sameCount >= Math.max(1, minAgree - 1)) {
                        return 0.65;
                    }
                    return 0.35;
                },
            },
        ];

        return scenarios.map((scenario) => ({
            name: scenario.name,
            description: scenario.description,
            result: this.simulateScenario(
                targetArtifacts.result,
                tradeContextByKey,
                scenario.getMultiplier,
                context.capitalSettings
            ),
        }));
    }

    private simulateScenario(
        result: BacktestResult,
        tradeContexts: Map<string, SignalContext>,
        getMultiplier: (context: SignalContext | null) => number,
        capitalSettings: ReturnType<typeof backtestService.getCapitalSettings>
    ): ScenarioSummary {
        let capital = Math.max(0, capitalSettings.initialCapital);
        let peak = capital;
        let maxDrawdownPercent = 0;
        let totalProfit = 0;
        let totalLoss = 0;
        let wins = 0;
        let multiplierSum = 0;

        for (const trade of result.trades) {
            const context = tradeContexts.get(`${timeKey(trade.entryTime)}|${trade.type}`) ?? null;
            const multiplier = Math.max(0, getMultiplier(context));
            multiplierSum += multiplier;

            const baseEntryValue = trade.size * trade.entryPrice;
            const tradeReturn = baseEntryValue > 0 ? trade.pnl / baseEntryValue : 0;
            const baseAllocation = capitalSettings.sizingMode === "fixed" && capitalSettings.fixedTradeAmount > 0
                ? capitalSettings.fixedTradeAmount
                : capital * (capitalSettings.positionSize / 100);
            const allocatedCapital = Math.min(capital, Math.max(0, baseAllocation * multiplier));
            const pnl = allocatedCapital * tradeReturn;

            capital += pnl;
            if (pnl > 0) {
                totalProfit += pnl;
                wins += 1;
            } else if (pnl < 0) {
                totalLoss += Math.abs(pnl);
            }

            peak = Math.max(peak, capital);
            if (peak > 0) {
                maxDrawdownPercent = Math.max(maxDrawdownPercent, ((peak - capital) / peak) * 100);
            }
        }

        const tradeCount = result.trades.length;
        const netProfit = capital - capitalSettings.initialCapital;

        return {
            totalTrades: tradeCount,
            winRate: tradeCount > 0 ? (wins / tradeCount) * 100 : 0,
            netProfitPercent: capitalSettings.initialCapital > 0 ? (netProfit / capitalSettings.initialCapital) * 100 : 0,
            expectancy: tradeCount > 0 ? netProfit / tradeCount : 0,
            profitFactor: totalLoss === 0 ? (totalProfit > 0 ? Infinity : 0) : totalProfit / totalLoss,
            maxDrawdownPercent,
            avgMultiplier: tradeCount > 0 ? multiplierSum / tradeCount : 0,
        };
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
