import { expect } from "chai";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
    __testInternals,
} from "../lib/selection-rules/server-vite-plugin";
import { resolveSelectionRulesFolder } from "../lib/selection-rules/catalog";
import {
    assertSelectionRuleResultIsScalar,
    assertSelectionRulesWireEventIsScalar,
    type SelectionRulesStreamEvent,
} from "../lib/selection-rules/stream-types";
import type { SelectionArchive } from "../lib/selection-rules/tally";

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
    const response: any = {
        statusCode: 0,
        body: "",
        setHeader() { return undefined; },
        write(value: string) { this.body += value; return true; },
        end(value = "") { this.body += value; this.ended = true; },
        on() { return this; },
    };
    return response;
}

function outcomeKey(eventId: string, horizon: number, asset: string): string {
    return JSON.stringify([eventId, horizon, "long", asset]);
}

function shortOutcomeKey(eventId: string, horizon: number, asset: string): string {
    return JSON.stringify([eventId, horizon, "short", asset]);
}

function baselineKey(eventId: string, horizon: number, selector: string): string {
    return JSON.stringify([eventId, horizon, selector, "long"]);
}

function makeArchive(): SelectionArchive {
    const eventId = "event-1";
    const horizon = 24;
    const candidates = [
        { asset: "AAA", pair: null, score: 0.8, signedVotes: 8, activePairCount: 10, ema200Above: true, breadth: 0.5, regime: "bullish" as const, longEligible: true, shortEligible: true, inPool: true },
        { asset: "BBB", pair: null, score: 0.4, signedVotes: 4, activePairCount: 20, ema200Above: true, breadth: 0.5, regime: "bullish" as const, longEligible: true, shortEligible: true, inPool: true },
    ];
    return {
        runId: "fixture",
        interval: "4h",
        horizons: [horizon],
        events: [{ eventId, decisionTimeSec: 1_700_000_000, interval: "4h", candidates }],
        outcomes: new Map([
            [outcomeKey(eventId, horizon, "AAA"), { eventId, decisionTimeSec: 1_700_000_000, horizonBars: horizon, direction: "long", asset: "AAA", inPool: true, eligible: true, return: 0.10, entryTimeSec: 1, exitTimeSec: 2, status: "ok" }],
            [outcomeKey(eventId, horizon, "BBB"), { eventId, decisionTimeSec: 1_700_000_000, horizonBars: horizon, direction: "long", asset: "BBB", inPool: true, eligible: true, return: 0.04, entryTimeSec: 1, exitTimeSec: 2, status: "ok" }],
            [shortOutcomeKey(eventId, horizon, "AAA"), { eventId, decisionTimeSec: 1_700_000_000, horizonBars: horizon, direction: "short", asset: "AAA", inPool: true, eligible: true, return: -0.10, entryTimeSec: 1, exitTimeSec: 2, status: "ok" }],
            [shortOutcomeKey(eventId, horizon, "BBB"), { eventId, decisionTimeSec: 1_700_000_000, horizonBars: horizon, direction: "short", asset: "BBB", inPool: true, eligible: true, return: -0.04, entryTimeSec: 1, exitTimeSec: 2, status: "ok" }],
        ]),
        baselines: new Map([
            [baselineKey(eventId, horizon, "TOP_RAW"), { eventId, decisionTimeSec: 1_700_000_000, horizonBars: horizon, selector: "TOP_RAW", direction: "long", asset: "AAA", selectedReturn: 0.10, controlReturn: 0.04 }],
            [baselineKey(eventId, horizon, "TOP_MEAN"), { eventId, decisionTimeSec: 1_700_000_000, horizonBars: horizon, selector: "TOP_MEAN", direction: "long", asset: "AAA", selectedReturn: 0.10, controlReturn: 0.04 }],
        ]),
    };
}

async function createFixtureRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "selection-rules-"));
    const archiveRoot = path.join(root, "archive", "batch-open-score");
    await mkdir(path.join(archiveRoot, "fixture"), { recursive: true });
    await writeFile(path.join(archiveRoot, "fixture", "meta.json"), JSON.stringify({
        schema: "top_mean_archive.v3",
        runId: "fixture",
        completedAt: "2026-09-06T00:00:00.000Z",
        interval: "4h",
        horizons: [24],
        fingerprint: "fixture-fingerprint",
    }));
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
            ["POST", "/api/selection-rules/run", { runId: "x", folderPath: "fixture", ruleKeys: ["top_mean"] }],
            ["POST", "/api/selection-rules/stop", { runId: "x" }],
            ["GET", "/api/selection-rules/status?runId=x"],
        ];
        for (const [method, url, body] of requests) {
            const response = makeResponse();
            await routes.get(url.split("?")[0])!(makeRequest(method, url, body, "10.0.0.5"), response);
            expect(response.statusCode).to.equal(401);
        }
    });

    it("streams scalar rule rows in registry order and retains the terminal summary", async () => {
        const root = await createFixtureRoot();
        setServerRootForTests(root);
        setArchiveLoaderForTests(() => makeArchive());
        try {
            const routes = captureRoutes();
            const response = makeResponse();
            await routes.get("/api/selection-rules/run")!(makeRequest("POST", "/api/selection-rules/run", {
                runId: "stream-test",
                folderPath: "fixture",
                ruleKeys: ["top_active", "top_mean", "top_raw"],
            }), response);
            const events: SelectionRulesStreamEvent[] = response.body.trim().split("\n").map((line: string) => JSON.parse(line) as SelectionRulesStreamEvent);
            expect(events.at(-1)?.type).to.equal("done");
            const rows = events.filter((event): event is Extract<SelectionRulesStreamEvent, { type: "rule_result" }> => event.type === "rule_result");
            expect(rows.map((event) => event.result.ruleKey)).to.deep.equal(["top_mean", "top_raw", "top_active"]);
            for (const event of events) assertSelectionRulesWireEventIsScalar(event);
            for (const event of rows) assertSelectionRuleResultIsScalar(event.result);
            const statusResponse = makeResponse();
            await routes.get("/api/selection-rules/status")!(makeRequest("GET", "/api/selection-rules/status?runId=stream-test"), statusResponse);
            const status = JSON.parse(statusResponse.body);
            expect(status.lastRun.phase).to.equal("done");
            expect(status.lastRun.results).to.have.length(3);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("keeps Stop run-scoped and honors the pending-stop slot", async () => {
        const root = await createFixtureRoot();
        setServerRootForTests(root);
        setArchiveLoaderForTests(() => makeArchive());
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
                folderPath: "fixture",
                ruleKeys: ["top_mean"],
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

    it("retains fatal status and filters the catalog safely", async () => {
        const root = await createFixtureRoot();
        const archiveRoot = path.join(root, "archive", "batch-open-score");
        await mkdir(path.join(archiveRoot, "missing-meta"));
        await mkdir(path.join(archiveRoot, "unsupported"));
        await writeFile(path.join(archiveRoot, "unsupported", "meta.json"), JSON.stringify({ schema: "top_mean_archive.v2", runId: "unsupported" }));
        await mkdir(path.join(root, "outside"));
        await writeFile(path.join(root, "outside", "meta.json"), "{}");
        setServerRootForTests(root);
        setArchiveLoaderForTests(() => { throw new Error("corrupt archive fixture"); });
        try {
            expect(await resolveSelectionRulesFolder(root, "../outside")).to.equal(null);
            const routes = captureRoutes();
            const catalogResponse = makeResponse();
            await routes.get("/api/selection-rules/catalog")!(makeRequest("GET", "/api/selection-rules/catalog"), catalogResponse);
            const catalog = JSON.parse(catalogResponse.body);
            expect(catalog.folders.map((folder: { runId: string }) => folder.runId)).to.deep.equal(["fixture"]);

            const runResponse = makeResponse();
            await routes.get("/api/selection-rules/run")!(makeRequest("POST", "/api/selection-rules/run", {
                runId: "fatal-test",
                folderPath: "fixture",
                ruleKeys: ["top_mean"],
            }), runResponse);
            expect(runResponse.body).to.contain('"type":"fatal"');
            const statusResponse = makeResponse();
            await routes.get("/api/selection-rules/status")!(makeRequest("GET", "/api/selection-rules/status?runId=fatal-test"), statusResponse);
            const status = JSON.parse(statusResponse.body);
            expect(status.lastRun.phase).to.equal("fatal");
            expect(status.lastRun.error).to.equal("corrupt archive fixture");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
