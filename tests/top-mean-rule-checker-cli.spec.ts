import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
    MAX_ACTIVE_BLOCK_COUNT,
    MAX_ACTIVE_BOOTSTRAP_SAMPLES,
    MAX_ACTIVE_BOOTSTRAP_SEED,
    MAX_ACTIVE_TIE_VERSION,
    PAIRLIST_POOL_RULE_DISCOVERY_FROM_SEC,
} from "../lib/batch-backtest/max-active-research-contract";
import { bootstrapBlockMeans, splitChronologicalBlocks, type PoolRuleArchive } from "../scripts/analyze-pool-rules";
import type { CandidateOutcomeRecord, PoolSnapshotRecord } from "../lib/batch-backtest/batch-open-score-usd-replay-engine";

const ASSETS = ["AAA", "BBB", "CCC"] as const;
const EVENT_COUNT = 24;

interface Fixture {
    ledgerDir: string;
    reportPath: string;
    rankingRule: string;
    filterRule: string;
    scoreRule: string;
    thinRule: string;
    materialRule: string;
    droppedEventsRule: string;
    leakyRule: string;
    markerPath: string;
    reportText: string;
    startSec: number;
}

interface FixtureOptions {
    includeOutcomeFiles?: boolean;
    tied?: boolean;
    reverseSnapshots?: boolean;
    startSec?: number;
}

function fixtureMeta(runId: string): PoolRuleArchive["meta"] {
    return {
        schema: "top_mean_archive.v2",
        runId,
        interval: "4h",
        horizons: [24],
        canonicalAssets: [...ASSETS],
        fingerprint: "fixture-fingerprint",
        manifest: {
            catalog: { assets: [...ASSETS] },
            researchContract: {
                tieVersion: MAX_ACTIVE_TIE_VERSION,
                blockCount: MAX_ACTIVE_BLOCK_COUNT,
                bootstrapSamples: MAX_ACTIVE_BOOTSTRAP_SAMPLES,
                bootstrapSeed: MAX_ACTIVE_BOOTSTRAP_SEED,
            },
        },
    } as PoolRuleArchive["meta"];
}

function buildFixtureRows(startSec: number, eventCount = EVENT_COUNT, options: FixtureOptions = {}): { snapshots: PoolSnapshotRecord[]; outcomes: CandidateOutcomeRecord[]; eventRows: Record<string, unknown>[] } {
    const snapshots: PoolSnapshotRecord[] = [];
    const outcomes: CandidateOutcomeRecord[] = [];
    const eventRows: Record<string, unknown>[] = [];
    for (let index = 0; index < eventCount; index += 1) {
        const decisionTimeSec = startSec + index * 86_400;
        const eventId = `4h:${decisionTimeSec}`;
        const signedVotes = options.tied ? [8, 8, 2] : index % 2 === 0 ? [8, 5, 2] : [5, 8, 2];
        for (let assetIndex = 0; assetIndex < ASSETS.length; assetIndex += 1) {
            const asset = ASSETS[assetIndex]!;
            snapshots.push({
                eventId,
                decisionTimeSec,
                interval: "4h",
                poolVersion: null,
                asset,
                inPool: true,
                activePairCount: 10,
                signedVotes: signedVotes[assetIndex] ?? 0,
                score: (signedVotes[assetIndex] ?? 0) / 10,
                longEligible: true,
                shortEligible: false,
                ema200Above: true,
                breadth: 0.6,
                regime: "bullish",
            });
            const value = asset === "AAA" ? 0.1 : asset === "BBB" ? 0.2 : 0.05;
            outcomes.push({
                eventId,
                decisionTimeSec,
                horizonBars: 24,
                direction: "long",
                asset,
                inPool: true,
                eligible: true,
                return: value,
                entryTimeSec: decisionTimeSec + 1,
                exitTimeSec: decisionTimeSec + 25,
                status: "ok",
            });
        }
        const selectedAsset = index % 2 === 0 ? "AAA" : "BBB";
        const selectedReturn = selectedAsset === "AAA" ? 0.1 : 0.2;
        const otherReturn = selectedAsset === "AAA" ? (0.2 + 0.05) / 2 : (0.1 + 0.05) / 2;
        eventRows.push({
            eventId,
            decisionTime: decisionTimeSec,
            entryTime: decisionTimeSec + 1,
            exitTime: decisionTimeSec + 25,
            horizonBars: 24,
            selector: "TOP_MEAN",
            direction: "long",
            asset: selectedAsset,
            selectedReturn,
            controlReturn: otherReturn,
            delta: selectedReturn - otherReturn,
            eligibleCandidates: 3,
        });
    }
    if (options.reverseSnapshots) snapshots.reverse();
    return { snapshots, outcomes, eventRows };
}

function percent(value: number | null): string {
    if (value === null) return "n/a";
    return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

function metricLine(label: string, rows: readonly Record<string, unknown>[]): string {
    const points = rows.map((row) => ({ eventId: String(row.eventId), decisionTimeSec: Number(row.decisionTime), value: Number(row.delta) }));
    const blocks = splitChronologicalBlocks(points).map((block) => block.reduce((sum, value) => sum + value, 0) / block.length);
    const ci = bootstrapBlockMeans(blocks);
    const mean = (field: string): number => rows.reduce((sum, row) => sum + Number(row[field]), 0) / rows.length;
    const ciText = ci.lower === null || ci.upper === null ? "n/a" : `[${percent(ci.lower)},${percent(ci.upper)}]`;
    return `${label} n=${rows.length} top=${percent(mean("selectedReturn"))} rand=${percent(mean("controlReturn"))} delta=${percent(mean("delta"))} CI95=${ciText} +blocks=${blocks.filter((value) => value > 0).length}/${blocks.length}`;
}

function summaryLine(rows: readonly Record<string, unknown>[]): string {
    const byAsset = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
        const asset = String(row.asset);
        const assetRows = byAsset.get(asset);
        if (assetRows) assetRows.push(row);
        else byAsset.set(asset, [row]);
    }
    const summaries = [...byAsset.entries()].map(([asset, assetRows]) => ({
        asset,
        events: assetRows.length,
        share: assetRows.length / rows.length,
        delta: assetRows.reduce((sum, row) => sum + Number(row.delta), 0) / assetRows.length,
    })).sort((left, right) => right.events - left.events || left.asset.localeCompare(right.asset));
    return summaries.map((row) => `${row.asset}:n=${row.events},share=${(row.share * 100).toFixed(1)}%,delta=${percent(row.delta)}`).join(" | ");
}

function writeFixture(eventCount = EVENT_COUNT, options: FixtureOptions = {}): Fixture {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "top-mean-rule-checker-"));
    const ledgerDir = path.join(tempRoot, "archive", "batch-open-score", "cli-fixture");
    const reportPath = path.join(ledgerDir, "report.txt");
    const markerPath = path.join(tempRoot, "rule-imported.txt");
    const rankingRule = path.join(tempRoot, "ranking-rule.ts");
    const filterRule = path.join(tempRoot, "filter-rule.ts");
    const scoreRule = path.join(tempRoot, "score-rule.ts");
    const thinRule = path.join(tempRoot, "thin-rule.ts");
    const materialRule = path.join(tempRoot, "material-rule.ts");
    const droppedEventsRule = path.join(tempRoot, "dropped-events-rule.ts");
    const leakyRule = path.join(tempRoot, "leaky-rule.ts");
    const startSec = options.startSec ?? 1_767_312_000;
    const rows = buildFixtureRows(startSec, eventCount, options);
    const archive: PoolRuleArchive = { meta: fixtureMeta("cli-fixture"), snapshots: rows.snapshots, outcomes: rows.outcomes, eventRows: rows.eventRows };
    const selectedRows = rows.eventRows;
    const excludedRows = selectedRows.filter((row) => row.asset !== "AAA");
    const reportText = [
        `OPEN_SCORE USD | COMPLETE | pairs=3 assets=3 events=${eventCount} comparable=${eventCount} eligible=${eventCount}`,
        "config | interval=4h window=fixture horizons=[24]",
        `--- horizon 24 bar(s) | coverage=${eventCount}/${eventCount} (100.0%) ---`,
        metricLine("TOP_MEAN       ", selectedRows),
        `TOP_MEAN selected assets = ${summaryLine(selectedRows)}`,
        metricLine("MEAN_EX_AAA", excludedRows),
    ].join("\n") + "\n";
    const files: Array<[string, string]> = [
        ["meta.json", JSON.stringify(archive.meta)],
        ["pool-snapshots.jsonl", rows.snapshots.map((row) => JSON.stringify(row)).join("\n") + "\n"],
    ];
    if (options.includeOutcomeFiles !== false) files.push(
        ["candidate-outcomes.jsonl", rows.outcomes.map((row) => JSON.stringify(row)).join("\n") + "\n"],
        ["events-full.jsonl", rows.eventRows.map((row) => JSON.stringify(row)).join("\n") + "\n"],
        ["report.txt", reportText],
    );
    for (const [name, value] of files) {
        const file = path.join(ledgerDir, name);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, value, "utf8");
    }
    writeFileSync(rankingRule, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(markerPath)}, "loaded"); export default (candidate) => candidate.asset === "CCC" ? 2 : 1;\n`, "utf8");
    writeFileSync(filterRule, "export default (candidate) => candidate.asset !== \"CCC\";\n", "utf8");
    writeFileSync(scoreRule, "export default (candidate) => candidate.score;\n", "utf8");
    writeFileSync(thinRule, `export default (candidate, event) => event.decisionTimeSec === ${startSec} && candidate.asset === "CCC" ? 2 : candidate.score;\n`, "utf8");
    writeFileSync(materialRule, `export default (candidate, event) => event.decisionTimeSec <= ${startSec + 86_400} && candidate.asset === "CCC" ? 2 : candidate.score;\n`, "utf8");
    writeFileSync(droppedEventsRule, "export default (_candidate, event) => event.dow !== 0;\n", "utf8");
    writeFileSync(leakyRule, "export default (candidate) => (candidate as any).return;\n", "utf8");
    return { ledgerDir, reportPath, rankingRule, filterRule, scoreRule, thinRule, materialRule, droppedEventsRule, leakyRule, markerPath, reportText, startSec };
}

function ledgerHashes(ledgerDir: string): string {
    const files = readdirSync(ledgerDir).sort();
    return files.map((name) => `${name}:${createHash("sha256").update(readFileSync(path.join(ledgerDir, name))).digest("hex")}`).join("\n");
}

function runChecker(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
    const esno = path.resolve(process.cwd(), "../../../node_modules/esno/esno.js");
    const script = path.resolve(process.cwd(), "scripts/top-mean-rule-checker.ts");
    const result = spawnSync(process.execPath, [esno, script, ...args], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192" },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("top-mean-rule-checker CLI", () => {
    it("runs self-check, stats, ranking, and filter modes without changing ledger bytes", () => {
        const fixture = writeFixture();
        try {
            const before = ledgerHashes(fixture.ledgerDir);
            const selfCheck = runChecker([fixture.ledgerDir, "--self-check"]);
            assert.equal(selfCheck.status, 0);
            assert.match(selfCheck.stdout, /^SELF_CHECK PASS \| events=24 /);

            const stats = runChecker([fixture.ledgerDir, "--stats", "--window", "validation"]);
            assert.equal(stats.status, 0);
            assert.match(stats.stdout, /candidate signedVotes .*p0=/);
            assert.match(stats.stdout, /regime \| bullish events=24/);

            const ranking = runChecker([fixture.ledgerDir, fixture.rankingRule, "--window", "validation"]);
            assert.equal(ranking.status, 0);
            assert.match(ranking.stdout, /PRIMARY \|/);
            assert.match(ranking.stdout, /SECONDARY \|/);
            assert.match(ranking.stdout, /SELECTED_ASSET \|/);
            assert.match(ranking.stdout, /PRIMARY_EX_/);
            assert.match(ranking.stdout, /SECONDARY_EX_/);

            const filter = runChecker([fixture.ledgerDir, fixture.filterRule, "--window", "validation"]);
            assert.equal(filter.status, 0);
            assert.match(filter.stdout, /rule kind=filter/);
            assert.match(filter.stdout, /candidate keep rate=66\.67%/);

            assert.equal(ledgerHashes(fixture.ledgerDir), before);
        } finally {
            rmSync(path.dirname(path.dirname(path.dirname(fixture.ledgerDir))), { recursive: true, force: true });
        }
    });

    it("is byte-identical across repeated and relative-path rule runs", () => {
        const fixture = writeFixture();
        try {
            const first = runChecker([fixture.ledgerDir, fixture.rankingRule, "--window", "validation"]);
            const second = runChecker([fixture.ledgerDir, fixture.rankingRule, "--window", "validation"]);
            assert.equal(first.status, 0);
            assert.equal(second.status, 0);
            assert.equal(first.stdout, second.stdout);
            const relativeLedger = path.relative(process.cwd(), fixture.ledgerDir);
            const relative = runChecker([relativeLedger, fixture.rankingRule, "--window", "validation"]);
            assert.equal(relative.status, 0);
            assert.equal(relative.stdout, first.stdout);
        } finally {
            rmSync(path.dirname(path.dirname(path.dirname(fixture.ledgerDir))), { recursive: true, force: true });
        }
    });

    it("returns usage code 2 and keeps a bad archive from importing a rule", () => {
        const fixture = writeFixture();
        try {
            const invalid = runChecker([fixture.ledgerDir]);
            assert.equal(invalid.status, 2);
            const original = readFileSync(fixture.reportPath, "utf8");
            writeFileSync(fixture.reportPath, original.replace("n=24 top=", "n=23 top="), "utf8");
            const failed = runChecker([fixture.ledgerDir, fixture.rankingRule, "--window", "validation"]);
            assert.equal(failed.status, 1);
            assert.match(failed.stderr, /SELF_CHECK FAIL/);
            assert.equal(existsSync(fixture.markerPath), false);
            writeFileSync(fixture.reportPath, original, "utf8");
            writeFileSync(fixture.reportPath, original.replace("COMPLETE", "DATA_INCOMPLETE"), "utf8");
            const unexpectedIncomplete = runChecker([fixture.ledgerDir, "--self-check"]);
            assert.equal(unexpectedIncomplete.status, 1);
            assert.match(unexpectedIncomplete.stderr, /report\.incomplete_archive/);
            writeFileSync(fixture.reportPath, original, "utf8");
        } finally {
            rmSync(path.dirname(path.dirname(path.dirname(fixture.ledgerDir))), { recursive: true, force: true });
        }
    });

    it("returns a successful INCONCLUSIVE report for a small valid fixture", () => {
        const fixture = writeFixture(6);
        try {
            const result = runChecker([fixture.ledgerDir, fixture.filterRule, "--window", "validation"]);
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /status=INCONCLUSIVE/);
            assert.match(result.stdout, /CI95=n\/a/);
        } finally {
            rmSync(path.dirname(path.dirname(path.dirname(fixture.ledgerDir))), { recursive: true, force: true });
        }
    });

    it("classifies ZERO, THIN, MATERIAL, and event-drop screen impacts", () => {
        const fixture = writeFixture(100, { includeOutcomeFiles: false, startSec: PAIRLIST_POOL_RULE_DISCOVERY_FROM_SEC + 86_400 });
        try {
            const zero = runChecker([fixture.ledgerDir, fixture.scoreRule, "--screen", "--window", "discovery"]);
            assert.equal(zero.status, 0, zero.stderr);
            assert.match(zero.stdout, /TOP_MEAN RULE CHECKER \| mode=screen/);
            assert.match(zero.stdout, /changed=0\/100 rate=0\.00%/);
            assert.match(zero.stdout, /SCREEN \| impact=ZERO thinCutoff=2\.00%/);

            const thin = runChecker([fixture.ledgerDir, fixture.thinRule, "--screen", "--window", "discovery"]);
            assert.equal(thin.status, 0, thin.stderr);
            assert.match(thin.stdout, /changed=1\/100 rate=1\.00%/);
            assert.match(thin.stdout, /SCREEN \| impact=THIN thinCutoff=2\.00%/);

            const material = runChecker([fixture.ledgerDir, fixture.materialRule, "--screen", "--window", "discovery"]);
            assert.equal(material.status, 0, material.stderr);
            assert.match(material.stdout, /changed=2\/100 rate=2\.00%/);
            assert.match(material.stdout, /SCREEN \| impact=MATERIAL thinCutoff=2\.00%/);

            const dropped = runChecker([fixture.ledgerDir, fixture.droppedEventsRule, "--screen", "--window", "discovery"]);
            assert.equal(dropped.status, 0, dropped.stderr);
            assert.match(dropped.stdout, /droppedEvents=[1-9]\d* changed=0\/100/);
            assert.match(dropped.stdout, /SCREEN \| impact=ZERO thinCutoff=2\.00%/);
        } finally {
            rmSync(path.dirname(path.dirname(path.dirname(fixture.ledgerDir))), { recursive: true, force: true });
        }
    });

    it("rejects validation for both causal modes with usage code 2", () => {
        const fixture = writeFixture(EVENT_COUNT, { includeOutcomeFiles: false, startSec: PAIRLIST_POOL_RULE_DISCOVERY_FROM_SEC + 86_400 });
        try {
            const screen = runChecker([fixture.ledgerDir, fixture.scoreRule, "--screen", "--window", "validation"]);
            assert.equal(screen.status, 2);
            assert.match(screen.stderr, /USAGE ERROR/);
            const stats = runChecker([fixture.ledgerDir, "--causal-stats", "--window", "validation"]);
            assert.equal(stats.status, 2);
            assert.match(stats.stderr, /USAGE ERROR/);
        } finally {
            rmSync(path.dirname(path.dirname(path.dirname(fixture.ledgerDir))), { recursive: true, force: true });
        }
    });

    it("runs screen and causal stats with no outcome or report files", () => {
        const fixture = writeFixture(EVENT_COUNT, { includeOutcomeFiles: false, startSec: PAIRLIST_POOL_RULE_DISCOVERY_FROM_SEC + 86_400 });
        try {
            for (const filename of ["candidate-outcomes.jsonl", "events-full.jsonl", "report.txt"]) {
                assert.equal(existsSync(path.join(fixture.ledgerDir, filename)), false);
            }
            const before = ledgerHashes(fixture.ledgerDir);
            const screen = runChecker([fixture.ledgerDir, fixture.scoreRule, "--screen", "--window", "discovery"]);
            assert.equal(screen.status, 0, screen.stderr);
            assert.match(screen.stdout, /causal cohort \| rawEvents=24 baseCandidateEvents=24 baseCandidates=72/);
            const stats = runChecker([fixture.ledgerDir, "--causal-stats", "--window", "discovery"]);
            assert.equal(stats.status, 0, stats.stderr);
            assert.match(stats.stdout, /causal cohort \| rawEvents=24 baseCandidateEvents=24 baseCandidates=72/);
            assert.equal(ledgerHashes(fixture.ledgerDir), before);
        } finally {
            rmSync(path.dirname(path.dirname(path.dirname(fixture.ledgerDir))), { recursive: true, force: true });
        }
    });

    it("keeps leakage failures, tie handling, input order, and stdout deterministic", () => {
        const fixture = writeFixture(EVENT_COUNT, { includeOutcomeFiles: false, startSec: PAIRLIST_POOL_RULE_DISCOVERY_FROM_SEC + 86_400 });
        const tied = writeFixture(EVENT_COUNT, { includeOutcomeFiles: false, tied: true, startSec: PAIRLIST_POOL_RULE_DISCOVERY_FROM_SEC + 86_400 });
        const reversed = writeFixture(EVENT_COUNT, { includeOutcomeFiles: false, tied: true, reverseSnapshots: true, startSec: PAIRLIST_POOL_RULE_DISCOVERY_FROM_SEC + 86_400 });
        try {
            const leak = runChecker([fixture.ledgerDir, fixture.leakyRule, "--screen", "--window", "discovery"]);
            assert.equal(leak.status, 1);
            assert.match(leak.stderr, /RULE FAIL/);
            assert.match(leak.stderr, /forbidden candidate field "return"/);

            const screenFirst = runChecker([fixture.ledgerDir, fixture.scoreRule, "--screen", "--window", "discovery"]);
            const screenSecond = runChecker([fixture.ledgerDir, fixture.scoreRule, "--screen", "--window", "discovery"]);
            assert.equal(screenFirst.status, 0);
            assert.equal(screenSecond.status, 0);
            assert.equal(screenFirst.stdout, screenSecond.stdout);

            const statsFirst = runChecker([fixture.ledgerDir, "--causal-stats", "--window", "discovery"]);
            const statsSecond = runChecker([fixture.ledgerDir, "--causal-stats", "--window", "discovery"]);
            assert.equal(statsFirst.status, 0);
            assert.equal(statsSecond.status, 0);
            assert.equal(statsFirst.stdout, statsSecond.stdout);

            const ordered = runChecker([tied.ledgerDir, tied.scoreRule, "--screen", "--window", "discovery"]);
            const inputReversed = runChecker([reversed.ledgerDir, reversed.scoreRule, "--screen", "--window", "discovery"]);
            assert.equal(ordered.status, 0);
            assert.equal(inputReversed.status, 0);
            assert.equal(ordered.stdout, inputReversed.stdout);
            assert.match(ordered.stdout, /changed=0\/24/);
        } finally {
            rmSync(path.dirname(path.dirname(path.dirname(fixture.ledgerDir))), { recursive: true, force: true });
            rmSync(path.dirname(path.dirname(path.dirname(tied.ledgerDir))), { recursive: true, force: true });
            rmSync(path.dirname(path.dirname(path.dirname(reversed.ledgerDir))), { recursive: true, force: true });
        }
    });

    it("rejects a pipe byte before loading the archive or importing the rule", () => {
        const fixture = writeFixture(EVENT_COUNT, { includeOutcomeFiles: false, startSec: PAIRLIST_POOL_RULE_DISCOVERY_FROM_SEC + 86_400 });
        const pipeRule = path.join(path.dirname(path.dirname(path.dirname(fixture.ledgerDir))), "pipe-rule.ts");
        writeFileSync(pipeRule, "export default (candidate, event) => candidate.ema200Above || event.breadth > 0.5;\n", "utf8");
        try {
            const result = runChecker([path.join(path.dirname(fixture.ledgerDir), "missing-ledger"), pipeRule, "--screen", "--window", "discovery"]);
            assert.equal(result.status, 1);
            assert.match(result.stderr, /^RULE FAIL/m);
            assert.match(result.stderr, /check=rule\.source\.no_pipe/);
            assert.match(result.stderr, /expected=no U\+007C bytes/);
            assert.match(result.stderr, /actual=pipe-rule\.ts:offset=59/);
            assert.doesNotMatch(result.stderr, /ARCHIVE FAIL/);
        } finally {
            rmSync(path.dirname(path.dirname(path.dirname(fixture.ledgerDir))), { recursive: true, force: true });
        }
    });
});
