import { expect } from "chai";
import { afterEach, describe, it } from "node:test";
import { HttpStatusError } from "../lib/vite-http-utils";
import { __testInternals } from "../lib/rank-pairs/server/rank-pairs-vite-plugin";
import type { RankResult } from "../lib/rank-pairs/rank-pairs-service";
import type { RankPairsRunStatusSnapshot } from "../lib/rank-pairs/server/rank-pairs-server-types";
import { classifyPairRegime } from "../lib/rank-pairs/pair-regime-classifier";

const {
    consumePendingStop,
    handleStatusRequest,
    handleStopRequest,
    parseRunId,
    registerRankPairsRoutesForTests,
    resetForTests,
    setAbortControllerForTests,
    setRunOwnerForTests,
    setRunStateForTests,
    shouldSweepOrphanEntry,
} = __testInternals;

type RouteHandler = (req: any, res: any) => Promise<void>;

function captureRoutes(): Map<string, RouteHandler> {
    const routes = new Map<string, RouteHandler>();
    registerRankPairsRoutesForTests({
        use: (path: string, handler: RouteHandler) => routes.set(path, handler),
    });
    return routes;
}

function makeRouteResponse(): {
    statusCode: number;
    body: string;
    setHeader: () => void;
    end: (body: string) => void;
} {
    const response = {
        statusCode: 0,
        body: "",
        setHeader: () => {},
        end: (body: string) => { response.body = body; },
    };
    return response;
}

function makeResult(symbol: string): RankResult {
    const regime = classifyPairRegime([]);
    regime.symbol = symbol;
    return { kind: "history", symbol, regime, status: "no_data" };
}

function makeState(
    overrides: Partial<RankPairsRunStatusSnapshot> = {},
): RankPairsRunStatusSnapshot & { diagnosticsText: string } {
    return {
        ok: true,
        running: true,
        terminal: false,
        runId: "rank-run-1",
        startedAt: 100,
        finishedAt: null,
        phase: "running",
        interval: "4h",
        mode: "history",
        evalLastBars: 200,
        oosIgnoreLastBars: 0,
        total: 124_000,
        completed: 321,
        currentSymbol: "BTC+ETH",
        progressPercent: 0.25,
        statusText: "Server: 321/124000 (BTC+ETH)",
        cancelled: false,
        resultCount: 0,
        terminalPreview: null,
        summary: null,
        diagnostics: null,
        copyAvailable: false,
        reciprocalDuplicates: 0,
        selfPairs: 0,
        error: null,
        diagnosticsText: "",
        ...overrides,
    };
}

afterEach(() => {
    resetForTests();
});

describe("rank-pairs server status and scoped Stop", () => {
    it("keeps running status bounded and omits partial result rows", () => {
        setRunStateForTests(makeState());
        setRunOwnerForTests(1, "rank-run-1");

        const status = handleStatusRequest("rank-run-1");

        expect(status?.running).to.equal(true);
        expect(status?.terminal).to.equal(false);
        expect(status?.completed).to.equal(321);
        expect(status?.terminalPreview).to.equal(null);
    });

    it("returns the retained partial preview after a cancelled run finalizes", () => {
        const preview = [makeResult("BTC+ETH"), makeResult("SOL+ETH")];
        setRunStateForTests(makeState({
            running: false,
            terminal: true,
            finishedAt: 200,
            phase: "cancelled",
            cancelled: true,
            completed: 2,
            resultCount: 2,
            terminalPreview: preview,
            summary: "Pairs 2",
            copyAvailable: true,
            statusText: "Stopped (2/124000 pairs)",
        }));
        setRunOwnerForTests(0, null);

        const status = handleStatusRequest("rank-run-1");

        expect(status?.terminal).to.equal(true);
        expect(status?.phase).to.equal("cancelled");
        expect(status?.terminalPreview).to.deep.equal(preview);
        expect(status?.copyAvailable).to.equal(true);
    });

    it("aborts only the matching active run id", async () => {
        const controller = new AbortController();
        setRunStateForTests(makeState());
        setRunOwnerForTests(7, "rank-run-1");
        setAbortControllerForTests(controller);

        const mismatch = await handleStopRequest("rank-run-other");
        expect(mismatch).to.deep.equal({ ok: false, stopped: false });
        expect(controller.signal.aborted).to.equal(false);

        const matching = await handleStopRequest("rank-run-1");
        expect(matching).to.deep.equal({ ok: true, stopped: true });
        expect(controller.signal.aborted).to.equal(true);
        expect(handleStatusRequest("rank-run-1")?.cancelled).to.equal(true);
    });

    it("records a Stop that arrives before ownership and consumes it once", async () => {
        const stopped = await handleStopRequest("rank-run-pending");
        expect(stopped).to.deep.equal({ ok: true, stopped: false });
        expect(consumePendingStop("rank-run-other")).to.equal(false);
        expect(consumePendingStop("rank-run-pending")).to.equal(true);
        expect(consumePendingStop("rank-run-pending")).to.equal(false);
    });

    it("rejects an unscoped Stop", async () => {
        let caught: unknown;
        try {
            await handleStopRequest(undefined);
        } catch (error) {
            caught = error;
        }
        expect(caught).to.be.instanceof(HttpStatusError);
        expect((caught as HttpStatusError).status).to.equal(400);
        expect(() => parseRunId("")).to.throw(HttpStatusError);
    });
});

describe("rank-pairs server route authorization", () => {
    const routesToCheck = [
        { path: "/api/rank-pairs/run", method: "POST" },
        { path: "/api/rank-pairs/stop", method: "POST" },
        { path: "/api/rank-pairs/status", method: "GET" },
        { path: "/api/rank-pairs/copy", method: "GET" },
    ];

    for (const route of routesToCheck) {
        it(`rejects remote ${route.method} ${route.path}`, async () => {
            const handler = captureRoutes().get(route.path);
            expect(handler).to.not.equal(undefined);
            const previousToken = process.env.LOCAL_PROXY_TOKEN;
            delete process.env.LOCAL_PROXY_TOKEN;
            try {
                const response = makeRouteResponse();
                await handler!(
                    {
                        method: route.method,
                        url: route.path,
                        headers: { host: "example.com:5173" },
                        socket: { remoteAddress: "203.0.113.10" },
                    },
                    response,
                );
                expect(response.statusCode).to.equal(401);
                expect(JSON.parse(response.body).error).to.include("local-only");
            } finally {
                if (previousToken !== undefined) {
                    process.env.LOCAL_PROXY_TOKEN = previousToken;
                }
            }
        });
    }

    it("allows loopback status through authorization", async () => {
        const handler = captureRoutes().get("/api/rank-pairs/status");
        const response = makeRouteResponse();
        await handler!(
            {
                method: "GET",
                url: "/api/rank-pairs/status",
                headers: {
                    host: "127.0.0.1:5173",
                    "sec-fetch-site": "same-origin",
                },
                socket: { remoteAddress: "127.0.0.1" },
            },
            response,
        );
        expect(response.statusCode).to.equal(404);
    });
});

describe("rank-pairs server copy artifact ownership", () => {
    it("never sweeps a directory owned by the current process", () => {
        expect(shouldSweepOrphanEntry(
            `strategies-finder-rank-pairs-${process.pid}-${Date.now()}-abc`,
        )).to.equal(false);
    });

    it("does not sweep legacy unscoped artifact directory names", () => {
        expect(shouldSweepOrphanEntry(
            "strategies-finder-rank-pairs-legacy",
        )).to.equal(false);
    });

    it("sweeps a stamped directory only when its owner is provably dead", () => {
        expect(shouldSweepOrphanEntry(
            `strategies-finder-rank-pairs-2147483647-${Date.now()}-abc`,
        )).to.equal(true);
    });
});
