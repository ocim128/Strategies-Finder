import { getOptionalElement } from "../dom-utils";

export function createSettingsHandlersDom() {
    return {
        resetSettingsBtn: getOptionalElement<HTMLButtonElement>("resetSettingsBtn"),
        saveConfigBtn: getOptionalElement<HTMLButtonElement>("saveConfigBtn"),
        configNameInput: getOptionalElement<HTMLInputElement>("configNameInput"),
        loadConfigBtn: getOptionalElement<HTMLButtonElement>("loadConfigBtn"),
        configSelect: getOptionalElement<HTMLSelectElement>("configSelect"),
        deleteConfigBtn: getOptionalElement<HTMLButtonElement>("deleteConfigBtn"),
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
