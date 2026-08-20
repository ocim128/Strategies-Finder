import { getRequiredElement } from "./dom-utils";

export const SETTINGS_WORKSPACE_REQUIRED_IDS = [
    "settingsTab",
    "strategyWorkspaceHeader",
    "strategyWorkspaceToggle",
    "strategyWorkspaceBody",
    "strategyWorkspaceSections",
    "strategyMetaName",
    "strategyMetaDescription",
    "strategyMetaKey",
    "strategyParamCount",
] as const;

export function createSettingsWorkspaceDom() {
    return {
        settingsTab: getRequiredElement("settingsTab"),
        strategyWorkspaceHeader: getRequiredElement("strategyWorkspaceHeader"),
        strategyWorkspaceToggle: getRequiredElement("strategyWorkspaceToggle"),
        strategyWorkspaceBody: getRequiredElement("strategyWorkspaceBody"),
        strategyWorkspaceSections: getRequiredElement("strategyWorkspaceSections"),
        strategyMetaName: getRequiredElement("strategyMetaName"),
        strategyMetaDescription: getRequiredElement("strategyMetaDescription"),
        strategyMetaKey: getRequiredElement("strategyMetaKey"),
        strategyParamCount: getRequiredElement("strategyParamCount"),
    };
}

export type SettingsWorkspaceDom = ReturnType<typeof createSettingsWorkspaceDom>;

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
    "ohlcChangeArrow",
    "ohlcChangeValue",
    "lastBacktestResult",
    "tradeBadge",
    "strategySelect",
    "timeframeCustom",
    "timeframeMinutesInput",
    "indicatorsPanel",
    "strategyStatus",
] as const;

export function createUiManagerDom() {
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
        ohlcChangeArrow: getRequiredElement("ohlcChangeArrow"),
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

export type UiManagerDom = ReturnType<typeof createUiManagerDom>;
