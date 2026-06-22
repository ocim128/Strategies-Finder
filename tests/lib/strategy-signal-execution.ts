import type {
    BacktestSettings,
    OHLCVData,
    Signal,
    Strategy,
    StrategyExecutionContext,
    StrategyParams,
} from "./types/strategies";
import { applySignalPolarity } from "./strategies/index";
import { resampleOHLCV, type ResampleOptions } from "./strategies/resample-utils";
import { toNumericTimeData, mapSignalsFromHigherTimeframe } from "./strategy-timeframe";
import { executeStrategyWithTimeGapIsolation } from "./strategy-time-gap-isolation";

type StrategyTimeframeConfig = {
    enabled: boolean;
    interval: string;
    resampleOptions?: ResampleOptions;
};

function readStrategyTimeframeConfig(settings: BacktestSettings): StrategyTimeframeConfig {
    const enabled = settings.strategyTimeframeEnabled === true;
    const parsedMinutes = Number(settings.strategyTimeframeMinutes);
    const minutes = Number.isFinite(parsedMinutes) && parsedMinutes > 0
        ? Math.max(1, Math.floor(parsedMinutes))
        : 120;
    const interval = `${minutes}m`;
    const resampleOptions: ResampleOptions | undefined = undefined;
    return { enabled, interval, resampleOptions };
}

function executeDirectStrategySignals(
    data: OHLCVData[],
    interval: string,
    strategy: Strategy,
    params: StrategyParams,
    context?: StrategyExecutionContext
): Signal[] {
    return executeStrategyWithTimeGapIsolation({
        data,
        interval,
        executionContext: context,
        execute: (segmentData, segmentContext) => strategy.execute(segmentData, params, segmentContext),
    });
}

export function executeBacktestStrategySignals(args: {
    data: OHLCVData[];
    interval: string;
    strategy: Strategy;
    params: StrategyParams;
    settings: BacktestSettings;
    strategyAlreadyWrapped?: boolean;
    executionContext?: StrategyExecutionContext;
}): Signal[] {
    const {
        data,
        interval,
        strategy,
        params,
        settings,
        strategyAlreadyWrapped = false,
        executionContext,
    } = args;

    if (strategyAlreadyWrapped) {
        const signals = executeDirectStrategySignals(data, interval, strategy, params, executionContext);
        return applySignalPolarity(signals, settings);
    }

    const tfConfig = readStrategyTimeframeConfig(settings);
    if (!tfConfig.enabled || data.length === 0) {
        const signals = executeDirectStrategySignals(data, interval, strategy, params, executionContext);
        return applySignalPolarity(signals, settings);
    }

    const numericData = toNumericTimeData(data);
    if (!numericData) {
        const signals = executeDirectStrategySignals(data, interval, strategy, params, executionContext);
        return applySignalPolarity(signals, settings);
    }

    const higherData = resampleOHLCV(numericData, tfConfig.interval, tfConfig.resampleOptions);
    if (higherData.length === 0) {
        return [];
    }

    const higherSignals = strategy.execute(higherData, params, executionContext);
    const mappedSignals = mapSignalsFromHigherTimeframe(
        data,
        numericData,
        higherData,
        higherSignals,
        tfConfig.interval,
        tfConfig.resampleOptions
    );
    return applySignalPolarity(mappedSignals, settings);
}
