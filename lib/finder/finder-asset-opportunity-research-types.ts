export interface FinderAssetOpportunityForwardOutcomeSummary {
    exitReason: "take_profit" | "stop_loss" | "end_of_data";
    barsHeld: number;
    netReturnPercent: number;
    entryPrice: number;
    exitPrice: number;
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
    forwardOutcomes?: Record<string, FinderAssetOpportunityForwardOutcomeSummary>;
}
