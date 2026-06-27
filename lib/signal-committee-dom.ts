import {
    getRequiredDomElements,
    getRequiredDomIds,
    type RequiredDomElementMap,
} from "./dom-utils";

const SIGNAL_COMMITTEE_DOM_IDS = {
    signalCommitteeTab: "signalcommitteeTab",
    signalCommitteeEmpty: "signalCommitteeEmpty",
    signalCommitteeContent: "signalCommitteeContent",
    signalCommitteeAddBtn: "signalCommitteeAddBtn",
    signalCommitteeAddSavedBtn: "signalCommitteeAddSavedBtn",
    signalCommitteeBulkDeleteBtn: "signalCommitteeBulkDeleteBtn",
    signalCommitteeSelectAll: "signalCommitteeSelectAll",
    signalCommitteeBulkPairsBtn: "signalCommitteeBulkPairsBtn",
    signalCommitteeBulkPairs: "signalCommitteeBulkPairs",
    signalCommitteeBulkAddBtn: "signalCommitteeBulkAddBtn",
    signalCommitteeSyncSyntheticBtn: "signalCommitteeSyncSyntheticBtn",
    signalCommitteeRefreshBtn: "signalCommitteeRefreshBtn",
    signalCommitteeChartToggleBtn: "signalCommitteeChartToggleBtn",
    signalCommitteeAutoToggle: "signalCommitteeAutoToggle",
    signalCommitteeIntervalSelect: "signalCommitteeIntervalSelect",
    signalCommitteeScore: "signalCommitteeScore",
    signalCommitteeLongShort: "signalCommitteeLongShort",
    signalCommitteeAvgAge: "signalCommitteeAvgAge",
    signalCommitteeAvgGain: "signalCommitteeAvgGain",
    signalCommitteeLastUpdated: "signalCommitteeLastUpdated",
    signalCommitteeStatus: "signalCommitteeStatus",
    signalCommitteeTableBody: "signalCommitteeTableBody",
    signalCommitteeTableWrapper: "signalCommitteeTableWrapper",
    signalCommitteeAlertEnabled: "signalCommitteeAlertEnabled",
    signalCommitteeAlertLongThreshold: "signalCommitteeAlertLongThreshold",
    signalCommitteeAlertShortThreshold: "signalCommitteeAlertShortThreshold",
    signalCommitteeAlertSaveBtn: "signalCommitteeAlertSaveBtn",
    signalCommitteeAlertStatus: "signalCommitteeAlertStatus",
    signalCommitteeDiagnosticPre: "signalCommitteeDiagnosticPre",
    signalCommitteeLegLeaderboard: "signalCommitteeLegLeaderboard",
    signalCommitteeScoreEdgeBody: "signalCommitteeScoreEdgeBody",
    signalCommitteeScoreEdgeCopyBtn: "signalCommitteeScoreEdgeCopyBtn",
} as const;

export const SIGNAL_COMMITTEE_REQUIRED_IDS = getRequiredDomIds(SIGNAL_COMMITTEE_DOM_IDS);

type SignalCommitteeTypedControls = {
    signalCommitteeAddBtn: HTMLButtonElement;
    signalCommitteeAddSavedBtn: HTMLButtonElement;
    signalCommitteeBulkDeleteBtn: HTMLButtonElement;
    signalCommitteeSelectAll: HTMLInputElement;
    signalCommitteeBulkPairsBtn: HTMLButtonElement;
    signalCommitteeBulkPairs: HTMLTextAreaElement;
    signalCommitteeBulkAddBtn: HTMLButtonElement;
    signalCommitteeSyncSyntheticBtn: HTMLButtonElement;
    signalCommitteeRefreshBtn: HTMLButtonElement;
    signalCommitteeChartToggleBtn: HTMLButtonElement;
    signalCommitteeAutoToggle: HTMLInputElement;
    signalCommitteeIntervalSelect: HTMLSelectElement;
    signalCommitteeAlertEnabled: HTMLInputElement;
    signalCommitteeAlertLongThreshold: HTMLInputElement;
    signalCommitteeAlertShortThreshold: HTMLInputElement;
    signalCommitteeAlertSaveBtn: HTMLButtonElement;
    signalCommitteeScoreEdgeCopyBtn: HTMLButtonElement;
};

export type SignalCommitteeDom =
    Omit<RequiredDomElementMap<typeof SIGNAL_COMMITTEE_DOM_IDS>, keyof SignalCommitteeTypedControls>
    & SignalCommitteeTypedControls;

export function createSignalCommitteeDom(): SignalCommitteeDom {
    return getRequiredDomElements(SIGNAL_COMMITTEE_DOM_IDS) as SignalCommitteeDom;
}
