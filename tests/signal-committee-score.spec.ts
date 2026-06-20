import { expect } from "chai";
import { describe, it } from "node:test";
import {
    aggregateScore,
    ageSecForRow,
    formatAgeShort,
    formatPercentSigned,
    gainPctForRow,
    voteForRow,
    type CommitteeScoreRow,
} from "../lib/signal-committee-score";

type Row = CommitteeScoreRow & { voteDirection?: "long" | "short" | null };

function openLong(entrySec: number, entryPrice: number, latestClose: number | null = null): Row {
    return {
        streamId: `long-${entrySec}`,
        ok: true,
        latestTrade: { entryTimeSec: entrySec, entryPrice, isOpen: true },
        latestClose,
        voteDirection: "long",
    };
}

function openShort(entrySec: number, entryPrice: number, latestClose: number | null = null): Row {
    return {
        streamId: `short-${entrySec}`,
        ok: true,
        latestTrade: { entryTimeSec: entrySec, entryPrice, isOpen: true },
        latestClose,
        voteDirection: "short",
    };
}

function flat(): Row {
    return {
        streamId: "flat",
        ok: true,
        latestTrade: { entryTimeSec: 0, entryPrice: 100, isOpen: false },
        latestClose: 100,
        voteDirection: null,
    };
}

function excluded(): Row {
    return {
        streamId: "excluded",
        ok: false,
        latestTrade: null,
        latestClose: null,
        voteDirection: null,
    };
}

describe("signal-committee-score / voteForRow", () => {
    it("votes +1 for an open long, -1 for an open short, 0 for flat", () => {
        expect(voteForRow(openLong(0, 100, 110))).to.equal(1);
        expect(voteForRow(openShort(0, 100, 90))).to.equal(-1);
        expect(voteForRow(flat())).to.equal(0);
    });

    it("votes 0 when ok=false (excluded rows never contribute)", () => {
        expect(voteForRow(excluded())).to.equal(0);
    });

    it("votes 0 for an open trade whose direction is unknown", () => {
        const row: Row = {
            streamId: "unknown",
            ok: true,
            latestTrade: { entryTimeSec: 0, entryPrice: 100, isOpen: true },
            latestClose: 100,
            voteDirection: null,
        };
        expect(voteForRow(row)).to.equal(0);
    });
});

describe("signal-committee-score / gainPctForRow", () => {
    it("computes long gain as ((last-entry)/entry)*100", () => {
        // entry 100 -> last 110 = +10%
        expect(gainPctForRow(openLong(0, 100, 110))).to.be.closeTo(10, 1e-9);
        // entry 100 -> last 95 = -5%
        expect(gainPctForRow(openLong(0, 100, 95))).to.be.closeTo(-5, 1e-9);
    });

    it("computes short gain with inverted sign (entry 100, last 90 -> +10%)", () => {
        expect(gainPctForRow(openShort(0, 100, 90))).to.be.closeTo(10, 1e-9);
        expect(gainPctForRow(openShort(0, 100, 110))).to.be.closeTo(-10, 1e-9);
    });

    it("returns null for flat or excluded rows", () => {
        expect(gainPctForRow(flat())).to.equal(null);
        expect(gainPctForRow(excluded())).to.equal(null);
    });

    it("returns null when latestClose is missing even if the trade is open", () => {
        const row = openLong(0, 100, null);
        expect(gainPctForRow(row)).to.equal(null);
    });
});

describe("signal-committee-score / ageSecForRow", () => {
    it("is now-entry for open trades", () => {
        expect(ageSecForRow(openLong(100, 50), 250)).to.equal(150);
    });

    it("is null for flat/excluded rows", () => {
        expect(ageSecForRow(flat(), 1000)).to.equal(null);
        expect(ageSecForRow(excluded(), 1000)).to.equal(null);
    });
});

describe("signal-committee-score / aggregateScore", () => {
    it("sums long(+1) and short(-1) votes into a signed score", () => {
        const now = 10_000;
        const rows = [
            openLong(9_000, 100, 110),
            openLong(9_500, 100, 105),
            openShort(9_900, 100, 95),
            flat(),
            excluded(),
        ];
        const agg = aggregateScore(rows, now);
        expect(agg.score).to.equal(1); // +1 +1 -1
        expect(agg.longCount).to.equal(2);
        expect(agg.shortCount).to.equal(1);
        expect(agg.flatCount).to.equal(1);
        expect(agg.excludedCount).to.equal(1);
    });

    it("averages age only over open-trade rows", () => {
        const now = 10_000;
        const rows = [
            openLong(9_000, 100, 110), // age 1000
            openShort(9_500, 100, 95), // age 500
            flat(),                    // ignored
            excluded(),                // ignored
        ];
        const agg = aggregateScore(rows, now);
        expect(agg.avgAgeSec).to.equal(750);
    });

    it("averages gain only over open trades with a usable latestClose", () => {
        const rows = [
            openLong(0, 100, 110), // +10%
            openLong(0, 100, 90),  // -10%
            openLong(0, 100, null),// excluded (no close)
            flat(),                // excluded
        ];
        const agg = aggregateScore(rows, 100);
        expect(agg.avgGainPct).to.be.closeTo(0, 1e-9);
    });

    it("returns null averages when no open trades exist", () => {
        const agg = aggregateScore([flat(), excluded()], 1000);
        expect(agg.score).to.equal(0);
        expect(agg.avgAgeSec).to.equal(null);
        expect(agg.avgGainPct).to.equal(null);
    });
});

describe("signal-committee-score / formatters", () => {
    it("formatAgeShort renders compact durations", () => {
        expect(formatAgeShort(null)).to.equal("—");
        expect(formatAgeShort(30)).to.equal("30s");
        expect(formatAgeShort(65)).to.equal("1m 05s");
        expect(formatAgeShort(3_600 * 2 + 60 * 14)).to.equal("2h 14m");
        expect(formatAgeShort(86_400 * 3 + 3_600 * 4)).to.equal("3d 04h");
    });

    it("formatPercentSigned renders a leading + for positives and — for null", () => {
        expect(formatPercentSigned(null)).to.equal("—");
        expect(formatPercentSigned(0)).to.equal("0.00%");
        expect(formatPercentSigned(1.234)).to.equal("+1.23%");
        expect(formatPercentSigned(-2.5)).to.equal("-2.50%");
    });
});
