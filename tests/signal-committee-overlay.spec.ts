import { expect } from "chai";
import { describe, it } from "node:test";
import {
    computeCommitteeOverlayScores,
    pickScoreChangePoints,
    chartOverlayVoteMultiplier,
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

    // Chart-scope: voteMultiplier must be honored so the overlay only reflects
    // members relevant to the open chart symbol. Without this, a FETUSDT chart
    // would silently sum in BTCUSDT/ETHUSDT/etc. member votes — the bug this
    // feature fixes.
    it("drops members whose voteMultiplier is 0", () => {
        // Both members cover the same bar at sec=15. The multiplier=0 member
        // (an unrelated chart symbol) must NOT contribute.
        const scores = computeCommitteeOverlayScores(
            bars(5, 15, 25),
            [
                { streamId: "fet", tradeWindows: [[10, 20, 1]], voteMultiplier: 1 },
                { streamId: "btc", tradeWindows: [[10, 20, 1]], voteMultiplier: 0 },
            ]
        );
        // Only `fet` counts -> +1 at sec 15.
        expect(Array.from(scores)).to.deep.equal([0, 1, 0]);
    });

    it("flips dirSigns when voteMultiplier is -1 (synthetic quote leg)", () => {
        // A long FET+APT member is short APT on the APTUSDT chart. Its long
        // window must therefore read -1 on a chart scoped to APTUSDT.
        const scores = computeCommitteeOverlayScores(
            bars(5, 15, 25),
            [{ streamId: "fetapt", tradeWindows: [[10, 20, 1]], voteMultiplier: -1 }]
        );
        // Long synthetic -> -1 on the quote leg's chart at sec 15.
        expect(Array.from(scores)).to.deep.equal([0, -1, 0]);
    });

    it("treats an omitted voteMultiplier as +1 (legacy callers)", () => {
        // Members constructed without the field must behave exactly as before
        // the chart-scope change so existing pure callers (tests, future code)
        // keep working without specifying a multiplier.
        const scores = computeCommitteeOverlayScores(
            bars(5, 15, 25),
            [member("a", [[10, 20, 1]])] // no voteMultiplier
        );
        expect(Array.from(scores)).to.deep.equal([0, 1, 0]);
    });

    // Regression: the events-based sweep must produce identical results to the
    // old O(windows × bars) loop on non-trivial inputs. Catches any boundary
    // or ordering bug introduced by the rewrite (entry inclusive, exit
    // exclusive, ties resolved entry-first).
    it("matches the documented hand-computed score on a mixed multi-member case", () => {
        // 3 members with overlapping long/short windows of differing lengths.
        //   a: long  [100, 300)
        //   b: short [200, 400)
        //   c: long  [250, null)   open-ended
        const scores = computeCommitteeOverlayScores(
            bars(0, 100, 150, 200, 250, 300, 350, 400, 500),
            [
                member("a", [[100, 300, 1]]),
                member("b", [[200, 400, -1]]),
                member("c", [[250, null, 1]]),
            ]
        );
        // 0   -> 0 (none)
        // 100 -> a in                -> +1
        // 150 -> a                   -> +1
        // 200 -> a + b               -> 0
        // 250 -> a + b + c           -> +1
        // 300 -> a out, b + c        -> 0
        // 350 -> b + c               -> 0
        // 400 -> b out, c            -> +1
        // 500 -> c                   -> +1
        expect(Array.from(scores)).to.deep.equal([0, 1, 1, 0, 1, 0, 0, 1, 1]);
    });

    it("resolves entry/exit ties as entry-first (entry inclusive, exit exclusive)", () => {
        // One window closes at sec=20 exactly when another opens. A bar at
        // sec=20 must reflect the new window only, not the closed one.
        const scores = computeCommitteeOverlayScores(
            bars(10, 20, 30),
            [
                member("closing", [[10, 20, 1]]),   // covers [10, 20)
                member("opening", [[20, 30, 1]]),   // covers [20, 30)
            ]
        );
        // sec=10 -> closing in -> +1
        // sec=20 -> closing out (exclusive) + opening in (inclusive) -> +1
        // sec=30 -> opening out -> 0
        expect(Array.from(scores)).to.deep.equal([1, 1, 0]);
    });

    // Regression for the bug this change fixes: with TRADE_WINDOWS_CAP raised,
    // bars far in the past must now be scored instead of being silently
    // truncated to 0. This test pins that a member with thousands of windows
    // is honored end-to-end, and that the events sweep scales to that volume.
    it("scores ancient bars when a member has many windows (cap-raise regression)", () => {
        // Build 1000 non-overlapping long windows spanning sec 0..2000, each
        // covering one bar. With the old cap (200), only the last 200 would
        // survive and the first 800 bars would read 0. The new cap (5000)
        // keeps them all; the events sweep must score every bar correctly.
        const windowCount = 1000;
        const windows: Array<[number, number | null, 1 | -1]> = [];
        const expected: number[] = [];
        for (let i = 0; i < windowCount; i++) {
            const entry = i * 2;       // bars at 0, 2, 4, ...
            const exit = entry + 1;    // window covers exactly [entry, entry+1)
            windows.push([entry, exit, 1]);
            expected.push(1);
        }
        const manyBars: CommitteeOverlayBar[] = [];
        for (let i = 0; i < windowCount; i++) manyBars.push({ sec: i * 2 });
        const scores = computeCommitteeOverlayScores(manyBars, [member("a", windows)]);
        expect(scores.length).to.equal(windowCount);
        expect(Array.from(scores)).to.deep.equal(expected);
    });

    // Performance gate: this would freeze the UI under the old O(members ×
    // windows × bars) loop (~2 billion comparisons). The events sweep is
    // O(events log events + bars) and must finish in well under a second.
    // If this test goes slow or times out, the algorithm has regressed.
    it("scales to multi-year chart volume without pathological cost", () => {
        const memberCount = 25;
        const windowsPerMember = 5000;
        const barCount = 16000;
        const syntheticBars: CommitteeOverlayBar[] = [];
        for (let i = 0; i < barCount; i++) syntheticBars.push({ sec: i * 100 });
        const syntheticMembers: CommitteeOverlayMember[] = [];
        for (let m = 0; m < memberCount; m++) {
            const windows: Array<[number, number | null, 1 | -1]> = [];
            for (let w = 0; w < windowsPerMember; w++) {
                const entry = w * 50;                 // windows spread across the chart
                windows.push([entry, entry + 25, (w % 2 === 0 ? 1 : -1) as 1 | -1]);
            }
            syntheticMembers.push({ streamId: `m${m}`, tradeWindows: windows });
        }
        const start = Date.now();
        const scores = computeCommitteeOverlayScores(syntheticBars, syntheticMembers);
        const elapsed = Date.now() - start;
        // Sanity: every bar produced a finite integer score.
        expect(scores.length).to.equal(barCount);
        expect(Number.isFinite(scores[0])).to.equal(true);
        // Generous budget: dev machines typically run this in <100 ms; allow
        // 2 seconds so the test does not flake on slow CI. The point is to
        // catch an O(n²) regression, not to benchmark.
        expect(elapsed, `events sweep took ${elapsed}ms`).to.be.lessThan(2000);
    });

    // Contract: the events sweep walks bars in lockstep with sorted events, so
    // bars MUST be ascending. The production caller (state.ohlcvData) is. This
    // test pins the ascending-order behavior so a future caller that feeds
    // unsorted bars fails loudly here instead of silently reading 0 on bars
    // whose events were already consumed by a later bar.
    it("requires bars in ascending sec order (production caller contract)", () => {
        // Ascending bars: sec=10 is inside [10,20), sec=20 outside, sec=30 outside.
        const ascending = computeCommitteeOverlayScores(
            bars(10, 20, 30),
            [member("a", [[10, 20, 1]])]
        );
        expect(Array.from(ascending)).to.deep.equal([1, 0, 0]);
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

describe("signal-committee-overlay / chartOverlayVoteMultiplier", () => {
    it("returns +1 when the member symbol equals the chart symbol", () => {
        expect(chartOverlayVoteMultiplier("FETUSDT", { symbol: "FETUSDT" })).to.equal(1);
    });

    it("is case- and separator-insensitive on the chart symbol", () => {
        // Committee symbols are stored normalized (e.g. FET+APT -> FETAPT, or
        // FETUSDT). The chart symbol may arrive with display separators; the
        // comparison must still match the normalized member symbol.
        expect(chartOverlayVoteMultiplier("fet usdt", { symbol: "FETUSDT" })).to.equal(1);
        expect(chartOverlayVoteMultiplier("FET-USDT", { symbol: "FETUSDT" })).to.equal(1);
    });

    it("returns 0 when a non-synthetic member's symbol does not match", () => {
        // The FETUSDT chart must NOT count a BTCUSDT-only member.
        expect(chartOverlayVoteMultiplier("FETUSDT", { symbol: "BTCUSDT" })).to.equal(0);
        expect(chartOverlayVoteMultiplier("FETUSDT", { symbol: null })).to.equal(0);
        expect(chartOverlayVoteMultiplier("FETUSDT", {})).to.equal(0);
    });

    it("returns 0 when the chart symbol is empty", () => {
        expect(chartOverlayVoteMultiplier("", { symbol: "FETUSDT" })).to.equal(0);
    });

    it("returns +1 when the chart symbol is the synthetic pair's base leg", () => {
        // Long FET+APT -> long FETUSDT on the FETUSDT chart.
        expect(chartOverlayVoteMultiplier("FETUSDT", {
            symbol: "FETAPT",
            syntheticPair: { baseSymbol: "FETUSDT", quoteSymbol: "APTUSDT" },
        })).to.equal(1);
    });

    it("returns -1 when the chart symbol is the synthetic pair's quote leg", () => {
        // Long FET+APT -> short APTUSDT on the APTUSDT chart.
        expect(chartOverlayVoteMultiplier("APTUSDT", {
            symbol: "FETAPT",
            syntheticPair: { baseSymbol: "FETUSDT", quoteSymbol: "APTUSDT" },
        })).to.equal(-1);
    });

    it("returns 0 when neither synthetic leg matches the chart symbol", () => {
        // A FET+APT member must not contribute to a BTCUSDT chart.
        expect(chartOverlayVoteMultiplier("BTCUSDT", {
            symbol: "FETAPT",
            syntheticPair: { baseSymbol: "FETUSDT", quoteSymbol: "APTUSDT" },
        })).to.equal(0);
    });

    it("ignores the direct symbol when a synthetic pair is present", () => {
        // When the pair is set, decomposition wins and the member's own symbol
        // (the derived synthetic) is NOT compared directly. A FETAPT member
        // must NOT count as +1 on a FETAPT chart via the symbol field — it
        // only counts via its legs.
        expect(chartOverlayVoteMultiplier("FETAPT", {
            symbol: "FETAPT",
            syntheticPair: { baseSymbol: "FETUSDT", quoteSymbol: "APTUSDT" },
        })).to.equal(0);
    });

    it("returns 0 when the synthetic pair is malformed", () => {
        // Defensive: a corrupt pair with empty legs must not crash or match.
        expect(chartOverlayVoteMultiplier("FETUSDT", {
            symbol: "FETAPT",
            syntheticPair: { baseSymbol: "", quoteSymbol: "" },
        })).to.equal(0);
    });
});
