import { expect } from "chai";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { __testInternals } from "../lib/asset-opportunity-explorer/server-vite-plugin";
import {
    readArchiveFileWithChangeDetection,
    scanAssetOpportunityArchive,
    type ArchiveFileIo,
    type ArchiveScanIo,
    type AssetOpportunityArchiveScanOutcome,
} from "../lib/asset-opportunity-explorer/archive-reader";
import { ExplorerAnalysisError } from "../lib/asset-opportunity-explorer/analysis";
import type { AssetOpportunityExplorerHeatmapResponse } from "../lib/asset-opportunity-explorer/types";

const {
    registerAssetOpportunityExplorerRoutesForTests,
    setServerRootForTests,
    setScanRunnerForTests,
    resetForTests,
    getSnapshotForTests,
    getRetainedViewForTests,
    getCatalogForTests,
} = __testInternals;

type RouteHandler = (req: any, res: any) => Promise<void>;

function captureRoutes(): Map<string, RouteHandler> {
    const routes = new Map<string, RouteHandler>();
    registerAssetOpportunityExplorerRoutesForTests({
        use: (route: string, handler: RouteHandler) => routes.set(route, handler),
    });
    return routes;
}

function makeRequest(url: string, remoteAddress = "127.0.0.1"): any {
    const request = Readable.from([]) as any;
    request.method = "GET";
    request.url = url;
    request.headers = { host: "127.0.0.1:5173" };
    request.socket = { remoteAddress };
    return request;
}

function makeResponse(): any {
    return {
        statusCode: 0,
        body: "",
        setHeader() { return undefined; },
        write(value: string) { this.body += value; return true; },
        end(value = "") { this.body += value; this.ended = true; },
        on() { return this; },
    };
}

async function dispatch(routes: Map<string, RouteHandler>, route: string, url: string, remoteAddress?: string): Promise<{ status: number; body: any }> {
    const handler = routes.get(route)!;
    const res = makeResponse();
    await handler(makeRequest(url, remoteAddress), res);
    return { status: res.status ?? res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

function archiveRow(rank: number, pnl: number | null, sampleSize: number, symbol = "AAA"): Record<string, unknown> {
    return {
        scope: "asset_opportunity",
        rank,
        symbol,
        strategyId: "strategy_a",
        strategyName: "Strategy A",
        candidateFingerprint: `fp-${rank}`,
        forwardOosPerformance: {
            ignoreLastBars: 12,
            basis: "base_only",
            horizons: [{
                bars: 6,
                pnlPercent: pnl,
                averagePnlPercent: pnl,
                winRatePercent: null,
                sampleSize,
            }],
        },
    };
}

function block(args: {
    timestamp: string;
    runId: string;
    holdoutBars: number;
    sortMetric: string;
    rows: unknown[];
    baseline?: unknown;
    measurementMode?: string;
}): string {
    return [
        "=".repeat(80),
        `Timestamp: ${args.timestamp}`,
        `Batch run id: ${args.runId}`,
        `OOS holdout: ${args.holdoutBars} bars`,
        `Archive sort: ${args.sortMetric}`,
        ...(args.measurementMode === undefined ? [] : [`Forward measurement: ${args.measurementMode}`]),
        ...(args.baseline === undefined
            ? []
            : [`Archive baseline: ${JSON.stringify(args.baseline)}`]),
        "=".repeat(80),
        JSON.stringify(args.rows),
        "=".repeat(80),
        "",
    ].join("\n");
}

async function createFixtureRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "asset-opportunity-explorer-"));
    const archiveDir = path.join(root, "archive", "asset opportunity");
    await mkdir(archiveDir, { recursive: true });
    await writeFile(path.join(archiveDir, "oos-holdout-12-bars.txt"), block({
        timestamp: "2026-09-25T01:00:00.000Z",
        runId: "run-a",
        holdoutBars: 12,
        sortMetric: "expectancy",
        rows: [
            archiveRow(1, 4, 1),
            archiveRow(2, 2, 1, "BBB"),
        ],
        baseline: {
            eligibleCandidateCount: 20,
            horizons: [{
                bars: 6,
                averagePnlPercent: 1,
                sampleWeightedAveragePnlPercent: 1,
                positiveResults: 12,
                observedResults: 20,
                totalSamples: 20,
            }],
        },
    }));
    await writeFile(path.join(archiveDir, "oos-holdout-24-bars.txt"), block({
        timestamp: "2026-09-25T02:00:00.000Z",
        runId: "run-a",
        holdoutBars: 24,
        sortMetric: "expectancy",
        rows: [archiveRow(1, -3, 2)],
    }));
    await writeFile(path.join(archiveDir, "oos-holdout-36-bars.txt"), block({
        timestamp: "2026-09-25T03:00:00.000Z",
        runId: "run-next-exit",
        holdoutBars: 36,
        sortMetric: "expectancy",
        measurementMode: "next_exit",
        rows: [],
    }));
    // Non-matching entries must be ignored entirely.
    await writeFile(path.join(archiveDir, "config.txt"), "ignored");
    await writeFile(path.join(archiveDir, "holdout-analysis.json"), "{}");
    await mkdir(path.join(archiveDir, "archived runs"));
    await writeFile(path.join(archiveDir, "archived runs", "oos-holdout-48-bars.txt"), block({
        timestamp: "2026-09-25T04:00:00.000Z",
        runId: "run-nested",
        holdoutBars: 48,
        sortMetric: "expectancy",
        rows: [],
    }));
    return root;
}

describe("Asset Opportunity Explorer server", () => {
    let routes: Map<string, RouteHandler>;
    let root: string;

    afterEach(async () => {
        resetForTests();
        if (root) await rm(root, { recursive: true, force: true });
    });

    it("rejects unauthorized remote requests on every route", async () => {
        root = await createFixtureRoot();
        setServerRootForTests(root);
        routes = captureRoutes();
        for (const route of routes.keys()) {
            const url = route === "/api/asset-opportunity-explorer/heatmap"
                ? `${route}?batchRunId=run-a&horizonBars=6&topK=2&spacing=all`
                : route === "/api/asset-opportunity-explorer/details"
                    ? `${route}?snapshotId=x&sortMetric=expectancy&horizonBars=6&holdoutFrom=12&holdoutTo=12&metric=actual`
                    : route;
            const response = await dispatch(routes, route, url, "192.168.1.10");
            expect(response.status, route).to.equal(401);
            expect(response.body.ok, route).to.equal(false);
        }
    });

    it("catalogs matching files only, newest run first, and ignores subfolders", async () => {
        root = await createFixtureRoot();
        setServerRootForTests(root);
        routes = captureRoutes();
        const { status, body } = await dispatch(routes, "/api/asset-opportunity-explorer/catalog", "?");
        expect(status).to.equal(200);
        expect(body.ok).to.equal(true);
        expect(body.archiveRoot).to.equal("archive/asset opportunity");
        expect(body.fileCount).to.equal(3);
        expect(body.runs.map((run: { batchRunId: string }) => run.batchRunId)).to.deep.equal(["run-next-exit", "run-a"]);
        const runA = body.runs.find((run: { batchRunId: string }) => run.batchRunId === "run-a");
        expect(runA.holdoutBars).to.deep.equal([12, 24]);
        expect(runA.support).to.equal("fixed_horizon");
        expect(runA.archiveMaximumRank).to.equal(2);
        expect(runA.hasBaselines).to.equal(true);
        expect(body.runs.find((run: { batchRunId: string }) => run.batchRunId === "run-next-exit").support).to.equal("next_exit");
        // Second call is served from the retained catalog scan.
        const again = await dispatch(routes, "/api/asset-opportunity-explorer/catalog", "?");
        expect(again.body.scannedAt).to.equal(body.scannedAt);
    });

    it("fails the scan with the affected filename instead of serving a partial archive", async () => {
        root = await createFixtureRoot();
        await writeFile(path.join(root, "archive", "asset opportunity", "oos-holdout-60-bars.txt"), "not an archive");
        setServerRootForTests(root);
        routes = captureRoutes();
        const { status, body } = await dispatch(routes, "/api/asset-opportunity-explorer/catalog", "?refresh=1");
        expect(status).to.equal(422);
        expect(body.ok).to.equal(false);
        expect(body.error).to.contain("oos-holdout-60-bars.txt");
        // The failed scan published nothing; the previously retained state (if
        // any) stays untouched for the UI to mark stale.
        expect(getSnapshotForTests()).to.equal(null);
    });

    it("returns an explicit empty catalog for a missing archive folder", async () => {
        root = await mkdtemp(path.join(tmpdir(), "asset-opportunity-explorer-empty-"));
        setServerRootForTests(root);
        routes = captureRoutes();
        const { status, body } = await dispatch(routes, "/api/asset-opportunity-explorer/catalog", "?");
        expect(status).to.equal(200);
        expect(body.fileCount).to.equal(0);
        expect(body.runs).to.deep.equal([]);
    });

    it("rejects invalid queries, unknown runs, and over-limit topK", async () => {
        root = await createFixtureRoot();
        setServerRootForTests(root);
        routes = captureRoutes();
        const heatmap = "/api/asset-opportunity-explorer/heatmap";
        const cases: Array<[string, string, number]> = [
            ["missing run", `${heatmap}?horizonBars=6&topK=2`, 400],
            ["zero horizon", `${heatmap}?batchRunId=run-a&horizonBars=0&topK=2`, 400],
            ["non-integer topK", `${heatmap}?batchRunId=run-a&horizonBars=6&topK=1.5`, 400],
            ["bad spacing", `${heatmap}?batchRunId=run-a&horizonBars=6&topK=2&spacing=none`, 400],
            ["unknown run", `${heatmap}?batchRunId=run-xyz&horizonBars=6&topK=2`, 400],
            ["over-limit topK", `${heatmap}?batchRunId=run-a&horizonBars=6&topK=99`, 400],
            ["unknown horizon", `${heatmap}?batchRunId=run-a&horizonBars=9&topK=2`, 400],
        ];
        for (const [label, url, expected] of cases) {
            const response = await dispatch(routes, heatmap, url.replace(heatmap, ""));
            expect(response.status, label).to.equal(expected);
            expect(response.body.ok, label).to.equal(false);
        }
    });

    it("builds the heatmap snapshot with cells, metadata, and no candidate arrays", async () => {
        root = await createFixtureRoot();
        setServerRootForTests(root);
        routes = captureRoutes();
        const { status, body } = await dispatch(
            routes,
            "/api/asset-opportunity-explorer/heatmap",
            "?batchRunId=run-a&horizonBars=6&topK=2&spacing=all",
        );
        expect(status).to.equal(200);
        const heatmap = body as AssetOpportunityExplorerHeatmapResponse;
        expect(heatmap.snapshotId).to.be.a("string");
        expect(heatmap.batchRunId).to.equal("run-a");
        expect(heatmap.holdoutBars).to.deep.equal([24, 12]);
        expect(heatmap.sorts).to.deep.equal(["expectancy"]);
        expect(heatmap.basis).to.equal("base_only");
        expect(heatmap.measurementMode).to.equal("fixed_horizon");
        const cell24 = heatmap.cells.find((cell) => cell.holdoutBars === 24)!;
        expect(cell24.actual).to.equal(-3);
        expect(cell24.baseline).to.equal(null);
        expect(cell24.delta).to.equal(null);
        expect(cell24.observedRows).to.equal(1);
        const cell12 = heatmap.cells.find((cell) => cell.holdoutBars === 12)!;
        expect(cell12.actual).to.equal(3);
        expect(cell12.baseline).to.equal(1);
        expect(cell12.delta).to.equal(2);
        expect(heatmap.diagnostics.observedRows).to.equal(3);
        expect(heatmap.diagnostics.unknownFingerprintRows).to.equal(0);
        // No candidate arrays on the wire.
        expect(Object.keys(heatmap)).to.not.include.members(["rows", "data", "topResults", "trades"]);
        for (const cell of heatmap.cells) {
            for (const value of Object.values(cell)) {
                expect(["number", "string", "object"]).to.include(typeof value);
                if (value === null || typeof value !== "object") continue;
                expect(Array.isArray(value)).to.equal(false);
            }
        }
    });

    it("reuses the retained snapshot for identical params and replaces it on change", async () => {
        root = await createFixtureRoot();
        setServerRootForTests(root);
        routes = captureRoutes();
        const first = await dispatch(routes, "/api/asset-opportunity-explorer/heatmap", "?batchRunId=run-a&horizonBars=6&topK=2&spacing=all");
        const second = await dispatch(routes, "/api/asset-opportunity-explorer/heatmap", "?batchRunId=run-a&horizonBars=6&topK=2&spacing=all");
        expect(second.body.snapshotId).to.equal(first.body.snapshotId);
        const changedK = await dispatch(routes, "/api/asset-opportunity-explorer/heatmap", "?batchRunId=run-a&horizonBars=6&topK=1&spacing=all");
        expect(changedK.body.snapshotId).to.not.equal(first.body.snapshotId);
        expect(getSnapshotForTests()?.response.topK).to.equal(1);
    });

    it("serves detail pages that reconcile with full-range counts and bounded pages", async () => {
        root = await createFixtureRoot();
        setServerRootForTests(root);
        routes = captureRoutes();
        const heatmap = await dispatch(routes, "/api/asset-opportunity-explorer/heatmap", "?batchRunId=run-a&horizonBars=6&topK=2&spacing=all");
        const snapshotId = heatmap.body.snapshotId as string;
        const detailsUrl = (extra: string) =>
            `/api/asset-opportunity-explorer/details?snapshotId=${encodeURIComponent(snapshotId)}&sortMetric=expectancy&horizonBars=6&holdoutFrom=12&holdoutTo=24&metric=actual&${extra}`;
        const page = await dispatch(routes, "/api/asset-opportunity-explorer/details", detailsUrl("offset=0&limit=1"));
        expect(page.status).to.equal(200);
        expect(page.body.rows).to.have.length(1);
        expect(page.body.hasMore).to.equal(true);
        expect(page.body.totalRows).to.equal(3);
        expect(page.body.unit).to.equal("%");
        expect(page.body.summary.totalHoldouts).to.equal(2);
        expect(page.body.summary.observedHoldouts).to.equal(2);
        // AAA/fp-1 recurs across both holdouts: one unique identity.
        expect(page.body.summary.uniqueCandidates).to.equal(2);
        // Full range in one page reconciles with the counts above.
        const full = await dispatch(routes, "/api/asset-opportunity-explorer/details", detailsUrl("offset=0&limit=500"));
        expect(full.body.rows).to.have.length(3);
        expect(full.body.hasMore).to.equal(false);
        // Page bounds.
        const tooLarge = await dispatch(routes, "/api/asset-opportunity-explorer/details", detailsUrl("offset=0&limit=501"));
        expect(tooLarge.status).to.equal(400);
        const beyondEnd = await dispatch(routes, "/api/asset-opportunity-explorer/details", detailsUrl("offset=99&limit=100"));
        expect(beyondEnd.body.rows).to.deep.equal([]);
        expect(beyondEnd.body.hasMore).to.equal(false);
        // Delta metric reports percentage-point units.
        const delta = await dispatch(routes, "/api/asset-opportunity-explorer/details", detailsUrl("offset=0&limit=100").replace("metric=actual", "metric=delta"));
        expect(delta.body.unit).to.equal("pp");
    });

    it("returns 409 with a reload hint for evicted snapshots after a run change", async () => {
        root = await createFixtureRoot();
        setServerRootForTests(root);
        routes = captureRoutes();
        const heatmap = await dispatch(routes, "/api/asset-opportunity-explorer/heatmap", "?batchRunId=run-a&horizonBars=6&topK=2&spacing=all");
        const snapshotId = heatmap.body.snapshotId as string;
        const detailsUrl = `/api/asset-opportunity-explorer/details?snapshotId=${encodeURIComponent(snapshotId)}&sortMetric=expectancy&horizonBars=6&holdoutFrom=12&holdoutTo=12&metric=actual`;
        const ok = await dispatch(routes, "/api/asset-opportunity-explorer/details", detailsUrl);
        expect(ok.status).to.equal(200);
        // Switching runs replaces the retained view; the old snapshot id is stale.
        await dispatch(routes, "/api/asset-opportunity-explorer/heatmap", "?batchRunId=run-next-exit&horizonBars=6&topK=2");
        const stale = await dispatch(routes, "/api/asset-opportunity-explorer/details", detailsUrl);
        expect(stale.status).to.equal(409);
        expect(stale.body.error).to.contain("reload");
    });

    it("explains next-exit runs instead of building a heatmap", async () => {
        root = await createFixtureRoot();
        setServerRootForTests(root);
        routes = captureRoutes();
        const response = await dispatch(routes, "/api/asset-opportunity-explorer/heatmap", "?batchRunId=run-next-exit&horizonBars=6&topK=2");
        expect(response.status).to.equal(409);
        expect(response.body.error).to.contain("next-exit");
    });

    it("refresh bypasses the cached catalog and invalidates the retained snapshot", async () => {
        root = await createFixtureRoot();
        setServerRootForTests(root);
        routes = captureRoutes();
        await dispatch(routes, "/api/asset-opportunity-explorer/heatmap", "?batchRunId=run-a&horizonBars=6&topK=2");
        expect(getSnapshotForTests()).to.not.equal(null);
        await dispatch(routes, "/api/asset-opportunity-explorer/catalog", "?refresh=1");
        expect(getSnapshotForTests()).to.equal(null);
        const cached = await dispatch(routes, "/api/asset-opportunity-explorer/catalog", "?");
        expect(cached.body.scannedAt).to.be.a("string");
    });

    it("surfaces a retryable archive-changed error when a file is appended mid-read", async () => {
        root = await createFixtureRoot();
        const filePath = path.join(root, "archive", "asset opportunity", "oos-holdout-12-bars.txt");
        const original = await import("node:fs/promises");
        let calls = 0;
        const changingIo: ArchiveFileIo = {
            async stat() {
                calls += 1;
                return { size: calls > 1 ? 999 : 100, mtimeMs: calls > 1 ? 2 : 1 };
            },
            readFile: () => original.readFile(filePath, "utf8"),
        };
        try {
            await readArchiveFileWithChangeDetection({ filePath, filename: "oos-holdout-12-bars.txt", io: changingIo });
            expect.fail("mid-read change must fail the read");
        } catch (error) {
            expect(error).to.be.instanceOf(ExplorerAnalysisError);
            expect((error as ExplorerAnalysisError).status).to.equal(409);
        }
    });

    it("never serves filesystem paths from client input", async () => {
        root = await createFixtureRoot();
        setServerRootForTests(root);
        routes = captureRoutes();
        const traversal = await dispatch(
            routes,
            "/api/asset-opportunity-explorer/heatmap",
            `?batchRunId=${encodeURIComponent("../../price-data")}&horizonBars=6&topK=2`,
        );
        expect(traversal.status).to.equal(400);
        expect(traversal.body.error).to.contain("Unknown batch run");
    });

    it("scans without retaining records for runs other than the requested one", async () => {
        root = await createFixtureRoot();
        const outcome = await scanAssetOpportunityArchive({ root, retainRunId: "run-a" });
        expect(outcome.view?.batchRunId).to.equal("run-a");
        expect(outcome.view?.blocks).to.have.length(2);
        expect(outcome.runs.map((run) => run.batchRunId)).to.deep.equal(["run-next-exit", "run-a"]);
        const metadataOnly = await scanAssetOpportunityArchive({ root, retainRunId: null });
        expect(metadataOnly.view).to.equal(null);
    });

    it("treats a missing archive directory as empty but other directory failures as errors", async () => {
        root = await mkdtemp(path.join(tmpdir(), "asset-opportunity-explorer-io-"));
        // Real filesystem, no archive folder: an explicit empty state.
        const emptyOutcome = await scanAssetOpportunityArchive({
            root: path.join(root, "does-not-exist"),
            retainRunId: null,
        });
        expect(emptyOutcome.fileCount).to.equal(0);
        expect(emptyOutcome.runs).to.deep.equal([]);
        // A directory read that fails for another reason is an actionable
        // error naming the directory, never "empty".
        const ioFailure: ArchiveScanIo = {
            stat: async () => ({ size: 0, mtimeMs: 0 }),
            readFile: async () => "",
            listDir: async () => {
                const error = new Error("permission denied") as NodeJS.ErrnoException;
                error.code = "EACCES";
                throw error;
            },
        };
        try {
            await scanAssetOpportunityArchive({ root, retainRunId: null, io: ioFailure });
            expect.fail("EACCES must fail the scan");
        } catch (error) {
            expect(error).to.be.instanceOf(ExplorerAnalysisError);
            expect((error as ExplorerAnalysisError).status).to.equal(500);
            expect((error as ExplorerAnalysisError).message).to.contain("archive/asset opportunity");
        }
    });

    it("never lets an older scan completion overwrite a newer run selection", async () => {
        root = await createFixtureRoot();
        setServerRootForTests(root);
        routes = captureRoutes();
        const gates = new Map<string, Array<() => void>>();
        const fakeOutcome = (retainRunId: string | null): AssetOpportunityArchiveScanOutcome => ({
            archiveRootRelative: "archive/asset opportunity",
            scannedAt: new Date().toISOString(),
            fileCount: 1,
            runs: [{
                batchRunId: retainRunId ?? "run-a",
                latestTimestamp: "2026-09-25T01:00:00.000Z",
                holdoutBars: [12],
                sortMetrics: ["expectancy"],
                support: "fixed_horizon",
                horizons: [6],
                archiveMaximumRank: 2,
                sourceBlockCount: 1,
                hasBaselines: false,
            }],
            view: {
                batchRunId: retainRunId ?? "run-a",
                blocks: [],
                holdoutBars: [12],
                sortMetrics: ["expectancy"],
                horizons: [6],
                support: "fixed_horizon",
                archiveMaximumRank: 2,
            },
        });
        setScanRunnerForTests((args) => new Promise((resolve) => {
            const key = args.retainRunId ?? "*";
            const queue = gates.get(key) ?? [];
            queue.push(() => resolve(fakeOutcome(args.retainRunId)));
            gates.set(key, queue);
        }));
        // Start heatmap(run-a) — its scan hangs. Then heatmap(run-b) — hangs too.
        const pendingA = dispatch(routes, "/api/asset-opportunity-explorer/heatmap", `?batchRunId=run-a&horizonBars=6&topK=2&spacing=all`);
        await waitForQueuedScan(gates, "run-a");
        const pendingB = dispatch(routes, "/api/asset-opportunity-explorer/heatmap", `?batchRunId=run-b&horizonBars=6&topK=2&spacing=all`);
        await waitForQueuedScan(gates, "run-b");
        // B finishes first and must own the retained state.
        releaseScan(gates, "run-b");
        await pendingB;
        expect(getRetainedViewForTests()?.batchRunId).to.equal("run-b");
        expect(getSnapshotForTests()?.response.batchRunId).to.equal("run-b");
        // A finishes last: superseded, so it publishes nothing and answers 409.
        releaseScan(gates, "run-a");
        const responseA = await pendingA;
        expect(responseA.status).to.equal(409);
        expect(getRetainedViewForTests()?.batchRunId).to.equal("run-b");
        expect(getSnapshotForTests()?.response.batchRunId).to.equal("run-b");
    });

    it("a late refresh cannot reinstall state over a newer run selection", async () => {
        root = await createFixtureRoot();
        setServerRootForTests(root);
        routes = captureRoutes();
        const gates = new Map<string, Array<() => void>>();
        const fakeOutcome = (retainRunId: string | null): AssetOpportunityArchiveScanOutcome => ({
            archiveRootRelative: "archive/asset opportunity",
            scannedAt: new Date().toISOString(),
            fileCount: 1,
            runs: [{
                batchRunId: retainRunId ?? "run-a",
                latestTimestamp: "2026-09-25T01:00:00.000Z",
                holdoutBars: [12],
                sortMetrics: ["expectancy"],
                support: "fixed_horizon",
                horizons: [6],
                archiveMaximumRank: 2,
                sourceBlockCount: 1,
                hasBaselines: false,
            }],
            view: {
                batchRunId: retainRunId ?? "run-a",
                blocks: [],
                holdoutBars: [12],
                sortMetrics: ["expectancy"],
                horizons: [6],
                support: "fixed_horizon",
                archiveMaximumRank: 2,
            },
        });
        setScanRunnerForTests((args) => new Promise((resolve) => {
            const key = args.retainRunId ?? "*";
            const queue = gates.get(key) ?? [];
            queue.push(() => resolve(fakeOutcome(args.retainRunId)));
            gates.set(key, queue);
        }));
        // Refresh starts scanning, then a run selection starts and finishes first.
        const pendingRefresh = dispatch(routes, "/api/asset-opportunity-explorer/catalog", "?refresh=1");
        await waitForQueuedScan(gates, "*");
        const pendingHeatmap = dispatch(routes, "/api/asset-opportunity-explorer/heatmap", "?batchRunId=run-a&horizonBars=6&topK=2&spacing=all");
        await waitForQueuedScan(gates, "run-a");
        releaseScan(gates, "run-a");
        await pendingHeatmap;
        expect(getRetainedViewForTests()?.batchRunId).to.equal("run-a");
        expect(getSnapshotForTests()).to.not.equal(null);
        // The refresh completes last: it must not invalidate the newer run's
        // retained view or snapshot.
        releaseScan(gates, "*");
        const refreshResponse = await pendingRefresh;
        expect(refreshResponse.status).to.equal(200);
        expect(getRetainedViewForTests()?.batchRunId).to.equal("run-a");
        expect(getSnapshotForTests()).to.not.equal(null);
        expect(getCatalogForTests()?.runs[0]?.batchRunId).to.equal("run-a");
    });
});

function waitForQueuedScan(
    gates: Map<string, Array<() => void>>,
    key: string,
    label = `scan ${key} in flight`,
): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
        if ((gates.get(key)?.length ?? 0) > 0) return Promise.resolve();
        return new Promise((resolve) => setTimeout(resolve, 5)).then(() => waitForQueuedScan(gates, key, label));
    }
    return Promise.reject(new Error(`timed out waiting for ${label}`));
}

function releaseScan(gates: Map<string, Array<() => void>>, key: string): void {
    const queue = gates.get(key);
    const release = queue?.shift();
    if (!release) throw new Error(`no queued scan for ${key}`);
    release();
}
