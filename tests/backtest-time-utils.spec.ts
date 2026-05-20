import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Time } from "lightweight-charts";
import {
    canonicalTimeKey,
    compareTime,
    getTimeIndex,
    getTimeIndexValue,
    timeKey,
    timeToNumber,
} from "../lib/strategies/backtest/backtest-utils";

describe("backtest time utilities", () => {
    it("normalizes equivalent seconds, milliseconds, ISO strings, and BusinessDay values", () => {
        const unixSeconds = Math.floor(Date.UTC(2024, 0, 2) / 1000);
        const unixMilliseconds = unixSeconds * 1000;
        const iso = "2024-01-02T00:00:00.000Z" as Time;
        const businessDay = { year: 2024, month: 1, day: 2 } as Time;

        assert.equal(timeToNumber(unixSeconds as Time), unixSeconds);
        assert.equal(timeToNumber(unixMilliseconds as Time), unixSeconds);
        assert.equal(timeToNumber(iso), unixSeconds);
        assert.equal(timeToNumber(businessDay), unixSeconds);
        assert.equal(compareTime(unixMilliseconds as Time, iso), 0);
        assert.equal(timeKey(businessDay), "2024-01-02");
        assert.equal(canonicalTimeKey(businessDay), String(unixSeconds));
    });

    it("builds canonical time-index keys for equivalent timestamp shapes", () => {
        const unixSeconds = Math.floor(Date.UTC(2024, 0, 2) / 1000);
        const index = getTimeIndex([
            { time: unixSeconds as Time, open: 1, high: 2, low: 1, close: 2, volume: 100 },
        ]);

        assert.equal(getTimeIndexValue(index, "2024-01-02T00:00:00.000Z" as Time), 0);
        assert.equal(getTimeIndexValue(index, (unixSeconds * 1000) as Time), 0);
    });
});
