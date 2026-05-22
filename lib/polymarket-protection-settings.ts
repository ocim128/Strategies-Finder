import { parseInputNumber } from "./dom-input-readers";
import { readBoolean, readNumber } from "./settings-parse-utils";

export const DEFAULT_POLYMARKET_PROTECTION_TAKE_PROFIT_ENABLED = false;
export const DEFAULT_POLYMARKET_PROTECTION_TAKE_PROFIT_CENTS = 20;
export const DEFAULT_POLYMARKET_PROTECTION_STOP_LOSS_ENABLED = false;
export const DEFAULT_POLYMARKET_PROTECTION_STOP_LOSS_CENTS = 20;

export type PolymarketProtectionSettingFields = {
    polymarketProtectionTakeProfitEnabled: boolean;
    polymarketProtectionTakeProfitCents: number;
    polymarketProtectionStopLossEnabled: boolean;
    polymarketProtectionStopLossCents: number;
};

export function clampPolymarketProtectionCents(value: unknown, fallback = DEFAULT_POLYMARKET_PROTECTION_TAKE_PROFIT_CENTS): number {
    const parsed = readNumber(value, fallback, { parseString: parseInputNumber });
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.min(99, Math.round(parsed * 10) / 10));
}

export function resolvePolymarketProtectionSettingFields(
    raw: Record<string, unknown>,
    readBooleanSetting: (key: string, fallback: boolean) => boolean = (key, fallback) => readBoolean(raw[key], fallback)
): PolymarketProtectionSettingFields {
    return {
        polymarketProtectionTakeProfitEnabled: readBooleanSetting(
            "polymarketProtectionTakeProfitEnabled",
            DEFAULT_POLYMARKET_PROTECTION_TAKE_PROFIT_ENABLED
        ),
        polymarketProtectionTakeProfitCents: clampPolymarketProtectionCents(
            raw["polymarketProtectionTakeProfitCents"],
            DEFAULT_POLYMARKET_PROTECTION_TAKE_PROFIT_CENTS
        ),
        polymarketProtectionStopLossEnabled: readBooleanSetting(
            "polymarketProtectionStopLossEnabled",
            DEFAULT_POLYMARKET_PROTECTION_STOP_LOSS_ENABLED
        ),
        polymarketProtectionStopLossCents: clampPolymarketProtectionCents(
            raw["polymarketProtectionStopLossCents"],
            DEFAULT_POLYMARKET_PROTECTION_STOP_LOSS_CENTS
        ),
    };
}

export function hasActivePolymarketProtection(settings: Partial<PolymarketProtectionSettingFields>): boolean {
    const takeProfitCents = clampPolymarketProtectionCents(
        settings.polymarketProtectionTakeProfitCents,
        DEFAULT_POLYMARKET_PROTECTION_TAKE_PROFIT_CENTS
    );
    const stopLossCents = clampPolymarketProtectionCents(
        settings.polymarketProtectionStopLossCents,
        DEFAULT_POLYMARKET_PROTECTION_STOP_LOSS_CENTS
    );
    return (
        settings.polymarketProtectionTakeProfitEnabled === true
        && takeProfitCents > 0
    ) || (
        settings.polymarketProtectionStopLossEnabled === true
        && stopLossCents > 0
    );
}
