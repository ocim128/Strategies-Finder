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
        runCombinedStrategyBtn: getOptionalElement<HTMLButtonElement>("runCombinedStrategyBtn"),
        combinerPrimarySelect: getOptionalElement<HTMLSelectElement>("combinerPrimarySelect"),
        combinerSecondarySelect: getOptionalElement<HTMLSelectElement>("combinerSecondarySelect"),
        combinerMode: getOptionalElement<HTMLSelectElement>("combinerMode"),
        useRustEngineToggle: getOptionalElement<HTMLInputElement>("useRustEngineToggle"),
        runBacktest: getOptionalElement<HTMLButtonElement>("runBacktest"),
    };
}

export type SettingsHandlersDom = ReturnType<typeof createSettingsHandlersDom>;
