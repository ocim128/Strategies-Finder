import { getOptionalElement, getRequiredElement } from "./dom-utils";

export const UI_EVENT_HANDLER_REQUIRED_IDS = [
    "symbolSelector",
    "symbolDropdown",
    "themeToggle",
    "strategySelect",
    "strategyTabs",
    "panelContent",
    "runBacktest",
    "clearTradesBtn",
    "togglePanel",
    "strategyPanel",
    "zoomInTool",
    "zoomOutTool",
    "fitTool",
    "riskSettingsToggle",
    "riskSettings",
    "tradeFilterSettingsToggle",
    "tradeFilterSettings",
    "riskMode",
    "riskAdvanced",
    "tradeDirection",
    "flipAfterConsecutiveLosses",
    "flipCooldownTrades",
    "minTradesBeforeFirstFlip",
    "tradeFilterMode",
    "htfBiasEmaPeriod",
    "confirmLookback",
    "volumeSmaPeriod",
    "volumeMultiplier",
    "confirmRsiPeriod",
    "confirmRsiBullish",
    "confirmRsiBearish",
    "strategyTimeframeToggle",
    "strategyTimeframeMinutes",
    "finderTradesToggle",
    "finderTradeFilters",
    "fixedTradeToggle",
    "initialCapitalGroup",
    "fixedTradeGroup",
    "positionSizeGroup",
    "initialCapital",
    "fixedTradeAmount",
    "positionSize",
    "panelResizeHandle",
] as const;

export interface UiEventHandlersDom {
    symbolSelector: HTMLElement;
    symbolDropdown: HTMLElement;
    symbolSearchInput: HTMLInputElement | null;
    symbolSearchResults: HTMLElement | null;
    symbolSearchSpinner: HTMLElement | null;
    symbolSearchClear: HTMLElement | null;
    symbolSearchLoading: HTMLElement | null;
    symbolSearchEmpty: HTMLElement | null;
    localSp500Select: HTMLSelectElement | null;
    mockModelSelect: HTMLSelectElement | null;
    mockBarsInput: HTMLInputElement | null;
    chartModeToggle: HTMLButtonElement | null;
    chartModeLabel: HTMLElement | null;
    timeframeMinutesInput: HTMLInputElement | null;
    timeframeMinutesApply: HTMLElement | null;
    visibleCandlesInput: HTMLInputElement | null;
    visibleCandlesApply: HTMLElement | null;
    themeToggle: HTMLElement;
    strategySelect: HTMLSelectElement;
    strategyTabs: HTMLElement;
    panelContent: HTMLElement;
    runBacktest: HTMLElement;
    clearTradesBtn: HTMLElement;
    togglePanel: HTMLElement;
    strategyPanel: HTMLElement;
    zoomInTool: HTMLElement;
    zoomOutTool: HTMLElement;
    fitTool: HTMLElement;
    screenshotTool: HTMLElement | null;
    copyChartBtn: HTMLElement | null;
    riskSettingsToggle: HTMLInputElement;
    riskSettings: HTMLElement;
    tradeFilterSettingsToggle: HTMLInputElement;
    tradeFilterSettings: HTMLElement;
    riskMode: HTMLSelectElement;
    riskSimpleAdvanced: HTMLElement | null;
    riskPercentage: HTMLElement | null;
    riskAdvanced: HTMLElement;
    tradeDirection: HTMLSelectElement;
    flipLossStreakSettingsRow: HTMLElement | null;
    flipAfterConsecutiveLosses: HTMLInputElement;
    flipCooldownTrades: HTMLInputElement;
    minTradesBeforeFirstFlip: HTMLInputElement;
    tradeFilterMode: HTMLSelectElement;
    htfBiasEmaPeriod: HTMLInputElement;
    confirmLookback: HTMLInputElement;
    volumeSmaPeriod: HTMLInputElement;
    volumeMultiplier: HTMLInputElement;
    confirmRsiPeriod: HTMLInputElement;
    confirmRsiBullish: HTMLInputElement;
    confirmRsiBearish: HTMLInputElement;
    strategyTimeframeToggle: HTMLInputElement;
    strategyTimeframeMinutes: HTMLInputElement;
    strategyTimeframeMinutesGroup: HTMLElement | null;
    twoHourCloseParity: HTMLSelectElement | null;
    finderTradesToggle: HTMLInputElement;
    finderTradeFilters: HTMLElement;
    fixedTradeToggle: HTMLInputElement;
    initialCapitalGroup: HTMLElement;
    fixedTradeGroup: HTMLElement;
    positionSizeGroup: HTMLElement;
    initialCapital: HTMLInputElement;
    fixedTradeAmount: HTMLInputElement;
    positionSize: HTMLInputElement;
    panelResizeHandle: HTMLElement;
}

export function createUiEventHandlersDom(): UiEventHandlersDom {
    return {
        symbolSelector: getRequiredElement("symbolSelector"),
        symbolDropdown: getRequiredElement("symbolDropdown"),
        symbolSearchInput: getOptionalElement<HTMLInputElement>("symbolSearchInput"),
        symbolSearchResults: getOptionalElement("symbolSearchResults"),
        symbolSearchSpinner: getOptionalElement("symbolSearchSpinner"),
        symbolSearchClear: getOptionalElement("symbolSearchClear"),
        symbolSearchLoading: getOptionalElement("symbolSearchLoading"),
        symbolSearchEmpty: getOptionalElement("symbolSearchEmpty"),
        localSp500Select: getOptionalElement<HTMLSelectElement>("localSp500Select"),
        mockModelSelect: getOptionalElement<HTMLSelectElement>("mockModelSelect"),
        mockBarsInput: getOptionalElement<HTMLInputElement>("mockBarsInput"),
        chartModeToggle: getOptionalElement<HTMLButtonElement>("chartModeToggle"),
        chartModeLabel: getOptionalElement("chartModeLabel"),
        timeframeMinutesInput: getOptionalElement<HTMLInputElement>("timeframeMinutesInput"),
        timeframeMinutesApply: getOptionalElement("timeframeMinutesApply"),
        visibleCandlesInput: getOptionalElement<HTMLInputElement>("visibleCandlesInput"),
        visibleCandlesApply: getOptionalElement("visibleCandlesApply"),
        themeToggle: getRequiredElement("themeToggle"),
        strategySelect: getRequiredElement<HTMLSelectElement>("strategySelect"),
        strategyTabs: getRequiredElement("strategyTabs"),
        panelContent: getRequiredElement("panelContent"),
        runBacktest: getRequiredElement("runBacktest"),
        clearTradesBtn: getRequiredElement("clearTradesBtn"),
        togglePanel: getRequiredElement("togglePanel"),
        strategyPanel: getRequiredElement("strategyPanel"),
        zoomInTool: getRequiredElement("zoomInTool"),
        zoomOutTool: getRequiredElement("zoomOutTool"),
        fitTool: getRequiredElement("fitTool"),
        screenshotTool: getOptionalElement("screenshotTool"),
        copyChartBtn: getOptionalElement("copyChartBtn"),
        riskSettingsToggle: getRequiredElement<HTMLInputElement>("riskSettingsToggle"),
        riskSettings: getRequiredElement("riskSettings"),
        tradeFilterSettingsToggle: getRequiredElement<HTMLInputElement>("tradeFilterSettingsToggle"),
        tradeFilterSettings: getRequiredElement("tradeFilterSettings"),
        riskMode: getRequiredElement<HTMLSelectElement>("riskMode"),
        riskSimpleAdvanced: getOptionalElement("riskSimpleAdvanced"),
        riskPercentage: getOptionalElement("riskPercentage"),
        riskAdvanced: getRequiredElement("riskAdvanced"),
        tradeDirection: getRequiredElement<HTMLSelectElement>("tradeDirection"),
        flipLossStreakSettingsRow: getOptionalElement("flipLossStreakSettingsRow"),
        flipAfterConsecutiveLosses: getRequiredElement<HTMLInputElement>("flipAfterConsecutiveLosses"),
        flipCooldownTrades: getRequiredElement<HTMLInputElement>("flipCooldownTrades"),
        minTradesBeforeFirstFlip: getRequiredElement<HTMLInputElement>("minTradesBeforeFirstFlip"),
        tradeFilterMode: getRequiredElement<HTMLSelectElement>("tradeFilterMode"),
        htfBiasEmaPeriod: getRequiredElement<HTMLInputElement>("htfBiasEmaPeriod"),
        confirmLookback: getRequiredElement<HTMLInputElement>("confirmLookback"),
        volumeSmaPeriod: getRequiredElement<HTMLInputElement>("volumeSmaPeriod"),
        volumeMultiplier: getRequiredElement<HTMLInputElement>("volumeMultiplier"),
        confirmRsiPeriod: getRequiredElement<HTMLInputElement>("confirmRsiPeriod"),
        confirmRsiBullish: getRequiredElement<HTMLInputElement>("confirmRsiBullish"),
        confirmRsiBearish: getRequiredElement<HTMLInputElement>("confirmRsiBearish"),
        strategyTimeframeToggle: getRequiredElement<HTMLInputElement>("strategyTimeframeToggle"),
        strategyTimeframeMinutes: getRequiredElement<HTMLInputElement>("strategyTimeframeMinutes"),
        strategyTimeframeMinutesGroup: getOptionalElement("strategyTimeframeMinutesGroup"),
        twoHourCloseParity: getOptionalElement<HTMLSelectElement>("twoHourCloseParity"),
        finderTradesToggle: getRequiredElement<HTMLInputElement>("finderTradesToggle"),
        finderTradeFilters: getRequiredElement("finderTradeFilters"),
        fixedTradeToggle: getRequiredElement<HTMLInputElement>("fixedTradeToggle"),
        initialCapitalGroup: getRequiredElement("initialCapitalGroup"),
        fixedTradeGroup: getRequiredElement("fixedTradeGroup"),
        positionSizeGroup: getRequiredElement("positionSizeGroup"),
        initialCapital: getRequiredElement<HTMLInputElement>("initialCapital"),
        fixedTradeAmount: getRequiredElement<HTMLInputElement>("fixedTradeAmount"),
        positionSize: getRequiredElement<HTMLInputElement>("positionSize"),
        panelResizeHandle: getRequiredElement("panelResizeHandle"),
    };
}

export interface StrategyPanelDom {
    togglePanel: HTMLElement;
    strategyPanel: HTMLElement;
    strategyTabs: HTMLElement;
    panelContent: HTMLElement;
    panelResizeHandle: HTMLElement;
}

export function createStrategyPanelDom(): StrategyPanelDom {
    return {
        togglePanel: getRequiredElement("togglePanel"),
        strategyPanel: getRequiredElement("strategyPanel"),
        strategyTabs: getRequiredElement("strategyTabs"),
        panelContent: getRequiredElement("panelContent"),
        panelResizeHandle: getRequiredElement("panelResizeHandle"),
    };
}

export const SETTINGS_WORKSPACE_REQUIRED_IDS = [
    "settingsTab",
    "strategyWorkspaceHeader",
    "strategyWorkspaceSections",
    "strategyMetaName",
    "strategyMetaDescription",
    "strategyMetaKey",
    "strategyParamCount",
] as const;

export interface SettingsWorkspaceDom {
    settingsTab: HTMLElement;
    strategyWorkspaceHeader: HTMLElement;
    strategyWorkspaceSections: HTMLElement;
    strategyMetaName: HTMLElement;
    strategyMetaDescription: HTMLElement;
    strategyMetaKey: HTMLElement;
    strategyParamCount: HTMLElement;
}

export function createSettingsWorkspaceDom(): SettingsWorkspaceDom {
    return {
        settingsTab: getRequiredElement("settingsTab"),
        strategyWorkspaceHeader: getRequiredElement("strategyWorkspaceHeader"),
        strategyWorkspaceSections: getRequiredElement("strategyWorkspaceSections"),
        strategyMetaName: getRequiredElement("strategyMetaName"),
        strategyMetaDescription: getRequiredElement("strategyMetaDescription"),
        strategyMetaKey: getRequiredElement("strategyMetaKey"),
        strategyParamCount: getRequiredElement("strategyParamCount"),
    };
}

export const ANALYSIS_PANEL_REQUIRED_IDS = [
    "emptyAnalysis",
    "analysisContent",
    "analysisSummary",
    "analysisSimulation",
    "simulationGrid",
    "analysisTableBody",
    "comboFilterSection",
    "comboFilterGrid",
    "analysisRunFinderBtn",
    "analysisFinderStatus",
    "analysisFinderResults",
    "analysisFinderBestGrid",
    "analysisFinderTopBody",
    "analysisEntryShapes",
    "analysisEntryShapeMaxCandles",
    "analysisWinsShapeCanvas",
    "analysisLossesShapeCanvas",
    "analysisWinsShapeMeta",
    "analysisLossesShapeMeta",
    "analysisRelaxModeToggle",
    "analysisMaxRemovalPercent",
    "runAnalysisBtn",
    "analysisRenderEntryShapesBtn",
    "analysisDownloadWinsShapeBtn",
    "analysisDownloadLossesShapeBtn",
    "analysisTab",
] as const;

export interface AnalysisPanelDom {
    emptyAnalysis: HTMLElement;
    analysisContent: HTMLElement;
    analysisSummary: HTMLElement;
    analysisSimulation: HTMLElement;
    simulationGrid: HTMLElement;
    analysisTableBody: HTMLElement;
    comboFilterSection: HTMLElement;
    comboFilterGrid: HTMLElement;
    analysisRunFinderBtn: HTMLButtonElement;
    analysisFinderStatus: HTMLElement;
    analysisFinderResults: HTMLElement;
    analysisFinderBestGrid: HTMLElement;
    analysisFinderTopBody: HTMLElement;
    analysisEntryShapes: HTMLElement;
    analysisEntryShapeMaxCandles: HTMLInputElement;
    analysisWinsShapeCanvas: HTMLCanvasElement;
    analysisLossesShapeCanvas: HTMLCanvasElement;
    analysisWinsShapeMeta: HTMLElement;
    analysisLossesShapeMeta: HTMLElement;
    analysisRelaxModeToggle: HTMLInputElement;
    analysisMaxRemovalPercent: HTMLInputElement;
    runAnalysisBtn: HTMLButtonElement;
    analysisRenderEntryShapesBtn: HTMLButtonElement;
    analysisDownloadWinsShapeBtn: HTMLButtonElement;
    analysisDownloadLossesShapeBtn: HTMLButtonElement;
    analysisTab: HTMLElement;
}

export function createAnalysisPanelDom(): AnalysisPanelDom {
    return {
        emptyAnalysis: getRequiredElement("emptyAnalysis"),
        analysisContent: getRequiredElement("analysisContent"),
        analysisSummary: getRequiredElement("analysisSummary"),
        analysisSimulation: getRequiredElement("analysisSimulation"),
        simulationGrid: getRequiredElement("simulationGrid"),
        analysisTableBody: getRequiredElement("analysisTableBody"),
        comboFilterSection: getRequiredElement("comboFilterSection"),
        comboFilterGrid: getRequiredElement("comboFilterGrid"),
        analysisRunFinderBtn: getRequiredElement<HTMLButtonElement>("analysisRunFinderBtn"),
        analysisFinderStatus: getRequiredElement("analysisFinderStatus"),
        analysisFinderResults: getRequiredElement("analysisFinderResults"),
        analysisFinderBestGrid: getRequiredElement("analysisFinderBestGrid"),
        analysisFinderTopBody: getRequiredElement("analysisFinderTopBody"),
        analysisEntryShapes: getRequiredElement("analysisEntryShapes"),
        analysisEntryShapeMaxCandles: getRequiredElement<HTMLInputElement>("analysisEntryShapeMaxCandles"),
        analysisWinsShapeCanvas: getRequiredElement<HTMLCanvasElement>("analysisWinsShapeCanvas"),
        analysisLossesShapeCanvas: getRequiredElement<HTMLCanvasElement>("analysisLossesShapeCanvas"),
        analysisWinsShapeMeta: getRequiredElement("analysisWinsShapeMeta"),
        analysisLossesShapeMeta: getRequiredElement("analysisLossesShapeMeta"),
        analysisRelaxModeToggle: getRequiredElement<HTMLInputElement>("analysisRelaxModeToggle"),
        analysisMaxRemovalPercent: getRequiredElement<HTMLInputElement>("analysisMaxRemovalPercent"),
        runAnalysisBtn: getRequiredElement<HTMLButtonElement>("runAnalysisBtn"),
        analysisRenderEntryShapesBtn: getRequiredElement<HTMLButtonElement>("analysisRenderEntryShapesBtn"),
        analysisDownloadWinsShapeBtn: getRequiredElement<HTMLButtonElement>("analysisDownloadWinsShapeBtn"),
        analysisDownloadLossesShapeBtn: getRequiredElement<HTMLButtonElement>("analysisDownloadLossesShapeBtn"),
        analysisTab: getRequiredElement("analysisTab"),
    };
}

export const FINDER_MANAGER_REQUIRED_IDS = [
    "runFinder",
    "finderCopyTopResults",
    "finderSaveSeedAudit",
    "finderList",
    "finderStrategiesToggleAll",
    "finderSort",
    "finderSortSecondary",
    "finderAdvancedToggle",
    "finderSimpleSort",
    "finderSortList",
    "finderMultiTimeframeToggle",
    "finderMultiTimeframeAdd",
    "finderMultiTimeframeCustomAdd",
    "finderMultiTimeframeCustom",
    "finderMultiTimeframeSelected",
    "finderComboToggle",
    "finderComboPrimarySelect",
    "finderComboSettings",
    "finderMultiTimeframeSelect",
    "finderMultiTimeframeNote",
    "finderMultiTimeframeSettings",
    "finderStrategyList",
    "finderMode",
    "finderTopN",
    "finderSteps",
    "finderRobustSeed",
    "finderRange",
    "finderMaxRuns",
    "finderTradesToggle",
    "finderTradesMin",
    "finderTradesMax",
] as const;

export interface FinderManagerDom {
    runFinder: HTMLButtonElement;
    finderCopyTopResults: HTMLButtonElement;
    finderSaveSeedAudit: HTMLButtonElement;
    finderList: HTMLElement;
    finderStrategiesToggleAll: HTMLInputElement;
    finderSort: HTMLSelectElement;
    finderSortSecondary: HTMLSelectElement;
    finderAdvancedToggle: HTMLInputElement;
    finderSimpleSort: HTMLElement;
    finderSortList: HTMLElement;
    finderMultiTimeframeToggle: HTMLInputElement;
    finderMultiTimeframeAdd: HTMLButtonElement;
    finderMultiTimeframeCustomAdd: HTMLButtonElement;
    finderMultiTimeframeCustom: HTMLInputElement;
    finderMultiTimeframeSelected: HTMLElement;
    finderComboToggle: HTMLInputElement;
    finderComboPrimarySelect: HTMLSelectElement;
    finderComboSettings: HTMLElement;
    finderMultiTimeframeSelect: HTMLSelectElement;
    finderMultiTimeframeNote: HTMLElement;
    finderMultiTimeframeSettings: HTMLElement;
    finderStrategyList: HTMLElement;
    finderMode: HTMLSelectElement;
    finderTopN: HTMLInputElement;
    finderSteps: HTMLInputElement;
    finderRobustSeed: HTMLInputElement;
    finderRange: HTMLInputElement;
    finderMaxRuns: HTMLInputElement;
    finderTradesToggle: HTMLInputElement;
    finderTradesMin: HTMLInputElement;
    finderTradesMax: HTMLInputElement;
}

export function createFinderManagerDom(): FinderManagerDom {
    return {
        runFinder: getRequiredElement<HTMLButtonElement>("runFinder"),
        finderCopyTopResults: getRequiredElement<HTMLButtonElement>("finderCopyTopResults"),
        finderSaveSeedAudit: getRequiredElement<HTMLButtonElement>("finderSaveSeedAudit"),
        finderList: getRequiredElement("finderList"),
        finderStrategiesToggleAll: getRequiredElement<HTMLInputElement>("finderStrategiesToggleAll"),
        finderSort: getRequiredElement<HTMLSelectElement>("finderSort"),
        finderSortSecondary: getRequiredElement<HTMLSelectElement>("finderSortSecondary"),
        finderAdvancedToggle: getRequiredElement<HTMLInputElement>("finderAdvancedToggle"),
        finderSimpleSort: getRequiredElement("finderSimpleSort"),
        finderSortList: getRequiredElement("finderSortList"),
        finderMultiTimeframeToggle: getRequiredElement<HTMLInputElement>("finderMultiTimeframeToggle"),
        finderMultiTimeframeAdd: getRequiredElement<HTMLButtonElement>("finderMultiTimeframeAdd"),
        finderMultiTimeframeCustomAdd: getRequiredElement<HTMLButtonElement>("finderMultiTimeframeCustomAdd"),
        finderMultiTimeframeCustom: getRequiredElement<HTMLInputElement>("finderMultiTimeframeCustom"),
        finderMultiTimeframeSelected: getRequiredElement("finderMultiTimeframeSelected"),
        finderComboToggle: getRequiredElement<HTMLInputElement>("finderComboToggle"),
        finderComboPrimarySelect: getRequiredElement<HTMLSelectElement>("finderComboPrimarySelect"),
        finderComboSettings: getRequiredElement("finderComboSettings"),
        finderMultiTimeframeSelect: getRequiredElement<HTMLSelectElement>("finderMultiTimeframeSelect"),
        finderMultiTimeframeNote: getRequiredElement("finderMultiTimeframeNote"),
        finderMultiTimeframeSettings: getRequiredElement("finderMultiTimeframeSettings"),
        finderStrategyList: getRequiredElement("finderStrategyList"),
        finderMode: getRequiredElement<HTMLSelectElement>("finderMode"),
        finderTopN: getRequiredElement<HTMLInputElement>("finderTopN"),
        finderSteps: getRequiredElement<HTMLInputElement>("finderSteps"),
        finderRobustSeed: getRequiredElement<HTMLInputElement>("finderRobustSeed"),
        finderRange: getRequiredElement<HTMLInputElement>("finderRange"),
        finderMaxRuns: getRequiredElement<HTMLInputElement>("finderMaxRuns"),
        finderTradesToggle: getRequiredElement<HTMLInputElement>("finderTradesToggle"),
        finderTradesMin: getRequiredElement<HTMLInputElement>("finderTradesMin"),
        finderTradesMax: getRequiredElement<HTMLInputElement>("finderTradesMax"),
    };
}

export const PAIR_COMBINER_BRIDGE_REQUIRED_IDS = [
    "combinerPrimarySelect",
    "combinerSecondarySelect",
    "combinerMode",
] as const;

export interface PairCombinerBridgeDom {
    combinerPrimarySelect: HTMLSelectElement;
    combinerSecondarySelect: HTMLSelectElement;
    combinerMode: HTMLSelectElement;
}

export function createPairCombinerBridgeDom(): PairCombinerBridgeDom {
    return {
        combinerPrimarySelect: getRequiredElement<HTMLSelectElement>("combinerPrimarySelect"),
        combinerSecondarySelect: getRequiredElement<HTMLSelectElement>("combinerSecondarySelect"),
        combinerMode: getRequiredElement<HTMLSelectElement>("combinerMode"),
    };
}

export const WALK_FORWARD_SERVICE_REQUIRED_IDS = [
    "wf-opt-window",
    "wf-test-window",
    "wf-step-size",
    "wf-min-trades",
    "wf-auto-suggest",
    "wf-validation-seeds",
    "wf-validation-min-passes",
    "wf-validation-max-dd",
    "wf-validation-panel",
    "wf-top-n",
    "wf-summary-panel",
    "wf-window-table-body",
    "wf-robustness-gauge",
    "wf-robustness-score",
    "wf-robustness-desc",
    "wf-run-btn",
    "wf-quick-btn",
    "wf-validate-btn",
    "wf-cancel-btn",
    "wf-spinner",
    "wf-quick-spinner",
    "wf-validate-spinner",
    "wf-status",
] as const;

export interface WalkForwardServiceDom {
    wfOptWindow: HTMLInputElement;
    wfTestWindow: HTMLInputElement;
    wfStepSize: HTMLInputElement;
    wfMinTrades: HTMLInputElement;
    wfAutoSuggest: HTMLInputElement;
    wfValidationSeeds: HTMLInputElement;
    wfValidationMinPasses: HTMLInputElement;
    wfValidationMaxDd: HTMLInputElement;
    wfValidationPanel: HTMLElement;
    wfTopN: HTMLInputElement;
    wfSummaryPanel: HTMLElement;
    wfWindowTableBody: HTMLElement;
    wfRobustnessGauge: HTMLElement;
    wfRobustnessScore: HTMLElement;
    wfRobustnessDesc: HTMLElement;
    wfRunBtn: HTMLButtonElement;
    wfQuickBtn: HTMLButtonElement;
    wfValidateBtn: HTMLButtonElement;
    wfCancelBtn: HTMLButtonElement;
    wfSpinner: HTMLElement;
    wfQuickSpinner: HTMLElement;
    wfValidateSpinner: HTMLElement;
    wfStatus: HTMLElement;
}

export function createWalkForwardServiceDom(): WalkForwardServiceDom {
    return {
        wfOptWindow: getRequiredElement<HTMLInputElement>("wf-opt-window"),
        wfTestWindow: getRequiredElement<HTMLInputElement>("wf-test-window"),
        wfStepSize: getRequiredElement<HTMLInputElement>("wf-step-size"),
        wfMinTrades: getRequiredElement<HTMLInputElement>("wf-min-trades"),
        wfAutoSuggest: getRequiredElement<HTMLInputElement>("wf-auto-suggest"),
        wfValidationSeeds: getRequiredElement<HTMLInputElement>("wf-validation-seeds"),
        wfValidationMinPasses: getRequiredElement<HTMLInputElement>("wf-validation-min-passes"),
        wfValidationMaxDd: getRequiredElement<HTMLInputElement>("wf-validation-max-dd"),
        wfValidationPanel: getRequiredElement("wf-validation-panel"),
        wfTopN: getRequiredElement<HTMLInputElement>("wf-top-n"),
        wfSummaryPanel: getRequiredElement("wf-summary-panel"),
        wfWindowTableBody: getRequiredElement("wf-window-table-body"),
        wfRobustnessGauge: getRequiredElement("wf-robustness-gauge"),
        wfRobustnessScore: getRequiredElement("wf-robustness-score"),
        wfRobustnessDesc: getRequiredElement("wf-robustness-desc"),
        wfRunBtn: getRequiredElement<HTMLButtonElement>("wf-run-btn"),
        wfQuickBtn: getRequiredElement<HTMLButtonElement>("wf-quick-btn"),
        wfValidateBtn: getRequiredElement<HTMLButtonElement>("wf-validate-btn"),
        wfCancelBtn: getRequiredElement<HTMLButtonElement>("wf-cancel-btn"),
        wfSpinner: getRequiredElement("wf-spinner"),
        wfQuickSpinner: getRequiredElement("wf-quick-spinner"),
        wfValidateSpinner: getRequiredElement("wf-validate-spinner"),
        wfStatus: getRequiredElement("wf-status"),
    };
}
