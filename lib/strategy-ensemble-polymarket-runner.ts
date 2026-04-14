import { ensureStrategyKeysLoaded, strategyRegistry } from "../strategyRegistry";
import { backtestService } from "./backtest-service";
import { type EnsembleLabDom } from "./strategy-ensemble-dom";
import {
    runEnsemblePolymarket,
    type EnsemblePolymarketConflictPolicy,
    type EnsemblePolymarketDirectionSlice,
    type EnsemblePolymarketOverridePairResult,
    type EnsemblePolymarketRunResult,
    type EnsemblePolymarketVetoPairResult,
} from "./strategy-ensemble-polymarket-engine";
import {
    getPolymarket5mSeriesIdForSymbol,
    getSupportedPolymarket5mSymbolsLabel,
    isSupportedPolymarket5mRun,
    loadPolymarket5mOutcomesForChart,
} from "./polymarket-btc5m";
import {
    renderEnsemblePolymarketResults,
    resetEnsemblePolymarketPanel,
} from "./strategy-ensemble-polymarket-renderer";
import {
    settingsManager,
    type EnsembleSignalRecipe,
    type StrategyConfig,
} from "./settings-manager";
import { state } from "./state";
import { clearBacktestResults, commitBacktestResult } from "./state-actions";
import { type OHLCVData } from "./strategies";
import { setActiveBacktestRerunContext } from "./backtest-rerun-context";
import { uiManager } from "./ui-manager";
import { debugLogger } from "./debug-logger";
import { strategyPanelController } from "./strategy-panel-controller";
import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";
import {
    annotateTradesWithPolymarketOutcomesForRun,
    summarizePolymarketTradesForRun,
} from "./polymarket-trade-annotations";
import type { BacktestResult } from "./types/strategies";
import { runConfig, type StrategyEnsembleEngineDeps } from "./strategy-ensemble-engine";

export interface StrategyEnsemblePolymarketRunnerDeps {
    getDom: () => EnsembleLabDom;
    updateStatus: (msg: string) => void;
    updatePolymarketStatus: (msg: string) => void;
    syncPolymarketAvailability: () => void;
    syncSavedSignalRecipeOptions: () => void;
    syncSavedSignalRecipeControls: () => void;
    getSelectedTargetName: () => string | null;
    getSelectedContextNames: () => string[];
    prepareCandles: () => OHLCVData[];
    invalidateRunContext: (msg: string) => void;
    cloneStrategyConfigSnapshot: (config: StrategyConfig) => StrategyConfig;
    buildVetoRecipeFromPair: (pair: EnsemblePolymarketVetoPairResult) => EnsembleSignalRecipe;
    buildOverrideRecipeFromPair: (pair: EnsemblePolymarketOverridePairResult) => EnsembleSignalRecipe;
    loadRecipeBacktest: (recipe: EnsembleSignalRecipe, successMessage: string) => Promise<void>;
}

export class StrategyEnsemblePolymarketRunner {
    private _lastPolymarketRunResult: EnsemblePolymarketRunResult | null = null;
    private _lastPolymarketSelection: {
        targetName: string;
        contextNames: string[];
        symbol: string;
        interval: string;
    } | null = null;
    private _lastPolymarketOutcomes: PolymarketOutcomeRow[] = [];
    private deps: StrategyEnsemblePolymarketRunnerDeps;

    constructor(deps: StrategyEnsemblePolymarketRunnerDeps) {
        this.deps = deps;
    }

    get lastPolymarketRunResult(): EnsemblePolymarketRunResult | null {
        return this._lastPolymarketRunResult;
    }

    get lastPolymarketSelection(): {
        targetName: string;
        contextNames: string[];
        symbol: string;
        interval: string;
    } | null {
        return this._lastPolymarketSelection;
    }

    get lastPolymarketOutcomes(): PolymarketOutcomeRow[] {
        return this._lastPolymarketOutcomes;
    }

    clearState(): void {
        this._lastPolymarketRunResult = null;
        this._lastPolymarketSelection = null;
        this._lastPolymarketOutcomes = [];
    }

    getSelectedPolymarketConflictPolicy(): EnsemblePolymarketConflictPolicy {
        const value = this.deps.getDom().ensemblePolymarketConflictPolicy.value;
        return value === "primary_veto"
            || value === "secondary_override"
            || value === "best_side_owner"
            || value === "skip_conflicts"
            ? value
            : "skip_conflicts";
    }

    getSelectedPolymarketDirectionSlice(): EnsemblePolymarketDirectionSlice {
        const value = this.deps.getDom().ensemblePolymarketDirectionSlice.value;
        return value === "long_only" || value === "short_only" || value === "all"
            ? value
            : "all";
    }

    getSelectedPolymarketPolicyResult(): EnsemblePolymarketRunResult["selectedPolicyResult"] {
        const runResult = this._lastPolymarketRunResult;
        if (!runResult) {
            return null;
        }

        switch (this.getSelectedPolymarketConflictPolicy()) {
            case "primary_veto":
                return runResult.policyResults.primaryVeto;
            case "secondary_override":
                return runResult.policyResults.secondaryOverride;
            case "best_side_owner":
                return runResult.policyResults.bestSideOwner;
            case "skip_conflicts":
            default:
                return runResult.policyResults.skipConflicts;
        }
    }

    requirePolymarketRunContext(usage: string): {
        runResult: EnsemblePolymarketRunResult;
        selection: { targetName: string; contextNames: string[]; symbol: string; interval: string };
        outcomes: readonly PolymarketOutcomeRow[];
    } {
        if (!this._lastPolymarketRunResult || !this._lastPolymarketSelection) {
            throw new Error(`Run Ensemble Polymarket first before ${usage}.`);
        }

        return {
            runResult: this._lastPolymarketRunResult,
            selection: this._lastPolymarketSelection,
            outcomes: this._lastPolymarketOutcomes,
        };
    }

    public attachPolymarketOutcomesToBacktestResult(
        result: BacktestResult,
        outcomes: readonly PolymarketOutcomeRow[],
        interval = state.currentInterval
    ): BacktestResult {
        if (outcomes.length === 0) {
            return result;
        }

        const annotatedTrades = annotateTradesWithPolymarketOutcomesForRun(
            result.trades,
            outcomes,
            interval
        );
        const summary = summarizePolymarketTradesForRun({
            trades: result.trades,
            outcomes,
            interval,
        });
        const totalTrades = result.totalTrades > 0 ? result.totalTrades : result.trades.length;
        const existingSummary = result.polymarketTradeSummary;
        const symbol = state.currentSymbol;

        return {
            ...result,
            trades: annotatedTrades,
            polymarketTradeSummary: {
                seriesId: getPolymarket5mSeriesIdForSymbol(symbol) || outcomes[0]?.series_id || "",
                outcomeRowsLoaded: existingSummary?.outcomeRowsLoaded && existingSummary.outcomeRowsLoaded > 0
                    ? existingSummary.outcomeRowsLoaded
                    : outcomes.length,
                scoredTrades: existingSummary?.scoredTrades ?? summary.scoredTrades,
                missingOutcomeTrades: existingSummary?.missingOutcomeTrades ?? summary.missingOutcomeTrades,
                unscoredTrades: existingSummary?.unscoredTrades ?? summary.unscoredTrades ?? Math.max(0, totalTrades - summary.scoredTrades),
                duplicateTradesIgnored: existingSummary?.duplicateTradesIgnored ?? summary.duplicateTradesIgnored,
                entryOffset: existingSummary?.entryOffset ?? undefined,
                timingProfile: existingSummary?.timingProfile ?? summary.timingProfile,
                evaluationMode: "resolve_hold",
            },
        };
    }

    async loadPolymarketConfigBacktest(configName: string): Promise<void> {
        try {
            const { selection, outcomes } = this.requirePolymarketRunContext(`viewing ${configName}`);
            const allowedNames = new Set([selection.targetName, ...selection.contextNames]);
            if (!allowedNames.has(configName)) {
                throw new Error(`Config "${configName}" is not part of the current Ensemble Polymarket run.`);
            }

            const candles = this.deps.prepareCandles();
            if (candles.length < 2) {
                throw new Error("Not enough closed candle data loaded to preview this config.");
            }

            await this.ensureConfigStrategiesLoaded([configName]);

            const artifact = await runConfig(configName, candles, this.buildEngineDeps());
            if (!artifact) {
                throw new Error(`Config "${configName}" could not be evaluated.`);
            }

            const previewResult = this.attachPolymarketOutcomesToBacktestResult(artifact.result, outcomes);
            clearBacktestResults("ensemble_polymarket_config_preview_reset");
            await settingsManager.applyStrategyConfig(artifact.config);
            commitBacktestResult(previewResult, "ensemble_preview", {
                reason: "ensemble_polymarket_config_preview",
            });
            const frozenPreviewResult = previewResult;
            const frozenConfig = this.deps.cloneStrategyConfigSnapshot(artifact.config);
            setActiveBacktestRerunContext({
                source: "ensemble_preview",
                label: `Ensemble Polymarket config: ${configName}`,
                rerun: async () => {
                    clearBacktestResults("ensemble_polymarket_config_preview_rerun_reset");
                    await settingsManager.applyStrategyConfig(frozenConfig);
                    commitBacktestResult(frozenPreviewResult, "ensemble_preview", {
                        reason: "ensemble_polymarket_config_preview_rerun",
                    });
                    this.deps.updatePolymarketStatus(`Refreshed frozen config preview: ${configName}.`);
                },
            });

            strategyPanelController.switchTab("results");
            this.deps.updatePolymarketStatus(`Viewing backtest for ${configName}. Loaded the frozen Polymarket-scored snapshot into Results and Trades.`);
            uiManager.showToast(`Viewing backtest: ${configName}`, "success");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.deps.updatePolymarketStatus(message);
            uiManager.showToast(message, "error");
        }
    }

    async loadPolymarketVetoPairBacktest(primaryConfigName: string, vetoConfigName: string): Promise<void> {
        try {
            const { runResult } = this.requirePolymarketRunContext(`viewing ${primaryConfigName} -> ${vetoConfigName}`);
            const pair = runResult.vetoScan.pairResults.find((candidate) =>
                candidate.primaryConfigName === primaryConfigName && candidate.vetoConfigName === vetoConfigName
            );
            if (!pair) {
                throw new Error(`Veto pair "${primaryConfigName} -> ${vetoConfigName}" is not part of the current run.`);
            }

            await this.deps.loadRecipeBacktest(
                this.deps.buildVetoRecipeFromPair(pair),
                `Viewing veto-pair backtest: ${primaryConfigName} -> ${vetoConfigName}.`
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.deps.updatePolymarketStatus(message);
            uiManager.showToast(message, "error");
        }
    }

    async loadPolymarketOverridePairBacktest(primaryConfigName: string, secondaryConfigName: string): Promise<void> {
        try {
            const { runResult } = this.requirePolymarketRunContext(`viewing ${primaryConfigName} -> ${secondaryConfigName}`);
            const pair = runResult.overrideScan.pairResults.find((candidate) =>
                candidate.primaryConfigName === primaryConfigName && candidate.secondaryConfigName === secondaryConfigName
            );
            if (!pair) {
                throw new Error(`Override pair "${primaryConfigName} -> ${secondaryConfigName}" is not part of the current run.`);
            }

            await this.deps.loadRecipeBacktest(
                this.deps.buildOverrideRecipeFromPair(pair),
                `Viewing override-pair backtest: ${primaryConfigName} -> ${secondaryConfigName}.`
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.deps.updatePolymarketStatus(message);
            uiManager.showToast(message, "error");
        }
    }

    async runPolymarket(): Promise<void> {
        const dom = this.deps.getDom();
        const targetName = this.deps.getSelectedTargetName();

        if (!targetName) {
            uiManager.showToast("Select a target config first.", "error");
            this.deps.updatePolymarketStatus("Select a target config first.");
            return;
        }

        const contextNames = this.deps.getSelectedContextNames();
        if (contextNames.length === 0) {
            uiManager.showToast("Select at least one context config.", "error");
            this.deps.updatePolymarketStatus("Select at least one context config.");
            return;
        }

        if (!isSupportedPolymarket5mRun(state.currentSymbol, state.currentInterval)) {
            const message = `Ensemble Polymarket currently supports ${getSupportedPolymarket5mSymbolsLabel()} on 5m.`;
            uiManager.showToast(message, "error");
            this.deps.updatePolymarketStatus(message);
            this.deps.syncPolymarketAvailability();
            return;
        }

        const candles = this.deps.prepareCandles();
        if (candles.length < 50) {
            uiManager.showToast("Not enough closed candle data loaded. Load more data first.", "error");
            this.deps.updatePolymarketStatus("Not enough closed candle data to run Ensemble Polymarket.");
            return;
        }

        const selectedConfigNames = [targetName, ...contextNames];
        await this.ensureConfigStrategiesLoaded(selectedConfigNames);
        const engineDeps = this.buildEngineDeps();
        const conflictPolicy = this.getSelectedPolymarketConflictPolicy();
        const directionSlice = this.getSelectedPolymarketDirectionSlice();

        dom.ensembleRunPolymarketBtn.disabled = true;
        dom.ensembleRunPolymarketBtn.setAttribute("aria-busy", "true");
        this.deps.updatePolymarketStatus(`Loading Polymarket outcomes for ${state.currentSymbol} (${state.currentInterval})...`);

        try {
            const outcomes = await loadPolymarket5mOutcomesForChart(state.currentSymbol, candles);
            const result = await runEnsemblePolymarket({
                targetName,
                contextNames,
                candles,
                symbol: state.currentSymbol,
                interval: state.currentInterval,
                outcomes,
                deps: engineDeps,
                conflictPolicy,
                directionSlice,
                onProgress: (message) => this.deps.updatePolymarketStatus(message),
            });

            this._lastPolymarketRunResult = result;
            this._lastPolymarketSelection = {
                targetName,
                contextNames: [...contextNames],
                symbol: state.currentSymbol,
                interval: state.currentInterval,
            };
            this._lastPolymarketOutcomes = [...outcomes];
            renderEnsemblePolymarketResults(dom, result);
            this.deps.updatePolymarketStatus(
                `Ensemble Polymarket ready. ${selectedConfigNames.length} configs scored on ${this.describePolymarketDirectionSlice(directionSlice)} with ${this.describePolymarketConflictPolicy(conflictPolicy)} selected.`
            );
            this.deps.syncSavedSignalRecipeControls();
            uiManager.showToast("Ensemble Polymarket complete.", "success");
        } catch (error) {
            this._lastPolymarketRunResult = null;
            this._lastPolymarketSelection = null;
            this._lastPolymarketOutcomes = [];
            debugLogger.error("[StrategyEnsembleLab][Polymarket] Run failed", {
                error: error instanceof Error ? error.message : String(error),
            });
            resetEnsemblePolymarketPanel(dom);
            this.deps.syncPolymarketAvailability();
            this.deps.syncSavedSignalRecipeControls();
            uiManager.showToast(
                `Ensemble Polymarket failed: ${error instanceof Error ? error.message : String(error)}`,
                "error"
            );
            this.deps.updatePolymarketStatus(
                `Ensemble Polymarket failed: ${error instanceof Error ? error.message : String(error)}`
            );
        } finally {
            dom.ensembleRunPolymarketBtn.setAttribute("aria-busy", "false");
            this.deps.syncPolymarketAvailability();
        }
    }

    private buildEngineDeps(): StrategyEnsembleEngineDeps {
        return {
            interval: state.currentInterval,
            loadStrategyConfig: (configName) => settingsManager.loadStrategyConfig(configName),
            getStrategy: (strategyKey) => strategyRegistry.get(strategyKey),
            resolveCapitalFromConfig: (config) => settingsManager.resolveCapitalFromConfig(config),
            evaluateStrategyOnData: (...args) => backtestService.evaluateStrategyOnData(...args),
            evaluateSignalsOnData: (...args) => backtestService.evaluateSignalsOnData(...args),
            warn: (message, details) => debugLogger.warn(message, details),
        };
    }

    private describePolymarketConflictPolicy(policy: EnsemblePolymarketConflictPolicy): string {
        switch (policy) {
            case "primary_veto":
                return "Primary + Secondary Veto";
            case "secondary_override":
                return "Secondary Override";
            case "best_side_owner":
                return "Best-Side Owner";
            case "skip_conflicts":
            default:
                return "Skip Conflicts";
        }
    }

    private describePolymarketDirectionSlice(directionSlice: EnsemblePolymarketDirectionSlice): string {
        switch (directionSlice) {
            case "long_only":
                return "Long Only";
            case "short_only":
                return "Short Only";
            case "all":
            default:
                return "All";
        }
    }

    private async ensureConfigStrategiesLoaded(configNames: readonly string[]): Promise<void> {
        const strategyKeys = configNames
            .map((configName) => settingsManager.loadStrategyConfig(configName)?.strategyKey ?? "")
            .filter((key) => key.length > 0);
        await ensureStrategyKeysLoaded(strategyKeys);
    }
}
