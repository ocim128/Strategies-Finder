import { state } from "./state";
import {
    runMonteCarloSimulation,
    type MonteCarloProgress,
    type MonteCarloResult,
    type MonteCarloSettings,
} from "./strategies/monte-carlo/monte-carlo-engine";
import { createMonteCarloDom, type MonteCarloDomElements } from "./monte-carlo-dom";
import {
    renderMonteCarloResults,
    type MonteCarloMethodComparisonRow,
} from "./monte-carlo-renderer";

const MAX_SIMULATION_CAP = 10_000;
const MIN_SIMULATION_CAP = 250;
const TARGET_TOTAL_WORK_UNITS = 8_000_000;

interface ScenarioPlan {
    key: "sequence" | "bootstrap" | "combined";
    label: string;
    settings: MonteCarloSettings;
    isPrimary: boolean;
}

let dom: MonteCarloDomElements | null = null;
let isRunning = false;
let abortController: AbortController | null = null;
let initialized = false;

export function initMonteCarloService(): void {
    if (initialized) {
        return;
    }

    dom = createMonteCarloDom();
    if (!dom) {
        console.warn("Monte Carlo service: DOM elements not found. Tab may not be loaded yet.");
        return;
    }

    dom.runBtn.addEventListener("click", () => {
        void handleRun();
    });
    dom.cancelBtn.addEventListener("click", handleCancel);
    dom.preset500Btn.addEventListener("click", () => applyPreset(500));
    dom.preset2000Btn.addEventListener("click", () => applyPreset(2000));
    dom.preset5000Btn.addEventListener("click", () => applyPreset(5000));
    dom.sequenceToggle.addEventListener("change", refreshSimulationCapHint);
    dom.bootstrapToggle.addEventListener("change", refreshSimulationCapHint);

    window.addEventListener("strategy-panel:tab-change", (event: Event) => {
        const customEvent = event as CustomEvent<{ tabId: string }>;
        if (customEvent.detail?.tabId === "montecarlo") {
            refreshMonteCarloFromState();
        }
    });

    refreshSimulationCapHint();
    initialized = true;
}

async function handleRun(): Promise<void> {
    if (!dom || isRunning) {
        return;
    }

    const backtestResult = state.currentBacktestResult;
    if (!backtestResult) {
        dom.statusSpan.textContent = "Please run a backtest first";
        return;
    }

    const baseSettings = readSettingsFromDom();
    if (!baseSettings.enableSequenceRandomization && !baseSettings.enableBootstrap) {
        dom.statusSpan.textContent = "Enable sequence randomization or bootstrap resampling";
        return;
    }

    const scenarioCount = getScenarioCount(baseSettings);
    const safeCap = computeSafeSimulationCap(backtestResult.trades.length, scenarioCount);
    const requestedSimulations = baseSettings.simulations;
    const effectiveSimulations = Math.min(requestedSimulations, safeCap);

    if (requestedSimulations > safeCap) {
        baseSettings.simulations = effectiveSimulations;
        dom.statusSpan.textContent = `Requested ${requestedSimulations.toLocaleString()} sims; using safe cap ${safeCap.toLocaleString()} for this run`;
    }

    const scenarioPlans = buildScenarioPlans(baseSettings);
    if (scenarioPlans.length === 0) {
        dom.statusSpan.textContent = "No Monte Carlo scenarios are available for the selected settings";
        return;
    }

    isRunning = true;
    abortController = new AbortController();
    dom.runBtn.disabled = true;
    dom.cancelBtn.style.display = "inline-block";
    dom.spinner.style.display = "inline-block";
    dom.statusSpan.textContent = `Running 0/${(scenarioPlans.length * effectiveSimulations).toLocaleString()} simulations...`;

    try {
        const results: Array<{ plan: ScenarioPlan; result: MonteCarloResult }> = [];

        for (let scenarioIndex = 0; scenarioIndex < scenarioPlans.length; scenarioIndex++) {
            const plan = scenarioPlans[scenarioIndex];
            const result = await runMonteCarloSimulation(
                backtestResult,
                plan.settings,
                state.ohlcvData,
                undefined,
                {
                    signal: abortController.signal,
                    onProgress: (progress: MonteCarloProgress) => {
                        if (!dom) {
                            return;
                        }
                        dom.statusSpan.textContent = formatProgressStatus(plan.label, progress, scenarioIndex, scenarioPlans.length);
                    },
                },
            );
            results.push({ plan, result });
        }

        if (!dom) {
            return;
        }

        const primaryEntry = results.find((entry) => entry.plan.isPrimary) ?? results[results.length - 1];
        const comparisonRows = results
            .filter((entry) => entry.result.status === "success")
            .map(({ plan, result }) => toComparisonRow(plan, result));
        const aggregateExecutionTimeMs = totalExecutionTimeMs(results);

        renderMonteCarloResults(primaryEntry.result, dom, comparisonRows);
        if (scenarioPlans.length > 1) {
            dom.execTimeEl.textContent = `${(aggregateExecutionTimeMs / 1000).toFixed(2)}s`;
        }
        dom.statusSpan.textContent = formatCompletionStatus(
            requestedSimulations,
            effectiveSimulations,
            scenarioPlans.length,
            aggregateExecutionTimeMs,
        );
    } catch (error) {
        if (!dom) {
            return;
        }

        if (isAbortError(error)) {
            dom.statusSpan.textContent = "Monte Carlo run cancelled";
        } else {
            dom.statusSpan.textContent = `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
            console.error("Monte Carlo simulation failed:", error);
        }
    } finally {
        isRunning = false;
        abortController = null;
        if (dom) {
            dom.runBtn.disabled = false;
            dom.cancelBtn.style.display = "none";
            dom.spinner.style.display = "none";
            refreshSimulationCapHint();
        }
    }
}

function readSettingsFromDom(): MonteCarloSettings {
    if (!dom) {
        throw new Error("Monte Carlo DOM not initialized");
    }

    return {
        simulations: parseInt(dom.simulationsInput.value, 10) || 1000,
        seed: parseInt(dom.seedInput.value, 10) || 1337,
        enableSequenceRandomization: dom.sequenceToggle.checked,
        enableBootstrap: dom.bootstrapToggle.checked,
        enableParameterPerturbation: false,
        parameterPerturbationStdDev: 5,
        ruinThresholdPercent: parseFloat(dom.ruinThresholdInput.value) || 50,
        initialCapital: parseFloat(dom.initialCapitalInput.value) || 10000,
    };
}

function buildScenarioPlans(baseSettings: MonteCarloSettings): ScenarioPlan[] {
    const plans: ScenarioPlan[] = [];

    if (baseSettings.enableSequenceRandomization) {
        plans.push({
            key: "sequence",
            label: "Sequence Only",
            isPrimary: !baseSettings.enableBootstrap,
            settings: {
                ...baseSettings,
                enableSequenceRandomization: true,
                enableBootstrap: false,
            },
        });
    }

    if (baseSettings.enableBootstrap) {
        plans.push({
            key: "bootstrap",
            label: "Bootstrap Only",
            isPrimary: !baseSettings.enableSequenceRandomization,
            settings: {
                ...baseSettings,
                enableSequenceRandomization: false,
                enableBootstrap: true,
            },
        });
    }

    if (baseSettings.enableSequenceRandomization && baseSettings.enableBootstrap) {
        plans.push({
            key: "combined",
            label: "Combined",
            isPrimary: true,
            settings: {
                ...baseSettings,
                enableSequenceRandomization: true,
                enableBootstrap: true,
            },
        });
    }

    return plans;
}

function toComparisonRow(plan: ScenarioPlan, result: MonteCarloResult): MonteCarloMethodComparisonRow {
    return {
        label: plan.label,
        isPrimary: plan.isPrimary,
        medianNetProfit: result.netProfitDistribution.median,
        medianMaxDrawdown: result.ruinProbabilityMetrics.maxDrawdownDistribution.median,
        maxDrawdown95: result.ruinProbabilityMetrics.maxDrawdownDistribution.percentile95,
        medianSharpe: median(result.metricSamples.sharpeRatioValues),
        ruinProbability: result.ruinProbabilityMetrics.ruinProbability,
    };
}

function totalExecutionTimeMs(results: Array<{ result: MonteCarloResult }>): number {
    return results.reduce((sum, entry) => sum + entry.result.executionTimeMs, 0);
}

function getScenarioCount(settings: MonteCarloSettings): number {
    return buildScenarioPlans(settings).length;
}

function computeSafeSimulationCap(tradeCount: number, scenarioCount: number): number {
    const workload = Math.max(1, tradeCount) * Math.max(1, scenarioCount);
    const cap = Math.floor(TARGET_TOTAL_WORK_UNITS / workload);
    return Math.min(MAX_SIMULATION_CAP, Math.max(MIN_SIMULATION_CAP, cap));
}

function refreshSimulationCapHint(): void {
    if (!dom) {
        return;
    }

    const settings = readSettingsFromDom();
    const tradeCount = state.currentBacktestResult?.trades.length ?? 0;
    const scenarioCount = getScenarioCount(settings);

    if (tradeCount === 0) {
        dom.simulationCapHint.textContent = "Safe cap becomes more precise after a backtest is available.";
        return;
    }

    const safeCap = computeSafeSimulationCap(tradeCount, scenarioCount);
    dom.simulationCapHint.textContent = `Current safe cap: ${safeCap.toLocaleString()} sims across ${scenarioCount} active method set${scenarioCount === 1 ? "" : "s"}.`;
}

function applyPreset(target: number): void {
    if (!dom) {
        return;
    }

    dom.simulationsInput.value = String(target);
    refreshSimulationCapHint();
}

function handleCancel(): void {
    abortController?.abort();
}

function formatProgressStatus(
    label: string,
    progress: MonteCarloProgress,
    scenarioIndex: number,
    scenarioCount: number,
): string {
    const completed = (scenarioIndex * progress.total) + progress.completed;
    const total = scenarioCount * progress.total;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    return `Running ${label}: ${completed.toLocaleString()}/${total.toLocaleString()} simulations... ${percent}%`;
}

function formatCompletionStatus(
    requestedSimulations: number,
    effectiveSimulations: number,
    scenarioCount: number,
    executionTimeMs: number,
): string {
    const totalEffective = scenarioCount * effectiveSimulations;
    if (scenarioCount > 1) {
        if (requestedSimulations > effectiveSimulations) {
            return `Completed ${effectiveSimulations.toLocaleString()} sims per scenario across ${scenarioCount} scenarios (${totalEffective.toLocaleString()} total) in ${executionTimeMs}ms. Requested ${requestedSimulations.toLocaleString()} per scenario.`;
        }

        return `Completed ${effectiveSimulations.toLocaleString()} sims per scenario across ${scenarioCount} scenarios (${totalEffective.toLocaleString()} total) in ${executionTimeMs}ms`;
    }

    if (requestedSimulations > effectiveSimulations) {
        return `Completed ${effectiveSimulations.toLocaleString()} capped simulations in ${executionTimeMs}ms (requested ${requestedSimulations.toLocaleString()})`;
    }

    return `Completed ${totalEffective.toLocaleString()} total simulations in ${executionTimeMs}ms`;
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}

function median(values: readonly number[]): number {
    if (values.length === 0) {
        return 0;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] ?? 0 : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export function showMonteCarloTab(): void {
    if (!dom) {
        initMonteCarloService();
    }
}

export function refreshMonteCarloFromState(): void {
    if (!dom) {
        return;
    }

    if (!state.currentBacktestResult) {
        dom.emptyState.style.display = "block";
        dom.resultsContainer.style.display = "none";
        refreshSimulationCapHint();
        return;
    }

    dom.emptyState.style.display = "none";
    refreshSimulationCapHint();
}
