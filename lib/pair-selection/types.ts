import type { TradeLedgerDirection } from "../batch-backtest/trade-ledger-schema";

export interface PairCandidate {
    pair: string;
    baseSymbol: string;
    quoteSymbol: string;
    direction: TradeLedgerDirection;
    signalTime: number;
    signalBarIndex: number;
    feat_entryRangePosition: number | null;
    feat_atrPct: number | null;
    feat_return20: number | null;
    feat_gapPct: number | null;
    feat_dow: number | null;
    feat_hour: number | null;
    feat_pairWinRatePrior: number | null;
    feat_pairTradesPrior: number;
    feat_barsSincePairLastFire: number | null;
    feat_pairSpreadVolatility20: number | null;
    feat_legVolatilityRatio20: number | null;
    feat_candidatesAtTime: number | null;
}

export interface PairEventContext {
    signalTime: number;
    interval: string;
    strategyKey: string;
}

export type PairSelectionRuleParams = Readonly<Record<string, number>>;

export interface PairSelectionParamBounds {
    min: number;
    max: number;
    step?: number;
}

export type PairSelectionTieBreak = (
    left: PairCandidate,
    right: PairCandidate,
    event: PairEventContext,
) => number;

export interface PairSelectionRule {
    key: string;
    name: string;
    description: string;
    /** Mining rules expose one numeric parameter; references are exempt. */
    defaultParams: PairSelectionRuleParams;
    paramLabels: Readonly<Record<string, string>>;
    normalizeParams?: (params: PairSelectionRuleParams) => PairSelectionRuleParams;
    metadata?: {
        paramBounds?: Readonly<Record<string, PairSelectionParamBounds>>;
    };
    score: (
        candidate: PairCandidate,
        event: PairEventContext,
        params: PairSelectionRuleParams,
        /** Fresh copies of every candidate in the same event, before gating. */
        pool: readonly PairCandidate[],
    ) => number;
    /** Optional rule-specific tie-break; omitted rules use the shared FNV digest. */
    tieBreak?: PairSelectionTieBreak;
}
