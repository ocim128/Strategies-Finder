import { expect } from "chai";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { __testInternals } from "../lib/local-sqlite-vite-plugin";
import { projectStabilityRowToSnapshot } from "../lib/batch-backtest/mine-timing-persistence";
import { buildTimingEdgeReport } from "../lib/finder/timing-edge-report";
import type { BatchStabilityRow } from "../lib/batch-backtest/batch-stability-mine";

/**
 * End-to-end persistence contract (Finding 7).
 *
 * Intent being locked (AGENTS.md rule 8): no focused test proved the complete
 * contract — Batch projection → SQLite normalization/load → Asset Leadership
 * reducer. Existing tests separately validate SQLite placeholder counts and
 * report reduction, but a field lost during projection, a case-normalization
 * drift, a null-conversion error, or a persistence-source mistake could pass
 * both suites independently. This test stores a representative Stability
 * snapshot through the actual plugin store handler, loads it back through the
 * actual load + normalization path, feeds the result into buildTimingEdgeReport,
 * and asserts direction, score, diversity, timestamp, close, strongest pair,
 * and freshness survive the round trip. Includes a null-optional-field row and
 * a SHORT row so the contract covers both directions and the null-sentinel
 * handling (SQL NULL → null, NOT 0).
 */
describe("mine-timing persistence end-to-end contract (Finding 7)", () => {
    const { storeMineTimingRunInDb, loadMineTimingRunsFromDb, setSqliteDbForTests, resetSqliteDbForTests } = __testInternals;

    function createTempDb(): DatabaseSync {
        const dbPath = join(tmpdir(), `sf-mine-timing-contract-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
        const db = new DatabaseSync(dbPath);
        db.exec(`
            CREATE TABLE IF NOT EXISTS mine_timing_runs (
                run_id TEXT NOT NULL PRIMARY KEY,
                created_at INTEGER NOT NULL,
                interval TEXT NOT NULL,
                strategy_key TEXT NOT NULL,
                source TEXT NOT NULL,
                pair_count INTEGER NOT NULL,
                reruns INTEGER NOT NULL DEFAULT 0,
                subset_size INTEGER NOT NULL DEFAULT 0,
                seed INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS mine_timing_verdicts (
                run_id TEXT NOT NULL,
                run_created_at INTEGER NOT NULL,
                interval TEXT NOT NULL,
                asset TEXT NOT NULL,
                verdict TEXT NOT NULL,
                direction TEXT,
                confidence TEXT NOT NULL,
                timing_edge_score REAL NOT NULL DEFAULT 0,
                median_diversity REAL NOT NULL DEFAULT 0,
                dominant_pair TEXT,
                dominant_pair_share REAL NOT NULL DEFAULT 0,
                close REAL,
                median_bars_held REAL,
                agreement_transition REAL,
                as_of_time_key TEXT,
                horizon_bars INTEGER,
                longest_horizon_bars INTEGER,
                expected_forward_return_pct REAL,
                oos_lift_pct REAL,
                longest_oos_forward_return_pct REAL,
                expected_mfe_pct REAL,
                expected_mae_pct REAL,
                median_lift_pct REAL,
                median_rr REAL,
                median_hmax_lift_pct REAL,
                median_dist REAL,
                analog_count INTEGER,
                candidate_count INTEGER,
                pair_warnings INTEGER NOT NULL DEFAULT 0,
                hits INTEGER NOT NULL DEFAULT 0,
                high INTEGER NOT NULL DEFAULT 0,
                medium INTEGER NOT NULL DEFAULT 0,
                low INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(run_id, asset, verdict)
            );
        `);
        return db;
    }

    function makeStabilityRow(overrides: Partial<BatchStabilityRow> & { asset: string; direction: "LONG" | "SHORT" }): BatchStabilityRow {
        return {
            hits: 6,
            high: 4,
            medium: 2,
            low: 0,
            medianRetPct: 3.5,
            medianLiftPct: 5.2,
            medianRr: 2.1,
            medianDist: 0.8,
            medianHmaxLiftPct: 9.4,
            pairWarnings: 0,
            timingEdgeScore: 67,
            medianDiversity: 0.77,
            asOfTimeKey: "2026-07-12T10:00:00Z",
            close: 123.45,
            medianBarsHeld: 4,
            agreementTransition: 1,
            freshHits: 3,
            dominantPair: "WLD+HYPE",
            dominantPairShare: 0.5,
            ...overrides,
        };
    }

    it("preserves direction, score, diversity, timestamp, close, strongest pair, and freshness across the store→load→report round trip", () => {
        const db = createTempDb();
        setSqliteDbForTests(db);
        try {
            const interval = "1h";
            // Two rows: a fully-populated LONG and a SHORT with null optional
            // fields (thin OOS data — the null-sentinel contract matters here).
            const longRow = makeStabilityRow({ asset: "WLD", direction: "LONG" });
            const shortRow = makeStabilityRow({
                asset: "PEPE",
                direction: "SHORT",
                timingEdgeScore: 30,
                medianLiftPct: null,
                medianRr: null,
                medianHmaxLiftPct: null,
                medianDist: null,
                medianDiversity: 0.4,
                dominantPair: "PEPE+DOGE",
                dominantPairShare: 0.6,
                close: 0.0012,
                asOfTimeKey: "2026-07-12T10:00:00Z",
                hits: 5,
                high: 2,
                medium: 3,
                low: 0,
            });

            // Batch projection: projectStabilityRowToSnapshot is the exact
            // function batch-backtest-service.ts calls before storeMineTimingRun.
            const verdicts = [longRow, shortRow].map(projectStabilityRowToSnapshot);

            // Store through the actual plugin store handler.
            storeMineTimingRunInDb({
                runId: "run-e2e-1",
                createdAt: Date.parse("2026-07-12T11:00:00Z"),
                interval,
                strategyKey: "rolling_vwap_center",
                source: "stability",
                pairCount: 100,
                reruns: 25,
                subsetSize: 200,
                seed: 1,
                verdicts,
            });

            // Load back through the actual plugin load + normalization path.
            const loaded = loadMineTimingRunsFromDb(50);
            expect(loaded).to.have.length(1);
            const loadedRun = loaded[0]!;
            expect(loadedRun.runId).to.equal("run-e2e-1");
            expect(loadedRun.source).to.equal("stability");
            expect(loadedRun.interval).to.equal(interval);
            expect(loadedRun.verdicts).to.have.length(2);

            // Feed into the Asset Leadership reducer.
            const nowMs = Date.parse("2026-07-12T11:30:00Z");
            const report = buildTimingEdgeReport({ runs: loaded, nowMs });

            // Both directions landed in their own Triggers section.
            const wldLong = report.longTriggers.find((r) => r.asset === "WLD");
            const pepeShort = report.shortTriggers.find((r) => r.asset === "PEPE");
            expect(wldLong, "WLD LONG must survive the round trip into Long Triggers").to.not.equal(undefined);
            expect(pepeShort, "PEPE SHORT must survive the round trip into Short Triggers").to.not.equal(undefined);

            // Score and diversity survive (multiplicative score, not a sum that
            // could mask a single lost field).
            expect(wldLong!.score).to.equal(67);
            expect(wldLong!.latestDiversity).to.be.closeTo(0.77, 1e-9);

            // Close (price) and timestamp survive — case-normalized on store,
            // restored to camelCase on load.
            expect(wldLong!.latestClose).to.be.closeTo(123.45, 1e-9);
            expect(wldLong!.latestAsOfTimeKey).to.equal("2026-07-12T10:00:00Z");

            // Strongest pair survived uppercase normalization on store.
            expect(wldLong!.strongestPair).to.equal("WLD+HYPE");
            expect(pepeShort!.strongestPair).to.equal("PEPE+DOGE");

            // Freshness: data is 0.5h old at 1h interval → lag 0.5 bars ≤ 2 →
            // not stale. First appearance → NEW (Finding 2's lag gate passes).
            expect(wldLong!.freshness).to.equal("NEW");

            // Null-sentinel contract: the SHORT row's null optional fields
            // (medianLiftPct, medianRr, etc.) must round-trip as null, NOT 0.
            // `Number(null) === 0` would silently collapse a SQL NULL to 0 on
            // the load path and break downstream `??` fallbacks.
            const pepeVerdict = loadedRun.verdicts.find((v) => v.asset === "PEPE")!;
            expect(pepeVerdict.medianLiftPct).to.equal(null);
            expect(pepeVerdict.medianRr).to.equal(null);
            expect(pepeVerdict.medianHmaxLiftPct).to.equal(null);
            expect(pepeVerdict.medianDist).to.equal(null);
            // Non-null fields on the same row survive.
            expect(pepeVerdict.timingEdgeScore).to.equal(30);
            expect(pepeVerdict.close).to.be.closeTo(0.0012, 1e-9);
            expect(pepeVerdict.medianDiversity).to.be.closeTo(0.4, 1e-9);
        } finally {
            resetSqliteDbForTests();
            try { db.close(); } catch { /* temp file */ }
        }
    });

    it("case-normalizes asset, verdict, and dominant_pair on store and restores them on load", () => {
        const db = createTempDb();
        setSqliteDbForTests(db);
        try {
            // Project lowercases direction ("long"/"short"); the store must
            // uppercase asset + verdict + dominant_pair, and the load path
            // must restore the snapshot shape the reducer expects.
            const row = makeStabilityRow({
                asset: "btc",
                direction: "LONG",
                dominantPair: "btc+eth",
            });
            const verdicts = [row].map(projectStabilityRowToSnapshot);
            // The projection keeps asset/verdict as-is from the row; the store
            // uppercases them. Verify the store normalization happened.
            expect(verdicts[0]!.asset).to.equal("btc");
            storeMineTimingRunInDb({
                runId: "run-case-1",
                createdAt: 1,
                interval: "1h",
                strategyKey: "s",
                source: "stability",
                pairCount: 1,
                reruns: 1,
                subsetSize: 1,
                seed: 1,
                verdicts,
            });
            const loaded = loadMineTimingRunsFromDb(50);
            const v = loaded[0]!.verdicts[0]!;
            expect(v.asset).to.equal("BTC");
            expect(v.verdict).to.equal("LONG");
            expect(v.dominantPair).to.equal("BTC+ETH");
            // direction is lowercased on store.
            expect(v.direction).to.equal("long");
        } finally {
            resetSqliteDbForTests();
            try { db.close(); } catch { /* temp file */ }
        }
    });
});
