import { expect } from "chai";
import { describe, it } from "node:test";
import type { Time } from "lightweight-charts";
import { sliceOhlcvByBlock } from "../lib/block-selector";
import { filterSignalsByBlockRange } from "../lib/signal-block-filter";
import type { OHLCVData } from "../lib/types/strategies";
import type { Signal } from "../lib/types/strategies";

type TestSignal = {
    time: Signal["time"];
    type: "buy";
    price: number;
    reason: string;
};

function signal(time: Signal["time"], reason: string): TestSignal {
    return {
        time,
        type: "buy",
        price: 100,
        reason,
    };
}

describe("signal block range filtering", () => {
    it("keeps ISO string and BusinessDay signals inside the selected block", () => {
        const blockRange = {
            from: Math.floor(Date.UTC(2024, 0, 2) / 1000),
            to: Math.floor(Date.UTC(2024, 0, 3) / 1000),
        };

        const filtered = filterSignalsByBlockRange(
            [
                signal("2024-01-01T00:00:00.000Z" as Time, "outside-before"),
                signal("2024-01-02T00:00:00.000Z" as Time, "inside-iso"),
                signal({ year: 2024, month: 1, day: 3 } as Time, "inside-business-day"),
                signal({ year: 2024, month: 1, day: 4 } as Time, "outside-after"),
            ],
            blockRange
        );

        expect(filtered.map((entry) => entry.reason)).to.deep.equal([
            "inside-iso",
            "inside-business-day",
        ]);
    });

    it("keeps ISO string and BusinessDay candles inside the selected block", () => {
        const blockRange = {
            from: Math.floor(Date.UTC(2024, 0, 2) / 1000),
            to: Math.floor(Date.UTC(2024, 0, 3) / 1000),
        };
        const candles: OHLCVData[] = [
            { time: "2024-01-01T00:00:00.000Z" as Time, open: 1, high: 1, low: 1, close: 1, volume: 1 },
            { time: "2024-01-02T00:00:00.000Z" as Time, open: 2, high: 2, low: 2, close: 2, volume: 1 },
            { time: { year: 2024, month: 1, day: 3 } as Time, open: 3, high: 3, low: 3, close: 3, volume: 1 },
            { time: { year: 2024, month: 1, day: 4 } as Time, open: 4, high: 4, low: 4, close: 4, volume: 1 },
        ];

        expect(sliceOhlcvByBlock(candles, blockRange).map((candle) => candle.close)).to.deep.equal([2, 3]);
    });
});
