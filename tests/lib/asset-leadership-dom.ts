import { getRequiredElement } from "./dom-utils";

export const ASSET_LEADERSHIP_REQUIRED_IDS = [
    "assetLeadershipStatus",
    "assetLeadershipRefresh",
    "assetLeadershipCopy",
    "assetLeadershipClear",
    "assetLeadershipOverviewMetrics",
    "assetLeadershipDerived",
    "assetLeadershipCurrentLeaders",
    "assetLeadershipEmergingLeaders",
    "assetLeadershipFallingLeaders",
    "assetLeadershipConsistentLeaders",
    "assetLeadershipRecentRuns",
] as const;

export function createAssetLeadershipDom() {
    return {
        status: getRequiredElement("assetLeadershipStatus"),
        refresh: getRequiredElement<HTMLButtonElement>("assetLeadershipRefresh"),
        copy: getRequiredElement<HTMLButtonElement>("assetLeadershipCopy"),
        clear: getRequiredElement<HTMLButtonElement>("assetLeadershipClear"),
        overviewMetrics: getRequiredElement("assetLeadershipOverviewMetrics"),
        derived: getRequiredElement("assetLeadershipDerived"),
        currentLeaders: getRequiredElement("assetLeadershipCurrentLeaders"),
        emergingLeaders: getRequiredElement("assetLeadershipEmergingLeaders"),
        fallingLeaders: getRequiredElement("assetLeadershipFallingLeaders"),
        consistentLeaders: getRequiredElement("assetLeadershipConsistentLeaders"),
        recentRuns: getRequiredElement("assetLeadershipRecentRuns"),
    };
}

export type AssetLeadershipDom = ReturnType<typeof createAssetLeadershipDom>;
