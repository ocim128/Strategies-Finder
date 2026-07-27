import { getRequiredElement } from "../dom-utils";

export const IBKR_DATA_REQUIRED_IDS = [
    "ibkrdataTab",
    "ibkrDataStatusBtn",
    "ibkrDataResolveBtn",
    "ibkrDataDownloadBtn",
    "ibkrDataSyncBtn",
    "ibkrDataStopBtn",
    "ibkrDataCopyBtn",
    "ibkrDataAppendStaleBtn",
    "ibkrDataSymbols",
    "ibkrDataSource",
    "ibkrDataInterval",
    "ibkrDataPeriod",
    "ibkrDataStatus",
    "ibkrDataOutput",
] as const;

export function createIbkrDataDom() {
    return {
        ibkrdataTab: getRequiredElement("ibkrdataTab"),
        ibkrDataStatusBtn: getRequiredElement<HTMLButtonElement>("ibkrDataStatusBtn"),
        ibkrDataResolveBtn: getRequiredElement<HTMLButtonElement>("ibkrDataResolveBtn"),
        ibkrDataDownloadBtn: getRequiredElement<HTMLButtonElement>("ibkrDataDownloadBtn"),
        ibkrDataSyncBtn: getRequiredElement<HTMLButtonElement>("ibkrDataSyncBtn"),
        ibkrDataStopBtn: getRequiredElement<HTMLButtonElement>("ibkrDataStopBtn"),
        ibkrDataCopyBtn: getRequiredElement<HTMLButtonElement>("ibkrDataCopyBtn"),
        ibkrDataAppendStaleBtn: getRequiredElement<HTMLButtonElement>("ibkrDataAppendStaleBtn"),
        ibkrDataSymbols: getRequiredElement<HTMLTextAreaElement>("ibkrDataSymbols"),
        ibkrDataSource: getRequiredElement<HTMLSelectElement>("ibkrDataSource"),
        ibkrDataInterval: getRequiredElement<HTMLSelectElement>("ibkrDataInterval"),
        ibkrDataPeriod: getRequiredElement<HTMLInputElement>("ibkrDataPeriod"),
        ibkrDataStatus: getRequiredElement<HTMLDivElement>("ibkrDataStatus"),
        ibkrDataOutput: getRequiredElement<HTMLPreElement>("ibkrDataOutput"),
    };
}

export type IbkrDataDom = ReturnType<typeof createIbkrDataDom>;
