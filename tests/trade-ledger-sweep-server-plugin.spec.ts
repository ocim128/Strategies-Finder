import { expect } from "chai";
import { afterEach, describe, it } from "node:test";
import { Readable } from "node:stream";
import {
    __testInternals,
    TRADE_LEDGER_SWEEP_MAX_BODY_BYTES,
} from "../lib/batch-backtest/trade-ledger-sweep-vite-plugin";
import {
    createEmptyLedgerSweepDiagnostics,
    type LedgerSweepMode,
} from "../lib/batch-backtest/trade-ledger-sweep-diagnostics";
import { assertLedgerSweepWireEventIsScalar } from "../lib/batch-backtest/trade-ledger-sweep-stream-types";
import { getActiveWorkloads, resetForTests as resetCoordinator } from "../lib/server-research-job-coordinator";

const {
    registerTradeLedgerSweepRoutesForTests,
    handleStopRequest,
    setJobRunnerForTests,
    setServerRootForTests,
    resetForTests,
    getRunStateForTests,
    getPendingStopRunIdForTests,
    acceptJobEventForTests,
    projectRunningStatusForTests,
} = __testInternals;

type RouteHandler = (req: any, res: any) => Promise<void>;

function captureRoutes(): Map<string, RouteHandler> {
    const routes = new Map<string, RouteHandler>();
    setServerRootForTests(process.cwd());
    registerTradeLedgerSweepRoutesForTests({
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
        headers: new Map<string, string>(),
        body: "",
        setHeader(name: string, value: string) { this.headers.set(name, value); },
        write(value: string) { this.body += value; return true; },
        end(value = "") { this.body += value; this.ended = true; },
        on() { return this; },
    };
    return response;
}

function diagnostics(runId: string, mode: LedgerSweepMode, preflight: any): any {
    return createEmptyLedgerSweepDiagnostics({ runId, mode, preflight });
}

afterEach(() => {
    resetForTests();
    resetCoordinator();
    setServerRootForTests(null);
});

describe("trade-ledger sweep server plugin", () => {
    it("registers all routes through the local JSON route boundary", () => {
        const routes = captureRoutes();
        expect([...routes.keys()]).to.deep.equal([
            "/api/trade-ledger-sweep/catalog",
            "/api/trade-ledger-sweep/run",
            "/api/trade-ledger-sweep/stop",
            "/api/trade-ledger-sweep/status",
        ]);
    });

    it("rejects unauthenticated non-loopback catalog access", async () => {
        const route = captureRoutes().get("/api/trade-ledger-sweep/catalog")!;
        const response = makeResponse();
        await route(makeRequest("GET", "/api/trade-ledger-sweep/catalog", undefined, "10.0.0.5"), response);
        expect(response.statusCode).to.equal(401);
    });

    it("catalogs folders and rules without exposing ledger rows or report text", async () => {
        const route = captureRoutes().get("/api/trade-ledger-sweep/catalog")!;
        const response = makeResponse();
        await route(makeRequest("GET", "/api/trade-ledger-sweep/catalog"), response);
        const payload = JSON.parse(response.body) as any;
        expect(payload.ok).to.equal(true);
        expect(payload.folders.some((folder: any) => folder.folderId === "2026-08-29_1851_batch-smoke-v2")).to.equal(true);
        expect(payload.rules.some((rule: any) => rule.ruleId === "smoke-trivial-rule")).to.equal(true);
        expect(JSON.stringify(payload)).to.not.contain("pnlPercent");
        expect(JSON.stringify(payload)).to.not.contain("reportLines");
    });

    it("rejects unknown run keys, traversal folder ids, and oversized bodies before ownership", async () => {
        const route = captureRoutes().get("/api/trade-ledger-sweep/run")!;
        const unknownResponse = makeResponse();
        await route(makeRequest("POST", "/api/trade-ledger-sweep/run", {
            runId: "ledger-sweep-test",
            folderId: "2026-08-29_1851_batch-smoke-v2",
            extra: true,
        }), unknownResponse);
        expect(unknownResponse.statusCode).to.equal(400);
        expect(getRunStateForTests()).to.equal(null);

        const traversalResponse = makeResponse();
        await route(makeRequest("POST", "/api/trade-ledger-sweep/run", {
            runId: "ledger-sweep-test",
            folderId: "../rules",
        }), traversalResponse);
        expect(traversalResponse.statusCode).to.equal(400);
        expect(getRunStateForTests()).to.equal(null);
        expect(TRADE_LEDGER_SWEEP_MAX_BODY_BYTES).to.equal(8 * 1024);
    });

    it("keeps scalar terminal state for reattachment and rejects a stale Stop", async () => {
        const routes = captureRoutes();
        const runId = "ledger-sweep-server-test";
        setJobRunnerForTests(async (args) => {
            const d = diagnostics(args.runId, args.mode, args.preflight);
            args.emit({
                type: "start",
                runId: args.runId,
                folderId: args.folder.folderId,
                folderName: args.folder.name,
                mode: args.mode,
                modeReason: args.modeReason,
                totalRules: args.rules.length,
                ledgerRows: args.folder.rows!,
                ledgerBytes: args.folder.ledgerBytes,
                rankBytes: args.folder.rankBytes,
                outputDir: args.outputDir,
                startedAt: Date.now(),
            });
            const result = {
                ruleId: args.rules[0]!.ruleId,
                ruleName: args.rules[0]!.ruleName,
                sourceHash: args.rules[0]!.sourceHash,
                verdict: "NO-EDGE" as const,
                weak: false,
                note: null,
                candidates: 1,
                kept: 0,
                keptPct: 0,
                isMeanPnlDeltaPp: -1,
                isMedianPnlDeltaPp: -1,
                holdoutMeanPnlDeltaPp: -1,
                holdoutMedianPnlDeltaPp: -1,
                ruleReplayMs: 1,
                controlReplayMs: 2,
                totalMs: 3,
                reportPath: `${args.outputDir}/reports/${args.rules[0]!.ruleId}.txt`,
                error: null,
            };
            args.emit({ type: "rule_result", runId: args.runId, result });
            args.emit({
                type: "done",
                runId: args.runId,
                ok: true,
                cancelled: false,
                finishedAt: Date.now(),
                summary: "summary",
                results: [result],
                diagnostics: d,
                outputDir: args.outputDir,
            });
        });
        const runResponse = makeResponse();
        await routes.get("/api/trade-ledger-sweep/run")!(makeRequest("POST", "/api/trade-ledger-sweep/run", {
            runId,
            folderId: "2026-08-29_1851_batch-smoke-v2",
        }), runResponse);
        const events = runResponse.body.trim().split("\n").map((line: string) => JSON.parse(line));
        expect(events.at(-1).type).to.equal("done");
        for (const event of events) assertLedgerSweepWireEventIsScalar(event);

        const statusResponse = makeResponse();
        await routes.get("/api/trade-ledger-sweep/status")!(makeRequest("GET", `/api/trade-ledger-sweep/status?runId=${runId}`), statusResponse);
        const status = JSON.parse(statusResponse.body);
        expect(status.lastRun.results).to.have.length(1);
        expect(status.run).to.equal(null);

        const staleStop = await handleStopRequest("ledger-sweep-other");
        expect(staleStop).to.deep.equal({ ok: true, stopped: false });
        expect(getPendingStopRunIdForTests()).to.equal("ledger-sweep-other");
    });

    it("enforces the wire heavy-field refusal while allowing the start count", () => {
        expect(() => assertLedgerSweepWireEventIsScalar({ type: "start", runId: "x", ledgerRows: 10 })).to.not.throw();
        expect(() => assertLedgerSweepWireEventIsScalar({ type: "rule_result", runId: "x", result: { trades: [] } })).to.throw();
        expect(() => assertLedgerSweepWireEventIsScalar({ type: "phase", runId: "x", memory: { heapUsed: Number.NaN } })).to.throw();
    });

    it("projects running diagnostics to a bounded status payload without mutating the retained aggregate", () => {
        const base = diagnostics("ledger-sweep-status-bounded", "load_once", {
            decision: "load_once",
            reason: "fits",
            estimatedHeapBytes: 1,
            estimatedRssBytes: 1,
            childHeapLimitBytes: 1,
        });
        base.memory.samples = Array.from({ length: 10_000 }, (_, index) => ({
            at: index,
            source: "worker" as const,
            phase: "rule_replay" as const,
            ruleId: null,
            heapUsed: index,
            heapTotal: index,
            rss: index,
            external: 0,
            arrayBuffers: 0,
            maxRss: index,
        }));
        base.cpu = Array.from({ length: 100 }, () => ({
            scope: "worker",
            userCpuMs: 1,
            systemCpuMs: 1,
            eventLoopUtilization: 0,
            eventLoopDelayP50Ms: 0,
            eventLoopDelayP99Ms: 0,
        }));
        base.errors = Array.from({ length: 100 }, (_, index) => `error-${index}`);
        const run = {
            runId: "ledger-sweep-status-bounded",
            folderId: "folder",
            folderName: "folder",
            mode: "load_once" as const,
            modeReason: "fits",
            phase: "rule_replay" as const,
            startedAt: 1,
            finishedAt: null,
            totalRules: 1,
            completedRules: 0,
            currentRuleId: "rule",
            elapsedMs: 1,
            percent: 1,
            results: [],
            diagnostics: base,
            summary: null,
            outputDir: "archive/sweeps/run",
            error: null,
        };
        const projected = projectRunningStatusForTests(run);
        expect(projected.diagnostics.memory.samples).to.have.length(1);
        expect(projected.diagnostics.cpu).to.have.length(1);
        expect(projected.diagnostics.errors).to.have.length(20);
        expect(projected.diagnostics.errorCount).to.equal(100);
        expect(run.diagnostics.memory.samples).to.have.length(10_000);
        expect(JSON.stringify(projected).length).to.be.lessThan(JSON.stringify(run).length / 10);
    });

    it("releases the coordinator only after an aborting Stop lets the job settle", async () => {
        const routes = captureRoutes();
        const runId = "ledger-sweep-stop-release";
        let started!: () => void;
        const startedPromise = new Promise<void>((resolve) => { started = resolve; });
        setJobRunnerForTests(async (args) => {
            args.emit({
                type: "start",
                runId: args.runId,
                folderId: args.folder.folderId,
                folderName: args.folder.name,
                mode: args.mode,
                modeReason: args.modeReason,
                totalRules: args.rules.length,
                ledgerRows: args.folder.rows!,
                ledgerBytes: args.folder.ledgerBytes,
                rankBytes: args.folder.rankBytes,
                outputDir: args.outputDir,
                startedAt: Date.now(),
            });
            started();
            await new Promise<void>((resolve) => args.signal.addEventListener("abort", () => resolve(), { once: true }));
        });
        const runResponse = makeResponse();
        const runPromise = routes.get("/api/trade-ledger-sweep/run")!(makeRequest("POST", "/api/trade-ledger-sweep/run", { runId, folderId: "2026-08-29_1851_batch-smoke-v2" }), runResponse);
        await startedPromise;
        const stopResponse = makeResponse();
        await routes.get("/api/trade-ledger-sweep/stop")!(makeRequest("POST", "/api/trade-ledger-sweep/stop", { runId }), stopResponse);
        expect(JSON.parse(stopResponse.body)).to.deep.equal({ ok: true, stopped: true });
        await runPromise;
        expect(getActiveWorkloads()).to.deep.equal([]);
    });

    it("ignores a stale generation event while a newer run owns the coordinator", async () => {
        const routes = captureRoutes();
        const firstRunId = "ledger-sweep-generation-one";
        setJobRunnerForTests(async (args) => {
            args.emit({ type: "start", runId: args.runId, folderId: args.folder.folderId, folderName: args.folder.name, mode: args.mode, modeReason: args.modeReason, totalRules: args.rules.length, ledgerRows: args.folder.rows!, ledgerBytes: args.folder.ledgerBytes, rankBytes: args.folder.rankBytes, outputDir: args.outputDir, startedAt: Date.now() });
            args.emit({ type: "done", runId: args.runId, ok: true, cancelled: false, finishedAt: Date.now(), summary: "done", results: [], diagnostics: diagnostics(args.runId, args.mode, args.preflight), outputDir: args.outputDir });
        });
        await routes.get("/api/trade-ledger-sweep/run")!(makeRequest("POST", "/api/trade-ledger-sweep/run", { runId: firstRunId, folderId: "2026-08-29_1851_batch-smoke-v2" }), makeResponse());

        const secondRunId = "ledger-sweep-generation-two";
        let secondStarted!: () => void;
        const secondStartedPromise = new Promise<void>((resolve) => { secondStarted = resolve; });
        setJobRunnerForTests(async (args) => {
            args.emit({ type: "start", runId: args.runId, folderId: args.folder.folderId, folderName: args.folder.name, mode: args.mode, modeReason: args.modeReason, totalRules: args.rules.length, ledgerRows: args.folder.rows!, ledgerBytes: args.folder.ledgerBytes, rankBytes: args.folder.rankBytes, outputDir: args.outputDir, startedAt: Date.now() });
            secondStarted();
            await new Promise<void>((resolve) => args.signal.addEventListener("abort", () => resolve(), { once: true }));
        });
        const secondPromise = routes.get("/api/trade-ledger-sweep/run")!(makeRequest("POST", "/api/trade-ledger-sweep/run", { runId: secondRunId, folderId: "2026-08-29_1851_batch-smoke-v2" }), makeResponse());
        await secondStartedPromise;
        const before = JSON.stringify(getRunStateForTests());
        expect(await handleStopRequest(firstRunId)).to.deep.equal({ ok: false, stopped: false });
        acceptJobEventForTests(1, { type: "progress", runId: firstRunId, phase: "rule_replay", percent: 99, detail: "stale", completedRules: 99, totalRules: 99, currentRuleId: "stale", elapsedMs: 99, controlCompleted: null, controlRuns: null, rulesPerHour: 99 });
        expect(JSON.stringify(getRunStateForTests())).to.equal(before);
        await handleStopRequest(secondRunId);
        await secondPromise;
    });
});
