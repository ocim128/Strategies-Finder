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
    takeProfitAdaptiveLookbackTrades: "takeProfitAdaptiveLookbackTrades",
    takeProfitAdaptiveRecentWindow: "takeProfitAdaptiveRecentWindow",
    takeProfitAdaptiveMinMultiplier: "takeProfitAdaptiveMinMultiplier",
    takeProfitAdaptiveMaxMultiplier: "takeProfitAdaptiveMaxMultiplier",
    takeProfitAdaptiveGridSteps: "takeProfitAdaptiveGridSteps",
    takeProfitAdaptiveRegimeBlend: "takeProfitAdaptiveRegimeBlend",
    takeProfitAdaptiveIcScale: "takeProfitAdaptiveIcScale",
} as const;

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
