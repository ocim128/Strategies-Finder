/**
 * Unit tests for the shared MarketCap preflight leaf
 * (`lib/ibkr-data/marketcap-preflight.ts`) used by BOTH server-side cap-tilt
 * consumers: the standalone OPEN_SCORE USD route and the TOP_MEAN coordinator.
 *
 * Locked contracts (audit centralize-preflight + fail-closed + provenance
 * findings):
 *  - a missing/empty dataset directory fails with the actionable download
 *    message (previously duplicated in the two callers);
 *  - CSVs that exist but contain zero valid rows FAIL instead of silently
 *    indexing zero symbols and degrading every cap lookup to weight 1;
 *  - coverage accounting (requested/loaded/missing, latest row, catalog time)
 *    is computed once, through the shared symbol normalizer;
 *  - `formatMarketCapProvenanceLines` emits the report provenance line and
 *    the staleness warning when the newest cap row trails the run's data
 *    window by more than MARKETCAP_STALE_WARNING_MS (weighting semantics are
 *    unchanged — the warning is observability only).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    formatMarketCapProvenanceLines,
    loadMarketCapPreflight,
    MARKETCAP_STALE_WARNING_MS,
    resolveDefaultMarketCapDir,
} from "../lib/ibkr-data/marketcap-preflight";

const DAY_MS = 24 * 60 * 60 * 1000;
const dateSec = (date: string): number => Math.floor(Date.parse(`${date}T00:00:00.000Z`) / 1000);

function makeDir(): string {
    return mkdtempSync(join(tmpdir(), "mktcap-preflight-"));
}

function writeValidCsv(dir: string, name: string, dates: string[]): void {
    writeFileSync(
        join(dir, name),
        [
            "time,close,shares_outstanding,market_cap",
            ...dates.map((date) => `${date},100,1000000,100000000`),
        ].join("\n"),
    );
}

describe("loadMarketCapPreflight", () => {
    it("reports coverage, missing symbols, latest row, and catalog time", () => {
        const dir = makeDir();
        try {
            writeValidCsv(dir, "AAA.csv", ["2026-01-02", "2026-01-06"]);
            writeValidCsv(dir, "BBB.csv", ["2026-01-03"]);
            writeFileSync(join(dir, "catalog.json"), JSON.stringify({ updatedAt: "2026-01-07T00:00:00.000Z" }));

            const preflight = loadMarketCapPreflight(dir, ["AAA", "BBB", "CCC", "aaa"]);
            assert.equal(preflight.requestedSymbols, 3, "requested symbols are deduped through the shared normalizer");
            assert.equal(preflight.loadedSymbols, 2);
            assert.deepEqual(preflight.missingSymbols, ["CCC"]);
            assert.equal(preflight.latestDataTimeSec, dateSec("2026-01-06"));
            assert.equal(preflight.catalogUpdatedAt, "2026-01-07T00:00:00.000Z");
            // Individual missing symbols keep the weight-1 fallback contract.
            assert.equal(preflight.lookup.lookup("CCC", dateSec("2026-01-06")), null);
            assert.equal(preflight.lookup.lookup("AAA", dateSec("2026-01-06")), 100000000);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("fails with the download message when the dataset directory is missing or empty", () => {
        const missingDir = join(makeDir(), "does-not-exist");
        assert.throws(
            () => loadMarketCapPreflight(missingDir, ["AAA"]),
            /requires the market-cap dataset.*missing or empty.*Download MarketCap/s,
        );

        const emptyDir = makeDir();
        try {
            assert.throws(
                () => loadMarketCapPreflight(emptyDir, ["AAA"]),
                /missing or empty/,
            );
        } finally {
            rmSync(emptyDir, { recursive: true, force: true });
        }
    });

    it("fails closed when CSVs exist but contain no valid rows (audit fail-closed finding)", () => {
        const dir = makeDir();
        try {
            // A malformed body and a header-only file both pass the old
            // "any .csv exists" check while indexing zero symbols.
            writeFileSync(join(dir, "BAD.csv"), "this is not csv at all\n");
            writeFileSync(join(dir, "EMPTY.csv"), "time,close,shares_outstanding,market_cap\n");
            mkdirSync(join(dir, "nested"), { recursive: true });
            assert.throws(
                () => loadMarketCapPreflight(dir, ["AAA"]),
                /contain no valid rows.*Redownload MarketCap/s,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("formatMarketCapProvenanceLines", () => {
    it("emits the coverage line and only warns when the dataset trails the data window", () => {
        const dir = makeDir();
        try {
            writeValidCsv(dir, "AAA.csv", ["2026-01-02", "2026-01-06"]);
            const preflight = loadMarketCapPreflight(dir, ["AAA"]);

            const fresh = formatMarketCapProvenanceLines(preflight, {
                windowEndTimeSec: dateSec("2026-01-10"),
            });
            assert.equal(fresh.length, 1);
            assert.match(fresh[0]!, /marketcap dataset \| requested=1 loaded=1 missing=0 latest=2026-01-06/);
            assert.match(fresh[0]!, /catalogUpdatedAt=none/);

            // The newest cap row is 40 days behind the run's data window:
            // the warning must say so explicitly.
            const stale = formatMarketCapProvenanceLines(preflight, {
                windowEndTimeSec: dateSec("2026-01-06") + Math.round(MARKETCAP_STALE_WARNING_MS / 1000) + 10 * DAY_MS / 1000,
            });
            assert.equal(stale.length, 2);
            assert.match(stale[1]!, /WARN: marketcap latest row \(2026-01-06\).*more than 30 days older than the latest data bar/);

            // Without a window reference the warning compares against `now`.
            const staleVsNow = formatMarketCapProvenanceLines(preflight, {
                nowMs: dateSec("2026-01-06") * 1000 + MARKETCAP_STALE_WARNING_MS + DAY_MS,
            });
            assert.equal(staleVsNow.length, 2);
            assert.match(staleVsNow[1]!, /older than today/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("lists missing symbols on a dedicated line, capped for very large lists", () => {
        const dir = makeDir();
        try {
            writeValidCsv(dir, "AAA.csv", ["2026-01-02"]);
            const preflight = loadMarketCapPreflight(
                dir,
                Array.from({ length: 20 }, (_, i) => (i === 0 ? "AAA" : `MISS${i}`)),
            );
            const lines = formatMarketCapProvenanceLines(preflight);
            assert.match(lines[0]!, /requested=20 loaded=1 missing=19/);
            assert.match(lines[1]!, /marketcap missing \| 19 requested symbol\(s\)/);
            assert.match(lines[1]!, /…$/, "very large missing lists are truncated with an ellipsis");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("resolveDefaultMarketCapDir", () => {
    it("keeps the process.cwd()-rooted price-data convention", () => {
        // Path.resolve drives the result, so compare platform-normalized.
        const normalized = resolveDefaultMarketCapDir("/srv/root").replace(/\\/g, "/");
        assert.match(normalized, /\/srv\/root\/price-data\/ibkr\/marketcap$/);
        assert.match(
            resolveDefaultMarketCapDir().replace(/\\/g, "/"),
            /\/price-data\/ibkr\/marketcap$/,
        );
    });
});
