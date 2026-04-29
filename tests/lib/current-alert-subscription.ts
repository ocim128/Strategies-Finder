import { writeAdvancedSizingIntoRecord } from "./advanced-sizing-settings";
import {
    getBacktestSettings as readBacktestSettings,
    getCapitalSettings as readCapitalSettings,
} from "./backtest-settings-reader";
import { resolveCurrentConfigName } from "./alert-config-resolver";
import { buildAlertStreamId } from "./alert-service";
import { parseInputNumber } from "./dom-input-readers";
import { settingsManager } from "./settings-manager";
import { state } from "./state";

export interface CurrentAlertSubscriptionContext {
    symbol: string;
    interval: string;
    strategyKey: string;
    strategyParams: Record<string, number>;
    backtestSettings: Record<string, unknown>;
    configName: string | null;
    streamId: string;
}

export function collectCurrentAlertStrategyParams(): Record<string, number> {
    const strategyParams: Record<string, number> = {};
    if (typeof document === "undefined") {
        return strategyParams;
    }

    document.querySelectorAll<HTMLInputElement>('#settingsTab .param-input[data-param]').forEach((input) => {
        const key = input.dataset.param;
        if (!key) return;
        const parsed = parseInputNumber(input.value);
        strategyParams[key] = parsed ?? 0;
    });

    return strategyParams;
}

export function collectCurrentAlertSubscriptionBacktestSettings(): Record<string, unknown> {
    const settings = readBacktestSettings() as Record<string, unknown>;
    const uiSettings = settingsManager.getBacktestSettings();
    const capital = readCapitalSettings();
    const uiToggleSettings = Object.fromEntries(
        Object.entries(uiSettings).filter(
            ([key, value]) => key.endsWith('Toggle') && typeof value === 'boolean'
        )
    );

    const merged: Record<string, unknown> = {
        ...settings,
        ...uiToggleSettings,
        binanceMarketType: state.binanceMarketType,
        initialCapital: capital.initialCapital,
        positionSize: capital.positionSize,
        commission: capital.commission,
        sizingMode: capital.sizingMode,
        fixedTradeToggle: capital.sizingMode !== 'percent',
        fixedTradeAmount: capital.fixedTradeAmount,
    };

    writeAdvancedSizingIntoRecord(merged, capital.advancedSizing);
    return merged;
}

export function resolveCurrentAlertSubscriptionContext(): CurrentAlertSubscriptionContext | null {
    const symbol = state.currentSymbol.trim();
    const interval = state.currentInterval.trim();
    const strategyKey = state.currentStrategyKey.trim();
    if (!symbol || !interval || !strategyKey) {
        return null;
    }

    if (typeof document === "undefined") {
        const backtestSettings: Record<string, unknown> = {
            binanceMarketType: state.binanceMarketType,
        };
        return {
            symbol,
            interval,
            strategyKey,
            strategyParams: {},
            backtestSettings,
            configName: null,
            streamId: buildAlertStreamId(symbol, interval, strategyKey),
        };
    }

    const strategyParams = collectCurrentAlertStrategyParams();
    const backtestSettings = collectCurrentAlertSubscriptionBacktestSettings();
    const configName = resolveCurrentConfigName(strategyKey, strategyParams, backtestSettings);

    return {
        symbol,
        interval,
        strategyKey,
        strategyParams,
        backtestSettings,
        configName,
        streamId: buildAlertStreamId(symbol, interval, strategyKey, configName ?? undefined),
    };
}
