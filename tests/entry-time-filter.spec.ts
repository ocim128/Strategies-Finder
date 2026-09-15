import { expect } from "chai";
import { describe, it } from "node:test";
import { isEntryBarAllowed } from "../lib/entry-time-filter";
import { resolveBacktestSettingsFromRaw } from "../lib/backtest-settings-resolver";
import { requiresTypescriptEngine, sanitizeBacktestSettingsForRust } from "../lib/rust-settings-sanitizer";
import { runBacktest, runBacktestCompact } from "../lib/strategies/index";
import type { BacktestSettings, OHLCVData, Signal, Time } from "../lib/strategies/index";

const data: OHLCVData[] = [
    { time: "2024-01-02T12:00:00Z" as Time, open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { time: "2024-01-02T16:00:00Z" as Time, open: 100, high: 102, low: 99, close: 101, volume: 1 },
    { time: "2024-01-03T12:00:00Z" as Time, open: 101, high: 103, low: 100, close: 102, volume: 1 },
    { time: "2024-01-03T16:00:00Z" as Time, open: 102, high: 104, low: 101, close: 103, volume: 1 },
];

function signal(index: number, type: Signal["type"]): Signal {
    return { time: data[index]!.time, type, price: data[index]!.close };
}

describe("entry time filter", () => {
    it("treats the two 4H bars as daily opening and closing bars", () => {
        expect(data.map((_bar, index) => isEntryBarAllowed(data, index, "day_open"))).to.deep.equal([
            true, false, true, false,
        ]);
        expect(data.map((_bar, index) => isEntryBarAllowed(data, index, "day_close"))).to.deep.equal([
            false, true, false, true,
        ]);
    });

    it("filters the actual fill bar while leaving exits available", () => {
        const cases: Array<{
            filter: "day_open" | "day_close";
            signals: Signal[];
            expectedEntryIndex: number;
        }> = [
            {
                filter: "day_open",
                signals: [signal(1, "buy"), signal(2, "sell")],
                expectedEntryIndex: 2,
            },
            {
                filter: "day_close",
                signals: [signal(0, "buy"), signal(1, "sell")],
                expectedEntryIndex: 1,
            },
        ];

        for (const testCase of cases) {
            const settings: BacktestSettings = {
                tradeDirection: "long",
                executionModel: "next_open",
                entryTimeFilterEnabled: true,
                entryTimeFilter: testCase.filter,
            };
            const options = { requireTradeHistory: true } as const;
            const full = runBacktest(data, testCase.signals, 1000, 100, 0, settings, undefined, undefined, options);
            const compact = runBacktestCompact(data, testCase.signals, 1000, 100, 0, settings, undefined, undefined, options);

            expect(full.trades).to.have.length(1);
            expect(compact.trades).to.have.length(1);
            expect(full.trades[0]!.entryTime).to.equal(data[testCase.expectedEntryIndex]!.time);
            expect(compact.trades[0]!.entryTime).to.equal(data[testCase.expectedEntryIndex]!.time);
            expect(compact.totalTrades).to.equal(full.totalTrades);
        }
    });

    it("normalizes the UI setting and keeps it on TypeScript", () => {
        const resolved = resolveBacktestSettingsFromRaw({
            riskSettingsToggle: true,
            riskEntryTimeFilterToggle: true,
            riskEntryTimeFilter: "day_close",
        } as BacktestSettings);

        expect(resolved.entryTimeFilterEnabled).to.equal(true);
        expect(resolved.entryTimeFilter).to.equal("day_close");
        expect(requiresTypescriptEngine(resolved)).to.equal(true);
        expect("entryTimeFilterEnabled" in sanitizeBacktestSettingsForRust(resolved)).to.equal(false);
        expect("entryTimeFilter" in sanitizeBacktestSettingsForRust(resolved)).to.equal(false);
    });
});
