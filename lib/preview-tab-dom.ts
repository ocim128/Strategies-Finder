import { getRequiredElement } from "./dom-utils";

export const PREVIEW_TAB_REQUIRED_IDS = [
    "previewTab",
    "previewSourceMode",
    "previewSavedConfig",
    "previewFollowDirectionToggle",
    "previewLiveModeToggle",
    "previewRefreshBtn",
    "strategyEntryPreviewPanel",
    "strategyEntryPreviewEmpty",
] as const;

export function createPreviewTabDom() {
    return {
        previewTab: getRequiredElement("previewTab"),
        previewSourceMode: getRequiredElement<HTMLSelectElement>("previewSourceMode"),
        previewSavedConfig: getRequiredElement<HTMLSelectElement>("previewSavedConfig"),
        previewFollowDirectionToggle: getRequiredElement<HTMLInputElement>("previewFollowDirectionToggle"),
        previewLiveModeToggle: getRequiredElement<HTMLInputElement>("previewLiveModeToggle"),
        previewRefreshBtn: getRequiredElement<HTMLButtonElement>("previewRefreshBtn"),
        strategyEntryPreviewPanel: getRequiredElement("strategyEntryPreviewPanel"),
        strategyEntryPreviewEmpty: getRequiredElement("strategyEntryPreviewEmpty"),
    };
}

export type PreviewTabDom = ReturnType<typeof createPreviewTabDom>;
