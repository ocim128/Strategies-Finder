/** Canonical structured verdict classifier for trade-ledger rule results. */

export const TRADE_LEDGER_EDGE_BAR_PP = 0.3;
export const TRADE_LEDGER_EDGE_MIN_KEPT_PCT = 2;

export type TradeLedgerVerdict =
    | "EDGE-CANDIDATE"
    | "HOLDOUT-NEG"
    | "TOO-RARE"
    | "NO-EDGE"
    | "ERROR";

export interface TradeLedgerVerdictInput {
    ruleName: string;
    keptPct: number | null;
    isMeanPnlDeltaPp: number | null;
    isMedianPnlDeltaPp: number | null;
    holdoutMeanPnlDeltaPp: number | null;
    holdoutMedianPnlDeltaPp: number | null;
    error?: string | null;
}

export interface TradeLedgerVerdictRow extends TradeLedgerVerdictInput {
    verdict: TradeLedgerVerdict;
    weak: boolean;
    note: string;
}

const VERDICT_ORDER: Record<TradeLedgerVerdict, number> = {
    "EDGE-CANDIDATE": 0,
    "HOLDOUT-NEG": 1,
    "TOO-RARE": 2,
    "NO-EDGE": 3,
    ERROR: 4,
};

/** Apply the one canonical EDGE/holdout/rarity/error decision tree. */
export function classifyTradeLedgerVerdict(input: TradeLedgerVerdictInput): TradeLedgerVerdictRow {
    if (input.error) {
        return {
            ...input,
            verdict: "ERROR",
            weak: false,
            note: input.error.slice(0, 90),
        };
    }
    if (input.keptPct === 0) {
        return {
            ...input,
            verdict: "NO-EDGE",
            weak: false,
            note: "no candidates admitted",
        };
    }
    if (
        input.keptPct === null
        || input.isMeanPnlDeltaPp === null
        || input.isMedianPnlDeltaPp === null
        || input.holdoutMeanPnlDeltaPp === null
        || input.holdoutMedianPnlDeltaPp === null
    ) {
        return {
            ...input,
            verdict: "ERROR",
            weak: false,
            note: "no RULE summary found in block",
        };
    }
    if (input.isMeanPnlDeltaPp >= TRADE_LEDGER_EDGE_BAR_PP && input.keptPct >= TRADE_LEDGER_EDGE_MIN_KEPT_PCT) {
        const weak = input.isMedianPnlDeltaPp < 0;
        return {
            ...input,
            verdict: input.holdoutMeanPnlDeltaPp > 0 ? "EDGE-CANDIDATE" : "HOLDOUT-NEG",
            weak,
            note: weak ? "weak: IS median negative" : "",
        };
    }
    if (input.isMeanPnlDeltaPp >= TRADE_LEDGER_EDGE_BAR_PP) {
        return {
            ...input,
            verdict: "TOO-RARE",
            weak: false,
            note: "passes delta bar but kept < 2%",
        };
    }
    return { ...input, verdict: "NO-EDGE", weak: false, note: "" };
}

/** Return the deterministic research-table ordering without mutating input. */
export function sortTradeLedgerVerdicts(rows: readonly TradeLedgerVerdictRow[]): TradeLedgerVerdictRow[] {
    return [...rows].sort((a, b) =>
        VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict]
        || (b.holdoutMeanPnlDeltaPp ?? -Infinity) - (a.holdoutMeanPnlDeltaPp ?? -Infinity)
        || (b.isMeanPnlDeltaPp ?? -Infinity) - (a.isMeanPnlDeltaPp ?? -Infinity)
        || (a.ruleName < b.ruleName ? -1 : a.ruleName > b.ruleName ? 1 : 0),
    );
}

export function countTradeLedgerVerdicts(rows: readonly TradeLedgerVerdictRow[]): Map<TradeLedgerVerdict, number> {
    const counts = new Map<TradeLedgerVerdict, number>();
    for (const row of rows) counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1);
    return counts;
}
