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
    "takeProfitMode",
    "takeProfitShrinkageSettingsRow",
    "takeProfitMfeLookbackTrades",
    "takeProfitMfePercentile",
    "takeProfitShrinkageStrength",
    "riskAdvanced",
    "tradeDirection",
    "flipAfterConsecutiveLosses",
    "flipCooldownTrades",
    "minTradesBeforeFirstFlip",
    "tradeFilterMode",
    "htfBiasEmaPeriod",
    "executionTrendEmaPeriod",
    "confirmLookback",
    "trendPersistenceWindow",
    "trendPersistenceMinBars",
    "trendSlopeLookback",
    "trendSlopeMinPercent",
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
    "tradeSizingModeGroup",
    "positionSizeGroup",
    "initialCapital",
    "tradeSizingMode",
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
    takeProfitMode: HTMLSelectElement;
    takeProfitShrinkageSettingsRow: HTMLElement;
    takeProfitMfeLookbackTrades: HTMLInputElement;
    takeProfitMfePercentile: HTMLInputElement;
    takeProfitShrinkageStrength: HTMLInputElement;
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
    executionTrendEmaPeriod: HTMLInputElement;
    confirmLookback: HTMLInputElement;
    trendPersistenceWindow: HTMLInputElement;
    trendPersistenceMinBars: HTMLInputElement;
    trendSlopeLookback: HTMLInputElement;
    trendSlopeMinPercent: HTMLInputElement;
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
    tradeSizingModeGroup: HTMLElement;
    positionSizeGroup: HTMLElement;
    initialCapital: HTMLInputElement;
    tradeSizingMode: HTMLSelectElement;
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
        takeProfitMode: getRequiredElement<HTMLSelectElement>("takeProfitMode"),
        takeProfitShrinkageSettingsRow: getRequiredElement("takeProfitShrinkageSettingsRow"),
        takeProfitMfeLookbackTrades: getRequiredElement<HTMLInputElement>("takeProfitMfeLookbackTrades"),
        takeProfitMfePercentile: getRequiredElement<HTMLInputElement>("takeProfitMfePercentile"),
        takeProfitShrinkageStrength: getRequiredElement<HTMLInputElement>("takeProfitShrinkageStrength"),
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
        executionTrendEmaPeriod: getRequiredElement<HTMLInputElement>("executionTrendEmaPeriod"),
        confirmLookback: getRequiredElement<HTMLInputElement>("confirmLookback"),
        trendPersistenceWindow: getRequiredElement<HTMLInputElement>("trendPersistenceWindow"),
        trendPersistenceMinBars: getRequiredElement<HTMLInputElement>("trendPersistenceMinBars"),
        trendSlopeLookback: getRequiredElement<HTMLInputElement>("trendSlopeLookback"),
        trendSlopeMinPercent: getRequiredElement<HTMLInputElement>("trendSlopeMinPercent"),
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
        tradeSizingModeGroup: getRequiredElement("tradeSizingModeGroup"),
        positionSizeGroup: getRequiredElement("positionSizeGroup"),
        initialCapital: getRequiredElement<HTMLInputElement>("initialCapital"),
        tradeSizingMode: getRequiredElement<HTMLSelectElement>("tradeSizingMode"),
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

export const UI_MANAGER_REQUIRED_IDS = [
    "symbolDataSource",
    "symbolPrice",
    "symbolChange",
    "ohlcOpen",
    "ohlcHigh",
    "ohlcLow",
    "ohlcClose",
    "ohlcVolume",
    "ohlcChange",
    "ohlcChangeValue",
    "lastBacktestResult",
    "tradeBadge",
    "strategySelect",
    "timeframeCustom",
    "timeframeMinutesInput",
    "indicatorsPanel",
    "strategyStatus",
] as const;

export interface UiManagerDom {
    symbolDataSource: HTMLElement;
    symbolPrice: HTMLElement;
    symbolChange: HTMLElement;
    ohlcOpen: HTMLElement;
    ohlcHigh: HTMLElement;
    ohlcLow: HTMLElement;
    ohlcClose: HTMLElement;
    ohlcVolume: HTMLElement;
    ohlcChange: HTMLElement;
    ohlcChangeValue: HTMLElement;
    lastBacktestResult: HTMLElement;
    tradeBadge: HTMLElement;
    strategySelect: HTMLSelectElement;
    timeframeCustom: HTMLElement;
    timeframeMinutesInput: HTMLInputElement;
    indicatorsPanel: HTMLElement;
    strategyStatus: HTMLElement;
}

export function createUiManagerDom(): UiManagerDom {
    return {
        symbolDataSource: getRequiredElement("symbolDataSource"),
        symbolPrice: getRequiredElement("symbolPrice"),
        symbolChange: getRequiredElement("symbolChange"),
        ohlcOpen: getRequiredElement("ohlcOpen"),
        ohlcHigh: getRequiredElement("ohlcHigh"),
        ohlcLow: getRequiredElement("ohlcLow"),
        ohlcClose: getRequiredElement("ohlcClose"),
        ohlcVolume: getRequiredElement("ohlcVolume"),
        ohlcChange: getRequiredElement("ohlcChange"),
        ohlcChangeValue: getRequiredElement("ohlcChangeValue"),
        lastBacktestResult: getRequiredElement("lastBacktestResult"),
        tradeBadge: getRequiredElement("tradeBadge"),
        strategySelect: getRequiredElement<HTMLSelectElement>("strategySelect"),
        timeframeCustom: getRequiredElement("timeframeCustom"),
        timeframeMinutesInput: getRequiredElement<HTMLInputElement>("timeframeMinutesInput"),
        indicatorsPanel: getRequiredElement("indicatorsPanel"),
        strategyStatus: getRequiredElement("strategyStatus"),
    };
}

export const RESULTS_RENDERER_REQUIRED_IDS = [
    "netProfitCard",
    "netProfitPctCard",
    "entryLevelsBody",
    "parityComparePanel",
    "parityCompareGrid",
    "parityCompareHint",
    "postEntryPathContainer",
    "postEntryPathHint",
    "snapshotProfileContainer",
    "exitReasonContainer",
    "edgeAnalysisContainer",
] as const;

export interface ResultsRendererDom {
    netProfitCard: HTMLElement;
    netProfitPctCard: HTMLElement;
    entryLevelsBody: HTMLElement;
    parityComparePanel: HTMLElement;
    parityCompareGrid: HTMLElement;
    parityCompareHint: HTMLElement;
    postEntryPathContainer: HTMLElement;
    postEntryPathHint: HTMLElement;
    snapshotProfileContainer: HTMLElement;
    exitReasonContainer: HTMLElement;
    edgeAnalysisContainer: HTMLElement;
}

export function createResultsRendererDom(): ResultsRendererDom {
    return {
        netProfitCard: getRequiredElement("netProfitCard"),
        netProfitPctCard: getRequiredElement("netProfitPctCard"),
        entryLevelsBody: getRequiredElement("entryLevelsBody"),
        parityComparePanel: getRequiredElement("parityComparePanel"),
        parityCompareGrid: getRequiredElement("parityCompareGrid"),
        parityCompareHint: getRequiredElement("parityCompareHint"),
        postEntryPathContainer: getRequiredElement("postEntryPathContainer"),
        postEntryPathHint: getRequiredElement("postEntryPathHint"),
        snapshotProfileContainer: getRequiredElement("snapshotProfileContainer"),
        exitReasonContainer: getRequiredElement("exitReasonContainer"),
        edgeAnalysisContainer: getRequiredElement("edgeAnalysisContainer"),
    };
}

export const TRADES_RENDERER_REQUIRED_IDS = [
    "tradesList",
    "tradesTotalPnL",
    "tradesWinRate",
] as const;

export interface TradesRendererDom {
    tradesList: HTMLElement;
    tradesTotalPnL: HTMLElement;
    tradesWinRate: HTMLElement;
}

export function createTradesRendererDom(): TradesRendererDom {
    return {
        tradesList: getRequiredElement("tradesList"),
        tradesTotalPnL: getRequiredElement("tradesTotalPnL"),
        tradesWinRate: getRequiredElement("tradesWinRate"),
    };
}

export const SETTINGS_MANAGER_REQUIRED_IDS = [
    "strategySelect",
    "settingsTab",
    "riskMode",
    "takeProfitMode",
    "tradeFilterMode",
    "tradeDirection",
    "twoHourCloseParity",
] as const;

export interface SettingsManagerDom {
    strategySelect: HTMLSelectElement;
    settingsTab: HTMLElement;
    riskMode: HTMLElement;
    takeProfitMode: HTMLElement;
    tradeFilterMode: HTMLElement;
    tradeDirection: HTMLElement;
    twoHourCloseParity: HTMLElement | null;
}

export function createSettingsManagerDom(): SettingsManagerDom {
    return {
        strategySelect: getRequiredElement<HTMLSelectElement>("strategySelect"),
        settingsTab: getRequiredElement("settingsTab"),
        riskMode: getRequiredElement("riskMode"),
        takeProfitMode: getRequiredElement("takeProfitMode"),
        tradeFilterMode: getRequiredElement("tradeFilterMode"),
        tradeDirection: getRequiredElement("tradeDirection"),
        twoHourCloseParity: getOptionalElement("twoHourCloseParity"),
    };
}



export const PORTFOLIO_LAB_REQUIRED_IDS = [
    "portfolioTab",
    "portfolioEmpty",
    "portfolioContent",
    "portfolioSymbolList",
    "portfolioBenchmarkSymbol",
    "portfolioAnchorSymbol",
    "portfolioLookbackBars",
    "portfolioWindowMode",
    "portfolioConsensusLagBars",
    "portfolioConsensusMinSamples",
    "portfolioUseCurrentBtn",
    "portfolioFillMajorsBtn",
    "portfolioRunBtn",
    "portfolioStatus",
    "portfolioResults",
    "portfolioSummary",
    "portfolioLiveContextSection",
    "portfolioLiveContextSummary",
    "portfolioLiveContextDetails",
    "portfolioForecastSection",
    "portfolioForecastSummary",
    "portfolioForecastDetails",
    "portfolioForecastTableBody",
    "portfolioInsightSection",
    "portfolioInsights",
    "portfolioExecutionSection",
    "portfolioExecutionSummary",
    "portfolioConsensusSection",
    "portfolioConsensusSummary",
    "portfolioConsensusTableBody",
    "portfolioBreadthMinAgree",
    "portfolioMaxOppose",
    "portfolioRunBreadthBacktestBtn",
    "portfolioRunFilterBacktestBtn",
    "portfolioRunBreadthSweepBtn",
    "portfolioRunOppositionSweepBtn",
    "portfolioBreadthSweepSection",
    "portfolioBreadthSweepTableBody",
    "portfolioOppositionSweepSection",
    "portfolioOppositionSweepTableBody",
    "portfolioRankingSection",
    "portfolioRankingSummary",
    "portfolioRankingTableBody",
    "portfolioSizingSection",
    "portfolioSizingSummary",
    "portfolioSizingTableBody",
    "portfolioMatrixSection",
    "portfolioCorrelationMatrix",
    "portfolioPairsTableBody",
    "portfolioIntervalBadge",
    "portfolioStrategyBadge",
] as const;

export interface PortfolioLabDom {
    portfolioTab: HTMLElement;
    portfolioEmpty: HTMLElement;
    portfolioContent: HTMLElement;
    portfolioSymbolList: HTMLTextAreaElement;
    portfolioBenchmarkSymbol: HTMLInputElement;
    portfolioAnchorSymbol: HTMLInputElement;
    portfolioLookbackBars: HTMLInputElement;
    portfolioWindowMode: HTMLSelectElement;
    portfolioConsensusLagBars: HTMLInputElement;
    portfolioConsensusMinSamples: HTMLInputElement;
    portfolioUseCurrentBtn: HTMLButtonElement;
    portfolioFillMajorsBtn: HTMLButtonElement;
    portfolioRunBtn: HTMLButtonElement;
    portfolioStatus: HTMLElement;
    portfolioResults: HTMLElement;
    portfolioSummary: HTMLElement;
    portfolioLiveContextSection: HTMLElement;
    portfolioLiveContextSummary: HTMLElement;
    portfolioLiveContextDetails: HTMLElement;
    portfolioForecastSection: HTMLElement;
    portfolioForecastSummary: HTMLElement;
    portfolioForecastDetails: HTMLElement;
    portfolioForecastTableBody: HTMLElement;
    portfolioInsightSection: HTMLElement;
    portfolioInsights: HTMLElement;
    portfolioExecutionSection: HTMLElement;
    portfolioExecutionSummary: HTMLElement;
    portfolioConsensusSection: HTMLElement;
    portfolioConsensusSummary: HTMLElement;
    portfolioConsensusTableBody: HTMLElement;
    portfolioBreadthMinAgree: HTMLInputElement;
    portfolioMaxOppose: HTMLInputElement;
    portfolioRunBreadthBacktestBtn: HTMLButtonElement;
    portfolioRunFilterBacktestBtn: HTMLButtonElement;
    portfolioRunBreadthSweepBtn: HTMLButtonElement;
    portfolioRunOppositionSweepBtn: HTMLButtonElement;
    portfolioBreadthSweepSection: HTMLElement;
    portfolioBreadthSweepTableBody: HTMLElement;
    portfolioOppositionSweepSection: HTMLElement;
    portfolioOppositionSweepTableBody: HTMLElement;
    portfolioRankingSection: HTMLElement;
    portfolioRankingSummary: HTMLElement;
    portfolioRankingTableBody: HTMLElement;
    portfolioSizingSection: HTMLElement;
    portfolioSizingSummary: HTMLElement;
    portfolioSizingTableBody: HTMLElement;
    portfolioMatrixSection: HTMLElement;
    portfolioCorrelationMatrix: HTMLElement;
    portfolioPairsTableBody: HTMLElement;
    portfolioIntervalBadge: HTMLElement;
    portfolioStrategyBadge: HTMLElement;
}

export function createPortfolioLabDom(): PortfolioLabDom {
    return {
        portfolioTab: getRequiredElement("portfolioTab"),
        portfolioEmpty: getRequiredElement("portfolioEmpty"),
        portfolioContent: getRequiredElement("portfolioContent"),
        portfolioSymbolList: getRequiredElement<HTMLTextAreaElement>("portfolioSymbolList"),
        portfolioBenchmarkSymbol: getRequiredElement<HTMLInputElement>("portfolioBenchmarkSymbol"),
        portfolioAnchorSymbol: getRequiredElement<HTMLInputElement>("portfolioAnchorSymbol"),
        portfolioLookbackBars: getRequiredElement<HTMLInputElement>("portfolioLookbackBars"),
        portfolioWindowMode: getRequiredElement<HTMLSelectElement>("portfolioWindowMode"),
        portfolioConsensusLagBars: getRequiredElement<HTMLInputElement>("portfolioConsensusLagBars"),
        portfolioConsensusMinSamples: getRequiredElement<HTMLInputElement>("portfolioConsensusMinSamples"),
        portfolioUseCurrentBtn: getRequiredElement<HTMLButtonElement>("portfolioUseCurrentBtn"),
        portfolioFillMajorsBtn: getRequiredElement<HTMLButtonElement>("portfolioFillMajorsBtn"),
        portfolioRunBtn: getRequiredElement<HTMLButtonElement>("portfolioRunBtn"),
        portfolioStatus: getRequiredElement("portfolioStatus"),
        portfolioResults: getRequiredElement("portfolioResults"),
        portfolioSummary: getRequiredElement("portfolioSummary"),
        portfolioLiveContextSection: getRequiredElement("portfolioLiveContextSection"),
        portfolioLiveContextSummary: getRequiredElement("portfolioLiveContextSummary"),
        portfolioLiveContextDetails: getRequiredElement("portfolioLiveContextDetails"),
        portfolioForecastSection: getRequiredElement("portfolioForecastSection"),
        portfolioForecastSummary: getRequiredElement("portfolioForecastSummary"),
        portfolioForecastDetails: getRequiredElement("portfolioForecastDetails"),
        portfolioForecastTableBody: getRequiredElement("portfolioForecastTableBody"),
        portfolioInsightSection: getRequiredElement("portfolioInsightSection"),
        portfolioInsights: getRequiredElement("portfolioInsights"),
        portfolioExecutionSection: getRequiredElement("portfolioExecutionSection"),
        portfolioExecutionSummary: getRequiredElement("portfolioExecutionSummary"),
        portfolioConsensusSection: getRequiredElement("portfolioConsensusSection"),
        portfolioConsensusSummary: getRequiredElement("portfolioConsensusSummary"),
        portfolioConsensusTableBody: getRequiredElement("portfolioConsensusTableBody"),
        portfolioBreadthMinAgree: getRequiredElement<HTMLInputElement>("portfolioBreadthMinAgree"),
        portfolioMaxOppose: getRequiredElement<HTMLInputElement>("portfolioMaxOppose"),
        portfolioRunBreadthBacktestBtn: getRequiredElement<HTMLButtonElement>("portfolioRunBreadthBacktestBtn"),
        portfolioRunFilterBacktestBtn: getRequiredElement<HTMLButtonElement>("portfolioRunFilterBacktestBtn"),
        portfolioRunBreadthSweepBtn: getRequiredElement<HTMLButtonElement>("portfolioRunBreadthSweepBtn"),
        portfolioRunOppositionSweepBtn: getRequiredElement<HTMLButtonElement>("portfolioRunOppositionSweepBtn"),
        portfolioBreadthSweepSection: getRequiredElement("portfolioBreadthSweepSection"),
        portfolioBreadthSweepTableBody: getRequiredElement("portfolioBreadthSweepTableBody"),
        portfolioOppositionSweepSection: getRequiredElement("portfolioOppositionSweepSection"),
        portfolioOppositionSweepTableBody: getRequiredElement("portfolioOppositionSweepTableBody"),
        portfolioRankingSection: getRequiredElement("portfolioRankingSection"),
        portfolioRankingSummary: getRequiredElement("portfolioRankingSummary"),
        portfolioRankingTableBody: getRequiredElement("portfolioRankingTableBody"),
        portfolioSizingSection: getRequiredElement("portfolioSizingSection"),
        portfolioSizingSummary: getRequiredElement("portfolioSizingSummary"),
        portfolioSizingTableBody: getRequiredElement("portfolioSizingTableBody"),
        portfolioMatrixSection: getRequiredElement("portfolioMatrixSection"),
        portfolioCorrelationMatrix: getRequiredElement("portfolioCorrelationMatrix"),
        portfolioPairsTableBody: getRequiredElement("portfolioPairsTableBody"),
        portfolioIntervalBadge: getRequiredElement("portfolioIntervalBadge"),
        portfolioStrategyBadge: getRequiredElement("portfolioStrategyBadge"),
    };
}

export const FINDER_MANAGER_REQUIRED_IDS = [
    "runFinder",
    "finderCopyTopResults",
    "finderSaveSeedAudit",
    "finderList",
    "finderStrategiesToggleAll",
    "finderStrategySearch",
    "finderStrategySelectAll",
    "finderStrategySelectNone",
    "finderStrategyInvertVisible",
    "finderStrategySelectVisible",
    "finderStrategySummary",
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
    finderStrategySearch: HTMLInputElement;
    finderStrategySelectAll: HTMLButtonElement;
    finderStrategySelectNone: HTMLButtonElement;
    finderStrategyInvertVisible: HTMLButtonElement;
    finderStrategySelectVisible: HTMLButtonElement;
    finderStrategySummary: HTMLElement;
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
        finderStrategySearch: getRequiredElement<HTMLInputElement>("finderStrategySearch"),
        finderStrategySelectAll: getRequiredElement<HTMLButtonElement>("finderStrategySelectAll"),
        finderStrategySelectNone: getRequiredElement<HTMLButtonElement>("finderStrategySelectNone"),
        finderStrategyInvertVisible: getRequiredElement<HTMLButtonElement>("finderStrategyInvertVisible"),
        finderStrategySelectVisible: getRequiredElement<HTMLButtonElement>("finderStrategySelectVisible"),
        finderStrategySummary: getRequiredElement("finderStrategySummary"),
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

export interface SettingsHandlersDom {
    resetSettingsBtn: HTMLButtonElement | null;
    saveConfigBtn: HTMLButtonElement | null;
    configNameInput: HTMLInputElement | null;
    loadConfigBtn: HTMLButtonElement | null;
    configSelect: HTMLSelectElement | null;
    deleteConfigBtn: HTMLButtonElement | null;
    generateShareLinkBtn: HTMLButtonElement | null;
    copyShareLinkBtn: HTMLButtonElement | null;
    shareConfigLinkInput: HTMLInputElement | null;
    loadShareLinkBtn: HTMLButtonElement | null;
    shareConfigImportInput: HTMLInputElement | null;
    runCombinedStrategyBtn: HTMLButtonElement | null;
    combinerPrimarySelect: HTMLSelectElement | null;
    combinerSecondarySelect: HTMLSelectElement | null;
    combinerMode: HTMLSelectElement | null;
    useRustEngineToggle: HTMLInputElement | null;
    runBacktest: HTMLButtonElement | null;
}

export function createSettingsHandlersDom(): SettingsHandlersDom {
    return {
        resetSettingsBtn: getOptionalElement<HTMLButtonElement>("resetSettingsBtn"),
        saveConfigBtn: getOptionalElement<HTMLButtonElement>("saveConfigBtn"),
        configNameInput: getOptionalElement<HTMLInputElement>("configNameInput"),
        loadConfigBtn: getOptionalElement<HTMLButtonElement>("loadConfigBtn"),
        configSelect: getOptionalElement<HTMLSelectElement>("configSelect"),
        deleteConfigBtn: getOptionalElement<HTMLButtonElement>("deleteConfigBtn"),
        generateShareLinkBtn: getOptionalElement<HTMLButtonElement>("generateShareLinkBtn"),
        copyShareLinkBtn: getOptionalElement<HTMLButtonElement>("copyShareLinkBtn"),
        shareConfigLinkInput: getOptionalElement<HTMLInputElement>("shareConfigLinkInput"),
        loadShareLinkBtn: getOptionalElement<HTMLButtonElement>("loadShareLinkBtn"),
        shareConfigImportInput: getOptionalElement<HTMLInputElement>("shareConfigImportInput"),
        runCombinedStrategyBtn: getOptionalElement<HTMLButtonElement>("runCombinedStrategyBtn"),
        combinerPrimarySelect: getOptionalElement<HTMLSelectElement>("combinerPrimarySelect"),
        combinerSecondarySelect: getOptionalElement<HTMLSelectElement>("combinerSecondarySelect"),
        combinerMode: getOptionalElement<HTMLSelectElement>("combinerMode"),
        useRustEngineToggle: getOptionalElement<HTMLInputElement>("useRustEngineToggle"),
        runBacktest: getOptionalElement<HTMLButtonElement>("runBacktest"),
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
    "wf-permutation-count",
    "wf-permutation-seed",
    "wf-permutation-metric",
    "wf-permutation-btn",
    "wf-permutation-spinner",
    "wf-permutation-panel",
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
    wfPermutationCount: HTMLInputElement;
    wfPermutationSeed: HTMLInputElement;
    wfPermutationMetric: HTMLSelectElement;
    wfPermutationBtn: HTMLButtonElement;
    wfPermutationSpinner: HTMLElement;
    wfPermutationPanel: HTMLElement;
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
        wfPermutationCount: getRequiredElement<HTMLInputElement>("wf-permutation-count"),
        wfPermutationSeed: getRequiredElement<HTMLInputElement>("wf-permutation-seed"),
        wfPermutationMetric: getRequiredElement<HTMLSelectElement>("wf-permutation-metric"),
        wfPermutationBtn: getRequiredElement<HTMLButtonElement>("wf-permutation-btn"),
        wfPermutationSpinner: getRequiredElement("wf-permutation-spinner"),
        wfPermutationPanel: getRequiredElement("wf-permutation-panel"),
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

export const PARAMETER_AUDIT_REQUIRED_IDS = [
    "parameterAuditSource",
    "parameterAuditSavedConfigGroup",
    "parameterAuditSavedConfig",
    "parameterAuditRun",
    "parameterAuditProgress",
    "parameterAuditProgressFill",
    "parameterAuditProgressText",
    "parameterAuditStatus",
    "parameterAuditSourceSummary",
    "parameterAuditIncludedParams",
    "parameterAuditEvidence",
    "parameterAuditSummary",
    "parameterAuditEmpty",
    "parameterAuditTableBody",
] as const;

export interface ParameterAuditDom {
    parameterAuditSource: HTMLSelectElement;
    parameterAuditSavedConfigGroup: HTMLElement;
    parameterAuditSavedConfig: HTMLSelectElement;
    parameterAuditRun: HTMLButtonElement;
    parameterAuditProgress: HTMLElement;
    parameterAuditProgressFill: HTMLElement;
    parameterAuditProgressText: HTMLElement;
    parameterAuditStatus: HTMLElement;
    parameterAuditSourceSummary: HTMLElement;
    parameterAuditIncludedParams: HTMLElement;
    parameterAuditEvidence: HTMLElement;
    parameterAuditSummary: HTMLElement;
    parameterAuditEmpty: HTMLElement;
    parameterAuditTableBody: HTMLElement;
}

export function createParameterAuditDom(): ParameterAuditDom {
    return {
        parameterAuditSource: getRequiredElement<HTMLSelectElement>("parameterAuditSource"),
        parameterAuditSavedConfigGroup: getRequiredElement("parameterAuditSavedConfigGroup"),
        parameterAuditSavedConfig: getRequiredElement<HTMLSelectElement>("parameterAuditSavedConfig"),
        parameterAuditRun: getRequiredElement<HTMLButtonElement>("parameterAuditRun"),
        parameterAuditProgress: getRequiredElement("parameterAuditProgress"),
        parameterAuditProgressFill: getRequiredElement("parameterAuditProgressFill"),
        parameterAuditProgressText: getRequiredElement("parameterAuditProgressText"),
        parameterAuditStatus: getRequiredElement("parameterAuditStatus"),
        parameterAuditSourceSummary: getRequiredElement("parameterAuditSourceSummary"),
        parameterAuditIncludedParams: getRequiredElement("parameterAuditIncludedParams"),
        parameterAuditEvidence: getRequiredElement("parameterAuditEvidence"),
        parameterAuditSummary: getRequiredElement("parameterAuditSummary"),
        parameterAuditEmpty: getRequiredElement("parameterAuditEmpty"),
        parameterAuditTableBody: getRequiredElement("parameterAuditTableBody"),
    };
}

export const ENSEMBLE_LAB_REQUIRED_IDS = [
    "ensembleTab",
    "ensembleEmpty",
    "ensembleContent",
    "ensembleTargetPicker",
    "ensembleTargetSelect",
    "ensembleTargetButton",
    "ensembleTargetMenu",
    "ensembleTargetSearch",
    "ensembleTargetList",
    "ensembleTargetPickerEmptyState",
    "ensembleTargetSummary",
    "ensembleMinSamples",
    "ensembleSymbolBadge",
    "ensembleIntervalBadge",
    "ensembleContextSearch",
    "ensembleContextFamilyFilter",
    "ensembleContextSelectAll",
    "ensembleContextSelectNone",
    "ensembleContextInvertVisible",
    "ensembleContextSelectVisible",
    "ensembleContextSelectSameFamily",
    "ensembleContextExcludeSameFamily",
    "ensembleContextSummary",
    "ensembleContextList",
    "ensembleContextHelper",
    "ensembleContextEmptyState",
    "ensembleRefreshConfigsBtn",
    "ensembleRunBtn",
    "ensembleStatus",
    "ensembleResults",
    "ensembleSummary",
    "ensembleCurrentContextSection",
    "ensembleCurrentContextSummary",
    "ensembleCurrentContextDetails",
    "ensembleHistoricalOddsSection",
    "ensembleHistoricalOddsSummary",
    "ensembleHistoricalOddsTableBody",
    "ensembleBuilderSection",
    "ensembleBuilderSummary",
    "ensembleBuilderTableBody",
    "ensembleDiagnosticsSection",
    "ensembleContributionSection",
    "ensembleContributionSummary",
    "ensembleContributionTableBody",
    "ensembleReplacementSection",
    "ensembleReplacementSummary",
    "ensembleReplacementTableBody",
    "ensembleRadarSection",
    "ensembleRadarContent",
] as const;

export interface EnsembleLabDom {
    ensembleTab: HTMLElement;
    ensembleEmpty: HTMLElement;
    ensembleContent: HTMLElement;
    ensembleTargetPicker: HTMLElement;
    ensembleTargetSelect: HTMLSelectElement;
    ensembleTargetButton: HTMLButtonElement;
    ensembleTargetMenu: HTMLElement;
    ensembleTargetSearch: HTMLInputElement;
    ensembleTargetList: HTMLElement;
    ensembleTargetPickerEmptyState: HTMLElement;
    ensembleTargetSummary: HTMLElement;
    ensembleMinSamples: HTMLInputElement;
    ensembleSymbolBadge: HTMLElement;
    ensembleIntervalBadge: HTMLElement;
    ensembleContextSearch: HTMLInputElement;
    ensembleContextFamilyFilter: HTMLSelectElement;
    ensembleContextSelectAll: HTMLButtonElement;
    ensembleContextSelectNone: HTMLButtonElement;
    ensembleContextInvertVisible: HTMLButtonElement;
    ensembleContextSelectVisible: HTMLButtonElement;
    ensembleContextSelectSameFamily: HTMLButtonElement;
    ensembleContextExcludeSameFamily: HTMLButtonElement;
    ensembleContextSummary: HTMLElement;
    ensembleContextList: HTMLElement;
    ensembleContextHelper: HTMLElement;
    ensembleContextEmptyState: HTMLElement;
    ensembleRefreshConfigsBtn: HTMLButtonElement;
    ensembleRunBtn: HTMLButtonElement;
    ensembleStatus: HTMLElement;
    ensembleResults: HTMLElement;
    ensembleSummary: HTMLElement;
    ensembleCurrentContextSection: HTMLElement;
    ensembleCurrentContextSummary: HTMLElement;
    ensembleCurrentContextDetails: HTMLElement;
    ensembleHistoricalOddsSection: HTMLElement;
    ensembleHistoricalOddsSummary: HTMLElement;
    ensembleHistoricalOddsTableBody: HTMLElement;
    ensembleBuilderSection: HTMLElement;
    ensembleBuilderSummary: HTMLElement;
    ensembleBuilderTableBody: HTMLElement;
    ensembleDiagnosticsSection: HTMLDetailsElement;
    ensembleContributionSection: HTMLElement;
    ensembleContributionSummary: HTMLElement;
    ensembleContributionTableBody: HTMLElement;
    ensembleReplacementSection: HTMLElement;
    ensembleReplacementSummary: HTMLElement;
    ensembleReplacementTableBody: HTMLElement;
    ensembleRadarSection: HTMLElement;
    ensembleRadarContent: HTMLElement;
}

export function createEnsembleLabDom(): EnsembleLabDom {
    return {
        ensembleTab: getRequiredElement("ensembleTab"),
        ensembleEmpty: getRequiredElement("ensembleEmpty"),
        ensembleContent: getRequiredElement("ensembleContent"),
        ensembleTargetPicker: getRequiredElement("ensembleTargetPicker"),
        ensembleTargetSelect: getRequiredElement<HTMLSelectElement>("ensembleTargetSelect"),
        ensembleTargetButton: getRequiredElement<HTMLButtonElement>("ensembleTargetButton"),
        ensembleTargetMenu: getRequiredElement("ensembleTargetMenu"),
        ensembleTargetSearch: getRequiredElement<HTMLInputElement>("ensembleTargetSearch"),
        ensembleTargetList: getRequiredElement("ensembleTargetList"),
        ensembleTargetPickerEmptyState: getRequiredElement("ensembleTargetPickerEmptyState"),
        ensembleTargetSummary: getRequiredElement("ensembleTargetSummary"),
        ensembleMinSamples: getRequiredElement<HTMLInputElement>("ensembleMinSamples"),
        ensembleSymbolBadge: getRequiredElement("ensembleSymbolBadge"),
        ensembleIntervalBadge: getRequiredElement("ensembleIntervalBadge"),
        ensembleContextSearch: getRequiredElement<HTMLInputElement>("ensembleContextSearch"),
        ensembleContextFamilyFilter: getRequiredElement<HTMLSelectElement>("ensembleContextFamilyFilter"),
        ensembleContextSelectAll: getRequiredElement<HTMLButtonElement>("ensembleContextSelectAll"),
        ensembleContextSelectNone: getRequiredElement<HTMLButtonElement>("ensembleContextSelectNone"),
        ensembleContextInvertVisible: getRequiredElement<HTMLButtonElement>("ensembleContextInvertVisible"),
        ensembleContextSelectVisible: getRequiredElement<HTMLButtonElement>("ensembleContextSelectVisible"),
        ensembleContextSelectSameFamily: getRequiredElement<HTMLButtonElement>("ensembleContextSelectSameFamily"),
        ensembleContextExcludeSameFamily: getRequiredElement<HTMLButtonElement>("ensembleContextExcludeSameFamily"),
        ensembleContextSummary: getRequiredElement("ensembleContextSummary"),
        ensembleContextList: getRequiredElement("ensembleContextList"),
        ensembleContextHelper: getRequiredElement("ensembleContextHelper"),
        ensembleContextEmptyState: getRequiredElement("ensembleContextEmptyState"),
        ensembleRefreshConfigsBtn: getRequiredElement<HTMLButtonElement>("ensembleRefreshConfigsBtn"),
        ensembleRunBtn: getRequiredElement<HTMLButtonElement>("ensembleRunBtn"),
        ensembleStatus: getRequiredElement("ensembleStatus"),
        ensembleResults: getRequiredElement("ensembleResults"),
        ensembleSummary: getRequiredElement("ensembleSummary"),
        ensembleCurrentContextSection: getRequiredElement("ensembleCurrentContextSection"),
        ensembleCurrentContextSummary: getRequiredElement("ensembleCurrentContextSummary"),
        ensembleCurrentContextDetails: getRequiredElement("ensembleCurrentContextDetails"),
        ensembleHistoricalOddsSection: getRequiredElement("ensembleHistoricalOddsSection"),
        ensembleHistoricalOddsSummary: getRequiredElement("ensembleHistoricalOddsSummary"),
        ensembleHistoricalOddsTableBody: getRequiredElement("ensembleHistoricalOddsTableBody"),
        ensembleBuilderSection: getRequiredElement("ensembleBuilderSection"),
        ensembleBuilderSummary: getRequiredElement("ensembleBuilderSummary"),
        ensembleBuilderTableBody: getRequiredElement("ensembleBuilderTableBody"),
        ensembleDiagnosticsSection: getRequiredElement<HTMLDetailsElement>("ensembleDiagnosticsSection"),
        ensembleContributionSection: getRequiredElement("ensembleContributionSection"),
        ensembleContributionSummary: getRequiredElement("ensembleContributionSummary"),
        ensembleContributionTableBody: getRequiredElement("ensembleContributionTableBody"),
        ensembleReplacementSection: getRequiredElement("ensembleReplacementSection"),
        ensembleReplacementSummary: getRequiredElement("ensembleReplacementSummary"),
        ensembleReplacementTableBody: getRequiredElement("ensembleReplacementTableBody"),
        ensembleRadarSection: getRequiredElement("ensembleRadarSection"),
        ensembleRadarContent: getRequiredElement("ensembleRadarContent"),
    };
}
