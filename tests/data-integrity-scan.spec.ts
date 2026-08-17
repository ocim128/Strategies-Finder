import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    extractValidTimestampsFromCsvPayload,
    scanDataIntegrity,
    summarizeDataIntegrity,
} from "../lib/market-data/data-integrity-scan";

const T30 = 30 * 60;
const NOW = 1_800_000_000;

function csv(rows: Array<[number, number, number, number, number, number]>): string {
    return [
        "time,open,high,low,close,volume",
        ...rows.map(([time, open, high, low, close, volume]) => `${new Date(time * 1000).toISOString()},${open},${high},${low},${close},${volume}`),
    ].join("\n");
}

function row(time: number, close = 100, volume = 100): [number, number, number, number, number, number] {
    return [time, close, close + 1, close - 1, close, volume];
}

function scanFixture(
    symbol: string,
    payload: string,
    options: Parameters<typeof scanDataIntegrity>[2],
) {
    const directory = mkdtempSync(join(tmpdir(), "data-integrity-scan-"));
    const path = join(directory, `${symbol}.csv`);
    try {
        writeFileSync(path, payload, "utf8");
        return scanDataIntegrity(symbol, readFileSync(path, "utf8"), options);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

describe("data integrity scan", () => {
    it("classifies stale tails, large gaps, duplicate timestamps, and non-monotonic rows", () => {
        const stale = scanFixture("STALE", csv([row(NOW - 8 * 86_400)]), { nowTimestamp: NOW });
        assert.equal(stale.verdict, "WARN");
        assert.equal(stale.lastBarAgeDays, 8);

        const criticallyStale = scanFixture("CRITICALLY_STALE", csv([row(NOW - 31 * 86_400)]), { nowTimestamp: NOW });
        assert.equal(criticallyStale.verdict, "BLOCK");

        const gap = scanFixture("GAP", csv([row(NOW - 10 * 86_400), row(NOW - 10 * 86_400 + 80 * T30)]), { nowTimestamp: NOW });
        assert.equal(gap.verdict, "WARN");
        assert.equal(gap.maxGapBars, 80);

        const duplicate = scanFixture("DUP", csv([row(NOW - 2 * T30), row(NOW - 2 * T30), row(NOW - T30)]), { nowTimestamp: NOW });
        assert.equal(duplicate.duplicateTimestamps, 1);
        assert.equal(duplicate.verdict, "WARN");

        const nonMonotonic = scanFixture("ORDER", csv([row(NOW - T30), row(NOW - 3 * T30), row(NOW - 2 * T30)]), { nowTimestamp: NOW });
        assert.equal(nonMonotonic.nonMonotonic, true);
        assert.equal(nonMonotonic.verdict, "BLOCK");
    });

    it("flags a low-volume split jump but leaves a proportionally high-volume move unflagged", () => {
        const lowVolumeJump = scanFixture("JUMP", csv([
            row(NOW - 2 * T30, 100, 100),
            row(NOW - T30, 140, 100),
        ]), { nowTimestamp: NOW });
        assert.equal(lowVolumeJump.splitJumpCandidates, 1);
        assert.equal(lowVolumeJump.verdict, "WARN");

        const highVolumeJump = scanFixture("BENIGN", csv([
            row(NOW - 2 * T30, 100, 100),
            row(NOW - T30, 140, 200),
        ]), { nowTimestamp: NOW });
        assert.equal(highVolumeJump.splitJumpCandidates, 0);
        assert.equal(highVolumeJump.verdict, "PASS");
    });

    it("uses the requested history-depth cohorts and blocks empty or unparsable files", () => {
        const rows: Array<[number, number, number, number, number, number]> = [];
        for (let index = 0; index < 2_000; index += 1) rows.push(row(NOW - index * T30));
        const depth = scanFixture("DEPTH", csv(rows), { nowTimestamp: NOW });
        assert.equal(depth.barCount, 2_000);
        assert.equal(depth.historyDepthCohort, "2k-5k");

        const empty = scanFixture("EMPTY", "time,open,high,low,close,volume\n", { nowTimestamp: NOW });
        assert.equal(empty.verdict, "BLOCK");

        const malformed = scanFixture("BAD", "time,open,high,low,close,volume\nnot-a-time,1,2,0,1,100\n", { nowTimestamp: NOW });
        assert.equal(malformed.unparsableRows, 1);
        assert.equal(malformed.verdict, "BLOCK");
    });

    it("reports quote overlap and promotes a universe freshness lag to WARN", () => {
        const currentTime = NOW - 1 * 86_400;
        const staleTime = currentTime - 3 * 86_400;
        const quotePayload = csv([row(currentTime), row(currentTime + T30)]);
        const quoteTimes = new Set(extractValidTimestampsFromCsvPayload(quotePayload));
        const current = scanFixture("CURRENT", quotePayload, {
            nowTimestamp: NOW,
            quoteTimestampSets: new Map([["SPY", quoteTimes]]),
        });
        const stale = scanFixture("LAGGING", csv([row(staleTime), row(staleTime + T30)]), {
            nowTimestamp: NOW,
            quoteTimestampSets: new Map([["SPY", quoteTimes]]),
        });
        assert.equal(current.overlapWithQuotes[0]?.coveragePercent, 100);
        // Overlap is informational-only (extended-hours asymmetry); staleness
        // is carried by the universe freshness spread, asserted below.
        assert.equal(stale.overlapWithQuotes[0]?.warning, false);

        const summary = summarizeDataIntegrity([current, stale]);
        const lagging = summary.scans.find((scan) => scan.symbol === "LAGGING");
        assert.equal(summary.verdict, "WARN");
        assert.equal(lagging?.universeFreshnessSpreadDays, 3);
        assert.equal(lagging?.verdict, "WARN");
    });
});
