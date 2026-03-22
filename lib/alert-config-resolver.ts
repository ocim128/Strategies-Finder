import { AlertSubscription, parseAlertConfigNameFromStreamId } from "./alert-service";
import { getOptionalElement } from "./dom-utils";
import { settingsManager } from "./settings-manager";

export type SavedConfig = {
    name: string;
    strategyKey: string;
    strategyParams: unknown;
    backtestSettings: unknown;
};

export type ConfigIndexEntry = {
    name: string;
    strategyKey: string;
    paramsKey: string;
    settingsKey: string;
};

export function safeJsonParse<T>(raw: string, fallback: T): T {
    try {
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

function stableNormalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableNormalize);
    if (value && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, stableNormalize(item)]);
        return Object.fromEntries(entries);
    }
    return value;
}

export function stableStringify(value: unknown): string {
    return JSON.stringify(stableNormalize(value));
}

export function resolveCurrentConfigName(
    strategyKey: string,
    strategyParams: Record<string, number>,
    backtestSettings: unknown
): string | null {
    const targetParams = stableStringify(strategyParams);
    const targetSettings = stableStringify(backtestSettings);
    const matches = (config: { strategyKey: string; strategyParams: unknown; backtestSettings: unknown }): boolean =>
        config.strategyKey === strategyKey
        && stableStringify(config.strategyParams) === targetParams
        && stableStringify(config.backtestSettings) === targetSettings;

    const configSelect = getOptionalElement<HTMLSelectElement>("configSelect");
    const selected = configSelect?.value?.trim();
    const allConfigs = settingsManager.loadAllStrategyConfigs();

    if (selected) {
        const selectedConfig = allConfigs.find((config) => config.name === selected);
        if (selectedConfig && matches(selectedConfig)) {
            return selectedConfig.name;
        }
    }

    const matched = allConfigs.find(matches);
    return matched?.name ?? null;
}

export function buildConfigIndex(savedConfigs: SavedConfig[]): ConfigIndexEntry[] {
    return savedConfigs.map((config) => ({
        name: config.name,
        strategyKey: config.strategyKey,
        paramsKey: stableStringify(config.strategyParams),
        settingsKey: stableStringify(config.backtestSettings),
    }));
}

export function resolveSubscriptionConfigNameFromIndex(
    sub: AlertSubscription,
    configIndex: ConfigIndexEntry[]
): string | null {
    const parsedFromStreamId = parseAlertConfigNameFromStreamId(sub.stream_id);
    if (parsedFromStreamId) return parsedFromStreamId;

    const subParams = safeJsonParse<unknown>(sub.strategy_params_json, {});
    const subSettings = safeJsonParse<unknown>(sub.backtest_settings_json, {});
    const subParamsKey = stableStringify(subParams);
    const subSettingsKey = stableStringify(subSettings);

    const matched = configIndex.find((config) =>
        config.strategyKey === sub.strategy_key
        && config.paramsKey === subParamsKey
        && config.settingsKey === subSettingsKey
    );

    return matched?.name ?? null;
}

export function resolveSubscriptionConfigName(
    sub: AlertSubscription,
    savedConfigs: SavedConfig[]
): string | null {
    const configIndex = buildConfigIndex(savedConfigs);
    return resolveSubscriptionConfigNameFromIndex(sub, configIndex);
}
