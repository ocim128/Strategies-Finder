import { expect } from "chai";
import { describe, it } from "node:test";
import type { Time } from "lightweight-charts";
import { filterSignalsByBlockRange } from "../lib/signal-block-filter";
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
});
