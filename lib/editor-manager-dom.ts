import { getRequiredElement } from "./dom-utils";

export const EDITOR_MANAGER_REQUIRED_IDS = [
    "codeEditorModal",
    "openCodeEditor",
    "closeCodeEditor",
    "newPresetBtn",
    "validateCodeBtn",
    "savePresetBtn",
    "applyStrategyBtn",
    "strategyName",
    "strategyKey",
    "presetList",
    "monaco-container",
    "editorStatus",
] as const;

export function createEditorManagerDom() {
    return {
        codeEditorModal: getRequiredElement("codeEditorModal"),
        openCodeEditor: getRequiredElement("openCodeEditor"),
        closeCodeEditor: getRequiredElement("closeCodeEditor"),
        newPresetBtn: getRequiredElement("newPresetBtn"),
        validateCodeBtn: getRequiredElement("validateCodeBtn"),
        savePresetBtn: getRequiredElement("savePresetBtn"),
        applyStrategyBtn: getRequiredElement("applyStrategyBtn"),
        strategyName: getRequiredElement<HTMLInputElement>("strategyName"),
        strategyKey: getRequiredElement<HTMLInputElement>("strategyKey"),
        presetList: getRequiredElement("presetList"),
        monacoContainer: getRequiredElement("monaco-container"),
        editorStatus: getRequiredElement("editorStatus"),
    };
}

export type EditorManagerDom = ReturnType<typeof createEditorManagerDom>;
