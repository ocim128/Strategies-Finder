import type { AdvancedSizingSettings } from "./types/backtest";

export const ADVANCED_SIZING_DOM_IDS = {
    advancedSizingSettingsPanel: "advancedSizingSettingsPanel",
    kellySettings: "kellySettings",
    volatilityTargetingSettings: "volatilityTargetingSettings",
    riskParitySettings: "riskParitySettings",
    martingaleSettings: "martingaleSettings",
    antiMartingaleSettings: "antiMartingaleSettings",
    optimalFSettings: "optimalFSettings",
    secureFSettings: "secureFSettings",
    kellyFraction: "kellyFraction",
    kellyWinRateCap: "kellyWinRateCap",
    kellyProfitFactorCap: "kellyProfitFactorCap",
    volTargetAnnual: "volTargetAnnual",
    volLookbackBars: "volLookbackBars",
    volScalingMethod: "volScalingMethod",
    riskParityLookback: "riskParityLookback",
    riskParityMethod: "riskParityMethod",
    martingaleMultiplier: "martingaleMultiplier",
    martingaleMaxSequence: "martingaleMaxSequence",
    martingaleResetOnWin: "martingaleResetOnWin",
    martingaleResetOnLoss: "martingaleResetOnLoss",
    martingaleBaseSize: "martingaleBaseSize",
    optimalFLookback: "optimalFLookback",
    optimalFBootstrapSamples: "optimalFBootstrapSamples",
    secureFConfidence: "secureFConfidence",
    secureFMethod: "secureFMethod",
} as const;

export const ADVANCED_SIZING_SUBSECTION_IDS = Object.freeze({
    kelly_criterion: ADVANCED_SIZING_DOM_IDS.kellySettings,
    volatility_targeting: ADVANCED_SIZING_DOM_IDS.volatilityTargetingSettings,
    risk_parity: ADVANCED_SIZING_DOM_IDS.riskParitySettings,
    martingale: ADVANCED_SIZING_DOM_IDS.martingaleSettings,
    anti_martingale: ADVANCED_SIZING_DOM_IDS.martingaleSettings,
    optimal_f: ADVANCED_SIZING_DOM_IDS.optimalFSettings,
    secure_f: ADVANCED_SIZING_DOM_IDS.optimalFSettings,
} as const);

export const ADVANCED_SIZING_FIELD_IDS: readonly (keyof AdvancedSizingSettings)[] = Object.freeze([
    "kellyFraction",
    "kellyWinRateCap",
    "kellyProfitFactorCap",
    "volTargetAnnual",
    "volLookbackBars",
    "volScalingMethod",
    "riskParityLookback",
    "riskParityMethod",
    "martingaleMultiplier",
    "martingaleMaxSequence",
    "martingaleResetOnWin",
    "martingaleResetOnLoss",
    "martingaleBaseSize",
    "optimalFLookback",
    "optimalFBootstrapSamples",
    "secureFConfidence",
    "secureFMethod",
]);

export const ADVANCED_SIZING_NUMERIC_FIELD_IDS = new Set<keyof AdvancedSizingSettings>([
    "kellyWinRateCap",
    "kellyProfitFactorCap",
    "volTargetAnnual",
    "volLookbackBars",
    "riskParityLookback",
    "martingaleMultiplier",
    "martingaleMaxSequence",
    "optimalFLookback",
    "optimalFBootstrapSamples",
    "secureFConfidence",
]);

export const ADVANCED_SIZING_BOOLEAN_FIELD_IDS = new Set<keyof AdvancedSizingSettings>([
    "martingaleResetOnWin",
    "martingaleResetOnLoss",
]);
