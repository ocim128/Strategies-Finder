import type { PolymarketFillScope } from "./polymarket-fill-analysis";
import type { PolymarketFillHistorySummary } from "./polymarket-fill-history";
import { parseTimeToUnixSeconds } from "./time-normalization";
import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";
import type { Trade } from "./types/strategies";

export function computeWilsonLowerBound(successes: number, trials: number, z = 1.96): number {
    if (!Number.isFinite(successes) || !Number.isFinite(trials) || trials <= 0) {
        return 0;
    }

    const n = Math.max(0, trials);
    const p = Math.min(1, Math.max(0, successes / n));
    const z2 = z * z;
    const denominator = 1 + z2 / n;
    const center = p + z2 / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
    return Math.max(0, (center - margin) / denominator);
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    return value;
}

function getPrediction(trade: Trade): "yes" | "no" {
    return trade.type === "long" ? "yes" : "no";
}

function getOutcomeMarketEntryPrice(outcome: PolymarketOutcomeRow, prediction: "yes" | "no"): number | null {
    if (outcome.yes_open_price === null) {
        return null;
    }

    return prediction === "yes"
        ? clamp01(outcome.yes_open_price)
        : clamp01(1 - outcome.yes_open_price);
}

function isWin(prediction: "yes" | "no", outcome: PolymarketOutcomeRow): boolean {
    return prediction === "yes"
        ? outcome.resolved_outcome_up === 1
        : outcome.resolved_outcome_up === 0;
}

function getYesCheckpointPrices(outcome: PolymarketOutcomeRow): Array<number | null> {
    return [
        outcome.yes_open_price,
        outcome.yes_entry_minute_1_price,
        outcome.yes_entry_minute_2_price,
        outcome.yes_entry_minute_3_price,
        outcome.yes_entry_minute_4_price,
    ];
}

function getTradeCheckpointPrices(scoredTrade: ScoredTrade): Array<number | null> {
    const yesPrices = getYesCheckpointPrices(scoredTrade.outcome);
    if (scoredTrade.prediction === "yes") {
        return yesPrices;
    }

    return yesPrices.map((price) => price === null ? null : clamp01(1 - price));
}

function hasUsableHistorySummary(
    historySummary: PolymarketFillHistorySummary | undefined
): historySummary is PolymarketFillHistorySummary {
    return Boolean(historySummary && historySummary.windows.some((window) => window.sampleCount > 0));
}

function getTradeWindowReferencePrices(
    scoredTrade: ScoredTrade,
    historySummary: PolymarketFillHistorySummary | undefined
): Array<number | null> {
    if (!hasUsableHistorySummary(historySummary)) {
        return getTradeCheckpointPrices(scoredTrade);
    }

    if (scoredTrade.prediction === "yes") {
        return historySummary.windows.map((window) => window.yesMinPrice);
    }

    return historySummary.windows.map((window) => (
        window.yesMaxPrice === null ? null : clamp01(1 - window.yesMaxPrice)
    ));
}

function erf(x: number): number {
    const sign = x < 0 ? -1 : 1;
    const absX = Math.abs(x);
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
    const t = 1 / (1 + p * absX);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
    return sign * y;
}

function normalCdf(x: number): number {
    return 0.5 * (1 + erf(x / Math.SQRT2));
}

function computeOneSidedBinomialPValue(successes: number, trials: number, nullWinRate: number): number {
    if (trials <= 0) return 1;
    const p = clamp01(nullWinRate);
    const mean = trials * p;
    const variance = trials * p * (1 - p);
    if (variance <= 0) {
        return successes <= mean ? 1 : 0;
    }

    const z = (successes - 0.5 - mean) / Math.sqrt(variance);
    return Math.max(0, Math.min(1, 1 - normalCdf(z)));
}

function shuffleArray<T>(array: readonly T[], random: () => number): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

function createSeededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function countWins(scoredTrades: readonly ScoredTrade[]): number {
    return scoredTrades.filter((trade) => trade.isWin).length;
}

function buildRegime(label: string, scoredTrades: readonly ScoredTrade[]): RegimeBreakdown {
    const wins = countWins(scoredTrades);
    return {
        label,
        scoredTrades: scoredTrades.length,
        wins,
        losses: scoredTrades.length - wins,
        winRate: scoredTrades.length > 0 ? wins / scoredTrades.length : 0,
        wilsonLowerBound: computeWilsonLowerBound(wins, scoredTrades.length),
    };
}

function formatPercentCompact(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
}

function selectFilledScoredTrades(
    scoredTrades: readonly ScoredTrade[],
    targetPriceCents: number,
    scope: PolymarketFillScope,
    historySummaryByStartTs?: ReadonlyMap<number, PolymarketFillHistorySummary>
): ScoredTrade[] {
    const targetPrice = clamp01(targetPriceCents / 100);
    return scoredTrades.filter((scoredTrade) => {
        if (scope === "long" && scoredTrade.prediction !== "yes") return false;
        if (scope === "short" && scoredTrade.prediction !== "no") return false;

        const historySummary = historySummaryByStartTs?.get(scoredTrade.entryTs);
        const seenPrices = getTradeWindowReferencePrices(scoredTrade, historySummary)
            .filter((price): price is number => price !== null);
        if (seenPrices.length === 0) {
            return false;
        }

        return seenPrices.some((price) => price <= targetPrice);
    });
}

export interface ScoredTrade {
    trade: Trade;
    outcome: PolymarketOutcomeRow;
    entryTs: number;
    isWin: boolean;
    prediction: "yes" | "no";
    marketEntryPrice: number | null;
}

export interface ConfidenceSummary {
    winRate: number;
    wins: number;
    losses: number;
    scoredTrades: number;
    coverage: number;
    wilsonLowerBound: number;
    alwaysYesBaseline: number;
    alwaysNoBaseline: number;
    deltaVsAlwaysYes: number;
    deltaVsAlwaysNo: number;
}

export interface ChronoBlock {
    label: string;
    startTs: number;
    endTs: number;
    scoredTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    wilsonLowerBound: number;
}

export interface RegimeBreakdown {
    label: string;
    scoredTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    wilsonLowerBound: number;
}

export interface SignificanceTestResult {
    mode: "shuffle" | "one_sided_binomial";
    constantPrediction?: "yes" | "no";
    hint: string;
    methodValue: string;
    baselineValue: string;
    observedWinRate: number;
    expectedWinRate: number;
    pValue: number;
    diagnosticValue: string;
}

export interface FillAdjustedMetrics {
    scoredTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    wilsonLowerBound: number;
    fillRate: number;
    eligibleTrades: number;
    targetPriceCents: number;
    scope: PolymarketFillScope;
    alwaysYesBaseline: number;
    alwaysNoBaseline: number;
    bestBaseline: number;
    bestBaselineLabel: "YES" | "NO";
    deltaVsBestBaseline: number;
    breakEvenWinRate: number;
    edgeVsBreakEven: number;
}

export interface DeployabilityVerdict {
    verdict: "Robust" | "Borderline" | "Weak";
    reasons: string[];
    wilsonPass: boolean;
    stabilityPass: boolean;
    significancePass: boolean;
    fillAdjustedPass: boolean;
}

export interface DeployabilityAnalysisResult {
    confidence: ConfidenceSummary;
    chronologicalBlocks: ChronoBlock[];
    regimeBreakdown: {
        longShort: RegimeBreakdown[];
        entryPriceBuckets?: RegimeBreakdown[];
    };
    significanceTest: SignificanceTestResult;
    fillAdjusted?: FillAdjustedMetrics;
    verdict: DeployabilityVerdict;
}

export interface DeployabilityAnalysisOptions {
    blockSize?: number;
    shuffleSimulations?: number;
    shuffleSeed?: number;
    entryPriceBuckets?: number[];
    fillScope?: PolymarketFillScope;
    fillTargetPriceCents?: number;
    historySummaryByStartTs?: Map<number, PolymarketFillHistorySummary>;
    wilsonThreshold?: number;
    significancePValueThreshold?: number;
    fillAdjustedMinWilson?: number;
}

export function extractScoredTrades(
    trades: readonly Trade[],
    outcomeByStartTs: ReadonlyMap<number, PolymarketOutcomeRow>
): ScoredTrade[] {
    const scoredTrades: ScoredTrade[] = [];

    for (const trade of trades) {
        const entryTs = parseTimeToUnixSeconds(trade.entryTime);
        if (entryTs === null) continue;

        const outcome = outcomeByStartTs.get(entryTs);
        if (!outcome) continue;

        const prediction = getPrediction(trade);
        scoredTrades.push({
            trade,
            outcome,
            entryTs,
            isWin: isWin(prediction, outcome),
            prediction,
            marketEntryPrice: getOutcomeMarketEntryPrice(outcome, prediction),
        });
    }

    scoredTrades.sort((left, right) => left.entryTs - right.entryTs);
    return scoredTrades;
}

export function buildConfidenceSummary(
    scoredTrades: readonly ScoredTrade[],
    evaluationRows: readonly PolymarketOutcomeRow[]
): ConfidenceSummary {
    const wins = countWins(scoredTrades);
    const scoredCount = scoredTrades.length;
    const losses = scoredCount - wins;
    const winRate = scoredCount > 0 ? wins / scoredCount : 0;
    const evaluatedEvents = evaluationRows.length;
    const resolvedUpCount = evaluationRows.reduce((sum, row) => sum + row.resolved_outcome_up, 0);
    const alwaysYesBaseline = evaluatedEvents > 0 ? resolvedUpCount / evaluatedEvents : 0;
    const alwaysNoBaseline = evaluatedEvents > 0 ? (evaluatedEvents - resolvedUpCount) / evaluatedEvents : 0;

    return {
        winRate,
        wins,
        losses,
        scoredTrades: scoredCount,
        coverage: evaluatedEvents > 0 ? scoredCount / evaluatedEvents : 0,
        wilsonLowerBound: computeWilsonLowerBound(wins, scoredCount),
        alwaysYesBaseline,
        alwaysNoBaseline,
        deltaVsAlwaysYes: winRate - alwaysYesBaseline,
        deltaVsAlwaysNo: winRate - alwaysNoBaseline,
    };
}

export function buildChronologicalBlocks(
    scoredTrades: readonly ScoredTrade[],
    blockSize = 250
): ChronoBlock[] {
    if (scoredTrades.length === 0 || blockSize <= 0) {
        return [];
    }

    const blocks: ChronoBlock[] = [];
    const blockCount = Math.ceil(scoredTrades.length / blockSize);
    for (let i = 0; i < blockCount; i++) {
        const blockTrades = scoredTrades.slice(i * blockSize, Math.min((i + 1) * blockSize, scoredTrades.length));
        const wins = countWins(blockTrades);
        blocks.push({
            label: `Block ${i + 1}`,
            startTs: blockTrades[0]?.entryTs ?? 0,
            endTs: blockTrades[blockTrades.length - 1]?.entryTs ?? 0,
            scoredTrades: blockTrades.length,
            wins,
            losses: blockTrades.length - wins,
            winRate: blockTrades.length > 0 ? wins / blockTrades.length : 0,
            wilsonLowerBound: computeWilsonLowerBound(wins, blockTrades.length),
        });
    }

    return blocks;
}

export function buildLongShortBreakdown(scoredTrades: readonly ScoredTrade[]): RegimeBreakdown[] {
    const breakdown: RegimeBreakdown[] = [];
    const longTrades = scoredTrades.filter((trade) => trade.prediction === "yes");
    const shortTrades = scoredTrades.filter((trade) => trade.prediction === "no");

    if (longTrades.length > 0) {
        breakdown.push(buildRegime("Long (YES)", longTrades));
    }

    if (shortTrades.length > 0) {
        breakdown.push(buildRegime("Short (NO)", shortTrades));
    }

    return breakdown;
}

export function buildEntryPriceBucketBreakdown(
    scoredTrades: readonly ScoredTrade[],
    bucketBoundaries: number[] = [30, 40, 50, 60, 70]
): RegimeBreakdown[] {
    const tradesWithPrice = scoredTrades.filter((trade) => trade.marketEntryPrice !== null);
    if (tradesWithPrice.length === 0 || bucketBoundaries.length === 0) {
        return [];
    }

    const sortedBoundaries = [...bucketBoundaries].sort((left, right) => left - right);
    const buckets: Array<{
        label: string;
        minPrice: number;
        maxPrice: number | null;
        trades: ScoredTrade[];
    }> = [
        {
            label: `< ${sortedBoundaries[0]}c`,
            minPrice: 0,
            maxPrice: sortedBoundaries[0],
            trades: [],
        },
    ];

    for (let i = 0; i < sortedBoundaries.length - 1; i++) {
        buckets.push({
            label: `${sortedBoundaries[i]}-${sortedBoundaries[i + 1]}c`,
            minPrice: sortedBoundaries[i],
            maxPrice: sortedBoundaries[i + 1],
            trades: [],
        });
    }

    buckets.push({
        label: `> ${sortedBoundaries[sortedBoundaries.length - 1]}c`,
        minPrice: sortedBoundaries[sortedBoundaries.length - 1],
        maxPrice: null,
        trades: [],
    });

    for (const trade of tradesWithPrice) {
        const priceCents = trade.marketEntryPrice! * 100;
        for (const bucket of buckets) {
            if (bucket.maxPrice === null) {
                if (priceCents >= bucket.minPrice) {
                    bucket.trades.push(trade);
                    break;
                }
                continue;
            }

            if (priceCents >= bucket.minPrice && priceCents < bucket.maxPrice) {
                bucket.trades.push(trade);
                break;
            }
        }
    }

    return buckets
        .filter((bucket) => bucket.trades.length > 0)
        .map((bucket) => buildRegime(bucket.label, bucket.trades));
}

export function buildSignificanceTest(
    scoredTrades: readonly ScoredTrade[],
    confidence: ConfidenceSummary,
    simulationCount = 1000,
    seed = 42
): SignificanceTestResult {
    if (scoredTrades.length === 0 || simulationCount <= 0) {
        return {
            mode: "shuffle",
            hint: "No scored trades are available for significance testing.",
            methodValue: "Unavailable",
            baselineValue: "N/A",
            observedWinRate: 0,
            expectedWinRate: 0,
            pValue: 1,
            diagnosticValue: "No samples",
        };
    }

    const predictionSet = new Set(scoredTrades.map((trade) => trade.prediction));
    if (predictionSet.size === 1) {
        const prediction = scoredTrades[0]?.prediction ?? "yes";
        const baselineWinRate = prediction === "yes"
            ? confidence.alwaysYesBaseline
            : confidence.alwaysNoBaseline;
        const wins = countWins(scoredTrades);
        const pValue = computeOneSidedBinomialPValue(wins, scoredTrades.length, baselineWinRate);
        const baselineLabel = prediction === "yes" ? "YES baseline" : "NO baseline";
        const expectedWins = scoredTrades.length * baselineWinRate;

        return {
            mode: "one_sided_binomial",
            constantPrediction: prediction,
            hint: `One-sided ${prediction === "yes" ? "YES-only" : "NO-only"} strategy: shuffle placebo is disabled because every prediction has the same side. Using a one-sided binomial tail test vs the ${baselineLabel.toLowerCase()}.`,
            methodValue: "Binomial tail",
            baselineValue: `${baselineLabel} ${formatPercentCompact(baselineWinRate)}`,
            observedWinRate: confidence.winRate,
            expectedWinRate: baselineWinRate,
            pValue,
            diagnosticValue: `Expected wins ${expectedWins.toFixed(1)}`,
        };
    }

    const random = createSeededRandom(seed);
    const predictions = scoredTrades.map((trade) => trade.prediction);
    const actualOutcomes = scoredTrades.map((trade) => trade.outcome.resolved_outcome_up);
    const observedWinRate = confidence.winRate;
    const simulatedWinRates: number[] = [];
    let exceedanceCount = 0;

    for (let simulation = 0; simulation < simulationCount; simulation++) {
        const shuffledOutcomes = shuffleArray(actualOutcomes, random);
        let simulatedWins = 0;

        for (let index = 0; index < predictions.length; index++) {
            const actual = shuffledOutcomes[index];
            if ((predictions[index] === "yes" && actual === 1) || (predictions[index] === "no" && actual === 0)) {
                simulatedWins++;
            }
        }

        const simulatedWinRate = simulatedWins / predictions.length;
        simulatedWinRates.push(simulatedWinRate);
        if (simulatedWinRate >= observedWinRate) {
            exceedanceCount++;
        }
    }

    const meanSimulatedWinRate = simulatedWinRates.reduce((sum, value) => sum + value, 0) / simulatedWinRates.length;
    const sortedRates = [...simulatedWinRates].sort((left, right) => left - right);
    const percentile95 = sortedRates[Math.floor(0.95 * (sortedRates.length - 1))] ?? 0;

    return {
        mode: "shuffle",
        hint: "Shuffle placebo test: outcome order is permuted while the strategy prediction sequence stays fixed. Low p-value indicates the observed edge is unlikely under a no-timing-skill null.",
        methodValue: `Shuffle x${simulationCount}`,
        baselineValue: "Shuffled outcomes",
        observedWinRate,
        expectedWinRate: meanSimulatedWinRate,
        pValue: exceedanceCount / simulationCount,
        diagnosticValue: `95th % ${formatPercentCompact(percentile95)}`,
    };
}

export function analyzeFillAdjustedMetrics(
    scoredTrades: readonly ScoredTrade[],
    targetPriceCents: number,
    scope: PolymarketFillScope,
    historySummaryByStartTs?: ReadonlyMap<number, PolymarketFillHistorySummary>
): FillAdjustedMetrics {
    const scopedTrades = scoredTrades.filter((trade) => {
        if (scope === "long") return trade.prediction === "yes";
        if (scope === "short") return trade.prediction === "no";
        return true;
    });
    const filledTrades = selectFilledScoredTrades(scopedTrades, targetPriceCents, scope, historySummaryByStartTs);
    const wins = countWins(filledTrades);
    const losses = filledTrades.length - wins;
    const winRate = filledTrades.length > 0 ? wins / filledTrades.length : 0;
    const resolvedUpCount = filledTrades.reduce((sum, trade) => sum + trade.outcome.resolved_outcome_up, 0);
    const alwaysYesBaseline = filledTrades.length > 0 ? resolvedUpCount / filledTrades.length : 0;
    const alwaysNoBaseline = filledTrades.length > 0 ? (filledTrades.length - resolvedUpCount) / filledTrades.length : 0;
    const bestBaselineLabel = alwaysYesBaseline >= alwaysNoBaseline ? "YES" : "NO";
    const bestBaseline = bestBaselineLabel === "YES" ? alwaysYesBaseline : alwaysNoBaseline;
    const breakEvenWinRate = clamp01(targetPriceCents / 100);

    return {
        scoredTrades: filledTrades.length,
        wins,
        losses,
        winRate,
        wilsonLowerBound: computeWilsonLowerBound(wins, filledTrades.length),
        fillRate: scopedTrades.length > 0 ? filledTrades.length / scopedTrades.length : 0,
        eligibleTrades: scopedTrades.length,
        targetPriceCents,
        scope,
        alwaysYesBaseline,
        alwaysNoBaseline,
        bestBaseline,
        bestBaselineLabel,
        deltaVsBestBaseline: winRate - bestBaseline,
        breakEvenWinRate,
        edgeVsBreakEven: winRate - breakEvenWinRate,
    };
}

export function determineVerdict(
    confidence: ConfidenceSummary,
    blocks: readonly ChronoBlock[],
    significanceTest: SignificanceTestResult,
    fillAdjusted: FillAdjustedMetrics | undefined,
    options: DeployabilityAnalysisOptions
): DeployabilityVerdict {
    const reasons: string[] = [];
    const wilsonThreshold = options.wilsonThreshold ?? 0.52;
    const significancePValueThreshold = options.significancePValueThreshold ?? 0.05;
    const fillAdjustedMinWilson = options.fillAdjustedMinWilson ?? 0.51;

    const wilsonPass = confidence.wilsonLowerBound >= wilsonThreshold;
    reasons.push(
        wilsonPass
            ? `Wilson LB (${confidence.wilsonLowerBound.toFixed(3)}) >= ${wilsonThreshold}`
            : `Wilson LB (${confidence.wilsonLowerBound.toFixed(3)}) < ${wilsonThreshold}`
    );

    let stabilityPass = true;
    if (blocks.length >= 2) {
        const recentBlock = blocks[blocks.length - 1]!;
        const previousBlock = blocks[blocks.length - 2]!;
        if (recentBlock.wilsonLowerBound < 0.5 && recentBlock.scoredTrades >= 10) {
            stabilityPass = false;
            reasons.push(`Recent block Wilson LB (${recentBlock.wilsonLowerBound.toFixed(3)}) < 0.5`);
        } else if (
            previousBlock.wilsonLowerBound >= 0.52 &&
            recentBlock.wilsonLowerBound < 0.48 &&
            recentBlock.scoredTrades >= 10
        ) {
            stabilityPass = false;
            reasons.push(`Wilson LB dropped from ${previousBlock.wilsonLowerBound.toFixed(3)} to ${recentBlock.wilsonLowerBound.toFixed(3)}`);
        } else {
            reasons.push("Recent blocks show stable edge");
        }
    } else {
        reasons.push("Insufficient blocks for stability analysis");
    }

    const significancePass = significanceTest.pValue <= significancePValueThreshold;
    reasons.push(
        significancePass
            ? `Significance p-value (${significanceTest.pValue.toFixed(3)}) <= ${significancePValueThreshold}`
            : `Significance p-value (${significanceTest.pValue.toFixed(3)}) > ${significancePValueThreshold}`
    );

    let fillAdjustedPass = true;
    if (fillAdjusted) {
        if (fillAdjusted.scoredTrades === 0) {
            fillAdjustedPass = false;
            reasons.push("No filled trades for fill-adjusted analysis");
        } else if (fillAdjusted.wilsonLowerBound >= fillAdjustedMinWilson) {
            reasons.push(`Fill-adjusted Wilson LB (${fillAdjusted.wilsonLowerBound.toFixed(3)}) >= ${fillAdjustedMinWilson}`);
        } else {
            fillAdjustedPass = false;
            reasons.push(`Fill-adjusted Wilson LB (${fillAdjusted.wilsonLowerBound.toFixed(3)}) < ${fillAdjustedMinWilson}`);
        }
    } else {
        reasons.push("Fill-adjusted analysis not available");
    }

    const passCount = [wilsonPass, stabilityPass, significancePass, fillAdjustedPass].filter(Boolean).length;
    const verdict = passCount >= 3 && wilsonPass && significancePass
        ? "Robust"
        : passCount >= 2
            ? "Borderline"
            : "Weak";

    return {
        verdict,
        reasons,
        wilsonPass,
        stabilityPass,
        significancePass,
        fillAdjustedPass,
    };
}

export function analyzePolymarketDeployability(
    scoredTrades: readonly ScoredTrade[],
    evaluationRows: readonly PolymarketOutcomeRow[],
    options: DeployabilityAnalysisOptions = {}
): DeployabilityAnalysisResult {
    const confidence = buildConfidenceSummary(scoredTrades, evaluationRows);
    const chronologicalBlocks = buildChronologicalBlocks(scoredTrades, options.blockSize ?? 250);
    const longShort = buildLongShortBreakdown(scoredTrades);
    const entryPriceBuckets = buildEntryPriceBucketBreakdown(scoredTrades, options.entryPriceBuckets ?? [30, 40, 50, 60, 70]);
    const significanceTest = buildSignificanceTest(
        scoredTrades,
        confidence,
        options.shuffleSimulations ?? 1000,
        options.shuffleSeed ?? 42
    );
    const fillAdjusted = options.fillScope !== undefined && options.fillTargetPriceCents !== undefined
        ? analyzeFillAdjustedMetrics(
            scoredTrades,
            options.fillTargetPriceCents,
            options.fillScope,
            options.historySummaryByStartTs
        )
        : undefined;
    const verdict = determineVerdict(confidence, chronologicalBlocks, significanceTest, fillAdjusted, options);

    return {
        confidence,
        chronologicalBlocks,
        regimeBreakdown: {
            longShort,
            entryPriceBuckets: entryPriceBuckets.length > 0 ? entryPriceBuckets : undefined,
        },
        significanceTest,
        fillAdjusted,
        verdict,
    };
}
