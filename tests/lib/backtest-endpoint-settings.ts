import { RUST_UNSUPPORTED_BACKTEST_SETTING_KEYS } from "./rust-settings-sanitizer";
import { BacktestSettings } from "./types/strategies";

const ENDPOINT_ALLOWED_UNSUPPORTED_BACKTEST_SETTING_KEYS = new Set<string>([
    "polymarketOutcomeSymbol",
]);

export const ENDPOINT_IGNORED_BACKTEST_SETTING_KEYS = [
    ...RUST_UNSUPPORTED_BACKTEST_SETTING_KEYS.filter((key) => !ENDPOINT_ALLOWED_UNSUPPORTED_BACKTEST_SETTING_KEYS.has(key)),
] as const;

const ENDPOINT_IGNORED_BACKTEST_SETTING_KEY_SET = new Set<string>(ENDPOINT_IGNORED_BACKTEST_SETTING_KEYS);

export function stripEndpointIgnoredBacktestSettings(
    settings: BacktestSettings | Record<string, unknown> | null | undefined
): Record<string, unknown> {
    const source = settings ?? {};
    return Object.fromEntries(
        Object.entries(source).filter(([key]) => !ENDPOINT_IGNORED_BACKTEST_SETTING_KEY_SET.has(key))
    );
}
