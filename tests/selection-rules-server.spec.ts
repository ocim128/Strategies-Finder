import { expect } from "chai";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { __testInternals } from "../lib/selection-rules/server-vite-plugin";
import { createSelectionRulesDetailStore, SELECTION_RULES_DETAIL_HISTORY_CAP } from "../lib/selection-rules/detail-store";
import { resolveSelectionRulesFolder } from "../lib/selection-rules/catalog";
import type { PairSelectionRuleDetail } from "../lib/pair-selection/tally";
import {
    assertSelectionRuleResultIsScalar,
    assertSelectionRulesWireEventIsScalar,
    type SelectionRulesStreamEvent,
} from "../lib/selection-rules/stream-types";

const {
    registerSelectionRulesRoutesForTests,
    setServerRootForTests,
    setJobRunnerForTests,
    setArchiveLoaderForTests,
    resetForTests,
    handleStopRequest,
    getPendingStopRunIdForTests,
    getRunOwnerForTests,
    getDetailEntryForTests,
} = __testInternals;

type RouteHandler = (req: any, res: any) => Promise<void>;

function captureRoutes(): Map<string, RouteHandler> {
    const routes = new Map<string, RouteHandler>();
    registerSelectionRulesRoutesForTests({
        use: (route: string, handler: RouteHandler) => routes.set(route, handler),
    });
    return routes;
}

function makeRequest(method: string, url: string, body?: unknown, remoteAddress = "127.0.0.1"): any {
    const text = body === undefined ? "" : JSON.stringify(body);
    const request = Readable.from(text ? [text] : []) as any;
    request.method = method;
    request.url = url;
    request.headers = {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(text)),
        host: "127.0.0.1:5173",
    };
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

/** The run route installs its owner across several async hops; wait for it. */
async function waitForRunInstall(): Promise<void> {
    // Wall-clock deadline, not a tick count: under load the async route
    // handler can take more than any fixed number of event-loop turns to
    // reach ownership, which made the mid-run read 404 spuriously.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && getRunOwnerForTests() === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

function makeLedgerRow(args: {
    signalTime: number;
    pair: string;
    baseSymbol: string;
    quoteSymbol: string;
    direction: "long" | "short";
    atr: number;
    entryPrice: number;
    exitPrice: number;
}): Record<string, unknown> {
    const pnlPercent = args.direction === "long"
        ? args.exitPrice / args.entryPrice - 1
        : 1 - args.exitPrice / args.entryPrice;
    return {
        ledgerVersion: 3,
        pair: args.pair,
        baseSymbol: args.baseSymbol,
        quoteSymbol: args.quoteSymbol,
        direction: args.direction,
        signalTime: args.signalTime,
        signalBarIndex: args.signalTime,
        fillTime: args.signalTime + 1,
        fillPrice: args.entryPrice,
        executed: true,
        notExecutedReason: null,
        feat_entryRangePosition: args.direction === "long" ? 0.8 : 0.2,
        feat_atrPct: args.atr,
        feat_return20: args.direction === "long" ? 0.02 : -0.02,
        feat_gapPct: 0.01,
        feat_dow: 1,
        feat_hour: 12,
        feat_pairWinRatePrior: null,
        feat_pairTradesPrior: 0,
        feat_barsSincePairLastFire: null,
        feat_pairSpreadVolatility20: 0.03,
        feat_legVolatilityRatio20: 1,
        feat_candidatesAtTime: 2,
        asIf: null,
        asIfReason: null,
        horizons: {
            "24": {
                entryTimeSec: args.signalTime + 1,
                entryPrice: args.entryPrice,
                exitTimeSec: args.signalTime + 25,
                exitPrice: args.exitPrice,
                pnlPercent,
                status: "ok",
            },
        },
    };
}

async function createFixtureRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "selection-rules-"));
    const archiveRoot = path.join(root, "archive", "mining-ledger");
    const folder = path.join(archiveRoot, "fixture-folder");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "provenance.json"), JSON.stringify({
        ledgerVersion: 3,
        featureVersion: 3,
        runId: "fixture-run",
        startedAt: "2026-09-06T00:00:00.000Z",
        interval: "4h",
        strategyKey: "fixture_strategy",
        strategyParams: {},
        backtestSettings: {},
        capitalSettings: {},
        engineMode: "typescript",
        executionModel: "next_open",
        tradeDirection: "both",
        riskMode: "percentage",
        fees: { commissionPercent: 0, slippageBps: 0 },
        ledgerHorizons: [24],
        pairCount: 2,
        symbols: ["AAA", "BBB", "CCC", "DDD"],
        replay: {
            replayEligible: true,
            replayBlockers: [],
            maxOpenTrades: 1,
            cooldownBars: 0,
            executionModel: "next_open",
            tradeDirection: "both",
            allowSameBarExit: false,
            disableSignalExits: true,
            slippageRate: 0,
            commissionRate: 0,
        },
    }));
    await writeFile(path.join(folder, "summary.json"), JSON.stringify({
        ledgerVersion: 3,
        featureVersion: 3,
        runId: "fixture-run",
        startedAt: "2026-09-06T00:00:00.000Z",
        finishedAt: "2026-09-06T00:01:00.000Z",
        ledgerComplete: true,
        failedWrites: 0,
        totals: { pairs: 2, signals: 4, executed: 4, notExecuted: 0 },
    }));
    const rows = [
        makeLedgerRow({ signalTime: 1_700_000_000, pair: "AAA/BBB", baseSymbol: "AAA", quoteSymbol: "BBB", direction: "long", atr: 1, entryPrice: 100, exitPrice: 110 }),
        makeLedgerRow({ signalTime: 1_700_000_000, pair: "CCC/DDD", baseSymbol: "CCC", quoteSymbol: "DDD", direction: "short", atr: 2, entryPrice: 100, exitPrice: 80 }),
        makeLedgerRow({ signalTime: 1_700_001_000, pair: "AAA/BBB", baseSymbol: "AAA", quoteSymbol: "BBB", direction: "long", atr: 1, entryPrice: 100, exitPrice: 110 }),
        makeLedgerRow({ signalTime: 1_700_001_000, pair: "CCC/DDD", baseSymbol: "CCC", quoteSymbol: "DDD", direction: "short", atr: 2, entryPrice: 100, exitPrice: 80 }),
    ];
    await writeFile(path.join(folder, "ledger.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    return root;
}

afterEach(() => {
    resetForTests();
    setServerRootForTests(null);
    setArchiveLoaderForTests(null);
});

describe("selection-rules server plugin", () => {
    it("registers every route behind the local authorization boundary", async () => {
        const routes = captureRoutes();
        const requests: Array<[string, string, unknown?]> = [
            ["GET", "/api/selection-rules/catalog"],
            ["POST", "/api/selection-rules/run", { runId: "x", folderPath: "fixture-folder", ruleKeys: ["reference_alphabetical"], horizonBars: 24 }],
            ["POST", "/api/selection-rules/stop", { runId: "x" }],
            ["GET", "/api/selection-rules/status?runId=x"],
            ["GET", "/api/selection-rules/details?runId=x&ruleKey=reference_alphabetical&horizonBars=24"],
        ];
        for (const [method, url, body] of requests) {
            const response = makeResponse();
            await routes.get(url.split("?")[0])!(makeRequest(method, url, body, "10.0.0.5"), response);
            expect(response.statusCode).to.equal(401);
        }
    });

    it("streams scalar pair-rule rows in registry order and retains the terminal summary", async () => {
        const root = await createFixtureRoot();
        setServerRootForTests(root);
        try {
            const routes = captureRoutes();
            const response = makeResponse();
            await routes.get("/api/selection-rules/run")!(makeRequest("POST", "/api/selection-rules/run", {
                runId: "stream-test",
                folderPath: "fixture-folder",
                ruleKeys: ["reference_alphabetical", "reference_loudest_atr"],
                horizonBars: 24,
            }), response);
            const events: SelectionRulesStreamEvent[] = response.body.trim().split("\n").map((line: string) => JSON.parse(line) as SelectionRulesStreamEvent);
            const done = events.at(-1);
            expect(done?.type).to.equal("done");
            expect(events.some((event) => event.type === "phase" && event.detail.includes("4 rows"))).to.equal(true);
            if (done?.type === "done") {
                expect(done.diagnosticsLines.some((line) => line.startsWith("env "))).to.equal(true);
                expect(done.diagnosticsLines.some((line) => line.startsWith("load "))).to.equal(true);
                expect(done.diagnosticsLines.some((line) => line.startsWith("preparation featurePreparationMs=")
                    && line.includes("sourceValidationMs=")
                    && line.includes("featureGenerationMs=")
                    && line.includes("featureGenerationWorkers=")
                    && line.includes("consumeMs="))).to.equal(true);
                expect(done.diagnosticsLines.filter((line) => line.startsWith("rule=")).every((line) => line.includes("activationMs="))).to.equal(true);
                expect(done.diagnosticsLines.some((line) => line.startsWith("rule=reference_alphabetical "))).to.equal(true);
            }
            const rows = events.filter((event): event is Extract<SelectionRulesStreamEvent, { type: "rule_result" }> => event.type === "rule_result");
            expect(rows.map((event) => event.result.ruleKey)).to.deep.equal(["reference_alphabetical", "reference_loudest_atr"]);
            expect(rows[0]?.result.n).to.equal(2);
            expect(rows[0]?.result.referenceLoudestAtrDeltaMeanPp).to.be.closeTo(-10, 1e-12);
            expect(rows[0]?.result.dominantBaseLeg).to.equal("AAA");
            for (const event of events) assertSelectionRulesWireEventIsScalar(event);
            for (const event of rows) assertSelectionRuleResultIsScalar(event.result);
            const statusResponse = makeResponse();
            await routes.get("/api/selection-rules/status")!(makeRequest("GET", "/api/selection-rules/status?runId=stream-test"), statusResponse);
            const status = JSON.parse(statusResponse.body);
            expect(status.lastRun.phase).to.equal("done");
            expect(status.lastRun.results).to.have.length(2);
            expect(status.lastRun.diagnosticsLines).to.deep.equal(done?.type === "done" ? done.diagnosticsLines : []);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("rejects a horizon absent from folder provenance", async () => {
        const root = await createFixtureRoot();
        setServerRootForTests(root);
        try {
            const routes = captureRoutes();
            const response = makeResponse();
            await routes.get("/api/selection-rules/run")!(makeRequest("POST", "/api/selection-rules/run", {
                runId: "bad-horizon",
                folderPath: "fixture-folder",
                ruleKeys: ["reference_alphabetical"],
                horizonBars: 48,
            }), response);
            expect(response.statusCode).to.equal(400);
            expect(response.body).to.contain("not present in folder provenance");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("keeps Stop run-scoped and honors the pending-stop slot", async () => {
        const root = await createFixtureRoot();
        setServerRootForTests(root);
        try {
            const routes = captureRoutes();
            let started!: () => void;
            const startedPromise = new Promise<void>((resolve) => { started = resolve; });
            setJobRunnerForTests(async (args) => {
                started();
                await new Promise<void>((resolve) => args.signal.addEventListener("abort", () => resolve(), { once: true }));
            });
            const runResponse = makeResponse();
            const runPromise = routes.get("/api/selection-rules/run")!(makeRequest("POST", "/api/selection-rules/run", {
                runId: "stop-current",
                folderPath: "fixture-folder",
                ruleKeys: ["reference_alphabetical"],
                horizonBars: 24,
            }), runResponse);
            await startedPromise;
            const staleResponse = makeResponse();
            await routes.get("/api/selection-rules/stop")!(makeRequest("POST", "/api/selection-rules/stop", { runId: "stop-stale" }), staleResponse);
            expect(JSON.parse(staleResponse.body)).to.deep.equal({ ok: false, stopped: false });
            const stopResponse = makeResponse();
            await routes.get("/api/selection-rules/stop")!(makeRequest("POST", "/api/selection-rules/stop", { runId: "stop-current" }), stopResponse);
            expect(JSON.parse(stopResponse.body)).to.deep.equal({ ok: true, stopped: true });
            await runPromise;
            const events = runResponse.body.trim().split("\n").map((line: string) => JSON.parse(line) as SelectionRulesStreamEvent);
            expect(events.at(-1)?.type).to.equal("cancelled");

            expect(await handleStopRequest("pending-stop")).to.deep.equal({ ok: true, stopped: false });
            expect(getPendingStopRunIdForTests()).to.equal("pending-stop");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("retains fatal status and filters v3 catalog entries safely", async () => {
        const root = await createFixtureRoot();
        const archiveRoot = path.join(root, "archive", "mining-ledger");
        await mkdir(path.join(archiveRoot, "missing-meta"));
        await mkdir(path.join(archiveRoot, "unsupported"));
        await writeFile(path.join(archiveRoot, "unsupported", "provenance.json"), JSON.stringify({ ledgerVersion: 2, featureVersion: 3 }));
        await writeFile(path.join(archiveRoot, "unsupported", "summary.json"), JSON.stringify({ ledgerComplete: true, finishedAt: "2026-09-06T00:00:00.000Z", totals: { signals: 1, pairs: 1 } }));
        await mkdir(path.join(root, "outside"));
        await writeFile(path.join(root, "outside", "provenance.json"), "{}");
        setServerRootForTests(root);
        setArchiveLoaderForTests(() => { throw new Error("corrupt pair-selection ledger fixture"); });
        try {
            expect(await resolveSelectionRulesFolder(root, "../outside")).to.equal(null);
            const routes = captureRoutes();
            const catalogResponse = makeResponse();
            await routes.get("/api/selection-rules/catalog")!(makeRequest("GET", "/api/selection-rules/catalog"), catalogResponse);
            const catalog = JSON.parse(catalogResponse.body);
            expect(catalog.folders.map((folder: { folderId: string }) => folder.folderId)).to.deep.equal(["fixture-folder"]);
            expect(catalog.skippedFolders).to.deep.include.members([
                { folderId: "missing-meta", reason: "missing_or_malformed_metadata" },
                { folderId: "unsupported", reason: "unsupported_version" },
            ]);

            const runResponse = makeResponse();
            await routes.get("/api/selection-rules/run")!(makeRequest("POST", "/api/selection-rules/run", {
                runId: "fatal-test",
                folderPath: "fixture-folder",
                ruleKeys: ["reference_alphabetical"],
                horizonBars: 24,
            }), runResponse);
            expect(runResponse.body).to.contain('"type":"fatal"');
            const statusResponse = makeResponse();
            await routes.get("/api/selection-rules/status")!(makeRequest("GET", "/api/selection-rules/status?runId=fatal-test"), statusResponse);
            const status = JSON.parse(statusResponse.body);
            expect(status.lastRun.phase).to.equal("fatal");
            expect(status.lastRun.error).to.equal("corrupt pair-selection ledger fixture");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("serves paged detail history after a completed run", async () => {
        const root = await createFixtureRoot();
        setServerRootForTests(root);
        try {
            const routes = captureRoutes();
            const runResponse = makeResponse();
            await routes.get("/api/selection-rules/run")!(makeRequest("POST", "/api/selection-rules/run", {
                runId: "details-run",
                folderPath: "fixture-folder",
                ruleKeys: ["reference_alphabetical"],
                horizonBars: 24,
            }), runResponse);
            expect(runResponse.body).to.contain('"type":"done"');

            const response = makeResponse();
            await routes.get("/api/selection-rules/details")!(
                makeRequest("GET", "/api/selection-rules/details?runId=details-run&ruleKey=reference_alphabetical&horizonBars=24"),
                response,
            );
            expect(response.statusCode).to.equal(200);
            const payload = JSON.parse(response.body);
            expect(payload.ok).to.equal(true);
            expect(payload.runId).to.equal("details-run");
            expect(payload.totalRows).to.equal(2);
            expect(payload.hasMore).to.equal(false);
            expect(payload.historyTruncated).to.equal(false);
            // Newest-first: the second fixture event leads the page.
            expect(payload.rows.map((row: { signalTime: number }) => row.signalTime)).to.deep.equal([1_700_001_000, 1_700_000_000]);
            for (const row of payload.rows) {
                expect(row.status).to.equal("COMPLETE");
                expect(row.candidateCount).to.equal(2);
            }
            expect(payload.latest.signalTime).to.equal(1_700_001_000);
            expect(payload.pairPerformance).to.have.lengthOf(1);
            expect(payload.pairPerformance[0]).to.include({ pair: "AAA/BBB", direction: "long", selectedCount: 2, completedCount: 2, wins: 2 });

            const page = makeResponse();
            await routes.get("/api/selection-rules/details")!(
                makeRequest("GET", "/api/selection-rules/details?runId=details-run&ruleKey=reference_alphabetical&horizonBars=24&offset=1&limit=1"),
                page,
            );
            const paged = JSON.parse(page.body);
            expect(paged.rows).to.have.lengthOf(1);
            expect(paged.rows[0].signalTime).to.equal(1_700_000_000);
            expect(paged.hasMore).to.equal(false);
            const firstPage = makeResponse();
            await routes.get("/api/selection-rules/details")!(
                makeRequest("GET", "/api/selection-rules/details?runId=details-run&ruleKey=reference_alphabetical&horizonBars=24&limit=1"),
                firstPage,
            );
            expect(JSON.parse(firstPage.body).hasMore).to.equal(true);

            // Status snapshots and streamed events stay detail-free.
            const statusResponse = makeResponse();
            await routes.get("/api/selection-rules/status")!(makeRequest("GET", "/api/selection-rules/status?runId=details-run"), statusResponse);
            expect(statusResponse.body).to.not.contain("pairPerformance");
            expect(statusResponse.body).to.not.contain("selectedReturn");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("validates details query values and rejects run or entry mismatches", async () => {
        const root = await createFixtureRoot();
        setServerRootForTests(root);
        try {
            const routes = captureRoutes();
            const runResponse = makeResponse();
            await routes.get("/api/selection-rules/run")!(makeRequest("POST", "/api/selection-rules/run", {
                runId: "validated-run",
                folderPath: "fixture-folder",
                ruleKeys: ["reference_alphabetical"],
                horizonBars: 24,
            }), runResponse);
            const url = "/api/selection-rules/details";
            const invalid: Array<[string, string]> = [
                ["missing runId", `${url}?ruleKey=reference_alphabetical&horizonBars=24`],
                ["bad runId", `${url}?runId=bad%21id&ruleKey=reference_alphabetical&horizonBars=24`],
                ["missing ruleKey", `${url}?runId=validated-run&horizonBars=24`],
                ["unknown ruleKey", `${url}?runId=validated-run&ruleKey=not_a_rule&horizonBars=24`],
                ["missing horizonBars", `${url}?runId=validated-run&ruleKey=reference_alphabetical`],
                ["zero horizonBars", `${url}?runId=validated-run&ruleKey=reference_alphabetical&horizonBars=0`],
                ["fractional horizonBars", `${url}?runId=validated-run&ruleKey=reference_alphabetical&horizonBars=2.5`],
                ["negative offset", `${url}?runId=validated-run&ruleKey=reference_alphabetical&horizonBars=24&offset=-1`],
                ["zero limit", `${url}?runId=validated-run&ruleKey=reference_alphabetical&horizonBars=24&limit=0`],
                ["oversized limit", `${url}?runId=validated-run&ruleKey=reference_alphabetical&horizonBars=24&limit=501`],
            ];
            for (const [label, query] of invalid) {
                const response = makeResponse();
                await routes.get(url)!(makeRequest("GET", query), response);
                expect(response.statusCode, label).to.equal(400);
            }
            // Unknown run: loud 404, not empty data.
            const runMismatch = makeResponse();
            await routes.get(url)!(makeRequest("GET", `${url}?runId=another-run&ruleKey=reference_alphabetical&horizonBars=24`), runMismatch);
            expect(runMismatch.statusCode).to.equal(404);
            // Valid run, but a rule/horizon combination that never tallied.
            const missingEntry = makeResponse();
            await routes.get(url)!(makeRequest("GET", `${url}?runId=validated-run&ruleKey=reference_alphabetical&horizonBars=48`), missingEntry);
            expect(missingEntry.statusCode).to.equal(404);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("keeps details readable mid-run and after cancellation or fatal termination", async () => {
        const root = await createFixtureRoot();
        setServerRootForTests(root);
        try {
            const routes = captureRoutes();
            const detail: PairSelectionRuleDetail = {
                latest: null,
                history: [{
                    signalTime: 1_700_000_000, pair: "AAA/BBB", baseSymbol: "AAA", quoteSymbol: "BBB",
                    direction: "long", score: 0, tiedCount: 1, candidateCount: 2, status: "COMPLETE",
                    selectedReturn: 0.1, othersMean: 0.2, delta: -0.1,
                }],
                pairPerformance: [],
                probe: { eventsScanned: 0, scoredCandidates: 0 },
            };
            let release!: () => void;
            const blocked = new Promise<void>((resolve) => { release = resolve; });
            setJobRunnerForTests(async (args) => {
                args.onDetail?.(detail, "reference_alphabetical", 24);
                await blocked;
            });
            const runPromise = routes.get("/api/selection-rules/run")!(makeRequest("POST", "/api/selection-rules/run", {
                runId: "midrun-details",
                folderPath: "fixture-folder",
                ruleKeys: ["reference_alphabetical"],
                horizonBars: 24,
            }), makeResponse());
            // Give the route a tick to install the run, then read mid-run.
            await waitForRunInstall();
            const midRun = makeResponse();
            await routes.get("/api/selection-rules/details")!(
                makeRequest("GET", "/api/selection-rules/details?runId=midrun-details&ruleKey=reference_alphabetical&horizonBars=24"),
                midRun,
            );
            expect(midRun.statusCode).to.equal(200);
            expect(JSON.parse(midRun.body).rows).to.have.lengthOf(1);

            await handleStopRequest("midrun-details");
            release();
            await runPromise;
            const afterCancel = makeResponse();
            await routes.get("/api/selection-rules/details")!(
                makeRequest("GET", "/api/selection-rules/details?runId=midrun-details&ruleKey=reference_alphabetical&horizonBars=24"),
                afterCancel,
            );
            expect(afterCancel.statusCode).to.equal(200);
            expect(JSON.parse(afterCancel.body).rows).to.have.lengthOf(1);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("clears details when a new run is installed and drops stale-generation writes", async () => {
        const root = await createFixtureRoot();
        setServerRootForTests(root);
        try {
            const routes = captureRoutes();
            const detail: PairSelectionRuleDetail = {
                latest: null,
                history: [{
                    signalTime: 1, pair: "OLD/PAIR", baseSymbol: "OLD", quoteSymbol: "PAIR",
                    direction: "long", score: 0, tiedCount: 1, candidateCount: 2, status: "COMPLETE",
                    selectedReturn: 0, othersMean: 0, delta: 0,
                }],
                pairPerformance: [],
                probe: { eventsScanned: 0, scoredCandidates: 0 },
            };
            // First run stores a detail then releases the run slot.
            setJobRunnerForTests(async (args) => {
                args.onDetail?.(detail, "reference_alphabetical", 24);
            });
            const firstRun = makeResponse();
            await routes.get("/api/selection-rules/run")!(makeRequest("POST", "/api/selection-rules/run", {
                runId: "first-run",
                folderPath: "fixture-folder",
                ruleKeys: ["reference_alphabetical"],
                horizonBars: 24,
            }), firstRun);
            expect(getDetailEntryForTests("reference_alphabetical", 24)).to.not.equal(null);

            // Second run installs its own store generation.
            let releaseSecond!: () => void;
            const secondBlocked = new Promise<void>((resolve) => { releaseSecond = resolve; });
            setJobRunnerForTests(async () => { await secondBlocked; });
            const secondRun = makeResponse();
            const secondPromise = routes.get("/api/selection-rules/run")!(makeRequest("POST", "/api/selection-rules/run", {
                runId: "second-run",
                folderPath: "fixture-folder",
                ruleKeys: ["reference_alphabetical"],
                horizonBars: 24,
            }), secondRun);
            await waitForRunInstall();
            const cleared = makeResponse();
            await routes.get("/api/selection-rules/details")!(
                makeRequest("GET", "/api/selection-rules/details?runId=second-run&ruleKey=reference_alphabetical&horizonBars=24"),
                cleared,
            );
            expect(cleared.statusCode).to.equal(404);

            await handleStopRequest("second-run");
            releaseSecond();
            await secondPromise;
            expect(getDetailEntryForTests("reference_alphabetical", 24)).to.equal(null);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("ignores a delayed detail write from a job whose generation already ended", async () => {
        const root = await createFixtureRoot();
        setServerRootForTests(root);
        try {
            const routes = captureRoutes();
            const detail: PairSelectionRuleDetail = {
                latest: null,
                history: [{
                    signalTime: 1, pair: "STALE/PAIR", baseSymbol: "STALE", quoteSymbol: "PAIR",
                    direction: "long", score: 0, tiedCount: 1, candidateCount: 2, status: "COMPLETE",
                    selectedReturn: 0, othersMean: 0, delta: 0,
                }],
                pairPerformance: [],
                probe: { eventsScanned: 0, scoredCandidates: 0 },
            };
            let staleWrite: (() => void) | null = null;
            setJobRunnerForTests(async (args) => {
                staleWrite = () => args.onDetail?.(detail, "reference_alphabetical", 24);
            });
            const firstRun = makeResponse();
            await routes.get("/api/selection-rules/run")!(makeRequest("POST", "/api/selection-rules/run", {
                runId: "stale-source",
                folderPath: "fixture-folder",
                ruleKeys: ["reference_alphabetical"],
                horizonBars: 24,
            }), firstRun);
            expect(typeof staleWrite).to.equal("function");

            let releaseSecond!: () => void;
            const secondBlocked = new Promise<void>((resolve) => { releaseSecond = resolve; });
            setJobRunnerForTests(async () => { await secondBlocked; });
            const secondRun = makeResponse();
            const secondPromise = routes.get("/api/selection-rules/run")!(makeRequest("POST", "/api/selection-rules/run", {
                runId: "stale-target",
                folderPath: "fixture-folder",
                ruleKeys: ["reference_alphabetical"],
                horizonBars: 24,
            }), secondRun);
            await waitForRunInstall();

            (staleWrite as (() => void) | null)?.();
            expect(getDetailEntryForTests("reference_alphabetical", 24)).to.equal(null);

            await handleStopRequest("stale-target");
            releaseSecond();
            await secondPromise;
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe("selection-rules detail store", () => {
    it("caps retained history at 2000 newest rows while keeping totalRows and aggregates complete", () => {
        const store = createSelectionRulesDetailStore();
        const history = Array.from({ length: SELECTION_RULES_DETAIL_HISTORY_CAP + 500 }, (_, index) => ({
            signalTime: index,
            pair: `P${index}/Q${index}`,
            baseSymbol: `P${index}`,
            quoteSymbol: `Q${index}`,
            direction: "long" as const,
            score: index,
            tiedCount: 1,
            candidateCount: 2,
            status: "COMPLETE" as const,
            selectedReturn: 0.01,
            othersMean: 0.02,
            delta: -0.01,
        }));
        const performance = [{ pair: "P/Q", direction: "long" as const, selectedCount: history.length, completedCount: history.length, wins: 1, winRate: 1, meanSelectedReturn: 0.01, medianSelectedReturn: 0.01, meanDelta: -0.01 }];
        store.store("rule_a", 24, {
            latest: history[history.length - 1]!,
            history,
            pairPerformance: performance,
            probe: { eventsScanned: 0, scoredCandidates: 0 },
        });
        const entry = store.get("rule_a", 24)!;
        expect(entry.rows).to.have.lengthOf(SELECTION_RULES_DETAIL_HISTORY_CAP);
        expect(entry.totalRows).to.equal(history.length);
        expect(entry.historyTruncated).to.equal(true);
        // Newest-first: the highest signalTime leads the retained page.
        expect(entry.rows[0]!.signalTime).to.equal(history.length - 1);
        expect(entry.rows.at(-1)!.signalTime).to.equal(history.length - SELECTION_RULES_DETAIL_HISTORY_CAP);
        expect(entry.pairPerformance).to.deep.equal(performance);
        store.clear();
        expect(store.get("rule_a", 24)).to.equal(null);
    });
});
