import { parseTimeToUnixSeconds } from './time-normalization';
import { applySignalPolarity, precomputeIndicators, runBacktest } from './strategies/index';
import { CAPITAL_DEFAULTS } from './backtest-settings-resolver';
import { evaluatePolymarketBacktestTrades } from './polymarket-trade-annotations';
import type { CapitalSettings } from './types/backtest';
import type { BacktestSettings, OHLCVData, Strategy, StrategyParams } from './types/strategies';
import type {
    PolymarketEvalOptions,
    PolymarketEvalResult,
    PolymarketOutcomeRow,
} from './types/polymarket-outcomes';

function barTimeToSec(bar: OHLCVData): number | null {
    return parseTimeToUnixSeconds(bar.time);
}

function resolvePolymarketCapitalSettings(
    capitalSettings?: Partial<CapitalSettings>
): CapitalSettings {
    return {
        initialCapital: Math.max(0, Number(capitalSettings?.initialCapital ?? CAPITAL_DEFAULTS.initialCapital) || CAPITAL_DEFAULTS.initialCapital),
        positionSize: Math.max(0, Number(capitalSettings?.positionSize ?? CAPITAL_DEFAULTS.positionSize) || CAPITAL_DEFAULTS.positionSize),
        commission: Math.max(0, Number(capitalSettings?.commission ?? CAPITAL_DEFAULTS.commission) || CAPITAL_DEFAULTS.commission),
        sizingMode: capitalSettings?.sizingMode ?? 'percent',
        fixedTradeAmount: Math.max(0, Number(capitalSettings?.fixedTradeAmount ?? CAPITAL_DEFAULTS.fixedTradeAmount) || CAPITAL_DEFAULTS.fixedTradeAmount),
    };
}

function resolvePolymarketBacktestSettings(options: PolymarketEvalOptions): BacktestSettings {
    return {
        executionModel: options.executionMode ?? 'next_open',
        tradeDirection: options.tradeDirection ?? 'both',
        tradeFilterMode: 'none',
        marketMode: 'all',
        stopLossEnabled: false,
        takeProfitEnabled: false,
        allowSameBarExit: false,
        slippageBps: 0,
        invertSignals: false,
        maxOpenTrades: 1,
        warmUpEntryEnabled: false,
        ...(options.backtestSettings ?? {}),
    };
}

export function evaluatePolymarketOutcomes(
    chartData: OHLCVData[],
    strategy: Strategy,
    params: StrategyParams,
    outcomes: PolymarketOutcomeRow[],
    options: PolymarketEvalOptions = {}
): PolymarketEvalResult {
    const executionMode = options.executionMode ?? 'next_open';
    const strategyKey = options.strategyKey;

    if (executionMode !== 'next_open') {
        throw new Error(`evaluatePolymarketOutcomes: unsupported executionMode "${executionMode}". Only "next_open" is supported.`);
    }

    const effectiveSettings = resolvePolymarketBacktestSettings(options);
    const effectiveCapital = resolvePolymarketCapitalSettings(options.capitalSettings);
    const normalizedParams = strategy.normalizeParams ? strategy.normalizeParams(params) : { ...params };
    const rawSignals = options.usePreparedData && strategy.prepareFinderData && strategy.executePrepared
        ? strategy.executePrepared(strategy.prepareFinderData(chartData), normalizedParams, chartData)
        : strategy.execute(chartData, normalizedParams);
    const signals = applySignalPolarity(rawSignals, effectiveSettings);
    const precomputed = precomputeIndicators(chartData, effectiveSettings);
    const backtestResult = runBacktest(
        chartData,
        signals,
        effectiveCapital.initialCapital,
        effectiveCapital.positionSize,
        effectiveCapital.commission,
        effectiveSettings,
        {
            mode: effectiveCapital.sizingMode,
            fixedTradeAmount: effectiveCapital.fixedTradeAmount,
        },
        precomputed
    );

    const barTimes = chartData.map(barTimeToSec);
    const validTargetTs = new Set<number>();
    for (let i = 1; i < barTimes.length; i++) {
        const ts = barTimes[i];
        if (ts !== null) validTargetTs.add(ts);
    }

    let evaluatedEvents = 0;
    let resolvedUpCount = 0;
    for (const row of outcomes) {
        if (!validTargetTs.has(row.event_start_ts)) continue;
        evaluatedEvents++;
        resolvedUpCount += row.resolved_outcome_up;
    }

    const tradeEval = evaluatePolymarketBacktestTrades({
        chartData,
        trades: backtestResult.trades,
        outcomes,
        strategyKey,
        includeRows: true,
    });

    const ignoredSignals = Math.max(0, signals.length - backtestResult.totalTrades);

    return {
        ...tradeEval,
        evaluatedEvents,
        alwaysYesBaselineWinRate: evaluatedEvents > 0 ? resolvedUpCount / evaluatedEvents : 0,
        alwaysNoBaselineWinRate: evaluatedEvents > 0 ? (evaluatedEvents - resolvedUpCount) / evaluatedEvents : 0,
        ignoredSignals,
    };
}
