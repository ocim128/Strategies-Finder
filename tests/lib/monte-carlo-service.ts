import { state } from "./state";
import { backtestService } from "./backtest-service";
import {
    buildPolymarketMonteCarloInput,
    runMonteCarloSimulation,
    runPolymarketMonteCarloSimulation,
    type MonteCarloProgress,
    type MonteCarloResult,
    type MonteCarloSettings,
    type MonteCarloSizingConfig,
    type PolymarketMonteCarloInput,
} from "./strategies/monte-carlo";
import { createMonteCarloDom, type MonteCarloDomElements } from "./monte-carlo-dom";
import {
    getMonteCarloCoverageWarnings,
    renderMonteCarloResults,
    type MonteCarloMethodComparisonRow,
} from "./monte-carlo-renderer";
import { median } from "./statistics-utils";
import { debugLogger } from "./debug-logger";
import type { BacktestResult } from "./types/strategies";

const MAX_SIMULATION_CAP = 10_000;
const MIN_SIMULATION_CAP = 250;
const TARGET_TOTAL_WORK_UNITS = 8_000_000;

type RunSource = "chart" | "polymarket";

interface ScenarioPlan {
    key: "sequence" | "bootstrap" | "combined";
    label: string;
    settings: MonteCarloSettings;
    isPrimary: boolean;
}

interface PolymarketRunReadiness {
    available: boolean;
    reason: string | null;
    input: PolymarketMonteCarloInput | null;
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
        debugLogger.warn("monte_carlo.dom_unavailable");
        return;
    }

    dom.runBtn.addEventListener("click", () => {
        void handleRun("chart");
    });
    dom.runPolymarketBtn.addEventListener("click", () => {
        void handleRun("polymarket");
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

    state.subscribe("currentBacktestResult", () => {
        refreshMonteCarloFromState();
    });

    refreshMonteCarloFromState();
    initialized = true;
}

async function handleRun(source: RunSource): Promise<void> {
    if (!dom || isRunning) {
        return;
    }

    const backtestResult = state.currentBacktestResult;
    if (!backtestResult) {
        dom.statusSpan.textContent = "Please run a backtest first";
        return;
    }

    const polymarketReadiness = getPolymarketRunReadiness(backtestResult);
    if (source === "polymarket" && !polymarketReadiness.available) {
        dom.statusSpan.textContent = polymarketReadiness.reason ?? "Polymarket Monte Carlo is unavailable";
        return;
    }

    const baseSettings = readSettingsFromDom();
    if (!baseSettings.enableSequenceRandomization && !baseSettings.enableBootstrap) {
        dom.statusSpan.textContent = "Enable sequence randomization or bootstrap resampling";
        return;
    }

    const scenarioCount = getScenarioCount(baseSettings);
    const sourceTradeCount = source === "chart"
        ? backtestResult.trades.length
        : (polymarketReadiness.input?.coverageSummary.usableTrades ?? 0);
    const safeCap = computeSafeSimulationCap(sourceTradeCount, scenarioCount);
    const requestedSimulations = baseSettings.simulations;
    const effectiveSimulations = Math.min(requestedSimulations, safeCap);

    if (requestedSimulations > safeCap) {
        baseSettings.simulations = effectiveSimulations;
        dom.statusSpan.textContent = `Requested ${requestedSimulations.toLocaleString()} sims; using safe cap ${safeCap.toLocaleString()} for this ${formatSourceNoun(source)} run`;
    }

    const scenarioPlans = buildScenarioPlans(baseSettings);
    if (scenarioPlans.length === 0) {
        dom.statusSpan.textContent = "No Monte Carlo scenarios are available for the selected settings";
        return;
    }

    isRunning = true;
    abortController = new AbortController();
    setRunningState(true);
    dom.statusSpan.textContent = `Running ${formatSourceLabel(source)} Monte Carlo: 0/${(scenarioPlans.length * effectiveSimulations).toLocaleString()} simulations...`;

    try {
        const results: Array<{ plan: ScenarioPlan; result: MonteCarloResult }> = [];

        for (let scenarioIndex = 0; scenarioIndex < scenarioPlans.length; scenarioIndex++) {
            const plan = scenarioPlans[scenarioIndex];
            const result = source === "chart"
                ? await runMonteCarloSimulation(
                    backtestResult,
                    plan.settings,
                    state.ohlcvData,
                    undefined,
                    {
                        signal: abortController.signal,
                        sizing: createChartMonteCarloSizingConfig(),
                        onProgress: (progress: MonteCarloProgress) => {
                            if (!dom) {
                                return;
                            }
                            dom.statusSpan.textContent = formatProgressStatus(source, plan.label, progress, scenarioIndex, scenarioPlans.length);
                        },
                    },
                )
                : await runPolymarketMonteCarloSimulation(
                    polymarketReadiness.input!,
                    plan.settings,
                    {
                        signal: abortController.signal,
                        onProgress: (progress: MonteCarloProgress) => {
                            if (!dom) {
                                return;
                            }
                            dom.statusSpan.textContent = formatProgressStatus(source, plan.label, progress, scenarioIndex, scenarioPlans.length);
                        },
                    },
                );
            results.push({ plan, result });
        }

        if (!dom) {
            return;
        }

        if (
            source === "polymarket"
            && polymarketReadiness.input
            && results.some(({ result }) => isInvalidFixedStakePolymarketResult(
                result,
                polymarketReadiness.input!,
                baseSettings.polymarketStakePerTrade,
            ))
        ) {
            dom.emptyState.style.display = "block";
            dom.resultsContainer.style.display = "none";
            dom.statusSpan.textContent = "Hard refresh required: Polymarket Monte Carlo engine is stale. Reload the page and rerun.";
            debugLogger.warn("monte_carlo.stale_polymarket_engine_detected");
            return;
        }

        const primaryEntry = results.find((entry) => entry.plan.isPrimary) ?? results[results.length - 1];
        const comparisonRows = results
            .filter((entry) => entry.result.status === "success")
            .map(({ plan, result }) => toComparisonRow(plan, result));
        const aggregateExecutionTimeMs = totalExecutionTimeMs(results);

        renderMonteCarloResults(primaryEntry.result, dom, comparisonRows);

        if (primaryEntry.result.status !== "success") {
            dom.statusSpan.textContent = primaryEntry.result.errorMessage ?? `${formatSourceLabel(source)} Monte Carlo could not complete`;
            return;
        }

        if (scenarioPlans.length > 1) {
            dom.execTimeEl.textContent = `${(aggregateExecutionTimeMs / 1000).toFixed(2)}s`;
        }

        dom.statusSpan.textContent = formatCompletionStatus(
            source,
            requestedSimulations,
            effectiveSimulations,
            scenarioPlans.length,
            aggregateExecutionTimeMs,
            primaryEntry.result,
        );
    } catch (error) {
        if (!dom) {
            return;
        }

        if (isAbortError(error)) {
            dom.statusSpan.textContent = `${formatSourceLabel(source)} Monte Carlo run cancelled`;
        } else {
            dom.statusSpan.textContent = `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
            debugLogger.error("monte_carlo.run_failed", {
                error: error instanceof Error ? error.message : String(error),
                source,
            });
        }
    } finally {
        isRunning = false;
        abortController = null;
        setRunningState(false);
        refreshActionAvailability();
        refreshSimulationCapHint();
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
        polymarketStakePerTrade: parseFloat(dom.polymarketStakePerTradeInput.value) || 1,
    };
}

function createChartMonteCarloSizingConfig(): MonteCarloSizingConfig {
    const capitalSettings = backtestService.getCapitalSettings();
    return {
        mode: capitalSettings.sizingMode,
        positionSizePercent: capitalSettings.positionSize,
        fixedTradeAmount: capitalSettings.fixedTradeAmount,
        commissionPercent: capitalSettings.commission,
        advancedSizing: capitalSettings.advancedSizing,
        ohlcvData: state.ohlcvData,
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
    const backtestResult = state.currentBacktestResult;
    const scenarioCount = getScenarioCount(settings);

    if (!backtestResult) {
        dom.simulationCapHint.textContent = "Safe cap becomes more precise after a backtest is available.";
        return;
    }

    const chartSafeCap = computeSafeSimulationCap(backtestResult.trades.length, scenarioCount);
    const polymarketReadiness = getPolymarketRunReadiness(backtestResult);
    if (!polymarketReadiness.input) {
        dom.simulationCapHint.textContent = `Chart safe cap: ${chartSafeCap.toLocaleString()} sims across ${scenarioCount} active method set${scenarioCount === 1 ? "" : "s"}. Polymarket unavailable until annotation data exists.`;
        return;
    }

    if (!polymarketReadiness.available) {
        dom.simulationCapHint.textContent = `Chart safe cap: ${chartSafeCap.toLocaleString()} sims across ${scenarioCount} active method set${scenarioCount === 1 ? "" : "s"}. Polymarket unavailable: ${polymarketReadiness.reason}`;
        return;
    }

    const polymarketSafeCap = computeSafeSimulationCap(
        polymarketReadiness.input.coverageSummary.usableTrades,
        scenarioCount,
    );
    dom.simulationCapHint.textContent = `Chart safe cap: ${chartSafeCap.toLocaleString()} sims. Polymarket safe cap: ${polymarketSafeCap.toLocaleString()} sims across ${scenarioCount} active method set${scenarioCount === 1 ? "" : "s"}.`;
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
    source: RunSource,
    label: string,
    progress: MonteCarloProgress,
    scenarioIndex: number,
    scenarioCount: number,
): string {
    const completed = (scenarioIndex * progress.total) + progress.completed;
    const total = scenarioCount * progress.total;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    return `Running ${formatSourceLabel(source)} ${label}: ${completed.toLocaleString()}/${total.toLocaleString()} simulations... ${percent}%`;
}

function formatCompletionStatus(
    source: RunSource,
    requestedSimulations: number,
    effectiveSimulations: number,
    scenarioCount: number,
    executionTimeMs: number,
    result: MonteCarloResult,
): string {
    const totalEffective = scenarioCount * effectiveSimulations;
    let baseMessage: string;

    if (scenarioCount > 1) {
        if (requestedSimulations > effectiveSimulations) {
            baseMessage = `Completed ${effectiveSimulations.toLocaleString()} ${formatSourceNoun(source)} sims per scenario across ${scenarioCount} scenarios (${totalEffective.toLocaleString()} total) in ${executionTimeMs}ms. Requested ${requestedSimulations.toLocaleString()} per scenario.`;
        } else {
            baseMessage = `Completed ${effectiveSimulations.toLocaleString()} ${formatSourceNoun(source)} sims per scenario across ${scenarioCount} scenarios (${totalEffective.toLocaleString()} total) in ${executionTimeMs}ms.`;
        }
    } else if (requestedSimulations > effectiveSimulations) {
        baseMessage = `Completed ${effectiveSimulations.toLocaleString()} capped ${formatSourceNoun(source)} simulations in ${executionTimeMs}ms (requested ${requestedSimulations.toLocaleString()}).`;
    } else {
        baseMessage = `Completed ${totalEffective.toLocaleString()} ${formatSourceNoun(source)} simulations in ${executionTimeMs}ms.`;
    }

    const coverageWarnings = getMonteCarloCoverageWarnings(result);
    return coverageWarnings.length > 0
        ? `${baseMessage} ${coverageWarnings.join(" ")}`
        : baseMessage;
}

function getPolymarketRunReadiness(backtestResult: BacktestResult | null): PolymarketRunReadiness {
    if (!backtestResult) {
        return {
            available: false,
            reason: "Please run a backtest first",
            input: null,
        };
    }

    const input = buildPolymarketMonteCarloInput(backtestResult);
    if (!input.hasTradeLevelAnnotations) {
        return {
            available: false,
            reason: backtestResult.polymarketTradeSummary
                ? "Polymarket Monte Carlo requires trade-level Polymarket annotations. Rerun the backtest with Polymarket Annotation enabled."
                : "Polymarket Monte Carlo requires a Polymarket-annotated backtest",
            input,
        };
    }

    if (input.coverageSummary.usableTrades <= 0) {
        return {
            available: false,
            reason: "Polymarket Monte Carlo requires usable Polymarket payouts on the current backtest",
            input,
        };
    }

    if (input.coverageSummary.usableTrades < 5) {
        return {
            available: false,
            reason: `Only ${input.coverageSummary.usableTrades} usable Polymarket trades; need at least 5`,
            input,
        };
    }

    return {
        available: true,
        reason: null,
        input,
    };
}

function refreshActionAvailability(): void {
    if (!dom) {
        return;
    }

    const backtestResult = state.currentBacktestResult;
    const chartAvailable = !!backtestResult;
    const polymarketReadiness = getPolymarketRunReadiness(backtestResult);

    dom.runBtn.disabled = isRunning || !chartAvailable;
    dom.runPolymarketBtn.disabled = isRunning || !polymarketReadiness.available;
    dom.runPolymarketBtn.title = polymarketReadiness.reason ?? "";

    if (!isRunning) {
        if (!chartAvailable) {
            setIdleStatusMessageIfRelevant("Please run a backtest first");
        } else if (!polymarketReadiness.available && polymarketReadiness.reason) {
            setIdleStatusMessageIfRelevant(polymarketReadiness.reason);
        } else {
            setIdleStatusMessageIfRelevant("Ready");
        }
    }
}

function setRunningState(running: boolean): void {
    if (!dom) {
        return;
    }

    dom.runBtn.disabled = running;
    dom.runPolymarketBtn.disabled = running;
    dom.cancelBtn.style.display = running ? "inline-block" : "none";
    dom.spinner.style.display = running ? "inline-block" : "none";
}

function setIdleStatusMessageIfRelevant(message: string): void {
    if (!dom) {
        return;
    }

    const current = dom.statusSpan.textContent?.trim() ?? "";
    if (
        current === ""
        || current === "Ready"
        || current === "Please run a backtest first"
        || current.startsWith("Polymarket Monte Carlo requires")
        || current.startsWith("Only ")
        || current.startsWith("Chart safe cap:")
        || current.startsWith("Polymarket unavailable")
    ) {
        dom.statusSpan.textContent = message;
    }
}

function formatSourceLabel(source: RunSource): string {
    return source === "polymarket" ? "Polymarket" : "Chart";
}

function formatSourceNoun(source: RunSource): string {
    return source === "polymarket" ? "Polymarket Monte Carlo" : "Monte Carlo";
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}

function isInvalidFixedStakePolymarketResult(
    result: MonteCarloResult,
    input: PolymarketMonteCarloInput,
    requestedStakePerTrade: number | undefined,
): boolean {
    if (result.inputSource !== "polymarket") {
        return false;
    }

    if (result.polymarketSizingModel !== "fixed_stake") {
        return true;
    }

    const stakePerTrade = typeof requestedStakePerTrade === "number" && Number.isFinite(requestedStakePerTrade)
        ? Math.max(0.01, requestedStakePerTrade)
        : 1;
    const maxAbsNetProfit = input.trades.reduce((sum, trade) => {
        const tradeReturn = trade.entryPrice > 0 ? trade.sharePnl / trade.entryPrice : 0;
        return sum + Math.abs(stakePerTrade * tradeReturn);
    }, 0);
    const tolerance = Math.max(1e-6, maxAbsNetProfit * 1e-6);

    if (Math.abs(result.inputNetProfit) > maxAbsNetProfit + tolerance) {
        return true;
    }

    return result.metricSamples.netProfitValues.some(
        (value) => Math.abs(value) > maxAbsNetProfit + tolerance,
    );
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
        refreshActionAvailability();
        refreshSimulationCapHint();
        return;
    }

    dom.emptyState.style.display = "none";
    refreshActionAvailability();
    refreshSimulationCapHint();
}
