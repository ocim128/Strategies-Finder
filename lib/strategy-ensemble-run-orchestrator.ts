import { settingsManager } from "./settings-manager";
import {
    buildSignalArtifact,
    countDistinctFamilies,
    runConfig,
    runFilteredBacktest,
    type StrategyEnsembleEngineDeps,
} from "./strategy-ensemble-engine";
import { buildLiveContext, resolveCurrentContextReference } from "./strategy-ensemble-live-context";
import {
    buildContributionRows,
    buildReplacementRows,
    evaluateScenario,
    type StrategyEnsembleRulesRuntime,
} from "./strategy-ensemble-rules";
import {
    renderStrategyEnsembleResults,
    resetStrategyEnsembleResultPanels,
} from "./strategy-ensemble-renderer";
import type {
    ConfigRunArtifact,
    ConfigSignalArtifact,
    EnsembleRunContext,
} from "./strategy-ensemble-types";
import type { OHLCVData } from "./strategies";
import { ensureStrategyKeysLoaded, strategyRegistry } from "../strategyRegistry";
import { backtestService } from "./backtest-service";
import { debugLogger } from "./debug-logger";
import { sliceOhlcvByBlock } from "./block-selector";
import { trimToClosedCandles } from "./closed-candle-utils";
import { state } from "./state";
import type { EnsembleLabDom } from "./strategy-ensemble-dom";

export interface EnsembleRunOrchestratorConfig {
    maxRuleValidationCandidates: number;
    maxRuleBuilderRows: number;
    maxReplacementRows: number;
}

export interface EnsembleRunOrchestratorDeps {
    getDom: () => EnsembleLabDom;
    updateStatus: (message: string) => void;
    yieldToUi: () => Promise<void>;
    getSelectedTargetName: () => string;
    getSelectedContextNames: () => string[];
    readMinSamples: () => number;
    showToast: (message: string, type: 'success' | 'error' | 'info' | 'warning') => void;
}

export class EnsembleRunOrchestrator {
    public runContext: EnsembleRunContext | null = null;

    private readonly deps: EnsembleRunOrchestratorDeps;
    private readonly config: EnsembleRunOrchestratorConfig;

    constructor(deps: EnsembleRunOrchestratorDeps, config: EnsembleRunOrchestratorConfig) {
        this.deps = deps;
        this.config = config;
    }

    prepareCandles(): OHLCVData[] {
        if (state.ohlcvData.length < 2) {
            return [];
        }
        return sliceOhlcvByBlock(trimToClosedCandles(state.ohlcvData, state.currentInterval), state.blockRange);
    }

    buildEngineDeps(): StrategyEnsembleEngineDeps {
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

    buildRulesRuntime(engineDeps: StrategyEnsembleEngineDeps): StrategyEnsembleRulesRuntime {
        return {
            runFilteredBacktest: (targetArtifact, signals, candles) =>
                runFilteredBacktest(targetArtifact, signals, candles, engineDeps),
            yieldToUi: () => this.deps.yieldToUi(),
            updateStatus: (message) => this.deps.updateStatus(message),
            maxRuleValidationCandidates: this.config.maxRuleValidationCandidates,
            maxRuleBuilderRows: this.config.maxRuleBuilderRows,
            maxReplacementRows: this.config.maxReplacementRows,
        };
    }

    private async ensureConfigStrategiesLoaded(configNames: readonly string[]): Promise<void> {
        const strategyKeys = configNames
            .map((configName) => settingsManager.loadStrategyConfig(configName)?.strategyKey ?? "")
            .filter((key) => key.length > 0);
        await ensureStrategyKeysLoaded(strategyKeys);
    }

    async run(): Promise<void> {
        const dom = this.deps.getDom();
        const targetName = this.deps.getSelectedTargetName();

        if (!targetName) {
            this.deps.showToast("Select a target config first.", "error");
            this.deps.updateStatus("Select a target config first.");
            return;
        }

        const contextNames = this.deps.getSelectedContextNames();
        if (contextNames.length === 0) {
            this.deps.showToast("Select at least one context config.", "error");
            this.deps.updateStatus("Select at least one context config.");
            return;
        }

        const candles = this.prepareCandles();
        if (candles.length < 50) {
            this.deps.showToast("Not enough closed candle data loaded. Load more data first.", "error");
            this.deps.updateStatus("Not enough closed candle data to run Strategy Ensemble Lab.");
            return;
        }

        const minSamples = this.deps.readMinSamples();
        const allConfigs = settingsManager.loadAllStrategyConfigs();
        const selectedConfigNames = [targetName, ...contextNames];
        const candidateConfigNames = allConfigs
            .map((config) => config.name)
            .filter((name) => !selectedConfigNames.includes(name));
        await this.ensureConfigStrategiesLoaded([...selectedConfigNames, ...candidateConfigNames]);
        const artifacts = new Map<string, ConfigRunArtifact>();
        const candidateArtifacts = new Map<string, ConfigSignalArtifact>();
        const engineDeps = this.buildEngineDeps();
        const rulesRuntime = this.buildRulesRuntime(engineDeps);

        dom.ensembleRunBtn.disabled = true;
        dom.ensembleRunBtn.setAttribute("aria-busy", "true");
        this.deps.updateStatus(`Running ${selectedConfigNames.length} selected configs on ${state.currentSymbol} (${state.currentInterval})...`);

        try {
            for (let index = 0; index < selectedConfigNames.length; index += 1) {
                const configName = selectedConfigNames[index];
                this.deps.updateStatus(`Running selected config ${configName} (${index + 1}/${selectedConfigNames.length})...`);
                const artifact = await runConfig(configName, candles, engineDeps);
                if (artifact) {
                    artifacts.set(configName, artifact);
                }
                await this.deps.yieldToUi();
            }

            for (let index = 0; index < candidateConfigNames.length; index += 1) {
                const configName = candidateConfigNames[index];
                this.deps.updateStatus(`Preparing replacement candidate ${configName} (${index + 1}/${candidateConfigNames.length})...`);
                const artifact = await buildSignalArtifact(configName, candles, engineDeps);
                if (artifact) {
                    candidateArtifacts.set(configName, artifact);
                }
                await this.deps.yieldToUi();
            }

            const targetArtifact = artifacts.get(targetName);
            if (!targetArtifact) {
                throw new Error(`Target config "${targetName}" could not be evaluated.`);
            }

            const contextArtifacts = contextNames
                .map((name) => artifacts.get(name) ?? null)
                .filter((artifact): artifact is ConfigRunArtifact => artifact !== null);

            if (contextArtifacts.length === 0) {
                throw new Error("No context configs could be evaluated.");
            }

            const contextFamilyCount = countDistinctFamilies(contextArtifacts);
            this.deps.updateStatus("Evaluating ensemble rule candidates...");
            const scenario = await evaluateScenario(targetArtifact, contextArtifacts, candles, minSamples, rulesRuntime);
            this.deps.updateStatus("Scoring leave-one-out context contribution...");
            const currentContextReference = resolveCurrentContextReference(targetArtifact, candles);
            const contributionRows = await buildContributionRows(
                targetArtifact,
                contextArtifacts,
                scenario,
                currentContextReference,
                rulesRuntime
            );
            this.deps.updateStatus("Ranking replacement candidates...");
            const replacementRows = await buildReplacementRows(
                targetArtifact,
                contextArtifacts,
                scenario,
                contributionRows,
                currentContextReference,
                Array.from(candidateArtifacts.values()),
                rulesRuntime
            );
            const liveContext = buildLiveContext(
                targetArtifact,
                contextArtifacts,
                candles,
                scenario.tradeSamples,
                minSamples
            );

            const runContext: EnsembleRunContext = {
                targetConfigName: targetName,
                contextConfigNames: contextArtifacts.map((artifact) => artifact.config.name),
                contextFamilyCount,
                symbol: state.currentSymbol,
                interval: state.currentInterval,
                candles,
                artifacts,
                targetArtifact,
                tradeSamples: scenario.tradeSamples,
                buckets: scenario.buckets,
                baselineBucket: scenario.baselineBucket,
                bestBucket: scenario.bestBucket,
                bestLongBucket: scenario.bestLongBucket,
                bestShortBucket: scenario.bestShortBucket,
                builderRows: scenario.builderRows,
                builderPreviewByRuleId: scenario.builderPreviewByRuleId,
                selectedRule: scenario.selectedRule,
                liveContext,
                minSamples,
                contributionRows,
                replacementRows,
            };
            this.runContext = runContext;

            renderStrategyEnsembleResults(this.deps.getDom(), runContext);
            this.deps.updateStatus(
                `Strategy Ensemble Lab ready. ${scenario.tradeSamples.length} target trades analyzed across ${contextArtifacts.length} context configs in ${contextFamilyCount} families.`
            );
            this.deps.showToast("Strategy Ensemble Lab complete.", "success");
        } catch (error) {
            this.runContext = null;
            debugLogger.error("[StrategyEnsembleLab] Run failed", {
                error: error instanceof Error ? error.message : String(error),
            });
            this.deps.showToast(
                `Strategy Ensemble Lab failed: ${error instanceof Error ? error.message : String(error)}`,
                "error"
            );
            this.deps.updateStatus("Strategy Ensemble Lab failed. Check console for details.");
            resetStrategyEnsembleResultPanels(this.deps.getDom());
        } finally {
            dom.ensembleRunBtn.disabled = false;
            dom.ensembleRunBtn.setAttribute("aria-busy", "false");
        }
    }
}
