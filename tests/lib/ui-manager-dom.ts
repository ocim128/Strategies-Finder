import { getRequiredElement } from "./dom-utils";

export const SETTINGS_WORKSPACE_REQUIRED_IDS = [
    "settingsTab",
    "strategyWorkspaceHeader",
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
    "ohlcChangeValue",
    "lastBacktestResult",
    "tradeBadge",
    "strategySelect",
    "timeframeCustom",
    "timeframeMinutesInput",
    "indicatorsPanel",
    "strategyStatus",
    "strategyEntryPreviewPanel",
    "strategyEntryPreviewEmpty",
    "entryPreviewSummary",
    "entryPreviewSummaryEyebrow",
    "entryPreviewSummaryHeadline",
    "entryPreviewSummaryDetail",
    "entryPreviewTitle",
    "entryPreviewStatus",
    "entryPreviewLegacyRows",
    "entryPreviewMode",
    "entryPreviewDirection",
    "entryPreviewLevel",
    "entryPreviewPrice",
    "entryPreviewDistance",
    "entryPreviewRows",
    "entryPreviewNote",
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
        ohlcChangeValue: getRequiredElement("ohlcChangeValue"),
        lastBacktestResult: getRequiredElement("lastBacktestResult"),
        tradeBadge: getRequiredElement("tradeBadge"),
        strategySelect: getRequiredElement<HTMLSelectElement>("strategySelect"),
        timeframeCustom: getRequiredElement("timeframeCustom"),
        timeframeMinutesInput: getRequiredElement<HTMLInputElement>("timeframeMinutesInput"),
        indicatorsPanel: getRequiredElement("indicatorsPanel"),
        strategyStatus: getRequiredElement("strategyStatus"),
        strategyEntryPreviewPanel: getRequiredElement("strategyEntryPreviewPanel"),
        strategyEntryPreviewEmpty: getRequiredElement("strategyEntryPreviewEmpty"),
        entryPreviewSummary: getRequiredElement("entryPreviewSummary"),
        entryPreviewSummaryEyebrow: getRequiredElement("entryPreviewSummaryEyebrow"),
        entryPreviewSummaryHeadline: getRequiredElement("entryPreviewSummaryHeadline"),
        entryPreviewSummaryDetail: getRequiredElement("entryPreviewSummaryDetail"),
        entryPreviewTitle: getRequiredElement("entryPreviewTitle"),
        entryPreviewStatus: getRequiredElement("entryPreviewStatus"),
        entryPreviewLegacyRows: getRequiredElement("entryPreviewLegacyRows"),
        entryPreviewMode: getRequiredElement("entryPreviewMode"),
        entryPreviewDirection: getRequiredElement("entryPreviewDirection"),
        entryPreviewLevel: getRequiredElement("entryPreviewLevel"),
        entryPreviewPrice: getRequiredElement("entryPreviewPrice"),
        entryPreviewDistance: getRequiredElement("entryPreviewDistance"),
        entryPreviewRows: getRequiredElement("entryPreviewRows"),
        entryPreviewNote: getRequiredElement("entryPreviewNote"),
    };
}

export type UiManagerDom = ReturnType<typeof createUiManagerDom>;
