import { getRequiredElement } from "./dom-utils";

export const SETTINGS_MANAGER_REQUIRED_IDS = [
    "strategySelect",
    "settingsTab",
    "riskMode",
    "tradeDirection",
] as const;

export function createSettingsManagerDom() {
    return {
        strategySelect: getRequiredElement<HTMLSelectElement>("strategySelect"),
        settingsTab: getRequiredElement("settingsTab"),
        riskMode: getRequiredElement("riskMode"),
        tradeDirection: getRequiredElement("tradeDirection"),
    };
}

export type SettingsManagerDom = ReturnType<typeof createSettingsManagerDom>;
