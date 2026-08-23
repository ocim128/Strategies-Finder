import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData } from "../lib/types/strategies";
import {
    assertFinderAssetDataAtOrBeforeFoldEnd,
    assertFinderAssetDataStrictlyAfterFoldEnd,
    buildFreshFoldScheduleFromDataEnd,
    getFinderAssetOpportunityFreshFoldWindow,
    normalizeFinderAssetFreshFoldSchedule,
    normalizeFinderAssetFoldEnd,
    sliceFinderAssetDataAtFoldEnd,
    sliceFinderAssetDataStrictlyAfterFoldEnd,
    sliceFinderAssetDataWithinFreshFoldWindow,
} from "../lib/finder/finder-asset-opportunity-fold";

function candles(times: number[]): OHLCVData[] {
    return times.map((time, index) => ({
        time,
        open: index + 1,
        high: index + 2,
        low: index,
        close: index + 1,
        volume: 1,
    }));
}

describe("Asset Opportunity point-in-time fold contract", () => {
    it("normalizes an absent or positive finite fold timestamp and rejects invalid values", () => {
        expect(normalizeFinderAssetFoldEnd(undefined)).to.equal(undefined);
        expect(normalizeFinderAssetFoldEnd("1700000000")).to.equal(1_700_000_000);
        expect(normalizeFinderAssetFoldEnd(1_700_000_000)).to.equal(1_700_000_000);
        expect(() => normalizeFinderAssetFoldEnd(0)).to.throw(/positive finite timestamp/);
        expect(() => normalizeFinderAssetFoldEnd("not-a-time")).to.throw(/positive finite timestamp/);
    });

    it("requires the explicit 25-fold stride-12 schedule", () => {
        const schedule = Array.from({ length: 25 }, (_, index) => ({
            holdoutBars: (index + 1) * 12,
            foldEnd: 1_700_000_000 + ((index + 1) * 300),
            oosStart: 1_700_000_000 + ((index + 2) * 300),
            oosEnd: 1_700_000_000 + ((index + 13) * 300),
        }));
        expect(normalizeFinderAssetFreshFoldSchedule(schedule)).to.deep.equal(schedule);
        expect(() => normalizeFinderAssetFreshFoldSchedule(schedule.slice(0, 24)))
            .to.throw(/exactly 25 entries/);
        expect(() => normalizeFinderAssetFreshFoldSchedule(
            schedule.map((entry, index) => index === 1 ? { ...entry, holdoutBars: 13 } : entry),
        )).to.throw(/holdoutBars 24/);
        expect(() => normalizeFinderAssetFreshFoldSchedule(
            schedule.map((entry, index) => index === 1 ? { ...entry, foldEnd: schedule[0]!.foldEnd } : entry),
        )).to.throw(/strictly ascending/);
    });

    it("builds folds with one stride of forward data after the final boundary", () => {
        const timestamps = Array.from({ length: 400 }, (_, index) => 1_700_000_000 + index * 300);
        const schedule = buildFreshFoldScheduleFromDataEnd(timestamps);
        expect(schedule).to.have.length(25);
        expect(schedule[0]).to.deep.equal({
            holdoutBars: 12,
            foldEnd: timestamps[75],
            oosStart: timestamps[76],
            oosEnd: timestamps[87],
        });
        expect(schedule[24]).to.deep.equal({
            holdoutBars: 300,
            foldEnd: timestamps[363],
            oosStart: timestamps[364],
            oosEnd: timestamps[375],
        });
        expect(schedule[1]!.foldEnd).to.equal(timestamps[87]);
        expect(() => buildFreshFoldScheduleFromDataEnd([])).to.throw(/reference series is empty/);
        expect(() => buildFreshFoldScheduleFromDataEnd(timestamps.slice(0, 324)))
            .to.throw(/too short/);
    });

    it("keeps the fold boundary inclusive and makes the forward window strictly later", () => {
        const raw = candles([100, 200, 300, 400]);
        const search = sliceFinderAssetDataAtFoldEnd(raw, 300);
        const forward = sliceFinderAssetDataStrictlyAfterFoldEnd(raw, 300);
        expect(search.map((candle) => candle.time)).to.deep.equal([100, 200, 300]);
        expect(forward.map((candle) => candle.time)).to.deep.equal([400]);
        assertFinderAssetDataAtOrBeforeFoldEnd(search, 300, "search");
        assertFinderAssetDataStrictlyAfterFoldEnd(forward, 300, "forward");
    });

    it("caps only the requested forward window without changing legacy slicing", () => {
        const raw = candles([100, 200, 300, 400, 500]);
        expect(sliceFinderAssetDataStrictlyAfterFoldEnd(raw, 200, 2).map((candle) => candle.time))
            .to.deep.equal([300, 400]);
        expect(sliceFinderAssetDataStrictlyAfterFoldEnd(raw, 200).map((candle) => candle.time))
            .to.deep.equal([300, 400, 500]);
        expect(sliceFinderAssetDataStrictlyAfterFoldEnd(raw, undefined, 2)).to.deep.equal([]);
    });

    it("uses calendar bounds for fresh windows and preserves missing bars", () => {
        const referenceTimestamps = Array.from({ length: 13 }, (_, index) => 100 + index * 100);
        expect(getFinderAssetOpportunityFreshFoldWindow(referenceTimestamps, 100)).to.deep.equal({
            oosStart: 200,
            oosEnd: 1300,
        });
        const raw = candles([200, 300, 1300, 1400]);
        expect(sliceFinderAssetDataWithinFreshFoldWindow(raw, { oosStart: 200, oosEnd: 1300 }).map((candle) => candle.time))
            .to.deep.equal([200, 300, 1300]);
    });

    it("anchors every fold and its forward window to gapped reference bars", () => {
        const timestamps = Array.from({ length: 500 }, (_, index) => 1_700_000_000 + index * 14_400)
            .filter((timestamp) => {
                const day = new Date(timestamp * 1000).getUTCDay();
                return day !== 0 && day !== 6 && timestamp !== 1_704_326_400;
            });
        const schedule = buildFreshFoldScheduleFromDataEnd(timestamps);
        expect(schedule.every((entry) => timestamps.includes(entry.foldEnd))).to.equal(true);
        expect(schedule.every((entry) => {
            const foldIndex = timestamps.indexOf(entry.foldEnd);
            return entry.oosStart === timestamps[foldIndex + 1]
                && entry.oosEnd === timestamps[foldIndex + 12];
        })).to.equal(true);
        expect(schedule.every((entry) =>
            sliceFinderAssetDataWithinFreshFoldWindow(candles(timestamps), entry).length === 12,
        )).to.equal(true);
    });

    it("preserves legacy absent-fold copy semantics", () => {
        const raw = candles([100, 200, 300]);
        const historical = sliceFinderAssetDataAtFoldEnd(raw, undefined);
        const forward = sliceFinderAssetDataStrictlyAfterFoldEnd(raw, undefined);
        expect(historical).to.deep.equal(raw);
        expect(historical).to.not.equal(raw);
        expect(forward).to.deep.equal([]);
    });

    it("matches the positional cutoff on mixed time shapes, duplicate timestamps, and irregular gaps", () => {
        const raw: OHLCVData[] = [
            { ...candles([1_700_000_000])[0]!, time: "2023-11-14T22:13:20.000Z" },
            { ...candles([1_700_000_001])[0]!, time: 1_700_000_001 },
            { ...candles([1_700_000_123])[0]!, time: 1_700_000_123 },
            { ...candles([1_700_000_123])[0]!, time: "2023-11-14T22:15:23.000Z" },
            { ...candles([1_700_100_000])[0]!, time: 1_700_100_000 },
            { ...candles([1_700_200_000])[0]!, time: 1_700_200_000 },
        ];
        const positionalHistorical = raw.slice(0, 5);
        const positionalForward = raw.slice(5);
        expect(sliceFinderAssetDataAtFoldEnd(raw, 1_700_100_000)).to.deep.equal(positionalHistorical);
        expect(sliceFinderAssetDataStrictlyAfterFoldEnd(raw, 1_700_100_000)).to.deep.equal(positionalForward);
    });

    it("fails loudly when a loader hands the iteration post-fold search data", () => {
        expect(() => assertFinderAssetDataAtOrBeforeFoldEnd(candles([100, 300, 400]), 300, "fixture"))
            .to.throw(/contains data after foldEnd 300/);
        expect(() => assertFinderAssetDataStrictlyAfterFoldEnd(candles([300, 400]), 300, "fixture"))
            .to.throw(/contains data at or before foldEnd 300/);
    });

    it("produces disjoint forward windows from the same raw series at two fold ends", () => {
        const raw = candles([100, 200, 300, 400, 500]);
        const first = sliceFinderAssetDataStrictlyAfterFoldEnd(raw, 200);
        const second = sliceFinderAssetDataStrictlyAfterFoldEnd(raw, 400);
        const firstTimes = new Set(first.map((candle) => candle.time));
        const secondTimes = new Set(second.map((candle) => candle.time));
        expect([...firstTimes]).to.deep.equal([300, 400, 500]);
        expect([...secondTimes]).to.deep.equal([500]);
        expect([...firstTimes].filter((time) => secondTimes.has(time))).to.deep.equal([500]);
        expect(first[0]!.time).to.be.greaterThan(200);
        expect(second[0]!.time).to.be.greaterThan(400);
    });
});
