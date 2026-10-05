/**
 * Shared server worker entry resolution and bundling
 * (`lib/server-worker-entry.ts`).
 *
 * Locks the contracts the Finder batch/universe pools and the TOP_MEAN
 * backtest/scan pools previously duplicated:
 *  - SOURCE SELECTION: repository source wins over the module-relative copy;
 *   a missing repository copy falls back to the module-relative one; a
 *   sibling `.js` of the selected source is preferred over bundling.
 *  - BUNDLING: a `.ts` source is esbuild-bundled to a content-addressed
 *   file under the caller's temporary namespace, and the bundle loads.
 *  - MEMO LIFETIMES: a caller-owned memo skips rebuilds while the source is
 *   unchanged AND the cached output still exists; a missing cached output
 *   rebuilds; no memo (TOP_MEAN policy) rebuilds every resolution.
 *  - FALLBACK: empty build output and build failures resolve to the raw
 *   source path (the pools surface the later worker-start failure).
 *  - CONCURRENT PUBLICATION: concurrent callers obtain the same complete,
 *   loadable bundle even when several publish at once.
 *
 * Fixtures are temporary files under `os.tmpdir()` and removed on settle;
 * the content-addressed spec namespaces under `os.tmpdir()` are best-effort
 * cleaned the same way. Each case uses its own source files so resolution
 * state cannot leak between cases.
 */

import { expect } from "chai";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import {
    resolveWorkerEntryPath,
    type WorkerBundleMemoRecord,
} from "../lib/server-worker-entry";
import { resolveAssetOpportunityBatchWorkerPath } from "../lib/finder/server/finder-asset-opportunity-batch-worker-pool";
import { resolveUniverseStrategyWorkerPath } from "../lib/finder/server/finder-universe-strategy-pool";
import type { AssetOpportunityBatchWorkerCommand } from "../lib/finder/server/finder-asset-opportunity-batch-worker";

const requireFixture = createRequire(import.meta.url);

describe("server worker entry resolution", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "server-worker-entry-spec-"));
    const repoDir = join(fixtureRoot, "repo", "lib", "fixture");
    const moduleDir = join(fixtureRoot, "module");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(moduleDir, { recursive: true });
    // Unique content per run forces a fresh content-addressed publication
    // even when a previous run left the output in place.
    const marker = (label: string): string => `${label}-${fixtureRoot}`;

    let namespaceSequence = 0;
    const nextNamespace = (): string => `server-worker-entry-spec-${++namespaceSequence}`;

    after(async () => {
        rmSync(fixtureRoot, { recursive: true, force: true });
        for (let index = 1; index <= namespaceSequence; index += 1) {
            // Best-effort cleanup of the spec's content-addressed roots;
            // ignore failures from another process still reading a bundle.
            await rm(join(tmpdir(), `server-worker-entry-spec-${index}`), { recursive: true, force: true }).catch(
                () => undefined,
            );
        }
    });

    it("prefers the repository source over the module-relative copy", async () => {
        const repositorySource = join(repoDir, "precedence-worker.ts");
        const moduleSource = join(moduleDir, "precedence-worker.ts");
        writeFileSync(repositorySource, `export const workerMarker = ${JSON.stringify(marker("repo"))};\n`);
        writeFileSync(moduleSource, `export const workerMarker = ${JSON.stringify(marker("module"))};\n`);
        const resolved = await resolveWorkerEntryPath({
            repositorySourcePath: repositorySource,
            moduleSourcePath: moduleSource,
            temporaryNamespace: nextNamespace(),
            outputFileName: "worker.cjs",
        });
        expect(requireFixture(resolved).workerMarker).to.equal(marker("repo"));
    });

    it("falls back to the module-relative source when the repository copy is missing", async () => {
        const moduleSource = join(moduleDir, "fallback-worker.ts");
        writeFileSync(moduleSource, `export const workerMarker = ${JSON.stringify(marker("module-fallback"))};\n`);
        const resolved = await resolveWorkerEntryPath({
            repositorySourcePath: join(repoDir, "does-not-exist-worker.ts"),
            moduleSourcePath: moduleSource,
            temporaryNamespace: nextNamespace(),
            outputFileName: "worker.cjs",
        });
        expect(requireFixture(resolved).workerMarker).to.equal(marker("module-fallback"));
    });

    it("prefers the sibling .js of the selected source over bundling", async () => {
        const repositorySource = join(repoDir, "sibling-case-worker.ts");
        const repositorySiblingJs = join(repoDir, "sibling-case-worker.js");
        writeFileSync(repositorySource, `export const workerMarker = "never-bundled";\n`);
        writeFileSync(repositorySiblingJs, `exports.workerMarker = "sibling-js-source";\n`);
        const resolved = await resolveWorkerEntryPath({
            repositorySourcePath: repositorySource,
            moduleSourcePath: join(moduleDir, "sibling-case-worker.ts"),
            temporaryNamespace: nextNamespace(),
            outputFileName: "worker.cjs",
        });
        expect(resolved).to.equal(repositorySiblingJs);
        // Verified by content: the spec runner's require hook redirects .js
        // specifiers to sibling .ts sources, so require() cannot observe the
        // difference here. Production requires the file it was handed.
        expect(readFileSync(repositorySiblingJs, "utf8")).to.include("sibling-js-source");
    });

    it("bundles a .ts source into the namespace directory as a loadable output", async () => {
        const namespace = nextNamespace();
        const repositorySource = join(repoDir, "bundle-worker.ts");
        const moduleSource = join(moduleDir, "bundle-worker.ts");
        writeFileSync(repositorySource, `export const workerMarker = ${JSON.stringify(marker("bundled"))};\n`);
        writeFileSync(moduleSource, `export const workerMarker = "unused";\n`);
        const resolved = await resolveWorkerEntryPath({
            repositorySourcePath: repositorySource,
            moduleSourcePath: moduleSource,
            temporaryNamespace: namespace,
            outputFileName: "worker.cjs",
        });
        expect(resolved).to.include(namespace);
        expect(resolved.endsWith("worker.cjs")).to.equal(true);
        expect(requireFixture(resolved).workerMarker).to.equal(marker("bundled"));
    });

    it("rebuilds when the memo's cached output file is missing", async () => {
        const namespace = nextNamespace();
        const repositorySource = join(repoDir, "memo-worker.ts");
        const moduleSource = join(moduleDir, "memo-worker.ts");
        writeFileSync(repositorySource, `export const workerMarker = ${JSON.stringify(marker("memo"))};\n`);
        writeFileSync(moduleSource, `export const workerMarker = "unused";\n`);
        const memo: { record: WorkerBundleMemoRecord | null } = { record: null };
        const base = {
            repositorySourcePath: repositorySource,
            moduleSourcePath: moduleSource,
            temporaryNamespace: namespace,
            outputFileName: "worker.cjs",
            memo,
        };
        const first = await resolveWorkerEntryPath(base);
        expect(memo.record?.outfile).to.equal(first);
        rmSync(first);
        expect(existsSync(first)).to.equal(false);

        const second = await resolveWorkerEntryPath(base);
        // Same content hashes to the same output path, which was republished.
        expect(second).to.equal(first);
        expect(existsSync(second)).to.equal(true);
        expect(memo.record?.outfile).to.equal(second);
    });

    it("skips the build while the memo's source and cached output are unchanged", async () => {
        const namespace = nextNamespace();
        const repositorySource = join(repoDir, "memo-skip-worker.ts");
        const moduleSource = join(moduleDir, "memo-skip-worker.ts");
        // The memo check stats the source, so the fixture must exist even
        // though the build seam fabricates the bundle contents.
        writeFileSync(repositorySource, `export const workerMarker = "unused";\n`);
        writeFileSync(moduleSource, `export const workerMarker = "unused";\n`);
        let builds = 0;
        const memo: { record: WorkerBundleMemoRecord | null } = { record: null };
        const base = {
            repositorySourcePath: repositorySource,
            moduleSourcePath: moduleSource,
            temporaryNamespace: namespace,
            outputFileName: "worker.cjs",
            memo,
            build: async (): Promise<{ outputFiles?: Array<{ contents: Uint8Array }> }> => ({
                outputFiles: [{ contents: new TextEncoder().encode(`exports.workerMarker = "stub-${++builds}";`)}],
            }),
        };
        const first = await resolveWorkerEntryPath(base);
        const second = await resolveWorkerEntryPath(base);
        expect(builds).to.equal(1, "an unchanged source with an existing output must not rebuild");
        expect(second).to.equal(first);
        expect(requireFixture(second).workerMarker).to.equal("stub-1");

        // Without a memo (the TOP_MEAN policy) every resolution builds; the
        // content-addressed output path is still stable and complete.
        let unmemoizedBuilds = 0;
        const unmemoizedRepositorySource = join(repoDir, "no-memo-worker.ts");
        writeFileSync(unmemoizedRepositorySource, `export const workerMarker = "unused";\n`);
        writeFileSync(join(moduleDir, "no-memo-worker.ts"), `export const workerMarker = "unused";\n`);
        const unmemoizedBase = {
            repositorySourcePath: unmemoizedRepositorySource,
            moduleSourcePath: join(moduleDir, "no-memo-worker.ts"),
            temporaryNamespace: nextNamespace(),
            outputFileName: "worker.cjs",
            build: async (): Promise<{ outputFiles?: Array<{ contents: Uint8Array }> }> => ({
                outputFiles: [{ contents: new TextEncoder().encode(`exports.workerMarker = ${JSON.stringify(marker(`unmemoized-${++unmemoizedBuilds}`))};`)}],
            }),
        };
        const unmemoizedFirst = await resolveWorkerEntryPath(unmemoizedBase);
        const unmemoizedSecond = await resolveWorkerEntryPath(unmemoizedBase);
        expect(unmemoizedBuilds).to.equal(2, "no memo means every resolution builds");
        expect(unmemoizedSecond).to.equal(unmemoizedFirst);
        expect(requireFixture(unmemoizedSecond).workerMarker).to.equal(marker("unmemoized-2"));
    });

    it("falls back to the raw source when the build output is empty or the build fails", async () => {
        const repositorySource = join(repoDir, "failure-worker.ts");
        writeFileSync(repositorySource, `export const workerMarker = ${JSON.stringify(marker("failure"))};\n`);
        const base = {
            repositorySourcePath: repositorySource,
            moduleSourcePath: join(moduleDir, "failure-worker.ts"),
            temporaryNamespace: nextNamespace(),
            outputFileName: "worker.cjs",
        };
        const emptyResolved = await resolveWorkerEntryPath({
            ...base,
            build: async (): Promise<{ outputFiles?: Array<{ contents: Uint8Array }> }> => ({
                outputFiles: [{ contents: new Uint8Array(0) }],
            }),
        });
        expect(emptyResolved).to.equal(repositorySource);

        const failedResolved = await resolveWorkerEntryPath({
            ...base,
            temporaryNamespace: nextNamespace(),
            build: async (): Promise<{ outputFiles?: Array<{ contents: Uint8Array }> }> => {
                throw new Error("simulated esbuild failure");
            },
        });
        expect(failedResolved).to.equal(repositorySource);
    });

    it("gives every concurrent caller the same complete, loadable bundle", async () => {
        const namespace = nextNamespace();
        const repositorySource = join(repoDir, "concurrent-worker.ts");
        const moduleSource = join(moduleDir, "concurrent-worker.ts");
        writeFileSync(repositorySource, `export const workerMarker = ${JSON.stringify(marker("concurrent"))};\n`);
        writeFileSync(moduleSource, `export const workerMarker = "unused";\n`);
        const base = {
            repositorySourcePath: repositorySource,
            moduleSourcePath: moduleSource,
            temporaryNamespace: namespace,
            outputFileName: "worker.cjs",
        };
        const results = await Promise.all(Array.from({ length: 8 }, () => resolveWorkerEntryPath(base)));
        expect(new Set(results).size).to.equal(1, "all concurrent callers resolve the same entry");
        expect(requireFixture(results[0]!).workerMarker).to.equal(marker("concurrent"));
    });
});

/**
 * Real-worker smokes for the two Finder entries. The pools' fake-runner specs
 * never prove that the shared helper's bundle actually BOOTS in a
 * worker_threads isolate; these cases start the resolved entry, exchange one
 * task message (each deterministic terminal event originates INSIDE the
 * worker, after full bootstrap), and terminate cleanly. A bundling failure
 * surfaces as a worker `error`/`exit` event instead.
 */
describe("real Finder worker entry smokes", () => {
    function runOneTaskInRealWorker(
        workerPath: string,
        message: unknown,
        label: string,
    ): Promise<{ type: string; error?: string }> {
        const worker = new Worker(workerPath, {});
        return new Promise<{ type: string; error?: string }>((resolveOutcome, rejectOutcome) => {
            const timer = setTimeout(() => rejectOutcome(new Error(`${label} smoke timed out`)), 30000);
            worker.on("message", (message: { type: string; error?: string }) => {
                clearTimeout(timer);
                resolveOutcome(message);
            });
            worker.on("error", (error) => {
                clearTimeout(timer);
                rejectOutcome(error);
            });
            worker.on("exit", (code) => {
                clearTimeout(timer);
                rejectOutcome(new Error(`${label} worker exited early with code ${code}`));
            });
            worker.postMessage(message);
        }).finally(() => worker.terminate());
    }

    it("boots the Asset Opportunity batch bundle and answers one task message", async () => {
        const workerPath = await resolveAssetOpportunityBatchWorkerPath();
        expect(existsSync(workerPath)).to.equal(true);
        // An empty strategy selection is the worker's first in-task
        // validation, so the task fatals deterministically AFTER bootstrap.
        const task = {
            taskIndex: 0,
            holdoutBars: 2,
            runId: "server-worker-entry-smoke",
            interval: "5m",
            symbols: [] as string[],
            options: { dataSlice: "all" },
            settings: {
                executionModel: "signal_close",
                tradeDirection: "long",
                allowSameBarExit: true,
                slippageBps: 0,
                marketMode: "all",
            },
            capitalSettings: {
                initialCapital: 10000,
                positionSize: 100,
                commission: 0,
                sizingMode: "percent",
                fixedTradeAmount: 1000,
            },
            strategyKeys: [] as string[],
            exitStrategyKeys: [] as string[],
            useRustEnginePreference: false,
            candidatePoolSize: 2,
            minFreshSupport: 1,
        };
        const command: AssetOpportunityBatchWorkerCommand = { type: "run_task", task: task as never };
        const outcome = await runOneTaskInRealWorker(workerPath, command, "batch");
        expect(outcome.type).to.equal("iteration_fatal");
        expect(outcome.error).to.include("at least one selected strategy");
    });

    it("boots the universe strategy bundle and answers one task message", async () => {
        const workerPath = await resolveUniverseStrategyWorkerPath();
        expect(existsSync(workerPath)).to.equal(true);
        // An unknown strategy key fatals deterministically AFTER bootstrap
        // (strict resolution is the task's first step).
        const outcome = await runOneTaskInRealWorker(
            workerPath,
            {
                type: "run_task",
                task: {
                    taskIndex: 0,
                    strategyKey: "no-such-strategy-key",
                    exitStrategyKeys: [] as string[],
                    interval: "5m",
                    symbols: [] as string[],
                    options: { dataSlice: "all" },
                },
            },
            "universe",
        );
        expect(outcome.type).to.equal("strategy_fatal");
        expect(outcome.error).to.include("Strategy not loaded");
    });
});
