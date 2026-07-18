import type {
    FinderOosVerdict,
    FinderUniverseCandidate,
    FinderUniverseMetric,
    FinderUniverseOosAggregate,
    FinderUniverseOptions,
    FinderUniverseSymbolResult,
} from "../types/finder";
import type { StrategyParams } from "../types/strategies";
import { median } from "../statistics-utils";

const MIN_RELIABLE_SYMBOL_TRADES = 15;

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function roundScore(value: number): number {
    return Math.round(value * 100) / 100;
}

function normalizeProfitFactor(value: number): number {
    if (!Number.isFinite(value) || value <= 1) return 0;
    return clamp01((Math.min(value, 3) - 1) / 2);
}

function normalizeCompositeEdgeRatio(value: number): number {
    if (!Number.isFinite(value) || value <= 1) return 0;
    return clamp01((Math.min(value, 3) - 1) / 2);
}

function computeDownsideSurvival(worstNetProfit: number, positiveAnchor: number): number {
    if (!Number.isFinite(worstNetProfit) || worstNetProfit >= 0) return 1;
    if (!Number.isFinite(positiveAnchor) || positiveAnchor <= 0) return 0;
    return clamp01(positiveAnchor / (positiveAnchor + Math.abs(worstNetProfit)));
}

function computeSymbolReliability(symbols: readonly FinderUniverseSymbolResult[]) {
    let activeSymbols = 0;
    let reliableSymbols = 0;
    let profitableReliableSymbols = 0;
    for (const symbol of symbols) {
        const result = symbol.result;
        if (!result || result.totalTrades <= 0) continue;
        activeSymbols += 1;
        if (result.totalTrades < MIN_RELIABLE_SYMBOL_TRADES) continue;
        reliableSymbols += 1;
        if (result.netProfit > 0.0001) {
            profitableReliableSymbols += 1;
        }
    }

    return {
        activeSymbols,
        reliableSymbols,
        reliableActiveRatio: activeSymbols > 0 ? reliableSymbols / activeSymbols : 0,
        profitableReliableRatio: reliableSymbols > 0 ? profitableReliableSymbols / reliableSymbols : 0,
    };
}

function computeOosPassReliability(symbols: readonly FinderUniverseSymbolResult[]) {
    let activeOosSymbols = 0;
    let decisiveOosSymbols = 0;
    let passingOosSymbols = 0;
    for (const symbol of symbols) {
        const oos = symbol.oosResult;
        if (!oos || oos.totalTrades <= 0) continue;
        activeOosSymbols += 1;
        if (symbol.oosVerdict === "pass" || symbol.oosVerdict === "fail") {
            decisiveOosSymbols += 1;
        }
        if (symbol.oosVerdict === "pass") {
            passingOosSymbols += 1;
        }
    }

    return {
        activeOosSymbols,
        decisiveOosSymbols,
        passingOosSymbols,
        passRatio: decisiveOosSymbols > 0 ? passingOosSymbols / decisiveOosSymbols : 0,
    };
}

function isAscendingUniverseMetric(metric: FinderUniverseMetric): boolean {
    return metric === "worstMaxDrawdownPercent" || metric === "medianMaxDrawdownPercent";
}

function computeReturnDrawdownRatio(netProfitPercent: number, maxDrawdownPercent: number): number {
    if (maxDrawdownPercent > 0.0001) return netProfitPercent / maxDrawdownPercent;
    if (netProfitPercent > 0.0001) return Number.MAX_SAFE_INTEGER;
    if (netProfitPercent < -0.0001) return Number.MIN_SAFE_INTEGER;
    return 0;
}

function classifyCounts(symbols: readonly FinderUniverseSymbolResult[]) {
    let activeSymbols = 0;
    let profitableSymbols = 0;
    let losingSymbols = 0;
    let flatSymbols = 0;
    let noTradeSymbols = 0;
    let totalTrades = 0;
    const expectancies: number[] = [];
    const netProfits: number[] = [];
    const sharpes: number[] = [];
    const profitFactors: number[] = [];
    const compositeEdgeRatios: number[] = [];
    const maxDrawdownPercents: number[] = [];
    const returnDrawdownRatios: number[] = [];

    for (const symbol of symbols) {
        const result = symbol.result;
        if (!result) {
            if (symbol.status === "no_trades") {
                noTradeSymbols += 1;
            }
            continue;
        }

        if (result.totalTrades <= 0) {
            noTradeSymbols += 1;
            continue;
        }

        activeSymbols += 1;
        totalTrades += result.totalTrades;
        expectancies.push(result.expectancy);
        netProfits.push(result.netProfit);
        if (result.sharpeRatioAvailable === true) {
            sharpes.push(result.sharpeRatio);
        }
        profitFactors.push(result.profitFactor);
        if (typeof result.compositeEdgeRatio === "number" && Number.isFinite(result.compositeEdgeRatio)) {
            compositeEdgeRatios.push(result.compositeEdgeRatio);
        }
        if (result.drawdownAvailable === true) {
            const maxDrawdownPercent = Math.max(0, result.maxDrawdownPercent);
            maxDrawdownPercents.push(maxDrawdownPercent);
            returnDrawdownRatios.push(computeReturnDrawdownRatio(result.netProfitPercent, maxDrawdownPercent));
        }

        if (result.netProfit > 0.0001) {
            profitableSymbols += 1;
        } else if (result.netProfit < -0.0001) {
            losingSymbols += 1;
        } else {
            flatSymbols += 1;
        }
    }

    return {
        activeSymbols,
        profitableSymbols,
        losingSymbols,
        flatSymbols,
        noTradeSymbols,
        totalTrades,
        medianExpectancy: median(expectancies),
        medianSharpe: median(sharpes),
        medianSharpeAvailable: sharpes.length > 0,
        medianProfitFactor: median(profitFactors),
        medianNetProfit: median(netProfits),
        medianCompositeEdgeRatio: compositeEdgeRatios.length > 0 ? median(compositeEdgeRatios) : 0,
        drawdownMetricsAvailable: maxDrawdownPercents.length > 0,
        worstMaxDrawdownPercent: maxDrawdownPercents.length > 0 ? Math.max(...maxDrawdownPercents) : 0,
        medianMaxDrawdownPercent: median(maxDrawdownPercents),
        medianReturnDrawdownRatio: median(returnDrawdownRatios),
        worstNetProfit: netProfits.length > 0 ? Math.min(...netProfits) : 0,
        bestNetProfit: netProfits.length > 0 ? Math.max(...netProfits) : 0,
    };
}

export function computeRobustUniverseScore(item: Pick<FinderUniverseCandidate,
    "symbols"
    | "activeSymbols"
    | "totalTrades"
    | "profitableActiveRatio"
    | "medianExpectancy"
    | "medianProfitFactor"
    | "medianCompositeEdgeRatio"
    | "medianNetProfit"
    | "worstNetProfit"
    | "bestNetProfit"
>): number {
    if (item.activeSymbols <= 0 || item.totalTrades <= 0) return 0;

    const reliability = computeSymbolReliability(item.symbols);
    const breadth = clamp01(item.profitableActiveRatio);
    const reliableBreadth = breadth * clamp01(reliability.reliableActiveRatio) * clamp01(reliability.profitableReliableRatio);
    const activeConfidence = clamp01(item.activeSymbols / (item.activeSymbols + 2));
    const tradeConfidence = clamp01(Math.sqrt(item.totalTrades / Math.max(60, item.activeSymbols * MIN_RELIABLE_SYMBOL_TRADES)));
    const profitFactorScore = normalizeProfitFactor(item.medianProfitFactor);
    const edgeRatioScore = item.medianCompositeEdgeRatio > 0
        ? normalizeCompositeEdgeRatio(item.medianCompositeEdgeRatio)
        : profitFactorScore;
    const edgeScore = item.medianExpectancy > 0
        ? (profitFactorScore * 0.6) + (edgeRatioScore * 0.4)
        : 0;
    const downsideSurvival = computeDownsideSurvival(
        item.worstNetProfit,
        Math.max(0, item.bestNetProfit, item.medianNetProfit)
    );

    return roundScore(100 * reliableBreadth * activeConfidence * tradeConfidence * edgeScore * downsideSurvival);
}

export function computeWindowStabilityScore(item: Pick<FinderUniverseCandidate,
    "symbols"
    | "activeSymbols"
    | "profitableActiveRatio"
    | "bestNetProfit"
    | "medianNetProfit"
    | "oosAggregate"
>): number {
    const oos = item.oosAggregate;
    if (!oos || item.activeSymbols <= 0 || oos.activeSymbols <= 0) return 0;

    const isBreadth = clamp01(item.profitableActiveRatio);
    const oosReliability = computeOosPassReliability(item.symbols);
    const oosBreadth = clamp01(oosReliability.passingOosSymbols / item.activeSymbols);
    const breadthRetention = isBreadth > 0 ? clamp01(oosBreadth / isBreadth) : 0;
    const activeRetention = clamp01(oos.activeSymbols / item.activeSymbols);
    const decisiveRetention = clamp01(oosReliability.decisiveOosSymbols / item.activeSymbols);
    const breadthFloor = Math.min(isBreadth, oosBreadth);
    const downsideSurvival = computeDownsideSurvival(
        oos.worstNetProfit,
        Math.max(0, item.bestNetProfit, item.medianNetProfit)
    );
    const verdictMultiplier = oos.verdict === "pass"
        ? 1
        : oos.verdict === "inconclusive"
            ? 0.5
            : 0;

    return roundScore(100 * breadthFloor * breadthRetention * activeRetention * decisiveRetention * downsideSurvival * verdictMultiplier);
}

export function updateFinderUniverseCandidateScores(candidate: FinderUniverseCandidate): void {
    candidate.robustUniverseScore = computeRobustUniverseScore(candidate);
    candidate.windowStabilityScore = computeWindowStabilityScore(candidate);
}

/**
 * Per-symbol OOS verdict. Mirrors the current-chart gate: pass requires a
 * non-negative OOS net profit and an OOS profit factor of at least 1.0. Too
 * few OOS trades (below the per-symbol floor) is inconclusive, not a failure.
 */
export function computeUniverseSymbolOosVerdict(args: {
    oosNetProfit: number;
    oosProfitFactor: number;
    oosTotalTrades: number;
    minTrades: number;
}): FinderOosVerdict {
    const floor = Math.max(1, args.minTrades);
    if (args.oosTotalTrades < floor) return "inconclusive";
    return args.oosNetProfit >= 0 && args.oosProfitFactor >= 1.0 ? "pass" : "fail";
}

/**
 * Strategy-level OOS summary across all symbols. The verdict compares the OOS
 * profitable-active breadth against the IS baseline:
 * - `fail` when fewer than 30% of active OOS symbols are profitable, or the
 *   OOS breadth collapsed below half the IS breadth (curve-fit signal);
 * - `inconclusive` when too few symbols produced any OOS trades;
 * - `pass` otherwise.
 */
export function computeUniverseOosAggregate(args: {
    symbols: FinderUniverseSymbolResult[];
    isProfitableActiveRatio: number;
    minActiveSymbols: number;
}): FinderUniverseOosAggregate {
    let activeSymbols = 0;
    let profitableSymbols = 0;
    let worstNetProfit = 0;
    for (const symbol of args.symbols) {
        const oos = symbol.oosResult;
        if (!oos || oos.totalTrades <= 0) continue;
        activeSymbols += 1;
        if (oos.netProfit > 0.0001) profitableSymbols += 1;
        worstNetProfit = Math.min(worstNetProfit, oos.netProfit);
    }
    const profitableActiveRatio = activeSymbols > 0 ? profitableSymbols / activeSymbols : 0;

    let verdict: FinderOosVerdict;
    if (activeSymbols < Math.max(1, args.minActiveSymbols)) {
        verdict = "inconclusive";
    } else if (profitableActiveRatio < 0.3 || profitableActiveRatio < args.isProfitableActiveRatio * 0.5) {
        verdict = "fail";
    } else {
        verdict = "pass";
    }
    return { verdict, activeSymbols, profitableSymbols, profitableActiveRatio, worstNetProfit };
}

export function buildFinderUniverseCandidate(input: {
    strategyKey: string;
    strategyName: string;
    params: StrategyParams;
    symbols: FinderUniverseSymbolResult[];
    evaluationStoppedEarly?: boolean;
    stoppedReason?: FinderUniverseCandidate["stoppedReason"];
    exitStrategyKey?: string;
    exitStrategyName?: string;
    exitStrategyParams?: StrategyParams;
}): FinderUniverseCandidate {
    const counts = classifyCounts(input.symbols);
    const candidate: FinderUniverseCandidate = {
        strategyKey: input.strategyKey,
        strategyName: input.strategyName,
        params: input.params,
        symbols: [...input.symbols],
        ...counts,
        profitableActiveRatio: counts.activeSymbols > 0
            ? counts.profitableSymbols / counts.activeSymbols
            : 0,
        robustUniverseScore: 0,
        windowStabilityScore: 0,
        evaluationStoppedEarly: input.evaluationStoppedEarly,
        stoppedReason: input.stoppedReason,
        ...(input.exitStrategyKey
            ? {
                exitStrategyKey: input.exitStrategyKey,
                exitStrategyName: input.exitStrategyName,
                exitStrategyParams: input.exitStrategyParams,
            }
            : {}),
    };
    updateFinderUniverseCandidateScores(candidate);
    return candidate;
}

export function getFinderUniverseMetricValue(
    item: FinderUniverseCandidate,
    metric: FinderUniverseMetric
): number {
    switch (metric) {
        case "robustUniverseScore":
            return item.robustUniverseScore;
        case "windowStabilityScore":
            return item.windowStabilityScore;
        case "profitableActiveRatio":
            return item.profitableActiveRatio;
        case "activeSymbols":
            return item.activeSymbols;
        case "medianExpectancy":
            return item.medianExpectancy;
        case "medianExpectancyWeightedTrades":
            return item.medianExpectancy * item.totalTrades;
        case "medianSharpe":
            return item.medianSharpe;
        case "medianProfitFactor":
            return item.medianProfitFactor;
        case "medianProfitFactorWeightedTrades":
            return item.medianProfitFactor * item.totalTrades;
        case "medianCompositeEdgeRatio":
            return item.medianCompositeEdgeRatio;
        case "worstMaxDrawdownPercent":
            return item.worstMaxDrawdownPercent;
        case "medianMaxDrawdownPercent":
            return item.medianMaxDrawdownPercent;
        case "medianReturnDrawdownRatio":
            return item.medianReturnDrawdownRatio;
        case "worstNetProfit":
            return item.worstNetProfit;
        case "totalTrades":
            return item.totalTrades;
        default:
            return 0;
    }
}

export function compareFinderUniverseCandidates(
    left: FinderUniverseCandidate,
    right: FinderUniverseCandidate,
    sortPriority: readonly FinderUniverseMetric[]
): number {
    for (const metric of sortPriority) {
        const leftValue = getFinderUniverseMetricValue(left, metric);
        const rightValue = getFinderUniverseMetricValue(right, metric);
        if (Math.abs(leftValue - rightValue) > 0.0001) {
            return isAscendingUniverseMetric(metric)
                ? leftValue - rightValue
                : rightValue - leftValue;
        }
    }

    if (left.strategyName !== right.strategyName) {
        return left.strategyName.localeCompare(right.strategyName);
    }

    return JSON.stringify(left.params).localeCompare(JSON.stringify(right.params));
}

export function sortFinderUniverseCandidates(
    results: readonly FinderUniverseCandidate[],
    sortPriority: readonly FinderUniverseMetric[]
): FinderUniverseCandidate[] {
    return [...results].sort((left, right) => compareFinderUniverseCandidates(left, right, sortPriority));
}

/**
 * Bounded top-K survivor store for the universe runner. Replaces the old
 * push-then-full-sort-and-slice (`survivors.push(...); getSortedSurvivors(50)`)
 * which re-sorted the entire survivor buffer on every passing candidate.
 *
 * Parity contract: for a fixed seed, the survivor SET produced by this ranker
 * MUST be identical to the old push-then-trim path. The risk is tie-breaker
 * drift — when two candidates tie on every metric AND every param string,
 * `Array.prototype.sort` (stable in modern V8) keeps the earlier-pushed one.
 * A naive heap would evict whichever tied element lands at the root, diverging
 * from stable-sort-keeps-first. The mitigation mirrors Batch's
 * `compareAnalogByDistanceThenOrder`: an explicit monotonically-increasing
 * insertion index is the final tie-breaker, so on a tie the LATER-inserted
 * element is "worse" (sits at the root, gets evicted on overflow), preserving
 * the earlier one exactly as stable-sort-and-slice did.
 *
 * `toSortedArray` orders output by (metric comparator, then insertion order),
 * matching `[...results].sort(compareFinderUniverseCandidates)` on a stable
 * runtime — so both the kept SET and the intermediate display order match the
 * pre-heap path. Locked by `tests/finder-universe-runner.spec.ts`.
 */
export class FinderUniverseSurvivorRanker {
    private readonly maxSize: number;
    private readonly sortPriority: readonly FinderUniverseMetric[];
    private insertOrder = 0;
    // Min-heap by "worst" (the worst candidate sits at index 0 so overflow
    // evicts it in O(log K)). Entries carry their insertion index for the
    // tie-breaker described above.
    private readonly heap: Array<{ candidate: FinderUniverseCandidate; order: number }> = [];

    constructor(maxSize: number, sortPriority: readonly FinderUniverseMetric[]) {
        this.maxSize = Math.max(1, Math.floor(maxSize));
        this.sortPriority = sortPriority;
    }

    offer(candidate: FinderUniverseCandidate): void {
        const entry = { candidate, order: this.insertOrder++ };
        if (this.heap.length < this.maxSize) {
            this.heap.push(entry);
            this.siftUp(this.heap.length - 1);
            return;
        }
        if (this.heap.length === 0) return;
        // Root holds the current worst survivor. If the newcomer is worse than
        // or ties with the worst, it would not survive a full-sort-and-slice
        // (stable sort keeps the earlier-inserted survivor), so drop it.
        if (this.isWorseOrEqual(entry, this.heap[0]!)) {
            return;
        }
        // Newcomer beats the worst: replace root and restore the heap.
        this.heap[0] = entry;
        this.siftDown(0);
    }

    /** Current survivor count (pre-trim; bounded by maxSize). */
    get size(): number {
        return this.heap.length;
    }

    /**
     * Return survivors ordered best-first by the metric comparator, with
     * insertion order as the final tie-breaker. Matches the old
     * `sortFinderUniverseCandidates(survivors, sortPriority).slice(0, limit)`.
     */
    toSortedArray(limit: number): FinderUniverseCandidate[] {
        const sorted = [...this.heap].sort((a, b) => {
            const cmp = compareFinderUniverseCandidates(a.candidate, b.candidate, this.sortPriority);
            if (cmp !== 0) return cmp;
            // Stable-sort parity: earlier-inserted first on a tie.
            return a.order - b.order;
        });
        return sorted.slice(0, Math.max(1, limit)).map((entry) => entry.candidate);
    }

    /**
     * "a is worse than b" — drives the min-heap so the worst survivor sits at
     * the root. A higher metric-comparator value means worse (since the metric
     * comparator returns positive when the left candidate ranks lower). On a
     * metric tie, the LATER-inserted entry is considered worse so it is the one
     * evicted on overflow — matching stable-sort-keeps-first semantics.
     */
    private isWorse(a: { candidate: FinderUniverseCandidate; order: number }, b: { candidate: FinderUniverseCandidate; order: number }): boolean {
        const cmp = compareFinderUniverseCandidates(a.candidate, b.candidate, this.sortPriority);
        if (cmp > 0) return true;
        if (cmp < 0) return false;
        return a.order > b.order;
    }

    private isWorseOrEqual(a: { candidate: FinderUniverseCandidate; order: number }, b: { candidate: FinderUniverseCandidate; order: number }): boolean {
        const cmp = compareFinderUniverseCandidates(a.candidate, b.candidate, this.sortPriority);
        if (cmp > 0) return true;
        if (cmp < 0) return false;
        // Tie: the newcomer (a) has a strictly greater order index than any
        // already-heap element (b), so it is "worse" and would not survive a
        // stable sort + slice. Equal order is impossible here because a was
        // just allocated a fresh index.
        return a.order > b.order;
    }

    private siftUp(index: number): void {
        let idx = index;
        while (idx > 0) {
            const parent = Math.floor((idx - 1) / 2);
            if (!this.isWorse(this.heap[idx]!, this.heap[parent]!)) break;
            const tmp = this.heap[idx]!;
            this.heap[idx] = this.heap[parent]!;
            this.heap[parent] = tmp;
            idx = parent;
        }
    }

    private siftDown(index: number): void {
        let idx = index;
        while (true) {
            const left = idx * 2 + 1;
            const right = left + 1;
            let worst = idx;
            if (left < this.heap.length && this.isWorse(this.heap[left]!, this.heap[worst]!)) {
                worst = left;
            }
            if (right < this.heap.length && this.isWorse(this.heap[right]!, this.heap[worst]!)) {
                worst = right;
            }
            if (worst === idx) break;
            const tmp = this.heap[idx]!;
            this.heap[idx] = this.heap[worst]!;
            this.heap[worst] = tmp;
            idx = worst;
        }
    }
}

export function passesFinderUniverseFilters(
    candidate: FinderUniverseCandidate,
    universe: FinderUniverseOptions
): boolean {
    return candidate.activeSymbols >= universe.minActiveSymbols
        && candidate.totalTrades >= universe.minTotalTrades
        && candidate.profitableActiveRatio >= universe.minProfitableActiveRatio;
}

export interface SymbolVerdict {
    label: string;
    cssClass: string;
    tier: number;
}

export function computePerformanceVerdict(
    result: { netProfit: number; profitFactor: number; totalTrades: number; sharpeRatio: number } | undefined,
    status: string
): SymbolVerdict {
    if (!result || result.totalTrades <= 0 ||
        status === "no_trades" || status === "load_failed" || status === "run_failed"
        || status === "skipped") {
        return { label: "NO SIGNAL", cssClass: "finder-verdict-no-signal", tier: 6 };
    }
    if (result.totalTrades < 15) {
        return { label: "THIN", cssClass: "finder-verdict-thin", tier: 5 };
    }
    if (result.netProfit < 0) {
        return { label: "LOSING", cssClass: "finder-verdict-losing", tier: 4 };
    }
    const pf = result.profitFactor;
    const sharpe = result.sharpeRatio;
    if (pf >= 1.5 && sharpe >= 1.0) {
        return { label: "STRONG", cssClass: "finder-verdict-strong", tier: 0 };
    }
    if (pf >= 1.2 && sharpe >= 0.5) {
        return { label: "SOLID", cssClass: "finder-verdict-solid", tier: 1 };
    }
    if (pf >= 1.05) {
        return { label: "MARGINAL", cssClass: "finder-verdict-marginal", tier: 2 };
    }
    return { label: "WEAK", cssClass: "finder-verdict-weak", tier: 3 };
}

export interface StrategyVerdict {
    label: string;
    cssClass: string;
}

export function computeStrategyVerdict(ratio: number): StrategyVerdict {
    if (ratio >= 1.0) return { label: "UNIFORM — check directional bias", cssClass: "finder-verdict-uniform" };
    if (ratio >= 0.85) return { label: "BROAD EDGE", cssClass: "finder-verdict-strong" };
    if (ratio >= 0.65) return { label: "MODERATE", cssClass: "finder-verdict-solid" };
    if (ratio >= 0.45) return { label: "SELECTIVE", cssClass: "finder-verdict-marginal" };
    return { label: "NARROW", cssClass: "finder-verdict-weak" };
}
