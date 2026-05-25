export type SettingsPresetMode = "simple" | "standard" | "advanced";

export interface StrategyPanelSettingsSectionDefinition {
    id: string;
    preset: SettingsPresetMode;
    accordionBodyId: string;
    featureToggleId?: string;
    featureContentId?: string;
}

export const STRATEGY_PANEL_SETTINGS_SECTIONS: readonly StrategyPanelSettingsSectionDefinition[] = [
    {
        id: "risk",
        preset: "simple",
        accordionBodyId: "riskSectionBody",
        featureToggleId: "riskSettingsToggle",
        featureContentId: "riskSettings",
    },
    {
        id: "realism",
        preset: "standard",
        accordionBodyId: "realismBody",
    },
    {
        id: "polymarket",
        preset: "standard",
        accordionBodyId: "polymarketSettingsBody",
    },
    {
        id: "sizing",
        preset: "simple",
        accordionBodyId: "tradeSizingBody",
    },
    {
        id: "direction",
        preset: "simple",
        accordionBodyId: "directionBody",
    },
    {
        id: "confirmation",
        preset: "standard",
        accordionBodyId: "confirmationSectionBody",
        featureToggleId: "confirmationStrategiesToggle",
        featureContentId: "confirmationStrategiesSettings",
    },
    {
        id: "engine",
        preset: "standard",
        accordionBodyId: "engineBody",
    },
    {
        id: "combiner",
        preset: "standard",
        accordionBodyId: "combinerBody",
    },
] as const;

const PRESET_RANK: Record<SettingsPresetMode, number> = {
    simple: 0,
    standard: 1,
    advanced: 2,
};

export function isSettingsSectionVisibleForPreset(
    sectionPreset: SettingsPresetMode,
    activePreset: SettingsPresetMode
): boolean {
    return PRESET_RANK[sectionPreset] <= PRESET_RANK[activePreset];
}

export function getSettingsSectionDefinition(sectionId: string): StrategyPanelSettingsSectionDefinition | null {
    return STRATEGY_PANEL_SETTINGS_SECTIONS.find((section) => section.id === sectionId) ?? null;
}
