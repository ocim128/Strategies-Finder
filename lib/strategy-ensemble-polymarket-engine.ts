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
    runConfig,
    type StrategyEnsembleEngineDeps,
} from "./strategy-ensemble-engine";
import type { OHLCVData } from "./strategies";
import type {
    PolymarketEvalResult,
    PolymarketOutcomeRow,
} from "./types/polymarket-outcomes";

export type EnsemblePolymarketVerdict = "edge" | "marginal" | "no_edge" | "insufficient";

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

export interface EnsemblePolymarketRunResult {
    symbol: string;
    interval: string;
    seriesId: string;
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
    majorityVoteOverlay: EnsemblePolymarketAgreementSummary;
}

const ENSEMBLE_POLYMARKET_MIN_SCORED = 30;
const ENSEMBLE_POLYMARKET_EDGE_BUFFER = 0.02;

type EventVoteBucket = {
    actualOutcomeUp: 0 | 1;
    yesConfigs: Set<string>;
    noConfigs: Set<string>;
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

function buildEventVoteBuckets(
    configResults: readonly EnsemblePolymarketConfigResult[],
): Map<number, EventVoteBucket> {
    const eventVotes = new Map<number, EventVoteBucket>();

    for (const result of configResults) {
        for (const row of result.evalResult.rows) {
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

export function buildEnsemblePolymarketAgreement(
    configResults: readonly EnsemblePolymarketConfigResult[],
    evaluatedEvents: number,
    mode: "majority_vote" | "conflict_filtered"
): EnsemblePolymarketAgreementSummary {
    const eventVotes = buildEventVoteBuckets(configResults);
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
        const isWin = predictedUp
            ? bucket.actualOutcomeUp === 1
            : bucket.actualOutcomeUp === 0;

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

export async function runEnsemblePolymarket(args: {
    targetName: string;
    contextNames: string[];
    candles: OHLCVData[];
    symbol: string;
    interval: string;
    outcomes: PolymarketOutcomeRow[];
    deps: StrategyEnsembleEngineDeps;
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
    const bestBaseline = Math.max(alwaysYesBaseline, alwaysNoBaseline);

    const selectedNames = [targetName, ...contextNames];
    const configResults: EnsemblePolymarketConfigResult[] = [];
    let totalWins = 0;
    let totalScoredTrades = 0;

    for (let index = 0; index < selectedNames.length; index += 1) {
        const configName = selectedNames[index]!;
        onProgress?.(`Scoring ${configName} (${index + 1}/${selectedNames.length}) against Polymarket outcomes...`);

        const artifact = await runConfig(configName, candles, deps);
        if (!artifact) {
            throw new Error(`Config "${configName}" could not be evaluated.`);
        }

        const evalResult = evaluatePolymarketBacktestTrades({
            chartData: candles,
            trades: artifact.result.trades,
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

        totalWins += evalResult.wins;
        totalScoredTrades += evalResult.scoredPredictions;
    }

    const bestConfig = configResults.reduce<EnsemblePolymarketConfigResult | null>((best, current) => {
        if (current.evalResult.scoredPredictions <= 0) {
            return best;
        }
        if (!best) {
            return current;
        }
        if (current.evalResult.winRate !== best.evalResult.winRate) {
            return current.evalResult.winRate > best.evalResult.winRate ? current : best;
        }
        return current.evalResult.scoredPredictions > best.evalResult.scoredPredictions ? current : best;
    }, null);

    const ensembleWinRate = totalScoredTrades > 0 ? totalWins / totalScoredTrades : 0;

    return {
        symbol,
        interval,
        seriesId,
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
        conflictFilteredOverlay: buildEnsemblePolymarketAgreement(
            configResults,
            evaluationContext.evaluatedEvents,
            "conflict_filtered"
        ),
        majorityVoteOverlay: buildEnsemblePolymarketAgreement(
            configResults,
            evaluationContext.evaluatedEvents,
            "majority_vote"
        ),
    };
}
