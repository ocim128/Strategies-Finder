import { getRequiredElement } from "./dom-utils";

export const STRATEGY_LIBRARY_AUDIT_REQUIRED_IDS = [
    "libraryauditTab",
    "strategyLibraryAuditStatus",
    "runStrategyLibraryAuditBtn",
    "strategyLibraryAuditSearch",
    "strategyLibraryAuditArchiveHeavyOnly",
    "strategyLibraryAuditHideCore",
    "strategyLibraryAuditSummary",
    "strategyLibraryAuditWarnings",
    "strategyLibraryAuditResults",
] as const;

export function createStrategyLibraryAuditDom() {
    return {
        libraryauditTab: getRequiredElement("libraryauditTab"),
        strategyLibraryAuditStatus: getRequiredElement("strategyLibraryAuditStatus"),
        runStrategyLibraryAuditBtn: getRequiredElement<HTMLButtonElement>("runStrategyLibraryAuditBtn"),
        strategyLibraryAuditSearch: getRequiredElement<HTMLInputElement>("strategyLibraryAuditSearch"),
        strategyLibraryAuditArchiveHeavyOnly: getRequiredElement<HTMLInputElement>("strategyLibraryAuditArchiveHeavyOnly"),
        strategyLibraryAuditHideCore: getRequiredElement<HTMLInputElement>("strategyLibraryAuditHideCore"),
        strategyLibraryAuditSummary: getRequiredElement("strategyLibraryAuditSummary"),
        strategyLibraryAuditWarnings: getRequiredElement("strategyLibraryAuditWarnings"),
        strategyLibraryAuditResults: getRequiredElement("strategyLibraryAuditResults"),
    };
}

export type StrategyLibraryAuditDom = ReturnType<typeof createStrategyLibraryAuditDom>;
