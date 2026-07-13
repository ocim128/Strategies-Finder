/** Pure Portfolio Fit analysis: rank Stability ENTER rows, try full size, then half. */

import {
    computeStabilityAction,
    STABILITY_DATA_STALE_THRESHOLD_BARS,
} from "./miner-verdict-format-helpers";
import type { BatchStabilityRow } from "./batch-stability-mine";
import {
    buildCovarianceMatrix,
    buildDirectionalReturnSeries,
    finiteOrNull,
    finiteOrZero,
    historicalExpectedShortfall,
    marginalExpectedShortfall,
    marginalVolatilityContribution,
    mean,
    pearsonCorrelation,
    portfolioVolatility,
    sampleStandardDeviation,
    type CovarianceMatrix,
} from "./batch-portfolio-fit-statistics";
import type {
    BatchPortfolioFitInput,
    BatchPortfolioFitOptions,
    BatchPortfolioFitPortfolioSummary,
    BatchPortfolioFitReasonCode,
    BatchPortfolioFitResult,
    BatchPortfolioFitRow,
    PortfolioFitDecision,
    PortfolioFitTargetReturnSeries,
} from "./batch-portfolio-fit-types";
import {
    PORTFOLIO_FIT_DEFAULT_OPTIONS,
    resolvePortfolioFitOptions,
} from "./batch-portfolio-fit-types";

export interface EligibilityOutcome {
    eligible: boolean;
    decision: PortfolioFitDecision;
    reasonCodes: BatchPortfolioFitReasonCode[];
    stabilityAction: string;
    stabilityReason: string;
    freshness: "FRESH" | "STALE" | "UNKNOWN";
    asOfTimeKey: string | null;
}

export function evaluateEligibility(
    row: BatchStabilityRow,
    reruns: number,
    interval: string,
    nowMs: number,
): EligibilityOutcome {
    const action = computeStabilityAction(row, reruns, interval, nowMs);
    const lag = action.dataLagBars;
    const freshness = lag === null
        ? "UNKNOWN"
        : lag > STABILITY_DATA_STALE_THRESHOLD_BARS ? "STALE" : "FRESH";
    const reasonCodes: BatchPortfolioFitReasonCode[] = [];
    let decision: PortfolioFitDecision = "DEFER";
    let eligible = false;
    if (action.action === "ENTER") {
        eligible = true;
        decision = "ADD";
    } else if (action.action === "REJECT") {
        decision = "REJECT";
        reasonCodes.push("NOT_ACTIONABLE");
    } else if (action.action === "INVALID") {
        decision = "REJECT";
        reasonCodes.push(lag !== null && lag > STABILITY_DATA_STALE_THRESHOLD_BARS
            ? "DATA_STALE"
            : "DATA_TIME_UNKNOWN");
    } else {
        reasonCodes.push("NOT_ACTIONABLE");
    }
    return {
        eligible,
        decision,
        reasonCodes,
        stabilityAction: action.action,
        stabilityReason: action.reason,
        freshness,
        asOfTimeKey: row.asOfTimeKey,
    };
}

export function estimateAdjustedEdge(
    row: BatchStabilityRow,
    reruns: number,
    options: BatchPortfolioFitOptions,
): { rawEdgeFraction: number | null; adjustedEdgeFraction: number | null; haircutFraction: number } {
    const rawPct = row.medianLiftPct ?? row.medianRetPct;
    if (rawPct === null || !Number.isFinite(rawPct)) {
        return { rawEdgeFraction: null, adjustedEdgeFraction: null, haircutFraction: 0 };
    }
    const rawEdgeFraction = rawPct / 100;
    const passRate = Math.max(0, Math.min(1, row.hits / Math.max(1, reruns)));
    const warningPenalty = Math.min(0.5, Math.max(0, row.pairWarnings) * 0.05);
    const rerunFactor = 0.5 + 0.5 * Math.min(1, Math.log10(1 + Math.max(1, reruns)) / Math.log10(51));
    const haircutFraction = Math.max(0, Math.min(
        0.9,
        options.uncertaintyHaircutBase * (1 - passRate) * rerunFactor + warningPenalty,
    ));
    const adjustedEdgeFraction = rawEdgeFraction * (1 - haircutFraction);
    return {
        rawEdgeFraction,
        adjustedEdgeFraction: finiteOrNull(adjustedEdgeFraction),
        haircutFraction,
    };
}

interface PreparedCandidate {
    originalOrder: number;
    row: BatchStabilityRow;
    eligibility: EligibilityOutcome;
    edge: ReturnType<typeof estimateAdjustedEdge>;
    directionalReturns: Map<string, number>;
    volatilityPct: number | null;
    expectedShortfallPct: number | null;
    adjustedUtility: number;
}

function prepareCandidate(
    row: BatchStabilityRow,
    originalOrder: number,
    reruns: number,
    interval: string,
    nowMs: number,
    targetReturns: ReadonlyMap<string, PortfolioFitTargetReturnSeries>,
    options: BatchPortfolioFitOptions,
): PreparedCandidate {
    const eligibility = evaluateEligibility(row, reruns, interval, nowMs);
    const edge = estimateAdjustedEdge(row, reruns, options);
    const rawReturns = targetReturns.get(row.asset)?.returns ?? new Map<string, number>();
    const directionalReturns = buildDirectionalReturnSeries(
        rawReturns,
        row.direction === "LONG" ? "long" : "short",
    );
    const values = Array.from(directionalReturns.values());
    const enoughHistory = values.length >= options.minObservations;
    const volatilityPct = enoughHistory ? finiteOrNull(sampleStandardDeviation(values)) : null;
    const expectedShortfallPct = enoughHistory
        ? finiteOrNull(historicalExpectedShortfall(values, options.expectedShortfallTailProbability))
        : null;
    const downside = Math.abs(expectedShortfallPct ?? 0);
    const adjustedUtility = edge.adjustedEdgeFraction !== null && downside > 0
        ? edge.adjustedEdgeFraction / downside
        : Number.NEGATIVE_INFINITY;
    return {
        originalOrder,
        row,
        eligibility,
        edge,
        directionalReturns,
        volatilityPct,
        expectedShortfallPct,
        adjustedUtility,
    };
}

interface AcceptedEntry {
    candidate: PreparedCandidate;
    weight: number;
}

interface AllocationState {
    accepted: Map<number, AcceptedEntry>;
    grossLong: number;
    grossShort: number;
    capitalUsed: number;
    portfolioReturns: Map<string, number>;
}

function freshAllocationState(): AllocationState {
    return {
        accepted: new Map(),
        grossLong: 0,
        grossShort: 0,
        capitalUsed: 0,
        portfolioReturns: new Map(),
    };
}

function applyAllocation(state: AllocationState, candidate: PreparedCandidate, weight: number): void {
    state.accepted.set(candidate.originalOrder, { candidate, weight });
    if (candidate.row.direction === "LONG") state.grossLong += weight;
    else state.grossShort += weight;
    state.capitalUsed += (candidate.row.direction === "LONG" ? 1 : -1) * weight;
    for (const [key, value] of candidate.directionalReturns) {
        state.portfolioReturns.set(key, (state.portfolioReturns.get(key) ?? 0) + weight * value);
    }
}

function rankCandidates(candidates: PreparedCandidate[]): PreparedCandidate[] {
    return [...candidates].sort((a, b) => {
        if (a.adjustedUtility !== b.adjustedUtility) return b.adjustedUtility - a.adjustedUtility;
        if (a.row.asset !== b.row.asset) return a.row.asset.localeCompare(b.row.asset);
        if (a.row.direction !== b.row.direction) return a.row.direction.localeCompare(b.row.direction);
        return a.originalOrder - b.originalOrder;
    });
}

interface AllocationAttempt {
    accepted: boolean;
    weight: number;
    reasonCodes: BatchPortfolioFitReasonCode[];
    maxAcceptedCorrelation: number | null;
    marginalExpectedShortfallPct: number | null;
}

function rejectAttempt(
    weight: number,
    reasonCode: BatchPortfolioFitReasonCode,
    maxAcceptedCorrelation: number | null = null,
    marginalExpectedShortfallPct: number | null = null,
): AllocationAttempt {
    return {
        accepted: false,
        weight,
        reasonCodes: [reasonCode],
        maxAcceptedCorrelation,
        marginalExpectedShortfallPct,
    };
}

function attemptAllocation(
    candidate: PreparedCandidate,
    state: AllocationState,
    weight: number,
    options: BatchPortfolioFitOptions,
): AllocationAttempt {
    if (weight <= 0 || weight > options.perCandidateCapFraction + 1e-9) {
        return rejectAttempt(weight, "PORTFOLIO_CAP_REACHED");
    }
    const nextGrossLong = state.grossLong + (candidate.row.direction === "LONG" ? weight : 0);
    const nextGrossShort = state.grossShort + (candidate.row.direction === "SHORT" ? weight : 0);
    const signedWeight = (candidate.row.direction === "LONG" ? 1 : -1) * weight;
    if (nextGrossLong + nextGrossShort > options.totalGrossCapFraction + 1e-9
        || Math.abs(state.capitalUsed + signedWeight) > options.capitalCapFraction + 1e-9) {
        return rejectAttempt(weight, "PORTFOLIO_CAP_REACHED");
    }

    let maxAcceptedCorrelation: number | null = null;
    for (const entry of state.accepted.values()) {
        const { correlation } = pearsonCorrelation(
            candidate.directionalReturns,
            entry.candidate.directionalReturns,
        );
        if (correlation === null) continue;
        if (maxAcceptedCorrelation === null || Math.abs(correlation) > Math.abs(maxAcceptedCorrelation)) {
            maxAcceptedCorrelation = correlation;
        }
        if (correlation > options.correlationCap) {
            return rejectAttempt(weight, "HIGH_CORRELATION", maxAcceptedCorrelation);
        }
    }

    const marginalEs = state.accepted.size > 0
        ? marginalExpectedShortfall(
            state.portfolioReturns,
            candidate.directionalReturns,
            weight,
            options.expectedShortfallTailProbability,
        )
        : 0;
    if (-marginalEs > options.tailRiskIncreaseThreshold + 1e-12) {
        return rejectAttempt(weight, "TAIL_RISK_INCREASE", maxAcceptedCorrelation, finiteOrNull(marginalEs));
    }
    return {
        accepted: true,
        weight,
        reasonCodes: ["ACCEPTED_WITHIN_LIMITS"],
        maxAcceptedCorrelation,
        marginalExpectedShortfallPct: finiteOrNull(marginalEs),
    };
}

interface CandidateOutcome {
    accepted: AllocationAttempt | null;
    fullFailure: AllocationAttempt | null;
    finalFailure: AllocationAttempt | null;
}

function runAllocator(
    candidates: PreparedCandidate[],
    fullWeight: number,
    options: BatchPortfolioFitOptions,
): { state: AllocationState; outcomes: Map<number, CandidateOutcome> } {
    const state = freshAllocationState();
    const outcomes = new Map<number, CandidateOutcome>();
    for (const candidate of rankCandidates(candidates)) {
        const full = attemptAllocation(candidate, state, fullWeight, options);
        if (full.accepted) {
            applyAllocation(state, candidate, fullWeight);
            outcomes.set(candidate.originalOrder, { accepted: full, fullFailure: null, finalFailure: null });
            continue;
        }
        const halfWeight = fullWeight / 2;
        const half = attemptAllocation(candidate, state, halfWeight, options);
        if (half.accepted) {
            applyAllocation(state, candidate, halfWeight);
            outcomes.set(candidate.originalOrder, { accepted: half, fullFailure: full, finalFailure: null });
        } else {
            outcomes.set(candidate.originalOrder, { accepted: null, fullFailure: full, finalFailure: half });
        }
    }
    return { state, outcomes };
}

function covarianceSubmatrix(
    accepted: AcceptedEntry[],
    covariance: CovarianceMatrix,
    eligibleIndex: ReadonlyMap<number, number>,
): number[][] {
    return accepted.map((left) => accepted.map((right) => {
        const i = eligibleIndex.get(left.candidate.originalOrder);
        const j = eligibleIndex.get(right.candidate.originalOrder);
        return i === undefined || j === undefined ? 0 : covariance.matrix[i]?.[j] ?? 0;
    }));
}

function buildPortfolioSummary(
    state: AllocationState,
    covariance: CovarianceMatrix | null,
    eligibleIndex: ReadonlyMap<number, number>,
    options: BatchPortfolioFitOptions,
): BatchPortfolioFitPortfolioSummary {
    if (state.accepted.size === 0) {
        return {
            allocatedFraction: 0,
            expectedReturnPct: null,
            volatilityPct: null,
            expectedShortfallPct: null,
            grossLongFraction: 0,
            grossShortFraction: 0,
        };
    }
    const accepted = Array.from(state.accepted.values());
    const returns = Array.from(state.portfolioReturns.values());
    const volatilityPct = covariance?.valid
        ? portfolioVolatility(
            accepted.map((entry) => entry.weight),
            covarianceSubmatrix(accepted, covariance, eligibleIndex),
        )
        : null;
    return {
        allocatedFraction: finiteOrZero(state.grossLong + state.grossShort),
        expectedReturnPct: finiteOrNull(mean(returns)),
        volatilityPct: finiteOrNull(volatilityPct),
        expectedShortfallPct: finiteOrNull(
            historicalExpectedShortfall(returns, options.expectedShortfallTailProbability),
        ),
        grossLongFraction: finiteOrZero(state.grossLong),
        grossShortFraction: finiteOrZero(state.grossShort),
    };
}

function buildResultRow(
    candidate: PreparedCandidate,
    outcome: CandidateOutcome | undefined,
    state: AllocationState,
    initialCapital: number,
    covariance: CovarianceMatrix | null,
    eligibleIndex: ReadonlyMap<number, number>,
): BatchPortfolioFitRow {
    const acceptedEntry = state.accepted.get(candidate.originalOrder);
    const allocationFraction = acceptedEntry?.weight ?? 0;
    const accepted = outcome?.accepted ?? null;
    const failure = outcome?.finalFailure ?? outcome?.fullFailure ?? null;
    let marginalVolatilityPct: number | null = null;
    if (acceptedEntry && covariance?.valid) {
        const acceptedEntries = Array.from(state.accepted.values());
        const candidateIndex = acceptedEntries.findIndex(
            (entry) => entry.candidate.originalOrder === candidate.originalOrder,
        );
        if (candidateIndex >= 0) {
            marginalVolatilityPct = finiteOrNull(marginalVolatilityContribution(
                acceptedEntries.map((entry) => entry.weight),
                covarianceSubmatrix(acceptedEntries, covariance, eligibleIndex),
                candidateIndex,
            ));
        }
    }
    const reasonCodes = candidate.eligibility.reasonCodes.length > 0
        ? candidate.eligibility.reasonCodes
        : accepted?.reasonCodes ?? failure?.reasonCodes ?? ["ACCEPTED_WITHIN_LIMITS"];
    return {
        asset: candidate.row.asset,
        direction: candidate.row.direction === "LONG" ? "long" : "short",
        decision: allocationFraction <= 0
            ? candidate.eligibility.decision
            : outcome?.fullFailure ? "ADD_SMALL" : "ADD",
        allocationFraction: finiteOrZero(allocationFraction),
        allocationAmount: finiteOrZero(allocationFraction * initialCapital),
        expectedEdgePct: candidate.edge.adjustedEdgeFraction,
        volatilityPct: candidate.volatilityPct,
        expectedShortfallPct: candidate.expectedShortfallPct,
        marginalVolatilityPct,
        marginalExpectedShortfallPct: accepted?.marginalExpectedShortfallPct ?? failure?.marginalExpectedShortfallPct ?? null,
        maxAcceptedCorrelation: accepted?.maxAcceptedCorrelation ?? failure?.maxAcceptedCorrelation ?? null,
        reasonCodes,
        allocationLimitReasonCodes: outcome?.accepted && outcome.fullFailure
            ? outcome.fullFailure.reasonCodes
            : [],
    };
}

export function runPortfolioFit(input: BatchPortfolioFitInput): BatchPortfolioFitResult {
    const options = resolvePortfolioFitOptions(input.options);
    const nowMs = input.nowMs ?? Date.now();
    const warnings: string[] = [];
    const targetReturns = new Map(input.targetReturns.map((series) => [series.asset, series]));
    const prepared = input.stability.rows
        .map((row, index) => prepareCandidate(
            row,
            index,
            input.stability.reruns,
            input.interval,
            nowMs,
            targetReturns,
            options,
        ))
        .filter((candidate) => candidate.eligibility.stabilityAction === "ENTER");

    const eligible: PreparedCandidate[] = [];
    for (const candidate of prepared) {
        if (candidate.directionalReturns.size < options.minObservations) {
            candidate.eligibility.eligible = false;
            candidate.eligibility.decision = "REJECT";
            candidate.eligibility.reasonCodes.push("INSUFFICIENT_HISTORY");
        } else if (candidate.edge.adjustedEdgeFraction === null || candidate.edge.adjustedEdgeFraction <= 0) {
            candidate.eligibility.eligible = false;
            candidate.eligibility.decision = "REJECT";
            candidate.eligibility.reasonCodes.push("NON_POSITIVE_EDGE");
        } else if (!Number.isFinite(candidate.adjustedUtility)) {
            candidate.eligibility.eligible = false;
            candidate.eligibility.decision = "REJECT";
            candidate.eligibility.reasonCodes.push("NUMERICAL_INVALID");
        } else {
            eligible.push(candidate);
        }
    }

    const covariance = eligible.length > 0
        ? buildCovarianceMatrix(eligible.map((candidate) => candidate.directionalReturns), options.minObservations)
        : null;
    if (covariance && !covariance.valid) {
        warnings.push("Covariance matrix invalid after shrinkage; marginal volatility estimates unavailable.");
    }
    const initialCapital = input.capital.initialCapital > 0 ? input.capital.initialCapital : 1;
    const fullWeight = Math.max(0, Math.min(
        options.perCandidateCapFraction,
        input.capital.baseAllocation / initialCapital,
    ));
    if (fullWeight <= 0) warnings.push("Resolved base allocation is zero; all candidates deferred.");
    const { state, outcomes } = runAllocator(eligible, fullWeight, options);
    const eligibleIndex = new Map(eligible.map((candidate, index) => [candidate.originalOrder, index]));
    const resultRows = prepared.map((candidate) => buildResultRow(
        candidate,
        outcomes.get(candidate.originalOrder),
        state,
        initialCapital,
        covariance,
        eligibleIndex,
    ));
    const asOfTimeKey = prepared
        .map((candidate) => candidate.eligibility.asOfTimeKey)
        .filter((key): key is string => Boolean(key))
        .sort()
        .at(-1) ?? null;
    return {
        schemaVersion: 1,
        fingerprint: input.fingerprint,
        generatedAt: nowMs,
        asOfTimeKey,
        engine: "typescript",
        rows: resultRows,
        portfolio: buildPortfolioSummary(state, covariance, eligibleIndex, options),
        warnings,
        kellyFraction: input.capital.kellyFraction,
        baseAllocationSource: input.capital.baseAllocationSource,
        configuredKellyFraction: input.capital.configuredKellyFraction,
    };
}

export { PORTFOLIO_FIT_DEFAULT_OPTIONS };
