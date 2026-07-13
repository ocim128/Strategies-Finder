/** Serializable, server-safe contracts for Portfolio Fit. */

import type { BatchStabilityMineResult } from "./batch-stability-mine";

export type BatchPortfolioFitEngine = "typescript";

export type BatchPortfolioFitReasonCode =
    | "NOT_ACTIONABLE"
    | "DATA_STALE"
    | "DATA_TIME_UNKNOWN"
    | "INSUFFICIENT_HISTORY"
    | "NON_POSITIVE_EDGE"
    | "NUMERICAL_INVALID"
    | "PORTFOLIO_CAP_REACHED"
    | "HIGH_CORRELATION"
    | "TAIL_RISK_INCREASE"
    | "UNCERTAINTY_HAIRCUT"
    | "ACCEPTED_WITHIN_LIMITS";

export type PortfolioFitDecision = "ADD" | "ADD_SMALL" | "DEFER" | "REJECT";
export type PortfolioFitKellyFraction = "full" | "half" | "quarter" | null;

export type PortfolioFitBaseAllocationSource =
    | "fixed"
    | "percent"
    | "direct_fraction_fallback_fixed"
    | "direct_fraction_fallback_percent"
    | "resolved_kelly"
    | "unknown";

export interface BatchPortfolioFitCapital {
    initialCapital: number;
    /** Maximum amount Portfolio Fit may allocate to one candidate. */
    baseAllocation: number;
    /** Kelly fraction actually used, not merely configured. */
    kellyFraction: PortfolioFitKellyFraction;
    baseAllocationSource: PortfolioFitBaseAllocationSource;
    configuredKellyFraction: PortfolioFitKellyFraction;
}

export interface BatchPortfolioFitOptions {
    minObservations: number;
    returnWindowBars: number;
    expectedShortfallTailProbability: number;
    perCandidateCapFraction: number;
    totalGrossCapFraction: number;
    capitalCapFraction: number;
    correlationCap: number;
    /** Maximum allowed worsening in expected shortfall. */
    tailRiskIncreaseThreshold: number;
    uncertaintyHaircutBase: number;
}

export const PORTFOLIO_FIT_DEFAULT_OPTIONS: Readonly<BatchPortfolioFitOptions> = {
    minObservations: 30,
    returnWindowBars: 300,
    expectedShortfallTailProbability: 0.05,
    perCandidateCapFraction: 0.25,
    totalGrossCapFraction: 1,
    capitalCapFraction: 1,
    correlationCap: 0.85,
    tailRiskIncreaseThreshold: 0,
    uncertaintyHaircutBase: 0.5,
};

export interface BatchPortfolioFitInput {
    fingerprint: string;
    interval: string;
    stability: BatchStabilityMineResult;
    capital: BatchPortfolioFitCapital;
    targetReturns: ReadonlyArray<PortfolioFitTargetReturnSeries>;
    options?: Partial<BatchPortfolioFitOptions>;
    nowMs?: number;
}

export interface PortfolioFitTargetReturnSeries {
    asset: string;
    /** Raw close-to-close returns keyed by normalized candle time. */
    returns: Map<string, number>;
}

export interface BatchPortfolioFitRow {
    asset: string;
    direction: "long" | "short";
    decision: PortfolioFitDecision;
    allocationFraction: number;
    allocationAmount: number;
    expectedEdgePct: number | null;
    volatilityPct: number | null;
    expectedShortfallPct: number | null;
    marginalVolatilityPct: number | null;
    marginalExpectedShortfallPct: number | null;
    maxAcceptedCorrelation: number | null;
    reasonCodes: BatchPortfolioFitReasonCode[];
    /** Why a full-size allocation failed when half-size was accepted. */
    allocationLimitReasonCodes: BatchPortfolioFitReasonCode[];
}

export interface BatchPortfolioFitPortfolioSummary {
    allocatedFraction: number;
    /** Historical arithmetic mean of allocated directional per-bar returns. */
    expectedReturnPct: number | null;
    volatilityPct: number | null;
    expectedShortfallPct: number | null;
    grossLongFraction: number;
    grossShortFraction: number;
}

export interface BatchPortfolioFitResult {
    schemaVersion: 1;
    fingerprint: string;
    generatedAt: number;
    asOfTimeKey: string | null;
    engine: BatchPortfolioFitEngine;
    /** Stability ENTER candidates only. */
    rows: BatchPortfolioFitRow[];
    portfolio: BatchPortfolioFitPortfolioSummary;
    warnings: string[];
    kellyFraction: PortfolioFitKellyFraction;
    baseAllocationSource: PortfolioFitBaseAllocationSource;
    configuredKellyFraction: PortfolioFitKellyFraction;
}

const OPTION_RANGES: Record<keyof BatchPortfolioFitOptions, [number, number]> = {
    minObservations: [1, 100000],
    returnWindowBars: [1, 100000],
    expectedShortfallTailProbability: [0.001, 0.5],
    perCandidateCapFraction: [1e-6, 1],
    totalGrossCapFraction: [1e-6, 1],
    capitalCapFraction: [1e-6, 1],
    correlationCap: [0, 1],
    tailRiskIncreaseThreshold: [0, 1],
    uncertaintyHaircutBase: [0, 0.999],
};

export function resolvePortfolioFitOptions(
    override?: Partial<BatchPortfolioFitOptions>,
): BatchPortfolioFitOptions {
    const resolved = { ...PORTFOLIO_FIT_DEFAULT_OPTIONS };
    if (!override) return resolved;
    for (const key of Object.keys(override) as Array<keyof BatchPortfolioFitOptions>) {
        const value = override[key];
        if (value === undefined || !Number.isFinite(value)) continue;
        const range = OPTION_RANGES[key];
        if (!range) continue;
        const [min, max] = range;
        if (value < min || value > max) continue;
        resolved[key] = value;
    }
    return resolved;
}
