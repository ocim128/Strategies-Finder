/**
 * Service-level tests for Rank Pairs summary, copy contract, and failure
 * preservation.
 *
 * These cover the pure presentation functions exported from
 * rank-pairs-service.ts. They lock the V2 clipboard column contract, verify the
 * summary does not double-count failures, and confirm that failed / no-data
 * rows preserve their actual status and reason instead of being masked as an
 * identical THIN.
 */

import { expect } from "chai";
import { describe, it } from "node:test";
import {
    badgeLabelFor,
    COPY_COLUMNS,
    COPY_HEADER,
    formatCopyText,
    formatOverallSummary,
    prepareRankPairRelationships,
    type RankResult,
} from "../lib/rank-pairs/rank-pairs-service";
import { classifyPairRegime, type PairRegimeResult } from "../lib/rank-pairs/pair-regime-classifier";
import type { OHLCVData, Time } from "../lib/types/strategies";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const DAY = 86_400;
const ANCHOR_INTERVAL_DAYS = 30;
const ANCHOR_SPACING = ANCHOR_INTERVAL_DAYS * DAY;
const TOTAL_ANCHORS = 37;
const FIXED_END = Date.UTC(2025, 0, 15) / 1000;

function candle(t: number, c: number): OHLCVData {
    return { time: t as Time, open: c, high: c, low: c, close: c, volume: 1 };
}

/** Clean BASE / TREND classification result for a valid pair. */
function okTrendResult(symbol: string): RankResult {
    const bars: OHLCVData[] = [];
    for (let i = 0; i < TOTAL_ANCHORS; i++) {
        bars.push(candle(FIXED_END - (TOTAL_ANCHORS - 1 - i) * ANCHOR_SPACING, 100 * Math.pow(1.04, i)));
    }
    const regime = classifyPairRegime(bars);
    regime.symbol = symbol;
    return { symbol, regime, status: "ok" };
}

function noDataResult(symbol: string, reason: PairRegimeResult["reason"] = "INSUFFICIENT_ANCHORS"): RankResult {
    const regime = classifyPairRegime([]);
    regime.reason = reason;
    regime.symbol = symbol;
    return { symbol, regime, status: "no_data" };
}

function failedResult(symbol: string, error: string): RankResult {
    const regime = classifyPairRegime([]);
    regime.symbol = symbol;
    return { symbol, regime, status: "failed", error };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rank-pairs-service — reciprocal relationships", () => {
    it("keeps the first orientation and removes its reciprocal", () => {
        const prepared = prepareRankPairRelationships([
            "SHIB+TRX",
            "TRX+SHIB",
            "DEXE+ETH",
            "ETH+DEXE",
        ]);
        expect(prepared.symbols).to.deep.equal(["SHIB+TRX", "DEXE+ETH"]);
        expect(prepared.reciprocalDuplicates).to.equal(2);
        expect(prepared.selfPairs).to.equal(0);
    });

    it("does not merge different relationships", () => {
        const prepared = prepareRankPairRelationships([
            "BTC+ETH",
            "BTC+SOL",
            "ETH+SOL",
        ]);
        expect(prepared.symbols).to.deep.equal(["BTC+ETH", "BTC+SOL", "ETH+SOL"]);
        expect(prepared.reciprocalDuplicates).to.equal(0);
    });

    it("removes self-pairs without counting them as reciprocal duplicates", () => {
        const prepared = prepareRankPairRelationships([
            "BTC+BTC",
            "ETH+BTC",
            "BTC+ETH",
            "ETH+ETH",
        ]);
        expect(prepared.symbols).to.deep.equal(["ETH+BTC"]);
        expect(prepared.reciprocalDuplicates).to.equal(1);
        expect(prepared.selfPairs).to.equal(2);
    });
});

describe("rank-pairs-service — summary", () => {
    it("counts direction and structure only from ok rows", () => {
        const results = [
            okTrendResult("A"),
            okTrendResult("B"),
            noDataResult("C"),
            failedResult("D", "boom"),
        ];
        const summary = formatOverallSummary(results);
        // A and B are the only ok rows; both are BASE / TREND.
        expect(summary).to.include("Pairs 4");
        expect(summary).to.include("BASE 2");
        expect(summary).to.include("TREND 2");
    });

    it("does not double-count failed rows as THIN", () => {
        const results = [
            okTrendResult("A"),
            noDataResult("B"),
            noDataResult("C"),
            failedResult("D", "network"),
        ];
        const summary = formatOverallSummary(results);
        // NODATA counts the two no_data rows; FAILED counts the one failed row.
        // Neither is folded into THIN (the old behavior double-counted).
        expect(summary).to.include("NODATA 2");
        expect(summary).to.include("FAILED 1");
        // BASE is 1 (only A is ok).
        expect(summary).to.include("BASE 1");
    });

    it("reports structure counts in the summary", () => {
        const results = [okTrendResult("A"), okTrendResult("B")];
        const summary = formatOverallSummary(results);
        // Both classify as TREND on the strong exponential fixture.
        expect(summary).to.include("TREND 2");
        // All structure fields are present.
        expect(summary).to.include("OSC");
        expect(summary).to.include("TRANS");
        expect(summary).to.include("REV");
        expect(summary).to.include("MIXED");
    });
});

describe("rank-pairs-service — V2 copy contract", () => {
    it("uses the RANK_PAIRS_V2 header and a column-name second line", () => {
        const text = formatCopyText([okTrendResult("A")]);
        const lines = text.split("\n");
        expect(lines[0]).to.equal(COPY_HEADER);
        expect(lines[1]).to.equal(COPY_COLUMNS.join(" | "));
        // One data row follows.
        expect(lines.length).to.equal(3);
    });

    it("every data row has exactly as many pipe fields as COPY_COLUMNS", () => {
        const results = [
            okTrendResult("A"),
            noDataResult("B"),
            failedResult("C", "load error"),
        ];
        const text = formatCopyText(results);
        const lines = text.split("\n");
        const expectedCols = COPY_COLUMNS.length;
        // lines 0 (header) and 1 (columns) are not data rows.
        for (let i = 2; i < lines.length; i++) {
            const fields = lines[i].split(" | ");
            expect(fields.length, `row ${i} field count`).to.equal(expectedCols);
        }
    });

    it("includes STATUS and ERROR columns so failed rows preserve the load error", () => {
        const statusIdx = COPY_COLUMNS.indexOf("STATUS");
        const errorIdx = COPY_COLUMNS.indexOf("ERROR");
        expect(statusIdx).to.be.gte(0);
        expect(errorIdx).to.be.gte(0);

        const text = formatCopyText([failedResult("Z", "404 not found")]);
        const dataRow = text.split("\n")[2].split(" | ");
        expect(dataRow[statusIdx]).to.equal("failed");
        expect(dataRow[errorIdx]).to.equal("404 not found");
    });

    it("a no_data row carries its actual reason, not a generic THIN mask", () => {
        const reasonIdx = COPY_COLUMNS.indexOf("REASON");
        const statusIdx = COPY_COLUMNS.indexOf("STATUS");
        const text = formatCopyText([noDataResult("X", "ZERO_VARIANCE")]);
        const dataRow = text.split("\n")[2].split(" | ");
        expect(dataRow[statusIdx]).to.equal("no_data");
        expect(dataRow[reasonIdx]).to.equal("ZERO_VARIANCE");
    });

    it("an ok row has status ok, reason OK, and an empty ERROR field", () => {
        const statusIdx = COPY_COLUMNS.indexOf("STATUS");
        const reasonIdx = COPY_COLUMNS.indexOf("REASON");
        const errorIdx = COPY_COLUMNS.indexOf("ERROR");
        const text = formatCopyText([okTrendResult("A")]);
        const dataRow = text.split("\n")[2].split(" | ");
        expect(dataRow[statusIdx]).to.equal("ok");
        expect(dataRow[reasonIdx]).to.equal("OK");
        expect(dataRow[errorIdx]).to.equal("");
    });
});

describe("rank-pairs-service — badge label surfaces reasons", () => {
    it("ok rows show the combined DIRECTION / STRUCTURE label", () => {
        const r = okTrendResult("A");
        expect(badgeLabelFor(r)).to.equal(r.regime.label);
    });

    it("no_data rows show THIN plus the actual reason, not a bare THIN / THIN", () => {
        const r = noDataResult("X", "INSUFFICIENT_ANCHORS");
        expect(badgeLabelFor(r)).to.equal("THIN (INSUFFICIENT_ANCHORS)");
    });

    it("failed rows show FAIL", () => {
        const r = failedResult("Y", "timeout");
        expect(badgeLabelFor(r)).to.equal("FAIL");
    });
});

describe("rank-pairs-service — failure isolation in copy ordering", () => {
    it("failed and no_data rows sort after every ok regime result", () => {
        const results = [
            failedResult("FAIL-A", "err"),
            noDataResult("THIN-A"),
            okTrendResult("OK-A"),
        ];
        const text = formatCopyText(results);
        const dataLines = text.split("\n").slice(2); // drop header + columns
        const statusIdx = COPY_COLUMNS.indexOf("STATUS");
        const statuses = dataLines.map((l) => l.split(" | ")[statusIdx]);
        // The ok row must come first; failed/no_data after.
        expect(statuses[0]).to.equal("ok");
        expect(statuses.slice(1).sort()).to.deep.equal(["failed", "no_data"]);
    });
});
