import { getRequiredElement } from "../dom-utils";

export const TRADE_LEDGER_SWEEP_REQUIRED_IDS = [
    "tradeLedgerSweepSection",
    "tradeLedgerSweepRefreshBtn",
    "tradeLedgerSweepFolderSelect",
    "tradeLedgerSweepFolderMeta",
    "tradeLedgerSweepRunBtn",
    "tradeLedgerSweepStopBtn",
    "tradeLedgerSweepStatus",
    "tradeLedgerSweepProgress",
    "tradeLedgerSweepProgressFill",
    "tradeLedgerSweepProgressText",
    "tradeLedgerSweepHoldoutWarning",
    "tradeLedgerSweepOutput",
    "tradeLedgerSweepCopySummaryBtn",
    "tradeLedgerSweepCopyDiagnosticsBtn",
    "tradeLedgerSweepResults",
    "tradeLedgerSweepEmpty",
    "tradeLedgerSweepDiagnostics",
] as const;

export function createTradeLedgerSweepDom() {
    return {
        tradeLedgerSweepSection: getRequiredElement<HTMLElement>("tradeLedgerSweepSection"),
        tradeLedgerSweepRefreshBtn: getRequiredElement<HTMLButtonElement>("tradeLedgerSweepRefreshBtn"),
        tradeLedgerSweepFolderSelect: getRequiredElement<HTMLSelectElement>("tradeLedgerSweepFolderSelect"),
        tradeLedgerSweepFolderMeta: getRequiredElement<HTMLDivElement>("tradeLedgerSweepFolderMeta"),
        tradeLedgerSweepRunBtn: getRequiredElement<HTMLButtonElement>("tradeLedgerSweepRunBtn"),
        tradeLedgerSweepStopBtn: getRequiredElement<HTMLButtonElement>("tradeLedgerSweepStopBtn"),
        tradeLedgerSweepStatus: getRequiredElement<HTMLDivElement>("tradeLedgerSweepStatus"),
        tradeLedgerSweepProgress: getRequiredElement<HTMLDivElement>("tradeLedgerSweepProgress"),
        tradeLedgerSweepProgressFill: getRequiredElement<HTMLDivElement>("tradeLedgerSweepProgressFill"),
        tradeLedgerSweepProgressText: getRequiredElement<HTMLDivElement>("tradeLedgerSweepProgressText"),
        tradeLedgerSweepHoldoutWarning: getRequiredElement<HTMLDivElement>("tradeLedgerSweepHoldoutWarning"),
        tradeLedgerSweepOutput: getRequiredElement<HTMLDivElement>("tradeLedgerSweepOutput"),
        tradeLedgerSweepCopySummaryBtn: getRequiredElement<HTMLButtonElement>("tradeLedgerSweepCopySummaryBtn"),
        tradeLedgerSweepCopyDiagnosticsBtn: getRequiredElement<HTMLButtonElement>("tradeLedgerSweepCopyDiagnosticsBtn"),
        tradeLedgerSweepResults: getRequiredElement<HTMLDivElement>("tradeLedgerSweepResults"),
        tradeLedgerSweepEmpty: getRequiredElement<HTMLDivElement>("tradeLedgerSweepEmpty"),
        tradeLedgerSweepDiagnostics: getRequiredElement<HTMLPreElement>("tradeLedgerSweepDiagnostics"),
    };
}

export type TradeLedgerSweepDom = ReturnType<typeof createTradeLedgerSweepDom>;
