import { ensureStrategyKeysLoaded, strategyRegistry } from "../strategyRegistry";
import { backtestService } from "./backtest-service";
import { ensureConfirmationStrategiesLoaded } from "./confirmation-signal-filter";
import { buildPreparedSignalsForEnsembleRecipe } from "./ensemble-signal-recipes";
import {
    settingsManager,
    type EnsembleSignalRecipe,
    type StrategyConfig,
} from "./settings-manager";
import { state } from "./state";
import { clearBacktestResults, commitBacktestResult } from "./state-actions";
import { type OHLCVData, type Signal } from "./strategies";
import { setActiveBacktestRerunContext } from "./backtest-rerun-context";
import { uiManager } from "./ui-manager";
import { strategyPanelController } from "./strategy-panel-controller";
import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";
import type { BacktestResult } from "./types/strategies";
import { formatJakartaTime } from "./timezone-utils";
import type {
    EnsemblePolymarketVetoPairResult,
    EnsemblePolymarketOverridePairResult,
} from "./strategy-ensemble-polymarket-engine";
import type { EnsembleLabDom } from "./strategy-ensemble-dom";

interface StrategyEnsembleRecipeRunnerDeps {
    getDom: () => EnsembleLabDom;
    updateStatus: (message: string) => void;
    updateSignalRecipeStatus: (message: string) => void;
    updatePolymarketStatus: (message: string) => void;
    prepareCandles: () => OHLCVData[];
    buildSelectedPolicyRecipeFromCurrentRun: () => EnsembleSignalRecipe;
    buildBestVetoRecipeFromCurrentRun: () => EnsembleSignalRecipe;
    buildVetoRecipeFromPair: (pair: EnsemblePolymarketVetoPairResult) => EnsembleSignalRecipe;
    buildOverrideRecipeFromPair: (pair: EnsemblePolymarketOverridePairResult) => EnsembleSignalRecipe;
    attachPolymarketOutcomesToBacktestResult: (result: BacktestResult, outcomes: readonly PolymarketOutcomeRow[], interval?: string) => BacktestResult;
    getLastPolymarketOutcomes: () => readonly PolymarketOutcomeRow[];
    cloneStrategyConfigSnapshot: (config: StrategyConfig) => StrategyConfig;
    syncSavedSignalRecipeOptions: (preferredName?: string) => void;
    describeRecipeMode: (mode: EnsembleSignalRecipe["mode"]) => string;
    formatPreviewExecutionSettings: (config: StrategyConfig) => string;
}

export class StrategyEnsembleRecipeRunner {
    constructor(private readonly deps: StrategyEnsembleRecipeRunnerDeps) {}

    public async loadRecipeBacktest(recipe: EnsembleSignalRecipe, successMessage: string): Promise<void> {
        await this.loadRecipeBacktestWithOptions(recipe, successMessage, {
            snapshotModeLabel: "Rebuilt Recipe Snapshot",
            freezeInstruction: "Frozen to the candle snapshot used when you loaded this preview. Rerun Ensemble Polymarket if you want it rebuilt on fresh candles.",
        });
    }

    public async loadRecipeBacktestWithOptions(
        recipe: EnsembleSignalRecipe,
        successMessage: string,
        options?: {
            overridePreparedSignals?: (candles: OHLCVData[]) => Signal[];
            overrideDescription?: string;
            registerRerun?: boolean;
            silent?: boolean;
            snapshotModeLabel?: string;
            freezeInstruction?: string;
        }
    ): Promise<void> {
        if (recipe.symbol !== state.currentSymbol || recipe.interval !== state.currentInterval) {
            throw new Error(`Recipe ${recipe.name} is pinned to ${recipe.symbol} ${recipe.interval}. Switch the chart to that market first.`);
        }

        const candles = this.deps.prepareCandles();
        if (candles.length < 2) {
            throw new Error("Not enough closed candle data loaded to preview this recipe.");
        }

        await this.ensureRecipeStrategiesLoaded(recipe);

        const resolved = buildPreparedSignalsForEnsembleRecipe({
            recipe,
            candles,
            getStrategy: (strategyKey) => strategyRegistry.get(strategyKey),
        });
        const overridePreparedSignals = options?.overridePreparedSignals?.(candles) ?? [];
        const preparedSignals = overridePreparedSignals.length > 0
            ? overridePreparedSignals
            : resolved.preparedSignals;
        if (preparedSignals.length === 0) {
            throw new Error(`Recipe ${recipe.name} produced no prepared signals on the current chart window.`);
        }

        clearBacktestResults("ensemble_recipe_preview_reset");
        await settingsManager.applyStrategyConfig(resolved.anchorConfig);
        const preview = await backtestService.evaluateSignalsOnData(
            candles,
            recipe.interval,
            preparedSignals,
            resolved.anchorBacktestSettings,
            settingsManager.resolveCapitalFromConfig(resolved.anchorConfig)
        );
        const previewResult = this.deps.attachPolymarketOutcomesToBacktestResult(
            preview.result,
            this.deps.getLastPolymarketOutcomes(),
            recipe.interval
        );
        commitBacktestResult(previewResult, "ensemble_preview", {
            reason: "ensemble_signal_recipe_preview",
        });
        const snapshotStatus = this.buildPreviewSnapshotStatus({
            recipe,
            anchorConfig: resolved.anchorConfig,
            candles,
            totalTrades: previewResult.totalTrades,
            snapshotModeLabel: options?.snapshotModeLabel ?? "Rebuilt Recipe Snapshot",
            freezeInstruction: options?.freezeInstruction ?? "Frozen to the candle snapshot used when you loaded this preview.",
        });
        const frozenPreviewResult = previewResult;
        const frozenAnchorConfig = this.deps.cloneStrategyConfigSnapshot(resolved.anchorConfig);
        if (options?.registerRerun !== false) {
            setActiveBacktestRerunContext({
                source: "ensemble_preview",
                label: recipe.name,
                rerun: async () => {
                    clearBacktestResults("ensemble_recipe_preview_rerun_reset");
                    await settingsManager.applyStrategyConfig(frozenAnchorConfig);
                    commitBacktestResult(frozenPreviewResult, "ensemble_preview", {
                        reason: "ensemble_signal_recipe_preview_rerun",
                    });
                    this.deps.updateStatus(`Refreshed frozen ensemble preview: ${recipe.name}.`);
                    this.deps.updatePolymarketStatus(`Refreshed frozen ensemble preview: ${recipe.name}.`);
                    this.deps.updateSignalRecipeStatus(snapshotStatus);
                },
            });
        }

        this.deps.updateStatus(successMessage);
        this.deps.updatePolymarketStatus(successMessage);
        this.deps.updateSignalRecipeStatus(snapshotStatus);
        strategyPanelController.switchTab("results");
        if (!options?.silent) {
            uiManager.showToast(successMessage, "success");
        }
    }

    private async ensureRecipeStrategiesLoaded(recipe: EnsembleSignalRecipe): Promise<void> {
        const strategyKeys = [
            recipe.anchorConfig.strategyKey,
            ...recipe.componentConfigs.map((config) => config.strategyKey),
        ];
        await ensureStrategyKeysLoaded(strategyKeys);
        await Promise.all([
            recipe.anchorConfig,
            ...recipe.componentConfigs,
        ].map((config) => ensureConfirmationStrategiesLoaded(config.backtestSettings)));
    }

    private async loadConflictFilterRecipePreview(
        recipe: EnsembleSignalRecipe,
        options?: { silent?: boolean }
    ): Promise<void> {
        await this.loadRecipeBacktestWithOptions(
            recipe,
            `Loaded target-anchored conflict-filter overlay preview from ${recipe.anchorConfigName}.`,
            {
                silent: options?.silent,
                snapshotModeLabel: "Rebuilt Target-Anchored Recipe Snapshot",
                freezeInstruction: "Frozen to the candle snapshot used when you loaded this target-anchored conflict-filter preview. Rerun Ensemble Polymarket if you want it rebuilt on fresh candles.",
            }
        );
    }

    public async loadConflictFilterBacktest(): Promise<void> {
        try {
            const recipe = this.deps.buildSelectedPolicyRecipeFromCurrentRun();
            if (recipe.mode === "target_conflict_filter") {
                await this.loadConflictFilterRecipePreview(recipe);
            } else {
                await this.loadRecipeBacktest(
                    recipe,
                    `Loaded ${this.deps.describeRecipeMode(recipe.mode).toLowerCase()} backtest preview from ${recipe.anchorConfigName}.`
                );
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.deps.updatePolymarketStatus(message);
            this.deps.updateSignalRecipeStatus(message);
            uiManager.showToast(message, "error");
        }
    }

    public async loadBestVetoBacktest(): Promise<void> {
        try {
            const recipe = this.deps.buildBestVetoRecipeFromCurrentRun();
            await this.loadRecipeBacktest(
                recipe,
                `Loaded primary-veto backtest preview from ${recipe.anchorConfigName}.`
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.deps.updatePolymarketStatus(message);
            this.deps.updateSignalRecipeStatus(message);
            uiManager.showToast(message, "error");
        }
    }

    public saveConflictFilterRecipe(): void {
        try {
            const persisted = settingsManager.upsertEnsembleSignalRecipe(this.deps.buildSelectedPolicyRecipeFromCurrentRun());
            this.deps.syncSavedSignalRecipeOptions(persisted.name);
            this.deps.updateSignalRecipeStatus(`Saved ${this.deps.describeRecipeMode(persisted.mode).toLowerCase()} recipe: ${persisted.name}.`);
            uiManager.showToast(`Saved recipe: ${persisted.name}`, "success");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.deps.updateSignalRecipeStatus(message);
            uiManager.showToast(message, "error");
        }
    }

    public saveBestVetoRecipe(): void {
        try {
            const persisted = settingsManager.upsertEnsembleSignalRecipe(this.deps.buildBestVetoRecipeFromCurrentRun());
            this.deps.syncSavedSignalRecipeOptions(persisted.name);
            this.deps.updateSignalRecipeStatus(`Saved best-veto recipe: ${persisted.name}.`);
            uiManager.showToast(`Saved recipe: ${persisted.name}`, "success");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.deps.updateSignalRecipeStatus(message);
            uiManager.showToast(message, "error");
        }
    }

    private buildPreviewSnapshotStatus(args: {
        recipe: EnsembleSignalRecipe;
        anchorConfig: StrategyConfig;
        candles: readonly OHLCVData[];
        totalTrades: number;
        snapshotModeLabel: string;
        freezeInstruction: string;
    }): string {
        const lastCandle = args.candles[args.candles.length - 1] ?? null;
        const lastCandleLabel = lastCandle
            ? formatJakartaTime(lastCandle.time, {
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
            })
            : "n/a";

        return [
            args.recipe.name,
            args.snapshotModeLabel,
            `${args.recipe.symbol} ${args.recipe.interval}`,
            this.deps.formatPreviewExecutionSettings(args.anchorConfig),
            `${args.candles.length} candles`,
            `last candle ${lastCandleLabel}`,
            `${args.totalTrades} backtest trade${args.totalTrades === 1 ? "" : "s"}`,
            args.freezeInstruction,
        ].join(" | ");
    }
}
