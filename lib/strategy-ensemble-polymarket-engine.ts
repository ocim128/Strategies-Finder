import {
    getPolymarket5mSeriesIdForSymbol,
    getSupportedPolymarket5mSymbolsLabel,
    isSupportedPolymarket5mRun,
} from "./polymarket-btc5m";
import { computeWilsonLowerBound } from "./polymarket-deployability-analysis";
import {
    createPolymarketTradeEvaluationContext,
    evaluatePolymarketBacktestTrades,
} from "./polymarket-trade-annotations";
import {
    buildEntryPresenceLookup,
    runConfig,
    type StrategyEnsembleEngineDeps,
} from "./strategy-ensemble-engine";
import {
    buildBestSideOwnerPreparedSignals,
    buildPrimarySecondaryOverridePreparedSignals,
    buildPrimaryVetoPreparedSignals,
    buildTargetConflictFilterPreparedSignals,
} from "./strategy-ensemble-signal-filters";
import type { ConfigRunArtifact } from "./strategy-ensemble-types";
import type {
    BacktestSettings,
    OHLCVData,
    Signal,
    Trade,
    TradeDirection,
} from "./strategies";
import { timeKey } from "./strategies";
import type {
    PolymarketEvalResult,
    PolymarketOutcomeRow,
} from "./types/polymarket-outcomes";

export type EnsemblePolymarketConflictPolicy = "skip_conflicts" | "primary_veto" | "secondary_override" | "best_side_owner";
export type EnsemblePolymarketDirectionSlice = "all" | "long_only" | "short_only";
export type EnsemblePolymarketVerdict = "edge" | "marginal" | "no_edge" | "insufficient";
export type EnsemblePolymarketVetoVerdict = "interesting" | "marginal" | "neutral" | "insufficient";

export interface EnsemblePolymarketConfigResult {
    configName: string;
    familyKey: string;
    familyLabel: string;
    tradeDirection: string;
    evalResult: PolymarketEvalResult;
    wilsonLowerBound: number;
    deltaVsBestBaseline: number;
    verdict: EnsemblePolymarketVerdict;
}

export interface EnsemblePolymarketAgreementSummary {
    evaluatedEvents: number;
    eventsWithVotes: number;
    scoredEvents: number;
    wins: number;
    losses: number;
    winRate: number;
    coverage: number;
    skippedEvents: number;
    skipRate: number;
    noSignalEvents: number;
    noSignalRate: number;
    unanimousEvents: number;
    mixedDirectionEvents: number;
    conflictedEvents: number;
    decisiveYesEvents: number;
    decisiveNoEvents: number;
}

export interface EnsemblePolymarketOverlayVote {
    eventStartTs: number;
    prediction: "yes" | "no";
    actualOutcomeUp: 0 | 1;
    yesVotes: number;
    noVotes: number;
}

export interface EnsemblePolymarketExecutableConflictSummary {
    totalTrades: number;
    scoredTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    coverage: number;
    retentionRate: number;
    skippedByExecution: number;
    missingOutcomeTrades: number;
}

export interface EnsemblePolymarketPolicyResult {
    policy: EnsemblePolymarketConflictPolicy;
    label: string;
    description: string;
    anchorConfigName: string;
    anchorFamilyLabel: string;
    primaryConfigName?: string;
    primaryFamilyLabel?: string;
    secondaryConfigName?: string;
    secondaryFamilyLabel?: string;
    vetoConfigName?: string;
    vetoFamilyLabel?: string;
    longOwnerConfigName?: string;
    shortOwnerConfigName?: string;
    totalTrades: number;
    scoredTrades: number;
    pricedTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    expectancy: number | null;
    coverage: number;
    retentionRate: number | null;
    missingOutcomeTrades: number;
    wilsonLowerBound: number;
    deltaVsBaseline: number;
    verdict: EnsemblePolymarketVerdict;
}

export interface EnsemblePolymarketVetoPairResult {
    primaryConfigName: string;
    primaryFamilyLabel: string;
    vetoConfigName: string;
    vetoFamilyLabel: string;
    primaryScoredEvents: number;
    overlapEvents: number;
    vetoedEvents: number;
    keptEvents: number;
    pricedTrades: number;
    keptWins: number;
    keptLosses: number;
    expectancy: number | null;
    primaryWinRate: number;
    postVetoWinRate: number;
    winRateLift: number;
    retentionRate: number;
    overlapRate: number;
    postVetoWilsonLowerBound: number;
    primaryWilsonLowerBound: number;
    wilsonLift: number;
    verdict: EnsemblePolymarketVetoVerdict;
}

export interface EnsemblePolymarketOverridePairResult {
    primaryConfigName: string;
    primaryFamilyLabel: string;
    secondaryConfigName: string;
    secondaryFamilyLabel: string;
    primaryScoredEvents: number;
    overlapEvents: number;
    overriddenEvents: number;
    keptEvents: number;
    pricedTrades: number;
    keptWins: number;
    keptLosses: number;
    expectancy: number | null;
    primaryWinRate: number;
    postOverrideWinRate: number;
    winRateLift: number;
    retentionRate: number;
    overlapRate: number;
    postOverrideWilsonLowerBound: number;
    primaryWilsonLowerBound: number;
    wilsonLift: number;
    verdict: EnsemblePolymarketVetoVerdict;
}

export interface EnsemblePolymarketRunResult {
    symbol: string;
    interval: string;
    seriesId: string;
    selectedPolicy: EnsemblePolymarketConflictPolicy;
    directionSlice: EnsemblePolymarketDirectionSlice;
    configResults: EnsemblePolymarketConfigResult[];
    ensembleSummary: {
        configsEvaluated: number;
        configsScored: number;
        totalScoredTrades: number;
        ensembleWinRate: number;
        bestConfigWinRate: number;
        bestConfigName: string;
        alwaysYesBaseline: number;
        alwaysNoBaseline: number;
        bestBaseline: number;
        ensembleDeltaVsBestBaseline: number;
    };
    conflictFilteredOverlay: EnsemblePolymarketAgreementSummary;
    conflictExecutableOverlay?: EnsemblePolymarketExecutableConflictSummary | null;
    majorityVoteOverlay: EnsemblePolymarketAgreementSummary;
    policyResults: {
        skipConflicts: EnsemblePolymarketPolicyResult | null;
        primaryVeto: EnsemblePolymarketPolicyResult | null;
        secondaryOverride: EnsemblePolymarketPolicyResult | null;
        bestSideOwner: EnsemblePolymarketPolicyResult | null;
    };
    selectedPolicyResult: EnsemblePolymarketPolicyResult | null;
    vetoScan: {
        pairResults: EnsemblePolymarketVetoPairResult[];
        positivePairCount: number;
        bestPair: EnsemblePolymarketVetoPairResult | null;
    };
    overrideScan: {
        pairResults: EnsemblePolymarketOverridePairResult[];
        positivePairCount: number;
        bestPair: EnsemblePolymarketOverridePairResult | null;
    };
}

const ENSEMBLE_POLYMARKET_MIN_SCORED = 30;
const ENSEMBLE_POLYMARKET_EDGE_BUFFER = 0.02;
const ENSEMBLE_POLYMARKET_VETO_INTERESTING_WILSON_LIFT = 0.02;

type EventVoteBucket = {
    actualOutcomeUp: 0 | 1;
    yesConfigs: Set<string>;
    noConfigs: Set<string>;
};

type ExecutedSignalArtifact = {
    runArtifact: ConfigRunArtifact;
    preparedSignals: Signal[];
    entryPresenceByTime: Map<string, { longEntry: boolean; shortEntry: boolean }>;
    tradeDirection: TradeDirection;
};

type SideStats = {
    configName: string;
    familyLabel: string;
    scoredPredictions: number;
    wins: number;
    losses: number;
    winRate: number;
    wilsonLowerBound: number;
    deltaVsBaseline: number;
    verdict: EnsemblePolymarketVerdict;
};

export function determineEnsemblePolymarketVerdict(
    wilsonLowerBound: number,
    bestBaseline: number,
    scoredPredictions: number
): EnsemblePolymarketVerdict {
    if (scoredPredictions < ENSEMBLE_POLYMARKET_MIN_SCORED) {
        return "insufficient";
    }

    if (wilsonLowerBound > bestBaseline + ENSEMBLE_POLYMARKET_EDGE_BUFFER) {
        return "edge";
    }

    if (wilsonLowerBound > bestBaseline) {
        return "marginal";
    }

    return "no_edge";
}

export function determineEnsemblePolymarketVetoVerdict(
    wilsonLift: number,
    winRateLift: number,
    keptEvents: number
): EnsemblePolymarketVetoVerdict {
    if (keptEvents < ENSEMBLE_POLYMARKET_MIN_SCORED) {
        return "insufficient";
    }

    if (wilsonLift > ENSEMBLE_POLYMARKET_VETO_INTERESTING_WILSON_LIFT && winRateLift > 0) {
        return "interesting";
    }

    if (wilsonLift > 0 && winRateLift > 0) {
        return "marginal";
    }

    return "neutral";
}

function buildEventVoteBuckets(
    configResults: readonly EnsemblePolymarketConfigResult[],
    directionSlice: EnsemblePolymarketDirectionSlice
): Map<number, EventVoteBucket> {
    const eventVotes = new Map<number, EventVoteBucket>();

    for (const result of configResults) {
        for (const row of result.evalResult.rows) {
            if (!matchesPredictionDirectionSlice(row.prediction, directionSlice)) {
                continue;
            }

            let bucket = eventVotes.get(row.eventStartTs);
            if (!bucket) {
                bucket = {
                    actualOutcomeUp: row.actualOutcomeUp,
                    yesConfigs: new Set<string>(),
                    noConfigs: new Set<string>(),
                };
                eventVotes.set(row.eventStartTs, bucket);
            }

            if (row.prediction === "yes") {
                bucket.yesConfigs.add(result.configName);
            } else {
                bucket.noConfigs.add(result.configName);
            }
        }
    }

    return eventVotes;
}

function buildConfigPredictionIndex(
    configResult: EnsemblePolymarketConfigResult,
    directionSlice: EnsemblePolymarketDirectionSlice
): Map<number, Set<"yes" | "no">> {
    const predictionByEventStartTs = new Map<number, Set<"yes" | "no">>();

    for (const row of configResult.evalResult.rows) {
        if (!matchesPredictionDirectionSlice(row.prediction, directionSlice)) {
            continue;
        }

        const predictions = predictionByEventStartTs.get(row.eventStartTs) ?? new Set<"yes" | "no">();
        predictions.add(row.prediction);
        predictionByEventStartTs.set(row.eventStartTs, predictions);
    }

    return predictionByEventStartTs;
}

export function collectEnsemblePolymarketOverlayVotes(
    configResults: readonly EnsemblePolymarketConfigResult[],
    mode: "majority_vote" | "conflict_filtered",
    directionSlice: EnsemblePolymarketDirectionSlice = "all"
): EnsemblePolymarketOverlayVote[] {
    const eventVotes = buildEventVoteBuckets(configResults, directionSlice);
    const overlayVotes: EnsemblePolymarketOverlayVote[] = [];

    for (const [eventStartTs, bucket] of eventVotes.entries()) {
        const yesVotes = bucket.yesConfigs.size;
        const noVotes = bucket.noConfigs.size;
        if (yesVotes === 0 && noVotes === 0) {
            continue;
        }

        const isMixedDirection = yesVotes > 0 && noVotes > 0;
        if (mode === "conflict_filtered" && isMixedDirection) {
            continue;
        }

        if (mode === "majority_vote" && yesVotes === noVotes) {
            continue;
        }

        overlayVotes.push({
            eventStartTs,
            prediction: yesVotes > noVotes ? "yes" : "no",
            actualOutcomeUp: bucket.actualOutcomeUp,
            yesVotes,
            noVotes,
        });
    }

    overlayVotes.sort((left, right) => left.eventStartTs - right.eventStartTs);
    return overlayVotes;
}

export function buildEnsemblePolymarketAgreement(
    configResults: readonly EnsemblePolymarketConfigResult[],
    evaluatedEvents: number,
    mode: "majority_vote" | "conflict_filtered",
    directionSlice: EnsemblePolymarketDirectionSlice = "all"
): EnsemblePolymarketAgreementSummary {
    const eventVotes = buildEventVoteBuckets(configResults, directionSlice);
    const eventsWithVotes = eventVotes.size;

    let wins = 0;
    let losses = 0;
    let unanimousEvents = 0;
    let mixedDirectionEvents = 0;
    let conflictedEvents = 0;
    let decisiveYesEvents = 0;
    let decisiveNoEvents = 0;

    for (const bucket of eventVotes.values()) {
        const yesVotes = bucket.yesConfigs.size;
        const noVotes = bucket.noConfigs.size;
        if (yesVotes === 0 && noVotes === 0) {
            continue;
        }

        const isMixedDirection = yesVotes > 0 && noVotes > 0;
        if (isMixedDirection) {
            mixedDirectionEvents += 1;
        }

        if (mode === "conflict_filtered" && isMixedDirection) {
            conflictedEvents += 1;
            continue;
        }

        if (mode === "majority_vote" && yesVotes === noVotes) {
            conflictedEvents += 1;
            continue;
        }

        if (!isMixedDirection) {
            unanimousEvents += 1;
        }

        const predictedUp = yesVotes > noVotes;
        if (predictedUp) {
            decisiveYesEvents += 1;
        } else {
            decisiveNoEvents += 1;
        }

        const isWin = predictedUp ? bucket.actualOutcomeUp === 1 : bucket.actualOutcomeUp === 0;
        if (isWin) {
            wins += 1;
        } else {
            losses += 1;
        }
    }

    const scoredEvents = wins + losses;
    const skippedEvents = Math.max(0, evaluatedEvents - scoredEvents);
    const noSignalEvents = Math.max(0, evaluatedEvents - eventsWithVotes);

    return {
        evaluatedEvents,
        eventsWithVotes,
        scoredEvents,
        wins,
        losses,
        winRate: scoredEvents > 0 ? wins / scoredEvents : 0,
        coverage: evaluatedEvents > 0 ? scoredEvents / evaluatedEvents : 0,
        skippedEvents,
        skipRate: evaluatedEvents > 0 ? skippedEvents / evaluatedEvents : 0,
        noSignalEvents,
        noSignalRate: evaluatedEvents > 0 ? noSignalEvents / evaluatedEvents : 0,
        unanimousEvents,
        mixedDirectionEvents,
        conflictedEvents,
        decisiveYesEvents,
        decisiveNoEvents,
    };
}

function getVerdictRank(verdict: EnsemblePolymarketVerdict): number {
    switch (verdict) {
        case "edge":
            return 3;
        case "marginal":
            return 2;
        case "no_edge":
            return 1;
        default:
            return 0;
    }
}

function getVetoVerdictRank(verdict: EnsemblePolymarketVetoVerdict): number {
    switch (verdict) {
        case "interesting":
            return 3;
        case "marginal":
            return 2;
        case "neutral":
            return 1;
        default:
            return 0;
    }
}

function compareConfigResults(left: EnsemblePolymarketConfigResult, right: EnsemblePolymarketConfigResult): number {
    const verdictRank = getVerdictRank(right.verdict) - getVerdictRank(left.verdict);
    if (verdictRank !== 0) {
        return verdictRank;
    }
    if (right.wilsonLowerBound !== left.wilsonLowerBound) {
        return right.wilsonLowerBound - left.wilsonLowerBound;
    }
    if (right.deltaVsBestBaseline !== left.deltaVsBestBaseline) {
        return right.deltaVsBestBaseline - left.deltaVsBestBaseline;
    }
    if (right.evalResult.winRate !== left.evalResult.winRate) {
        return right.evalResult.winRate - left.evalResult.winRate;
    }
    if (right.evalResult.coverage !== left.evalResult.coverage) {
        return right.evalResult.coverage - left.evalResult.coverage;
    }
    return right.evalResult.scoredPredictions - left.evalResult.scoredPredictions;
}

function matchesPredictionDirectionSlice(
    prediction: "yes" | "no",
    directionSlice: EnsemblePolymarketDirectionSlice
): boolean {
    if (directionSlice === "all") {
        return true;
    }
    return directionSlice === "long_only" ? prediction === "yes" : prediction === "no";
}

function filterTradesByDirectionSlice(
    trades: readonly Trade[],
    directionSlice: EnsemblePolymarketDirectionSlice
): Trade[] {
    if (directionSlice === "all") {
        return [...trades];
    }
    const tradeType = directionSlice === "long_only" ? "long" : "short";
    return trades.filter((trade) => trade.type === tradeType);
}

function filterSignalsByDirectionSlice(
    signals: readonly Signal[],
    directionSlice: EnsemblePolymarketDirectionSlice
): Signal[] {
    if (directionSlice === "all") {
        return [...signals];
    }
    const signalType = directionSlice === "long_only" ? "buy" : "sell";
    return signals.filter((signal) => signal.type === signalType);
}

function buildExecutedEntrySignals(trades: readonly Trade[], candles: readonly OHLCVData[]): Signal[] {
    const barIndexByTime = new Map<string, number>();
    candles.forEach((candle, index) => {
        barIndexByTime.set(timeKey(candle.time), index);
    });

    const deduped = new Map<string, Signal>();
    for (const trade of trades) {
        const type: Signal["type"] = trade.type === "long" ? "buy" : "sell";
        const eventKey = `${timeKey(trade.entryTime)}:${type}`;
        if (deduped.has(eventKey)) {
            continue;
        }
        deduped.set(eventKey, {
            time: trade.entryTime,
            type,
            price: trade.entryPrice,
            triggerPrice: trade.entryPrice,
            barIndex: barIndexByTime.get(timeKey(trade.entryTime)),
        });
    }

    return Array.from(deduped.values()).sort(compareSignalsByBarIndexThenTime);
}

function inferReplayTradeDirection(
    signals: readonly Signal[],
    directionSlice: EnsemblePolymarketDirectionSlice,
    fallback: TradeDirection
): TradeDirection {
    if (directionSlice === "long_only") {
        return "long";
    }
    if (directionSlice === "short_only") {
        return "short";
    }

    const hasBuy = signals.some((signal) => signal.type === "buy");
    const hasSell = signals.some((signal) => signal.type === "sell");
    if (hasBuy && hasSell) {
        return "combined";
    }
    if (hasSell) {
        return "short";
    }
    if (hasBuy) {
        return "long";
    }
    return fallback;
}

function buildReplayBacktestSettings(
    backtestSettings: BacktestSettings,
    preparedSignals: readonly Signal[],
    directionSlice: EnsemblePolymarketDirectionSlice,
    fallbackDirection: TradeDirection
): BacktestSettings {
    return {
        ...backtestSettings,
        executionModel: "next_open",
        tradeDirection: inferReplayTradeDirection(preparedSignals, directionSlice, fallbackDirection),
        slippageBps: 0,
    };
}

function buildExecutedSignalArtifact(
    artifact: ConfigRunArtifact,
    candles: readonly OHLCVData[],
    directionSlice: EnsemblePolymarketDirectionSlice
): ExecutedSignalArtifact {
    const preparedSignals = filterSignalsByDirectionSlice(
        buildExecutedEntrySignals(filterTradesByDirectionSlice(artifact.result.trades, directionSlice), candles),
        directionSlice
    );
    return {
        runArtifact: artifact,
        preparedSignals,
        entryPresenceByTime: buildEntryPresenceLookup(preparedSignals),
        tradeDirection: inferReplayTradeDirection(preparedSignals, directionSlice, artifact.tradeDirection),
    };
}

function resolveBestBaseline(
    alwaysYesBaseline: number,
    alwaysNoBaseline: number,
    directionSlice: EnsemblePolymarketDirectionSlice
): number {
    if (directionSlice === "long_only") {
        return alwaysYesBaseline;
    }
    if (directionSlice === "short_only") {
        return alwaysNoBaseline;
    }
    return Math.max(alwaysYesBaseline, alwaysNoBaseline);
}

function compareSignalsByBarIndexThenTime(left: Signal, right: Signal): number {
    const leftBarIndex = Number.isFinite(left.barIndex as number) ? Math.trunc(left.barIndex as number) : null;
    const rightBarIndex = Number.isFinite(right.barIndex as number) ? Math.trunc(right.barIndex as number) : null;
    if (leftBarIndex !== null && rightBarIndex !== null && leftBarIndex !== rightBarIndex) {
        return leftBarIndex - rightBarIndex;
    }

    const leftKey = timeKey(left.time);
    const rightKey = timeKey(right.time);
    if (leftKey === rightKey) {
        return 0;
    }
    return leftKey < rightKey ? -1 : 1;
}

function describeDirectionSlice(directionSlice: EnsemblePolymarketDirectionSlice): string {
    switch (directionSlice) {
        case "long_only":
            return "Long Only";
        case "short_only":
            return "Short Only";
        default:
            return "All";
    }
}

function describeConflictPolicy(policy: EnsemblePolymarketConflictPolicy): string {
    switch (policy) {
        case "primary_veto":
            return "Primary + Secondary Veto";
        case "secondary_override":
            return "Secondary Override";
        case "best_side_owner":
            return "Best-Side Owner";
        case "skip_conflicts":
        default:
            return "Skip Conflicts";
    }
}

function buildConfigSideStats(
    configResult: EnsemblePolymarketConfigResult,
    side: "long" | "short",
    baseline: number
): SideStats | null {
    const prediction = side === "long" ? "yes" : "no";
    const rows = configResult.evalResult.rows.filter((row) => row.prediction === prediction);
    const wins = rows.filter((row) => row.isWin).length;
    const losses = rows.length - wins;
    const scoredPredictions = wins + losses;
    if (scoredPredictions <= 0) {
        return null;
    }
    const winRate = wins / scoredPredictions;
    const wilsonLowerBound = computeWilsonLowerBound(wins, scoredPredictions);

    return {
        configName: configResult.configName,
        familyLabel: configResult.familyLabel,
        scoredPredictions,
        wins,
        losses,
        winRate,
        wilsonLowerBound,
        deltaVsBaseline: winRate - baseline,
        verdict: determineEnsemblePolymarketVerdict(wilsonLowerBound, baseline, scoredPredictions),
    };
}

function compareSideStats(left: SideStats, right: SideStats): number {
    const verdictRank = getVerdictRank(right.verdict) - getVerdictRank(left.verdict);
    if (verdictRank !== 0) {
        return verdictRank;
    }
    if (right.wilsonLowerBound !== left.wilsonLowerBound) {
        return right.wilsonLowerBound - left.wilsonLowerBound;
    }
    if (right.deltaVsBaseline !== left.deltaVsBaseline) {
        return right.deltaVsBaseline - left.deltaVsBaseline;
    }
    if (right.winRate !== left.winRate) {
        return right.winRate - left.winRate;
    }
    return right.scoredPredictions - left.scoredPredictions;
}

async function evaluatePolicyRecipe(args: {
    policy: EnsemblePolymarketConflictPolicy;
    label: string;
    description: string;
    anchorArtifact: ConfigRunArtifact;
    preparedSignals: Signal[];
    directionSlice: EnsemblePolymarketDirectionSlice;
    bestBaseline: number;
    evaluationContext: ReturnType<typeof createPolymarketTradeEvaluationContext>;
    candles: OHLCVData[];
    outcomes: PolymarketOutcomeRow[];
    deps: StrategyEnsembleEngineDeps;
    retentionBase?: number | null;
    primaryConfigName?: string;
    primaryFamilyLabel?: string;
    secondaryConfigName?: string;
    secondaryFamilyLabel?: string;
    vetoConfigName?: string;
    vetoFamilyLabel?: string;
    longOwnerConfigName?: string;
    shortOwnerConfigName?: string;
}): Promise<EnsemblePolymarketPolicyResult | null> {
    if (args.preparedSignals.length === 0) {
        return null;
    }

    const replaySettings = buildReplayBacktestSettings(
        args.anchorArtifact.backtestSettings,
        args.preparedSignals,
        args.directionSlice,
        args.anchorArtifact.tradeDirection
    );
    const replay = await args.deps.evaluateSignalsOnData(
        args.candles,
        args.deps.interval,
        args.preparedSignals,
        replaySettings,
        args.deps.resolveCapitalFromConfig(args.anchorArtifact.config)
    );
    const evalResult = evaluatePolymarketBacktestTrades({
        chartData: args.candles,
        trades: filterTradesByDirectionSlice(replay.result.trades, args.directionSlice),
        outcomes: args.outcomes,
        strategyKey: args.anchorArtifact.config.strategyKey,
        context: args.evaluationContext,
    });
    const wilsonLowerBound = computeWilsonLowerBound(evalResult.wins, evalResult.scoredPredictions);

    return {
        policy: args.policy,
        label: args.label,
        description: args.description,
        anchorConfigName: args.anchorArtifact.config.name,
        anchorFamilyLabel: args.anchorArtifact.familyLabel,
        primaryConfigName: args.primaryConfigName,
        primaryFamilyLabel: args.primaryFamilyLabel,
        secondaryConfigName: args.secondaryConfigName,
        secondaryFamilyLabel: args.secondaryFamilyLabel,
        vetoConfigName: args.vetoConfigName,
        vetoFamilyLabel: args.vetoFamilyLabel,
        longOwnerConfigName: args.longOwnerConfigName,
        shortOwnerConfigName: args.shortOwnerConfigName,
        totalTrades: replay.result.totalTrades,
        scoredTrades: evalResult.scoredPredictions,
        pricedTrades: evalResult.pricedPredictions ?? 0,
        wins: evalResult.wins,
        losses: evalResult.losses,
        winRate: evalResult.winRate,
        expectancy: (evalResult.pricedPredictions ?? 0) > 0 ? (evalResult.expectancy ?? 0) : null,
        coverage: evalResult.coverage,
        retentionRate: args.retentionBase != null && args.retentionBase > 0
            ? evalResult.scoredPredictions / args.retentionBase
            : null,
        missingOutcomeTrades: evalResult.missingOutcomeRows,
        wilsonLowerBound,
        deltaVsBaseline: evalResult.winRate - args.bestBaseline,
        verdict: determineEnsemblePolymarketVerdict(
            wilsonLowerBound,
            args.bestBaseline,
            evalResult.scoredPredictions
        ),
    };
}

async function buildEnsemblePolymarketVetoScan(args: {
    configResults: readonly EnsemblePolymarketConfigResult[];
    executedArtifactsByName: ReadonlyMap<string, ExecutedSignalArtifact>;
    evaluationContext: ReturnType<typeof createPolymarketTradeEvaluationContext>;
    candles: OHLCVData[];
    outcomes: PolymarketOutcomeRow[];
    deps: StrategyEnsembleEngineDeps;
    bestBaseline: number;
    directionSlice: EnsemblePolymarketDirectionSlice;
    onProgress?: (message: string) => void;
}): Promise<EnsemblePolymarketRunResult["vetoScan"]> {
    const predictionIndexByConfig = new Map<string, Map<number, Set<"yes" | "no">>>();
    const pairResults: EnsemblePolymarketVetoPairResult[] = [];

    for (const configResult of args.configResults) {
        predictionIndexByConfig.set(
            configResult.configName,
            buildConfigPredictionIndex(configResult, args.directionSlice)
        );
    }

    for (const primaryResult of args.configResults) {
        if (primaryResult.evalResult.scoredPredictions <= 0) {
            continue;
        }

        const primaryArtifact = args.executedArtifactsByName.get(primaryResult.configName);
        if (!primaryArtifact) {
            continue;
        }

        for (const vetoResult of args.configResults) {
            if (primaryResult.configName === vetoResult.configName) {
                continue;
            }

            const vetoArtifact = args.executedArtifactsByName.get(vetoResult.configName);
            if (!vetoArtifact) {
                continue;
            }

            args.onProgress?.(`Testing veto pair ${primaryResult.configName} -> ${vetoResult.configName}...`);
            const vetoPredictions = predictionIndexByConfig.get(vetoResult.configName) ?? new Map<number, Set<"yes" | "no">>();
            let overlapEvents = 0;
            let vetoedEvents = 0;

            for (const row of primaryResult.evalResult.rows) {
                const vetoSignals = vetoPredictions.get(row.eventStartTs);
                if (vetoSignals) {
                    overlapEvents += 1;
                }

                const oppositePrediction = row.prediction === "yes" ? "no" : "yes";
                if (vetoSignals?.has(oppositePrediction)) {
                    vetoedEvents += 1;
                }
            }

            const evaluated = await evaluatePolicyRecipe({
                policy: "primary_veto",
                label: `Primary + Secondary Veto (${primaryResult.configName} -> ${vetoResult.configName})`,
                description: `${vetoResult.configName} vetoes opposite-side entries from ${primaryResult.configName}.`,
                anchorArtifact: primaryArtifact.runArtifact,
                preparedSignals: buildPrimaryVetoPreparedSignals(primaryArtifact, vetoArtifact),
                directionSlice: args.directionSlice,
                bestBaseline: args.bestBaseline,
                evaluationContext: args.evaluationContext,
                candles: args.candles,
                outcomes: args.outcomes,
                deps: args.deps,
                retentionBase: primaryResult.evalResult.scoredPredictions,
                primaryConfigName: primaryResult.configName,
                primaryFamilyLabel: primaryResult.familyLabel,
                vetoConfigName: vetoResult.configName,
                vetoFamilyLabel: vetoResult.familyLabel,
            });
            if (!evaluated) {
                continue;
            }

            const winRateLift = evaluated.winRate - primaryResult.evalResult.winRate;
            const wilsonLift = evaluated.wilsonLowerBound - primaryResult.wilsonLowerBound;

            pairResults.push({
                primaryConfigName: primaryResult.configName,
                primaryFamilyLabel: primaryResult.familyLabel,
                vetoConfigName: vetoResult.configName,
                vetoFamilyLabel: vetoResult.familyLabel,
                primaryScoredEvents: primaryResult.evalResult.scoredPredictions,
                overlapEvents,
                vetoedEvents,
                keptEvents: evaluated.scoredTrades,
                pricedTrades: evaluated.pricedTrades,
                keptWins: evaluated.wins,
                keptLosses: evaluated.losses,
                expectancy: evaluated.expectancy,
                primaryWinRate: primaryResult.evalResult.winRate,
                postVetoWinRate: evaluated.winRate,
                winRateLift,
                retentionRate: evaluated.retentionRate ?? 0,
                overlapRate: primaryResult.evalResult.scoredPredictions > 0
                    ? overlapEvents / primaryResult.evalResult.scoredPredictions
                    : 0,
                postVetoWilsonLowerBound: evaluated.wilsonLowerBound,
                primaryWilsonLowerBound: primaryResult.wilsonLowerBound,
                wilsonLift,
                verdict: determineEnsemblePolymarketVetoVerdict(wilsonLift, winRateLift, evaluated.scoredTrades),
            });
        }
    }

    pairResults.sort((left, right) => {
        const verdictRank = getVetoVerdictRank(right.verdict) - getVetoVerdictRank(left.verdict);
        if (verdictRank !== 0) {
            return verdictRank;
        }
        if (right.wilsonLift !== left.wilsonLift) {
            return right.wilsonLift - left.wilsonLift;
        }
        if (right.winRateLift !== left.winRateLift) {
            return right.winRateLift - left.winRateLift;
        }
        if (right.retentionRate !== left.retentionRate) {
            return right.retentionRate - left.retentionRate;
        }
        return right.keptEvents - left.keptEvents;
    });

    return {
        pairResults,
        positivePairCount: pairResults.filter((pairResult) => pairResult.verdict === "interesting" || pairResult.verdict === "marginal").length,
        bestPair: pairResults[0] ?? null,
    };
}

async function buildEnsemblePolymarketOverrideScan(args: {
    configResults: readonly EnsemblePolymarketConfigResult[];
    executedArtifactsByName: ReadonlyMap<string, ExecutedSignalArtifact>;
    evaluationContext: ReturnType<typeof createPolymarketTradeEvaluationContext>;
    candles: OHLCVData[];
    outcomes: PolymarketOutcomeRow[];
    deps: StrategyEnsembleEngineDeps;
    bestBaseline: number;
    directionSlice: EnsemblePolymarketDirectionSlice;
    onProgress?: (message: string) => void;
}): Promise<EnsemblePolymarketRunResult["overrideScan"]> {
    const predictionIndexByConfig = new Map<string, Map<number, Set<"yes" | "no">>>();
    const pairResults: EnsemblePolymarketOverridePairResult[] = [];

    for (const configResult of args.configResults) {
        predictionIndexByConfig.set(
            configResult.configName,
            buildConfigPredictionIndex(configResult, args.directionSlice)
        );
    }

    for (const primaryResult of args.configResults) {
        if (primaryResult.evalResult.scoredPredictions <= 0) {
            continue;
        }

        const primaryArtifact = args.executedArtifactsByName.get(primaryResult.configName);
        if (!primaryArtifact) {
            continue;
        }

        for (const secondaryResult of args.configResults) {
            if (primaryResult.configName === secondaryResult.configName) {
                continue;
            }

            const secondaryArtifact = args.executedArtifactsByName.get(secondaryResult.configName);
            if (!secondaryArtifact) {
                continue;
            }

            args.onProgress?.(`Testing override pair ${primaryResult.configName} -> ${secondaryResult.configName}...`);
            const secondaryPredictions = predictionIndexByConfig.get(secondaryResult.configName) ?? new Map<number, Set<"yes" | "no">>();
            let overlapEvents = 0;
            let overriddenEvents = 0;

            for (const row of primaryResult.evalResult.rows) {
                const secondarySignals = secondaryPredictions.get(row.eventStartTs);
                if (secondarySignals) {
                    overlapEvents += 1;
                }

                const oppositePrediction = row.prediction === "yes" ? "no" : "yes";
                if (secondarySignals?.has(oppositePrediction)) {
                    overriddenEvents += 1;
                }
            }

            const evaluated = await evaluatePolicyRecipe({
                policy: "secondary_override",
                label: `Secondary Override (${primaryResult.configName} -> ${secondaryResult.configName})`,
                description: `${secondaryResult.configName} replaces ${primaryResult.configName} on opposite-side conflicts.`,
                anchorArtifact: primaryArtifact.runArtifact,
                preparedSignals: buildPrimarySecondaryOverridePreparedSignals(primaryArtifact, secondaryArtifact),
                directionSlice: args.directionSlice,
                bestBaseline: args.bestBaseline,
                evaluationContext: args.evaluationContext,
                candles: args.candles,
                outcomes: args.outcomes,
                deps: args.deps,
                retentionBase: primaryResult.evalResult.scoredPredictions,
                primaryConfigName: primaryResult.configName,
                primaryFamilyLabel: primaryResult.familyLabel,
                secondaryConfigName: secondaryResult.configName,
                secondaryFamilyLabel: secondaryResult.familyLabel,
            });
            if (!evaluated) {
                continue;
            }

            const winRateLift = evaluated.winRate - primaryResult.evalResult.winRate;
            const wilsonLift = evaluated.wilsonLowerBound - primaryResult.wilsonLowerBound;

            pairResults.push({
                primaryConfigName: primaryResult.configName,
                primaryFamilyLabel: primaryResult.familyLabel,
                secondaryConfigName: secondaryResult.configName,
                secondaryFamilyLabel: secondaryResult.familyLabel,
                primaryScoredEvents: primaryResult.evalResult.scoredPredictions,
                overlapEvents,
                overriddenEvents,
                keptEvents: evaluated.scoredTrades,
                pricedTrades: evaluated.pricedTrades,
                keptWins: evaluated.wins,
                keptLosses: evaluated.losses,
                expectancy: evaluated.expectancy,
                primaryWinRate: primaryResult.evalResult.winRate,
                postOverrideWinRate: evaluated.winRate,
                winRateLift,
                retentionRate: evaluated.retentionRate ?? 0,
                overlapRate: primaryResult.evalResult.scoredPredictions > 0
                    ? overlapEvents / primaryResult.evalResult.scoredPredictions
                    : 0,
                postOverrideWilsonLowerBound: evaluated.wilsonLowerBound,
                primaryWilsonLowerBound: primaryResult.wilsonLowerBound,
                wilsonLift,
                verdict: determineEnsemblePolymarketVetoVerdict(wilsonLift, winRateLift, evaluated.scoredTrades),
            });
        }
    }

    pairResults.sort((left, right) => {
        const verdictRank = getVetoVerdictRank(right.verdict) - getVetoVerdictRank(left.verdict);
        if (verdictRank !== 0) {
            return verdictRank;
        }
        if (right.wilsonLift !== left.wilsonLift) {
            return right.wilsonLift - left.wilsonLift;
        }
        if (right.winRateLift !== left.winRateLift) {
            return right.winRateLift - left.winRateLift;
        }
        if (right.retentionRate !== left.retentionRate) {
            return right.retentionRate - left.retentionRate;
        }
        return right.keptEvents - left.keptEvents;
    });

    return {
        pairResults,
        positivePairCount: pairResults.filter((pairResult) => pairResult.verdict === "interesting" || pairResult.verdict === "marginal").length,
        bestPair: pairResults[0] ?? null,
    };
}

function buildSelectedPolicyResult(args: {
    selectedPolicy: EnsemblePolymarketConflictPolicy;
    policyResults: EnsemblePolymarketRunResult["policyResults"];
}): EnsemblePolymarketPolicyResult | null {
    switch (args.selectedPolicy) {
        case "primary_veto":
            return args.policyResults.primaryVeto;
        case "secondary_override":
            return args.policyResults.secondaryOverride;
        case "best_side_owner":
            return args.policyResults.bestSideOwner;
        case "skip_conflicts":
        default:
            return args.policyResults.skipConflicts;
    }
}

export async function runEnsemblePolymarket(args: {
    targetName: string;
    contextNames: string[];
    candles: OHLCVData[];
    symbol: string;
    interval: string;
    outcomes: PolymarketOutcomeRow[];
    deps: StrategyEnsembleEngineDeps;
    conflictPolicy?: EnsemblePolymarketConflictPolicy;
    directionSlice?: EnsemblePolymarketDirectionSlice;
    onProgress?: (message: string) => void;
}): Promise<EnsemblePolymarketRunResult> {
    const {
        targetName,
        contextNames,
        candles,
        symbol,
        interval,
        outcomes,
        deps,
        onProgress,
    } = args;
    const selectedPolicy = args.conflictPolicy ?? "skip_conflicts";
    const directionSlice = args.directionSlice ?? "all";

    if (!isSupportedPolymarket5mRun(symbol, interval)) {
        throw new Error(`Ensemble Polymarket currently supports ${getSupportedPolymarket5mSymbolsLabel()} on 5m.`);
    }

    if (candles.length < 2) {
        throw new Error("Not enough closed candle data for Polymarket evaluation.");
    }

    const seriesId = getPolymarket5mSeriesIdForSymbol(symbol);
    if (!seriesId) {
        throw new Error(`Ensemble Polymarket currently supports ${getSupportedPolymarket5mSymbolsLabel()} on 5m.`);
    }

    if (outcomes.length === 0) {
        throw new Error(`No Polymarket outcome rows available for series ${seriesId}. Run poly:sync-outcomes first.`);
    }

    const evaluationContext = createPolymarketTradeEvaluationContext(candles, outcomes);
    const alwaysYesBaseline = evaluationContext.evaluatedEvents > 0
        ? evaluationContext.resolvedUpCount / evaluationContext.evaluatedEvents
        : 0;
    const alwaysNoBaseline = evaluationContext.evaluatedEvents > 0
        ? (evaluationContext.evaluatedEvents - evaluationContext.resolvedUpCount) / evaluationContext.evaluatedEvents
        : 0;
    const bestBaseline = resolveBestBaseline(alwaysYesBaseline, alwaysNoBaseline, directionSlice);

    const selectedNames = [targetName, ...contextNames];
    const configResults: EnsemblePolymarketConfigResult[] = [];
    const runArtifactsByName = new Map<string, ConfigRunArtifact>();
    const executedArtifactsByName = new Map<string, ExecutedSignalArtifact>();
    let totalWins = 0;
    let totalScoredTrades = 0;

    for (let index = 0; index < selectedNames.length; index += 1) {
        const configName = selectedNames[index]!;
        onProgress?.(`Scoring ${configName} (${index + 1}/${selectedNames.length}) against Polymarket outcomes...`);

        const artifact = await runConfig(configName, candles, deps);
        if (!artifact) {
            throw new Error(`Config "${configName}" could not be evaluated.`);
        }

        runArtifactsByName.set(configName, artifact);
        const evalResult = evaluatePolymarketBacktestTrades({
            chartData: candles,
            trades: filterTradesByDirectionSlice(artifact.result.trades, directionSlice),
            outcomes,
            strategyKey: artifact.config.strategyKey,
            context: evaluationContext,
        });
        const wilsonLowerBound = computeWilsonLowerBound(evalResult.wins, evalResult.scoredPredictions);
        const deltaVsBestBaseline = evalResult.winRate - bestBaseline;

        configResults.push({
            configName: artifact.config.name,
            familyKey: artifact.familyKey,
            familyLabel: artifact.familyLabel,
            tradeDirection: artifact.tradeDirection,
            evalResult,
            wilsonLowerBound,
            deltaVsBestBaseline,
            verdict: determineEnsemblePolymarketVerdict(
                wilsonLowerBound,
                bestBaseline,
                evalResult.scoredPredictions
            ),
        });

        executedArtifactsByName.set(configName, buildExecutedSignalArtifact(artifact, candles, directionSlice));
        totalWins += evalResult.wins;
        totalScoredTrades += evalResult.scoredPredictions;
    }

    configResults.sort(compareConfigResults);
    const targetRunArtifact = runArtifactsByName.get(targetName);
    const targetExecutedArtifact = executedArtifactsByName.get(targetName);
    if (!targetRunArtifact || !targetExecutedArtifact) {
        throw new Error(`Target config "${targetName}" could not be evaluated.`);
    }

    const bestConfig = configResults[0] ?? null;
    const ensembleWinRate = totalScoredTrades > 0 ? totalWins / totalScoredTrades : 0;
    const conflictFilteredOverlay = buildEnsemblePolymarketAgreement(
        configResults,
        evaluationContext.evaluatedEvents,
        "conflict_filtered",
        directionSlice
    );
    const majorityVoteOverlay = buildEnsemblePolymarketAgreement(
        configResults,
        evaluationContext.evaluatedEvents,
        "majority_vote",
        directionSlice
    );

    onProgress?.(`Evaluating ${describeConflictPolicy(selectedPolicy)} (${describeDirectionSlice(directionSlice)})...`);
    const skipConflictsResult = await evaluatePolicyRecipe({
        policy: "skip_conflicts",
        label: `Skip Conflicts (${describeDirectionSlice(directionSlice)})`,
        description: `Replay ${targetName} after skipping opposite/conflicted context events across ${contextNames.length} selected context config${contextNames.length === 1 ? "" : "s"}.`,
        anchorArtifact: targetRunArtifact,
        preparedSignals: buildTargetConflictFilterPreparedSignals(
            targetExecutedArtifact,
            contextNames
                .map((name) => executedArtifactsByName.get(name) ?? null)
                .filter((artifact): artifact is ExecutedSignalArtifact => artifact !== null)
        ),
        directionSlice,
        bestBaseline,
        evaluationContext,
        candles,
        outcomes,
        deps,
        retentionBase: conflictFilteredOverlay.scoredEvents,
        primaryConfigName: targetRunArtifact.config.name,
        primaryFamilyLabel: targetRunArtifact.familyLabel,
    });

    const vetoScan = await buildEnsemblePolymarketVetoScan({
        configResults,
        executedArtifactsByName,
        evaluationContext,
        candles,
        outcomes,
        deps,
        bestBaseline,
        directionSlice,
        onProgress,
    });

    const overrideScan = await buildEnsemblePolymarketOverrideScan({
        configResults,
        executedArtifactsByName,
        evaluationContext,
        candles,
        outcomes,
        deps,
        bestBaseline,
        directionSlice,
        onProgress,
    });

    const bestVetoPair = vetoScan.bestPair;
    const bestOverridePair = overrideScan.bestPair;

    const primaryVetoResult = bestVetoPair
        ? await evaluatePolicyRecipe({
            policy: "primary_veto",
            label: `Primary + Secondary Veto (${bestVetoPair.primaryConfigName} -> ${bestVetoPair.vetoConfigName})`,
            description: `${bestVetoPair.vetoConfigName} vetoes opposite-side entries from ${bestVetoPair.primaryConfigName}.`,
            anchorArtifact: runArtifactsByName.get(bestVetoPair.primaryConfigName) ?? targetRunArtifact,
            preparedSignals: buildPrimaryVetoPreparedSignals(
                executedArtifactsByName.get(bestVetoPair.primaryConfigName)!,
                executedArtifactsByName.get(bestVetoPair.vetoConfigName)!
            ),
            directionSlice,
            bestBaseline,
            evaluationContext,
            candles,
            outcomes,
            deps,
            retentionBase: bestVetoPair.primaryScoredEvents,
            primaryConfigName: bestVetoPair.primaryConfigName,
            primaryFamilyLabel: bestVetoPair.primaryFamilyLabel,
            vetoConfigName: bestVetoPair.vetoConfigName,
            vetoFamilyLabel: bestVetoPair.vetoFamilyLabel,
        })
        : null;

    const secondaryOverrideResult = bestOverridePair
        ? await evaluatePolicyRecipe({
            policy: "secondary_override",
            label: `Secondary Override (${bestOverridePair.primaryConfigName} -> ${bestOverridePair.secondaryConfigName})`,
            description: `${bestOverridePair.secondaryConfigName} replaces ${bestOverridePair.primaryConfigName} on opposite-side conflicts.`,
            anchorArtifact: runArtifactsByName.get(bestOverridePair.primaryConfigName) ?? targetRunArtifact,
            preparedSignals: buildPrimarySecondaryOverridePreparedSignals(
                executedArtifactsByName.get(bestOverridePair.primaryConfigName)!,
                executedArtifactsByName.get(bestOverridePair.secondaryConfigName)!
            ),
            directionSlice,
            bestBaseline,
            evaluationContext,
            candles,
            outcomes,
            deps,
            retentionBase: bestOverridePair.primaryScoredEvents,
            primaryConfigName: bestOverridePair.primaryConfigName,
            primaryFamilyLabel: bestOverridePair.primaryFamilyLabel,
            secondaryConfigName: bestOverridePair.secondaryConfigName,
            secondaryFamilyLabel: bestOverridePair.secondaryFamilyLabel,
        })
        : null;

    const bestLongOwner = directionSlice === "short_only"
        ? null
        : configResults
            .map((result) => buildConfigSideStats(result, "long", alwaysYesBaseline))
            .filter((result): result is SideStats => result !== null)
            .sort(compareSideStats)[0] ?? null;
    const bestShortOwner = directionSlice === "long_only"
        ? null
        : configResults
            .map((result) => buildConfigSideStats(result, "short", alwaysNoBaseline))
            .filter((result): result is SideStats => result !== null)
            .sort(compareSideStats)[0] ?? null;

    const bestSideOwnerSignals = buildBestSideOwnerPreparedSignals({
        longArtifact: bestLongOwner ? executedArtifactsByName.get(bestLongOwner.configName) ?? null : null,
        shortArtifact: bestShortOwner ? executedArtifactsByName.get(bestShortOwner.configName) ?? null : null,
    });
    const bestSideOwnerResult = bestSideOwnerSignals.length > 0
        ? await evaluatePolicyRecipe({
            policy: "best_side_owner",
            label: directionSlice === "all"
                ? `Best-Side Owner (${bestLongOwner?.configName ?? "n/a"} long / ${bestShortOwner?.configName ?? "n/a"} short)`
                : directionSlice === "long_only"
                    ? `Best Long Owner (${bestLongOwner?.configName ?? "n/a"})`
                    : `Best Short Owner (${bestShortOwner?.configName ?? "n/a"})`,
            description: directionSlice === "all"
                ? `Use ${bestLongOwner?.configName ?? "n/a"} for long-side events and ${bestShortOwner?.configName ?? "n/a"} for short-side events, skipping owner conflicts.`
                : directionSlice === "long_only"
                    ? `Use ${bestLongOwner?.configName ?? "n/a"} as the long-side owner.`
                    : `Use ${bestShortOwner?.configName ?? "n/a"} as the short-side owner.`,
            anchorArtifact: targetRunArtifact,
            preparedSignals: bestSideOwnerSignals,
            directionSlice,
            bestBaseline,
            evaluationContext,
            candles,
            outcomes,
            deps,
            retentionBase: null,
            longOwnerConfigName: bestLongOwner?.configName,
            shortOwnerConfigName: bestShortOwner?.configName,
        })
        : null;

    const policyResults = {
        skipConflicts: skipConflictsResult,
        primaryVeto: primaryVetoResult,
        secondaryOverride: secondaryOverrideResult,
        bestSideOwner: bestSideOwnerResult,
    } satisfies EnsemblePolymarketRunResult["policyResults"];
    const selectedPolicyResult = buildSelectedPolicyResult({ selectedPolicy, policyResults });
    const conflictExecutableOverlay = skipConflictsResult
        ? {
            totalTrades: skipConflictsResult.totalTrades,
            scoredTrades: skipConflictsResult.scoredTrades,
            wins: skipConflictsResult.wins,
            losses: skipConflictsResult.losses,
            winRate: skipConflictsResult.winRate,
            coverage: skipConflictsResult.coverage,
            retentionRate: conflictFilteredOverlay.scoredEvents > 0
                ? skipConflictsResult.scoredTrades / conflictFilteredOverlay.scoredEvents
                : 0,
            skippedByExecution: Math.max(0, conflictFilteredOverlay.scoredEvents - skipConflictsResult.scoredTrades),
            missingOutcomeTrades: skipConflictsResult.missingOutcomeTrades,
        }
        : null;

    return {
        symbol,
        interval,
        seriesId,
        selectedPolicy,
        directionSlice,
        configResults,
        ensembleSummary: {
            configsEvaluated: configResults.length,
            configsScored: configResults.filter((result) => result.evalResult.scoredPredictions > 0).length,
            totalScoredTrades,
            ensembleWinRate,
            bestConfigWinRate: bestConfig?.evalResult.winRate ?? 0,
            bestConfigName: bestConfig?.configName ?? "n/a",
            alwaysYesBaseline,
            alwaysNoBaseline,
            bestBaseline,
            ensembleDeltaVsBestBaseline: ensembleWinRate - bestBaseline,
        },
        conflictFilteredOverlay,
        conflictExecutableOverlay,
        majorityVoteOverlay,
        policyResults,
        selectedPolicyResult,
        vetoScan,
        overrideScan,
    };
}
