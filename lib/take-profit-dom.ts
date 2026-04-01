import type { BacktestSettings } from "./types/strategies";

type AdaptiveTakeProfitField = Extract<keyof BacktestSettings,
    | "takeProfitAdaptiveLookbackTrades"
    | "takeProfitAdaptiveRecentWindow"
    | "takeProfitAdaptiveMinMultiplier"
    | "takeProfitAdaptiveMaxMultiplier"
    | "takeProfitAdaptiveGridSteps"
    | "takeProfitAdaptiveRegimeBlend"
    | "takeProfitAdaptiveIcScale"
>;

export const TAKE_PROFIT_DOM_IDS = {
    edgeWeightedSettings: "takeProfitEdgeWeightedSettings",
    expectancyOptimalSettings: "takeProfitExpectancyOptimalSettings",
    regimeCalibratedSettings: "takeProfitRegimeCalibratedSettings",
    informationCoefficientSettings: "takeProfitInformationCoefficientSettings",
    pathEfficiencySettings: "takeProfitPathEfficiencySettings",
    serialDependencySettings: "takeProfitSerialDependencySettings",
    minimumSurprisalSettings: "takeProfitMinimumSurprisalSettings",
    takeProfitAdaptiveLookbackTrades: "takeProfitAdaptiveLookbackTrades",
    takeProfitAdaptiveRecentWindow: "takeProfitAdaptiveRecentWindow",
    takeProfitAdaptiveMinMultiplier: "takeProfitAdaptiveMinMultiplier",
    takeProfitAdaptiveMaxMultiplier: "takeProfitAdaptiveMaxMultiplier",
    takeProfitAdaptiveGridSteps: "takeProfitAdaptiveGridSteps",
    takeProfitAdaptiveRegimeBlend: "takeProfitAdaptiveRegimeBlend",
    takeProfitAdaptiveIcScale: "takeProfitAdaptiveIcScale",
} as const;

export const TAKE_PROFIT_MODE_PANEL_IDS = Object.freeze({
    edge_weighted: TAKE_PROFIT_DOM_IDS.edgeWeightedSettings,
    expectancy_optimal: TAKE_PROFIT_DOM_IDS.expectancyOptimalSettings,
    regime_calibrated: TAKE_PROFIT_DOM_IDS.regimeCalibratedSettings,
    information_coefficient: TAKE_PROFIT_DOM_IDS.informationCoefficientSettings,
    path_efficiency: TAKE_PROFIT_DOM_IDS.pathEfficiencySettings,
    serial_dependency: TAKE_PROFIT_DOM_IDS.serialDependencySettings,
    minimum_surprisal: TAKE_PROFIT_DOM_IDS.minimumSurprisalSettings,
} as const);

export const TAKE_PROFIT_FIELD_IDS: readonly AdaptiveTakeProfitField[] = Object.freeze([
    "takeProfitAdaptiveLookbackTrades",
    "takeProfitAdaptiveRecentWindow",
    "takeProfitAdaptiveMinMultiplier",
    "takeProfitAdaptiveMaxMultiplier",
    "takeProfitAdaptiveGridSteps",
    "takeProfitAdaptiveRegimeBlend",
    "takeProfitAdaptiveIcScale",
]);

export const TAKE_PROFIT_NUMERIC_FIELD_IDS = new Set<AdaptiveTakeProfitField>(TAKE_PROFIT_FIELD_IDS);
