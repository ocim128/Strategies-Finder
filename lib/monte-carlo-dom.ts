import { getRequiredDomElements } from "./dom-utils";

export interface MonteCarloDomElements {
    scopeSelect: HTMLSelectElement;
    chartScope: HTMLElement;
    universeScope: HTMLElement;
    universeSymbols: HTMLTextAreaElement;
    universeCopyFinder: HTMLButtonElement;
    universePaths: HTMLInputElement;
    universeCapital: HTMLInputElement;
    universeMinimum: HTMLInputElement;
    universeProfitable: HTMLInputElement;
    universeDrawdown: HTMLInputElement;
    universeSeed: HTMLInputElement;
    universeRuin: HTMLInputElement;
    universePreview: HTMLElement;
    universeSummary: HTMLElement;
    universeTable: HTMLTableElement;
    universeRows: HTMLTableSectionElement;
    universePrevious: HTMLButtonElement;
    universeNext: HTMLButtonElement;
    universePage: HTMLElement;
    universeCsv: HTMLButtonElement;
    universeJson: HTMLButtonElement;
    universeDetailStatus: HTMLElement;
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
    runBtn: HTMLButtonElement;
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
}

const MONTE_CARLO_DOM_IDS = {
    scopeSelect: 'mc-scope', chartScope: 'mc-chart-scope-container', universeScope: 'mc-universe-scope-container',
    universeSymbols: 'mc-universe-symbols', universeCopyFinder: 'mc-universe-copy-finder',
    universePaths: 'mc-universe-paths', universeCapital: 'mc-universe-capital', universeMinimum: 'mc-universe-minimum',
    universeProfitable: 'mc-universe-profitable', universeDrawdown: 'mc-universe-drawdown',
    universeSeed: 'mc-universe-seed', universeRuin: 'mc-universe-ruin', universePreview: 'mc-universe-preview',
    universeSummary: 'mc-universe-summary', universeTable: 'mc-universe-table', universeRows: 'mc-universe-rows',
    universePrevious: 'mc-universe-previous', universeNext: 'mc-universe-next', universePage: 'mc-universe-page',
    universeCsv: 'mc-universe-csv', universeJson: 'mc-universe-json', universeDetailStatus: 'mc-universe-detail-status',
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
    runBtn: "mc-run-btn",
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
} as const satisfies Record<keyof MonteCarloDomElements, string>;

export const MONTE_CARLO_REQUIRED_IDS = [
    ...Object.values(MONTE_CARLO_DOM_IDS),
    "montecarloTab",
] as const;

/**
 * Resolve every control and result section the service binds. Every declared
 * id is required: a missing element throws so initialization fails before any
 * listener is attached, and the lazy tab reports the activation failure instead
 * of silently operating on a substituted element.
 */
export function createMonteCarloDom(): MonteCarloDomElements {
    return getRequiredDomElements(MONTE_CARLO_DOM_IDS) as MonteCarloDomElements;
}
