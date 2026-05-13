import {
    getRequiredDomElements,
    getRequiredDomIds,
    type RequiredDomElementMap,
} from "./dom-utils";

const ENSEMBLE_LAB_DOM_IDS = {
    ensembleTab: "ensembleTab",
    ensembleEmpty: "ensembleEmpty",
    ensembleContent: "ensembleContent",
    ensembleTargetPicker: "ensembleTargetPicker",
    ensembleTargetSelect: "ensembleTargetSelect",
    ensembleTargetButton: "ensembleTargetButton",
    ensembleTargetMenu: "ensembleTargetMenu",
    ensembleTargetSearch: "ensembleTargetSearch",
    ensembleTargetList: "ensembleTargetList",
    ensembleTargetPickerEmptyState: "ensembleTargetPickerEmptyState",
    ensembleTargetSummary: "ensembleTargetSummary",
    ensembleMinSamples: "ensembleMinSamples",
    ensembleSymbolBadge: "ensembleSymbolBadge",
    ensembleIntervalBadge: "ensembleIntervalBadge",
    ensembleContextSearch: "ensembleContextSearch",
    ensembleContextFamilyFilter: "ensembleContextFamilyFilter",
    ensembleContextSelectAll: "ensembleContextSelectAll",
    ensembleContextSelectNone: "ensembleContextSelectNone",
    ensembleContextInvertVisible: "ensembleContextInvertVisible",
    ensembleContextSelectVisible: "ensembleContextSelectVisible",
    ensembleContextSelectSameFamily: "ensembleContextSelectSameFamily",
    ensembleContextExcludeSameFamily: "ensembleContextExcludeSameFamily",
    ensembleContextSummary: "ensembleContextSummary",
    ensembleContextList: "ensembleContextList",
    ensembleContextHelper: "ensembleContextHelper",
    ensembleContextEmptyState: "ensembleContextEmptyState",
    ensembleRefreshConfigsBtn: "ensembleRefreshConfigsBtn",
    ensembleRunBtn: "ensembleRunBtn",
    ensembleRunPolymarketBtn: "ensembleRunPolymarketBtn",
    ensembleLoadConflictBacktestBtn: "ensembleLoadConflictBacktestBtn",
    ensembleLoadBestVetoBacktestBtn: "ensembleLoadBestVetoBacktestBtn",
    ensembleSaveConflictRecipeBtn: "ensembleSaveConflictRecipeBtn",
    ensembleSaveBestVetoRecipeBtn: "ensembleSaveBestVetoRecipeBtn",
    ensembleStatus: "ensembleStatus",
    ensembleResults: "ensembleResults",
    ensembleSummary: "ensembleSummary",
    ensembleCurrentContextSection: "ensembleCurrentContextSection",
    ensembleCurrentContextSummary: "ensembleCurrentContextSummary",
    ensembleCurrentContextDetails: "ensembleCurrentContextDetails",
    ensembleHistoricalOddsSection: "ensembleHistoricalOddsSection",
    ensembleHistoricalOddsSummary: "ensembleHistoricalOddsSummary",
    ensembleHistoricalOddsTableBody: "ensembleHistoricalOddsTableBody",
    ensemblePolymarketSection: "ensemblePolymarketSection",
    ensemblePolymarketEmpty: "ensemblePolymarketEmpty",
    ensemblePolymarketStatus: "ensemblePolymarketStatus",
    ensemblePolymarketConflictPolicy: "ensemblePolymarketConflictPolicy",
    ensemblePolymarketDirectionSlice: "ensemblePolymarketDirectionSlice",
    ensembleSignalRecipeSelect: "ensembleSignalRecipeSelect",
    ensembleSignalRecipeDirectionSelect: "ensembleSignalRecipeDirectionSelect",
    ensembleSignalRecipeDownloadScriptBtn: "ensembleSignalRecipeDownloadScriptBtn",
    ensembleSignalRecipeCopyEnvBtn: "ensembleSignalRecipeCopyEnvBtn",
    ensembleSignalRecipeDeleteBtn: "ensembleSignalRecipeDeleteBtn",
    ensembleSignalRecipeStatus: "ensembleSignalRecipeStatus",
    ensemblePolymarketSummary: "ensemblePolymarketSummary",
    ensemblePolymarketAgreement: "ensemblePolymarketAgreement",
    ensemblePolymarketTableBody: "ensemblePolymarketTableBody",
    ensemblePolymarketVetoSummary: "ensemblePolymarketVetoSummary",
    ensemblePolymarketVetoTableBody: "ensemblePolymarketVetoTableBody",
    ensemblePolymarketOverrideSummary: "ensemblePolymarketOverrideSummary",
    ensemblePolymarketOverrideTableBody: "ensemblePolymarketOverrideTableBody",
    ensembleBuilderSection: "ensembleBuilderSection",
    ensembleBuilderSummary: "ensembleBuilderSummary",
    ensembleBuilderTableBody: "ensembleBuilderTableBody",
    ensembleDiagnosticsSection: "ensembleDiagnosticsSection",
    ensembleContributionSection: "ensembleContributionSection",
    ensembleContributionSummary: "ensembleContributionSummary",
    ensembleContributionTableBody: "ensembleContributionTableBody",
    ensembleReplacementSection: "ensembleReplacementSection",
    ensembleReplacementSummary: "ensembleReplacementSummary",
    ensembleReplacementTableBody: "ensembleReplacementTableBody",
    ensembleRadarSection: "ensembleRadarSection",
    ensembleRadarContent: "ensembleRadarContent",
} as const;

export const ENSEMBLE_LAB_REQUIRED_IDS = getRequiredDomIds(ENSEMBLE_LAB_DOM_IDS);

type EnsembleLabTypedControls = {
    ensembleTargetSelect: HTMLSelectElement;
    ensembleTargetButton: HTMLButtonElement;
    ensembleTargetSearch: HTMLInputElement;
    ensembleMinSamples: HTMLInputElement;
    ensembleContextSearch: HTMLInputElement;
    ensembleContextFamilyFilter: HTMLSelectElement;
    ensembleContextSelectAll: HTMLButtonElement;
    ensembleContextSelectNone: HTMLButtonElement;
    ensembleContextInvertVisible: HTMLButtonElement;
    ensembleContextSelectVisible: HTMLButtonElement;
    ensembleContextSelectSameFamily: HTMLButtonElement;
    ensembleContextExcludeSameFamily: HTMLButtonElement;
    ensembleRefreshConfigsBtn: HTMLButtonElement;
    ensembleRunBtn: HTMLButtonElement;
    ensembleRunPolymarketBtn: HTMLButtonElement;
    ensembleLoadConflictBacktestBtn: HTMLButtonElement;
    ensembleLoadBestVetoBacktestBtn: HTMLButtonElement;
    ensembleSaveConflictRecipeBtn: HTMLButtonElement;
    ensembleSaveBestVetoRecipeBtn: HTMLButtonElement;
    ensemblePolymarketConflictPolicy: HTMLSelectElement;
    ensemblePolymarketDirectionSlice: HTMLSelectElement;
    ensembleSignalRecipeSelect: HTMLSelectElement;
    ensembleSignalRecipeDirectionSelect: HTMLSelectElement;
    ensembleSignalRecipeDownloadScriptBtn: HTMLButtonElement;
    ensembleSignalRecipeCopyEnvBtn: HTMLButtonElement;
    ensembleSignalRecipeDeleteBtn: HTMLButtonElement;
    ensembleDiagnosticsSection: HTMLDetailsElement;
};

export type EnsembleLabDom =
    Omit<RequiredDomElementMap<typeof ENSEMBLE_LAB_DOM_IDS>, keyof EnsembleLabTypedControls>
    & EnsembleLabTypedControls;

export function createEnsembleLabDom(): EnsembleLabDom {
    return getRequiredDomElements(ENSEMBLE_LAB_DOM_IDS) as EnsembleLabDom;
}
