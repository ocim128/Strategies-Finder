import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isTrustedLocalRequest, __testInternals } from "../lib/local-sqlite-vite-plugin";

describe("local sqlite vite plugin", () => {
    it("rejects requests without local origin or referer headers", () => {
        assert.equal(isTrustedLocalRequest({ headers: {} }), false);
    });

    it("allows localhost origin requests without a bearer token", () => {
        assert.equal(isTrustedLocalRequest({
            headers: { origin: "http://localhost:5173" },
        }), true);
    });

    it("allows localhost referer requests without a bearer token", () => {
        assert.equal(isTrustedLocalRequest({
            headers: { referer: "http://127.0.0.1:5173/chart" },
        }), true);
    });

    describe("mine_timing_verdicts SQL parity", () => {
        // Regression guard for the silent 500 caused by an off-by-one between
        // the schema column count and the INSERT placeholder count. The
        // original bug: 33 columns declared, 33 values passed, but only 32
        // `?` placeholders — SQLite rejected the statement, the route threw,
        // and the browser saw HTTP 500 with no in-UI indication.
        //
        // This test parses the plugin source and asserts all three counts
        // agree. It fails loudly the moment someone adds a column without
        // updating the other two sites in lockstep.
        const pluginSource = readFileSync(
            resolve(process.cwd(), "lib", "local-sqlite-vite-plugin.ts"),
            "utf8",
        );

        function extractColumnBlock(statementStart: number): { start: number; end: number; text: string } | null {
            // Find the parens that wrap the column list after a keyword like
            // `INSERT INTO mine_timing_verdicts (` or `CREATE TABLE ... (`.
            const open = pluginSource.indexOf("(", statementStart);
            if (open === -1) return null;
            let depth = 0;
            for (let i = open; i < pluginSource.length; i += 1) {
                const ch = pluginSource[i];
                if (ch === "(") depth += 1;
                else if (ch === ")") {
                    depth -= 1;
                    if (depth === 0) {
                        return { start: open + 1, end: i, text: pluginSource.slice(open + 1, i) };
                    }
                }
            }
            return null;
        }

        function parseColumnNames(blockText: string): string[] {
            // The block is the inside of `(...)`. Two shapes occur:
            //   - CREATE TABLE: one column per line, `<name> <type> ...`,
            //     optionally followed by a trailing `PRIMARY KEY(...)` clause.
            //   - INSERT: comma-separated names, possibly multiple per line.
            //
            // Strip the PRIMARY KEY clause first — its arguments are column
            // names that would otherwise pollute the count. Then split on
            // commas so an INSERT line like `run_id, run_created_at, interval`
            // yields three entries.
            const withoutPrimaryKey = blockText.replace(/PRIMARY\s+KEY\s*\([^)]*\)/gi, "");
            return withoutPrimaryKey
                .split("\n")
                .flatMap((line) => line.split(","))
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0 && !entry.toUpperCase().startsWith("PRIMARY"))
                .map((entry) => entry.split(/\s+/)[0])
                .filter((name) => /^[a-z_]+$/i.test(name));
        }

        it("schema column count matches INSERT column count matches placeholder count", () => {
            const createMatch = pluginSource.indexOf("CREATE TABLE IF NOT EXISTS mine_timing_verdicts");
            const insertMatch = pluginSource.indexOf("INSERT INTO mine_timing_verdicts");
            assert.ok(createMatch !== -1 && insertMatch !== -1, "mine_timing_verdicts statements not found");

            const createBlock = extractColumnBlock(createMatch);
            const insertBlock = extractColumnBlock(insertMatch);
            assert.ok(createBlock && insertBlock, "could not extract column blocks");

            const schemaCols = parseColumnNames(createBlock.text);
            const insertCols = parseColumnNames(insertBlock.text);

            // Now find the matching VALUES (...) for the INSERT and count `?`.
            const valuesIdx = pluginSource.indexOf("VALUES", insertMatch);
            assert.ok(valuesIdx !== -1, "VALUES clause not found for INSERT");
            const valuesBlock = extractColumnBlock(valuesIdx);
            assert.ok(valuesBlock, "could not extract VALUES block");
            const placeholderCount = (valuesBlock.text.match(/\?/g) ?? []).length;

            assert.equal(
                schemaCols.length,
                insertCols.length,
                `schema has ${schemaCols.length} columns but INSERT lists ${insertCols.length}`,
            );
            assert.equal(
                insertCols.length,
                placeholderCount,
                `INSERT lists ${insertCols.length} columns but VALUES has ${placeholderCount} placeholders`,
            );
        });
    });

    describe("mine_timing retention pruning (Finding 4)", () => {
        // Intent being locked (AGENTS.md rule 8): `mine_timing_runs` and
        // `mine_timing_verdicts` grow indefinitely because reads cap at 50
        // but nothing deletes older runs. Each Stability run adds one wide
        // verdict row per asset, so unbounded retention leaves the tables
        // dominated by unread operational baggage. After a successful store,
        // the plugin prunes to the newest MINE_TIMING_RUN_RETENTION_COUNT
        // runs within the same transaction, deleting child verdicts BEFORE
        // parent runs so no orphan verdicts survive.
        const { pruneMineTimingRuns, setSqliteDbForTests, resetSqliteDbForTests, MINE_TIMING_RUN_RETENTION_COUNT } = __testInternals;

        function createTempDb(): DatabaseSync {
            const dbPath = join(tmpdir(), `sf-mine-timing-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
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

        function insertRun(db: DatabaseSync, runId: string, createdAt: number): void {
            db.prepare(
                `INSERT INTO mine_timing_runs (run_id, created_at, interval, strategy_key, source, pair_count, reruns, subset_size, seed) VALUES (?, ?, '1h', 's', 'stability', 100, 25, 200, 1)`,
            ).run(runId, createdAt);
        }

        function insertVerdict(db: DatabaseSync, runId: string, asset: string): void {
            db.prepare(
                `INSERT INTO mine_timing_verdicts (run_id, run_created_at, interval, asset, verdict, direction, confidence) VALUES (?, 1, '1h', ?, 'LONG', 'long', 'medium')`,
            ).run(runId, asset);
        }

        it("keeps the newest retention-limit runs and deletes child verdicts before parent runs", () => {
            const db = createTempDb();
            setSqliteDbForTests(db);
            try {
                // Insert retention + 2 runs, each with a verdict, ascending
                // created_at so run-0 is oldest.
                const total = MINE_TIMING_RUN_RETENTION_COUNT + 2;
                for (let i = 0; i < total; i += 1) {
                    const runId = `run-${String(i).padStart(3, "0")}`;
                    insertRun(db, runId, i);
                    insertVerdict(db, runId, `ASSET${i}`);
                }
                const beforeRuns = (db.prepare("SELECT COUNT(*) AS c FROM mine_timing_runs").get() as { c: number }).c;
                const beforeVerdicts = (db.prepare("SELECT COUNT(*) AS c FROM mine_timing_verdicts").get() as { c: number }).c;
                assert.equal(beforeRuns, total);
                assert.equal(beforeVerdicts, total);

                pruneMineTimingRuns();

                const afterRuns = (db.prepare("SELECT COUNT(*) AS c FROM mine_timing_runs").get() as { c: number }).c;
                const afterVerdicts = (db.prepare("SELECT COUNT(*) AS c FROM mine_timing_verdicts").get() as { c: number }).c;
                assert.equal(afterRuns, MINE_TIMING_RUN_RETENTION_COUNT, "runs pruned to retention limit");
                assert.equal(afterVerdicts, MINE_TIMING_RUN_RETENTION_COUNT, "child verdicts pruned 1:1 with parents");

                // Oldest two runs (run-000, run-001) and their verdicts are gone.
                const oldestRun = db.prepare("SELECT run_id FROM mine_timing_runs WHERE run_id = ?").get("run-000");
                const oldestVerdict = db.prepare("SELECT run_id FROM mine_timing_verdicts WHERE run_id = ?").get("run-000");
                assert.equal(oldestRun, undefined, "oldest run row deleted");
                assert.equal(oldestVerdict, undefined, "oldest run's child verdict deleted before parent");

                // Newest run (run-201 at index total-1) and its verdict remain.
                const newestRun = db.prepare("SELECT run_id FROM mine_timing_runs WHERE run_id = ?").get(`run-${String(total - 1).padStart(3, "0")}`);
                const newestVerdict = db.prepare("SELECT run_id FROM mine_timing_verdicts WHERE run_id = ?").get(`run-${String(total - 1).padStart(3, "0")}`);
                assert.ok(newestRun, "newest run retained");
                assert.ok(newestVerdict, "newest run's verdict retained");
            } finally {
                resetSqliteDbForTests();
                try { db.close(); } catch { /* temp file already gone */ }
            }
        });

        it("is a no-op when run count is at or below the retention limit", () => {
            const db = createTempDb();
            setSqliteDbForTests(db);
            try {
                for (let i = 0; i < MINE_TIMING_RUN_RETENTION_COUNT; i += 1) {
                    insertRun(db, `run-${i}`, i);
                    insertVerdict(db, `run-${i}`, `ASSET${i}`);
                }
                pruneMineTimingRuns();
                const afterRuns = (db.prepare("SELECT COUNT(*) AS c FROM mine_timing_runs").get() as { c: number }).c;
                const afterVerdicts = (db.prepare("SELECT COUNT(*) AS c FROM mine_timing_verdicts").get() as { c: number }).c;
                assert.equal(afterRuns, MINE_TIMING_RUN_RETENTION_COUNT);
                assert.equal(afterVerdicts, MINE_TIMING_RUN_RETENTION_COUNT);
            } finally {
                resetSqliteDbForTests();
                try { db.close(); } catch { /* temp file already gone */ }
            }
        });

        it("retains all runs in a created_at tie group when they fall inside the retention window", () => {
            // Two runs with identical created_at: run-a and run-b, both newer
            // than the fill rows. The prune's ORDER BY created_at DESC, run_id
            // ASC tiebreak makes the ordering deterministic, but both tie runs
            // are inside the newest 200 so neither is pruned — the fill-0 row
            // (oldest) is the one that falls outside. This locks that ties
            // don't cause accidental data loss within the retention window.
            const db = createTempDb();
            setSqliteDbForTests(db);
            try {
                // Fill up to retention so the next insert triggers pruning.
                for (let i = 0; i < MINE_TIMING_RUN_RETENTION_COUNT; i += 1) {
                    insertRun(db, `fill-${i}`, i);
                }
                // Two new runs with the SAME created_at (larger than fill),
                // inserted so total = retention + 2.
                const tieCreatedAt = MINE_TIMING_RUN_RETENTION_COUNT + 100;
                insertRun(db, "run-a", tieCreatedAt);
                insertRun(db, "run-b", tieCreatedAt);
                insertVerdict(db, "run-a", "A");
                insertVerdict(db, "run-b", "B");
                pruneMineTimingRuns();
                const afterRuns = (db.prepare("SELECT COUNT(*) AS c FROM mine_timing_runs").get() as { c: number }).c;
                assert.equal(afterRuns, MINE_TIMING_RUN_RETENTION_COUNT);
                // Both tie runs are inside the newest 200; fill-0 is pruned.
                const runA = db.prepare("SELECT run_id FROM mine_timing_runs WHERE run_id = 'run-a'").get();
                const runB = db.prepare("SELECT run_id FROM mine_timing_runs WHERE run_id = 'run-b'").get();
                const fill0 = db.prepare("SELECT run_id FROM mine_timing_runs WHERE run_id = 'fill-0'").get();
                assert.ok(runA, "tie run-a retained (inside newest window)");
                assert.ok(runB, "tie run-b retained (inside newest window)");
                assert.equal(fill0, undefined, "oldest fill run pruned to make room");
            } finally {
                resetSqliteDbForTests();
                try { db.close(); } catch { /* temp file already gone */ }
            }
        });
    });
});
