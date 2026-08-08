/** Browser-visible analysis lifecycle regressions not covered by plugin specs. */
import { expect } from "chai";
import { describe, it, before, after, beforeEach } from "node:test";
import { createBatchBacktestService, type BatchBacktestService } from "../lib/batch-backtest/batch-backtest-service";
import type { BatchBacktestDom } from "../lib/batch-backtest/batch-backtest-dom";
import { BATCH_BACKTEST_REQUIRED_IDS } from "../lib/batch-backtest/batch-backtest-dom";
import { state } from "../lib/state";
import { backtestService } from "../lib/backtest-service";
import {
    createFakeBatchBacktestDom,
    createFakeBatchElement,
} from "./helpers/fake-batch-backtest-dom";

function fakeEl(): any {
    return createFakeBatchElement();
}

/** Shared fake DOM derived from the live BatchBacktestDom contract. */
function fakeDom(): BatchBacktestDom {
    return createFakeBatchBacktestDom();
}

/** Fetch mock responder type. */
type FetchResponse = {
    ok: boolean;
    status: number;
    body?: ReadableStream<Uint8Array> | null;
    text?: string;
};
type FetchResponder = (url: string, init?: any) => FetchResponse | Promise<FetchResponse>;

// Saved globals to restore after the suite.
let savedDocument: any;
let savedLocalStorage: any;
let savedFetch: any;

before(() => {
    savedDocument = (globalThis as any).document;
    savedLocalStorage = (globalThis as any).localStorage;
    savedFetch = (globalThis as any).fetch;
    (globalThis as any).document = {
        getElementById: () => fakeEl(),
        createElement: () => fakeEl(),
        createDocumentFragment: () => fakeEl(),
        addEventListener: () => {},
    };
    (globalThis as any).localStorage = {
        _store: new Map<string, string>(),
        getItem(k: string) { return this._store.has(k) ? this._store.get(k)! : null; },
        setItem(k: string, v: string) { this._store.set(k, v); },
        removeItem(k: string) { this._store.delete(k); },
    };
});

after(() => {
    currentService.dispose();
    if (savedDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = savedDocument;
    if (savedLocalStorage === undefined) delete (globalThis as any).localStorage;
    else (globalThis as any).localStorage = savedLocalStorage;
    (globalThis as any).fetch = savedFetch;
});

let currentService: BatchBacktestService = createBatchBacktestService();

beforeEach(() => {
    currentService.dispose();
    currentService = createBatchBacktestService();
});

function svc(): any { return currentService as any; }

function topMeanResultFixture(): any {
    return {
        runId: "sp500_top_mean_completed",
        completed: true,
        counts: {},
        horizons: [{
            horizon: 12,
            events: 4,
            topMean: {
                events: 4,
                topMean: 0.08,
                randomMean: 0.03,
                delta: 0.05,
            },
            topAssets: [{
                asset: "AAA",
                events: 4,
                share: 1,
                topMean: 0.08,
                randomMean: 0.03,
                delta: 0.05,
            }],
        }],
        warnings: [],
        reportLines: ["TOP_MEAN test result"],
    };
}

function setupForAnalysis(fingerprint = "fp-test"): BatchBacktestDom {
    const dom = fakeDom();
    const s = svc();
    s.dom = dom;
    s.bindEvents(dom);
    s.serverHasArtifacts = true;
    s.lastRunFingerprint = fingerprint;
    s.lastRunInterval = "5m";
    s.lastRunStrategyKey = "test";
    s.analysisInFlight = false;
    s.analysisCancelRequested = false;
    s.pendingStopPromise = null;
    s.activeServerRunId = null;
    // Reset Balanced Generator state so a previous test's remembered
    // provenance does not leak into the next test.
    s.activePairListProvenance = null;
    s.lastBalancedPairListResult = null;
    s.runInFlight = false;
    s.batchActionInFlight = false;
    s.topMeanReattachInFlight = false;
    s.activeTopMeanRunId = null;
    s.serverRunActive = false;
    (globalThis as any).localStorage._store.clear();
    s.buildCurrentRunFingerprint = () => fingerprint;
    return dom;
}

function persistTopMeanRunForTest(runId: string): void {
    (globalThis as any).localStorage.setItem(
        "sp500_top_mean_active_run_id",
        JSON.stringify({
            schema: "sp500_top_mean_active_run_id.v1",
            version: 1,
            data: { runId },
        }),
    );
}

async function withMockFetch(responder: FetchResponder, fn: () => Promise<void>): Promise<void> {
    const prev = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string, init?: any) => {
        const r = await responder(url, init);
        return {
            ok: r.ok,
            status: r.status,
            body: r.body ?? null,
            text: async () => r.text ?? "",
            json: async () => JSON.parse(r.text ?? "{}"),
        };
    };
    try {
        await fn();
    } finally {
        (globalThis as any).fetch = prev;
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BatchBacktestService analysis lifecycle", () => {
    it("initializes the service successfully against the current Batch DOM contract", () => {
        // Intent: fakeDom must include every current BatchBacktestDom field so
        // service.bindEvents no longer fails during suite setup when TOP_MEAN
        // controls are added. A missing field is a fixture bug, not product.
        const dom = createFakeBatchBacktestDom();
        for (const id of BATCH_BACKTEST_REQUIRED_IDS) {
            expect((dom as any)[id], `missing DOM field ${id}`).to.not.equal(undefined);
        }
        const s = svc();
        s.dom = dom;
        expect(() => s.bindEvents(dom)).to.not.throw();
        expect(dom.batchBacktestSp500TopMeanRunBtn, "TOP_MEAN run button present").to.not.equal(undefined);
        expect(dom.batchBacktestSp500TopMeanCopyOpenScoreBtn, "TOP_MEAN Copy OPEN_SCORE button present").to.not.equal(undefined);
        expect(dom.batchBacktestSp500TopMeanDetailsSelector, "TOP_MEAN details selector present").to.not.equal(undefined);
        expect(dom.batchBacktestSp500TopMeanDetailsBtn, "TOP_MEAN details button present").to.not.equal(undefined);
    });

    it("keeps TOP_MEAN OPEN_SCORE copy output separate from diagnostics", () => {
        setupForAnalysis();
        const result = topMeanResultFixture();
        result.reportLines = [
            "OPEN_SCORE USD | DATA_COMPLETE",
            "================ OPEN_SCORE USD | CALENDAR YEAR 2025 ================",
            "config | window=2025-01-01..2025-12-31",
        ];
        svc().latestTopMeanResult = result;
        svc().recordTopMeanDiagnostic("run.start", { workerCount: 4 });

        expect(svc().buildTopMeanOpenScoreText()).to.equal(result.reportLines.join("\n"));
        expect(svc().buildTopMeanOpenScoreText()).to.not.include("workerCount");
        expect(svc().buildTopMeanDiagnosticText()).to.include("workerCount");
    });

    it("shows per-event OPEN_SCORE details without adding them to copied reports", () => {
        const dom = setupForAnalysis();
        const result = topMeanResultFixture();
        result.reportLines = ["OPEN_SCORE USD | SUMMARY ONLY"];
        result.openScoreEventDetails = [
            {
                decisionTime: 1_700_000_000,
                entryTime: 1_700_003_600,
                exitTime: 1_700_176_400,
                horizonBars: 48,
                selector: "TOP_MEAN",
                direction: "long",
                asset: "TOP_MEAN_ONLY_ASSET",
                selectedReturn: -0.2239,
                controlReturn: -0.0162,
                delta: -0.2077,
                eligibleCandidates: 12,
            },
            {
                decisionTime: 1_700_000_000,
                entryTime: 1_700_003_600,
                exitTime: 1_700_176_400,
                horizonBars: 48,
                selector: "MAX_ACTIVE",
                direction: "long",
                asset: "MAX_ACTIVE_ONLY_ASSET",
                selectedReturn: 0.1455,
                controlReturn: 0.0392,
                delta: 0.1063,
                eligibleCandidates: 12,
            },
        ];
        svc().latestTopMeanResult = result;
        svc().renderTopMeanResults(dom, result);

        expect(dom.batchBacktestSp500TopMeanDetailsSelector.value).to.equal("TOP_MEAN");
        expect(dom.batchBacktestSp500TopMeanDetailsSelector.disabled).to.equal(false);
        expect(dom.batchBacktestSp500TopMeanDetailsBtn.disabled).to.equal(false);
        expect(dom.batchBacktestSp500TopMeanDetails.hidden).to.equal(true);
        svc().toggleSp500TopMeanOpenScoreDetails();
        expect(dom.batchBacktestSp500TopMeanDetails.hidden).to.equal(false);
        expect(dom.batchBacktestSp500TopMeanDetailsBtn.textContent).to.equal("Hide OPEN_SCORE Details");
        expect(dom.batchBacktestSp500TopMeanDetails.innerHTML).to.include("TOP_MEAN");
        expect(dom.batchBacktestSp500TopMeanDetails.innerHTML).to.include("TOP_MEAN_ONLY_ASSET");
        expect(dom.batchBacktestSp500TopMeanDetails.innerHTML).to.not.include("MAX_ACTIVE_ONLY_ASSET");
        expect(dom.batchBacktestSp500TopMeanDetails.innerHTML).to.include("-22.39%");
        expect(dom.batchBacktestSp500TopMeanDetails.innerHTML).to.include("-20.77%");
        expect(dom.batchBacktestSp500TopMeanDetails.innerHTML).to.include("2023-11-14 22:13:20");

        dom.batchBacktestSp500TopMeanDetailsSelector.value = "MAX_ACTIVE";
        dom.batchBacktestSp500TopMeanDetailsSelector.dispatchEvent({ type: "change" } as unknown as Event);
        expect(dom.batchBacktestSp500TopMeanDetails.innerHTML).to.include("MAX_ACTIVE_ONLY_ASSET");
        expect(dom.batchBacktestSp500TopMeanDetails.innerHTML).to.include("+14.55%");
        expect(dom.batchBacktestSp500TopMeanDetails.innerHTML).to.not.include("TOP_MEAN_ONLY_ASSET");

        const copied = svc().buildTopMeanOpenScoreText();
        expect(copied).to.equal("OPEN_SCORE USD | SUMMARY ONLY");
        expect(copied).to.not.include("TOP_MEAN_ONLY_ASSET");
        expect(copied).to.not.include("MAX_ACTIVE_ONLY_ASSET");
        expect(copied).to.not.include("2023-11-14");
    });

    it("does not persist large OPEN_SCORE detail rows in localStorage", () => {
        setupForAnalysis();
        const result = topMeanResultFixture();
        result.openScoreEventDetails = [{
            selector: "TOP_MEAN",
            asset: "DETAIL_ONLY_ASSET",
        }];
        result.annualReports = [{
            year: 2026,
            sampleFromSec: 1,
            sampleToSec: 2,
            horizons: [],
            warnings: [],
            reportLines: ["annual"],
            eventDetails: [{
                selector: "MAX_ACTIVE",
                asset: "ANNUAL_DETAIL_ONLY",
            }],
        }];

        svc().persistLatestTopMeanResult(result);

        const stored = [...(globalThis as any).localStorage._store.values()].join("\n");
        expect(stored).to.not.include("DETAIL_ONLY_ASSET");
        expect(stored).to.not.include("ANNUAL_DETAIL_ONLY");
        expect(stored).to.include("annual");
    });

    it("rejects TOP_MEAN coordinator while another Batch action is in flight", async () => {
        const dom = setupForAnalysis();
        svc().batchActionInFlight = true;
        let fetchCalled = false;
        await withMockFetch(() => {
            fetchCalled = true;
            return { ok: true, status: 200, text: "{}" };
        }, async () => {
            await svc().runSp500TopMeanCoordinator();
        });
        expect(fetchCalled, "TOP_MEAN must short-circuit before fetch").to.equal(false);
        expect(dom.batchBacktestSp500TopMeanProgressText.textContent).to.include("already in progress");
        svc().batchActionInFlight = false;
    });

    it("runs custom crypto TOP_MEAN markets at the current chart interval", async () => {
        const dom = setupForAnalysis();
        const service = svc();
        dom.batchBacktestSymbols.value = "BTCUSDT\nZEC+APT";
        state.currentInterval = "15m";
        let requestBody: any = null;
        const originalResolver = service.resolveTopMeanBuiltInStrategy;
        const originalBacktestSettings = backtestService.getBacktestSettings;
        const originalCapitalSettings = backtestService.getCapitalSettings;
        service.resolveTopMeanBuiltInStrategy = async () => ({
            strategyKey: "test",
            strategy: { defaultParams: {} },
        });
        backtestService.getBacktestSettings = () => ({});
        backtestService.getCapitalSettings = () => ({
            initialCapital: 10_000,
            positionSize: 100,
            commission: 0,
            sizingMode: "fixed",
            fixedTradeAmount: 1_000,
        });

        try {
            await withMockFetch((url, init) => {
                if (String(url).includes("/sp500-top-mean/run")) {
                    requestBody = JSON.parse(String(init?.body ?? "{}"));
                }
                return {
                    ok: true,
                    status: 200,
                    body: new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.close();
                        },
                    }),
                };
            }, async () => {
                await service.runSp500TopMeanCoordinator();
            });
        } finally {
            service.resolveTopMeanBuiltInStrategy = originalResolver;
            backtestService.getBacktestSettings = originalBacktestSettings;
            backtestService.getCapitalSettings = originalCapitalSettings;
        }

        expect(requestBody.interval).to.equal("15m");
        expect(requestBody.pairListText).to.equal("BTCUSDT\nZEC+APT");
    });

    it("persists the active run id and restores it after a tab-style reset", () => {
        setupForAnalysis();
        svc().persistActiveServerRun("batch-owned");
        svc().activeServerRunId = null;

        expect(svc().loadPersistedActiveServerRun()?.runId).to.equal("batch-owned");
    });

    it("restores the completed TOP_MEAN Coordinator result after a tab-style reset", () => {
        // Intent: a completed coordinator result is user-visible research
        // output, not transient run state. Reloading the Batch tab must restore
        // the rendered leaderboard and its Copy/Download actions.
        const dom = setupForAnalysis();
        const result = topMeanResultFixture();
        svc().persistLatestTopMeanResult(result);

        svc().latestTopMeanResult = null;
        dom.batchBacktestSp500TopMeanResults.innerHTML = "";
        dom.batchBacktestSp500TopMeanCopyBtn.disabled = true;
        dom.batchBacktestSp500TopMeanCopyOpenScoreBtn.disabled = true;
        dom.batchBacktestSp500TopMeanDownloadBtn.disabled = true;

        svc().loadPersistedLatestTopMeanResult(dom);

        expect(svc().latestTopMeanResult).to.deep.equal(result);
        expect(dom.batchBacktestSp500TopMeanResults.innerHTML).to.include("AAA");
        expect(dom.batchBacktestSp500TopMeanCopyBtn.disabled).to.equal(false);
        expect(dom.batchBacktestSp500TopMeanCopyOpenScoreBtn.disabled).to.equal(false);
        expect(dom.batchBacktestSp500TopMeanDownloadBtn.disabled).to.equal(false);
    });

    it("clears the stale TOP_MEAN Stop state immediately after a server restart", async () => {
        const dom = setupForAnalysis();
        svc().activeTopMeanRunId = "lost-after-restart";
        persistTopMeanRunForTest("lost-after-restart");
        dom.batchBacktestSp500TopMeanRunBtn.style.display = "none";
        dom.batchBacktestSp500TopMeanStopBtn.style.display = "block";

        await withMockFetch(() => ({
            ok: false,
            status: 404,
            text: JSON.stringify({ ok: false, error: "Run not found" }),
        }), async () => {
            await svc().reattachToInProgressTopMeanRun();
        });

        expect(svc().activeTopMeanRunId).to.equal(null);
        expect(JSON.parse((globalThis as any).localStorage.getItem("sp500_top_mean_active_run_id")).data).to.equal(null);
        expect(dom.batchBacktestSp500TopMeanRunBtn.style.display).to.equal("block");
        expect(dom.batchBacktestSp500TopMeanStopBtn.style.display).to.equal("none");
        expect(dom.batchBacktestSp500TopMeanProgressText.textContent).to.include("server restarted");
    });

    it("clears local TOP_MEAN state when Stop confirms no matching server run", async () => {
        const dom = setupForAnalysis();
        svc().activeTopMeanRunId = "stale-stop-run";
        persistTopMeanRunForTest("stale-stop-run");
        dom.batchBacktestSp500TopMeanRunBtn.style.display = "none";
        dom.batchBacktestSp500TopMeanStopBtn.style.display = "block";

        await withMockFetch(() => ({
            ok: true,
            status: 200,
            text: JSON.stringify({ ok: true, stopped: false }),
        }), async () => {
            await svc().stopSp500TopMeanCoordinator();
        });

        expect(svc().activeTopMeanRunId).to.equal(null);
        expect(JSON.parse((globalThis as any).localStorage.getItem("sp500_top_mean_active_run_id")).data).to.equal(null);
        expect(dom.batchBacktestSp500TopMeanRunBtn.style.display).to.equal("block");
        expect(dom.batchBacktestSp500TopMeanStopBtn.style.display).to.equal("none");
    });

    it("renders the algorithmic trade decision and single-configuration assumption", () => {
        const dom = setupForAnalysis();
        const result = topMeanResultFixture();
        result.currentSnapshot = {
            snapshot: {
                asOf: 1_700_000_000,
                artifacts: 10,
                openPositions: 4,
                candidates: [{ asset: "AAA", score: 3, activePairs: 4, mean: 0.75 }],
                winners: [{ asset: "AAA", score: 3, activePairs: 4, mean: 0.75 }],
                reason: "ok",
            },
            stats: {
                artifactsProcessed: 10,
                openPositions: 4,
                positiveCandidates: 1,
                staleEndpoints: 0,
                missingEndpoints: 0,
                malformedArtifacts: 0,
                tieCount: 0,
                durationMs: 1,
            },
            decision: {
                status: "LONG_NEXT_BAR",
                reason: "latest_decision_event",
                asset: "AAA",
                decisionTime: 1_700_000_000,
                candidates: [{ asset: "AAA", score: 3, activePairs: 4, mean: 0.75 }],
                winners: [{ asset: "AAA", score: 3, activePairs: 4, mean: 0.75 }],
                entryPairs: 2,
                entryRule: "first_target_bar_strictly_after_decision",
                researchNotionalUsd: 1000,
                researchHoldBars: 24,
                researchExitRule: "24th_bar_close",
                verification: "algorithmic_endpoint_check",
                configurationAssumption: "one_strategy_configuration",
            },
        };
        result.latestSelections = {
            decisionTime: 1_700_000_000,
            ema200ObservedAssets: 3,
            ema200AssetsAbove: 2,
            ema200Breadth: 2 / 3,
            regime: "bullish",
            selections: [
                {
                    selector: "TOP_RAW",
                    direction: "long",
                    asset: "BBB",
                    tiedAssets: [],
                    score: 4,
                    mean: 0.5,
                    activePairs: 8,
                    eligibleCandidates: 3,
                    reason: "selected",
                },
                {
                    selector: "REGIME_MEAN",
                    direction: "long",
                    asset: null,
                    tiedAssets: ["AAA", "CCC"],
                    score: null,
                    mean: null,
                    activePairs: null,
                    eligibleCandidates: 2,
                    reason: "tied",
                },
                {
                    selector: "MAX_SUBMITTED",
                    direction: "long",
                    asset: "CCC",
                    tiedAssets: [],
                    score: 2,
                    mean: 0.25,
                    activePairs: 8,
                    eligibleCandidates: 3,
                    reason: "selected",
                },
            ],
        };

        svc().renderTopMeanResults(dom, result);

        expect(dom.batchBacktestSp500TopMeanResults.innerHTML).to.include("ALGORITHMIC TRADE DECISION");
        expect(dom.batchBacktestSp500TopMeanResults.innerHTML).to.include("LONG AAA");
        expect(dom.batchBacktestSp500TopMeanResults.innerHTML).to.include("one selected strategy configuration only");
        expect(dom.batchBacktestSp500TopMeanResults.innerHTML).to.include("Latest OPEN_SCORE Selector Picks");
        expect(dom.batchBacktestSp500TopMeanResults.innerHTML).to.include("TOP_RAW");
        expect(dom.batchBacktestSp500TopMeanResults.innerHTML).to.include("MAX_SUBMITTED");
        expect(dom.batchBacktestSp500TopMeanResults.innerHTML).to.include("TIE / SKIP: AAA, CCC");
        const copiedLines = svc().formatLatestOpenScoreSelectionLines(result.latestSelections);
        expect(copiedLines).to.include(
            "REGIME_MEAN NOW | direction=LONG | asset=TIE_SKIP[AAA,CCC] | mean=n/a | score=n/a | activePairs=n/a | pool=2 | reason=tied",
        );
        expect(copiedLines).to.include(
            "MAX_SUBMITTED NOW | direction=LONG | asset=CCC | mean=0.25 | score=2 | activePairs=8 | pool=3 | reason=selected",
        );
    });

    it("keeps ownership after a rejected Stop and clears it after an accepted Stop", async () => {
        setupForAnalysis();
        svc().activeServerRunId = "batch-owned";
        svc().persistActiveServerRun("batch-owned");
        const bodies: Array<{ runId?: string }> = [];
        let accepted = false;

        await withMockFetch((_url, init) => {
            bodies.push(JSON.parse(String(init?.body ?? "{}")));
            return { ok: true, status: 200, text: JSON.stringify({ ok: accepted, stopped: accepted }) };
        }, async () => {
            await svc().stopServerWork();
            expect(svc().activeServerRunId).to.equal("batch-owned");
            accepted = true;
            await svc().stopServerWork();
        });

        expect(bodies).to.deep.equal([{ runId: "batch-owned" }, { runId: "batch-owned" }]);
        expect(svc().activeServerRunId).to.equal(null);
    });

    it("surfaces a terminal server failure when reattaching after reload", async () => {
        const dom = setupForAnalysis();
        svc().activeServerRunId = "batch-fatal";
        svc().persistActiveServerRun("batch-fatal");
        svc().lastResults = [];

        await withMockFetch(() => ({
            ok: true,
            status: 200,
            text: JSON.stringify({
                running: false,
                lastRun: {
                    runId: "batch-fatal",
                    rowCount: 0,
                    hasArtifacts: false,
                    fingerprint: null,
                    phase: "fatal",
                    summary: "Batch failed.",
                    error: "worker exploded",
                },
            }),
        }), async () => {
            await svc().reattachToInProgressServerRun();
        });

        expect(dom.batchBacktestStatus.textContent).to.include("worker exploded");
        expect(svc().activeServerRunId).to.equal("batch-fatal");
        expect(svc().loadPersistedActiveServerRun()).to.equal(null);
    });

    it("disables OPEN_SCORE USD after clearStaleResults (audit artifact-action-gating finding)", () => {
        const dom = setupForAnalysis();
        svc().serverHasArtifacts = true;
        svc().lastRunFingerprint = "fp-test";
        svc().updateArtifactActionButtons(dom);
        expect(dom.batchBacktestOpenScoreUsdBtn.disabled, "OPEN_SCORE USD enabled before clear").to.equal(false);
        svc().clearStaleResults(dom);
        expect(dom.batchBacktestOpenScoreUsdBtn.disabled, "OPEN_SCORE USD disabled after clear").to.equal(true);
    });

    it("rejects a second runBatch synchronously while one is in flight (audit single-flight finding)", async () => {
        // Intent being locked (AGENTS.md rule 8): the browser-side runInFlight
        // guard fires BEFORE any await and before the Run button is disabled,
        // so a rapid double-click on Run cannot stack two runBatch()
        // invocations. The button-disable further down is the visual signal;
        // this guard is the correctness gate.
        //
        // Directly flip runInFlight on (as if a run were in progress), call
        // runBatch, and assert it short-circuited without touching fetch.
        const dom = setupForAnalysis();
        svc().runInFlight = true;
        let fetchCalled = false;
        await withMockFetch(() => {
            fetchCalled = true;
            return { ok: true, status: 200, text: "{}" };
        }, async () => {
            await svc().runBatch();
        });
        expect(fetchCalled, "second runBatch must short-circuit before fetch").to.equal(false);
        expect(dom.batchBacktestStatus.textContent).to.include("already running");
        // Reset for the rest of the suite.
        svc().runInFlight = false;
    });

    it("reconcileStatusRows dedupes a streamed prefix + a recovery page (audit status-row-recovery finding)", () => {
        // Intent being locked (AGENTS.md rule 8): the shared helper is the
        // single source of truth for accepting status rows. The previous
        // bespoke code in recoverCompletedServerRun appended the WHOLE first
        // recovery page to the DOM while only pushing the missing prefix into
        // lastResults, producing duplicate DOM rows after a stream
        // interruption. The helper MUST dedupe by absolute index against
        // lastResults on both the data array and the DOM append.
        const dom = setupForAnalysis();
        svc().lastResults = [];
        // Simulate the streamed prefix: 3 rows already in lastResults.
        const prefix = [
            { symbol: "AAA", status: "profitable", barCount: 100 },
            { symbol: "BBB", status: "profitable", barCount: 100 },
            { symbol: "CCC", status: "profitable", barCount: 100 },
        ] as any;
        for (const r of prefix) svc().lastResults.push(r);
        // Recovery page: same 3 rows + 2 new ones. The helper MUST skip the
        // first 3 (already seen) and only accept the last 2.
        const recovery = [
            ...prefix,
            { symbol: "DDD", status: "profitable", barCount: 100 },
            { symbol: "EEE", status: "profitable", barCount: 100 },
        ] as any;
        const accepted = svc().reconcileStatusRows(dom, recovery, 0);
        expect(accepted.length, "only the 2 unseen rows are accepted").to.equal(2);
        expect(accepted.map((r: any) => r.symbol)).to.deep.equal(["DDD", "EEE"]);
        expect(svc().lastResults.length, "lastResults has 5 rows total").to.equal(5);
    });

    it("reconcileStatusRows clears a truncated-suffix restore before rebuilding (audit Finding 5 dedupe fix)", () => {
        // Intent being locked (AGENTS.md rule 8): a truncated persisted snapshot
        // holds the most-recent N rows (a SUFFIX), not a prefix starting at 0.
        // reconcileStatusRows dedupes by absolute index assuming lastResults is
        // a prefix, so a truncated suffix would incorrectly skip rows 0..N-1
        // and produce a jumbled table on the next reattach. The fix: the first
        // reconcile call after a truncated restore clears lastResults + DOM
        // before accepting the incoming page, so the reattach rebuilds cleanly.
        const dom = setupForAnalysis();
        // Simulate a truncated restore: lastResults holds rows 8,9 of a 10-row
        // run (a suffix), flagged as truncated.
        svc().lastResults = [
            { symbol: "ROW_8", status: "profitable", barCount: 100 },
            { symbol: "ROW_9", status: "profitable", barCount: 100 },
        ] as any;
        svc().appendedCount = 2;
        (svc() as any).lastResultsIsTruncatedSuffix = true;
        // A reattach now delivers the TRUE first page (rows 0,1,2 — a prefix).
        // Without the fix, the dedupe would skip absoluteIndex 0,1 (thinking
        // they're already held) and only accept index 2+, producing gaps.
        const firstPage = [
            { symbol: "ROW_0", status: "profitable", barCount: 100 },
            { symbol: "ROW_1", status: "profitable", barCount: 100 },
            { symbol: "ROW_2", status: "profitable", barCount: 100 },
        ] as any;
        const accepted = svc().reconcileStatusRows(dom, firstPage, 0);
        // The fix cleared the truncated suffix, so ALL 3 prefix rows are
        // accepted (not deduped against the stale suffix).
        expect(accepted.length, "truncated suffix cleared, all prefix rows accepted").to.equal(3);
        expect(accepted.map((r: any) => r.symbol)).to.deep.equal(["ROW_0", "ROW_1", "ROW_2"]);
        // The stale suffix rows are gone — lastResults starts fresh from the
        // incoming page (no jumbled ROW_8/ROW_9 lingering before ROW_0).
        expect(svc().lastResults.map((r: any) => r.symbol)).to.deep.equal(["ROW_0", "ROW_1", "ROW_2"]);
        expect((svc() as any).lastResultsIsTruncatedSuffix, "flag cleared after reconcile").to.equal(false);
    });

    it("a terminal reattach drains lastRun.rows so a reloaded tab recovers the result table (audit status-row-recovery finding)", async () => {
        // Intent being locked (AGENTS.md rule 8): a tab that reloads AFTER a
        // server-side run completed must recover the result rows from
        // `/status.lastRun`. Previously the terminal branch adopted
        // hasArtifacts but ignored lastRun.rows entirely, leaving the tab
        // showing Mine availability with no results and no Copy output. The
        // fix routes terminal rows through the shared reconcile helper.
        const dom = setupForAnalysis();
        svc().lastResults = [];
        svc().activeServerRunId = "batch-recovered";
        svc().persistActiveServerRun("batch-recovered");

        const rows = [
            { symbol: "AAA+BBB", status: "profitable", barCount: 100 },
            { symbol: "CCC+DDD", status: "profitable", barCount: 100 },
        ];
        await withMockFetch(() => ({
            ok: true,
            status: 200,
            text: JSON.stringify({
                running: false,
                runMismatch: false,
                lastRun: {
                    rowCount: 2,
                    hasArtifacts: true,
                    fingerprint: "fp-test",
                    interval: "5m",
                    strategyKey: "test",
                    runId: "batch-recovered",
                    phase: "done",
                    summary: "Done — 2 pairs",
                    rows,
                    rowOffset: 0,
                    nextOffset: null,
                },
            }),
        }), async () => {
            await svc().reattachToInProgressServerRun();
        });

        expect(svc().lastResults.length, "terminal reattach drains lastRun.rows").to.equal(2);
        expect(svc().lastResults.map((r: any) => r.symbol)).to.deep.equal(["AAA+BBB", "CCC+DDD"]);
        expect(dom.batchBacktestStatus.textContent).to.include("Done");
    });
});

describe("BatchBacktestService Balanced Generator lifecycle", () => {
    it("Generate-and-Apply writes the pair list to the textarea and remembers provenance", async () => {
        const dom = setupForAnalysis();
        dom.batchBacktestBalancedAssets.value = "BTC\nETH\nXRP";
        dom.batchBacktestBalancedMaxPairs.value = "5";
        dom.batchBacktestBalancedSeed.value = "1";

        // Click through the bound handler.
        const clicked = dom.batchBacktestBalancedGenerateBtn.click();
        expect(clicked, "Generate button must be wired").to.equal(true);
        // The generator is synchronous internally; await a microtask so the
        // async click handler finishes.
        await new Promise((r) => setTimeout(r, 0));

        // Textarea now contains the generated pair list.
        const textareaValue = (dom.batchBacktestSymbols as any).value as string;
        expect(textareaValue.length, "textarea was written").to.be.greaterThan(0);
        // Provenance is remembered.
        const provenance = svc().getActivePairListProvenance();
        expect(provenance, "provenance is remembered after apply").to.not.equal(null);
        if (provenance) {
            expect(provenance.schema).to.equal("batch.pair_list.v1");
            expect(provenance.assetCount).to.equal(3);
        }
    });

    it("Copy Generated is enabled after a successful generation", async () => {
        const dom = setupForAnalysis();
        dom.batchBacktestBalancedAssets.value = "BTC\nETH\nXRP\nADA";
        dom.batchBacktestBalancedMaxPairs.value = "10";
        dom.batchBacktestBalancedSeed.value = "1";

        dom.batchBacktestBalancedGenerateBtn.click();
        await new Promise((r) => setTimeout(r, 0));

        expect(dom.batchBacktestBalancedCopyBtn.disabled, "Copy enabled after success").to.equal(false);
    });

    it("failed generation leaves the textarea and provenance untouched", async () => {
        const dom = setupForAnalysis();
        // Pre-populate the textarea so we can detect it is NOT overwritten.
        (dom.batchBacktestSymbols as any).value = "PREEXISTING+PAIR";
        dom.batchBacktestBalancedAssets.value = "ONLY_ONE_ASSET";
        dom.batchBacktestBalancedMaxPairs.value = "10";
        dom.batchBacktestBalancedSeed.value = "1";

        dom.batchBacktestBalancedGenerateBtn.click();
        await new Promise((r) => setTimeout(r, 0));

        // Textarea untouched.
        expect((dom.batchBacktestSymbols as any).value).to.equal("PREEXISTING+PAIR");
        // Provenance untouched.
        expect(svc().getActivePairListProvenance(), "no provenance on failure").to.equal(null);
        // Summary shows the error.
        expect(dom.batchBacktestBalancedSummary.textContent).to.match(/at least two/i);
    });

    it("rejects Generate while an analysis is in flight and does not mutate the textarea", async () => {
        const dom = setupForAnalysis();
        (dom.batchBacktestSymbols as any).value = "PREEXISTING+PAIR";
        dom.batchBacktestBalancedAssets.value = "BTC\nETH";
        // Simulate an in-flight analysis.
        svc().analysisInFlight = true;

        dom.batchBacktestBalancedGenerateBtn.click();
        await new Promise((r) => setTimeout(r, 0));

        expect((dom.batchBacktestSymbols as any).value, "textarea untouched while busy").to.equal("PREEXISTING+PAIR");
        expect(dom.batchBacktestBalancedSummary.textContent).to.match(/unavailable|run|analysis/i);
        expect(svc().getActivePairListProvenance()).to.equal(null);
    });

    it("rejects Generate while a Batch run is in flight", async () => {
        const dom = setupForAnalysis();
        (dom.batchBacktestSymbols as any).value = "PREEXISTING+PAIR";
        dom.batchBacktestBalancedAssets.value = "BTC\nETH";
        svc().runInFlight = true;

        dom.batchBacktestBalancedGenerateBtn.click();
        await new Promise((r) => setTimeout(r, 0));

        expect((dom.batchBacktestSymbols as any).value).to.equal("PREEXISTING+PAIR");
        expect(svc().getActivePairListProvenance()).to.equal(null);
    });

    it("clears remembered provenance when the textarea is manually edited", async () => {
        const dom = setupForAnalysis();
        dom.batchBacktestBalancedAssets.value = "BTC\nETH\nXRP";
        dom.batchBacktestBalancedMaxPairs.value = "5";
        dom.batchBacktestBalancedSeed.value = "1";

        dom.batchBacktestBalancedGenerateBtn.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(svc().getActivePairListProvenance(), "provenance set after apply").to.not.equal(null);

        // Simulate a manual edit: change the textarea value AND dispatch the
        // input event so the bound handler runs clearActivePairListProvenanceIfStale.
        const original = (dom.batchBacktestSymbols as any).value as string;
        (dom.batchBacktestSymbols as any).value = original + "\nMANUAL+EDIT";
        dom.batchBacktestSymbols.dispatchEvent({ type: "input" } as any);

        expect(svc().getActivePairListProvenance(), "provenance cleared after manual edit").to.equal(null);
    });
});
