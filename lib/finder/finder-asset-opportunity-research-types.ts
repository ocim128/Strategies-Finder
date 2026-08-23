/** Scalar-only research row; this module has no Node or browser dependencies. */
export interface FinderAssetOpportunityCandidateSummaryRow {
    symbol: string;
    strategyKey: string;
    candidateFingerprint: string;
    identityHash: string;
    candidateIndex: number;
    evaluationOk: boolean;
    passesTradeFilter: boolean;
    netProfitPercent: number | null;
    totalTrades: number | null;
    tpHitCount: number | null;
    medianBarsToTP: number | null;
    medianBarsToTerminal: number | null;
    tpFirstShare: number | null;
}
