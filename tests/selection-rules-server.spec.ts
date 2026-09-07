import { expect } from "chai";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { __testInternals } from "../lib/selection-rules/server-vite-plugin";
import { resolveSelectionRulesFolder } from "../lib/selection-rules/catalog";
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
                ruleKeys: ["hedge_volatility_balance", "reference_alphabetical", "directional_close_location"],
                horizonBars: 24,
            }), response);
            const events: SelectionRulesStreamEvent[] = response.body.trim().split("\n").map((line: string) => JSON.parse(line) as SelectionRulesStreamEvent);
            const done = events.at(-1);
            expect(done?.type).to.equal("done");
            if (done?.type === "done") {
                expect(done.diagnosticsLines.some((line) => line.startsWith("env "))).to.equal(true);
                expect(done.diagnosticsLines.some((line) => line.startsWith("load "))).to.equal(true);
                expect(done.diagnosticsLines.some((line) => line.startsWith("rule=reference_alphabetical "))).to.equal(true);
            }
            const rows = events.filter((event): event is Extract<SelectionRulesStreamEvent, { type: "rule_result" }> => event.type === "rule_result");
            expect(rows.map((event) => event.result.ruleKey)).to.deep.equal(["reference_alphabetical", "directional_close_location", "hedge_volatility_balance"]);
            expect(rows[0]?.result.n).to.equal(2);
            expect(rows[0]?.result.referenceLoudestAtrDeltaMeanPp).to.be.closeTo(-10, 1e-12);
            expect(rows[0]?.result.dominantBaseLeg).to.equal("AAA");
            for (const event of events) assertSelectionRulesWireEventIsScalar(event);
            for (const event of rows) assertSelectionRuleResultIsScalar(event.result);
            const statusResponse = makeResponse();
            await routes.get("/api/selection-rules/status")!(makeRequest("GET", "/api/selection-rules/status?runId=stream-test"), statusResponse);
            const status = JSON.parse(statusResponse.body);
            expect(status.lastRun.phase).to.equal("done");
            expect(status.lastRun.results).to.have.length(3);
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
});
