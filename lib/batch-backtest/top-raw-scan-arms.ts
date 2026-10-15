import type { ScanFinalist, ScanRow } from "./top-raw-scan-contract";

/** Batch NOW arms the scan can rank leaders by, mirroring the Batch arm
 * identifiers. The profit-now arms reproduce the OPEN_SCORE causal semantics
 * exactly (see open-score-replay/artifact-scan.ts): a pair's open vote counts
 * only when the pair's own realized PnL was strictly positive at the trade's
 * entry, and the CONF arm weights each vote by the confidence weight of that
 * closed-trade history. */
export const SCAN_ARMS = ["top_raw", "top_mean", "max_active", "top_raw_profit_now", "top_mean_profit_now", "top_raw_profit_now_conf"] as const;
export type ScanArm = (typeof SCAN_ARMS)[number];
export const DEFAULT_SCAN_ARM: ScanArm = "top_raw";
export function validateScanArm(value: unknown): ScanArm {
    if (value === undefined) return DEFAULT_SCAN_ARM;
    if (typeof value === "string" && (SCAN_ARMS as readonly string[]).includes(value)) return value as ScanArm;
    throw new Error(`arm must be one of ${SCAN_ARMS.join(", ")}.`);
}
export interface ScanArmVoteRequirements { profitNow: boolean; profitNowConf: boolean }
export function scanArmVoteRequirements(arm: ScanArm): ScanArmVoteRequirements {
    return {
        profitNow: arm === "top_raw_profit_now" || arm === "top_mean_profit_now",
        profitNowConf: arm === "top_raw_profit_now_conf",
    };
}
/** Finder-arm display key, matching the Batch arm identifiers. */
export function scanArmLabel(arm: ScanArm): string {
    return arm === "top_raw" ? "TOP_RAW" : arm === "top_mean" ? "TOP_MEAN" : arm === "max_active" ? "MAX_ACTIVE"
        : arm === "top_raw_profit_now" ? "TOP_RAW_PROFIT_NOW" : arm === "top_mean_profit_now" ? "TOP_MEAN_PROFIT_NOW" : "TOP_RAW_PROFIT_NOW_CONF";
}

/** Per-asset sums over its evaluated pairs: signed endpoint votes, pairs with
 * a nonzero vote, causally gated open votes (and their active-pair count), and
 * the confidence-weighted gated open votes. */
export interface ScanArmSums {
    raw: number; activePairs: number;
    profitNow: number; profitNowActivePairs: number; profitNowConf: number;
}
export function scanArmValue(arm: ScanArm, sums: ScanArmSums): number | null {
    switch (arm) {
        case "top_raw": return sums.raw;
        case "max_active": return sums.activePairs;
        case "top_raw_profit_now": return sums.profitNow;
        case "top_raw_profit_now_conf": return sums.profitNowConf;
        case "top_mean": return sums.activePairs ? sums.raw / sums.activePairs : null;
        case "top_mean_profit_now": return sums.profitNowActivePairs ? sums.profitNow / sums.profitNowActivePairs : null;
    }
}
/** Positivity mirrors the Batch NOW pools: the vote arms qualify on raw > 0
 * and the profit-now arms on their own gated score > 0. */
export function scanArmPositive(arm: ScanArm, sums: ScanArmSums): boolean {
    if (arm === "top_raw_profit_now" || arm === "top_mean_profit_now") return sums.profitNow > 0;
    if (arm === "top_raw_profit_now_conf") return sums.profitNowConf > 0;
    return sums.raw > 0;
}
export function scanArmEstimatedValue(arm: ScanArm, row: ScanRow): number | null {
    return scanArmValue(arm, {
        raw: row.estimatedRaw ?? 0, activePairs: row.estimatedActiveDegree ?? 0,
        profitNow: row.estimatedProfitNow ?? 0, profitNowActivePairs: row.estimatedProfitNowActiveDegree ?? 0, profitNowConf: row.estimatedProfitNowConf ?? 0,
    });
}
export function scanArmSampledValue(arm: ScanArm, row: ScanRow): number | null {
    return scanArmValue(arm, {
        raw: row.sampledRaw, activePairs: row.activeDegree,
        profitNow: row.sampledProfitNow, profitNowActivePairs: row.sampledProfitNowActiveDegree, profitNowConf: row.sampledProfitNowConf,
    });
}
export function scanArmExactValue(arm: ScanArm, row: ScanFinalist): number | null {
    return scanArmValue(arm, {
        raw: row.exactRaw ?? 0, activePairs: row.exactActiveDegree ?? 0,
        profitNow: row.exactProfitNow ?? 0, profitNowActivePairs: row.exactProfitNowActiveDegree ?? 0, profitNowConf: row.exactProfitNowConf ?? 0,
    });
}
export function scanArmExactPositive(arm: ScanArm, row: ScanFinalist): boolean {
    return row.complete && scanArmPositive(arm, {
        raw: row.exactRaw ?? 0, activePairs: row.exactActiveDegree ?? 0,
        profitNow: row.exactProfitNow ?? 0, profitNowActivePairs: row.exactProfitNowActiveDegree ?? 0, profitNowConf: row.exactProfitNowConf ?? 0,
    });
}
