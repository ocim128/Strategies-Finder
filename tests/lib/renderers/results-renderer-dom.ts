import { getRequiredElement } from "../dom-utils";

export const RESULTS_RENDERER_REQUIRED_IDS = [
    "netProfitCard",
    "netProfitPctCard",
    "entryLevelsBody",
    "advancedAnalyticsContainer",
    "advancedAnalyticsHint",
    "tradeTimingQualityContainer",
    "postEntryPathContainer",
    "postEntryPathHint",
    "snapshotProfileContainer",
    "exitReasonContainer",
    "edgeAnalysisContainer",
] as const;

export function createResultsRendererDom() {
    return {
        netProfitCard: getRequiredElement("netProfitCard"),
        netProfitPctCard: getRequiredElement("netProfitPctCard"),
        entryLevelsBody: getRequiredElement("entryLevelsBody"),
        advancedAnalyticsContainer: getRequiredElement("advancedAnalyticsContainer"),
        advancedAnalyticsHint: getRequiredElement("advancedAnalyticsHint"),
        tradeTimingQualityContainer: getRequiredElement("tradeTimingQualityContainer"),
        postEntryPathContainer: getRequiredElement("postEntryPathContainer"),
        postEntryPathHint: getRequiredElement("postEntryPathHint"),
        snapshotProfileContainer: getRequiredElement("snapshotProfileContainer"),
        exitReasonContainer: getRequiredElement("exitReasonContainer"),
        edgeAnalysisContainer: getRequiredElement("edgeAnalysisContainer"),
    };
}

export type ResultsRendererDom = ReturnType<typeof createResultsRendererDom>;
