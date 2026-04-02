import { getRequiredElement } from "./dom-utils";

export const WALK_FORWARD_SERVICE_REQUIRED_IDS = [
    "wf-opt-window",
    "wf-test-window",
    "wf-step-size",
    "wf-min-trades",
    "wf-auto-suggest",
    "wf-top-n",
    "wf-summary-panel",
    "wf-decay-panel",
    "wf-window-table-body",
    "wf-robustness-gauge",
    "wf-robustness-score",
    "wf-robustness-desc",
    "wf-run-btn",
    "wf-quick-btn",
    "wf-cancel-btn",
    "wf-spinner",
    "wf-quick-spinner",
    "wf-status",
] as const;

export function createWalkForwardServiceDom() {
    return {
        wfOptWindow: getRequiredElement<HTMLInputElement>("wf-opt-window"),
        wfTestWindow: getRequiredElement<HTMLInputElement>("wf-test-window"),
        wfStepSize: getRequiredElement<HTMLInputElement>("wf-step-size"),
        wfMinTrades: getRequiredElement<HTMLInputElement>("wf-min-trades"),
        wfAutoSuggest: getRequiredElement<HTMLInputElement>("wf-auto-suggest"),
        wfTopN: getRequiredElement<HTMLInputElement>("wf-top-n"),
        wfSummaryPanel: getRequiredElement("wf-summary-panel"),
        wfDecayPanel: getRequiredElement("wf-decay-panel"),
        wfWindowTableBody: getRequiredElement("wf-window-table-body"),
        wfRobustnessGauge: getRequiredElement("wf-robustness-gauge"),
        wfRobustnessScore: getRequiredElement("wf-robustness-score"),
        wfRobustnessDesc: getRequiredElement("wf-robustness-desc"),
        wfRunBtn: getRequiredElement<HTMLButtonElement>("wf-run-btn"),
        wfQuickBtn: getRequiredElement<HTMLButtonElement>("wf-quick-btn"),
        wfCancelBtn: getRequiredElement<HTMLButtonElement>("wf-cancel-btn"),
        wfSpinner: getRequiredElement("wf-spinner"),
        wfQuickSpinner: getRequiredElement("wf-quick-spinner"),
        wfStatus: getRequiredElement("wf-status"),
    };
}

export type WalkForwardServiceDom = ReturnType<typeof createWalkForwardServiceDom>;
