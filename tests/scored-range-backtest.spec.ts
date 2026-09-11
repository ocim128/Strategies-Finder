import { expect } from "chai";
import { describe, it } from "node:test";
import { runBacktest, runBacktestCompact } from "../lib/strategies/backtest/backtest-engine";
import { executeBacktest } from "../lib/backtest-executor";
import type { OHLCVData, Signal } from "../lib/types/strategies";

// Deterministic 40-bar hourly series. Uptrend so a long entry gains and a
// short entry loses; a mild pullback near the end keeps terminal closes
// distinct from the highs.
const BAR_COUNT = 40;
const BASE_TIME = 1_700_000_000; // unix seconds; 1h bars

function buildData(): OHLCVData[] {
    const data: OHLCVData[] = [];
    for (let i = 0; i < BAR_COUNT; i += 1) {
        const drift = 100 + i * 1 + (i > 34 ? -2 * (i - 34) : 0);
        const open = drift;
        const close = drift + 0.5;
        data.push({
            time: (BASE_TIME + i * 3600) as OHLCVData["time"],
            open,
            high: Math.max(open, close) + 1,
            low: Math.min(open, close) - 1,
            close,
            volume: 1000,
        });
    }
    return data;
}

function signalAt(barIndex: number, type: Signal["type"]): Signal {
    return { barIndex, time: (BASE_TIME + barIndex * 3600) as Signal["time"], type, price: 0 };
}

function barTime(data: OHLCVData[], index: number): OHLCVData["time"] {
    return data[index]!.time;
}

const RANGE = { startIndex: 10, endIndex: 29 };
function scoredRange(data: OHLCVData[]) {
    return { startBarTime: barTime(data, RANGE.startIndex), endBarTime: barTime(data, RANGE.endIndex) };
}

const BASE_SETTINGS = {
    tradeDirection: "long" as const,
    executionModel: "next_open" as const,
    slippageBps: 0,
    maxOpenTrades: 1,
    // Off so a counter-direction signal can flip the position on the same
    // bar (the default 1-bar reentry cooldown would block it and obscure the
    // boundary behavior under test).
    riskCooldownEnabled: false,
};

function runScored(
    data: OHLCVData[],
    signals: Signal[],
    overrides: {
        settings?: Record<string, unknown>;
        tradeDirection?: "long" | "short" | "both";
        fixedTradeAmount?: number;
        initialCapital?: number;
        commissionPercent?: number;
    } = {},
) {
    return runBacktest(
        data,
        signals,
        overrides.initialCapital ?? 10_000,
        100,
        overrides.commissionPercent ?? 0,
        {
            ...BASE_SETTINGS,
            ...(overrides.tradeDirection ? { tradeDirection: overrides.tradeDirection } : {}),
            ...(overrides.settings ?? {}),
        } as Parameters<typeof runBacktest>[5],
        { mode: "fixed", fixedTradeAmount: overrides.fixedTradeAmount ?? 1_000 },
        undefined,
        { scoredRange: scoredRange(data), requireTradeHistory: true },
    );
}

describe("Scored-range execution contract", () => {
    it("excludes warmup signals entirely, including a signal on the last warmup bar under next_open", () => {
        const data = buildData();
        // Signal on the last warmup bar (9) would fill at bar 10 without a range.
        const boundary = runScored(data, [signalAt(9, "buy")]);
        expect(boundary.totalTrades).to.equal(0);
        expect(boundary.netProfit).to.equal(0);

        // Many warmup signals: none may enter the scored account.
        const warmupOnly = runScored(
            data,
            Array.from({ length: 10 }, (_, i) => signalAt(i, "buy" as const)),
        );
        expect(warmupOnly.totalTrades).to.equal(0);
    });

    it("admits a signal originating on scored bar 1 for signal_close and bar 2 for next_open/next_close", () => {
        const data = buildData();
        const inRange = { startBarTime: barTime(data, 10), endBarTime: barTime(data, 29) };

        const signalClose = runBacktest(
            data,
            [{ ...signalAt(10, "buy"), price: data[10]!.close }],
            10_000,
            100,
            0,
            { ...BASE_SETTINGS, executionModel: "signal_close" } as Parameters<typeof runBacktest>[5],
            { mode: "fixed", fixedTradeAmount: 1_000 },
            undefined,
            { scoredRange: inRange, requireTradeHistory: true },
        );
        expect(signalClose.trades.length).to.equal(1);
        expect(signalClose.trades[0]!.entryPrice).to.equal(data[10]!.close);
        // Terminal liquidation at the scored end close.
        expect(signalClose.trades[0]!.exitPrice).to.equal(data[29]!.close);

        const nextOpen = runScored(data, [signalAt(10, "buy")]);
        expect(nextOpen.trades.length).to.equal(1);
        expect(nextOpen.trades[0]!.entryPrice).to.equal(data[11]!.open);

        const nextClose = runBacktest(
            data,
            [signalAt(10, "buy")],
            10_000,
            100,
            0,
            { ...BASE_SETTINGS, executionModel: "next_close" } as Parameters<typeof runBacktest>[5],
            { mode: "fixed", fixedTradeAmount: 1_000 },
            undefined,
            { scoredRange: inRange, requireTradeHistory: true },
        );
        expect(nextClose.trades.length).to.equal(1);
        expect(nextClose.trades[0]!.entryPrice).to.equal(data[11]!.close);
    });

    it("never fills after the scored end: a next_open signal on the final scored bar is ignored", () => {
        const data = buildData();
        const atEnd = runScored(data, [signalAt(29, "buy")]);
        expect(atEnd.totalTrades).to.equal(0);
        // A signal on the bar before the end still fills at the end bar.
        const beforeEnd = runScored(data, [signalAt(28, "buy")]);
        expect(beforeEnd.trades.length).to.equal(1);
        expect(beforeEnd.trades[0]!.exitPrice).to.equal(data[29]!.close);
        expect(beforeEnd.trades[0]!.exitReason).to.equal("end_of_data");
    });

    it("keeps flat scored bars in the statistics: no in-range signals yields a zero return and full scored equity samples", () => {
        const data = buildData();
        const flat = runScored(data, [signalAt(5, "buy")]);
        expect(flat.totalTrades).to.equal(0);
        expect(flat.netProfit).to.equal(0);
        expect(flat.netProfitPercent).to.equal(0);
        expect(flat.equityCurve.length).to.equal(RANGE.endIndex - RANGE.startIndex + 1);
        expect(flat.equityCurve.every((point) => point.value === 10_000)).to.equal(true);
    });

    it("changes unscored account activity cannot affect scored results", () => {
        const data = buildData();
        const scoredSignals = [signalAt(12, "buy")];
        const quietWarmup = runScored(data, [...scoredSignals]);
        // A wildly profitable warmup trade (entered at 1, exited at 30).
        const busyWarmup = runScored(data, [
            signalAt(1, "buy"),
            { ...signalAt(30, "sell") },
            ...scoredSignals,
        ]);
        expect(quietWarmup.netProfit).to.equal(busyWarmup.netProfit);
        expect(quietWarmup.totalTrades).to.equal(busyWarmup.totalTrades);
        expect(quietWarmup.trades).to.deep.equal(busyWarmup.trades);
        expect(quietWarmup.equityCurve).to.deep.equal(busyWarmup.equityCurve);
    });

    it("applies direction-correct terminal slippage and commission at the scored end close", () => {
        const data = buildData();
        const entryBar = 12;
        const entry = runScored(data, [signalAt(entryBar, "buy")], { settings: { slippageBps: 100 } });
        expect(entry.trades.length).to.equal(1);
        const trade = entry.trades[0]!;
        // Terminal liquidation for a LONG is a SELL: price steps DOWN by 1%.
        expect(trade.exitPrice).to.equal(data[29]!.close * (1 - 0.01));
        // Entry fill also carries buy-side slippage.
        expect(trade.entryPrice).to.equal(data[13]!.open * (1 + 0.01));

        // Short liquidation is a BUY: price steps UP by 1%.
        const shortEntry = runScored(data, [signalAt(entryBar, "sell")], {
            tradeDirection: "short",
            settings: { slippageBps: 100 },
        });
        expect(shortEntry.trades[0]!.exitPrice).to.equal(data[29]!.close * (1 + 0.01));

        // Terminal commission is included: with 10% commission per side the
        // long trade's net PnL is materially below its gross slippage-only PnL.
        const withCommission = runScored(data, [signalAt(entryBar, "buy")], {
            settings: { slippageBps: 100 },
            commissionPercent: 10,
        });
        expect(withCommission.netProfit).to.be.lessThan(entry.netProfit);
    });

    it("supports long, short, and both directions inside the scored window", () => {
        const data = buildData();
        const longRun = runScored(data, [signalAt(12, "buy")], { tradeDirection: "long" });
        const shortRun = runScored(data, [signalAt(12, "sell")], { tradeDirection: "short" });
        const bothRun = runScored(data, [signalAt(12, "buy"), signalAt(20, "sell")], { tradeDirection: "both" });

        expect(longRun.trades.length).to.equal(1);
        expect(longRun.netProfit).to.be.greaterThan(0);
        expect(shortRun.trades.length).to.equal(1);
        expect(shortRun.netProfit).to.be.lessThan(0);
        // Both: long entry at 13, flipped by the sell signal at 21.
        expect(bothRun.trades.length).to.equal(2);
        expect(bothRun.trades[0]!.type).to.equal("long");
        expect(bothRun.trades[1]!.type).to.equal("short");
    });

    it("full-range execution is unchanged when no scored range is present", () => {
        const data = buildData();
        const signals = [signalAt(5, "buy"), signalAt(20, "sell")];
        const full = runBacktest(
            data,
            signals,
            10_000,
            100,
            0,
            { ...BASE_SETTINGS } as Parameters<typeof runBacktest>[5],
            { mode: "fixed", fixedTradeAmount: 1_000 },
            undefined,
            { requireTradeHistory: true },
        );
        // Warmup entry participates again: entered at bar 6 open (next_open),
        // closed by the sell exit at bar 21 open. Equity spans the full timeline.
        expect(full.trades.length).to.equal(1);
        expect(full.trades[0]!.entryPrice).to.equal(data[6]!.open);
        expect(full.trades[0]!.exitPrice).to.equal(data[21]!.open);
        expect(full.equityCurve.length).to.equal(data.length);
    });

    it("rejects unresolved or inverted boundaries and unsupported engines/directions loudly", () => {
        const data = buildData();
        const run = (scoredRange: unknown, options: Record<string, unknown> = {}) => runBacktest(
            data,
            [signalAt(12, "buy")],
            10_000,
            100,
            0,
            { ...BASE_SETTINGS } as Parameters<typeof runBacktest>[5],
            { mode: "fixed", fixedTradeAmount: 1_000 },
            undefined,
            { scoredRange: scoredRange as never, ...options },
        );

        expect(() => run({ startBarTime: 12345, endBarTime: barTime(data, 20) })).to.throw();
        expect(() => run({ startBarTime: barTime(data, 20), endBarTime: barTime(data, 10) })).to.throw();
        expect(() => run({ startBarTime: barTime(data, 10), endBarTime: barTime(data, BAR_COUNT + 5) })).to.throw();
        // Combined direction with a range is rejected before search.
        expect(() => run(scoredRange(data), { tradeDirection: undefined })).to.not.throw();
        expect(() => runBacktest(
            data,
            [signalAt(12, "buy")],
            10_000,
            100,
            0,
            { ...BASE_SETTINGS, tradeDirection: "combined" } as unknown as Parameters<typeof runBacktest>[5],
            { mode: "fixed", fixedTradeAmount: 1_000 },
            undefined,
            { scoredRange: scoredRange(data) },
        )).to.throw(/combined/);
        // The compact engine rejects the range (replay must use the standard path).
        expect(() => runBacktestCompact(
            data,
            [signalAt(12, "buy")],
            10_000,
            100,
            0,
            { ...BASE_SETTINGS } as Parameters<typeof runBacktestCompact>[5],
            { mode: "fixed", fixedTradeAmount: 1_000 },
            undefined,
            { scoredRange: scoredRange(data) },
        )).to.throw(/standard engine/);
    });

    it("threads through executeBacktest: TypeScript only, warmup excluded, scored account", async () => {
        const data = buildData();
        const output = await executeBacktest({
            ohlcvData: data,
            closedCandleDataOverride: data,
            interval: "1h",
            strategyKey: "demo",
            strategy: {
                name: "Fixture",
                description: "",
                defaultParams: {},
                paramLabels: {},
                execute: () => [signalAt(5, "buy"), signalAt(12, "buy")],
            } as never,
            strategyParams: {},
            backtestSettings: { ...BASE_SETTINGS, tradeDirection: "long" } as never,
            capitalSettings: { initialCapital: 10_000, positionSize: 100, commission: 0, sizingMode: "fixed", fixedTradeAmount: 1_000 } as never,
            preResolvedSettings: { ...BASE_SETTINGS, tradeDirection: "long" } as never,
            preResolvedCapital: { initialCapital: 10_000, positionSize: 100, commission: 0, sizingMode: "fixed", fixedTradeAmount: 1_000 } as never,
            context: { blockRange: null, annotatePolymarket: false, engineMode: "typescript", nowSec: 1_700_000_000 + 40 * 3600 },
            backtestRunOptions: {
                scoredRange: scoredRange(data),
                useCompactBacktest: false,
                includeSharpeRatio: true,
                skipResultPostProcessing: true,
                requireTradeHistory: true,
            },
        });

        expect(output.engineUsed).to.equal("typescript");
        expect(output.result.totalTrades).to.equal(1);
        expect(output.result.trades[0]!.entryPrice).to.equal(data[13]!.open);
    });
});
