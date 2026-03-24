import { parseTimeToUnixSeconds } from './time-normalization';
import type { OHLCVData, Strategy, StrategyParams } from './types/strategies';
import type {
    PolymarketEvalOptions,
    PolymarketEvalResult,
    PolymarketEvalRow,
    PolymarketOutcomeRow,
} from './types/polymarket-outcomes';

function barTimeToSec(bar: OHLCVData): number | null {
    return parseTimeToUnixSeconds(bar.time);
}

export function evaluatePolymarketOutcomes(
    chartData: OHLCVData[],
    strategy: Strategy,
    params: StrategyParams,
    outcomes: PolymarketOutcomeRow[],
    options: PolymarketEvalOptions = {}
): PolymarketEvalResult {
    const executionMode = options.executionMode ?? 'next_open';
    const tradeDirection = options.tradeDirection ?? 'both';
    const strategyKey = options.strategyKey;

    if (executionMode !== 'next_open') {
        throw new Error(`evaluatePolymarketOutcomes: unsupported executionMode "${executionMode}". Only "next_open" is supported.`);
    }

    const normalizedParams = strategy.normalizeParams ? strategy.normalizeParams(params) : { ...params };
    let signals = options.usePreparedData && strategy.prepareFinderData && strategy.executePrepared
        ? strategy.executePrepared(strategy.prepareFinderData(chartData), normalizedParams, chartData)
        : strategy.execute(chartData, normalizedParams);

    if (tradeDirection === 'long') {
        signals = signals.filter(signal => signal.type === 'buy');
    } else if (tradeDirection === 'short') {
        signals = signals.filter(signal => signal.type === 'sell');
    }

    const outcomeByStartTs = new Map<number, PolymarketOutcomeRow>();
    for (const row of outcomes) {
        outcomeByStartTs.set(row.event_start_ts, row);
    }

    const barTimes = chartData.map(barTimeToSec);
    const validTargetTs = new Set<number>();
    for (let i = 1; i < barTimes.length; i++) {
        const ts = barTimes[i];
        if (ts !== null) validTargetTs.add(ts);
    }

    type PendingPrediction = {
        targetTs: number;
        signalBarIndex: number;
        prediction: 'yes' | 'no';
        signalTime: number;
        signalReason: string | undefined;
    };

    const seenTargetTs = new Set<number>();
    const predictions: PendingPrediction[] = [];
    let ignoredSignals = 0;

    for (const signal of signals) {
        let barIndex = signal.barIndex ?? -1;
        if (barIndex < 0) {
            const signalTime = parseTimeToUnixSeconds(signal.time);
            barIndex = chartData.findIndex(bar => parseTimeToUnixSeconds(bar.time) === signalTime);
        }

        if (barIndex < 0 || barIndex >= chartData.length) {
            ignoredSignals++;
            continue;
        }

        const nextBarIndex = barIndex + 1;
        if (nextBarIndex >= chartData.length) {
            ignoredSignals++;
            continue;
        }

        const targetTs = barTimes[nextBarIndex];
        if (targetTs === null) {
            ignoredSignals++;
            continue;
        }

        if (seenTargetTs.has(targetTs)) {
            ignoredSignals++;
            continue;
        }
        seenTargetTs.add(targetTs);

        predictions.push({
            targetTs,
            signalBarIndex: barIndex,
            prediction: signal.type === 'buy' ? 'yes' : 'no',
            signalTime: barTimes[barIndex] ?? 0,
            signalReason: signal.reason,
        });
    }

    const rows: PolymarketEvalRow[] = [];
    let wins = 0;
    let losses = 0;
    let missingOutcomeRows = 0;
    let longPredictions = 0;
    let shortPredictions = 0;
    let longWins = 0;
    let shortWins = 0;

    for (const prediction of predictions) {
        if (prediction.prediction === 'yes') {
            longPredictions++;
        } else {
            shortPredictions++;
        }

        const outcome = outcomeByStartTs.get(prediction.targetTs);
        if (!outcome) {
            missingOutcomeRows++;
            continue;
        }

        const isWin = prediction.prediction === 'yes'
            ? outcome.resolved_outcome_up === 1
            : outcome.resolved_outcome_up === 0;

        if (isWin) {
            wins++;
            if (prediction.prediction === 'yes') longWins++;
            if (prediction.prediction === 'no') shortWins++;
        } else {
            losses++;
        }

        rows.push({
            eventStartTs: outcome.event_start_ts,
            eventEndTs: outcome.event_end_ts,
            eventSlug: outcome.event_slug,
            signalBarIndex: prediction.signalBarIndex,
            signalTime: prediction.signalTime,
            prediction: prediction.prediction,
            actualOutcomeUp: outcome.resolved_outcome_up,
            isWin,
            signalReason: prediction.signalReason,
            strategyKey,
        });
    }

    let evaluatedEvents = 0;
    let resolvedUpCount = 0;
    for (const row of outcomes) {
        if (!validTargetTs.has(row.event_start_ts)) continue;
        evaluatedEvents++;
        resolvedUpCount += row.resolved_outcome_up;
    }

    const predictionsTaken = predictions.length;
    const scoredPredictions = rows.length;

    return {
        evaluatedEvents,
        predictionsTaken,
        scoredPredictions,
        wins,
        losses,
        skips: Math.max(0, evaluatedEvents - scoredPredictions),
        winRate: scoredPredictions > 0 ? wins / scoredPredictions : 0,
        coverage: evaluatedEvents > 0 ? scoredPredictions / evaluatedEvents : 0,
        longPredictions,
        shortPredictions,
        longWins,
        shortWins,
        longWinRate: longPredictions > 0 ? longWins / longPredictions : 0,
        shortWinRate: shortPredictions > 0 ? shortWins / shortPredictions : 0,
        alwaysYesBaselineWinRate: evaluatedEvents > 0 ? resolvedUpCount / evaluatedEvents : 0,
        alwaysNoBaselineWinRate: evaluatedEvents > 0 ? (evaluatedEvents - resolvedUpCount) / evaluatedEvents : 0,
        missingOutcomeRows,
        ignoredSignals,
        rows,
    };
}
