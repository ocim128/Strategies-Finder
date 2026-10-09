export type SettingsPresetMode = "simple" | "standard";

export interface StrategyPanelSettingsSectionDefinition {
    id: string;
    preset: SettingsPresetMode;
    accordionBodyId: string;
    featureToggleId?: string;
    featureContentId?: string;
}

export const STRATEGY_PANEL_SETTINGS_SECTIONS: readonly StrategyPanelSettingsSectionDefinition[] = [
    {
        id: "direction",
        preset: "simple",
        accordionBodyId: "directionBody",
    },
    {
        id: "risk",
        preset: "simple",
        accordionBodyId: "riskSectionBody",
        featureToggleId: "riskSettingsToggle",
        featureContentId: "riskSettings",
    },
    {
        id: "sizing",
        preset: "simple",
        accordionBodyId: "tradeSizingBody",
    },
    {
        id: "confirmation",
        preset: "standard",
        accordionBodyId: "confirmationSectionBody",
        featureToggleId: "confirmationStrategiesToggle",
        featureContentId: "confirmationStrategiesSettings",
    },
    {
        id: "realism",
        preset: "standard",
        accordionBodyId: "realismBody",
    },
    {
        id: "engine",
        preset: "standard",
        accordionBodyId: "engineBody",
    },
] as const;

export function getSettingsSectionDefinition(sectionId: string): StrategyPanelSettingsSectionDefinition | null {
    return STRATEGY_PANEL_SETTINGS_SECTIONS.find((section) => section.id === sectionId) ?? null;
}
