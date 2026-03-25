import { getRequiredElement } from "./dom-utils";

export const LIVE_POSITIONS_REQUIRED_IDS = [
    "livePositionsPanel",
    "lpOpenCount",
    "lpViewToggle",
    "lpRefreshBtn",
    "lpCollapseBtn",
    "lpCollapseIcon",
    "lpBody",
    "lpLastUpdated",
    "lpPollingStatus",
    "lpPollingDot",
    "lpPollingText",
    "lpList",
    "lpEmpty",
    "lpMismatchBanner",
    "lpMismatchText",
    "lpDetailModal",
    "lpDetailTitle",
    "lpDetailClose",
    "lpDetailBody",
    "lpDetailLoading",
    "lpDetailContent",
] as const;

export function createLivePositionsDom() {
    return {
        panel: getRequiredElement("livePositionsPanel"),
        count: getRequiredElement("lpOpenCount"),
        viewToggle: getRequiredElement<HTMLButtonElement>("lpViewToggle"),
        refreshBtn: getRequiredElement<HTMLButtonElement>("lpRefreshBtn"),
        collapseBtn: getRequiredElement<HTMLButtonElement>("lpCollapseBtn"),
        collapseIcon: getRequiredElement("lpCollapseIcon"),
        body: getRequiredElement("lpBody"),
        lastUpdated: getRequiredElement("lpLastUpdated"),
        pollingStatus: getRequiredElement<HTMLButtonElement>("lpPollingStatus"),
        pollingDot: getRequiredElement("lpPollingDot"),
        pollingText: getRequiredElement("lpPollingText"),
        list: getRequiredElement("lpList"),
        empty: getRequiredElement("lpEmpty"),
        mismatchBanner: getRequiredElement("lpMismatchBanner"),
        mismatchText: getRequiredElement("lpMismatchText"),
        detailModal: getRequiredElement("lpDetailModal"),
        detailTitle: getRequiredElement("lpDetailTitle"),
        detailClose: getRequiredElement<HTMLButtonElement>("lpDetailClose"),
        detailBody: getRequiredElement("lpDetailBody"),
        detailLoading: getRequiredElement("lpDetailLoading"),
        detailContent: getRequiredElement("lpDetailContent"),
    };
}

export type LivePositionsDom = ReturnType<typeof createLivePositionsDom>;
