import { expect } from "chai";
import { describe, it } from "node:test";
import { resolveOpenTradeDisplayMetrics } from "../lib/open-trade-display";
import type { OHLCVData, Time, Trade } from "../lib/types/strategies";

function makeTrade(overrides: Partial<Trade> = {}): Trade {
    return {
        id: 1,
        type: "long",
        entryTime: 1_700_000_000 as Time,
        entryPrice: 100,
        exitTime: 1_700_000_240 as Time,
        exitPrice: 101,
        pnl: 1,
        pnlPercent: 1,
        size: 1,
        fees: 0,
        exitReason: "end_of_data",
        ...overrides,
    };
}

function makeCandle(time: number, close: number, high: number = close, low: number = close): OHLCVData {
    return {
        time: time as Time,
        open: close,
        high,
        low,
        close,
        volume: 1,
    };
}

describe("Open trade display", () => {
    it("uses the last loaded candle time instead of wall-clock time for end-of-data trades", () => {
        const trade = makeTrade({
            entryTime: 1_700_000_000 as Time,
            exitTime: 1_700_000_240 as Time,
            exitPrice: 101,
            pnl: 1,
            pnlPercent: 1,
        });

        const display = resolveOpenTradeDisplayMetrics(
            trade,
            makeCandle(1_700_000_240, 101)
        );

        expect(display.durationMs).to.equal(240_000);
        expect(display.exitPrice).to.equal(101);
        expect(display.displayExitReason).to.equal("end_of_data");
    });

    it("keeps stale end-of-data trades closed when newer candles exist", () => {
        const trade = makeTrade({
            entryTime: 1_700_000_000 as Time,
            exitTime: 1_700_000_240 as Time,
            exitPrice: 101,
            pnl: 1,
            pnlPercent: 1,
        });

        const display = resolveOpenTradeDisplayMetrics(
            trade,
            makeCandle(1_700_000_420, 110, 110, 110)
        );

        expect(display.durationMs).to.equal(240_000);
        expect(display.exitPrice).to.equal(101);
        expect(display.pnl).to.equal(1);
        expect(display.displayExitReason).to.equal("end_of_data");
        expect(display.isSyntheticLiveExit).to.equal(false);
    });
});
