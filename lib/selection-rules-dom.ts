import { getRequiredElement } from "./dom-utils";

export const SELECTION_RULES_REQUIRED_IDS = [
    "selectionRulesSection",
    "selectionRulesFolderSelect",
    "selectionRulesHorizonSelect",
    "selectionRulesFolderMeta",
    "selectionRulesRuleList",
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
] as const;

export function createSelectionRulesDom() {
    return {
        selectionRulesSection: getRequiredElement<HTMLElement>("selectionRulesSection"),
        selectionRulesFolderSelect: getRequiredElement<HTMLSelectElement>("selectionRulesFolderSelect"),
        selectionRulesHorizonSelect: getRequiredElement<HTMLSelectElement>("selectionRulesHorizonSelect"),
        selectionRulesFolderMeta: getRequiredElement<HTMLDivElement>("selectionRulesFolderMeta"),
        selectionRulesRuleList: getRequiredElement<HTMLDivElement>("selectionRulesRuleList"),
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
    };
}

export type SelectionRulesDom = ReturnType<typeof createSelectionRulesDom>;
