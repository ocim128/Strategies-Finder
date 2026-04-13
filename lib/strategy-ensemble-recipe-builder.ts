import { settingsManager, type EnsembleSignalRecipe, type StrategyConfig } from "./settings-manager";
import type {
    EnsemblePolymarketConflictPolicy,
    EnsemblePolymarketDirectionSlice,
    EnsemblePolymarketOverridePairResult,
    EnsemblePolymarketRunResult,
    EnsemblePolymarketVetoPairResult,
} from "./strategy-ensemble-polymarket-engine";
import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";

type PolymarketSelection = {
    targetName: string;
    contextNames: string[];
    symbol: string;
    interval: string;
};

export type RecipeBuilderDeps = {
    getLastPolymarketRunResult: () => EnsemblePolymarketRunResult | null;
    getLastPolymarketSelection: () => PolymarketSelection | null;
    requirePolymarketRunContext: (usage: string) => {
        runResult: EnsemblePolymarketRunResult;
        selection: PolymarketSelection;
        outcomes: readonly PolymarketOutcomeRow[];
    };
    describePolymarketDirectionSlice: (slice: EnsemblePolymarketDirectionSlice) => string;
    getSelectedPolymarketConflictPolicy: () => EnsemblePolymarketConflictPolicy;
};

export class StrategyEnsembleRecipeBuilder {
    private deps: RecipeBuilderDeps;

    constructor(deps: RecipeBuilderDeps) {
        this.deps = deps;
    }

    cloneStrategyConfigSnapshot(config: StrategyConfig): StrategyConfig {
        return {
            ...config,
            strategyParams: { ...config.strategyParams },
            backtestSettings: { ...config.backtestSettings },
        };
    }

    loadRequiredStrategyConfigSnapshot(configName: string, usage: string): StrategyConfig {
        const config = settingsManager.loadStrategyConfig(configName);
        if (!config) {
            throw new Error(`Saved config "${configName}" is no longer available for ${usage}.`);
        }
        return this.cloneStrategyConfigSnapshot(config);
    }

    buildUniqueSignalRecipeName(baseName: string): string {
        const existingNames = new Set(
            settingsManager.loadAllEnsembleSignalRecipes().map((recipe) => recipe.name)
        );

        if (!existingNames.has(baseName)) {
            return baseName;
        }

        let suffix = 2;
        let candidate = `${baseName} (${suffix})`;
        while (existingNames.has(candidate)) {
            suffix += 1;
            candidate = `${baseName} (${suffix})`;
        }
        return candidate;
    }

    buildRecipeMetricsFromPolicyResult(
        policyResult: NonNullable<EnsemblePolymarketRunResult["selectedPolicyResult"]>,
        overlapRate: number | null = null
    ): EnsembleSignalRecipe["metrics"] {
        return {
            keptTrades: policyResult.scoredTrades,
            wins: policyResult.wins,
            losses: policyResult.losses,
            winRate: policyResult.winRate,
            retentionRate: policyResult.retentionRate,
            coverage: policyResult.coverage,
            overlapRate,
            winRateLift: policyResult.deltaVsBaseline,
            wilsonLift: null,
        };
    }

    buildDirectionSliceRecipeSuffix(directionSlice: EnsemblePolymarketDirectionSlice): string {
        switch (directionSlice) {
            case "long_only":
                return " long";
            case "short_only":
                return " short";
            case "all":
            default:
                return "";
        }
    }

    buildConflictFilterRecipeFromCurrentRun(): EnsembleSignalRecipe {
        const runResult = this.deps.getLastPolymarketRunResult();
        const selection = this.deps.getLastPolymarketSelection();
        if (!runResult || !selection) {
            throw new Error("Run Ensemble Polymarket first.");
        }
        const policyResult = runResult.policyResults.skipConflicts;
        if (!policyResult) {
            throw new Error("The current run did not produce a skip-conflicts recipe.");
        }

        const targetConfig = this.loadRequiredStrategyConfigSnapshot(selection.targetName, "the conflict-filter recipe");
        const contextConfigs = selection.contextNames.map((name) =>
            this.loadRequiredStrategyConfigSnapshot(name, "the conflict-filter recipe")
        );
        const overlay = runResult.conflictFilteredOverlay;
        const nowIso = new Date().toISOString();
        const overlapRate = overlay.evaluatedEvents > 0
            ? overlay.eventsWithVotes / overlay.evaluatedEvents
            : null;

        return {
            name: this.buildUniqueSignalRecipeName(
                `${selection.symbol} ${selection.interval} conflict ${selection.targetName}${this.buildDirectionSliceRecipeSuffix(runResult.directionSlice)}`
            ),
            createdAt: nowIso,
            updatedAt: nowIso,
            source: "ensemble_polymarket",
            symbol: selection.symbol,
            interval: selection.interval,
            mode: "target_conflict_filter",
            directionSlice: runResult.directionSlice,
            anchorConfigName: targetConfig.name,
            anchorConfig: targetConfig,
            componentConfigs: [targetConfig, ...contextConfigs],
            notes: `Target-anchored conflict-filter overlay derived from ${selection.targetName} with ${contextConfigs.length} context config${contextConfigs.length === 1 ? "" : "s"} on the ${this.deps.describePolymarketDirectionSlice(runResult.directionSlice)} slice. This recipe replays the target config entries after removing bars where any selected context config fires the opposite side at the same event time.`,
            metrics: this.buildRecipeMetricsFromPolicyResult(policyResult, overlapRate),
        };
    }

    buildBestVetoRecipeFromCurrentRun(): EnsembleSignalRecipe {
        const { runResult } = this.deps.requirePolymarketRunContext("building the best-veto recipe");
        const bestPair = runResult.vetoScan.bestPair ?? null;
        if (!bestPair) {
            throw new Error("Run Ensemble Polymarket and produce a best veto pair first.");
        }

        return this.buildVetoRecipeFromPair(bestPair);
    }

    buildVetoRecipeFromPair(pair: EnsemblePolymarketVetoPairResult): EnsembleSignalRecipe {
        const { runResult, selection } = this.deps.requirePolymarketRunContext("building a veto-pair recipe");
        const primaryConfig = this.loadRequiredStrategyConfigSnapshot(pair.primaryConfigName, "the veto-pair recipe");
        const vetoConfig = this.loadRequiredStrategyConfigSnapshot(pair.vetoConfigName, "the veto-pair recipe");
        const nowIso = new Date().toISOString();

        return {
            name: this.buildUniqueSignalRecipeName(
                `${selection.symbol} ${selection.interval} veto ${pair.primaryConfigName} -> ${pair.vetoConfigName}${this.buildDirectionSliceRecipeSuffix(runResult.directionSlice)}`
            ),
            createdAt: nowIso,
            updatedAt: nowIso,
            source: "ensemble_polymarket",
            symbol: selection.symbol,
            interval: selection.interval,
            mode: "primary_veto",
            directionSlice: runResult.directionSlice,
            anchorConfigName: primaryConfig.name,
            anchorConfig: primaryConfig,
            componentConfigs: [primaryConfig, vetoConfig],
            primaryConfigName: primaryConfig.name,
            vetoConfigName: vetoConfig.name,
            notes: `Primary-veto recipe derived from ${pair.primaryConfigName} -> ${pair.vetoConfigName} on the ${this.deps.describePolymarketDirectionSlice(runResult.directionSlice)} slice. Trade ${primaryConfig.name}, but skip the event when ${vetoConfig.name} fires the opposite Polymarket side on the same event.`,
            metrics: {
                keptTrades: pair.keptEvents,
                wins: pair.keptWins,
                losses: pair.keptLosses,
                winRate: pair.postVetoWinRate,
                retentionRate: pair.retentionRate,
                coverage: null,
                overlapRate: pair.overlapRate,
                winRateLift: pair.winRateLift,
                wilsonLift: pair.wilsonLift,
            },
        };
    }

    buildSecondaryOverrideRecipeFromCurrentRun(): EnsembleSignalRecipe {
        const { runResult } = this.deps.requirePolymarketRunContext("building the best secondary-override recipe");
        const bestPair = runResult.overrideScan.bestPair ?? null;
        if (!bestPair) {
            throw new Error("Run Ensemble Polymarket and produce a best secondary-override pair first.");
        }

        return this.buildOverrideRecipeFromPair(bestPair);
    }

    buildOverrideRecipeFromPair(pair: EnsemblePolymarketOverridePairResult): EnsembleSignalRecipe {
        const { runResult, selection } = this.deps.requirePolymarketRunContext("building an override-pair recipe");
        const primaryConfig = this.loadRequiredStrategyConfigSnapshot(pair.primaryConfigName, "the override-pair recipe");
        const secondaryConfig = this.loadRequiredStrategyConfigSnapshot(pair.secondaryConfigName, "the override-pair recipe");
        const nowIso = new Date().toISOString();

        return {
            name: this.buildUniqueSignalRecipeName(
                `${selection.symbol} ${selection.interval} override ${pair.primaryConfigName} -> ${pair.secondaryConfigName}${this.buildDirectionSliceRecipeSuffix(runResult.directionSlice)}`
            ),
            createdAt: nowIso,
            updatedAt: nowIso,
            source: "ensemble_polymarket",
            symbol: selection.symbol,
            interval: selection.interval,
            mode: "secondary_override",
            directionSlice: runResult.directionSlice,
            anchorConfigName: primaryConfig.name,
            anchorConfig: primaryConfig,
            componentConfigs: [primaryConfig, secondaryConfig],
            primaryConfigName: primaryConfig.name,
            secondaryConfigName: secondaryConfig.name,
            notes: `Secondary-override recipe derived from ${pair.primaryConfigName} -> ${pair.secondaryConfigName} on the ${this.deps.describePolymarketDirectionSlice(runResult.directionSlice)} slice. Trade ${primaryConfig.name}, but when ${secondaryConfig.name} fires the opposite Polymarket side on the same event, force the secondary side instead.`,
            metrics: {
                keptTrades: pair.keptEvents,
                wins: pair.keptWins,
                losses: pair.keptLosses,
                winRate: pair.postOverrideWinRate,
                retentionRate: pair.retentionRate,
                coverage: null,
                overlapRate: pair.overlapRate,
                winRateLift: pair.winRateLift,
                wilsonLift: pair.wilsonLift,
            },
        };
    }

    buildBestSideOwnerRecipeFromCurrentRun(): EnsembleSignalRecipe {
        const runResult = this.deps.getLastPolymarketRunResult();
        const selection = this.deps.getLastPolymarketSelection();
        const policyResult = runResult?.policyResults.bestSideOwner ?? null;
        if (!runResult || !selection || !policyResult) {
            throw new Error("Run Ensemble Polymarket and produce a best-side-owner recipe first.");
        }

        const anchorConfig = this.loadRequiredStrategyConfigSnapshot(selection.targetName, "the best-side-owner recipe");
        const componentNames = new Set<string>([anchorConfig.name]);
        if (policyResult.longOwnerConfigName) {
            componentNames.add(policyResult.longOwnerConfigName);
        }
        if (policyResult.shortOwnerConfigName) {
            componentNames.add(policyResult.shortOwnerConfigName);
        }
        const componentConfigs = Array.from(componentNames).map((name) =>
            this.loadRequiredStrategyConfigSnapshot(name, "the best-side-owner recipe")
        );
        const nowIso = new Date().toISOString();
        const ownerLabel = [
            policyResult.longOwnerConfigName ? `long ${policyResult.longOwnerConfigName}` : "",
            policyResult.shortOwnerConfigName ? `short ${policyResult.shortOwnerConfigName}` : "",
        ].filter((part) => part.length > 0).join(" + ");

        return {
            name: this.buildUniqueSignalRecipeName(
                `${selection.symbol} ${selection.interval} owners ${ownerLabel || selection.targetName}${this.buildDirectionSliceRecipeSuffix(runResult.directionSlice)}`
            ),
            createdAt: nowIso,
            updatedAt: nowIso,
            source: "ensemble_polymarket",
            symbol: selection.symbol,
            interval: selection.interval,
            mode: "best_side_owner",
            directionSlice: runResult.directionSlice,
            anchorConfigName: anchorConfig.name,
            anchorConfig: anchorConfig,
            componentConfigs,
            longOwnerConfigName: policyResult.longOwnerConfigName,
            shortOwnerConfigName: policyResult.shortOwnerConfigName,
            notes: `Best-side-owner recipe on the ${this.deps.describePolymarketDirectionSlice(runResult.directionSlice)} slice. Replay uses ${anchorConfig.name} as the anchor execution profile while delegating long and short event ownership to the strongest saved configs discovered in the current run.`,
            metrics: this.buildRecipeMetricsFromPolicyResult(policyResult, null),
        };
    }

    buildSelectedPolicyRecipeFromCurrentRun(): EnsembleSignalRecipe {
        switch (this.deps.getSelectedPolymarketConflictPolicy()) {
            case "primary_veto":
                return this.buildBestVetoRecipeFromCurrentRun();
            case "secondary_override":
                return this.buildSecondaryOverrideRecipeFromCurrentRun();
            case "best_side_owner":
                return this.buildBestSideOwnerRecipeFromCurrentRun();
            case "skip_conflicts":
            default:
                return this.buildConflictFilterRecipeFromCurrentRun();
        }
    }
}
