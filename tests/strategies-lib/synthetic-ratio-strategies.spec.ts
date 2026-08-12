import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Strategy, StrategyParams, Time } from "../../lib/types/strategies";
import { body_proportion_percentile_fade } from "../../lib/strategies/lib/body_proportion_percentile_fade";
import { cumulative_return_percentile_reversion } from "../../lib/strategies/lib/cumulative_return_percentile_reversion";
import { return_sign_streak_fade } from "../../lib/strategies/lib/return_sign_streak_fade";

type StrategySmokeCase = {
    key: string;
    strategy: Strategy;
    input: Record<string, string>;
    expected: Record<string, number>;
};

// Only the strategies that survived the 89-candidate cull (43caa6d "new lib")
// remain; culled candidates were removed from the manifest and their smoke
// cases deleted with them.
const CASES: StrategySmokeCase[] = [
    { key: "return_sign_streak_fade", strategy: return_sign_streak_fade, input: { lookback: "3.2", streakMin: "4.7" }, expected: { lookback: 3, streakMin: 5 } },
    { key: "cumulative_return_percentile_reversion", strategy: cumulative_return_percentile_reversion, input: { lookback: "20.1", pctlExtreme: "0.95" }, expected: { lookback: 20, pctlExtreme: 0.95 } },
    { key: "body_proportion_percentile_fade", strategy: body_proportion_percentile_fade, input: { lookback: "25", pctlExtreme: "0.80" }, expected: { lookback: 25, pctlExtreme: 0.8 } },
];

function generateMockData(length = 120): OHLCVData[] {
    const data: OHLCVData[] = [];
    let price = 100;
    for (let i = 0; i < length; i += 1) {
        const change = Math.sin(i * 0.5) * 2 + (i % 15 === 0 ? 5 : 0) - (i % 20 === 0 ? 6 : 0);
        const open = price;
        const close = price + change;
        data.push({
            time: (1_700_000_000 + i * 3600) as Time,
            open,
            high: Math.max(open, close) + 0.5,
            low: Math.min(open, close) - 0.5,
            close,
            volume: 100 + (i % 10) * 10,
        });
        price = close;
    }
    return data;
}

function normalize(strategy: Strategy, input: Record<string, string>): StrategyParams {
    if (!strategy.normalizeParams) {
        throw new Error(`${strategy.name} has no normalizeParams`);
    }
    return strategy.normalizeParams(input as unknown as StrategyParams);
}

describe("Synthetic Ratio Strategies Smoke Tests", () => {
    const data = generateMockData();

    for (const testCase of CASES) {
        it(`${testCase.key} executes and normalizes`, () => {
            expect(testCase.strategy.execute(data, testCase.strategy.defaultParams)).to.be.an("array");
            const normalized = normalize(testCase.strategy, testCase.input);
            for (const [key, expected] of Object.entries(testCase.expected)) {
                expect(normalized[key], `${testCase.key}.${key}`).to.equal(expected);
            }
        });
    }
});
