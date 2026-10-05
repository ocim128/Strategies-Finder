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

    it('keeps override exits available on a forbidden entry bar with next-open slippage', () => {
        const signals: Signal[] = [signal(0, 'buy'),
            { ...signal(1, 'sell'), exitOnly: true }, signal(1, 'buy')];
        const settings: BacktestSettings = { executionModel: 'next_open', tradeDirection: 'long',
            entryTimeFilterEnabled: true, entryTimeFilter: 'day_close', disableSignalExits: true,
            exitStrategyOverrideEnabled: true, exitStrategyKey: 'short_term_overextension_fade', slippageBps: 2 };
        for (const engine of [runBacktest, runBacktestCompact]) {
            const result = engine(data, signals, 1000, 100, 0, settings, undefined, undefined,
                { omitEquityCurve: true, includeSharpeRatio: false, requireTradeHistory: true, collectDiagnostics: true });
            expect(result.diagnostics?.fastPath?.used).to.equal(true);
            expect(result.trades).to.have.length(1);
            expect(result.trades[0].entryTime).to.equal(data[1].time);
            expect(result.trades[0].exitTime).to.equal(data[2].time);
            expect(result.trades[0].exitReason).to.equal('signal');
        }
    });

    it('uses the actual sparse exit bar when arming an entry cooldown', () => {
        const candles = Array.from({ length: 12 }, (_, i) => ({ ...data[i % data.length],
            time: (Date.UTC(2024, 0, 2 + i) / 1000) as Time }));
        const signals: Signal[] = [0, 2, 3, 7].map((i, order) => ({ time: candles[i].time,
            barIndex: i, price: candles[i].close, type: order === 1 ? 'sell' : 'buy' }));
        const settings: BacktestSettings = { executionModel: 'next_open', entryTimeFilterEnabled: true,
            entryTimeFilter: 'day_open', riskCooldownEnabled: true, riskCooldownBars: 3 };
        const full = runBacktest(candles, signals, 1000, 100, 0, settings);
        const sparse = runBacktestCompact(candles, signals, 1000, 100, 0, settings, undefined, undefined,
            { omitEquityCurve: true, includeSharpeRatio: false, skipDrawdown: true, requireTradeHistory: true });
        expect(full.trades.map(trade => trade.entryTime)).to.deep.equal([candles[1].time, candles[8].time]);
        expect(sparse.trades).to.deep.equal(full.trades);
    });

    for (const executionModel of ['signal_close', 'next_open', 'next_close'] as const) {
        for (const tradeDirection of ['long', 'short', 'both'] as const) {
            for (const filter of ['day_open', 'day_close'] as const) {
                it(`preserves filtered fills and unfiltered exits on the fast path: ${tradeDirection}/${executionModel}/${filter}`, () => {
                    const candles: OHLCVData[] = Array.from({ length: 36 }, (_, i) => ({
                        time: (Date.UTC(2024, 0, 2) / 1000 + i * 14400) as Time,
                        open: 100 + i % 7, close: 101 + i % 7,
                        high: 103 + i % 7, low: 99 + i % 7, volume: 1,
                    }));
                    // Dense signals exercise fills, flips and exits on forbidden entry bars.
                    const signals: Signal[] = candles.map((bar, i) => ({
                        time: bar.time, price: bar.close, barIndex: i,
                        type: Math.floor(i / 2) % 2 === 0 ? 'buy' : 'sell',
                        ...(i % 9 === 0 ? { sizeFraction: 0.5 } : {}),
                        ...(i % 11 === 0 ? { exitOnly: true } : {}),
                    }));
                    const settings: BacktestSettings = { executionModel, tradeDirection,
                        entryTimeFilterEnabled: true, entryTimeFilter: filter, slippageBps: 2,
                        riskMinHoldEnabled: true, riskMinHoldBars: 1 };
                    const sizing = { mode: 'fixed' as const, fixedTradeAmount: 1000 };
                    const reference = runBacktest(candles, signals, 10000, 100, 0.1, settings, sizing,
                        undefined, { includeAdvancedAnalytics: false });
                    expect(reference.trades.length).to.be.greaterThan(0);
                    for (const indexed of [false, true]) {
                        const inputSignals = indexed ? signals : signals.map(({ barIndex: _index, ...signal }) => signal);
                        for (const engine of [runBacktest, runBacktestCompact]) {
                            const actual = engine(candles, inputSignals, 10000, 100, 0.1, settings, sizing,
                                undefined, { omitEquityCurve: true, requireTradeHistory: true,
                                    includeAdvancedAnalytics: false, collectDiagnostics: true });
                            expect(actual.diagnostics?.fastPath?.used).to.equal(true);
                            expect(actual.diagnostics?.fastPath?.signalPreparation).to.equal(indexed ? 'indexed' : 'objects');
                            expect(actual.trades).to.deep.equal(reference.trades);
                            for (const key of ['netProfit', 'expectancy', 'profitFactor', 'maxDrawdown', 'maxDrawdownPercent', 'sharpeRatio'] as const) {
                                if (Number.isFinite(reference[key])) expect(actual[key], key).to.be.closeTo(reference[key], 1e-9);
                                else expect(actual[key], key).to.equal(reference[key]);
                            }
                        }
                    }
                    const sparse = runBacktestCompact(candles, signals, 10000, 100, 0.1, settings, sizing,
                        undefined, { omitEquityCurve: true, skipDrawdown: true, includeSharpeRatio: false,
                            requireTradeHistory: true, collectDiagnostics: true });
                    expect(sparse.diagnostics?.fastPath?.used).to.equal(true);
                    expect(sparse.trades).to.deep.equal(reference.trades);
                });
            }
        }
    }
});
