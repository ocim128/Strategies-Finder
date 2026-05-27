import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { polymarket_event_direction_follow } from "../../lib/strategies/lib/polymarket_event_direction_follow";

const EVENT_START = 1_700_001_000;

function bar(offsetSeconds: number, open: number, close: number): OHLCVData {
    return {
        time: (EVENT_START + offsetSeconds) as Time,
        open,
        high: Math.max(open, close),
        low: Math.min(open, close),
        close,
        volume: 1,
    };
}

describe("polymarket_event_direction_follow", () => {
    it("follows event-open direction using closed 1s bars", () => {
        const signals = polymarket_event_direction_follow.execute([
            bar(0, 100, 100),
            bar(1, 100, 100.02),
            bar(2, 100.02, 99.97),
            bar(3, 99.97, 100),
        ], {
            minSecondsToEventEnd: 0,
        });

        expect(signals.map((signal) => [signal.barIndex, signal.type])).to.deep.equal([
            [1, "buy"],
            [2, "sell"],
        ]);
    });

    it("resets the event-open reference at the next 5-minute event", () => {
        const signals = polymarket_event_direction_follow.execute([
            bar(0, 100, 100),
            bar(1, 100, 101),
            bar(300, 200, 200),
            bar(301, 200, 199),
        ], {
            minSecondsToEventEnd: 0,
        });

        expect(signals.map((signal) => [signal.barIndex, signal.type])).to.deep.equal([
            [1, "buy"],
            [3, "sell"],
        ]);
    });

    it("applies the late-event cutoff at the modeled decision second", () => {
        const signals = polymarket_event_direction_follow.execute([
            bar(0, 100, 100),
            bar(283, 100, 100.02),
            bar(284, 100.02, 100.03),
        ], {
            minSecondsToEventEnd: 15,
        });

        expect(signals.map((signal) => signal.barIndex)).to.deep.equal([1]);
    });

    it("exposes only the event-end cutoff as a tunable parameter", () => {
        expect(polymarket_event_direction_follow.defaultParams).to.deep.equal({
            minSecondsToEventEnd: 180,
        });
        expect(polymarket_event_direction_follow.paramLabels).to.deep.equal({
            minSecondsToEventEnd: "Minimum Seconds To Event End",
        });
        expect(polymarket_event_direction_follow.metadata?.walkForwardParams).to.deep.equal([
            "minSecondsToEventEnd",
        ]);
    });
});
