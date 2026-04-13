import { getOptionalElement } from "./dom-utils";
import {
    BACKTEST_DOM_SETTING_IDS,
    CAPITAL_DEFAULTS,
    EFFECTIVE_BACKTEST_DEFAULTS,
    resolveBacktestSettingsFromRaw,
} from "./backtest-settings-resolver";
import { readNumberInputValue } from "./dom-input-readers";
import { ADVANCED_SIZING_DOM_IDS, ADVANCED_SIZING_FIELD_IDS } from "./advanced-sizing-dom";
import {
    resolveCapitalSettingsFromRaw,
    SUBSCRIPTION_CAPITAL_LEGACY_DEFAULTS,
} from "./backtest-capital-settings";
import type { CapitalSettings } from "./types/backtest";
import type { BacktestSettings } from "./strategies/index";

export function readDomSettingValue(id: string): unknown {
    const element = getOptionalElement<HTMLElement>(id);
    if (!element) return undefined;
    if (element instanceof HTMLInputElement) {
        if (element.type === 'checkbox' || element.type === 'radio') {
            return element.checked;
        }
        return element.value;
    }
    if (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
        return element.value;
    }
    return undefined;
}

export function getCapitalSettings(): CapitalSettings {
    const fixedTradeToggle = getOptionalElement<HTMLInputElement>('fixedTradeToggle');
    const tradeSizingMode = getOptionalElement<HTMLSelectElement>('tradeSizingMode');
    const raw: Record<string, unknown> = {
        initialCapital: readNumberInputValue('initialCapital', CAPITAL_DEFAULTS.initialCapital),
        positionSize: readNumberInputValue('positionSize', CAPITAL_DEFAULTS.positionSize),
        commission: readNumberInputValue('commission', CAPITAL_DEFAULTS.commission),
        fixedTradeAmount: readNumberInputValue('fixedTradeAmount', CAPITAL_DEFAULTS.fixedTradeAmount),
        fixedTradeToggle: fixedTradeToggle?.checked,
        sizingMode: tradeSizingMode?.value,
    };

    for (const key of ADVANCED_SIZING_FIELD_IDS) {
        const element = getOptionalElement<HTMLInputElement | HTMLSelectElement>(ADVANCED_SIZING_DOM_IDS[key]);
        if (!element) continue;
        raw[key] = element instanceof HTMLInputElement && element.type === "checkbox"
            ? element.checked
            : element.value;
    }

    return resolveCapitalSettingsFromRaw(raw);
}

export function getBacktestSettings(): BacktestSettings {
    const raw: Record<string, unknown> = {};
    for (const id of BACKTEST_DOM_SETTING_IDS) {
        const value = readDomSettingValue(id);
        if (value !== undefined) {
            raw[id] = value;
        }
    }

    const settings = resolveBacktestSettingsFromRaw(raw as BacktestSettings, {
        coerceWithoutUiToggles: false,
    });

    settings.tradeDirection = settings.tradeDirection ?? EFFECTIVE_BACKTEST_DEFAULTS.tradeDirection;
    settings.executionModel = settings.executionModel ?? EFFECTIVE_BACKTEST_DEFAULTS.executionModel;
    return settings;
}

export function resolveSubscriptionCapitalSettings(backtestSettings: BacktestSettings): CapitalSettings {
    const raw = backtestSettings as Record<string, unknown>;
    return resolveCapitalSettingsFromRaw(raw, SUBSCRIPTION_CAPITAL_LEGACY_DEFAULTS);
}
