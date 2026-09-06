export type SelectionRegime = "bullish" | "bearish" | "unavailable";

/** The only candidate fields a selection rule may inspect. */
export interface SelectionCandidate {
    asset: string;
    pair: string | null;
    score: number | null;
    signedVotes: number;
    activePairCount: number;
    ema200Above: boolean;
    breadth: number | null;
    regime: SelectionRegime;
    longEligible: boolean;
    shortEligible: boolean;
    inPool: boolean;
}

/** The only event fields a selection rule may inspect. */
export interface SelectionEventContext {
    eventId: string;
    decisionTimeSec: number;
    horizonBars: number;
    interval: string;
}

export type SelectionRuleParams = Readonly<Record<string, number>>;

export interface SelectionParamBounds {
    min: number;
    max: number;
    step?: number;
}

export interface SelectionRule {
    key: string;
    name: string;
    description: string;
    defaultParams: SelectionRuleParams;
    paramLabels: Readonly<Record<string, string>>;
    normalizeParams?: (params: SelectionRuleParams) => SelectionRuleParams;
    metadata?: {
        paramBounds?: Readonly<Record<string, SelectionParamBounds>>;
    };
    score: (
        candidate: SelectionCandidate,
        event: SelectionEventContext,
        params: SelectionRuleParams,
        /** Fresh read-only copies of ALL positive candidates of the same event (pre-gating). Enables cross-candidate theses. */
        pool: readonly SelectionCandidate[],
    ) => number;
}
