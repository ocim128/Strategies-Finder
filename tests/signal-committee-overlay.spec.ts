import { expect } from "chai";
import { describe, it } from "node:test";
import {
    computeCommitteeOverlayScores,
    pickScoreChangePoints,
    toOverlayPoints,
    type CommitteeOverlayBar,
    type CommitteeOverlayMember,
} from "../lib/signal-committee-overlay";

function bars(...secs: number[]): CommitteeOverlayBar[] {
    return secs.map((sec) => ({ sec }));
}

function member(streamId: string, windows: Array<[number, number | null, 1 | -1]>): CommitteeOverlayMember {
    return { streamId, tradeWindows: windows };
}

describe("signal-committee-overlay / computeCommitteeOverlayScores", () => {
    it("returns an empty array when there are no bars", () => {
        const scores = computeCommitteeOverlayScores([], [member("a", [[10, 20, 1]])]);
        expect(scores.length).to.equal(0);
    });

    it("returns all zeros when there are no members with windows", () => {
        const scores = computeCommitteeOverlayScores(bars(5, 15, 25), []);
        expect(Array.from(scores)).to.deep.equal([0, 0, 0]);
    });

    it("returns all zeros when members have no tradeWindows", () => {
        const scores = computeCommitteeOverlayScores(bars(5, 15, 25), [{ streamId: "a" }]);
        expect(Array.from(scores)).to.deep.equal([0, 0, 0]);
    });

    it("scores a single long window correctly across bars", () => {
        // long window [10, 20)
        const scores = computeCommitteeOverlayScores(bars(5, 10, 15, 19, 20, 25), [member("a", [[10, 20, 1]])]);
        // 5 -> before -> 0
        // 10 -> entry boundary inclusive -> +1
        // 15, 19 -> inside -> +1
        // 20 -> exit boundary exclusive -> 0
        // 25 -> after -> 0
        expect(Array.from(scores)).to.deep.equal([0, 1, 1, 1, 0, 0]);
    });

    it("treats null exitSec as covering all bars from entry onward", () => {
        // open long: [10, null)
        const scores = computeCommitteeOverlayScores(bars(5, 10, 100, 1000), [member("a", [[10, null, 1]])]);
        expect(Array.from(scores)).to.deep.equal([0, 1, 1, 1]);
    });

    it("sums contributions across multiple members", () => {
        // member a: long [10, 30) -> +1 in that range
        // member b: short [20, 40) -> -1 in that range
        const scores = computeCommitteeOverlayScores(
            bars(5, 15, 25, 35, 45),
            [
                member("a", [[10, 30, 1]]),
                member("b", [[20, 40, -1]]),
            ]
        );
        // 5  -> neither -> 0
        // 15 -> only a -> +1
        // 25 -> a and b -> 0
        // 35 -> only b -> -1
        // 45 -> neither -> 0
        expect(Array.from(scores)).to.deep.equal([0, 1, 0, -1, 0]);
    });

    it("cross-timeframe: 1h window covers many 1m bars", () => {
        // A 1h long window [0, 3600) covering 1m bars at 0, 60, 120, ..., 3600
        const oneMinBars: CommitteeOverlayBar[] = [];
        for (let s = 0; s <= 3600; s += 60) oneMinBars.push({ sec: s });
        const scores = computeCommitteeOverlayScores(oneMinBars, [member("h1", [[0, 3600, 1]])]);
        // All bars from 0..3540 inclusive are inside; 3600 is the exclusive exit boundary.
        expect(scores[0]).to.equal(1);
        expect(scores[scores.length - 2]).to.equal(1); // bar at 3540
        expect(scores[scores.length - 1]).to.equal(0); // bar at 3600 = exit
    });

    it("ignores windows with non-finite entry", () => {
        const scores = computeCommitteeOverlayScores(bars(10), [member("a", [[Number.NaN, 20, 1]])]);
        expect(scores[0]).to.equal(0);
    });

    it("ignores bars with non-finite sec", () => {
        const scores = computeCommitteeOverlayScores(
            [{ sec: Number.NaN }, { sec: 15 }],
            [member("a", [[10, 20, 1]])]
        );
        expect(scores[0]).to.equal(0);
        expect(scores[1]).to.equal(1);
    });

    it("handles overlapping windows from the same member (rare but valid)", () => {
        // Two long windows from one member that overlap: bars in the overlap
        // get +2. This is unusual but the algorithm must not silently drop it.
        const scores = computeCommitteeOverlayScores(
            bars(5, 12, 17, 25),
            [member("a", [[10, 20, 1], [12, 18, 1]])]
        );
        // 5  -> 0
        // 12 -> +2 (inside both)
        // 17 -> +2 (inside both)
        // 25 -> 0
        expect(Array.from(scores)).to.deep.equal([0, 2, 2, 0]);
    });
});

describe("signal-committee-overlay / toOverlayPoints", () => {
    it("zips bars and scores into {time, value} points, dropping null times", () => {
        const bars = [{ t: "a" }, { t: "b" }, { t: null }, { t: "d" }];
        const scores = [1, 2, 3, 4];
        const points = toOverlayPoints(bars, scores, (b) => b.t);
        expect(points).to.deep.equal([
            { time: "a", value: 1 },
            { time: "b", value: 2 },
            { time: "d", value: 4 },
        ]);
    });

    it("stops at the shorter of bars/scores", () => {
        const points = toOverlayPoints([1, 2, 3], [10, 20], (n) => n);
        expect(points).to.deep.equal([{ time: 1, value: 10 }, { time: 2, value: 20 }]);
    });
});

describe("signal-committee-overlay / pickScoreChangePoints", () => {
    it("returns nothing for empty input", () => {
        expect(pickScoreChangePoints([], [], (b) => b)).to.deep.equal([]);
    });

    it("picks the first bar, every change, and the last bar", () => {
        // scores: 0, 1, 1, -1, -1, 0
        //   idx0 -> first (0)
        //   idx1 -> change to 1
        //   idx2 -> same as idx1 -> skip
        //   idx3 -> change to -1
        //   idx4 -> same as idx3 -> skip
        //   idx5 -> change to 0 (also last)
        const bars = ["a", "b", "c", "d", "e", "f"];
        const scores = [0, 1, 1, -1, -1, 0];
        const points = pickScoreChangePoints(bars, scores, (b) => b);
        expect(points).to.deep.equal([
            { time: "a", value: 0 },
            { time: "b", value: 1 },
            { time: "d", value: -1 },
            { time: "f", value: 0 },
        ]);
    });

    it("keeps the last bar visible even when the score is flat throughout", () => {
        // All-zero verdict across many bars: only the first and last are picked.
        const bars = ["a", "b", "c", "d"];
        const scores = [0, 0, 0, 0];
        const points = pickScoreChangePoints(bars, scores, (b) => b);
        expect(points).to.deep.equal([
            { time: "a", value: 0 },
            { time: "d", value: 0 },
        ]);
    });

    it("dedupes when the last bar is also a change (no double entry)", () => {
        // The last bar is both a change and the last bar — must appear once.
        const bars = ["a", "b"];
        const scores = [0, 1];
        const points = pickScoreChangePoints(bars, scores, (b) => b);
        expect(points).to.deep.equal([
            { time: "a", value: 0 },
            { time: "b", value: 1 },
        ]);
    });

    it("drops bars whose time is null but keeps comparing neighbours", () => {
        // A null-time bar in the middle is dropped, but the change it carried
        // is NOT — the next real bar still reflects the updated score.
        const bars = ["a", null, "c"];
        const scores = [0, 1, 1];
        const points = pickScoreChangePoints(bars, scores, (b) => b);
        expect(points).to.deep.equal([
            { time: "a", value: 0 },
            { time: "c", value: 1 },
        ]);
    });
});
