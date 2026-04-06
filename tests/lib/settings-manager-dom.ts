import { getRequiredElement } from "./dom-utils";

export const SETTINGS_MANAGER_REQUIRED_IDS = [
    "strategySelect",
    "settingsTab",
    "riskMode",
    "takeProfitMode",
    "tradeFilterMode",
    "tradeDirection",
] as const;

export function createSettingsManagerDom() {
    return {
        strategySelect: getRequiredElement<HTMLSelectElement>("strategySelect"),
        settingsTab: getRequiredElement("settingsTab"),
        riskMode: getRequiredElement("riskMode"),
        takeProfitMode: getRequiredElement("takeProfitMode"),
        tradeFilterMode: getRequiredElement("tradeFilterMode"),
        tradeDirection: getRequiredElement("tradeDirection"),
    };
}

export type SettingsManagerDom = ReturnType<typeof createSettingsManagerDom>;
