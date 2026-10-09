import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Writable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
    LineRingBuffer,
    classifyTestRunStatus,
    createTestLogWriter,
    findUnmatchedTestFilters,
    normalizeForMatch,
    parseExplicitJobCount,
    parseTimeoutMs,
    orderTestsByDuration,
    readTestDurations,
    sanitizeLogName,
    selectTests,
} from "../scripts/run-tests";

const root = fileURLToPath(new URL("../", import.meta.url));
const esnoCli = createRequire(import.meta.url).resolve("esno/esno.js");

describe("test runner contracts", () => {
    it("rejects unmatched filters even when another filter matches", () => {
        assert.deepEqual(findUnmatchedTestFilters(["tests/finder-engine.spec.ts"], ["finder", "finder-typo"]), ["finder-typo"]);
    });

    it("starts slow specs first without mutating selection or losing unknown specs", () => {
        const files = ["a", "b", "new", "c"];
        const durations = new Map([["a", 10], ["b", 100], ["c", 10], ["deleted", 999]]);
        assert.deepEqual(orderTestsByDuration(files, durations), ["b", "a", "c", "new"]);
        assert.deepEqual(files, ["a", "b", "new", "c"]);
        assert.deepEqual(orderTestsByDuration(files, new Map()), files);
    });

    it("tolerates missing and corrupt history and uses only valid successful timings", () => {
        const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "test-runner-history-"));
        const fixture = path.join(fixtureRoot, "timings.json");
        try {
            assert.equal(readTestDurations(fixture).size, 0);
            for (const text of ["broken json", "null", "{}", '{"results":{}}']) {
                fs.writeFileSync(fixture, text);
                assert.equal(readTestDurations(fixture).size, 0);
            }
            fs.writeFileSync(fixture, JSON.stringify({ results: [
                { file: "pass", status: "PASS", durationMs: 50 },
                { file: "zero", status: "PASS", durationMs: 0 },
                { file: "fail", status: "FAIL", durationMs: 120_000 },
                { file: "skip", status: "SKIP", durationMs: 20 },
                { file: "negative", status: "PASS", durationMs: -1 },
                { file: "string", status: "PASS", durationMs: "100" },
                { file: 123, status: "PASS", durationMs: 10 }, null,
            ] }));
            assert.deepEqual([...readTestDurations(fixture)], [["pass", 50], ["zero", 0]]);
        } finally {
            fs.rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    it("lists selected specs as one JSON object without replacing run evidence", () => {
        const evidencePaths = ["artifacts/test-logs/latest/summary.json", "artifacts/test-logs/timings.json"];
        const readEvidence = () => evidencePaths.map(file => fs.existsSync(path.join(root, file))
            ? fs.readFileSync(path.join(root, file), "utf8") : null);
        const before = readEvidence();
        const result = spawnSync(process.execPath, [esnoCli, "scripts/run-tests.ts", "test-runner-contract.spec.ts", "--list", "--json"], {
            cwd: root, encoding: "utf8", timeout: 10_000,
        });
        assert.equal(result.status, 0, result.stderr);
        const listing = JSON.parse(result.stdout);
        assert.equal(listing.selectedCount, 1);
        assert.ok(listing.totalCount > 1);
        assert.deepEqual(listing.files, ["tests/test-runner-contract.spec.ts"]);
        assert.deepEqual(readEvidence(), before);
    });

    it("fails CLI typos before running a matching spec", () => {
        for (const badArgument of ["no-such-spec-xyz", "--jbos=4"]) {
            const result = spawnSync(process.execPath, [esnoCli, "scripts/run-tests.ts", "test-runner-contract.spec.ts", badArgument, "--list"], {
                cwd: root, encoding: "utf8", timeout: 10_000,
            });
            assert.equal(result.status, 1, result.stderr);
            assert.match(result.stderr, /No test files matched|Unknown test runner option/);
            assert.equal(result.stdout, "");
        }
    });

    it("fails suite-construction errors even when the child exits zero", () => {
        const fixtureRoot = fs.mkdtempSync(path.join(root, "artifacts/runner-suite-"));
        try {
            fs.mkdirSync(path.join(fixtureRoot, "scripts"));
            fs.mkdirSync(path.join(fixtureRoot, "tests"));
            const runner = path.join(fixtureRoot, "scripts/run-tests.ts");
            fs.copyFileSync(path.join(root, "scripts/run-tests.ts"), runner);
            fs.writeFileSync(path.join(fixtureRoot, "tests/broken.spec.ts"),
                'import { describe } from "node:test"; describe("broken suite", () => { throw new Error("fixture suite error"); });');
            fs.writeFileSync(path.join(fixtureRoot, "tests/todo.spec.ts"),
                'import { it } from "node:test"; it("expected pending failure", { todo: true }, () => { throw new Error("pending"); });');
            const result = spawnSync(process.execPath, [esnoCli, runner, "--json"], {
                cwd: fixtureRoot, encoding: "utf8", timeout: 15_000,
            });
            assert.equal(result.status, 1, result.stderr);
            const summary = JSON.parse(result.stdout);
            assert.equal(summary.failedCount, 1);
            assert.equal(summary.passedCount, 1);
            const failed = summary.results.find((row: { status: string }) => row.status === "FAIL");
            assert.match(fs.readFileSync(failed.logFile, "utf8"), /fixture suite error/);
        } finally {
            fs.rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    it("records browser compilation failures and finishes other specs and the summary", () => {
        // Keep this copied runner isolated from the outer run's latest/ logs.
        // It can still resolve dependencies through the app's parent directories.
        const artifacts = path.join(root, "artifacts");
        fs.mkdirSync(artifacts, { recursive: true });
        const fixtureRoot = fs.mkdtempSync(path.join(artifacts, "runner-compilation-"));
        try {
            fs.mkdirSync(path.join(fixtureRoot, "scripts"));
            fs.mkdirSync(path.join(fixtureRoot, "tests"));
            const runner = path.join(fixtureRoot, "scripts/run-tests.ts");
            fs.copyFileSync(path.join(root, "scripts/run-tests.ts"), runner);
            fs.writeFileSync(path.join(fixtureRoot, "tests/broken.browser.spec.ts"), 'import "./missing-module";');
            fs.writeFileSync(path.join(fixtureRoot, "tests/passing.spec.ts"), 'console.log("passing fixture executed");');
            for (const jobs of [1, 2]) {
                const result = spawnSync(process.execPath, [esnoCli, runner, `--jobs=${jobs}`, "--json"], {
                    cwd: fixtureRoot, encoding: "utf8", timeout: 15_000,
                });
                assert.equal(result.status, 1, result.stderr);
                const summary = JSON.parse(result.stdout);
                assert.equal(summary.failedCount, 1);
                assert.equal(summary.passedCount, 1);
                assert.equal(summary.selectedCount, 2);
                assert.deepEqual(summary, JSON.parse(fs.readFileSync(
                    path.join(fixtureRoot, "artifacts/test-logs/latest/summary.json"), "utf8",
                )));
                const failed = summary.results.find((row: { status: string }) => row.status === "FAIL");
                assert.equal(failed.file, "tests/broken.browser.spec.ts");
                assert.match(fs.readFileSync(failed.logFile, "utf8"), /missing-module/);
                assert.equal(failed.logError, undefined);
            }
        } finally {
            fs.rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    it("handles a log open error before the test finishes without hanging", async () => {
        const stream = new Writable({ write: (_chunk, _encoding, callback) => callback() });
        const log = createTestLogWriter(stream);
        stream.destroy(new Error("Log open denied"));
        await new Promise<void>(resolve => setImmediate(resolve));
        log.write("output after the log failed");
        assert.equal(await log.finish(), "Log open denied");
    });

    it("reports mid-stream write failures separately from test outcomes", async () => {
        const stream = new Writable({ write: (_chunk, _encoding, callback) => callback(new Error("Disk full")) });
        const log = createTestLogWriter(stream);
        log.write("test output");
        assert.equal(await log.finish(), "Disk full");
        assert.equal(classifyTestRunStatus(0, false, false, false), "PASS");
    });

    it("waits for healthy logs to flush", async () => {
        let output = "";
        const stream = new Writable({ write: (chunk, _encoding, callback) => {
            setImmediate(() => { output += String(chunk); callback(); });
        } });
        const log = createTestLogWriter(stream);
        log.write("complete output");
        assert.equal(await log.finish(), undefined);
        assert.equal(output, "complete output");
    });
    it("keeps bounded failure output while preserving partial lines", () => {
        const buffer = new LineRingBuffer(2);
        buffer.pushChunk("first\nsecond\nthird");
        assert.deepEqual(buffer.flush(), ["second", "third"]);
    });

    it("normalizes filters and selects matching specs", () => {
        assert.equal(normalizeForMatch("Tests\\Feature-Dom-Contracts.spec.ts"), "tests/feature-dom-contracts.spec.ts");
        assert.deepEqual(
            selectTests(
                ["tests/feature-dom-contracts.spec.ts", "tests/e2e.spec.ts", "tests/worker.spec.ts"],
                ["FEATURE-DOM"]
            ),
            ["tests/feature-dom-contracts.spec.ts"]
        );
    });

    it("validates bounded runner options", () => {
        assert.equal(parseExplicitJobCount("4"), 4);
        assert.equal(parseTimeoutMs("5000"), 5000);
        assert.throws(() => parseExplicitJobCount("0"), /positive numeric/);
        assert.throws(() => parseTimeoutMs("999"), /at least 1000/);
    });

    it("makes explicit skip outcomes distinct from passes and failures", () => {
        assert.equal(classifyTestRunStatus(0, false, false, false), "PASS");
        assert.equal(classifyTestRunStatus(0, false, false, false, "catalog unavailable"), "SKIP");
        assert.equal(classifyTestRunStatus(1, false, false, false, "catalog unavailable"), "FAIL");
        assert.equal(classifyTestRunStatus(0, false, false, false, undefined, true), "FAIL");
    });

    it("sanitizes platform-specific log names", () => {
        assert.equal(sanitizeLogName("tests\\foo/bar.spec.ts"), "tests__foo__bar.spec.ts");
    });
});
