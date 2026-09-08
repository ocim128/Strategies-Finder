import { getRequiredElement } from "./dom-utils";

export const SELECTION_RULES_REQUIRED_IDS = [
    "selectionRulesSection",
    "selectionRulesFolderSelect",
    "selectionRulesHorizonSelect",
    "selectionRulesFolderMeta",
    "selectionRulesSelectAll",
    "selectionRulesSelectNone",
    "selectionRulesInvert",
    "selectionRulesRuleList",
    "selectionRulesSelectionSummary",
    "selectionRulesRefreshBtn",
    "selectionRulesRunBtn",
    "selectionRulesStopBtn",
    "selectionRulesStatus",
    "selectionRulesProgress",
    "selectionRulesProgressFill",
    "selectionRulesProgressText",
    "selectionRulesResults",
    "selectionRulesEmpty",
    "selectionRulesReport",
    "selectionRulesCopyBtn",
    "selectionRulesDiagnostics",
    "selectionRulesCopyDiagnosticsBtn",
] as const;

export function createSelectionRulesDom() {
    return {
        selectionRulesSection: getRequiredElement<HTMLElement>("selectionRulesSection"),
        selectionRulesFolderSelect: getRequiredElement<HTMLSelectElement>("selectionRulesFolderSelect"),
        selectionRulesHorizonSelect: getRequiredElement<HTMLSelectElement>("selectionRulesHorizonSelect"),
        selectionRulesFolderMeta: getRequiredElement<HTMLDivElement>("selectionRulesFolderMeta"),
        selectionRulesSelectAll: getRequiredElement<HTMLButtonElement>("selectionRulesSelectAll"),
        selectionRulesSelectNone: getRequiredElement<HTMLButtonElement>("selectionRulesSelectNone"),
        selectionRulesInvert: getRequiredElement<HTMLButtonElement>("selectionRulesInvert"),
        selectionRulesRuleList: getRequiredElement<HTMLDivElement>("selectionRulesRuleList"),
        selectionRulesSelectionSummary: getRequiredElement<HTMLSpanElement>("selectionRulesSelectionSummary"),
        selectionRulesRefreshBtn: getRequiredElement<HTMLButtonElement>("selectionRulesRefreshBtn"),
        selectionRulesRunBtn: getRequiredElement<HTMLButtonElement>("selectionRulesRunBtn"),
        selectionRulesStopBtn: getRequiredElement<HTMLButtonElement>("selectionRulesStopBtn"),
        selectionRulesStatus: getRequiredElement<HTMLDivElement>("selectionRulesStatus"),
        selectionRulesProgress: getRequiredElement<HTMLDivElement>("selectionRulesProgress"),
        selectionRulesProgressFill: getRequiredElement<HTMLProgressElement>("selectionRulesProgressFill"),
        selectionRulesProgressText: getRequiredElement<HTMLDivElement>("selectionRulesProgressText"),
        selectionRulesResults: getRequiredElement<HTMLTableSectionElement>("selectionRulesResults"),
        selectionRulesEmpty: getRequiredElement<HTMLDivElement>("selectionRulesEmpty"),
        selectionRulesReport: getRequiredElement<HTMLPreElement>("selectionRulesReport"),
        selectionRulesCopyBtn: getRequiredElement<HTMLButtonElement>("selectionRulesCopyBtn"),
        selectionRulesDiagnostics: getRequiredElement<HTMLPreElement>("selectionRulesDiagnostics"),
        selectionRulesCopyDiagnosticsBtn: getRequiredElement<HTMLButtonElement>("selectionRulesCopyDiagnosticsBtn"),
    };
}

export type SelectionRulesDom = ReturnType<typeof createSelectionRulesDom>;
