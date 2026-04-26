/**
 * DOM contracts for Monte Carlo simulation tab
 */

import { debugLogger } from "./debug-logger";

export const MONTE_CARLO_REQUIRED_IDS = [
    // Configuration inputs
    "mc-simulations",
    "mc-sim-cap-hint",
    "mc-seed",
    "mc-preset-row",
    "mc-preset-500",
    "mc-preset-2000",
    "mc-preset-5000",
    "mc-sequence-toggle",
    "mc-bootstrap-toggle",
    "mc-ruin-threshold",
    "mc-initial-capital",
    "mc-polymarket-stake-per-trade",
    // Action buttons
    "mc-run-btn",
    "mc-run-polymarket-btn",
    "mc-cancel-btn",
    // Status
    "mc-status",
    "mc-spinner",
    // Results container
    "mc-results",
    "mc-empty-state",
    "mc-source-badge",
    // Summary grid
    "mc-summary-profit-label",
    "mc-sim-count",
    "mc-ruin-prob",
    "mc-median-profit",
    "mc-median-sharpe",
    "mc-median-dd",
    "mc-exec-time",
    // Polymarket summary
    "mc-polymarket-summary-header",
    "mc-polymarket-summary",
    "mc-pm-scored-trades",
    "mc-pm-overall-coverage",
    "mc-pm-data-coverage",
    "mc-pm-observed-final-balance",
    "mc-pm-skip-breakdown",
    "mc-pm-median-final-bankroll",
    "mc-pm-final-bankroll-p5",
    // Confidence intervals table
    "mc-ci-body",
    "mc-risk-grid",
    "mc-risk-flag",
    "mc-dd-stress-multiple",
    "mc-risk-detail",
    "mc-method-profit-header",
    "mc-method-comparison-body",
    "mc-dd-percentiles-body",
    // Histogram canvases
    "mc-profit-histogram",
    "mc-dd-histogram",
    "mc-sharpe-histogram",
    "mc-profit-dist-title",
    // Distribution stats
    "mc-profit-stats",
    "mc-dd-stats",
    "mc-sharpe-stats",
    // Equity fan chart
    "mc-equity-fan",
    "mc-fan-legend",
    // Ruin analysis
    "mc-ruin-rate",
    "mc-expected-trades-to-ruin",
    "mc-median-trades-to-ruin",
    "mc-dd-95",
    // Sensitivity section
    "mc-sensitivity-header",
    "mc-sensitivity-section",
    "mc-sensitivity-grid",
    // Tab panel
    "montecarloTab",
] as const;

export interface MonteCarloDomElements {
    // Configuration inputs
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
    
    // Action buttons
    runBtn: HTMLButtonElement;
    runPolymarketBtn: HTMLButtonElement;
    cancelBtn: HTMLButtonElement;
    
    // Status
    statusSpan: HTMLSpanElement;
    spinner: HTMLElement;
    
    // Results container
    resultsContainer: HTMLElement;
    emptyState: HTMLElement;
    sourceBadge: HTMLElement;
    
    // Summary grid
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
    
    // Confidence intervals table
    ciBody: HTMLTableSectionElement;
    riskGrid: HTMLElement;
    riskFlagEl: HTMLElement;
    ddStressMultipleEl: HTMLElement;
    riskDetailEl: HTMLElement;
    methodProfitHeader: HTMLElement;
    methodComparisonBody: HTMLTableSectionElement;
    ddPercentilesBody: HTMLTableSectionElement;
    
    // Histogram canvases
    profitHistogram: HTMLCanvasElement;
    ddHistogram: HTMLCanvasElement;
    sharpeHistogram: HTMLCanvasElement;
    profitDistTitle: HTMLElement;
    
    // Distribution stats containers
    profitStats: HTMLElement;
    ddStats: HTMLElement;
    sharpeStats: HTMLElement;
    
    // Equity fan chart
    equityFan: HTMLCanvasElement;
    fanLegend: HTMLElement;
    
    // Ruin analysis
    ruinRateEl: HTMLElement;
    expectedTradesToRuinEl: HTMLElement;
    medianTradesToRuinEl: HTMLElement;
    dd95El: HTMLElement;
    
    // Sensitivity section
    sensitivityHeader: HTMLElement;
    sensitivitySection: HTMLElement;
    sensitivityGrid: HTMLElement;
}

export function createMonteCarloDom(): MonteCarloDomElements | null {
    const getRequiredElement = <T extends HTMLElement>(id: string, critical = false): T | null => {
        const el = document.getElementById(id);
        if (!el) {
            if (critical) {
                debugLogger.error("monte_carlo.dom_missing", { id });
            }
            return null;
        }
        return el as T;
    };

    const simulationsInput = getRequiredElement<HTMLInputElement>("mc-simulations");
    const simulationCapHint = getRequiredElement<HTMLElement>("mc-sim-cap-hint");
    const seedInput = getRequiredElement<HTMLInputElement>("mc-seed");
    const presetRow = getRequiredElement<HTMLElement>("mc-preset-row");
    const preset500Btn = getRequiredElement<HTMLButtonElement>("mc-preset-500");
    const preset2000Btn = getRequiredElement<HTMLButtonElement>("mc-preset-2000");
    const preset5000Btn = getRequiredElement<HTMLButtonElement>("mc-preset-5000");
    const sequenceToggle = getRequiredElement<HTMLInputElement>("mc-sequence-toggle");
    const bootstrapToggle = getRequiredElement<HTMLInputElement>("mc-bootstrap-toggle");
    const ruinThresholdInput = getRequiredElement<HTMLInputElement>("mc-ruin-threshold");
    const initialCapitalInput = getRequiredElement<HTMLInputElement>("mc-initial-capital");
    const polymarketStakePerTradeInput = getRequiredElement<HTMLInputElement>("mc-polymarket-stake-per-trade");
    const runBtn = getRequiredElement<HTMLButtonElement>("mc-run-btn");
    const runPolymarketBtn = getRequiredElement<HTMLButtonElement>("mc-run-polymarket-btn");
    const cancelBtn = getRequiredElement<HTMLButtonElement>("mc-cancel-btn");
    const statusSpan = getRequiredElement<HTMLSpanElement>("mc-status");
    const spinner = getRequiredElement<HTMLElement>("mc-spinner");
    const resultsContainer = getRequiredElement<HTMLElement>("mc-results");
    const emptyState = getRequiredElement<HTMLElement>("mc-empty-state");
    const sourceBadge = getRequiredElement<HTMLElement>("mc-source-badge");
    const summaryProfitLabel = getRequiredElement<HTMLElement>("mc-summary-profit-label");
    const simCountEl = getRequiredElement<HTMLElement>("mc-sim-count");
    const ruinProbEl = getRequiredElement<HTMLElement>("mc-ruin-prob");
    const medianProfitEl = getRequiredElement<HTMLElement>("mc-median-profit");
    const medianSharpeEl = getRequiredElement<HTMLElement>("mc-median-sharpe");
    const medianDdEl = getRequiredElement<HTMLElement>("mc-median-dd");
    const execTimeEl = getRequiredElement<HTMLElement>("mc-exec-time");
    const polymarketSummaryHeader = getRequiredElement<HTMLElement>("mc-polymarket-summary-header");
    const polymarketSummary = getRequiredElement<HTMLElement>("mc-polymarket-summary");
    const pmScoredTradesEl = getRequiredElement<HTMLElement>("mc-pm-scored-trades");
    const pmOverallCoverageEl = getRequiredElement<HTMLElement>("mc-pm-overall-coverage");
    const pmDataCoverageEl = getRequiredElement<HTMLElement>("mc-pm-data-coverage");
    const pmObservedFinalBalanceEl = getRequiredElement<HTMLElement>("mc-pm-observed-final-balance");
    const pmSkipBreakdownEl = getRequiredElement<HTMLElement>("mc-pm-skip-breakdown");
    const pmMedianFinalBankrollEl = getRequiredElement<HTMLElement>("mc-pm-median-final-bankroll");
    const pmFinalBankrollP5El = getRequiredElement<HTMLElement>("mc-pm-final-bankroll-p5");
    const ciBody = getRequiredElement<HTMLTableSectionElement>("mc-ci-body");
    const riskGrid = getRequiredElement<HTMLElement>("mc-risk-grid");
    const riskFlagEl = getRequiredElement<HTMLElement>("mc-risk-flag");
    const ddStressMultipleEl = getRequiredElement<HTMLElement>("mc-dd-stress-multiple");
    const riskDetailEl = getRequiredElement<HTMLElement>("mc-risk-detail");
    const methodProfitHeader = getRequiredElement<HTMLElement>("mc-method-profit-header");
    const methodComparisonBody = getRequiredElement<HTMLTableSectionElement>("mc-method-comparison-body");
    const ddPercentilesBody = getRequiredElement<HTMLTableSectionElement>("mc-dd-percentiles-body");
    const profitHistogram = getRequiredElement<HTMLCanvasElement>("mc-profit-histogram");
    const ddHistogram = getRequiredElement<HTMLCanvasElement>("mc-dd-histogram");
    const sharpeHistogram = getRequiredElement<HTMLCanvasElement>("mc-sharpe-histogram");
    const profitDistTitle = getRequiredElement<HTMLElement>("mc-profit-dist-title");
    const equityFan = getRequiredElement<HTMLCanvasElement>("mc-equity-fan");
    const fanLegend = getRequiredElement<HTMLElement>("mc-fan-legend");
    const ruinRateEl = getRequiredElement<HTMLElement>("mc-ruin-rate");
    const expectedTradesToRuinEl = getRequiredElement<HTMLElement>("mc-expected-trades-to-ruin");
    const medianTradesToRuinEl = getRequiredElement<HTMLElement>("mc-median-trades-to-ruin");
    const dd95El = getRequiredElement<HTMLElement>("mc-dd-95");
    const profitStats = getRequiredElement<HTMLElement>("mc-profit-stats");
    const ddStats = getRequiredElement<HTMLElement>("mc-dd-stats");
    const sharpeStats = getRequiredElement<HTMLElement>("mc-sharpe-stats");
    const sensitivityHeader = getRequiredElement<HTMLElement>("mc-sensitivity-header");
    const sensitivitySection = getRequiredElement<HTMLElement>("mc-sensitivity-section");
    const sensitivityGrid = getRequiredElement<HTMLElement>("mc-sensitivity-grid");
    
    // Check if critical elements are missing
    if (!simulationsInput || !runBtn || !resultsContainer || !emptyState) {
        return null;
    }

    return {
        // Configuration inputs (use non-null assertion for optional elements, will fallback in service)
        simulationsInput,
        simulationCapHint: simulationCapHint ?? simulationsInput,
        seedInput: seedInput ?? simulationsInput,
        presetRow: presetRow ?? simulationsInput,
        preset500Btn: preset500Btn ?? runBtn,
        preset2000Btn: preset2000Btn ?? runBtn,
        preset5000Btn: preset5000Btn ?? runBtn,
        sequenceToggle: sequenceToggle ?? simulationsInput,
        bootstrapToggle: bootstrapToggle ?? simulationsInput,
        ruinThresholdInput: ruinThresholdInput ?? simulationsInput,
        initialCapitalInput: initialCapitalInput ?? simulationsInput,
        polymarketStakePerTradeInput: polymarketStakePerTradeInput ?? simulationsInput,
        
        // Action buttons
        runBtn,
        runPolymarketBtn: runPolymarketBtn ?? runBtn,
        cancelBtn: cancelBtn ?? runBtn,
        
        // Status
        statusSpan: statusSpan ?? runBtn,
        spinner: spinner ?? runBtn,
        
        // Results container
        resultsContainer,
        emptyState,
        sourceBadge: sourceBadge ?? resultsContainer,
        
        // Summary grid
        summaryProfitLabel: summaryProfitLabel ?? resultsContainer,
        simCountEl: simCountEl ?? resultsContainer,
        ruinProbEl: ruinProbEl ?? resultsContainer,
        medianProfitEl: medianProfitEl ?? resultsContainer,
        medianSharpeEl: medianSharpeEl ?? resultsContainer,
        medianDdEl: medianDdEl ?? resultsContainer,
        execTimeEl: execTimeEl ?? resultsContainer,
        polymarketSummaryHeader: polymarketSummaryHeader ?? resultsContainer,
        polymarketSummary: polymarketSummary ?? resultsContainer,
        pmScoredTradesEl: pmScoredTradesEl ?? resultsContainer,
        pmOverallCoverageEl: pmOverallCoverageEl ?? resultsContainer,
        pmDataCoverageEl: pmDataCoverageEl ?? resultsContainer,
        pmObservedFinalBalanceEl: pmObservedFinalBalanceEl ?? resultsContainer,
        pmSkipBreakdownEl: pmSkipBreakdownEl ?? resultsContainer,
        pmMedianFinalBankrollEl: pmMedianFinalBankrollEl ?? resultsContainer,
        pmFinalBankrollP5El: pmFinalBankrollP5El ?? resultsContainer,
        
        // Confidence intervals table
        ciBody: ciBody ?? (resultsContainer.querySelector("tbody") as HTMLTableSectionElement),
        riskGrid: riskGrid ?? resultsContainer,
        riskFlagEl: riskFlagEl ?? resultsContainer,
        ddStressMultipleEl: ddStressMultipleEl ?? resultsContainer,
        riskDetailEl: riskDetailEl ?? resultsContainer,
        methodProfitHeader: methodProfitHeader ?? resultsContainer,
        methodComparisonBody: methodComparisonBody ?? (resultsContainer.querySelector("#mc-method-comparison-body") as HTMLTableSectionElement),
        ddPercentilesBody: ddPercentilesBody ?? (resultsContainer.querySelector("#mc-dd-percentiles-body") as HTMLTableSectionElement),
        
        // Histogram canvases
        profitHistogram: profitHistogram ?? (resultsContainer.querySelector("#mc-profit-histogram") as HTMLCanvasElement),
        ddHistogram: ddHistogram ?? (resultsContainer.querySelector("#mc-dd-histogram") as HTMLCanvasElement),
        sharpeHistogram: sharpeHistogram ?? (resultsContainer.querySelector("#mc-sharpe-histogram") as HTMLCanvasElement),
        profitDistTitle: profitDistTitle ?? resultsContainer,
        
        // Equity fan chart
        equityFan: equityFan ?? (resultsContainer.querySelector("#mc-equity-fan") as HTMLCanvasElement),
        fanLegend: fanLegend ?? resultsContainer,
        
        // Ruin analysis
        ruinRateEl: ruinRateEl ?? resultsContainer,
        expectedTradesToRuinEl: expectedTradesToRuinEl ?? resultsContainer,
        medianTradesToRuinEl: medianTradesToRuinEl ?? resultsContainer,
        dd95El: dd95El ?? resultsContainer,
        
        // Distribution stats
        profitStats: profitStats ?? resultsContainer,
        ddStats: ddStats ?? resultsContainer,
        sharpeStats: sharpeStats ?? resultsContainer,
        
        // Sensitivity section
        sensitivityHeader: sensitivityHeader ?? resultsContainer,
        sensitivitySection: sensitivitySection ?? resultsContainer,
        sensitivityGrid: sensitivityGrid ?? resultsContainer,
    };
}
