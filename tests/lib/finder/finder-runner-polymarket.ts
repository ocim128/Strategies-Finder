/**
 * Polymarket-mode Finder runner.
 *
 * Replaces backtest-based ranking with classification-based ranking
 * using the Polymarket outcome evaluator from phase-1.
 */
import type { OHLCVData, BacktestResult } from '../strategies/index';
import type { FinderResult } from '../types/finder';
import type { PolymarketOutcomeRow, PolymarketEvalResult } from '../types/polymarket-outcomes';
import { evaluatePolymarketOutcomes } from '../polymarket-outcome-evaluator';
import { loadPolymarketOutcomes } from '../local-sqlite-polymarket-api';
import { parseTimeToUnixSeconds } from '../time-normalization';
import { POLYMARKET_SORT_PRIORITY } from './constants';
import { FinderResultRanker } from './finder-result-ranker';
import { buildFinderEvaluationData, buildFinderResult, type StrategyPlan } from './finder-runner-shared';
import { buildFinderSearchBaseParams } from './finder-runner-core';
import type { FinderRunInput, FinderRunCallbacks, FinderRunOutput } from './finder-runner';

const BTC_5M_POLYMARKET_SERIES_ID = '10684';

// ─── Neutral placeholder BacktestResult ───────────────────────────────────

function buildNeutralBacktestResult(evalResult: PolymarketEvalResult): BacktestResult {
    return {
        trades: [],
        netProfit: 0,
        netProfitPercent: 0,
        winRate: evalResult.winRate * 100,
        expectancy: 0,
        avgTrade: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: evalResult.predictionsTaken,
        winningTrades: evalResult.wins,
        losingTrades: evalResult.losses,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
    };
}

// ─── Outcome loading ──────────────────────────────────────────────────────

async function loadOutcomesForChart(chartData: OHLCVData[]): Promise<PolymarketOutcomeRow[]> {
    if (chartData.length < 2) return [];

    // Compute time range from chart data
    const firstTs = parseTimeToUnixSeconds(chartData[0].time);
    const lastTs = parseTimeToUnixSeconds(chartData[chartData.length - 1].time);
    if (firstTs === null || lastTs === null) return [];

    // Load with a small buffer
    return loadPolymarketOutcomes({
        seriesId: BTC_5M_POLYMARKET_SERIES_ID,
        startTs: firstTs - 300,
        endTs: lastTs + 600,
    });
}

// ─── Main Polymarket Finder runner ────────────────────────────────────────

export async function runPolymarketFinder(
    input: FinderRunInput,
    callbacks: FinderRunCallbacks
): Promise<FinderRunOutput> {
    const { options, settings, selectedStrategies } = input;

    // ── Guardrails ──
    if (input.interval !== '5m') {
        callbacks.setStatus('Polymarket scoring requires 5m interval.');
        return { results: [] };
    }

    if (options.multiTimeframeEnabled) {
        callbacks.setStatus('Multi-timeframe is not supported in Polymarket mode.');
        return { results: [] };
    }

    if (options.comboEnabled) {
        callbacks.setStatus('Combo mode is not supported in Polymarket mode.');
        return { results: [] };
    }

    if (options.mode !== 'grid' && options.mode !== 'random') {
        callbacks.setStatus(`"${options.mode}" mode is not supported in Polymarket mode. Use grid or random.`);
        return { results: [] };
    }

    // ── Load outcome rows once ──
    callbacks.setProgress(5, 'Loading Polymarket outcome data...');
    callbacks.setStatus('Loading Polymarket outcomes from SQLite...');

    const closedData = buildFinderEvaluationData(input.ohlcvData, input.interval, settings);
    if (closedData.length < 2) {
        callbacks.setStatus('Not enough chart data for Polymarket evaluation.');
        return { results: [] };
    }

    const outcomes = await loadOutcomesForChart(closedData);
    if (outcomes.length === 0) {
        callbacks.setStatus(`No Polymarket outcome rows available for series ${BTC_5M_POLYMARKET_SERIES_ID}. Run poly:sync-outcomes first.`);
        return { results: [] };
    }

    callbacks.setStatus(`Loaded ${outcomes.length} outcome rows. Preparing strategies...`);
    callbacks.setProgress(10, 'Preparing parameter sets...');

    // ── Build strategy plans ──
    const strategyPlans: StrategyPlan[] = [];
    let totalRuns = 0;
    for (const selection of selectedStrategies) {
        const extendedDefaults = buildFinderSearchBaseParams(selection.strategy, settings, options);
        const paramSets = input.generateParamSets(extendedDefaults, options);
        if (paramSets.length === 0) continue;
        totalRuns += paramSets.length;
        strategyPlans.push({
            key: selection.key,
            name: selection.name,
            strategy: selection.strategy,
            paramSets,
        });
    }

    if (totalRuns === 0) {
        callbacks.setStatus('No valid parameter combinations generated.');
        return { results: [] };
    }

    // ── Evaluate all candidates ──
    const sortPriority = POLYMARKET_SORT_PRIORITY;
    const ranker = new FinderResultRanker(Math.max(options.topN, 50), sortPriority);
    let processedCount = 0;
    let filteredCount = 0;
    let lastUiUpdateAt = 0;

    for (const plan of strategyPlans) {
        for (const params of plan.paramSets) {

            // Resolve trade direction for evaluator (only accept simple values)
            const rawDir = settings.tradeDirection ?? 'both';
            const evalDirection: 'long' | 'short' | 'both' = (rawDir === 'long' || rawDir === 'short') ? rawDir : 'both';

            const evalResult = evaluatePolymarketOutcomes(
                closedData,
                plan.strategy,
                params,
                outcomes,
                {
                    executionMode: 'next_open',
                    tradeDirection: evalDirection,
                    strategyKey: plan.key,
                }
            );

            // Apply trade filter (reinterpreted as prediction count filter)
            if (options.tradeFilterEnabled) {
                if (evalResult.predictionsTaken < options.minTrades) {
                    processedCount++;
                    continue;
                }
                if (evalResult.predictionsTaken > options.maxTrades) {
                    processedCount++;
                    continue;
                }
            }

            // Build neutral BacktestResult placeholder
            const neutralResult = buildNeutralBacktestResult(evalResult);
            const finderResult: FinderResult = buildFinderResult({
                key: plan.key,
                name: plan.name,
                params,
                result: neutralResult,
                selectionResult: neutralResult,
                endpointAdjusted: false,
                endpointRemovedTrades: 0,
            });
            finderResult.polymarketEval = evalResult;

            filteredCount++;
            ranker.offer(finderResult);

            processedCount++;
            const now = performance.now();
            if (now - lastUiUpdateAt > 250 || processedCount === totalRuns) {
                lastUiUpdateAt = now;
                const progress = 10 + (processedCount / totalRuns) * 85;
                callbacks.setProgress(progress, `${processedCount}/${totalRuns} evaluations`);
                callbacks.setStatus(`Evaluating ${processedCount}/${totalRuns} candidates (${filteredCount} matched)...`);
            }

            // Yield occasionally to keep UI responsive
            if (processedCount % 64 === 0 || processedCount === totalRuns) {
                await callbacks.yieldControl();
            }
        }
    }

    const results = ranker.toSortedArray(options.topN);
    callbacks.setProgress(100, `${totalRuns}/${totalRuns} evaluations`);
    const statusParts = [`${processedCount} evaluations`];
    if (options.tradeFilterEnabled) {
        statusParts.push(`${filteredCount} matched`);
    }
    statusParts.push(`${results.length} shown`);
    statusParts.push(`${outcomes.length} outcome rows`);
    callbacks.setStatus(`Complete. ${statusParts.join(', ')}.`);

    return { results };
}
