import { getOptionalElement } from "../dom-utils";

export const SETTINGS_BULK_DELETE_REQUIRED_IDS = [
    "bulkDeleteConfigs", "bulkConfigList", "selectAllConfigs", "bulkConfigSelectionCount", "deleteSelectedConfigsBtn",
] as const;

export function createSettingsHandlersDom() {
    return {
        resetSettingsBtn: getOptionalElement<HTMLButtonElement>("resetSettingsBtn"),
        restoreSettingsConfigBtn: getOptionalElement<HTMLButtonElement>("restoreSettingsConfigBtn"),
        saveConfigBtn: getOptionalElement<HTMLButtonElement>("saveConfigBtn"),
        configNameInput: getOptionalElement<HTMLInputElement>("configNameInput"),
        loadConfigBtn: getOptionalElement<HTMLButtonElement>("loadConfigBtn"),
        configSelect: getOptionalElement<HTMLSelectElement>("configSelect"),
        deleteConfigBtn: getOptionalElement<HTMLButtonElement>("deleteConfigBtn"),
        bulkConfigList: getOptionalElement("bulkConfigList"),
        selectAllConfigs: getOptionalElement<HTMLInputElement>("selectAllConfigs"),
        bulkConfigSelectionCount: getOptionalElement("bulkConfigSelectionCount"),
        deleteSelectedConfigsBtn: getOptionalElement<HTMLButtonElement>("deleteSelectedConfigsBtn"),
        generateShareLinkBtn: getOptionalElement<HTMLButtonElement>("generateShareLinkBtn"),
        copyShareLinkBtn: getOptionalElement<HTMLButtonElement>("copyShareLinkBtn"),
        shareConfigLinkInput: getOptionalElement<HTMLInputElement>("shareConfigLinkInput"),
        loadShareLinkBtn: getOptionalElement<HTMLButtonElement>("loadShareLinkBtn"),
        shareConfigImportInput: getOptionalElement<HTMLInputElement>("shareConfigImportInput"),
        useRustEngineToggle: getOptionalElement<HTMLInputElement>("useRustEngineToggle"),
        runBacktest: getOptionalElement<HTMLButtonElement>("runBacktest"),
    };
}

export type SettingsHandlersDom = ReturnType<typeof createSettingsHandlersDom>;
