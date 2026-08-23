export interface FinderAssetOpportunityForwardOutcomeSummary {
    exitReason: "take_profit" | "stop_loss" | "end_of_data";
    barsHeld: number;
    grossReturnPercent: number;
    slippagePercent: number;
    commissionPercent: number;
    netReturnPercent: number;
    entryPrice: number;
    exitPrice: number;
    entryTimestamp: string;
    exitTimestamp: string;
}

/** Scalar-only research row; this module has no Node or browser dependencies. */
export interface FinderAssetOpportunityCandidateSummaryRow {
    symbol: string;
    strategyKey: string;
    candidateFingerprint: string;
    identityHash: string;
    candidateIndex: number;
    evaluationOk: boolean;
    passesTradeFilter: boolean;
    profitFactor: number | null;
    netProfitPercent: number | null;
    totalTrades: number | null;
    tpHitCount: number | null;
    medianBarsToTP: number | null;
    medianBarsToTerminal: number | null;
    tpFirstShare: number | null;
    /** True when a fresh signal supplied an entry inside the OOS window. */
    forwardOutcomeEligible?: boolean;
    forwardOutcomes?: Record<string, FinderAssetOpportunityForwardOutcomeSummary>;
}

export interface FinderAssetOpportunityPairContextRow {
    symbol: string;
    candidateCount: number;
    distinctStrategyCount: number;
    strategyCoverage: number;
    strategyIdEntropy: number;
    meanMedianBarsToTP: number | null;
    meanMedianBarsToTerminal: number | null;
    meanTpFirstShare: number | null;
    topProfitFactor: number | null;
    fullPool: true;
}

export type FinderFreshWindowJudgmentStatus = "VALID" | "INVALID";

export const FINDER_FRESH_WINDOW_BATCH_ROLES = ["collection", "judged", "replication"] as const;
export type FinderFreshWindowBatchRole = typeof FINDER_FRESH_WINDOW_BATCH_ROLES[number];

export function isFinderFreshWindowBatchRole(value: unknown): value is FinderFreshWindowBatchRole {
    return typeof value === "string"
        && (FINDER_FRESH_WINDOW_BATCH_ROLES as readonly string[]).includes(value);
}
