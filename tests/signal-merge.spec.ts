import { expect } from "chai";
import { describe, it } from "node:test";
import type { Time } from "lightweight-charts";
import { mergeStrategySignals } from "../lib/signal-merge";

function signal(time: Time, reason: string) {
    return {
        time,
        type: "buy" as const,
        price: 100,
        reason,
    };
}

describe("mergeStrategySignals", () => {
    it("sorts OR-merged BusinessDay signals by time", () => {
        const merged = mergeStrategySignals(
            [signal({ year: 2024, month: 1, day: 3 } as Time, "jan-03")],
            [signal({ year: 2024, month: 1, day: 2 } as Time, "jan-02")],
            "or"
        );

        expect(merged.map((entry) => entry.reason)).to.deep.equal(["jan-02", "jan-03"]);
    });

    it("sorts OR-merged ISO string signals by time", () => {
        const merged = mergeStrategySignals(
            [signal("2024-01-03T00:00:00.000Z" as Time, "jan-03")],
            [signal("2024-01-02T00:00:00.000Z" as Time, "jan-02")],
            "or"
        );

        expect(merged.map((entry) => entry.reason)).to.deep.equal(["jan-02", "jan-03"]);
    });

    it("sorts OR-merged mixed time shapes on the same unix scale", () => {
        const merged = mergeStrategySignals(
            [signal("2024-01-03T00:00:00.000Z" as Time, "jan-03-iso")],
            [
                signal({ year: 2024, month: 1, day: 2 } as Time, "jan-02-business-day"),
                signal(1704326400 as Time, "jan-04-seconds"),
            ],
            "or"
        );

        expect(merged.map((entry) => entry.reason)).to.deep.equal([
            "jan-02-business-day",
            "jan-03-iso",
            "jan-04-seconds",
        ]);
    });
});
