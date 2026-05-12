import { debugLogger } from "./debug-logger";

export interface MonteCarloDomElements {
    simulationsInput: HTMLInputElement;
    simulationCapHint: HTMLElement;
    seedInput: HTMLInputElement;
    presetRow: HTMLElement;
    preset500Btn: HTMLButtonElement;
    preset2000Btn: HTMLButtonElement;
    preset5000Btn: HTMLButtonElement;
    sequenceToggle: HTMLInputElement;
    bootstrapToggle: HTMLInputElement;
    ruinThresholdInput: HTMLInputElement;
    initialCapitalInput: HTMLInputElement;
    polymarketStakePerTradeInput: HTMLInputElement;
    runBtn: HTMLButtonElement;
    runPolymarketBtn: HTMLButtonElement;
    cancelBtn: HTMLButtonElement;
    statusSpan: HTMLSpanElement;
    spinner: HTMLElement;
    resultsContainer: HTMLElement;
    emptyState: HTMLElement;
    sourceBadge: HTMLElement;
    summaryProfitLabel: HTMLElement;
    simCountEl: HTMLElement;
    ruinProbEl: HTMLElement;
    medianProfitEl: HTMLElement;
    medianSharpeEl: HTMLElement;
    medianDdEl: HTMLElement;
    execTimeEl: HTMLElement;
    polymarketSummaryHeader: HTMLElement;
    polymarketSummary: HTMLElement;
    pmScoredTradesEl: HTMLElement;
    pmOverallCoverageEl: HTMLElement;
    pmDataCoverageEl: HTMLElement;
    pmObservedFinalBalanceEl: HTMLElement;
    pmSkipBreakdownEl: HTMLElement;
    pmMedianFinalBankrollEl: HTMLElement;
    pmFinalBankrollP5El: HTMLElement;
    ciBody: HTMLTableSectionElement;
    riskGrid: HTMLElement;
    riskFlagEl: HTMLElement;
    ddStressMultipleEl: HTMLElement;
    riskDetailEl: HTMLElement;
    methodProfitHeader: HTMLElement;
    methodComparisonBody: HTMLTableSectionElement;
    ddPercentilesBody: HTMLTableSectionElement;
    profitHistogram: HTMLCanvasElement;
    ddHistogram: HTMLCanvasElement;
    sharpeHistogram: HTMLCanvasElement;
    profitDistTitle: HTMLElement;
    profitStats: HTMLElement;
    ddStats: HTMLElement;
    sharpeStats: HTMLElement;
    equityFan: HTMLCanvasElement;
    fanLegend: HTMLElement;
    ruinRateEl: HTMLElement;
    expectedTradesToRuinEl: HTMLElement;
    medianTradesToRuinEl: HTMLElement;
    dd95El: HTMLElement;
    sensitivityHeader: HTMLElement;
    sensitivitySection: HTMLElement;
    sensitivityGrid: HTMLElement;
}

const MONTE_CARLO_DOM_IDS = {
    simulationsInput: "mc-simulations",
    simulationCapHint: "mc-sim-cap-hint",
    seedInput: "mc-seed",
    presetRow: "mc-preset-row",
    preset500Btn: "mc-preset-500",
    preset2000Btn: "mc-preset-2000",
    preset5000Btn: "mc-preset-5000",
    sequenceToggle: "mc-sequence-toggle",
    bootstrapToggle: "mc-bootstrap-toggle",
    ruinThresholdInput: "mc-ruin-threshold",
    initialCapitalInput: "mc-initial-capital",
    polymarketStakePerTradeInput: "mc-polymarket-stake-per-trade",
    runBtn: "mc-run-btn",
    runPolymarketBtn: "mc-run-polymarket-btn",
    cancelBtn: "mc-cancel-btn",
    statusSpan: "mc-status",
    spinner: "mc-spinner",
    resultsContainer: "mc-results",
    emptyState: "mc-empty-state",
    sourceBadge: "mc-source-badge",
    summaryProfitLabel: "mc-summary-profit-label",
    simCountEl: "mc-sim-count",
    ruinProbEl: "mc-ruin-prob",
    medianProfitEl: "mc-median-profit",
    medianSharpeEl: "mc-median-sharpe",
    medianDdEl: "mc-median-dd",
    execTimeEl: "mc-exec-time",
    polymarketSummaryHeader: "mc-polymarket-summary-header",
    polymarketSummary: "mc-polymarket-summary",
    pmScoredTradesEl: "mc-pm-scored-trades",
    pmOverallCoverageEl: "mc-pm-overall-coverage",
    pmDataCoverageEl: "mc-pm-data-coverage",
    pmObservedFinalBalanceEl: "mc-pm-observed-final-balance",
    pmSkipBreakdownEl: "mc-pm-skip-breakdown",
    pmMedianFinalBankrollEl: "mc-pm-median-final-bankroll",
    pmFinalBankrollP5El: "mc-pm-final-bankroll-p5",
    ciBody: "mc-ci-body",
    riskGrid: "mc-risk-grid",
    riskFlagEl: "mc-risk-flag",
    ddStressMultipleEl: "mc-dd-stress-multiple",
    riskDetailEl: "mc-risk-detail",
    methodProfitHeader: "mc-method-profit-header",
    methodComparisonBody: "mc-method-comparison-body",
    ddPercentilesBody: "mc-dd-percentiles-body",
    profitHistogram: "mc-profit-histogram",
    ddHistogram: "mc-dd-histogram",
    sharpeHistogram: "mc-sharpe-histogram",
    profitDistTitle: "mc-profit-dist-title",
    profitStats: "mc-profit-stats",
    ddStats: "mc-dd-stats",
    sharpeStats: "mc-sharpe-stats",
    equityFan: "mc-equity-fan",
    fanLegend: "mc-fan-legend",
    ruinRateEl: "mc-ruin-rate",
    expectedTradesToRuinEl: "mc-expected-trades-to-ruin",
    medianTradesToRuinEl: "mc-median-trades-to-ruin",
    dd95El: "mc-dd-95",
    sensitivityHeader: "mc-sensitivity-header",
    sensitivitySection: "mc-sensitivity-section",
    sensitivityGrid: "mc-sensitivity-grid",
} as const satisfies Record<keyof MonteCarloDomElements, string>;

export const MONTE_CARLO_REQUIRED_IDS = [
    ...Object.values(MONTE_CARLO_DOM_IDS),
    "montecarloTab",
] as const;

type NullableMonteCarloDomElements = {
    [K in keyof MonteCarloDomElements]: MonteCarloDomElements[K] | null;
};

const CRITICAL_DOM_KEYS = [
    "simulationsInput",
    "runBtn",
    "resultsContainer",
    "emptyState",
] as const satisfies readonly (keyof MonteCarloDomElements)[];
type CriticalDomKey = typeof CRITICAL_DOM_KEYS[number];

const SELECTOR_FALLBACKS = {
    ciBody: "tbody",
    methodComparisonBody: "#mc-method-comparison-body",
    ddPercentilesBody: "#mc-dd-percentiles-body",
    profitHistogram: "#mc-profit-histogram",
    ddHistogram: "#mc-dd-histogram",
    sharpeHistogram: "#mc-sharpe-histogram",
    equityFan: "#mc-equity-fan",
} as const satisfies Partial<Record<keyof MonteCarloDomElements, string>>;
type SelectorFallbackKey = keyof typeof SELECTOR_FALLBACKS;

const ELEMENT_FALLBACKS = {
    simulationCapHint: "simulationsInput",
    seedInput: "simulationsInput",
    presetRow: "simulationsInput",
    preset500Btn: "runBtn",
    preset2000Btn: "runBtn",
    preset5000Btn: "runBtn",
    sequenceToggle: "simulationsInput",
    bootstrapToggle: "simulationsInput",
    ruinThresholdInput: "simulationsInput",
    initialCapitalInput: "simulationsInput",
    polymarketStakePerTradeInput: "simulationsInput",
    runPolymarketBtn: "runBtn",
    cancelBtn: "runBtn",
    statusSpan: "runBtn",
    spinner: "runBtn",
    sourceBadge: "resultsContainer",
    summaryProfitLabel: "resultsContainer",
    simCountEl: "resultsContainer",
    ruinProbEl: "resultsContainer",
    medianProfitEl: "resultsContainer",
    medianSharpeEl: "resultsContainer",
    medianDdEl: "resultsContainer",
    execTimeEl: "resultsContainer",
    polymarketSummaryHeader: "resultsContainer",
    polymarketSummary: "resultsContainer",
    pmScoredTradesEl: "resultsContainer",
    pmOverallCoverageEl: "resultsContainer",
    pmDataCoverageEl: "resultsContainer",
    pmObservedFinalBalanceEl: "resultsContainer",
    pmSkipBreakdownEl: "resultsContainer",
    pmMedianFinalBankrollEl: "resultsContainer",
    pmFinalBankrollP5El: "resultsContainer",
    riskGrid: "resultsContainer",
    riskFlagEl: "resultsContainer",
    ddStressMultipleEl: "resultsContainer",
    riskDetailEl: "resultsContainer",
    methodProfitHeader: "resultsContainer",
    profitDistTitle: "resultsContainer",
    profitStats: "resultsContainer",
    ddStats: "resultsContainer",
    sharpeStats: "resultsContainer",
    fanLegend: "resultsContainer",
    ruinRateEl: "resultsContainer",
    expectedTradesToRuinEl: "resultsContainer",
    medianTradesToRuinEl: "resultsContainer",
    dd95El: "resultsContainer",
    sensitivityHeader: "resultsContainer",
    sensitivitySection: "resultsContainer",
    sensitivityGrid: "resultsContainer",
} as const satisfies Record<
    Exclude<keyof MonteCarloDomElements, CriticalDomKey | SelectorFallbackKey>,
    keyof MonteCarloDomElements
>;

const CRITICAL_DOM_KEY_SET = new Set<keyof MonteCarloDomElements>(CRITICAL_DOM_KEYS);

function setElement<K extends keyof MonteCarloDomElements>(
    elements: NullableMonteCarloDomElements,
    key: K,
    element: HTMLElement | null,
): void {
    elements[key] = element as NullableMonteCarloDomElements[K];
}

function readMonteCarloElements(): NullableMonteCarloDomElements {
    const elements = {} as NullableMonteCarloDomElements;

    for (const key of Object.keys(MONTE_CARLO_DOM_IDS) as Array<keyof MonteCarloDomElements>) {
        const id = MONTE_CARLO_DOM_IDS[key];
        const element = document.getElementById(id);
        if (!element && CRITICAL_DOM_KEY_SET.has(key)) {
            debugLogger.error("monte_carlo.dom_missing", { id });
        }
        setElement(elements, key, element);
    }

    return elements;
}

function applyFallbacks(elements: Partial<MonteCarloDomElements>, resultsContainer: HTMLElement): void {
    const elementRecord = elements as Record<string, HTMLElement | null | undefined>;

    for (const key of Object.keys(ELEMENT_FALLBACKS) as Array<keyof typeof ELEMENT_FALLBACKS>) {
        elementRecord[key] ??= elementRecord[ELEMENT_FALLBACKS[key]];
    }

    for (const key of Object.keys(SELECTOR_FALLBACKS) as Array<keyof typeof SELECTOR_FALLBACKS>) {
        elementRecord[key] ??= resultsContainer.querySelector<HTMLElement>(SELECTOR_FALLBACKS[key]);
    }
}

export function createMonteCarloDom(): MonteCarloDomElements | null {
    const elements = readMonteCarloElements();
    const { simulationsInput, runBtn, resultsContainer, emptyState } = elements;

    if (!simulationsInput || !runBtn || !resultsContainer || !emptyState) {
        return null;
    }

    const resolved = {
        ...elements,
        simulationsInput,
        runBtn,
        resultsContainer,
        emptyState,
    } as Partial<MonteCarloDomElements>;
    applyFallbacks(resolved, resultsContainer);

    return resolved as MonteCarloDomElements;
}
