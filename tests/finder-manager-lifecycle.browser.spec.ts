/**
 * Browser-side Finder lifecycle contract tests (audit Finding 8) plus the
 * regression tests for audit Findings 2 (reattach abort/ownership), 4
 * (persistence only at semantic checkpoints), and 6 (lazy Universe symbol
 * breakdowns), and for the Copy Diagnostics availability transitions
 * (disabled at run start, enabled once a scope adopts diagnostics).
 *
 * Session behavior (ownership, Stop, recovery, stop rejection) is tested on
 * fresh `FinderServerSession` instances against a recording host — no
 * manager. The facade keeps a small set of integration tests that verify its
 * terminal-adoption and stream wiring with fresh collaborators injected.
 * DOM rendering stays outside these tests (fake elements only).
 */
import { expect } from "chai";
import { describe, it, before, after, beforeEach } from "node:test";
import { finderManager } from "../lib/finder-manager";
import { FinderUI } from "../lib/finder/finder-ui";
import { clearDomElementCache } from "../lib/dom-utils";
import { buildFinderUniverseCandidate } from "../lib/finder/finder-universe-metrics";
import { ASSET_OPPORTUNITY_ALL_SORTS } from "../lib/finder/finder-asset-opportunity-metrics";
import { createFakeFinderElement, createFakeFinderManagerDom } from "./helpers/fake-finder-manager-dom";
import { FinderServerSession, type FinderSessionHost } from "../lib/finder/browser/finder-server-session";
import { FinderResultStore } from "../lib/finder/browser/finder-result-store";
import { FinderControls } from "../lib/finder/browser/finder-controls";
import { FinderRunController, type FinderRunControllerDeps } from "../lib/finder/browser/finder-run-controller";
import { normalizeFinderUiState } from "../lib/finder/browser/finder-settings";
import { readFinderActiveServerRun } from "../lib/finder/browser/finder-persistence";
import { runUniverseFinder } from "../lib/finder/browser/workflows/symbol-universe";
import { runCurrentChartFinder } from "../lib/finder/browser/workflows/current-chart";
import { runStrategyQualityFinder } from "../lib/finder/browser/workflows/strategy-quality";
import { runAssetOpportunityFinder } from "../lib/finder/browser/workflows/asset-opportunity";
import type { FinderRunHost } from "../lib/finder/browser/workflows/finder-run-host";
import type { FinderRunStatusSnapshot } from "../lib/finder/server/finder-stream-types";
import type {
    FinderArmPerformanceCandidate,
    FinderArmPerformanceRunContext,
    FinderAssetOpportunityResult,
    FinderDiagnostics,
    FinderScope,
    FinderStrategyQualityResult,
    FinderUniverseCandidate,
    FinderUniverseSymbolResult,
} from "../lib/types/finder";
import type { OHLCVData, Strategy, Time } from "../lib/types/strategies";

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

function persistActiveServerRun(runId: string, scope: "symbol_universe" | "asset_opportunity" | "arm_performance" = "symbol_universe"): void {
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

function makeCandidate(
    params: Record<string, number> = { threshold: 1 },
    netProfit = 10,
): FinderUniverseCandidate {
    return buildFinderUniverseCandidate({
        strategyKey: "universe_test",
        strategyName: "Universe Test",
        params,
        symbols: [makeSymbolResult("AAA", netProfit), makeSymbolResult("BBB", netProfit / 2)],
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

function terminalArmPerformanceSnapshot(
    runId: string,
    results: FinderArmPerformanceCandidate[],
    runContext: FinderArmPerformanceRunContext,
): FinderRunStatusSnapshot {
    return {
        ...runningSnapshot(runId),
        running: false,
        terminal: true,
        finishedAt: Date.now(),
        phase: "done",
        jobKind: "arm_performance",
        progressPercent: 100,
        statusText: "Done",
        candidateCount: results.length,
        terminalArmPerformanceResults: results,
        armPerformanceRunContext: runContext,
        armPerformance: {
            plannedCandidates: runContext.plannedCandidateCount,
            completedCandidates: results.length,
            pairCount: runContext.pairs.length,
            currentCandidateOrdinal: null,
            currentStrategyKey: null,
            childPhase: null,
        },
        summary: "Done",
    };
}

function makeArmCandidate(ordinal: number, rawNow: number, raw: number): FinderArmPerformanceCandidate {
    const metric = (topMean: number) => ({
        events: 2,
        topMean,
        randomMean: 0,
        delta: topMean / 2,
        topMedian: topMean,
        ciLower: topMean / 2,
        ciUpper: topMean,
        positiveBlocks: 1,
        totalBlocks: 1,
    });
    const metrics = Object.fromEntries([
        "TOP_RAW_PROFIT_NOW", "TOP_MEAN_PROFIT_NOW", "TOP_RAW_PROFIT_NOW_CONF", "TOP_Z",
        "TOP_RAW", "TOP_MEAN", "TOP_MEAN_RAW_UNIQUE", "TOP_RAW_PROFIT", "TOP_MEAN_PROFIT",
        "BOT_RAW_PROFIT_NOW", "BOT_MEAN_PROFIT_NOW", "BOT_Z", "BOT_RAW", "BOT_MEAN", "BOT_MEAN_RAW_UNIQUE",
    ].map((arm) => [arm, metric(arm === "TOP_RAW_PROFIT_NOW" ? rawNow : arm === "TOP_RAW" ? raw : ordinal)]));
    return {
        candidateId: `arm-candidate-${ordinal}`,
        candidateOrdinal: ordinal,
        strategyKey: "arm_test",
        strategyName: "Arm Test",
        horizon: 5,
        params: { threshold: ordinal + 1 },
        backtestSettings: { executionModel: "signal_close" } as any,
        pairCoverage: { requestedPairs: 500, completedPairs: 500, failedPairs: 0, replayTargetLoadFailures: 0, noTradePairs: 0 },
        metrics: metrics as FinderArmPerformanceCandidate["metrics"],
        requestedEngineMode: "typescript",
        actualEngineMode: "typescript",
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

function makeAssetRow(symbol: string, strategyKey: string, expectancy: number): FinderAssetOpportunityResult {
    const backtest = {
        trades: [],
        equityCurve: [],
        netProfit: 10,
        netProfitPercent: 1,
        winRate: 50,
        expectancy,
        avgTrade: 1,
        profitFactor: 2,
        maxDrawdown: 1,
        maxDrawdownPercent: 1,
        totalTrades: 10,
        winningTrades: 5,
        losingTrades: 5,
        avgWin: 2,
        avgLoss: 1,
        sharpeRatio: 1,
    };
    return {
        symbol,
        strategyKey,
        strategyName: strategyKey,
        params: {},
        historicalRank: 1,
        totalCandidatesEvaluated: 1,
        isHistoricalBest: true,
        freshStatus: "fresh",
        direction: "long",
        latestSignalTime: null,
        signalAgeBars: 0,
        fillTiming: "signal_close",
        selectionResult: backtest,
        medianBarsToTp: 3,
        support: {
            freshLongCandidates: 1,
            freshShortCandidates: 0,
            freshSameDirection: 1,
            poolSize: 1,
            bestFreshRank: 1,
            directionAgreementRatio: 1,
        },
        grade: "select",
    } as FinderAssetOpportunityResult;
}

function makeFakeStrategy(name: string): Strategy {
    return {
        name,
        description: "deterministic test strategy",
        defaultParams: { threshold: 1 },
        paramLabels: { threshold: "Threshold" },
        execute(data: OHLCVData[]) {
            if (data.length < 3) return [];
            return [
                { time: data[0]!.time, type: "buy", price: data[0]!.close },
                { time: data[data.length - 1]!.time, type: "sell", price: data[data.length - 1]!.close },
            ];
        },
    } as unknown as Strategy;
}

function makeCandles(count: number): OHLCVData[] {
    return Array.from({ length: count }, (_value, index) => ({
        time: (1_700_000_000 + index * 300) as Time,
        open: 100 + index,
        high: 101 + index,
        low: 99 + index,
        close: 100.5 + index,
        volume: 1000,
    }));
}

// ---------------------------------------------------------------------------
// Recording session host for fresh-session tests
// ---------------------------------------------------------------------------

interface RecordingSessionHost extends FinderSessionHost {
    calls: {
        setProgress: Array<[boolean, number, string]>;
        status: string[];
        restoreScope: FinderScope[];
        resetForServerRunAdoption: number;
        setRunning: boolean[];
        interpretTerminal: Array<{ snapshot: FinderRunStatusSnapshot; persistedScope: string }>;
    };
}

function makeRecordingSessionHost(): RecordingSessionHost {
    const calls = {
        setProgress: [] as Array<[boolean, number, string]>,
        status: [] as string[],
        restoreScope: [] as FinderScope[],
        resetForServerRunAdoption: 0,
        setRunning: [] as boolean[],
        interpretTerminal: [] as Array<{ snapshot: FinderRunStatusSnapshot; persistedScope: string }>,
    };
    return {
        calls,
        setProgress: (active, percent, text) => { calls.setProgress.push([active, percent, text]); },
        setStatus: (text) => { calls.status.push(text); },
        restoreScope: (scope) => { calls.restoreScope.push(scope); },
        resetForServerRunAdoption: () => { calls.resetForServerRunAdoption += 1; },
        setRunning: (running) => { calls.setRunning.push(running); },
        interpretTerminal: (snapshot, persistedScope) => { calls.interpretTerminal.push({ snapshot, persistedScope }); },
    };
}

// ---------------------------------------------------------------------------
// Recording run host for workflow/controller tests
// ---------------------------------------------------------------------------

interface RecordingRunHost extends FinderRunHost {
    calls: {
        status: string[];
        availability: boolean[];
    };
}

function makeRecordingRunHost(): RecordingRunHost {
    const calls = {
        status: [] as string[],
        availability: [] as boolean[],
    };
    return {
        calls,
        setProgress: () => {},
        setStatus: (text) => { calls.status.push(text); },
        isCancelled: () => false,
        getAbortSignal: () => undefined,
        yieldControl: async () => {},
        renderRandomBenchmark: () => {},
        renderLatestResults: () => {},
        stashAndResetResort: () => {},
        populateResortOptions: () => {},
        showDiagnosticsAvailability: (available) => { calls.availability.push(available); },
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

/**
 * Give the facade fresh collaborators so integration tests cannot leak run
 * ownership, inventories, or editable settings between tests.
 */
function resetFacadeCollaborators(): void {
    const m = manager();
    m.session = new FinderServerSession();
    m.resultStore = new FinderResultStore((results) => m.saveLatestResultsSnapshot(results));
    m.controls.uiState = normalizeFinderUiState(null);
    m.controls.uiState.topN = 10;
    (m.ui as any).statusElement = null;
    (m.ui as any).lastStatusText = "";
}

beforeEach(() => {
    elsById.clear();
    (globalThis as any).localStorage._store.clear();
    (globalThis as any).localStorage._writes.clear();
    clearDomElementCache();
    installMockFetch();
});

// ---------------------------------------------------------------------------
// Session behavior on fresh FinderServerSession instances
// ---------------------------------------------------------------------------

describe("FinderServerSession reattach lifecycle (fresh instances)", () => {
    it("does not adopt a delayed initial probe when a new run started during the await", async () => {
        const session = new FinderServerSession();
        const host = makeRecordingSessionHost();
        persistActiveServerRun("old-run");
        const reattach = session.reattachToActiveServerRun(host);
        // The probe is in flight (no response yet). A new run starts while we
        // wait — exactly what the old code raced on: the probe resolving AFTER
        // the new run took ownership would overwrite its ownership token.
        session.activeRunId = "new-run";

        mockFetch.resolveFirst(runningSnapshot("old-run"));
        await reattach;

        expect(session.activeRunId, "new run ownership preserved").to.equal("new-run");
        expect(host.calls.setRunning, "run/stop UI untouched").to.deep.equal([]);
        expect(host.calls.restoreScope, "scope untouched").to.deep.equal([]);
        expect(host.calls.interpretTerminal).to.deep.equal([]);
    });

    it("aborts an in-flight status fetch when Stop cancels the reattach poll", async () => {
        const session = new FinderServerSession();
        const host = makeRecordingSessionHost();
        persistActiveServerRun("hung-run");
        const reattach = session.reattachToActiveServerRun(host);
        // Probe hangs; the user presses Stop while it is pending.
        expect(mockFetch.requests.length).to.be.greaterThan(0);
        session.stopReattachPoll();
        expect(mockFetch.aborted(), "the pending status fetch was aborted").to.equal(true);
        await reattach;
        expect(session.abortController).to.equal(null);
    });

    it("ignores a stale recovery response after the active run changed mid-await", async () => {
        const session = new FinderServerSession();
        const host = makeRecordingSessionHost();
        session.activeRunId = "run-a";
        const recovery = session.recoverActiveServerRun("run-a", "symbol_universe", host);
        expect(mockFetch.requests.length).to.be.greaterThan(0);

        // The stream-error handler is still awaiting; a new run takes over.
        session.activeRunId = "run-b";
        mockFetch.resolveFirst(terminalDoneSnapshot("run-a", [makeCandidate()]));

        const recovered = await recovery;
        expect(recovered, "stale terminal snapshot must not be adopted").to.equal(null);
        expect(session.activeRunId).to.equal("run-b");
    });

    it("does not treat an HTTP-200 server stop rejection as success", async () => {
        const session = new FinderServerSession();
        const runId = "server-rejected-stop";
        persistActiveServerRun(runId);
        const statusMessages: string[] = [];

        const stop = session.stopServerRun(runId, { setStatus: (text) => { statusMessages.push(text); } });
        mockFetch.resolveFirst(makeResponse({ ok: false, stopped: false }));
        await stop;

        expect(readFinderActiveServerRun()?.runId, "the persisted record survives a rejected stop").to.equal(runId);
        expect(statusMessages.join(" ")).to.include("rejected by the server");
    });

    it("surfaces a terminal fatal snapshot, skips result adoption, and clears the record", async () => {
        const session = new FinderServerSession();
        const host = makeRecordingSessionHost();
        persistActiveServerRun("fatal-run");
        const reattach = session.reattachToActiveServerRun(host);
        mockFetch.resolveFirst(terminalFatalSnapshot("fatal-run", "worker exploded"));
        await reattach;

        expect(host.calls.status.some((text) => text.includes("worker exploded"))).to.equal(true);
        expect(host.calls.interpretTerminal.map((call) => call.snapshot.phase)).to.deep.equal(["fatal"]);
        expect(session.activeRunId).to.equal(null);
        expect(host.calls.setRunning[host.calls.setRunning.length - 1]).to.equal(false);
        // clearActiveServerRun writes a data:null envelope rather than
        // removing the key; readFinderActiveServerRun treats it as absent.
        const stored = JSON.parse((globalThis as any).localStorage.getItem("playground_finder_active_server_run"));
        expect(stored.data).to.equal(null);
        expect(readFinderActiveServerRun()).to.equal(null);
    });

    it("clears a stale persisted record when the server no longer has the job", async () => {
        const session = new FinderServerSession();
        const host = makeRecordingSessionHost();
        persistActiveServerRun("gone-run");
        const reattach = session.reattachToActiveServerRun(host);
        mockFetch.resolveFirst(makeResponse({ ok: false }, 404));
        await reattach;

        expect(readFinderActiveServerRun()).to.equal(null);
        expect(host.calls.setRunning, "the facade UI is untouched without a matching job").to.deep.equal([]);
        expect(host.calls.interpretTerminal).to.deep.equal([]);
    });

    it("hands a terminal done snapshot to the host with the persisted scope", async () => {
        const session = new FinderServerSession();
        const host = makeRecordingSessionHost();
        persistActiveServerRun("done-run");
        const reattach = session.reattachToActiveServerRun(host);
        mockFetch.resolveFirst(terminalDoneSnapshot("done-run", [makeCandidate()]));
        await reattach;

        expect(host.calls.interpretTerminal).to.have.length(1);
        expect(host.calls.interpretTerminal[0]!.persistedScope).to.equal("symbol_universe");
        expect(host.calls.interpretTerminal[0]!.snapshot.terminalCandidates).to.have.length(1);
        expect(session.activeRunId).to.equal(null);
        expect(readFinderActiveServerRun()).to.equal(null);
    });
});

// ---------------------------------------------------------------------------
// Facade integration: terminal adoption, re-sort, and persistence
// ---------------------------------------------------------------------------

describe("Finder facade terminal adoption (integration)", () => {
    beforeEach(() => {
        resetFacadeCollaborators();
    });

    it("restores a terminal done snapshot from the persisted run id after a reload", async () => {
        persistActiveServerRun("done-run");
        const reattach = manager().reattachToActiveServerRun();
        mockFetch.resolveFirst(terminalDoneSnapshot("done-run", [makeCandidate()]));
        await reattach;

        const results = manager().resultStore.latestResults;
        expect(results.scope).to.equal("symbol_universe");
        expect(results.results).to.have.length(1);
        expect(results.results[0]!.strategyKey).to.equal("universe_test");
        expect(manager().session.activeRunId).to.equal(null);
        const stored = JSON.parse((globalThis as any).localStorage.getItem("playground_finder_active_server_run"));
        expect(stored.data).to.equal(null);
    });

    it("re-sorts the full terminal Universe inventory, not only the displayed topN", async () => {
        persistActiveServerRun("universe-resort-run");
        manager().controls.uiState.topN = 1;
        const lower = makeCandidate({ threshold: 1 }, 10);
        const higher = makeCandidate({ threshold: 2 }, 100);
        const reattach = manager().reattachToActiveServerRun();
        mockFetch.resolveFirst(terminalDoneSnapshot("universe-resort-run", [lower, higher]));
        await reattach;

        expect(manager().resultStore.latestResults.results).to.have.length(1);
        expect(manager().resultStore.latestResults.results[0]!.params.threshold).to.equal(1);

        manager().getDom().finderResort.value = "medianExpectancy";
        manager().applyResort();

        expect(manager().resultStore.latestResults.results).to.have.length(1);
        expect(manager().resultStore.latestResults.results[0]!.params.threshold).to.equal(2);
    });

    it("reattaches the full Arm Performance inventory and repeatedly re-sorts every arm locally", async () => {
        const runId = "arm-performance-reattach";
        persistActiveServerRun(runId, "arm_performance");
        manager().controls.uiState.topN = 1;
        manager().controls.uiState.scope = "arm_performance";
        const rows = [
            makeArmCandidate(0, 1, 8),
            makeArmCandidate(1, 9, 2),
            makeArmCandidate(2, 3, 12),
        ];
        const context = {
            runId,
            startedAt: 1,
            strategyKeys: ["arm_test"],
            pairs: ["AAA+BBB", "CCC+DDD"],
            failedPairs: [{ symbol: "CCC+DDD", error: "Insufficient candles", failureKind: "missing_data" }],
            interval: "4h",
            horizon: 5,
            dateMode: "full",
            evaluationCutoffSec: 1_700_000_000,
            plannedCandidateCount: rows.length,
            actualEngineModes: ["typescript"],
            capTiltWeight: "off",
            searchOptions: { mode: "random" },
            backtestSettings: {},
            capitalSettings: {},
            requestedEngineMode: "typescript",
        } as unknown as FinderArmPerformanceRunContext;

        const reattach = manager().reattachToActiveServerRun();
        mockFetch.resolveFirst(terminalArmPerformanceSnapshot(runId, rows, context));
        await reattach;

        expect(manager().resultStore.latestResults.scope).to.equal("arm_performance");
        expect(manager().resultStore.latestResults.results).to.have.length(1);
        expect(manager().resultStore.latestResults.results[0]!.candidateOrdinal).to.equal(1);
        expect(manager().resultStore.armPerformanceRunResults).to.have.length(3);
        expect(manager().resultStore.armPerformanceRunContext.pairs).to.deep.equal(context.pairs);
        expect(manager().getDom().finderCopyDiagnostics.disabled).to.equal(false);

        let copiedDiagnostics = "";
        manager().copyTextToClipboard = async (text: string) => { copiedDiagnostics = text; };
        await manager().copyFinderDiagnostics();
        const copied = JSON.parse(copiedDiagnostics);
        expect(copied.scope).to.equal("arm_performance");
        expect(copied.runContext.failedPairs).to.deep.equal(context.failedPairs);

        manager().getDom().finderResort.value = "TOP_RAW";
        manager().applyResort();
        expect(manager().resultStore.latestResults.results[0]!.candidateOrdinal).to.equal(2);

        manager().getDom().finderResort.value = "TOP_RAW_PROFIT_NOW";
        manager().applyResort();
        expect(manager().resultStore.latestResults.results[0]!.candidateOrdinal).to.equal(1);

        manager().getDom().finderResort.value = "";
        manager().applyResort();
        expect(manager().resultStore.latestResults.results[0]!.candidateOrdinal).to.equal(1);
        expect(manager().resultStore.armPerformanceRunResults.map((row: FinderArmPerformanceCandidate) => row.candidateOrdinal))
            .to.deep.equal([0, 1, 2]);
    });

    it("reloads the full terminal Arm Performance inventory from the saved context runId", async () => {
        const runId = "arm-performance-completion-reload";
        persistActiveServerRun(runId, "arm_performance");
        manager().controls.uiState.topN = 1;
        manager().controls.uiState.scope = "arm_performance";
        const rows = [
            makeArmCandidate(0, 100, 1),
            makeArmCandidate(1, 90, 100),
            makeArmCandidate(2, 80, 1000),
        ];
        const context = {
            runId,
            startedAt: 1,
            strategyKeys: ["arm_test"],
            pairs: ["AAA+BBB"],
            interval: "4h",
            horizon: 5,
            dateMode: "full",
            evaluationCutoffSec: 1_700_000_000,
            plannedCandidateCount: rows.length,
            actualEngineModes: ["typescript"],
            capTiltWeight: "off",
            searchOptions: { mode: "random", topN: 1 },
            backtestSettings: {},
            uiBacktestSettings: { riskSettingsToggle: true, stopLossEnabled: true, takeProfitEnabled: true } as any,
            capitalSettings: {},
            requestedEngineMode: "typescript",
        } as unknown as FinderArmPerformanceRunContext;

        const terminal = terminalArmPerformanceSnapshot(runId, rows, context);
        const completion = manager().reattachToActiveServerRun();
        mockFetch.resolveFirst(terminal);
        await completion;

        const persisted = JSON.parse((globalThis as any).localStorage.getItem("playground_finder_latest_results"));
        expect(persisted.data.results.results).to.have.length(1, "completion snapshot is only the saved display prefix");
        expect(persisted.data.results.results[0].candidateOrdinal).to.equal(0);
        expect(manager().loadPersistedActiveServerRun()).to.equal(null);

        // Simulate a new Finder manager instance restoring the local preview.
        manager().resultStore.latestResults = { scope: "current_chart", results: [] };
        manager().resultStore.armPerformanceRunResults = [];
        manager().resultStore.armPerformanceDefaultResults = [];
        manager().resultStore.armPerformanceRunContext = null;
        manager().resultStore.armPerformanceInventoryComplete = true;
        manager().loadPersistedLatestResults();
        expect(manager().resultStore.latestResults.inventoryComplete).to.equal(false);
        expect(manager().resultStore.latestResults.runContext.uiBacktestSettings.riskSettingsToggle).to.equal(true);
        const reload = manager().reattachToActiveServerRun();
        expect(mockFetch.requests[0]?.url).to.include(encodeURIComponent(runId));
        mockFetch.resolveFirst(terminal);
        await reload;

        expect(manager().resultStore.armPerformanceRunResults).to.have.length(3);
        manager().getDom().finderResort.value = "TOP_RAW";
        manager().applyResort();
        expect(manager().resultStore.latestResults.results[0]!.candidateOrdinal).to.equal(2);
    });

    it("keeps Copy Diagnostics available when every Arm Performance candidate fails", async () => {
        const runId = "arm-performance-no-candidates";
        persistActiveServerRun(runId, "arm_performance");
        const context = {
            runId,
            startedAt: 1,
            strategyKeys: ["arm_test"],
            pairs: ["AAA+BBB"],
            failedPairs: [{ symbol: "AAA+BBB", error: "Insufficient candles", failureKind: "missing_data" }],
            interval: "4h",
            horizon: 5,
            dateMode: "full",
            evaluationCutoffSec: 1_700_000_000,
            plannedCandidateCount: 1,
            actualEngineModes: [],
            capTiltWeight: "off",
            searchOptions: { mode: "random" },
            backtestSettings: {},
            capitalSettings: {},
            requestedEngineMode: "typescript",
        } as unknown as FinderArmPerformanceRunContext;

        const reattach = manager().reattachToActiveServerRun();
        mockFetch.resolveFirst(terminalArmPerformanceSnapshot(runId, [], context));
        await reattach;

        expect(manager().resultStore.latestResults.scope).to.equal("arm_performance");
        expect(manager().resultStore.armPerformanceRunResults).to.have.length(0);
        expect(manager().getDom().finderCopyDiagnostics.disabled).to.equal(false);

        manager().resultStore.latestResults = { scope: "current_chart", results: [] };
        manager().resultStore.armPerformanceRunContext = null;
        manager().loadPersistedLatestResults();
        expect(manager().resultStore.latestResults.scope).to.equal("arm_performance");
        expect(manager().resultStore.armPerformanceRunContext.failedPairs).to.deep.equal(context.failedPairs);
        expect(manager().getDom().finderCopyDiagnostics.disabled).to.equal(false);

        let copiedDiagnostics = "";
        manager().copyTextToClipboard = async (text: string) => { copiedDiagnostics = text; };
        await manager().copyFinderDiagnostics();
        const copied = JSON.parse(copiedDiagnostics);
        expect(copied.runContext.failedPairs).to.deep.equal(context.failedPairs);
        expect(copied.results).to.deep.equal([]);
    });

    it("keeps the incomplete Arm Performance preview when its retained server run is gone", async () => {
        const runId = "arm-performance-expired-preview";
        const preview = makeArmCandidate(0, 10, 10);
        preview.candidateId = runId + ":candidate-0";
        manager().resultStore.latestResults = {
            scope: "arm_performance",
            results: [preview],
            runContext: {
                runId,
                startedAt: 1,
                strategyKeys: ["arm_test"],
                pairs: ["AAA+BBB"],
                interval: "4h",
                horizon: 5,
                dateMode: "full",
                evaluationCutoffSec: 1_700_000_000,
                plannedCandidateCount: 1,
                actualEngineModes: ["typescript"],
                capTiltWeight: "off",
                searchOptions: { mode: "random" },
                backtestSettings: {},
                capitalSettings: {},
                requestedEngineMode: "typescript",
            } as FinderArmPerformanceRunContext,
            inventoryComplete: false,
        };

        manager().resultStore.latestResults.runContext = null;
        const recovery = manager().reattachToActiveServerRun();
        expect(mockFetch.requests[0]?.url).to.include(runId);
        mockFetch.resolveFirst({ ok: false }, 404);
        await recovery;

        expect(manager().resultStore.latestResults.results).to.deep.equal([preview]);
        expect(manager().resultStore.latestResults.inventoryComplete).to.equal(false);
    });

    it("keeps Re-Sort available for an incomplete Arm Performance preview", () => {
        const results = [
            makeArmCandidate(0, 10, 10),
            makeArmCandidate(1, 10, 100),
        ];
        const m = manager();
        m.controls.uiState.scope = "arm_performance";
        m.getDom().finderScope.value = "arm_performance";
        m.resultStore.armPerformanceRunResults = [...results];
        m.resultStore.armPerformanceDefaultResults = [...results];
        m.resultStore.armPerformanceInventoryComplete = false;
        m.resultStore.setArmPerformanceLatestResults(results, false, 20, false);
        m.populateResortOptions();

        expect(m.getDom().finderResort.disabled).to.equal(false);
        expect(m.getDom().finderResort.children.some((option: any) => option.value === "TOP_RAW")).to.equal(true);

        m.getDom().finderResort.value = "TOP_RAW";
        m.applyResort();

        expect(m.resultStore.latestResults.results[0]!.candidateOrdinal).to.equal(1);
        expect(m.resultStore.latestResults.inventoryComplete).to.equal(false);
    });
});

describe("FinderManager Asset Opportunity batch stream contracts", () => {
    beforeEach(() => {
        resetFacadeCollaborators();
    });

    it("does not turn a recovered batch fatal into a successful outcome", async () => {
        const runId = "batch-fatal-recovery";
        manager().session.activeRunId = runId;
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
        manager().session.activeRunId = runId;
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
    beforeEach(() => {
        resetFacadeCollaborators();
    });

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
            manager().resultStore.setLatestResults({ scope: "current_chart", results: [result] }, false);
        }
        expect(writes(), "no snapshot writes during provisional updates").to.equal(0);

        // Terminal adoption (default persist = true): exactly one commit.
        manager().resultStore.setLatestResults({ scope: "current_chart", results: [result] });
        expect(writes()).to.equal(1);
        const stored = JSON.parse((globalThis as any).localStorage.getItem(key));
        expect(stored.schema).to.equal("finder.latest_results");
        // saveLatestResultsSnapshot stores { savedAt, symbol, interval, results }
        // where `results` is itself a FinderLatestResults { scope, results }.
        expect(stored.data.results.results).to.have.length(1);
    });
});

describe("Finder Arm Performance scope controls", () => {
    it("visibly constrains incompatible search and window options without an arm selector", () => {
        // `any` so the test can seed select `options` arrays (readonly on the
        // DOM types, plain arrays on the fake elements).
        const dom: any = createFakeFinderManagerDom();
        const controls = new FinderControls({
            getDom: () => dom,
            setStatus: () => {},
            renderLatestResults: () => {},
            populateResortOptions: () => {},
            applyResort: () => {},
            requestRun: () => {},
            renderRandomBenchmark: () => {},
            selection: { getVisibleStrategyKeys: () => [] } as any,
        });
        dom.finderMode.value = "genetic";
        dom.finderMode.options = [
            { value: "grid", disabled: false },
            { value: "random", disabled: false },
            { value: "genetic", disabled: false },
        ];
        dom.finderDataSlice.value = "half_newest";
        dom.finderDataSlice.options = [
            { value: "all", disabled: false },
            { value: "date_range", disabled: false },
            { value: "half_newest", disabled: false },
        ];
        dom.finderScope.value = "arm_performance";
        controls.uiState.scope = "arm_performance";
        controls.applyScopeUi();

        expect(dom.finderMode.options[2].disabled).to.equal(true);
        expect(dom.finderMode.value).to.equal("random");
        expect(dom.finderDataSlice.options[0].disabled).to.equal(false);
        expect(dom.finderDataSlice.options[1].disabled).to.equal(false);
        expect(dom.finderDataSlice.options[2].disabled).to.equal(true);
        expect(dom.finderDataSlice.value).to.equal("all");
        expect(dom.finderUniverseSymbolsLabel.textContent).to.equal("Synthetic Pairs");
        expect(dom.finderArmPerformanceSettings.style.display).to.equal("");
        expect(dom.finderTradeFilterSection.style.display).to.equal("none");
    });
});

// ---------------------------------------------------------------------------
// Copy Diagnostics availability transitions (regression)
// ---------------------------------------------------------------------------

function makeStubControllerDeps(host: FinderRunHost, overrides: Partial<FinderRunControllerDeps> = {}): FinderRunControllerDeps {
    return {
        host: () => host,
        store: () => new FinderResultStore(() => {}),
        session: () => new FinderServerSession(),
        isMultiAssetScope: () => true,
        setRunningUI: () => {},
        prepareRun: () => {},
        captureRunSettings: () => ({}) as any,
        readOptions: () => ({
            scope: "current_chart",
            mode: "random",
            sortPriority: ["netProfit"],
            useAdvancedSort: false,
            topN: 5,
            steps: 1,
            rangePercent: 0,
            maxRuns: 10,
            tradeFilterEnabled: false,
            minTrades: 0,
            maxTrades: Number.POSITIVE_INFINITY,
            dataSlice: "all",
        }) as any,
        setLastFinderOptions: () => {},
        getSelectedStrategies: async () => [],
        getUniverseSelectedStrategies: async () => [],
        resolveExitStrategyCandidates: async () => undefined,
        generateParamSets: () => [{ threshold: 1 }],
        retainEvaluationData: () => {},
        setDiagnostics: () => {},
        setAssetDiagnostics: () => {},
        readBatchHoldoutRange: () => ({ start: 1, end: 5, error: null }),
        isBatchMode: () => false,
        getPairListText: () => "",
        getSelectedArm: () => "TOP_RAW_PROFIT_NOW" as any,
        ...overrides,
    };
}

describe("Copy Diagnostics availability transitions", () => {
    beforeEach(() => {
        resetFacadeCollaborators();
    });

    it("disables the button when a run starts and re-enables it when failure diagnostics are built", async () => {
        const host = makeRecordingRunHost();
        const events: string[] = [];
        const controller = new FinderRunController(makeStubControllerDeps(host, {
            prepareRun: () => { events.push("prepareRun"); },
            getSelectedStrategies: async () => { throw new Error("engine exploded"); },
        }));
        const originalAvailability = host.showDiagnosticsAvailability.bind(host);
        (host as any).showDiagnosticsAvailability = (available: boolean) => {
            events.push(`availability:${available}`);
            originalAvailability(available);
        };

        await controller.runFinder();

        expect(events[0]).to.equal("prepareRun");
        expect(events).to.include("availability:false");
        expect(events.indexOf("availability:false")).to.be.greaterThan(events.indexOf("prepareRun"));
        expect(host.calls.availability[host.calls.availability.length - 1]).to.equal(true);
    });

    it("enables the button after a Symbol Universe run adopts terminal diagnostics", async () => {
        const host = makeRecordingRunHost();
        const session = new FinderServerSession();
        const store = new FinderResultStore(() => {});
        const strategy = makeFakeStrategy("Universe Test");
        const options: any = {
            scope: "symbol_universe",
            mode: "random",
            topN: 2,
            universe: { symbols: ["AAA"], sortPriority: [], minActiveSymbols: 1, minTotalTrades: 0, minProfitableActiveRatio: 0 },
            dataSlice: "all",
            oosValidationEnabled: false,
        };
        const diagnostics = { runId: "diag-1", bottlenecks: [] } as unknown as FinderDiagnostics;

        const run = runUniverseFinder({
            host, store, session,
            strategies: {
                getSelectedStrategies: async () => [],
                getUniverseSelectedStrategies: async () => [{ key: "universe_test", name: "Universe Test", strategy }],
                resolveExitStrategyCandidates: async () => undefined,
            },
            options,
            startTime: performance.now(),
            getUniverseSelectedStrategies: async () => [{ key: "universe_test", name: "Universe Test", strategy }],
            onDiagnostics: (value) => { expect(value).to.deep.equal(diagnostics); },
        });
        // The outer workflow awaits strategy loading before issuing the run
        // request; yield a macrotask so the fetch lands in the mock.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(mockFetch.requests.length).to.be.greaterThan(0);
        mockFetch.resolveFirst(makeNdjsonResponse([
            { type: "start", runId: session.activeRunId, totalCandidates: 1, totalSymbols: 1, interval: "5m", strategyKeys: ["universe_test"] },
            {
                type: "done",
                ok: true,
                cancelled: false,
                runId: session.activeRunId,
                interval: "5m",
                totals: { loadedSymbols: 1, failedSymbols: 0, survivors: 1, oosRemoved: 0 },
                summary: "done",
                candidates: [makeCandidate()],
                diagnostics,
            },
        ]));

        const completed = await run;
        expect(completed).to.equal(true);
        expect(store.latestResults.results).to.have.length(1);
        expect(host.calls.availability).to.deep.equal([true]);
    });

    it("enables the button after an Asset Opportunity run adopts asset diagnostics", async () => {
        const host = makeRecordingRunHost();
        const session = new FinderServerSession();
        const store = new FinderResultStore(() => {});
        const strategy = makeFakeStrategy("Asset Test");
        const options: any = {
            scope: "asset_opportunity",
            mode: "random",
            topN: 5,
            assetOpportunity: { symbols: ["AAA"] },
            dataSlice: "all",
        };
        const assetDiagnostics = {
            totalAssets: 1,
            assetsWithFreshEntry: 1,
            assetsWithNoFreshEntry: 0,
            selectGradeAssets: 1,
            watchGradeAssets: 0,
            rejectGradeAssets: 0,
            failedAssets: [] as Array<{ symbol: string; reason: string }>,
        };

        const run = runAssetOpportunityFinder({
            host, store, session,
            strategies: {
                getSelectedStrategies: async () => [{ key: "asset_test", name: "Asset Test", strategy }],
                getUniverseSelectedStrategies: async () => [],
                resolveExitStrategyCandidates: async () => undefined,
            },
            options,
            startTime: performance.now(),
            getSelectedStrategies: async () => [{ key: "asset_test", name: "Asset Test", strategy }],
            onDiagnostics: (diagnostics, adoptedAssetDiagnostics) => {
                expect(diagnostics).to.equal(null);
                expect(adoptedAssetDiagnostics?.totalAssets).to.equal(1);
            },
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        mockFetch.resolveFirst(makeNdjsonResponse([
            { type: "asset_done", runId: session.activeRunId, assets: [makeAssetRow("AAA", "asset_test", 2)], totals: { totalAssets: 1, assetsWithFreshEntry: 1, failedAssets: 0 }, diagnostics: null, assetDiagnostics },
        ]));

        const completed = await run;
        expect(completed).to.equal(true);
        expect(store.latestResults.results).to.have.length(1);
        expect(host.calls.availability).to.deep.equal([true]);
    });

    it("enables the button after a current-chart run adopts diagnostics", async () => {
        const host = makeRecordingRunHost();
        const store = new FinderResultStore(() => {});
        const { state } = await import("../lib/state");
        const savedData = state.ohlcvData;
        const savedInterval = (state as any).currentInterval;
        const savedBlockRange = (state as any).blockRange;
        state.set("ohlcvData", makeCandles(64));
        state.set("currentInterval", "5m");
        state.set("blockRange", null);

        let retained: { interval: string; data: OHLCVData[] } | null = null;
        let adoptedDiagnostics: unknown = null;

        try {
            const completed = await runCurrentChartFinder({
                host, store,
                strategies: {
                    getSelectedStrategies: async () => [],
                    getUniverseSelectedStrategies: async () => [],
                    resolveExitStrategyCandidates: async () => undefined,
                },
                options: {
                    scope: "current_chart",
                    mode: "random",
                    sortPriority: ["netProfit"],
                    useAdvancedSort: false,
                    topN: 5,
                    steps: 1,
                    rangePercent: 0,
                    maxRuns: 10,
                    tradeFilterEnabled: false,
                    minTrades: 0,
                    maxTrades: Number.POSITIVE_INFINITY,
                    dataSlice: "all",
                } as any,
                startTime: performance.now(),
                getSelectedStrategies: async () => [{ key: "cc_test", name: "Current Chart Test", strategy: makeFakeStrategy("Current Chart Test") }],
                generateParamSets: () => [{ threshold: 1 }],
                retainEvaluationData: (data) => { retained = data; },
                onDiagnostics: (diagnostics) => { adoptedDiagnostics = diagnostics; },
            });

            expect(completed).to.equal(true);
            expect(retained).to.not.equal(null);
            expect(retained!.interval).to.equal("5m");
            expect(adoptedDiagnostics).to.not.equal(null);
            expect(host.calls.availability).to.deep.equal([true]);
        } finally {
            state.set("ohlcvData", savedData);
            state.set("currentInterval", savedInterval);
            state.set("blockRange", savedBlockRange);
        }
    });

    it("enables the button after a Strategy Quality Audit produces diagnostics", async () => {
        // Every dataset load fails offline; the audit must still finish with
        // performance diagnostics so Copy Diagnostics stays meaningful.
        (globalThis as any).fetch = async () => ({
            ok: true,
            status: 200,
            text: async () => "[]",
            json: async () => [],
        });
        const host = makeRecordingRunHost();
        const store = new FinderResultStore(() => {});
        const strategy = makeFakeStrategy("Quality Test");
        let adoptedDiagnostics: unknown = null;

        const completed = await runStrategyQualityFinder({
            host, store,
            options: {
                scope: "strategy_quality",
                mode: "random",
                universe: { symbols: ["NOPE"], sortPriority: [], minActiveSymbols: 1, minTotalTrades: 0, minProfitableActiveRatio: 0 },
                dataSlice: "all",
                oosValidationEnabled: false,
            } as any,
            startTime: performance.now(),
            getUniverseSelectedStrategies: async () => [{ key: "sq_test", name: "Quality Test", strategy }],
            onDiagnostics: (diagnostics) => { adoptedDiagnostics = diagnostics; },
        });

        expect(completed).to.equal(true);
        expect(adoptedDiagnostics).to.not.equal(null);
        expect(host.calls.availability).to.deep.equal([true]);
    });
});

// ---------------------------------------------------------------------------
// FinderUI rendering contracts (unchanged scope)
// ---------------------------------------------------------------------------

describe("FinderUI Arm Performance preview actions", () => {
    it("keeps Apply enabled when an incomplete cached preview has no run context", () => {
        const ui = new FinderUI();
        ui.renderArmPerformanceResults([makeArmCandidate(0, 10, 10)], null, "TOP_RAW", true);

        const findApply = (node: any): any => {
            if (node?.className === "btn btn-secondary finder-apply") return node;
            for (const child of node?.children ?? []) {
                const found = findApply(child);
                if (found) return found;
            }
            return null;
        };
        const button = findApply(elsById.get("finderList"));
        expect(button, "the result has an Apply button").to.not.equal(null);
        expect(button.disabled, "missing run context does not disable Apply").to.equal(false);
        expect(button.title ?? "").to.not.include("unavailable");
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

    it("defers Strategy Quality symbol rows until the breakdown is opened", () => {
        const ui = new FinderUI();
        const result = {
            strategyKey: "quality_test",
            strategyName: "Quality Test",
            params: {},
            symbols: [
                { symbol: "AAA", status: "profitable", barCount: 100 },
                { symbol: "BBB", status: "no_trades", barCount: 100 },
            ],
            requestedSymbols: 2,
            loadedSymbols: 2,
            failedSymbols: 0,
            activeSymbols: 1,
            profitableSymbols: 1,
            losingSymbols: 0,
            noTradeSymbols: 1,
            totalTrades: 10,
            totalNetProfit: 10,
            averageNetProfit: 10,
            averageExpectancy: 1,
            medianExpectancy: 1,
            averageProfitFactor: 2,
            profitFactor: 2,
            averageSharpe: 1,
            sharpeAvailableSymbols: 1,
            weightedWinRate: 100,
            worstMaxDrawdownPercent: 0,
        } as FinderStrategyQualityResult;

        ui.renderStrategyQualityResults([result]);

        const list = elsById.get("finderList");
        const details = findByTag(list, "details");
        expect(details, "a Strategy Quality breakdown exists").to.not.equal(null);
        expect(symbolRowCount(details), "no rows are built while closed").to.equal(0);

        details.open = true;
        details.dispatchEvent({ type: "toggle" });
        expect(symbolRowCount(details)).to.equal(2);

        details.dispatchEvent({ type: "toggle" });
        expect(symbolRowCount(details)).to.equal(2);
    });
});

describe("FinderUI Asset Opportunity metric presentation", () => {
    function makeAssetResult(medianBarsToTp: number | null): FinderAssetOpportunityResult {
        const backtest = {
            trades: [],
            equityCurve: [],
            netProfit: 10,
            netProfitPercent: 1,
            winRate: 50,
            expectancy: 1,
            avgTrade: 1,
            profitFactor: 2,
            maxDrawdown: 1,
            maxDrawdownPercent: 1,
            totalTrades: 10,
            winningTrades: 5,
            losingTrades: 5,
            avgWin: 2,
            avgLoss: 1,
            sharpeRatio: 1,
        };
        return {
            symbol: medianBarsToTp === null ? "MISSING" : "FAST",
            strategyKey: "ui_test",
            strategyName: "UI Test",
            params: {},
            historicalRank: 1,
            totalCandidatesEvaluated: 1,
            isHistoricalBest: true,
            freshStatus: "fresh",
            direction: "long",
            latestSignalTime: null,
            signalAgeBars: 0,
            fillTiming: "signal_close",
            selectionResult: backtest,
            medianBarsToTp,
            ...(medianBarsToTp !== null
                ? {
                    priorTupleRecurrenceCount: 2,
                    strategyCoverageCount: 3,
                    barrierExitShare: 0.8,
                    entryHourConcentration: 0.75,
                    tradeGapUniformity: 1.25,
                    topDecileProfitShare: 0.4,
                    winnerLoserHoldGapBars: -2,
                    entryPriceRegimeMembership: 0.9,
                    equityPathLinearity: 0.85,
                }
                : {}),
            support: {
                freshLongCandidates: 1,
                freshShortCandidates: 0,
                freshSameDirection: 1,
                poolSize: 1,
                bestFreshRank: 1,
                directionAgreementRatio: 1,
            },
            grade: "select",
        };
    }

    function collectText(root: any): string {
        return [
            root.textContent ?? "",
            ...(root.children ?? []).map((child: any) => collectText(child)),
        ].join(" ");
    }

    it("renders the median TP value and makes missing legacy values explicit", () => {
        const ui = new FinderUI();
        ui.renderAssetOpportunityResults([
            makeAssetResult(3.5),
            makeAssetResult(null),
        ]);

        const text = collectText(elsById.get("finderList"));
        expect(text).to.include("Median TP 3.5 bars");
        expect(text).to.include("Median TP --");
        expect(text).to.include("Recurrence 2");
        expect(text).to.include("Coverage 3 strategies");
        expect(text).to.include("Barrier 80%");
        expect(text).to.include("Hour 0.75");
        expect(text).to.include("Gap 1.25");
        expect(text).to.include("Top Decile 40%");
        expect(text).to.include("Win-Lose Hold -2.0 bars");
        expect(text).to.include("Price Regime 0.90");
        expect(text).to.include("Path R² 0.85");
        expect(text).to.include("Coverage --");
    });
});
