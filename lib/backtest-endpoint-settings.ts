import { SNAPSHOT_CONFIGS } from "./backtest-settings-resolver";
import { SNAPSHOT_FILTER_SETTING_KEYS } from "./rust-settings-sanitizer";
import type { BacktestSettings } from "./types/strategies";

const ENDPOINT_IGNORED_SNAPSHOT_TOGGLE_KEYS = SNAPSHOT_CONFIGS.map((snapshot) => snapshot.toggleKey);

export const ENDPOINT_IGNORED_BACKTEST_SETTING_KEYS = [
    "captureSnapshots",
    ...ENDPOINT_IGNORED_SNAPSHOT_TOGGLE_KEYS,
    ...SNAPSHOT_FILTER_SETTING_KEYS,
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
