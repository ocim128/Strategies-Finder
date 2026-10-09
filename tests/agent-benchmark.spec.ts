import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { BENCHMARK_TASKS, TASK_SET_HASH, compareAgentRuns, saveAgentRun, validateAgentRun, type AgentRun } from "../scripts/agent-benchmark";

const root = fileURLToPath(new URL("../", import.meta.url));
const esno = createRequire(import.meta.url).resolve("esno/esno.js");

function fixture(overrides: Partial<AgentRun> = {}): AgentRun {
    return {
        formatVersion: 1, taskSetHash: TASK_SET_HASH, taskId: "validation-routing", trial: 1,
        variant: "baseline", fixtureRevision: "a".repeat(40), model: "fixture-model", reasoningEffort: "medium",
        metrics: { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 700, reasoningTokens: 100, wallTimeMs: 100, toolCalls: 5, correctiveFollowups: 0 },
        review: { passed: true, reviewer: "fixture-grader", notes: "Synthetic test data, not measured usage" },
        checks: [], evidence: ["transcript.txt"], ...overrides,
    };
}

function pair() {
    return [fixture(), fixture({ variant: "efficient", metrics: { ...fixture().metrics, inputTokens: 500 } })];
}

describe("agent workflow benchmark", () => {
    it("keeps eight distinct tasks with real sources and review criteria", () => {
        assert.equal(BENCHMARK_TASKS.length, 8);
        assert.equal(new Set(BENCHMARK_TASKS.map(task => task.id)).size, 8);
        for (const task of BENCHMARK_TASKS) {
            assert.ok(task.prompt && task.acceptance.length > 0);
            for (const file of task.sources) assert.ok(fs.existsSync(path.join(root, file)), file);
            for (const check of task.requiredChecks.filter(check => check.endsWith(".spec.ts"))) {
                assert.ok(fs.existsSync(path.join(root, "tests", check)), check);
            }
        }
    });

    it("refuses guessed/missing metrics and double-counted token subsets", () => {
        const valid = fixture();
        assert.deepEqual(validateAgentRun(valid), valid);
        for (const invalid of [null, -1, NaN, Infinity, "1000", 1.5]) {
            assert.throws(() => validateAgentRun({ ...valid, metrics: { ...valid.metrics, inputTokens: invalid } }));
        }
        assert.throws(() => validateAgentRun({ ...valid, metrics: { ...valid.metrics, cachedInputTokens: 1001 } }), /subsets/);
        assert.throws(() => validateAgentRun({ ...valid, metrics: { ...valid.metrics, reasoningTokens: 201 } }), /subsets/);
        assert.throws(() => validateAgentRun({ ...valid, taskSetHash: "old-task-set" }), /task set/);
        assert.throws(() => validateAgentRun({ ...valid, variant: "../escape" }), /slug/);
        assert.throws(() => validateAgentRun({ ...valid, review: { ...valid.review, reviewer: "" } }), /reviewer/);
    });

    it("requires implementation checks for a pass while retaining failed attempts", () => {
        const run = fixture({ taskId: "runner-filter-error" });
        assert.throws(() => validateAgentRun(run), /minimum check/);
        const checks = BENCHMARK_TASKS.find(task => task.id === run.taskId)!.requiredChecks.map(name => ({ name, exitCode: 0 }));
        assert.ok(validateAgentRun({ ...run, checks }).review.passed);
        assert.throws(() => validateAgentRun({ ...run, checks: checks.map(check => ({ ...check, exitCode: 1 })) }));
        assert.equal(validateAgentRun({ ...run, review: { ...run.review, passed: false } }).review.passed, false);
    });

    it("reports actual totals without adding cache and reasoning subsets again", () => {
        const report = compareAgentRuns(pair(), "baseline", "efficient", ["validation-routing"], 1);
        assert.equal(report.status, "improved");
        assert.equal(report.aggregate!.baseline.tokens, 1200);
        assert.equal(report.aggregate!.candidate.tokens, 700);
    });

    it("does not call a cheaper failed outcome an improvement", () => {
        const [a, b] = pair();
        b!.review = { ...b!.review, passed: false };
        const report = compareAgentRuns([a!, b!], "baseline", "efficient", ["validation-routing"], 1);
        assert.equal(report.status, "regression");
        assert.deepEqual(report.qualityRegressions, ["validation-routing/1"]);
        assert.equal(report.aggregate!.candidate.tokens, 700, "failed runs remain in the totals");
        const failedBaseline = { ...a!, review: { ...a!.review, passed: false } };
        assert.equal(compareAgentRuns([failedBaseline, b!], "baseline", "efficient", ["validation-routing"], 1).status, "regression");
    });

    it("flags extra corrective follow-ups and non-improving token usage", () => {
        const [a, b] = pair();
        assert.equal(compareAgentRuns([a!, { ...b!, metrics: { ...b!.metrics, correctiveFollowups: 1 } }], "baseline", "efficient", ["validation-routing"], 1).status, "regression");
        assert.equal(compareAgentRuns([a!, { ...b!, metrics: a!.metrics }], "baseline", "efficient", ["validation-routing"], 1).status, "no-improvement");
    });

    it("withholds aggregate savings for missing trials or incomparable configurations", () => {
        assert.equal(compareAgentRuns(pair(), "baseline", "efficient").aggregate, null);
        const [a, b] = pair();
        for (const changed of [{ model: "other-model" }, { fixtureRevision: "b".repeat(40) }, { reasoningEffort: "low" }]) {
            const report = compareAgentRuns([a!, { ...b!, ...changed }], "baseline", "efficient", ["validation-routing"], 1);
            assert.equal(report.status, "insufficient-evidence");
            assert.equal(report.aggregate, null);
        }
        assert.throws(() => compareAgentRuns([...pair(), a!], "baseline", "efficient"), /Duplicate run/);
        assert.throws(() => compareAgentRuns(pair(), "baseline", "baseline"), /distinct/);
        assert.throws(() => compareAgentRuns(pair(), "baseline", "efficient", [], 1), /unique tasks/);
    });

    it("checks metadata across trials and retains unmatched extra trials", () => {
        const runs = [...pair(), ...pair().map(run => ({ ...run, trial: 2, model: "different" }))];
        assert.equal(compareAgentRuns(runs, "baseline", "efficient", ["validation-routing"], 2).status, "insufficient-evidence");
        runs[2]!.model = runs[3]!.model = "fixture-model";
        assert.equal(compareAgentRuns(runs, "baseline", "efficient", ["validation-routing"], 2).status, "improved");
        runs.push(fixture({ trial: 3 }));
        const report = compareAgentRuns(runs, "baseline", "efficient", ["validation-routing"], 2);
        assert.equal(report.status, "insufficient-evidence");
        assert.ok(report.issues.some(issue => issue.includes("validation-routing/3")));
    });

    it("archives evidence before latest logs change and refuses overwrites or outside evidence", () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-benchmark-spec-"));
        try {
            const evidence = path.join(directory, "transcript.txt");
            fs.writeFileSync(evidence, "original evidence");
            const destination = saveAgentRun(fixture(), directory);
            const saved = validateAgentRun(JSON.parse(fs.readFileSync(destination, "utf8")));
            fs.writeFileSync(evidence, "replaced latest output");
            assert.equal(fs.readFileSync(path.join(directory, saved.evidence[0]!), "utf8"), "original evidence");
            assert.throws(() => saveAgentRun(fixture(), directory), /EEXIST/);
            assert.throws(() => saveAgentRun(fixture({ trial: 2, evidence: [path.join(root, "AGENTS.md")] }), directory), /inside the repo/);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it("provides templates but rejects unknown CLI options without recording data", () => {
        const call = (...args: string[]) => spawnSync(process.execPath, [esno, "scripts/agent-benchmark.ts", ...args], { cwd: root, encoding: "utf8", timeout: 10_000 });
        const template = call("template", "--task", "validation-routing", "--variant", "baseline", "--trial", "1");
        assert.equal(template.status, 0, template.stderr);
        const value = JSON.parse(template.stdout);
        assert.equal(value.metrics.inputTokens, null);
        assert.throws(() => validateAgentRun(value));
        const invalid = call("tasks", "--typo", "true");
        assert.equal(invalid.status, 1);
        assert.equal(invalid.stdout, "");
        assert.match(invalid.stderr, /agent:bench/);
        const missing = call("compare", "--baseline", "spec-baseline-empty", "--candidate", "spec-candidate-empty", "--json");
        assert.equal(missing.status, 2, missing.stderr);
        const report = JSON.parse(missing.stdout);
        assert.equal(report.status, "insufficient-evidence");
        assert.equal(report.aggregate, null);
    });
});
