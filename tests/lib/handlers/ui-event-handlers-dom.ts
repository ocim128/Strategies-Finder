import {
    getOptionalElement,
    getRequiredDomElements,
    getRequiredDomIds,
    type RequiredDomElementMap,
} from "../dom-utils";
import { ADVANCED_SIZING_DOM_IDS } from "../advanced-sizing-dom";
import { TAKE_PROFIT_DOM_IDS } from "../take-profit-dom";

const UI_EVENT_HANDLER_DOM_IDS = {
    symbolSelector: "symbolSelector",
    symbolDropdown: "symbolDropdown",
    binanceMarketTypeSelect: "binanceMarketTypeSelect",
    themeToggle: "themeToggle",
    strategySelect: "strategySelect",
    strategyTabs: "strategyTabs",
    panelContent: "panelContent",
    runBacktestEndpointPreview: "runBacktestEndpointPreview",
    copyBacktestEndpoint: "copyBacktestEndpoint",
    runBacktest: "runBacktest",
    clearTradesBtn: "clearTradesBtn",
    togglePanel: "togglePanel",
    strategyPanel: "strategyPanel",
    zoomInTool: "zoomInTool",
    zoomOutTool: "zoomOutTool",
    fitTool: "fitTool",
    riskSettingsToggle: "riskSettingsToggle",
    riskSettings: "riskSettings",
    riskMode: "riskMode",
    takeProfitMode: "takeProfitMode",
    takeProfitAdaptiveLookbackTrades: TAKE_PROFIT_DOM_IDS.takeProfitAdaptiveLookbackTrades,
    takeProfitAdaptiveRecentWindow: TAKE_PROFIT_DOM_IDS.takeProfitAdaptiveRecentWindow,
    takeProfitAdaptiveMinMultiplier: TAKE_PROFIT_DOM_IDS.takeProfitAdaptiveMinMultiplier,
    takeProfitAdaptiveMaxMultiplier: TAKE_PROFIT_DOM_IDS.takeProfitAdaptiveMaxMultiplier,
    takeProfitAdaptiveGridSteps: TAKE_PROFIT_DOM_IDS.takeProfitAdaptiveGridSteps,
    takeProfitAdaptiveRegimeBlend: TAKE_PROFIT_DOM_IDS.takeProfitAdaptiveRegimeBlend,
    takeProfitAdaptiveIcScale: TAKE_PROFIT_DOM_IDS.takeProfitAdaptiveIcScale,
    tradeDirection: "tradeDirection",
    flipAfterConsecutiveLosses: "flipAfterConsecutiveLosses",
    flipCooldownTrades: "flipCooldownTrades",
    minTradesBeforeFirstFlip: "minTradesBeforeFirstFlip",
    confirmationStrategiesToggle: "confirmationStrategiesToggle",
    confirmationStrategiesSettings: "confirmationStrategiesSettings",
    confirmationStrategies: "confirmationStrategies",
    confirmationStrategyParams: "confirmationStrategyParams",
    confirmationEntropyRatioRegimeAlignment: "confirmationEntropyRatioRegimeAlignment",
    confirmationEntropySlowWindow: "confirmationEntropySlowWindow",
    confirmationCloseLocationMedianAlignment: "confirmationCloseLocationMedianAlignment",
    confirmationCloseLocationLookback: "confirmationCloseLocationLookback",
    strategyTimeframeToggle: "strategyTimeframeToggle",
    strategyTimeframeMinutes: "strategyTimeframeMinutes",
    finderTradesToggle: "finderTradesToggle",
    finderTradeFilters: "finderTradeFilters",
    fixedTradeToggle: "fixedTradeToggle",
    initialCapitalGroup: "initialCapitalGroup",
    fixedTradeGroup: "fixedTradeGroup",
    tradeSizingModeGroup: "tradeSizingModeGroup",
    positionSizeGroup: "positionSizeGroup",
    initialCapital: "initialCapital",
    tradeSizingMode: "tradeSizingMode",
    fixedTradeAmount: "fixedTradeAmount",
    positionSize: "positionSize",
    advancedSizingSettingsPanel: ADVANCED_SIZING_DOM_IDS.advancedSizingSettingsPanel,
    kellySettings: ADVANCED_SIZING_DOM_IDS.kellySettings,
    volatilityTargetingSettings: ADVANCED_SIZING_DOM_IDS.volatilityTargetingSettings,
    riskParitySettings: ADVANCED_SIZING_DOM_IDS.riskParitySettings,
    martingaleSettings: ADVANCED_SIZING_DOM_IDS.martingaleSettings,
    optimalFSettings: ADVANCED_SIZING_DOM_IDS.optimalFSettings,
    kellyFraction: ADVANCED_SIZING_DOM_IDS.kellyFraction,
    kellyWinRateCap: ADVANCED_SIZING_DOM_IDS.kellyWinRateCap,
    kellyProfitFactorCap: ADVANCED_SIZING_DOM_IDS.kellyProfitFactorCap,
    volTargetAnnual: ADVANCED_SIZING_DOM_IDS.volTargetAnnual,
    volLookbackBars: ADVANCED_SIZING_DOM_IDS.volLookbackBars,
    volScalingMethod: ADVANCED_SIZING_DOM_IDS.volScalingMethod,
    riskParityLookback: ADVANCED_SIZING_DOM_IDS.riskParityLookback,
    riskParityMethod: ADVANCED_SIZING_DOM_IDS.riskParityMethod,
    martingaleMultiplier: ADVANCED_SIZING_DOM_IDS.martingaleMultiplier,
    martingaleMaxSequence: ADVANCED_SIZING_DOM_IDS.martingaleMaxSequence,
    martingaleResetOnWin: ADVANCED_SIZING_DOM_IDS.martingaleResetOnWin,
    martingaleResetOnLoss: ADVANCED_SIZING_DOM_IDS.martingaleResetOnLoss,
    martingaleBaseSize: ADVANCED_SIZING_DOM_IDS.martingaleBaseSize,
    optimalFLookback: ADVANCED_SIZING_DOM_IDS.optimalFLookback,
    optimalFBootstrapSamples: ADVANCED_SIZING_DOM_IDS.optimalFBootstrapSamples,
    secureFConfidence: ADVANCED_SIZING_DOM_IDS.secureFConfidence,
    secureFMethod: ADVANCED_SIZING_DOM_IDS.secureFMethod,
    panelResizeHandle: "panelResizeHandle",
    takeProfitEdgeWeightedSettings: TAKE_PROFIT_DOM_IDS.edgeWeightedSettings,
    takeProfitExpectancyOptimalSettings: TAKE_PROFIT_DOM_IDS.expectancyOptimalSettings,
    takeProfitRegimeCalibratedSettings: TAKE_PROFIT_DOM_IDS.regimeCalibratedSettings,
    takeProfitInformationCoefficientSettings: TAKE_PROFIT_DOM_IDS.informationCoefficientSettings,
    takeProfitPathEfficiencySettings: TAKE_PROFIT_DOM_IDS.pathEfficiencySettings,
    takeProfitSerialDependencySettings: TAKE_PROFIT_DOM_IDS.serialDependencySettings,
    takeProfitMinimumSurprisalSettings: TAKE_PROFIT_DOM_IDS.minimumSurprisalSettings,
} as const;

export const UI_EVENT_HANDLER_REQUIRED_IDS = getRequiredDomIds(UI_EVENT_HANDLER_DOM_IDS);

type UiEventTypedControls = {
    binanceMarketTypeSelect: HTMLSelectElement;
    strategySelect: HTMLSelectElement;
    runBacktestEndpointPreview: HTMLButtonElement;
    copyBacktestEndpoint: HTMLButtonElement;
    riskSettingsToggle: HTMLInputElement;
    riskMode: HTMLSelectElement;
    takeProfitMode: HTMLSelectElement;
    takeProfitAdaptiveLookbackTrades: HTMLInputElement;
    takeProfitAdaptiveRecentWindow: HTMLInputElement;
    takeProfitAdaptiveMinMultiplier: HTMLInputElement;
    takeProfitAdaptiveMaxMultiplier: HTMLInputElement;
    takeProfitAdaptiveGridSteps: HTMLInputElement;
    takeProfitAdaptiveRegimeBlend: HTMLInputElement;
    takeProfitAdaptiveIcScale: HTMLInputElement;
    tradeDirection: HTMLSelectElement;
    flipAfterConsecutiveLosses: HTMLInputElement;
    flipCooldownTrades: HTMLInputElement;
    minTradesBeforeFirstFlip: HTMLInputElement;
    confirmationStrategiesToggle: HTMLInputElement;
    confirmationStrategies: HTMLInputElement;
    confirmationStrategyParams: HTMLInputElement;
    confirmationEntropyRatioRegimeAlignment: HTMLInputElement;
    confirmationEntropySlowWindow: HTMLInputElement;
    confirmationCloseLocationMedianAlignment: HTMLInputElement;
    confirmationCloseLocationLookback: HTMLInputElement;
    strategyTimeframeToggle: HTMLInputElement;
    strategyTimeframeMinutes: HTMLInputElement;
    finderTradesToggle: HTMLInputElement;
    fixedTradeToggle: HTMLInputElement;
    initialCapital: HTMLInputElement;
    tradeSizingMode: HTMLSelectElement;
    fixedTradeAmount: HTMLInputElement;
    positionSize: HTMLInputElement;
    kellyFraction: HTMLSelectElement;
    kellyWinRateCap: HTMLInputElement;
    kellyProfitFactorCap: HTMLInputElement;
    volTargetAnnual: HTMLInputElement;
    volLookbackBars: HTMLInputElement;
    volScalingMethod: HTMLSelectElement;
    riskParityLookback: HTMLInputElement;
    riskParityMethod: HTMLSelectElement;
    martingaleMultiplier: HTMLInputElement;
    martingaleMaxSequence: HTMLInputElement;
    martingaleResetOnWin: HTMLInputElement;
    martingaleResetOnLoss: HTMLInputElement;
    martingaleBaseSize: HTMLSelectElement;
    optimalFLookback: HTMLInputElement;
    optimalFBootstrapSamples: HTMLInputElement;
    secureFConfidence: HTMLInputElement;
    secureFMethod: HTMLSelectElement;
};

type UiEventRequiredDom =
    Omit<RequiredDomElementMap<typeof UI_EVENT_HANDLER_DOM_IDS>, keyof UiEventTypedControls>
    & UiEventTypedControls;

export type UiEventHandlersDom = UiEventRequiredDom & {
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
    screenshotTool: HTMLElement | null;
    copyChartBtn: HTMLElement | null;
    riskSimpleAdvanced: HTMLElement | null;
    riskPercentage: HTMLElement | null;
    flipLossStreakSettingsRow: HTMLElement | null;
    strategyTimeframeMinutesGroup: HTMLElement | null;
};

export function createUiEventHandlersDom(): UiEventHandlersDom {
    return {
        ...(getRequiredDomElements(UI_EVENT_HANDLER_DOM_IDS) as UiEventRequiredDom),
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
        screenshotTool: getOptionalElement("screenshotTool"),
        copyChartBtn: getOptionalElement("copyChartBtn"),
        riskSimpleAdvanced: getOptionalElement("riskSimpleAdvanced"),
        riskPercentage: getOptionalElement("riskPercentage"),
        flipLossStreakSettingsRow: getOptionalElement("flipLossStreakSettingsRow"),
        strategyTimeframeMinutesGroup: getOptionalElement("strategyTimeframeMinutesGroup"),
    };
}
