import type { CapitalSettings } from "../../lib/types/backtest";
import type { BacktestSettings } from "../../lib/types/strategies";

export function makeBacktestSettings(overrides: BacktestSettings = {}): BacktestSettings {
    return { tradeDirection: "long", slippageBps: 0, ...overrides } satisfies BacktestSettings;
}

export function makeCapitalSettings(overrides: Partial<CapitalSettings> = {}): CapitalSettings {
    return {
        initialCapital: 10_000,
        positionSize: 100,
        commission: 0,
        sizingMode: "percent",
        fixedTradeAmount: 1_000,
        ...overrides,
    } satisfies CapitalSettings;
}
