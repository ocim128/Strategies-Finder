import { applySignalPolarity, precomputeIndicators, runBacktest } from './strategies/index';
import { CAPITAL_DEFAULTS } from './backtest-settings-resolver';
import { applyConfirmationStrategiesToSignals } from './confirmation-signal-filter';
import {
    createPolymarketBridgeEvaluationContext,
    createPolymarketTradeEvaluationContext,
    evaluatePolymarketBacktestTrades,
    evaluatePolymarketBacktestTrades1mBridge,
} from './polymarket-trade-annotations';
import { resolveCapitalSettingsFromRaw } from './backtest-capital-settings';
import type { CapitalSettings } from './types/backtest';
import type { BacktestSettings, OHLCVData, Strategy, StrategyExecutionContext, StrategyParams } from './types/strategies';
import type {
    PolymarketEvalOptions,
    PolymarketEvalResult,
    PolymarketOutcomeRow,
} from './types/polymarket-outcomes';

function resolvePolymarketCapitalSettings(
    capitalSettings?: Partial<CapitalSettings>
): CapitalSettings {
    return resolveCapitalSettingsFromRaw({
        ...capitalSettings,
        fixedTradeToggle: capitalSettings?.sizingMode && capitalSettings.sizingMode !== "percent",
    }, {
        initialCapital: CAPITAL_DEFAULTS.initialCapital,
        positionSize: CAPITAL_DEFAULTS.positionSize,
        commission: CAPITAL_DEFAULTS.commission,
        fixedTradeAmount: CAPITAL_DEFAULTS.fixedTradeAmount,
        sizingMode: "percent",
    });
}

function resolvePolymarketBacktestSettings(options: PolymarketEvalOptions): BacktestSettings {
    return {
        executionModel: options.executionMode ?? 'next_open',
        tradeDirection: options.tradeDirection ?? 'both',
        marketMode: 'all',
        stopLossEnabled: false,
        takeProfitEnabled: false,
        allowSameBarExit: false,
        slippageBps: 0,
        invertSignals: false,
        maxOpenTrades: 1,
        ...(options.backtestSettings ?? {}),
    };
}

export interface PolymarketEvalOptions1mBridge extends PolymarketEvalOptions {
    /** Entry offset minute (0..4) for 1m -> 5m bridge evaluation */
    entryOffset?: number;
}

export function evaluatePolymarketOutcomes(
    chartData: OHLCVData[],
    strategy: Strategy,
    params: StrategyParams,
    outcomes: PolymarketOutcomeRow[],
    options: PolymarketEvalOptions = {},
    executionContext?: StrategyExecutionContext
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
        ? strategy.executePrepared(strategy.prepareFinderData(chartData, undefined, executionContext), normalizedParams, chartData, executionContext)
        : strategy.execute(chartData, normalizedParams, executionContext);
    const signals = applyConfirmationStrategiesToSignals({
        data: chartData,
        baseSignals: applySignalPolarity(rawSignals, effectiveSettings),
        settings: effectiveSettings,
    });
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
            advancedSizing: effectiveCapital.advancedSizing,
        },
        precomputed
    );

    const bridgeOptions = options as PolymarketEvalOptions1mBridge;
    const ignoredSignals = Math.max(0, signals.length - backtestResult.totalTrades);
    const entryOffset = bridgeOptions.entryOffset;

    if (entryOffset !== undefined) {
        const context = createPolymarketBridgeEvaluationContext(chartData, outcomes);
        const tradeEval = evaluatePolymarketBacktestTrades1mBridge({
            chartData,
            trades: backtestResult.trades,
            outcomes,
            strategyKey,
            selectedOffset: entryOffset,
            includeRows: true,
            context,
            entryPriceFilterCents: options.entryPriceFilterCents,
            backtestSlippageCents: options.backtestSlippageCents,
        });

        return {
            ...tradeEval,
            evaluatedEvents: context.evaluatedEvents,
            alwaysYesBaselineWinRate: context.evaluatedEvents > 0 ? context.resolvedUpCount / context.evaluatedEvents : 0,
            alwaysNoBaselineWinRate: context.evaluatedEvents > 0 ? (context.evaluatedEvents - context.resolvedUpCount) / context.evaluatedEvents : 0,
            ignoredSignals,
        };
    }

    const context = createPolymarketTradeEvaluationContext(chartData, outcomes);
    const tradeEval = evaluatePolymarketBacktestTrades({
        chartData,
        trades: backtestResult.trades,
        outcomes,
        strategyKey,
        includeRows: true,
        context,
        entryPriceFilterCents: options.entryPriceFilterCents,
        backtestSlippageCents: options.backtestSlippageCents,
    });

    return {
        ...tradeEval,
        evaluatedEvents: context.evaluatedEvents,
        alwaysYesBaselineWinRate: context.evaluatedEvents > 0 ? context.resolvedUpCount / context.evaluatedEvents : 0,
        alwaysNoBaselineWinRate: context.evaluatedEvents > 0 ? (context.evaluatedEvents - context.resolvedUpCount) / context.evaluatedEvents : 0,
        ignoredSignals,
    };
}
