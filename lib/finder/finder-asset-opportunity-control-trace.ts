import { createHash } from "node:crypto";
import type { FinderAssetOpportunityCandidateSummaryRow } from "./finder-asset-opportunity-research-types";

export interface FinderAssetOpportunityControlDraw {
    symbol: string;
    identityHash: string | null;
}

export interface FinderAssetOpportunityControlTrace {
    seed: number;
    draws: FinderAssetOpportunityControlDraw[];
    digest: string;
}

function sha256Json(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function finite(value: unknown): boolean {
    return typeof value === "number" && Number.isFinite(value);
}

function isControlEligible(
    row: FinderAssetOpportunityCandidateSummaryRow,
    horizon: number,
): boolean {
    if (!row.evaluationOk || !row.passesTradeFilter) return false;
    const outcome = row.forwardOutcomes?.[String(horizon)];
    return outcome !== undefined
        && (outcome.exitReason === "take_profit"
            || outcome.exitReason === "stop_loss"
            || outcome.exitReason === "end_of_data")
        && finite(outcome.barsHeld)
        && finite(outcome.grossReturnPercent)
        && finite(outcome.slippagePercent)
        && finite(outcome.commissionPercent)
        && finite(outcome.netReturnPercent)
        && finite(outcome.entryPrice)
        && finite(outcome.exitPrice)
        && typeof outcome.entryTimestamp === "string"
        && outcome.entryTimestamp.length > 0
        && typeof outcome.exitTimestamp === "string"
        && outcome.exitTimestamp.length > 0;
}

/** The fixed RNG used by both the producer and the post-hoc analyzer. */
export function createFinderAssetOpportunityRng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) | 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

/** Reproduce the fixed random-pool draw for one archived fold. */
export function buildFinderAssetOpportunityControlTrace(
    rows: readonly FinderAssetOpportunityCandidateSummaryRow[],
    foldIndex: number,
    horizon: number,
    seed: number,
): FinderAssetOpportunityControlTrace {
    const bySymbol = new Map<string, FinderAssetOpportunityCandidateSummaryRow[]>();
    for (const row of rows) {
        const symbolRows = bySymbol.get(row.symbol) ?? [];
        symbolRows.push(row);
        bySymbol.set(row.symbol, symbolRows);
    }
    const rng = createFinderAssetOpportunityRng(seed + foldIndex);
    const draws = [...bySymbol.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([symbol, symbolRows]) => {
            const eligible = symbolRows.filter((row) => isControlEligible(row, horizon));
            const draw = eligible.length > 0
                ? eligible[Math.floor(rng() * eligible.length)]!
                : null;
            return { symbol, identityHash: draw?.identityHash ?? null };
        });
    return {
        seed,
        draws,
        digest: sha256Json(draws),
    };
}
