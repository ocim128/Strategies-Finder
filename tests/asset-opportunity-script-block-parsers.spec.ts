/**
 * Regression coverage for the Asset Opportunity analyzer block parsers.
 *
 * Every analyzer reads append-only `oos-holdout-<N>-bars.txt` archives whose
 * `=`-separated header carries a fixed core plus optional forward-measurement /
 * baseline / epoch / pool-distribution lines, followed by the JSON row body.
 * The body is the LAST capture group of each `BLOCK_PATTERN`; when the optional
 * header groups were appended to the pattern, three scripts kept a stale body
 * index, so `JSON.parse(undefined)` threw inside their try/catch and every
 * block — legacy ones included — was silently skipped (a report that looked
 * empty instead of failing).
 *
 * These specs pin the contract per script: a legacy block (core header only)
 * and an enriched block (every optional header line that script accepts) must
 * both parse to the same rows, the body must be valid JSON with the expected
 * row count, and a legacy+enriched file must contribute rows from BOTH blocks.
 */
import { expect } from "chai";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BLOCK_PATTERN as negativeEdgePattern, parseBlocks as parseNegativeEdgeBlocks } from "../scripts/analyze-asset-opportunity-negative-edge";
import { BLOCK_PATTERN as recentFormPattern, loadFiles as loadRecentFormFiles } from "../scripts/analyze-asset-opportunity-recent-form";
import { BLOCK_PATTERN as stabilityPattern, parseBlocks as parseStabilityBlocks } from "../scripts/analyze-asset-opportunity-stability";
import { BLOCK_PATTERN as customSortsPattern, loadFiles as loadCustomSortsFiles } from "../scripts/analyze-asset-opportunity-custom-sorts";

const SEPARATOR = "=".repeat(80);
const HOLDOUT_BARS = 12;
const SORT_METRIC = "averageGain";

const BASELINE = {
    eligibleCandidateCount: 2,
    horizons: [{ bars: HOLDOUT_BARS, averagePnlPercent: 0.4 }],
};
const POOL_DISTRIBUTION = {
    eligibleCandidateCount: 2,
    horizons: [{ bars: HOLDOUT_BARS, observedResults: 2, totalSamples: 2, p10: -1.5, p50: 0.4, p90: 2.1 }],
    selection: {},
};

function makeRow(rank: number, symbol: string): Record<string, unknown> {
    return {
        rank,
        symbol,
        strategyId: `strategy_${symbol}`,
        candidateFingerprint: `fp_${symbol}`,
        selectionPerformance: {
            avgTrade: 1.2,
            avgLoss: -0.4,
            avgWin: 1.6,
            winRate: 60,
            totalTrades: 20,
            netProfit: 120,
            maxDrawdownPercent: 8,
        },
        forwardOosPerformance: { horizons: [{ bars: HOLDOUT_BARS, pnlPercent: 1.1, sampleSize: 5 }] },
    };
}

const ROWS = [makeRow(1, "AAA"), makeRow(2, "BBB")];
const OTHER_ROWS = [makeRow(1, "CCC"), makeRow(2, "DDD")];

/**
 * Build one archive block exactly like `buildAssetOpportunityArchiveBlockText`
 * (the writer ends the block with a single `\n` after the JSON body).
 */
function buildBlock(optionalLines: readonly string[], rows: readonly unknown[] = ROWS): string {
    return [
        SEPARATOR,
        "Timestamp: 2026-09-26T00:00:00.000Z",
        "Batch run id: fixture-run",
        `OOS holdout: ${HOLDOUT_BARS} bars`,
        `Archive sort: ${SORT_METRIC}`,
        ...optionalLines,
        SEPARATOR,
        JSON.stringify(rows),
        "",
    ].join("\n");
}

/** Every block body in `text`: the LAST capture group of `pattern`. */
function bodiesOf(pattern: RegExp, text: string): string[] {
    return [...text.matchAll(pattern)].map((match) => match[match.length - 1] ?? "");
}

/** Run a file-based `loadFiles` against a throwaway archive directory. */
function withTempArchive<T>(text: string, run: (dir: string) => T): T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-block-parser-"));
    try {
        fs.writeFileSync(path.join(dir, `oos-holdout-${HOLDOUT_BARS}-bars.txt`), text);
        return run(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// Optional header lines each pattern accepts, in the pattern's own order. A
// script that does not accept `Forward measurement` must not be fed it, or the
// whole block fails to match.
const OPTIONAL_LINES = {
    negativeEdge: [
        `Archive baseline: ${JSON.stringify(BASELINE)}`,
        "Archive epoch: 2026-09-26-selection-correction",
        `Archive pool distribution: ${JSON.stringify(POOL_DISTRIBUTION)}`,
    ],
    recentForm: [
        "Forward measurement: fixed_horizon",
        `Archive baseline: ${JSON.stringify(BASELINE)}`,
        `Next-exit archive baseline: ${JSON.stringify(BASELINE)}`,
        "Archive epoch: 2026-09-26-selection-correction",
        `Archive pool distribution: ${JSON.stringify(POOL_DISTRIBUTION)}`,
    ],
    stability: [
        "Forward measurement: fixed_horizon",
        `Archive baseline: ${JSON.stringify(BASELINE)}`,
        `Archive baseline by basis: ${JSON.stringify({ pair: BASELINE })}`,
        `Next-exit archive baseline: ${JSON.stringify(BASELINE)}`,
        "Archive epoch: 2026-09-26-selection-correction",
        `Archive pool distribution: ${JSON.stringify(POOL_DISTRIBUTION)}`,
    ],
    customSorts: [
        "Forward measurement: fixed_horizon",
        `Archive baseline: ${JSON.stringify(BASELINE)}`,
        `Next-exit archive baseline: ${JSON.stringify(BASELINE)}`,
        "Archive epoch: 2026-09-26-selection-correction",
        `Archive pool distribution: ${JSON.stringify(POOL_DISTRIBUTION)}`,
    ],
} as const;

interface ScriptCase {
    name: string;
    pattern: RegExp;
    optionalLines: readonly string[];
    /** Rows the script's real parser extracts from one file's text. */
    parse: (text: string) => unknown[];
}

const CASES: ScriptCase[] = [
    {
        name: "analyze-asset-opportunity-negative-edge",
        pattern: negativeEdgePattern,
        optionalLines: OPTIONAL_LINES.negativeEdge,
        parse: (text) => parseNegativeEdgeBlocks(text, HOLDOUT_BARS).flatMap((block) => block.rows),
    },
    {
        name: "analyze-asset-opportunity-recent-form",
        pattern: recentFormPattern,
        optionalLines: OPTIONAL_LINES.recentForm,
        parse: (text) => withTempArchive(text, (dir) => [...loadRecentFormFiles(dir)[0]!.candidates.values()]),
    },
    {
        name: "analyze-asset-opportunity-stability",
        pattern: stabilityPattern,
        optionalLines: OPTIONAL_LINES.stability,
        parse: (text) => parseStabilityBlocks(text, HOLDOUT_BARS).flatMap((block) => block.rows),
    },
    {
        name: "analyze-asset-opportunity-custom-sorts",
        pattern: customSortsPattern,
        optionalLines: OPTIONAL_LINES.customSorts,
        parse: (text) => withTempArchive(text, (dir) => loadCustomSortsFiles(dir)[0]!.rows),
    },
];

for (const scriptCase of CASES) {
    describe(`${scriptCase.name} block parser`, () => {
        it("captures a legacy block's body as valid JSON with the expected rows", () => {
            const bodies = bodiesOf(scriptCase.pattern, buildBlock([]));
            expect(bodies).to.have.length(1);
            const parsed = JSON.parse(bodies[0]!) as unknown[];
            expect(parsed).to.have.length(ROWS.length);
            expect(parsed).to.deep.equal(ROWS);
        });

        it("captures an enriched block's body as valid JSON with the same rows", () => {
            const bodies = bodiesOf(scriptCase.pattern, buildBlock(scriptCase.optionalLines));
            expect(bodies).to.have.length(1);
            const parsed = JSON.parse(bodies[0]!) as unknown[];
            expect(parsed).to.have.length(ROWS.length);
            expect(parsed).to.deep.equal(ROWS);
        });

        it("parses a legacy and an enriched block to the same rows", () => {
            const legacyRows = scriptCase.parse(buildBlock([]));
            const enrichedRows = scriptCase.parse(buildBlock(scriptCase.optionalLines));
            expect(legacyRows).to.have.length(ROWS.length);
            expect(legacyRows).to.deep.equal(ROWS);
            expect(enrichedRows).to.deep.equal(legacyRows);
        });

        it("does not silently skip either block when legacy and enriched blocks are concatenated", () => {
            // The original defect dropped EVERY block (legacy included) because
            // JSON.parse(undefined) threw. Distinct rows per block prove both
            // contributed, so a file with mixed block kinds never reads empty.
            const text = buildBlock([]) + buildBlock(scriptCase.optionalLines, OTHER_ROWS);
            const rows = scriptCase.parse(text);
            expect(rows).to.have.length(ROWS.length * 2);
        });
    });
}
