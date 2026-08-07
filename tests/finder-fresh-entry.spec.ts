/**
 * Tests for the fresh-entry detector leaf (`lib/finder/finder-fresh-entry.ts`).
 *
 * The detector resolves whether the latest closed candle produced a NEW entry,
 * an active (still-open) state signal, or no position. These tests cover the
 * fixtures the implementation plan calls out: fresh long, fresh short,
 * reversal, repeated signal (active), no signal (flat), and forced final
 * liquidation (`end_of_data`) exclusion semantics.
 *
 * The detector is a pure function of `(BacktestResult, candles, settings?)`,
 * so the tests build deterministic trades + candle arrays and assert the
 * resolved status without spinning up the backtest engine.
 */
import { expect } from "chai";
import { describe, it } from "node:test";
import { detectFreshEntry } from "../lib/finder/finder-fresh-entry";
import type { BacktestResult, OHLCVData, Signal, Time, Trade } from "../lib/types/strategies";
import type { BacktestSettings } from "../lib/types/strategies";

function candle(i: number, close = 100 + i): OHLCVData {
    return {
        time: (1_700_000_000 + i * 60) as Time,
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1000,
    };
}

function candles(n: number): OHLCVData[] {
    return Array.from({ length: n }, (_v, i) => candle(i));
}

function trade(args: {
    id?: number;
    type: "long" | "short";
    entryIndex: number;
    exitReason?: Trade["exitReason"];
    entryCandles: OHLCVData[];
}): Trade {
    const id = args.id ?? 1;
    const entryCandle = args.entryCandles[args.entryIndex]!;
    return {
        id,
        type: args.type,
        entryTime: entryCandle.time,
        entryPrice: entryCandle.close,
        exitTime: entryCandle.time,
        exitPrice: entryCandle.close,
        pnl: 0,
        pnlPercent: 0,
        size: 1,
        fees: 0,
        ...(args.exitReason ? { exitReason: args.exitReason } : {}),
    };
}

function resultWith(trades: Trade[]): BacktestResult {
    return {
        trades,
        netProfit: 0,
        netProfitPercent: 0,
        winRate: 0,
        expectancy: 0,
        avgTrade: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: trades.length,
        winningTrades: 0,
        losingTrades: 0,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
    };
}

const SIGNAL_CLOSE_SETTINGS: BacktestSettings = { executionModel: "signal_close" };
const NEXT_OPEN_SETTINGS: BacktestSettings = { executionModel: "next_open" };

describe("Finder fresh-entry detector", () => {
    it("returns flat for a result with no trades", () => {
        const detected = detectFreshEntry({
            result: resultWith([]),
            candles: candles(5),
            settings: SIGNAL_CLOSE_SETTINGS,
        });
        expect(detected.freshStatus).to.equal("flat");
        expect(detected.direction).to.equal(null);
        expect(detected.latestSignalTime).to.equal(null);
        expect(detected.isOpen).to.equal(false);
    });

    it("marks a latest next_open signal fresh before its next-bar fill exists", () => {
        const data = candles(5);
        const latest = data[data.length - 1]!;
        const signals: Signal[] = [{
            time: latest.time,
            type: "buy",
            price: latest.close,
        }];
        const detected = detectFreshEntry({
            result: resultWith([]),
            candles: data,
            settings: { ...NEXT_OPEN_SETTINGS, tradeDirection: "long" },
            signals,
        });
        expect(detected.freshStatus).to.equal("fresh");
        expect(detected.direction).to.equal("long");
        expect(detected.latestSignalTime).to.equal(latest.time);
        expect(detected.signalAgeBars).to.equal(0);
        expect(detected.fillTiming).to.equal("next_open");
    });

    it("keeps a repeated latest next_open signal active when the prior position is open", () => {
        const data = candles(5);
        const latest = data[data.length - 1]!;
        const detected = detectFreshEntry({
            result: resultWith([
                trade({ type: "long", entryIndex: 1, exitReason: "end_of_data", entryCandles: data }),
            ]),
            candles: data,
            settings: { ...NEXT_OPEN_SETTINGS, tradeDirection: "long" },
            signals: [{ time: latest.time, type: "buy", price: latest.close }],
        });
        expect(detected.freshStatus).to.equal("active");
        expect(detected.direction).to.equal("long");
        expect(detected.signalAgeBars).to.equal(4);
    });

    it("marks a long entry on the latest closed candle as fresh", () => {
        const data = candles(5);
        const latest = data.length - 1;
        const detected = detectFreshEntry({
            result: resultWith([
                trade({ type: "long", entryIndex: latest, exitReason: "end_of_data", entryCandles: data }),
            ]),
            candles: data,
            settings: SIGNAL_CLOSE_SETTINGS,
        });
        expect(detected.freshStatus).to.equal("fresh");
        expect(detected.direction).to.equal("long");
        expect(detected.signalAgeBars).to.equal(0);
        expect(detected.isOpen).to.equal(true);
    });

    it("marks a short entry on the latest closed candle as fresh (reversal counts)", () => {
        const data = candles(5);
        const latest = data.length - 1;
        const detected = detectFreshEntry({
            result: resultWith([
                trade({ id: 1, type: "long", entryIndex: 1, exitReason: "signal", entryCandles: data }),
                trade({ id: 2, type: "short", entryIndex: latest, exitReason: "end_of_data", entryCandles: data }),
            ]),
            candles: data,
            settings: SIGNAL_CLOSE_SETTINGS,
        });
        expect(detected.freshStatus).to.equal("fresh");
        expect(detected.direction).to.equal("short");
        expect(detected.signalAgeBars).to.equal(0);
    });

    it("marks an open position entered on an earlier bar as active (repeated state signal)", () => {
        const data = candles(5);
        const detected = detectFreshEntry({
            result: resultWith([
                trade({ type: "long", entryIndex: 1, exitReason: "end_of_data", entryCandles: data }),
            ]),
            candles: data,
            settings: SIGNAL_CLOSE_SETTINGS,
        });
        expect(detected.freshStatus).to.equal("active");
        expect(detected.direction).to.equal("long");
        expect(detected.isOpen).to.equal(true);
        // Entry bar 1 of 5 → age = 3 (latest index 4 - 1).
        expect(detected.signalAgeBars).to.equal(3);
    });

    it("marks a closed latest trade (exitReason not end_of_data) on an earlier bar as flat", () => {
        const data = candles(5);
        const detected = detectFreshEntry({
            result: resultWith([
                trade({ type: "long", entryIndex: 1, exitReason: "signal", entryCandles: data }),
            ]),
            candles: data,
            settings: SIGNAL_CLOSE_SETTINGS,
        });
        expect(detected.freshStatus).to.equal("flat");
        expect(detected.isOpen).to.equal(false);
    });

    it("excludes forced end_of_data liquidation from the freshness age when the latest entry fired earlier", () => {
        // Open on bar 1, never closed → engine forces end_of_data exit on the
        // latest bar. The signal bar is bar 1, so this is `active` not `fresh`.
        const data = candles(4);
        const detected = detectFreshEntry({
            result: resultWith([
                trade({ type: "long", entryIndex: 1, exitReason: "end_of_data", entryCandles: data }),
            ]),
            candles: data,
            settings: SIGNAL_CLOSE_SETTINGS,
        });
        expect(detected.freshStatus).to.equal("active");
        expect(detected.signalAgeBars).to.equal(2);
    });

    it("walks back one bar for next_open execution model to find the source signal", () => {
        // Entry fill on the latest bar under next_open means the signal fired
        // one bar earlier. With execution shift = 1, signal bar = latest - 1,
        // so signalAgeBars = 1, NOT 0 → this is `active` (entry on the latest
        // bar, but signal fired earlier). The detector correctly distinguishes
        // next_open fills from signal_close.
        const data = candles(3);
        const latest = data.length - 1;
        const detected = detectFreshEntry({
            result: resultWith([
                trade({ type: "long", entryIndex: latest, exitReason: "end_of_data", entryCandles: data }),
            ]),
            candles: data,
            settings: NEXT_OPEN_SETTINGS,
        });
        // signalBarIndex = latest - 1 = 1, signalAgeBars = latest - 1 = 1.
        expect(detected.signalAgeBars).to.equal(1);
        // Entry fill is on the latest bar; signal fired one bar earlier → not fresh.
        expect(detected.freshStatus).to.equal("active");
    });

    it("resolves fillTiming from settings", () => {
        const data = candles(2);
        const detected = detectFreshEntry({
            result: resultWith([
                trade({ type: "long", entryIndex: 1, exitReason: "end_of_data", entryCandles: data }),
            ]),
            candles: data,
            settings: { executionModel: "next_close" },
        });
        expect(detected.fillTiming).to.equal("next_close");
    });

    it("picks the latest executed entry by entry time, breaking ties by trade id", () => {
        // Two trades: one older long, one newer short on the latest bar.
        const data = candles(4);
        const latest = data.length - 1;
        const detected = detectFreshEntry({
            result: resultWith([
                trade({ id: 1, type: "long", entryIndex: 1, exitReason: "signal", entryCandles: data }),
                trade({ id: 2, type: "short", entryIndex: latest, exitReason: "end_of_data", entryCandles: data }),
            ]),
            candles: data,
            settings: SIGNAL_CLOSE_SETTINGS,
        });
        // Latest entry wins → short, on the latest bar → fresh.
        expect(detected.direction).to.equal("short");
        expect(detected.freshStatus).to.equal("fresh");
    });
});
