import { resolvePolymarketTradePayout } from "./polymarket-payout";
import { parseTimeToUnixSeconds } from "./time-normalization";
import type { Trade } from "./types/strategies";
import { buildBacktestPolymarketPerformanceSummary } from "./polymarket-diagnostics-utils";
import type {
    StrategyDebuggerBucket,
    StrategyDebuggerConfidence,
    StrategyDebuggerDelta,
    StrategyDebuggerDiagnostic,
    StrategyDebuggerMatchQuality,
    StrategyDebuggerMetrics,
    StrategyDebuggerRunInput,
    StrategyDebuggerRunMeta,
    StrategyDebuggerTradeGroupSummary,
    StrategyDebuggerTradeOverlap,
    StrategyDebuggerVerdict,
} from "./strategy-debugger-types";

const MIN_BUCKET_TRADES = 20;
const MAX_BUCKETS = 5;

interface PricedTrade {
    trade: Trade;
    payoutCents: number;
    key: string;
    side: "YES" | "NO";
    entryPrice: number | null;
    secondsRemaining: number | null;
    eventProgress: number | null;
}

interface BucketCandidate {
    bucket: string;
    deltaCents: number | null;
    trades: number;
    note?: string;
}

function round(value: number, digits = 2): number {
    if (!Number.isFinite(value)) return 0;
    return Number(value.toFixed(digits));
}

function roundNullable(value: number | null, digits = 2): number | null {
    return value === null || !Number.isFinite(value) ? null : round(value, digits);
}

function isScoredTrade(trade: Trade): boolean {
    const source = trade.polymarketOutcome?.marketExitSource;
    return Boolean(trade.polymarketOutcome)
        && source !== "duplicate"
        && source !== "filtered"
        && source !== "entry_price_filtered"
        && source !== "entry_time_filtered"
        && source !== "no_event"
        && source !== "missing";
}

function countTradesByExitSource(trades: readonly Trade[], source: string): number {
    return trades.filter((trade) => trade.polymarketOutcome?.marketExitSource === source).length;
}

function summarizeTrades(trades: readonly PricedTrade[]): StrategyDebuggerTradeGroupSummary {
    const count = trades.length;
    if (count === 0) {
        return { count: 0, winRate: 0, expectancyCents: null };
    }
    const wins = trades.filter((item) => item.payoutCents > 0).length;
    const net = trades.reduce((sum, item) => sum + item.payoutCents, 0);
    return {
        count,
        winRate: round(wins / count, 4),
        expectancyCents: round(net / count, 2),
    };
}

export function buildStrategyDebuggerMetrics(input: StrategyDebuggerRunInput): StrategyDebuggerMetrics {
    const summary = input.result.polymarketTradeSummary;
    const performance = buildBacktestPolymarketPerformanceSummary(input.result);
    const totalTrades = input.result.totalTrades > 0 ? input.result.totalTrades : input.result.trades.length;
    const scoredTrades = summary?.scoredTrades ?? performance?.scoredTrades ?? input.result.trades.filter(isScoredTrade).length;
    const unscoredTrades = summary?.unscoredTrades ?? performance?.unscoredTrades ?? Math.max(0, totalTrades - scoredTrades);
    const scoredBase = scoredTrades + unscoredTrades;
    const profitFactor = performance?.polymarketProfitFactor;

    return {
        strategyKey: input.strategyKey,
        strategyName: input.strategyName,
        paramSource: input.paramSource,
        params: input.params,
        scoredTrades,
        unscoredTrades,
        missingOutcomeTrades: summary?.missingOutcomeTrades ?? performance?.missingOutcomeTrades ?? 0,
        missingPriceTrades: summary?.missingPriceTrades ?? countTradesByExitSource(input.result.trades, "missing"),
        duplicateTradesIgnored: summary?.duplicateTradesIgnored ?? countTradesByExitSource(input.result.trades, "duplicate"),
        scoredTradeShare: scoredBase > 0 ? round(scoredTrades / scoredBase, 4) : 0,
        winRate: round(performance?.polymarketWinRate ?? 0, 4),
        expectancyCents: performance?.polymarketExpectancy === null || performance?.polymarketExpectancy === undefined
            ? null
            : round(performance.polymarketExpectancy * 100, 2),
        profitFactor: typeof profitFactor === "number" && Number.isFinite(profitFactor)
            ? round(profitFactor, 4)
            : null,
        sizedNet: typeof summary?.sizedNetProfit === "number" && Number.isFinite(summary.sizedNetProfit)
            ? round(summary.sizedNetProfit, 2)
            : null,
        sizedReturnPercent: typeof summary?.sizedNetProfitPercent === "number" && Number.isFinite(summary.sizedNetProfitPercent)
            ? round(summary.sizedNetProfitPercent, 4)
            : null,
        sizedTrades: typeof summary?.sizedTrades === "number" && Number.isFinite(summary.sizedTrades)
            ? summary.sizedTrades
            : null,
    };
}

function buildPricedTrade(trade: Trade): PricedTrade | null {
    const payout = resolvePolymarketTradePayout(trade);
    if (!payout.payout) return null;

    const outcome = trade.polymarketOutcome;
    if (!outcome) return null;

    const entryTs = typeof outcome.marketEntryFillTs === "number" && Number.isFinite(outcome.marketEntryFillTs)
        ? outcome.marketEntryFillTs
        : parseTimeToUnixSeconds(trade.entryTime);
    const eventStart = outcome.eventStartTs;
    const eventEnd = outcome.eventEndTs;
    const side = trade.type === "long" ? "YES" : "NO";
    const duration = eventEnd - eventStart;
    const secondsRemaining = entryTs === null ? null : eventEnd - entryTs;
    const eventProgress = entryTs === null || duration <= 0
        ? null
        : Math.max(0, Math.min(1, (entryTs - eventStart) / duration));

    return {
        trade,
        payoutCents: payout.payout.sharePnl * 100,
        key: `${eventStart}|${eventEnd}|${side}`,
        side,
        entryPrice: payout.payout.entryPrice,
        secondsRemaining,
        eventProgress,
    };
}

function getPricedTrades(trades: readonly Trade[]): PricedTrade[] {
    return trades
        .map(buildPricedTrade)
        .filter((trade): trade is PricedTrade => trade !== null);
}

function sortPricedTradesByTime(left: PricedTrade, right: PricedTrade): number {
    const leftTs = parseTimeToUnixSeconds(left.trade.entryTime) ?? 0;
    const rightTs = parseTimeToUnixSeconds(right.trade.entryTime) ?? 0;
    return leftTs - rightTs;
}

function groupByKey(trades: readonly PricedTrade[]): Map<string, PricedTrade[]> {
    const grouped = new Map<string, PricedTrade[]>();
    for (const trade of trades) {
        const items = grouped.get(trade.key) ?? [];
        items.push(trade);
        grouped.set(trade.key, items);
    }
    for (const items of grouped.values()) {
        items.sort(sortPricedTradesByTime);
    }
    return grouped;
}

function resolveMatchQuality(matched: number, baselineCount: number, candidateCount: number): StrategyDebuggerMatchQuality {
    const denominator = Math.max(baselineCount, candidateCount);
    const ratio = denominator > 0 ? matched / denominator : 0;
    if (ratio >= 0.7) return "high";
    if (ratio >= 0.35) return "medium";
    return "low";
}

export function buildStrategyDebuggerTradeOverlap(
    baselineTradesRaw: readonly Trade[],
    candidateTradesRaw: readonly Trade[]
): StrategyDebuggerTradeOverlap & {
    candidateAddedTrades: PricedTrade[];
    candidateSkippedTrades: PricedTrade[];
} {
    const baselineTrades = getPricedTrades(baselineTradesRaw);
    const candidateTrades = getPricedTrades(candidateTradesRaw);
    const baselineByKey = groupByKey(baselineTrades);
    const candidateByKey = groupByKey(candidateTrades);

    let bothCount = 0;
    let candidateBetterCount = 0;
    let baselineBetterCount = 0;
    let totalDelta = 0;
    const candidateAddedTrades: PricedTrade[] = [];
    const candidateSkippedTrades: PricedTrade[] = [];

    const allKeys = new Set([...baselineByKey.keys(), ...candidateByKey.keys()]);
    for (const key of allKeys) {
        const baselineItems = baselineByKey.get(key) ?? [];
        const candidateItems = candidateByKey.get(key) ?? [];
        const pairCount = Math.min(baselineItems.length, candidateItems.length);

        for (let i = 0; i < pairCount; i++) {
            const baseline = baselineItems[i]!;
            const candidate = candidateItems[i]!;
            const delta = candidate.payoutCents - baseline.payoutCents;
            totalDelta += delta;
            bothCount++;
            if (delta > 0) candidateBetterCount++;
            if (delta < 0) baselineBetterCount++;
        }

        candidateAddedTrades.push(...candidateItems.slice(pairCount));
        candidateSkippedTrades.push(...baselineItems.slice(pairCount));
    }

    const skippedSummary = summarizeTrades(candidateSkippedTrades);

    return {
        matchQuality: resolveMatchQuality(bothCount, baselineTrades.length, candidateTrades.length),
        bothTook: {
            count: bothCount,
            candidateBetterCount,
            baselineBetterCount,
            avgDeltaCents: bothCount > 0 ? round(totalDelta / bothCount, 2) : null,
        },
        candidateAdded: summarizeTrades(candidateAddedTrades),
        candidateSkipped: {
            count: candidateSkippedTrades.length,
            baselineWinRate: skippedSummary.winRate,
            baselineExpectancyCents: skippedSummary.expectancyCents,
        },
        candidateAddedTrades,
        candidateSkippedTrades,
    };
}

function entryPriceBucket(price: number | null): string | null {
    if (price === null || !Number.isFinite(price)) return null;
    const cents = price * 100;
    if (cents < 20) return "entryPrice <20c";
    if (cents < 35) return "entryPrice 20-35c";
    if (cents < 45) return "entryPrice 35-45c";
    if (cents < 55) return "entryPrice 45-55c";
    if (cents < 65) return "entryPrice 55-65c";
    if (cents <= 80) return "entryPrice 65-80c";
    return "entryPrice >80c";
}

function secondsRemainingBucket(seconds: number | null): string | null {
    if (seconds === null || !Number.isFinite(seconds)) return null;
    if (seconds < 180) return "secondsRemaining <180";
    if (seconds < 210) return "secondsRemaining 180-210";
    if (seconds < 240) return "secondsRemaining 210-240";
    if (seconds < 270) return "secondsRemaining 240-270";
    return "secondsRemaining 270+";
}

function eventProgressBucket(progress: number | null): string | null {
    if (progress === null || !Number.isFinite(progress)) return null;
    if (progress < 0.2) return "eventProgress 0-20%";
    if (progress < 0.4) return "eventProgress 20-40%";
    if (progress < 0.6) return "eventProgress 40-60%";
    if (progress < 0.8) return "eventProgress 60-80%";
    return "eventProgress 80-100%";
}

function addBucket(map: Map<string, number[]>, bucket: string | null, deltaCents: number): void {
    if (!bucket) return;
    const values = map.get(bucket) ?? [];
    values.push(deltaCents);
    map.set(bucket, values);
}

function collectBucketCandidates(
    candidateAddedTrades: readonly PricedTrade[],
    candidateSkippedTrades: readonly PricedTrade[]
): BucketCandidate[] {
    const buckets = new Map<string, number[]>();
    for (const trade of candidateAddedTrades) {
        addBucket(buckets, entryPriceBucket(trade.entryPrice), trade.payoutCents);
        addBucket(buckets, secondsRemainingBucket(trade.secondsRemaining), trade.payoutCents);
        addBucket(buckets, eventProgressBucket(trade.eventProgress), trade.payoutCents);
        addBucket(buckets, `side ${trade.side}`, trade.payoutCents);
    }
    for (const trade of candidateSkippedTrades) {
        const avoidedDelta = -trade.payoutCents;
        addBucket(buckets, entryPriceBucket(trade.entryPrice), avoidedDelta);
        addBucket(buckets, secondsRemainingBucket(trade.secondsRemaining), avoidedDelta);
        addBucket(buckets, eventProgressBucket(trade.eventProgress), avoidedDelta);
        addBucket(buckets, `side ${trade.side}`, avoidedDelta);
    }

    return [...buckets.entries()].map(([bucket, values]) => {
        const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
        return {
            bucket,
            deltaCents: round(avg, 2),
            trades: values.length,
            note: values.length < MIN_BUCKET_TRADES ? "too small" : undefined,
        };
    });
}

function toOutputBucket(candidate: BucketCandidate): StrategyDebuggerBucket {
    return {
        bucket: candidate.bucket,
        candidateDeltaCents: roundNullable(candidate.deltaCents, 2),
        trades: candidate.trades,
        ...(candidate.note ? { note: candidate.note } : {}),
    };
}

export function buildStrategyDebuggerBuckets(
    candidateAddedTrades: readonly PricedTrade[],
    candidateSkippedTrades: readonly PricedTrade[]
): { helpedBuckets: StrategyDebuggerBucket[]; hurtBuckets: StrategyDebuggerBucket[] } {
    const buckets = collectBucketCandidates(candidateAddedTrades, candidateSkippedTrades);
    const usable = buckets.filter((bucket) => bucket.deltaCents !== null);
    const helpedBuckets = usable
        .filter((bucket) => (bucket.deltaCents ?? 0) > 0)
        .sort((left, right) => (right.deltaCents ?? 0) - (left.deltaCents ?? 0))
        .slice(0, MAX_BUCKETS)
        .map(toOutputBucket);
    const hurtBuckets = usable
        .filter((bucket) => (bucket.deltaCents ?? 0) < 0)
        .sort((left, right) => (left.deltaCents ?? 0) - (right.deltaCents ?? 0))
        .slice(0, MAX_BUCKETS)
        .map(toOutputBucket);
    return { helpedBuckets, hurtBuckets };
}

function buildDelta(baseline: StrategyDebuggerMetrics, candidate: StrategyDebuggerMetrics): StrategyDebuggerDelta {
    return {
        expectancyCents: baseline.expectancyCents === null || candidate.expectancyCents === null
            ? null
            : round(candidate.expectancyCents - baseline.expectancyCents, 2),
        winRatePoints: round((candidate.winRate - baseline.winRate) * 100, 2),
        sizedNet: baseline.sizedNet === null || candidate.sizedNet === null
            ? null
            : round(candidate.sizedNet - baseline.sizedNet, 2),
        scoredTrades: candidate.scoredTrades - baseline.scoredTrades,
    };
}

function resolveConfidence(
    candidate: StrategyDebuggerMetrics,
    overlap: StrategyDebuggerTradeOverlap,
    minScoredTrades: number
): StrategyDebuggerConfidence {
    if (candidate.scoredTrades >= Math.max(200, minScoredTrades) && candidate.scoredTradeShare >= 0.8 && overlap.matchQuality === "high") {
        return "high";
    }
    if (candidate.scoredTrades >= minScoredTrades && candidate.scoredTradeShare >= 0.5) {
        return "medium";
    }
    return "low";
}

function resolveVerdict(
    candidate: StrategyDebuggerMetrics,
    delta: StrategyDebuggerDelta,
    confidence: StrategyDebuggerConfidence,
    minScoredTrades: number
): StrategyDebuggerVerdict {
    if (candidate.scoredTradeShare < 0.35 || candidate.missingPriceTrades > candidate.scoredTrades) {
        return "needs data check";
    }
    if (candidate.scoredTrades < minScoredTrades) {
        return "bad coverage";
    }
    if (confidence === "low") {
        return "low confidence";
    }
    const expDelta = delta.expectancyCents ?? 0;
    const netDelta = delta.sizedNet ?? 0;
    if (expDelta > 0.5 || (netDelta > 0 && expDelta > -0.25)) {
        return "better";
    }
    if (expDelta < -0.5 || (netDelta < 0 && expDelta < 0.25)) {
        return "worse";
    }
    return "flat";
}

function buildPlainEnglish(
    verdict: StrategyDebuggerVerdict,
    delta: StrategyDebuggerDelta,
    overlap: StrategyDebuggerTradeOverlap
): string[] {
    const lines: string[] = [];
    if (verdict === "needs data check") {
        lines.push("Coverage or price data is weak enough that the comparison may be misleading.");
    } else if (verdict === "bad coverage") {
        lines.push("Candidate produced too few scored trades for a useful comparison.");
    } else if (delta.expectancyCents !== null && delta.expectancyCents > 0) {
        lines.push(`Candidate improved expectancy by ${round(delta.expectancyCents, 2)}c versus baseline.`);
    } else if (delta.expectancyCents !== null && delta.expectancyCents < 0) {
        lines.push(`Candidate reduced expectancy by ${round(Math.abs(delta.expectancyCents), 2)}c versus baseline.`);
    } else {
        lines.push("Candidate expectancy could not be compared cleanly.");
    }

    if (overlap.candidateAdded.count > 0) {
        const exp = overlap.candidateAdded.expectancyCents;
        lines.push(exp !== null && exp < 0
            ? "Candidate-added trades were a drag."
            : "Candidate-added trades were not the main weakness.");
    }
    if (overlap.candidateSkipped.count > 0) {
        const exp = overlap.candidateSkipped.baselineExpectancyCents;
        lines.push(exp !== null && exp > 0
            ? "Candidate skipped baseline trades that were mostly useful."
            : "Candidate skipped some weak baseline trades.");
    }
    if (overlap.matchQuality === "low") {
        lines.push("Trade overlap match quality is low, so use aggregate metrics more than pairwise trade details.");
    }
    return lines.slice(0, 4);
}

function buildNextPromptHint(verdict: StrategyDebuggerVerdict, overlap: StrategyDebuggerTradeOverlap): string {
    if (verdict === "needs data check") {
        return "Debug missing prices, duplicate handling, and scored coverage before generating another strategy.";
    }
    if (overlap.candidateAdded.expectancyCents !== null && overlap.candidateAdded.expectancyCents < 0) {
        return "Next experiment should reduce candidate-only trades or turn the weak added-trade bucket into a filter.";
    }
    if (overlap.candidateSkipped.baselineExpectancyCents !== null && overlap.candidateSkipped.baselineExpectancyCents > 0) {
        return "Next experiment should keep the baseline side and avoid filters that skip high-expectancy baseline trades.";
    }
    if (verdict === "better") {
        return "Next experiment should keep the helpful rule and test whether it survives Finder parameter validation.";
    }
    return "Next experiment should make one small baseline filter change and compare again.";
}

export function buildStrategyDebuggerDiagnostic(args: {
    run: StrategyDebuggerRunMeta;
    baseline: StrategyDebuggerRunInput;
    candidate: StrategyDebuggerRunInput;
    minScoredTrades: number;
}): StrategyDebuggerDiagnostic {
    const baselineMetrics = buildStrategyDebuggerMetrics(args.baseline);
    const candidateMetrics = buildStrategyDebuggerMetrics(args.candidate);
    const delta = buildDelta(baselineMetrics, candidateMetrics);
    const overlapWithTrades = buildStrategyDebuggerTradeOverlap(args.baseline.result.trades, args.candidate.result.trades);
    const { candidateAddedTrades, candidateSkippedTrades, ...tradeOverlap } = overlapWithTrades;
    const buckets = buildStrategyDebuggerBuckets(candidateAddedTrades, candidateSkippedTrades);
    const confidence = resolveConfidence(candidateMetrics, tradeOverlap, args.minScoredTrades);
    const verdict = resolveVerdict(candidateMetrics, delta, confidence, args.minScoredTrades);

    return {
        schema: "polymarket.strategy_debugger.v1",
        run: args.run,
        baseline: baselineMetrics,
        candidate: candidateMetrics,
        delta,
        tradeOverlap,
        helpedBuckets: buckets.helpedBuckets,
        hurtBuckets: buckets.hurtBuckets,
        diagnosis: {
            verdict,
            confidence,
            plainEnglish: buildPlainEnglish(verdict, delta, tradeOverlap),
            limitations: [
                "Single chart range only.",
                "Resolved params are not final parameter validation.",
                "Bucket diagnostics are descriptive, not proof.",
            ],
            nextPromptHint: buildNextPromptHint(verdict, tradeOverlap),
        },
    };
}
