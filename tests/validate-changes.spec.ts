import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { after, describe, it } from "node:test";
import {
    APP_ROOT,
    applyNpmForwardedConfig,
    buildJsonReport,
    collectChangedPaths,
    executePlanChecks,
    main,
    parseCliArgs,
    parseRunnerSummary,
    parseStatusZ,
    renderHumanReport,
    resolveNpmCliPath,
    stopProcessTree,
    CliUsageError,
    type ReportScope,
} from "../scripts/validate-changes";
import { buildValidationPlan } from "../scripts/validation-map";
import type { ValidationCheckId, ValidationPlan } from "../scripts/validation-map";

const requireFromHere = createRequire(import.meta.url);
const esnoCliPath = requireFromHere.resolve("esno/esno.js");
const validateChangesCliPath = path.join(APP_ROOT, "scripts", "validate-changes.ts");

const fixtureRoots: string[] = [];

function git(args: readonly string[], cwd: string): string {
    const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout;
}

function write(filePath: string, contents: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, "utf8");
}

/** Disposable repository shaped like a miniature app so planning can resolve specs. */
function createFixtureRepo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "validate-changes-"));
    fixtureRoots.push(root);
    git(["init"], root);
    git(["config", "user.email", "fixture@example.com"], root);
    git(["config", "user.name", "Fixture"], root);
    git(["config", "core.autocrlf", "false"], root);
    write(path.join(root, "tests", "finder-engine.spec.ts"), "test('finder fixture');\n");
    write(path.join(root, "tests", "feature-dom-contracts.spec.ts"), "test('dom fixture');\n");
    write(path.join(root, "tests", "server-ibkr-csv-loader.spec.ts"), "test('loader fixture');\n");
    write(path.join(root, "lib", "tracked.ts"), "export const tracked = 1;\n");
    write(path.join(root, "docs", "guide.md"), "# Fixture guide\n");
    git(["add", "-A"], root);
    git(["commit", "-m", "baseline"], root);
    return root;
}

function fakePlan(checks: readonly ValidationCheckId[], testFilters: string[] = [], selectedSpecs: string[] = []): ValidationPlan {
    return {
        formatVersion: 1,
        changedPaths: ["lib/tracked.ts"],
        matches: [],
        unmatchedPaths: [],
        fallbackApplied: false,
        guides: [],
        testFilters,
        selectedSpecs,
        checks: [...checks],
        docsOnly: false,
    };
}

function textWriter(): { writer: { write: (text: string) => void }; text: () => string } {
    const chunks: string[] = [];
    return {
        writer: {
            write: (text: string) => {
                chunks.push(text);
            },
        },
        text: () => chunks.join(""),
    };
}

after(() => {
    for (const root of fixtureRoots) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

describe("cli argument parsing", () => {
    it("parses the documented flags", () => {
        assert.deepEqual(parseCliArgs([]), { base: null, run: false, json: false, help: false });
        assert.deepEqual(parseCliArgs(["--base", "origin/main"]), { base: "origin/main", run: false, json: false, help: false });
        assert.deepEqual(parseCliArgs(["--base=feature"]), { base: "feature", run: false, json: false, help: false });
        assert.deepEqual(parseCliArgs(["--run", "--json"]), { base: null, run: true, json: true, help: false });
        assert.deepEqual(parseCliArgs(["-h"]), { base: null, run: false, json: false, help: true });
    });

    it("rejects unknown arguments and malformed --base values", () => {
        assert.throws(() => parseCliArgs(["--unknown"]), CliUsageError);
        assert.throws(() => parseCliArgs(["--base"]), /requires a Git reference/);
        assert.throws(() => parseCliArgs(["--base="]), /non-empty Git reference/);
        assert.throws(() => parseCliArgs(["lib/finder.ts"]), CliUsageError);
    });
});

describe("git status parsing", () => {
    it("reads rename, copy, untracked, and deletion entries from -z output", () => {
        const entries = parseStatusZ(
            "R  lib/new.ts\0lib/old.ts\0?? untracked.txt\0 D removed.txt\0M  edited.ts\0C  copied.ts\0orig.ts\0",
        );
        assert.deepEqual(entries, [
            { entryPath: "lib/new.ts", originPath: "lib/old.ts" },
            { entryPath: "untracked.txt" },
            { entryPath: "removed.txt" },
            { entryPath: "edited.ts" },
            { entryPath: "copied.ts", originPath: "orig.ts" },
        ]);
    });
});

describe("git change collection", () => {
    it("collects staged, unstaged, and untracked files", async () => {
        const root = createFixtureRepo();
        fs.writeFileSync(path.join(root, "lib", "tracked.ts"), "export const tracked = 2;\n", "utf8");
        write(path.join(root, "staged.txt"), "staged\n");
        git(["add", "staged.txt"], root);
        write(path.join(root, "untracked.txt"), "untracked\n");

        const changes = await collectChangedPaths({ appRoot: root });
        assert.deepEqual(changes.paths, ["lib/tracked.ts", "staged.txt", "untracked.txt"]);
        assert.equal(changes.baseCommit, null);
        assert.deepEqual(changes.outOfScopePaths, []);
    });

    it("collects a staged file edited again once and hands its identity to the planner", async () => {
        const root = createFixtureRepo();
        const baseCommit = git(["rev-parse", "HEAD"], root).trim();
        git(["checkout", "-b", "feature"], root);
        write(path.join(root, "lib", "tracked.ts"), "export const tracked = 2;\n");
        git(["add", "-A"], root);
        git(["commit", "-m", "branch work"], root);
        // The same path now arrives from the committed diff, the staged index,
        // and the working tree; the collector must report it exactly once.
        write(path.join(root, "lib", "tracked.ts"), "export const tracked = 3;\n");
        git(["add", "lib/tracked.ts"], root);
        fs.writeFileSync(path.join(root, "lib", "tracked.ts"), "export const tracked = 4;\n", "utf8");

        const changes = await collectChangedPaths({ appRoot: root, base: baseCommit });
        assert.deepEqual(changes.paths, ["lib/tracked.ts"]);

        // The collector's output already satisfies the planner's canonical
        // form, so planning must not reshape path identity or order.
        const plan = buildValidationPlan({ changedPaths: changes.paths, availableSpecs: [] });
        assert.deepEqual(plan.changedPaths, changes.paths);
    });

    it("reports both rename paths and deletions", async () => {
        const root = createFixtureRepo();
        write(path.join(root, "renamed-old.txt"), "rename me\n");
        write(path.join(root, "deleted.txt"), "delete me\n");
        git(["add", "-A"], root);
        git(["commit", "-m", "rename fodder"], root);
        git(["mv", "renamed-old.txt", "renamed-new.txt"], root);
        fs.rmSync(path.join(root, "deleted.txt"));

        const changes = await collectChangedPaths({ appRoot: root });
        assert.ok(changes.paths.includes("renamed-old.txt"), "origin path missing");
        assert.ok(changes.paths.includes("renamed-new.txt"), "target path missing");
        assert.ok(changes.paths.includes("deleted.txt"), "deletion missing");
    });

    it("handles spaces and unicode in untracked paths", async () => {
        const root = createFixtureRepo();
        write(path.join(root, "data set", "über file.txt"), "unicode\n");

        const changes = await collectChangedPaths({ appRoot: root });
        assert.deepEqual(changes.paths, ["data set/über file.txt"]);
    });

    it("unions committed branch changes with local changes for --base", async () => {
        const root = createFixtureRepo();
        const baseCommit = git(["rev-parse", "HEAD"], root).trim();
        git(["checkout", "-b", "feature"], root);
        write(path.join(root, "lib", "committed-on-branch.ts"), "export const committed = 1;\n");
        git(["add", "-A"], root);
        git(["commit", "-m", "branch work"], root);
        write(path.join(root, "lib", "local-only.ts"), "export const local = 1;\n");

        const changes = await collectChangedPaths({ appRoot: root, base: baseCommit });
        assert.equal(changes.baseCommit, baseCommit);
        assert.ok(changes.mergeBase);
        assert.ok(changes.paths.includes("lib/committed-on-branch.ts"), "committed change missing");
        assert.ok(changes.paths.includes("lib/local-only.ts"), "local change missing");
        assert.equal(changes.paths.includes("docs/guide.md"), false);
    });

    it("errors when the base ref does not resolve", async () => {
        const root = createFixtureRepo();
        await assert.rejects(
            collectChangedPaths({ appRoot: root, base: "no-such-ref-anywhere" }),
            /did not resolve to a commit/,
        );
    });

    it("returns an empty set for a clean worktree", async () => {
        const root = createFixtureRepo();
        const changes = await collectChangedPaths({ appRoot: root });
        assert.deepEqual(changes.paths, []);
    });

    for (const nested of [false, true]) {
        it(`scopes changes through a directory alias ${nested ? "with a nested app" : "of the repository root"}`, async () => {
            const root = createFixtureRepo();
            const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), "validate-changes-alias-"));
            fixtureRoots.push(aliasParent);
            const alias = path.join(aliasParent, "repo");
            fs.symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");

            const appDirectory = nested ? "app" : "";
            write(path.join(root, appDirectory, "inside.txt"), "inside\n");
            if (nested) write(path.join(root, "outside.txt"), "outside\n");

            const changes = await collectChangedPaths({ appRoot: path.join(alias, appDirectory) });
            assert.deepEqual(changes.paths, ["inside.txt"]);
            assert.deepEqual(changes.outOfScopePaths, nested ? ["outside.txt"] : []);
        });
    }

    it("keeps paths outside the app root out of scope", async () => {
        const root = createFixtureRepo();
        const appRoot = path.join(root, "app");
        fs.mkdirSync(appRoot, { recursive: true });
        write(path.join(root, "outside.txt"), "outside\n");
        write(path.join(appRoot, "inside.txt"), "inside\n");

        const changes = await collectChangedPaths({ appRoot });
        assert.deepEqual(changes.paths, ["inside.txt"]);
        assert.deepEqual(changes.outOfScopePaths, ["outside.txt"]);
    });
});

describe("runner summary evidence", () => {
    const fixtureResults = [
        { file: "tests/a.spec.ts", status: "PASS", durationMs: 1, exitCode: 0, signal: null, timedOut: false, logFile: "a.log" },
        { file: "tests/b.spec.ts", status: "PASS", durationMs: 1, exitCode: 0, signal: null, timedOut: false, logFile: "b.log" },
    ];
    const baseSummary = {
        generatedAt: "2026-10-04T00:00:00.000Z",
        selectedCount: 2,
        passedCount: 2,
        failedCount: 0,
        skippedCount: 0,
        durationMs: 12,
        timeoutMs: 120000,
        verbose: false,
        filters: ["finder-"],
        logsDir: "artifacts/test-logs/latest",
        results: fixtureResults,
    };
    const plannedSpecs = ["tests/a.spec.ts", "tests/b.spec.ts"];

    it("accepts a matching summary", () => {
        const parsed = parseRunnerSummary(JSON.stringify(baseSummary), ["finder-"], plannedSpecs);
        assert.equal(parsed.ok, true);
        if (parsed.ok) assert.equal(parsed.summary.failedCount, 0);
    });

    it("accepts a summary embedded in other stdout output", () => {
        const parsed = parseRunnerSummary(
            `warning noise\nline\n${JSON.stringify(baseSummary, null, 2)}\n`,
            ["finder-"],
            plannedSpecs,
        );
        assert.equal(parsed.ok, true);
    });

    it("rejects summaries that belong to another invocation", () => {
        const stale = { ...baseSummary, filters: ["stale-filter"] };
        const parsed = parseRunnerSummary(JSON.stringify(stale), ["finder-"], plannedSpecs);
        assert.equal(parsed.ok, false);
        if (!parsed.ok) assert.match(parsed.reason, /do not match this invocation/);

        const drifted = { ...baseSummary, selectedCount: 5 };
        const other = parseRunnerSummary(JSON.stringify(drifted), ["finder-"], plannedSpecs);
        assert.equal(other.ok, false);
        if (!other.ok) assert.match(other.reason, /selected 5 spec/);
    });

    it("rejects results that do not name the planned specs", () => {
        const identityMismatch = {
            ...baseSummary,
            results: [
                fixtureResults[0],
                { ...fixtureResults[1], file: "tests/someone-else.spec.ts" },
            ],
        };
        const parsed = parseRunnerSummary(JSON.stringify(identityMismatch), ["finder-"], plannedSpecs);
        assert.equal(parsed.ok, false);
        if (!parsed.ok) assert.match(parsed.reason, /do not match the planned specs/);
    });

    it("rejects missing or malformed summaries", () => {
        assert.equal(parseRunnerSummary("", ["finder-"], plannedSpecs).ok, false);
        const parsed = parseRunnerSummary("not json at all", ["finder-"], plannedSpecs);
        assert.equal(parsed.ok, false);
        if (!parsed.ok) assert.match(parsed.reason, /Could not parse/);
    });
});

describe("npm forwarded configuration", () => {
    it("accepts flags npm consumed and forwarded through npm_config_*", () => {
        const merged = applyNpmForwardedConfig(
            parseCliArgs([]),
            [],
            { npm_config_run: "true", npm_config_json: "1", npm_config_base: "origin/main" },
        );
        assert.deepEqual(merged, { base: "origin/main", run: true, json: true, help: false });
    });

    it("lets explicit argv flags win over forwarded values", () => {
        const merged = applyNpmForwardedConfig(
            parseCliArgs(["--run", "--base", "HEAD"]),
            ["--run", "--base", "HEAD"],
            { npm_config_run: "false", npm_config_base: "other-branch" },
        );
        assert.deepEqual(merged, { base: "HEAD", run: true, json: false, help: false });
    });

    it("ignores non-flag config values", () => {
        const merged = applyNpmForwardedConfig(
            parseCliArgs([]),
            [],
            { npm_config_base: "true", npm_config_json: "false", npm_config_run: "0" },
        );
        assert.deepEqual(merged, { base: null, run: false, json: false, help: false });
    });
});

describe("npm cli resolution", () => {
    it("prefers the explicit path and rejects an unresolvable environment", () => {
        assert.equal(resolveNpmCliPath("C:/fixture/npm-cli.js"), "C:/fixture/npm-cli.js");
        const previous = process.env.npm_execpath;
        delete process.env.npm_execpath;
        try {
            assert.throws(() => resolveNpmCliPath(), /npm_execpath/);
        } finally {
            if (previous !== undefined) process.env.npm_execpath = previous;
        }
    });
});

describe("report rendering", () => {
    const scope: ReportScope = {
        base: null,
        baseCommit: null,
        mergeBase: null,
        gitRoot: "fixture",
        appRoot: "fixture",
        outOfScopePaths: [],
    };

    it("distinguishes planned from executed checks and explains docs-only plans", () => {
        const plan = buildValidationPlan({ changedPaths: ["docs/finder.md"], availableSpecs: ["tests/finder-engine.spec.ts"] });
        const preview = renderHumanReport({ plan, scope, ran: false, generatedAt: "2026-10-04T00:00:00.000Z" });
        assert.match(preview, /preview \(read-only\)/);
        assert.match(preview, /Documentation-only change/);
        assert.match(preview, /code was not validated/);

        const executedPlan = buildValidationPlan({ changedPaths: ["lib/finder/finder-engine.ts"], availableSpecs: ["tests/finder-engine.spec.ts"] });
        const executed = renderHumanReport({
            plan: executedPlan,
            scope,
            ran: true,
            generatedAt: "2026-10-04T00:00:00.000Z",
            execution: {
                requested: true,
                success: true,
                interrupted: false,
                results: [{
                    checkId: "typecheck",
                    status: "PASS",
                    durationMs: 5,
                    exitCode: 0,
                    signal: null,
                    logFiles: [],
                }],
                tools: { node: process.version, npmCliPath: "npm", npmVersion: "10", cargoVersion: null },
            },
        });
        assert.match(executed, /Validation plan — executed/);
        assert.match(executed, /\[PASS\] typecheck/);

        const report = buildJsonReport({ plan: executedPlan, scope, ran: false, generatedAt: "2026-10-04T00:00:00.000Z" });
        assert.equal(report.formatVersion, 1);
        assert.ok(!("execution" in report));
        assert.ok(Array.isArray(report.checks));
    });
});

describe("check execution", () => {
    it("writes nothing without --run, including against a disposable repository", async () => {
        const root = createFixtureRepo();
        fs.writeFileSync(path.join(root, "lib", "tracked.ts"), "export const tracked = 2;\n", "utf8");
        const stdout = textWriter();
        const stderr = textWriter();
        const exitCode = await main(["--json"], { stdout: stdout.writer, stderr: stderr.writer }, { appRoot: root });
        assert.equal(exitCode, 0, stderr.text());
        const report = JSON.parse(stdout.text()) as {
            changedPaths: string[];
            fallbackApplied: boolean;
            selectedSpecs: string[];
            execution?: unknown;
        };
        assert.ok(report.changedPaths.includes("lib/tracked.ts"));
        assert.equal(report.fallbackApplied, true);
        assert.deepEqual(report.selectedSpecs, []);
        assert.equal(report.execution, undefined);
        assert.equal(
            fs.existsSync(path.join(root, "artifacts", "validation-logs")),
            false,
            "preview must not create validation logs",
        );
    });

    it("runs from a nested directory and keeps stdout a single JSON object", () => {
        const result = spawnSync(
            process.execPath,
            [esnoCliPath, validateChangesCliPath, "--json"],
            { cwd: path.join(APP_ROOT, "lib"), encoding: "utf8", timeout: 180000 },
        );
        assert.equal(result.status, 0, result.stderr);
        const report = JSON.parse(result.stdout) as { scope: { appRoot: string }; changedPaths: string[] };
        assert.equal(report.scope.appRoot, APP_ROOT);
        assert.ok(Array.isArray(report.changedPaths));
    });

    it("stops at the first failing check and marks the rest as not run", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "validate-changes-run-"));
        fixtureRoots.push(root);
        const npmFixture = path.join(root, "fixture-npm-cli.js");
        write(npmFixture, [
            "const script = process.argv[3];",
            "console.log('fixture npm run ' + script);",
            "if (script === 'typecheck:tests') process.exit(3);",
        ].join("\n"));

        const outcome = await executePlanChecks(fakePlan(["typecheck", "typecheck:tests", "e2e"]), {
            appRoot: root,
            logDir: path.join(root, "logs"),
            npmCliPath: npmFixture,
        });

        assert.equal(outcome.success, false);
        assert.deepEqual(outcome.results.map(result => result.status), ["PASS", "FAIL", "SKIPPED"]);
        assert.match(outcome.results[2].detail ?? "", /Not run after "typecheck:tests"/);
        const failureLog = fs.readFileSync(outcome.results[1].logFiles[0], "utf8");
        assert.match(failureLog, /fixture npm run typecheck:tests/);
    });

    it("attributes focused-run evidence from the runner's JSON summary", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "validate-changes-focus-"));
        fixtureRoots.push(root);
        const npmFixture = path.join(root, "fixture-npm-cli.js");
        write(npmFixture, "process.exit(0);");
        const runnerFixture = path.join(root, "fixture-runner.js");
        write(runnerFixture, [
            "const args = process.argv.slice(2);",
            "const jsonIndex = args.indexOf('--json');",
            "const filters = args.slice(0, jsonIndex < 0 ? args.length : jsonIndex);",
            "const scenario = process.env.FIXTURE_SCENARIO || 'pass';",
            "const results = [",
            "  { file: 'tests/a.spec.ts', status: 'PASS', durationMs: 1, exitCode: 0, signal: null, timedOut: false, logFile: 'a.log' },",
            "  { file: 'tests/b.spec.ts', status: 'PASS', durationMs: 1, exitCode: 0, signal: null, timedOut: false, logFile: 'b.log' },",
            "];",
            "const summary = {",
            "  generatedAt: new Date().toISOString(),",
            "  selectedCount: 2, passedCount: 2, failedCount: 0, skippedCount: 0,",
            "  durationMs: 4, timeoutMs: 1000, verbose: false, filters, logsDir: 'fixture', results,",
            "};",
            "if (scenario === 'fail') { summary.failedCount = 1; summary.passedCount = 1; results[1].status = 'FAIL'; }",
            "if (scenario === 'skip') { summary.skippedCount = 1; summary.passedCount = 1; results[1].status = 'SKIP'; results[1].skipReason = 'catalog unavailable'; }",
            "if (scenario === 'logerror') { results[0].logError = 'Disk full'; }",
            "if (scenario === 'stale') { summary.filters = ['stale-filter']; }",
            "process.stdout.write(JSON.stringify(summary, null, 2));",
            "if (scenario === 'exitfail') process.exit(1);",
        ].join("\n"));

        const options = {
            appRoot: root,
            logDir: path.join(root, "logs"),
            npmCliPath: npmFixture,
            focusedChild: { file: process.execPath, leadingArgs: [runnerFixture] },
        };
        const plannedSpecs = ["tests/a.spec.ts", "tests/b.spec.ts"];

        process.env.FIXTURE_SCENARIO = "pass";
        try {
            const passing = await executePlanChecks(fakePlan(["focused-tests"], ["finder-"], plannedSpecs), options);
            assert.equal(passing.success, true);
            assert.equal(passing.results[0].status, "PASS");
            assert.equal(passing.results[0].evidence?.selectedCount, 2);
        } finally {
            delete process.env.FIXTURE_SCENARIO;
        }

        process.env.FIXTURE_SCENARIO = "skip";
        try {
            const skipped = await executePlanChecks(fakePlan(["focused-tests"], ["finder-"], plannedSpecs), options);
            assert.equal(skipped.results[0].status, "FAIL");
            assert.match(skipped.results[0].detail ?? "", /incomplete/);
        } finally {
            delete process.env.FIXTURE_SCENARIO;
        }

        process.env.FIXTURE_SCENARIO = "logerror";
        try {
            const logErrorRun = await executePlanChecks(fakePlan(["focused-tests"], ["finder-"], plannedSpecs), options);
            assert.equal(logErrorRun.results[0].status, "FAIL");
            assert.match(logErrorRun.results[0].detail ?? "", /evidence incomplete/);
            assert.equal(logErrorRun.success, false);
        } finally {
            delete process.env.FIXTURE_SCENARIO;
        }

        process.env.FIXTURE_SCENARIO = "stale";
        try {
            const stale = await executePlanChecks(fakePlan(["focused-tests"], ["finder-"], plannedSpecs), options);
            assert.equal(stale.results[0].status, "FAIL");
            assert.match(stale.results[0].detail ?? "", /do not match this invocation/);
        } finally {
            delete process.env.FIXTURE_SCENARIO;
        }

        process.env.FIXTURE_SCENARIO = "fail";
        try {
            const failing = await executePlanChecks(fakePlan(["focused-tests"], ["finder-"], plannedSpecs), options);
            assert.equal(failing.results[0].status, "FAIL");
            assert.ok(failing.results[0].evidence?.failedSpecs.includes("tests/b.spec.ts"));
        } finally {
            delete process.env.FIXTURE_SCENARIO;
        }
    });

    it("validates fresh full-suite evidence before passing the full-js check", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "validate-changes-fulljs-"));
        fixtureRoots.push(root);
        const npmFixture = path.join(root, "fixture-npm-cli.js");
        write(npmFixture, [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "const scenario = process.env.FULLJS_SCENARIO || 'pass';",
            "if (scenario !== 'missing') {",
            "  const dir = path.join(process.cwd(), 'artifacts', 'test-logs', 'latest');",
            "  fs.mkdirSync(dir, { recursive: true });",
            "  const generatedAt = scenario === 'stale'",
            "    ? new Date(Date.now() - 600000).toISOString()",
            "    : new Date().toISOString();",
            "  const results = [",
            "    { file: 'tests/a.spec.ts', status: 'PASS', durationMs: 1, exitCode: 0, signal: null, timedOut: false, logFile: 'a.log' },",
            "    { file: 'tests/b.spec.ts', status: scenario === 'skipped' ? 'SKIP' : 'PASS', durationMs: 1, exitCode: 0, signal: null, timedOut: false, logFile: 'b.log' },",
            "  ];",
            "  if (scenario === 'skipped') results[1].skipReason = 'catalog unavailable';",
            "  const summary = {",
            "    generatedAt,",
            "    selectedCount: 2, passedCount: scenario === 'skipped' ? 1 : 2, failedCount: 0,",
            "    skippedCount: scenario === 'skipped' ? 1 : 0,",
            "    durationMs: 4, timeoutMs: 1000, verbose: false, filters: [], logsDir: dir, results,",
            "  };",
            "  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary));",
            "}",
            "process.exit(0);",
        ].join("\n"));

        const runScenario = async (scenario: string) => {
            fs.rmSync(path.join(root, "artifacts"), { recursive: true, force: true });
            process.env.FULLJS_SCENARIO = scenario;
            try {
                return await executePlanChecks(fakePlan(["full-js"]), {
                    appRoot: root,
                    logDir: path.join(root, "logs"),
                    npmCliPath: npmFixture,
                });
            } finally {
                delete process.env.FULLJS_SCENARIO;
            }
        };

        const passing = await runScenario("pass");
        assert.equal(passing.success, true, passing.results[0].detail);
        assert.equal(passing.results[0].status, "PASS");
        assert.equal(passing.results[0].evidence?.selectedCount, 2);

        const skipped = await runScenario("skipped");
        assert.equal(skipped.results[0].status, "FAIL");
        assert.match(skipped.results[0].detail ?? "", /full-suite evidence is incomplete/);

        const stale = await runScenario("stale");
        assert.equal(stale.results[0].status, "FAIL");
        assert.match(stale.results[0].detail ?? "", /refusing stale full-suite evidence/);

        const missing = await runScenario("missing");
        assert.equal(missing.results[0].status, "FAIL");
        assert.match(missing.results[0].detail ?? "", /full-suite evidence is missing/);
    });

    it("reports a missing cargo as an unmet check rather than a skip", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "validate-changes-rust-"));
        fixtureRoots.push(root);
        const npmFixture = path.join(root, "fixture-npm-cli.js");
        write(npmFixture, "process.exit(0);");

        const outcome = await executePlanChecks(fakePlan(["rust"]), {
            appRoot: root,
            logDir: path.join(root, "logs"),
            npmCliPath: npmFixture,
            cargoPath: path.join(root, "definitely-not-cargo"),
        });

        assert.equal(outcome.success, false);
        assert.equal(outcome.results[0].status, "UNMET");
        assert.match(outcome.results[0].detail ?? "", /cargo was not found/);
    });

    it("kills the active child and aborts the remaining checks", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "validate-changes-abort-"));
        fixtureRoots.push(root);
        const npmFixture = path.join(root, "fixture-npm-cli.js");
        write(npmFixture, "process.exit(0);");
        const sleeper = path.join(root, "fixture-sleeper.js");
        const startedMarker = path.join(root, "sleeper-started.flag");
        write(sleeper, [
            "const fs = require('node:fs');",
            `fs.writeFileSync(${JSON.stringify(startedMarker)}, '1');`,
            "setTimeout(() => process.exit(0), 60000);",
        ].join("\n"));

        const controller = new AbortController();
        const execution = executePlanChecks(fakePlan(["focused-tests", "e2e"], ["fixture-"], ["tests/fixture.spec.ts"]), {
            appRoot: root,
            logDir: path.join(root, "logs"),
            npmCliPath: npmFixture,
            focusedChild: { file: process.execPath, leadingArgs: [sleeper] },
            signal: controller.signal,
        });

        const startedAt = Date.now();
        while (!fs.existsSync(startedMarker)) {
            if (Date.now() - startedAt > 15000) throw new Error("sleeper child never started");
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        controller.abort();
        const outcome = await execution;

        assert.equal(outcome.interrupted, true);
        assert.equal(outcome.success, false);
        assert.equal(outcome.results[0].status, "FAIL");
        assert.equal(outcome.results[1].status, "SKIPPED");
        assert.match(outcome.results[1].detail ?? "", /Aborted/);
        assert.ok(Date.now() - startedAt < 30000, "abort should not wait for the sleeping child");
    });

    it("stops a spawned process tree promptly", async () => {
        const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 60000);"], {
            stdio: ["ignore", "ignore", "ignore"],
        });
        const exited = new Promise<void>((resolve) => {
            child.on("close", () => resolve());
        });
        await new Promise(resolve => setTimeout(resolve, 300));
        stopProcessTree(child);
        const startedAt = Date.now();
        await exited;
        assert.ok(Date.now() - startedAt < 15000, "process tree should terminate promptly");
    });
});
