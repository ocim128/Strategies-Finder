/**
 * Browser-side Finder lifecycle contract tests (audit Finding 8) plus the
 * regression tests for audit Findings 2 (reattach abort/ownership), 4
 * (persistence only at semantic checkpoints), and 6 (lazy Universe symbol
 * breakdowns).
 *
 * The server protocol has its own spec; this file covers the browser state
 * machine in FinderManager: stale reattach responses, terminal fatal
 * snapshots, Stop during a pending status fetch, persisted run-id
 * restoration, and stream-failure status recovery. DOM rendering and strategy
 * execution stay outside these tests (fake elements only).
 */
import { expect } from "chai";
import { describe, it, before, after, beforeEach } from "node:test";
import { finderManager } from "../lib/finder-manager";
import { FinderUI } from "../lib/finder/finder-ui";
import { clearDomElementCache } from "../lib/dom-utils";
import { buildFinderUniverseCandidate } from "../lib/finder/finder-universe-metrics";
import { ASSET_OPPORTUNITY_ALL_SORTS } from "../lib/finder/finder-asset-opportunity-metrics";
import { createFakeFinderElement } from "./helpers/fake-finder-manager-dom";
import type { FinderRunStatusSnapshot } from "../lib/finder/server/finder-stream-types";
import type { FinderUniverseCandidate, FinderUniverseSymbolResult } from "../lib/types/finder";
import type { Time } from "../lib/types/strategies";

// ---------------------------------------------------------------------------
// Fake browser environment
// ---------------------------------------------------------------------------

const elsById = new Map<string, any>();

function installFakeDocument(): void {
    (globalThis as any).document = {
        getElementById: (id: string) => {
            if (!elsById.has(id)) {
                elsById.set(id, createFakeFinderElement());
            }
            return elsById.get(id);
        },
        createElement: (tag: string) => {
            const el = createFakeFinderElement();
            el.tagName = tag;
            return el;
        },
        createDocumentFragment: () => createFakeFinderElement(),
        addEventListener: () => {},
        body: createFakeFinderElement(),
    };
}

function makeFakeLocalStorage() {
    const store = new Map<string, string>();
    const writes = new Map<string, number>();
    return {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => {
            store.set(key, value);
            writes.set(key, (writes.get(key) ?? 0) + 1);
        },
        removeItem: (key: string) => {
            store.delete(key);
        },
        _store: store,
        _writes: writes,
    };
}

// ---------------------------------------------------------------------------
// Mock fetch with deferred responses + AbortSignal support
// ---------------------------------------------------------------------------

type PendingRequest = {
    url: string;
    init?: {
        signal?: AbortSignal;
        method?: string;
        headers?: Record<string, string>;
        body?: string;
    };
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
};

class MockFetch {
    requests: PendingRequest[] = [];

    fetch = (url: string, init?: PendingRequest["init"]): Promise<unknown> =>
        new Promise((resolve, reject) => {
            const request: PendingRequest = { url: String(url), init, resolve, reject };
            this.requests.push(request);
            const signal = init?.signal;
            if (signal) {
                if (signal.aborted) {
                    reject(makeAbortError());
                    return;
                }
                signal.addEventListener("abort", () => reject(makeAbortError()));
            }
        });

    /** True if any in-flight request carries an aborted signal. */
    aborted(): boolean {
        return this.requests.some((request) => request.init?.signal?.aborted === true);
    }

    resolveFirst(payload: unknown, status = 200): void {
        const request = this.requests.shift();
        if (!request) throw new Error("No pending fetch request to resolve");
        const response = payload && typeof payload === "object" && "ok" in payload && "body" in payload
            ? payload
            : makeResponse(payload, status);
        request.resolve(response);
    }
}

function makeAbortError(): Error {
    const error = new Error("Aborted");
    (error as Error & { name: string }).name = "AbortError";
    return error;
}

function makeResponse(payload: unknown, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        body: null,
        text: async () => JSON.stringify(payload),
        json: async () => payload,
    };
}

function makeNdjsonResponse(events: readonly unknown[]) {
    const encoder = new TextEncoder();
    return {
        ...makeResponse(null),
        body: new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode(events.map((event) => JSON.stringify(event)).join("\n") + "\n"));
                controller.close();
            },
        }),
    };
}

let mockFetch: MockFetch;

function installMockFetch(): void {
    mockFetch = new MockFetch();
    (globalThis as any).fetch = mockFetch.fetch;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function persistActiveServerRun(runId: string, scope: "symbol_universe" | "asset_opportunity" = "symbol_universe"): void {
    (globalThis as any).localStorage.setItem(
        "playground_finder_active_server_run",
        JSON.stringify({
            schema: "finder.active_server_run",
            version: 1,
            data: { runId, scope, startedAt: Date.now() },
        }),
    );
}

function makeSymbolResult(symbol: string, netProfit: number): FinderUniverseSymbolResult {
    return {
        symbol,
        status: "profitable",
        barCount: 100,
        firstTime: 1_700_000_000 as Time,
        lastTime: (1_700_000_000 + 100 * 300) as Time,
        firstClose: 100,
        lastClose: 100 + netProfit,
        directionalLookbackClose: 100,
        directionalLookbackBars: 96,
        result: {
            netProfit,
            netProfitPercent: netProfit,
            expectancy: netProfit,
            avgTrade: netProfit,
            winRate: 1,
            profitFactor: 2,
            // Above the THIN (<15 trades) and STRONG (PF>=1.5, Sharpe>=1.0)
            // verdict thresholds so the summary line reports STRONG.
            totalTrades: 20,
            maxDrawdownPercent: 0,
            winningTrades: 10,
            losingTrades: 0,
            avgWin: netProfit,
            avgLoss: 0,
            sharpeRatio: 1.5,
            sharpeRatioAvailable: true,
            drawdownAvailable: false,
        },
    };
}

function makeCandidate(params: Record<string, number> = { threshold: 1 }): FinderUniverseCandidate {
    return buildFinderUniverseCandidate({
        strategyKey: "universe_test",
        strategyName: "Universe Test",
        params,
        symbols: [makeSymbolResult("AAA", 10), makeSymbolResult("BBB", 5)],
    });
}

function runningSnapshot(runId: string): FinderRunStatusSnapshot {
    return {
        ok: true,
        running: true,
        terminal: false,
        runId,
        startedAt: Date.now(),
        finishedAt: null,
        phase: "evaluating",
        interval: "5m",
        jobKind: "symbol_universe",
        strategyKeys: ["universe_test"],
        strategyIndex: 0,
        strategyCount: 1,
        totalSymbols: 2,
        progressPercent: 20,
        statusText: "Evaluating...",
        candidateCount: 0,
        loadedSymbols: 0,
        failedSymbols: 0,
        cancelled: false,
        terminalCandidates: null,
        terminalAssets: null,
        summary: null,
        error: null,
        diagnostics: null,
        totals: null,
        assetTotals: null,
    };
}

function terminalDoneSnapshot(runId: string, candidates: FinderUniverseCandidate[]): FinderRunStatusSnapshot {
    return {
        ...runningSnapshot(runId),
        running: false,
        terminal: true,
        finishedAt: Date.now(),
        phase: "done",
        progressPercent: 100,
        statusText: "Done",
        candidateCount: candidates.length,
        terminalCandidates: candidates,
        summary: `Done — ${candidates.length} survivors`,
    };
}

function terminalFatalSnapshot(runId: string, error: string): FinderRunStatusSnapshot {
    return {
        ...runningSnapshot(runId),
        running: false,
        terminal: true,
        finishedAt: Date.now(),
        phase: "fatal",
        progressPercent: 100,
        statusText: "Failed",
        error,
    };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let savedDocument: any;
let savedLocalStorage: any;
let savedFetch: any;
let savedHtmlInputElement: any;
let savedHtmlSelectElement: any;
let savedHtmlTextAreaElement: any;

before(() => {
    savedDocument = (globalThis as any).document;
    savedLocalStorage = (globalThis as any).localStorage;
    savedFetch = (globalThis as any).fetch;
    savedHtmlInputElement = (globalThis as any).HTMLInputElement;
    savedHtmlSelectElement = (globalThis as any).HTMLSelectElement;
    savedHtmlTextAreaElement = (globalThis as any).HTMLTextAreaElement;
    installFakeDocument();
    (globalThis as any).localStorage = makeFakeLocalStorage();
    (globalThis as any).HTMLInputElement = class {};
    (globalThis as any).HTMLSelectElement = class {};
    (globalThis as any).HTMLTextAreaElement = class {};
});

after(() => {
    if (savedDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = savedDocument;
    if (savedLocalStorage === undefined) delete (globalThis as any).localStorage;
    else (globalThis as any).localStorage = savedLocalStorage;
    if (savedFetch === undefined) delete (globalThis as any).fetch;
    else (globalThis as any).fetch = savedFetch;
    if (savedHtmlInputElement === undefined) delete (globalThis as any).HTMLInputElement;
    else (globalThis as any).HTMLInputElement = savedHtmlInputElement;
    if (savedHtmlSelectElement === undefined) delete (globalThis as any).HTMLSelectElement;
    else (globalThis as any).HTMLSelectElement = savedHtmlSelectElement;
    if (savedHtmlTextAreaElement === undefined) delete (globalThis as any).HTMLTextAreaElement;
    else (globalThis as any).HTMLTextAreaElement = savedHtmlTextAreaElement;
    clearDomElementCache();
});

function manager(): any {
    return finderManager as any;
}

beforeEach(() => {
    const m = manager();
    m.activeServerRunId = null;
    m.isRunning = false;
    m.isCancelled = false;
    m.reattachPollingStopped = false;
    m.reattachTimer = null;
    m.reattachTimerResolve = null;
    m.reattachAbortController = null;
    m.latestResults = { scope: "current_chart", results: [] };
    m.originalLatestResults = null;
    m.assetOpportunityRunResults = [];
    m.assetOpportunityDefaultResults = [];
    m.uiState.scope = "current_chart";
    (m.ui as any).statusElement = null;
    (m.ui as any).lastStatusText = "";
    elsById.clear();
    (globalThis as any).localStorage._store.clear();
    (globalThis as any).localStorage._writes.clear();
    clearDomElementCache();
    installMockFetch();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FinderManager reattach lifecycle (audit Finding 2)", () => {
    it("does not adopt a delayed initial probe when a new run started during the await", async () => {
        persistActiveServerRun("old-run");
        const reattach = manager().reattachToActiveServerRun();
        // The probe is in flight (no response yet). A new run starts while we
        // wait — exactly what the old code raced on: the probe resolving AFTER
        // runFinder() set activeServerRunId would overwrite the new run's
        // ownership token.
        manager().activeServerRunId = "new-run";
        manager().isRunning = true;

        mockFetch.resolveFirst(runningSnapshot("old-run"));
        await reattach;

        expect(manager().activeServerRunId, "new run ownership preserved").to.equal("new-run");
        expect(manager().isRunning).to.equal(true);
        // The reattach path never adopted the old run's scope either.
        expect(manager().uiState.scope).to.equal("current_chart");
    });

    it("aborts an in-flight status fetch when Stop cancels the reattach poll", async () => {
        persistActiveServerRun("hung-run");
        const reattach = manager().reattachToActiveServerRun();
        // Probe hangs; the user presses Stop while it is pending.
        expect(mockFetch.requests.length).to.be.greaterThan(0);
        manager().stopReattachPoll();
        expect(mockFetch.aborted(), "the pending status fetch was aborted").to.equal(true);
        await reattach;
        expect(manager().reattachAbortController).to.equal(null);
    });

    it("ignores a stale recovery response after activeServerRunId changed mid-await", async () => {
        manager().activeServerRunId = "run-a";
        manager().isRunning = true;
        const recovery = manager().recoverActiveServerRun("run-a", "symbol_universe");
        expect(mockFetch.requests.length).to.be.greaterThan(0);

        // The stream-error handler is still awaiting; a new run takes over.
        manager().activeServerRunId = "run-b";
        mockFetch.resolveFirst(terminalDoneSnapshot("run-a", [makeCandidate()]));

        const recovered = await recovery;
        expect(recovered, "stale terminal snapshot must not be adopted").to.equal(null);
        expect(manager().activeServerRunId).to.equal("run-b");
    });

    it("does not treat an HTTP-200 server stop rejection as success", async () => {
        const runId = "server-rejected-stop";
        persistActiveServerRun(runId);
        manager().isRunning = true;

        const stop = manager().stopActiveServerRun(runId);
        mockFetch.resolveFirst(makeResponse({ ok: false, stopped: false }));
        await stop;

        const stored = JSON.parse((globalThis as any).localStorage.getItem("playground_finder_active_server_run"));
        expect(stored.data.runId).to.equal(runId);
        expect(elsById.get("finderStatus")?.textContent).to.include("rejected by the server");
    });
});

describe("FinderManager reattach terminal adoption (audit Finding 8)", () => {
    it("surfaces a terminal fatal snapshot and clears ownership + the persisted record", async () => {
        persistActiveServerRun("fatal-run");
        const reattach = manager().reattachToActiveServerRun();
        mockFetch.resolveFirst(terminalFatalSnapshot("fatal-run", "worker exploded"));
        await reattach;

        const status = elsById.get("finderStatus");
        expect(status?.textContent).to.include("worker exploded");
        expect(manager().activeServerRunId).to.equal(null);
        // clearActiveServerRun writes a data:null envelope rather than
        // removing the key; loadPersistedActiveServerRun treats it as absent.
        const stored = JSON.parse((globalThis as any).localStorage.getItem("playground_finder_active_server_run"));
        expect(stored.data).to.equal(null);
        expect(manager().loadPersistedActiveServerRun()).to.equal(null);
    });

    it("restores a terminal done snapshot from the persisted run id after a reload", async () => {
        persistActiveServerRun("done-run");
        const reattach = manager().reattachToActiveServerRun();
        mockFetch.resolveFirst(terminalDoneSnapshot("done-run", [makeCandidate()]));
        await reattach;

        const results = manager().latestResults;
        expect(results.scope).to.equal("symbol_universe");
        expect(results.results).to.have.length(1);
        expect(results.results[0]!.strategyKey).to.equal("universe_test");
        expect(manager().activeServerRunId).to.equal(null);
        const stored = JSON.parse((globalThis as any).localStorage.getItem("playground_finder_active_server_run"));
        expect(stored.data).to.equal(null);
    });
});

describe("FinderManager Asset Opportunity batch stream contracts", () => {
    it("does not turn a recovered batch fatal into a successful outcome", async () => {
        const runId = "batch-fatal-recovery";
        manager().activeServerRunId = runId;
        manager().isRunning = true;
        const options: any = {
            mode: "random",
            scope: "asset_opportunity",
            topN: 1,
            assetOpportunity: { symbols: ["AAA"] },
        };
        const request = manager().runAssetOpportunityBatchFinderServer(
            options,
            [],
            undefined,
            runId,
            performance.now(),
            { start: 1, end: 1 },
        );

        mockFetch.resolveFirst(makeNdjsonResponse([{
            type: "asset_batch_fatal",
            runId,
            error: "Archive write failed",
            holdoutBars: 1,
            completedIterations: 0,
        }]));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        mockFetch.resolveFirst(makeResponse({
            ...runningSnapshot(runId),
            running: false,
            terminal: true,
            finishedAt: Date.now(),
            phase: "fatal",
            jobKind: "asset_opportunity_batch",
            terminalAssets: [],
            assetTotals: null,
            assetDiagnostics: null,
            error: "Archive write failed",
        }));

        let caught: unknown = null;
        try {
            await request;
        } catch (error) {
            caught = error;
        }
        expect(caught).to.be.instanceOf(Error);
        expect((caught as Error).message).to.include("Archive write failed");
    });

    it("retains the latest batch diagnostics and asset counts from terminal events", async () => {
        const runId = "batch-diagnostics";
        manager().activeServerRunId = runId;
        manager().isRunning = true;
        const assetDiagnostics: any = {
            totalAssets: 2,
            assetsWithFreshEntry: 1,
            assetsWithNoFreshEntry: 0,
            selectGradeAssets: 1,
            watchGradeAssets: 0,
            rejectGradeAssets: 0,
            failedAssets: [{ symbol: "BBB", reason: "No candles" }],
        };
        const totals: any = {
            totalAssets: 2,
            assetsWithFreshEntry: 1,
            failedAssets: 1,
            selectGradeAssets: 1,
            watchGradeAssets: 0,
            rejectGradeAssets: 0,
        };
        const options: any = {
            mode: "random",
            scope: "asset_opportunity",
            topN: 1,
            assetOpportunity: { symbols: ["AAA", "BBB"] },
        };
        const request = manager().runAssetOpportunityBatchFinderServer(
            options,
            [],
            undefined,
            runId,
            performance.now(),
            { start: 1, end: 1 },
            "freshSignalLibraries",
        );

        const submittedBody = JSON.parse(String(mockFetch.requests[0]?.init?.body));
        expect(submittedBody.archiveSort).to.equal(ASSET_OPPORTUNITY_ALL_SORTS);

        mockFetch.resolveFirst(makeNdjsonResponse([
            {
                type: "asset_batch_iteration_done",
                runId,
                holdoutBars: 1,
                iterationIndex: 0,
                totalIterations: 1,
                assets: [],
                totals,
                diagnostics: null,
                assetDiagnostics,
                archiveFilename: "oos-holdout-1-bars.txt",
            },
            {
                type: "asset_batch_done",
                ok: true,
                cancelled: false,
                runId,
                completedIterations: 1,
                failedIterations: 0,
                assets: [],
                holdoutBars: 1,
                totals,
                diagnostics: null,
                assetDiagnostics,
                summary: "done",
            },
        ]));

        const outcome = await request;
        expect(outcome.assetDiagnostics).to.deep.equal(assetDiagnostics);
        expect(outcome.assetsWithFreshEntry).to.equal(1);
        expect(outcome.failedAssets).to.equal(1);
    });
});

describe("FinderManager result persistence (audit Finding 4)", () => {
    it("skips the persisted snapshot for provisional updates and writes once at terminal adoption", () => {
        const result: any = {
            key: "immutability_test",
            name: "Immutability Test",
            params: { threshold: 1 },
            result: { netProfit: 10, totalTrades: 2 },
            selectionResult: { netProfit: 10, totalTrades: 2 },
        };
        const key = "playground_finder_latest_results";
        const writes = () => (globalThis as any).localStorage._writes.get(key) ?? 0;

        // Provisional mid-run render (persist = false): no storage write.
        for (let i = 0; i < 3; i += 1) {
            manager().setLatestResults({ scope: "current_chart", results: [result] }, false);
        }
        expect(writes(), "no snapshot writes during provisional updates").to.equal(0);

        // Terminal adoption (default persist = true): exactly one commit.
        manager().setLatestResults({ scope: "current_chart", results: [result] });
        expect(writes()).to.equal(1);
        const stored = JSON.parse((globalThis as any).localStorage.getItem(key));
        expect(stored.schema).to.equal("finder.latest_results");
        // saveLatestResultsSnapshot stores { savedAt, symbol, interval, results }
        // where `results` is itself a FinderLatestResults { scope, results }.
        expect(stored.data.results.results).to.have.length(1);
    });
});

describe("FinderUI lazy Universe symbol breakdowns (audit Finding 6)", () => {
    function findByTag(root: any, tag: string): any | null {
        if (!root) return null;
        if (root.tagName === tag) return root;
        for (const child of root.children ?? []) {
            const found = findByTag(child, tag);
            if (found) return found;
        }
        return null;
    }

    function symbolRowCount(details: any): number {
        return (details.children ?? []).filter(
            (child: any) => typeof child?.className === "string" && child.className.includes("finder-symbol-row"),
        ).length;
    }

    it("creates no hidden symbol rows until the breakdown <details> is opened", () => {
        const ui = new FinderUI();
        ui.renderUniverseResults([makeCandidate()]);

        const list = elsById.get("finderList");
        const details = findByTag(list, "details");
        expect(details, "a <details> breakdown exists").to.not.equal(null);
        expect(symbolRowCount(details), "no symbol rows while closed").to.equal(0);
        // The summary line still shows the lightweight verdict counts.
        const summaryLine = (details.children ?? []).find(
            (child: any) => child?.className === "finder-universe-summary",
        );
        expect(summaryLine?.textContent).to.include("2 STRONG");

        // Opening the details fires the one-time toggle handler.
        details.open = true;
        details.dispatchEvent({ type: "toggle" });
        expect(symbolRowCount(details)).to.equal(2);

        // A second toggle must not duplicate rows.
        details.dispatchEvent({ type: "toggle" });
        expect(symbolRowCount(details)).to.equal(2);
    });
});
