import { expect } from "chai";
import { describe, it } from "node:test";
import {
    buildTripleBarrierFirstHitIndices,
} from "../lib/strategies/backtest/path-exit-rules";
import type { OHLCVData, Time } from "../lib/types/strategies";

function makeBars(): OHLCVData[] {
    return [
        { time: 1 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1 },
        { time: 2 as Time, open: 100, high: 103, low: 99, close: 101, volume: 1 },
        { time: 3 as Time, open: 101, high: 102, low: 97, close: 100, volume: 1 },
        { time: 4 as Time, open: 100, high: 104, low: 97, close: 100, volume: 1 },
    ];
}

describe("Path-exit triple-barrier cache", () => {
    it("retains the first-hit and same-bar collision semantics for long trades", () => {
        const hits = buildTripleBarrierFirstHitIndices(makeBars(), 1, 2, 3);

        expect([...hits.favorable]).to.deep.equal([1, 3, 3, -1]);
        expect([...hits.adverse]).to.deep.equal([2, 2, 3, -1]);
    });

    it("mirrors the favorable/adverse barriers for short trades", () => {
        const hits = buildTripleBarrierFirstHitIndices(makeBars(), -1, 2, 3);

        expect([...hits.favorable]).to.deep.equal([2, 2, 3, -1]);
        expect([...hits.adverse]).to.deep.equal([1, 3, 3, -1]);
    });
});
