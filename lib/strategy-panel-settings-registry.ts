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
    {
        id: "polymarket",
        preset: "standard",
        accordionBodyId: "polymarketSettingsBody",
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
