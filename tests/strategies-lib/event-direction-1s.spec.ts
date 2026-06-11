import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { event_direction_1s } from "../../lib/strategies/lib/event_direction_1s";

const EVENT_START = 1_700_001_000;

function bar(offsetSeconds: number, open: number, close: number): OHLCVData {
    return {
        time: (EVENT_START + offsetSeconds) as Time,
        open,
        high: Math.max(open, close),
        low: Math.min(open, close),
        close,
        volume: 1000,
    };
}

describe("event_direction_1s", () => {
    it("buys when close is above event open within the time window", () => {
        const bars = [
            bar(0, 100, 100),
            bar(1, 100, 100.5),
            bar(2, 100.5, 101),
        ];

        const signals = event_direction_1s.execute(bars, { minSecondsToEventEnd: 180 });

        expect(signals).to.have.length(2);
        expect(signals[0]!.type).to.equal("buy");
        expect(signals[1]!.type).to.equal("buy");
    });

    it("sells when close is below event open within the time window", () => {
        const bars = [
            bar(0, 100, 100),
            bar(1, 100, 99),
            bar(2, 99, 98),
        ];

        const signals = event_direction_1s.execute(bars, { minSecondsToEventEnd: 180 });

        expect(signals).to.have.length(2);
        expect(signals[0]!.type).to.equal("sell");
        expect(signals[1]!.type).to.equal("sell");
    });

    it("skips signals within minSecondsToEventEnd of event end", () => {
        // Event ends at EVENT_START + 300. With minSecondsToEventEnd=180,
        // signals after second 119 (300 - 180 - 1) should be skipped.
        const bars = [
            bar(0, 100, 100),
            bar(119, 100, 101),   // secondsRemaining = 180 -> skipped (<=)
            bar(50, 100, 101),    // secondsRemaining = 249 -> included
        ];

        const signals = event_direction_1s.execute(bars, { minSecondsToEventEnd: 180 });

        // bar at offset 50 should fire, bar at 119 should not
        expect(signals).to.have.length(1);
        expect(signals[0]!.barIndex).to.equal(2);
    });

    it("does not fire when close equals event open", () => {
        const bars = [
            bar(0, 100, 100),
            bar(1, 100, 100),
        ];

        const signals = event_direction_1s.execute(bars, { minSecondsToEventEnd: 180 });

        expect(signals).to.deep.equal([]);
    });

    it("requires no Polymarket context", () => {
        const bars = [
            bar(0, 100, 100),
            bar(1, 100, 101),
        ];

        // No third argument (context) — should still work
        const signals = event_direction_1s.execute(bars, { minSecondsToEventEnd: 180 });

        expect(signals).to.have.length(1);
        expect(signals[0]!.type).to.equal("buy");
    });

    it("exposes minSecondsToEventEnd as a tunable parameter", () => {
        expect(event_direction_1s.defaultParams).to.deep.equal({
            minSecondsToEventEnd: 180,
        });
        expect(event_direction_1s.paramLabels).to.deep.equal({
            minSecondsToEventEnd: "Min Seconds To Event End",
        });
        expect(event_direction_1s.metadata?.walkForwardParams).to.deep.equal([
            "minSecondsToEventEnd",
        ]);
    });
});
