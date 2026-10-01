/** Browser-visible analysis lifecycle regressions not covered by plugin specs. */
import { expect } from "chai";
import { describe, it, before, after, beforeEach } from "node:test";
import {
    createBatchBacktestService,
    formatTopMeanCompletionMessage,
    type BatchBacktestService,
} from "../lib/batch-backtest/batch-backtest-service";
import type { BatchBacktestDom } from "../lib/batch-backtest/batch-backtest-dom";
import { BATCH_BACKTEST_REQUIRED_IDS } from "../lib/batch-backtest/batch-backtest-dom";
import { state } from "../lib/state";
import { backtestService } from "../lib/backtest-service";
import {
    readTopMeanActiveRun,
    readTopMeanReplayMode,
    persistTopMeanReplayMode,
    readLatestTopMeanResult,
    persistLatestTopMeanResult,
    TOP_MEAN_LATEST_RESULT_STORAGE,
} from "../lib/batch-backtest/browser/batch-browser-store";
import {
    createFakeBatchBacktestDom,
    createFakeBatchElement,
} from "./helpers/fake-batch-backtest-dom";
import { registerLoadedBuiltInStrategy, unregisterLoadedBuiltInStrategy } from "../lib/strategies/built-in-catalog";
import { strategyRegistry } from "../strategyRegistry";

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
    s.batchRun.setServerHasArtifacts(true);
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
    s.topMean.setActiveTopMeanRunId(null);
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
        svc().topMean.recordTopMeanDiagnostic("run.start", { workerCount: 4 });

        expect(svc().topMean.buildTopMeanOpenScoreText()).to.equal(result.reportLines.join("\n"));
        expect(svc().topMean.buildTopMeanOpenScoreText()).to.not.include("workerCount");
        expect(svc().topMean.buildTopMeanDiagnosticText()).to.include("workerCount");
    });

    it("shows per-event OPEN_SCORE details without adding them to copied reports", () => {
        const dom = setupForAnalysis();
        const result = topMeanResultFixture();
        result.complete = false;
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

        const copied = svc().topMean.buildTopMeanOpenScoreText();
        expect(copied).to.equal("OPEN_SCORE USD | SUMMARY ONLY");
        expect(copied).to.not.include("TOP_MEAN_ONLY_ASSET");
        expect(copied).to.not.include("MAX_ACTIVE_ONLY_ASSET");
        expect(copied).to.not.include("2023-11-14");
    });

    it("OPEN_SCORE details year filter slices the full-window rows client-side", () => {
        const dom = setupForAnalysis();
        const result = topMeanResultFixture();
        result.reportLines = ["OPEN_SCORE USD | SUMMARY ONLY"];
        result.openScoreEventDetails = [
            {
                decisionTime: Date.UTC(2022, 5, 15) / 1000,
                entryTime: Date.UTC(2022, 5, 15) / 1000 + 3_600,
                exitTime: Date.UTC(2022, 5, 15) / 1000 + 3_600 * 48,
                horizonBars: 48,
                selector: "TOP_MEAN",
                direction: "long",
                asset: "ASSET_2022",
                selectedReturn: 0.1,
                controlReturn: 0.02,
                delta: 0.08,
                eligibleCandidates: 5,
            },
            {
                decisionTime: Date.UTC(2023, 0, 10) / 1000,
                entryTime: Date.UTC(2023, 0, 10) / 1000 + 3_600,
                exitTime: Date.UTC(2023, 0, 10) / 1000 + 3_600 * 48,
                horizonBars: 48,
                selector: "TOP_MEAN",
                direction: "long",
                asset: "ASSET_2023",
                selectedReturn: -0.05,
                controlReturn: 0.01,
                delta: -0.06,
                eligibleCandidates: 5,
            },
        ];
        svc().latestTopMeanResult = result;
        svc().renderTopMeanResults(dom, result);

        // Default (blank year select) keeps the current full-window behaviour.
        svc().toggleSp500TopMeanOpenScoreDetails();
        let html = dom.batchBacktestSp500TopMeanDetails.innerHTML;
        expect(html).to.include("Selected Window");
        expect(html).to.include("ASSET_2022");
        expect(html).to.include("ASSET_2023");
        expect(dom.batchBacktestSp500TopMeanDetailsYear.innerHTML).to.include(">2022</option>");
        expect(dom.batchBacktestSp500TopMeanDetailsYear.innerHTML).to.include(">2023</option>");

        dom.batchBacktestSp500TopMeanDetailsYear.value = "2022";
        dom.batchBacktestSp500TopMeanDetailsYear.dispatchEvent({ type: "change" } as unknown as Event);
        html = dom.batchBacktestSp500TopMeanDetails.innerHTML;
        expect(html).to.include("Selected Window — Calendar Year 2022");
        expect(html).to.include("ASSET_2022");
        expect(html).to.not.include("ASSET_2023");

        dom.batchBacktestSp500TopMeanDetailsYear.value = "";
        dom.batchBacktestSp500TopMeanDetailsYear.dispatchEvent({ type: "change" } as unknown as Event);
        html = dom.batchBacktestSp500TopMeanDetails.innerHTML;
        expect(html).to.include("ASSET_2023");
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

        svc().topMean.persistLatestTopMeanResult(result);

        const stored = [...(globalThis as any).localStorage._store.values()].join("\n");
        expect(stored).to.not.include("DETAIL_ONLY_ASSET");
        expect(stored).to.not.include("ANNUAL_DETAIL_ONLY");
        expect(stored).to.include("annual");
    });

    it("restores the TOP_MEAN diagnostic log after a reload so Copy Diagnostic survives an OOM crash", () => {
        // Intent: the diagnostic ring is the OOM evidence path. When the tab
        // dies, the ring dies with it — the durable log must come back on the
        // next load with the Copy Diagnostic button enabled.
        const dom = setupForAnalysis();
        const dying = svc();
        dying.topMean.setDiagnosticRunId("sp500_top_mean_crashed");
        dying.topMean.recordTopMeanDiagnostic("run.start", { workerCount: 4 });
        dying.topMean.recordTopMeanNdjsonEvent({ type: "preflight", counts: { pairCount: 20000 } });
        dying.topMean.recordTopMeanNdjsonEvent({ type: "done", result: { runId: "sp500_top_mean_crashed" } });
        dying.writeTopMeanDiagnosticLogNow();

        // Simulate the reload: fresh service instance, empty in-memory state.
        currentService.dispose();
        currentService = createBatchBacktestService();
        const fresh = svc();
        fresh.dom = dom;
        fresh.restorePersistedTopMeanDiagnostics();

        expect(fresh.topMean.getDiagnosticRunId()).to.equal("sp500_top_mean_crashed");
        expect(dom.batchBacktestSp500TopMeanCopyDiagnosticBtn.disabled).to.equal(false);
        const text = fresh.topMean.buildTopMeanDiagnosticText();
        expect(text).to.include("sp500_top_mean_crashed");
        expect(text).to.include("ndjson.preflight");
        expect(text).to.include("20000");
        expect(text).to.include("diagnostic.restored_from_previous_session");
    });

    it("records the approximate byte size of every ndjson diagnostic entry", () => {
        // Intent: payload size per event is the primary OOM evidence the user
        // can copy and share; it must be captured at receipt time.
        setupForAnalysis();
        svc().topMean.recordTopMeanNdjsonEvent({ type: "preflight", counts: { pairCount: 20000 } });
        const entry = svc().topMean.getDiagnosticEntries().find(
            (e: any) => e.type === "ndjson.preflight",
        );
        expect(entry, "preflight event must be recorded").to.not.equal(undefined);
        expect(entry.bytes).to.be.a("number");
        expect(entry.bytes).to.be.greaterThan(0);
    });

    it("compacts oversized payloads at record time so the ring, copy, and persist stay small", () => {
        // Intent: a terminal reattach poll carries the whole wire-safe result;
        // recording it verbatim bloated the copied diagnostic to millions of
        // lines AND retained multi-MB duplicates in the ring. The diagnostic
        // evidence is the timeline + byte size + shape, not the payload.
        setupForAnalysis();
        const s = svc();
        s.topMean.recordTopMeanDiagnostic("ndjson.done", {
            result: { runId: "sp500_top_mean_big", blob: "x".repeat(200_000) },
        });

        // The ring entry is compacted to a shape summary, not the payload.
        const entries = s.topMean.getDiagnosticEntries();
        const entry = entries[entries.length - 1];
        expect(entry.data.diagnosticDataTruncated).to.equal(true);
        expect(entry.data.result.runId).to.equal("sp500_top_mean_big");
        expect(JSON.stringify(entry.data).length).to.be.lessThan(2_000);

        // The copied diagnostic stays small.
        const copied = s.topMean.buildTopMeanDiagnosticText();
        expect(copied).to.include("sp500_top_mean_big");
        expect(copied.length).to.be.lessThan(20_000);

        // The persisted copy carries the same compact shape.
        const stored = [...(globalThis as any).localStorage._store.values()].join("\n");
        expect(stored).to.include("diagnosticDataTruncated");
        expect(stored.length).to.be.lessThan(500_000);
    });

    it("keeps small payloads verbatim in diagnostic entries", () => {
        // Intent: compaction must not blur small, high-signal payloads —
        // progress counts, error messages, request options stay readable.
        setupForAnalysis();
        const s = svc();
        s.topMean.recordTopMeanDiagnostic("ndjson.progress", { completed: 1000, total: 20000 });
        const entries = s.topMean.getDiagnosticEntries();
        const entry = entries[entries.length - 1];
        expect(entry.data.completed).to.equal(1000);
        expect(entry.data.total).to.equal(20000);
        expect(entry.data.diagnosticDataTruncated).to.equal(undefined);
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

    it("submits the coordinator's own similar-cap mode and current interval for custom markets", async () => {
        const dom = setupForAnalysis();
        const service = svc();
        dom.batchBacktestSp500TopMeanCapTilt.value = "similarCap2x";
        dom.batchBacktestOpenScoreUsdCapTilt.value = "largeBase2x";
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
        expect(requestBody.capTiltWeight).to.equal("similarCap2x");
        expect(requestBody.pairListText).to.equal("BTCUSDT\nZEC+APT");
        expect(requestBody.saveArchiveLog).to.equal(false);
    });

    it("restores Run and preserves an HTTP 413 without reattaching a rejected TOP_MEAN run", async () => {
        const dom = setupForAnalysis();
        const service = svc();
        service.resolveTopMeanBuiltInStrategy = async () => ({
            strategyKey: "test", strategy: { defaultParams: {} },
        });
        const originalBacktestSettings = backtestService.getBacktestSettings;
        const originalCapitalSettings = backtestService.getCapitalSettings;
        backtestService.getBacktestSettings = () => ({});
        backtestService.getCapitalSettings = () => ({
            initialCapital: 10_000, positionSize: 100, commission: 0,
            sizingMode: "fixed", fixedTradeAmount: 1_000,
        });
        const urls: string[] = [];
        const message = "Request body too large. Limit is 67108864 bytes.";
        try {
            await withMockFetch((url) => {
                urls.push(String(url));
                return { ok: false, status: 413, text: JSON.stringify({ ok: false, error: message }) };
            }, async () => {
                await service.runSp500TopMeanCoordinator();
            });
        } finally {
            backtestService.getBacktestSettings = originalBacktestSettings;
            backtestService.getCapitalSettings = originalCapitalSettings;
        }
        expect(urls).to.deep.equal(["/api/batch-backtest/sp500-top-mean/run"]);
        expect(dom.batchBacktestSp500TopMeanRunBtn.style.display).to.not.equal("none");
        expect(dom.batchBacktestSp500TopMeanStopBtn.style.display).to.equal("none");
        expect(dom.batchBacktestSp500TopMeanProgressText.textContent).to.include(message);
        expect(readTopMeanActiveRun()).to.equal(null);
        expect(service.topMean.buildTopMeanDiagnosticText()).to.not.include("reattach.start");
    });

    it("submits standalone similar-cap mode independently of the coordinator select", async () => {
        const dom = setupForAnalysis();
        dom.batchBacktestOpenScoreUsdCapTilt.value = "similarCap2x";
        dom.batchBacktestSp500TopMeanCapTilt.value = "smallBase2x";
        dom.batchBacktestOpenScoreUsdHorizons.value = "24";
        let requestBody: any = null;
        await withMockFetch((_url, init) => {
            requestBody = JSON.parse(String(init?.body ?? "{}"));
            return { ok: false, status: 400, text: "test stop before server run" };
        }, async () => {
            await svc().runOpenScoreUsdReplay();
        });
        expect(requestBody.capTiltWeight).to.equal("similarCap2x");
    });

    it("submits an explicitly checked archive toggle and does not persist it", async () => {
        const dom = setupForAnalysis();
        dom.batchBacktestSp500TopMeanArchiveToggle.checked = true;
        const service = svc();
        dom.batchBacktestSymbols.value = "BTCUSDT\nZEC+APT";
        state.currentInterval = "15m";
        let requestBody: any = null;
        service.resolveTopMeanBuiltInStrategy = async () => ({
            strategyKey: "test",
            strategy: { defaultParams: {} },
        });
        const originalBacktestSettings = backtestService.getBacktestSettings;
        const originalCapitalSettings = backtestService.getCapitalSettings;
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
                return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }) };
            }, async () => {
                await service.runSp500TopMeanCoordinator();
            });
        } finally {
            backtestService.getBacktestSettings = originalBacktestSettings;
            backtestService.getCapitalSettings = originalCapitalSettings;
        }

        expect(requestBody.saveArchiveLog).to.equal(true);
        expect((globalThis as any).localStorage.getItem("sp500_top_mean_archive_toggle")).to.equal(null);
        expect(createFakeBatchBacktestDom().batchBacktestSp500TopMeanArchiveToggle.checked).to.equal(false);
    });

    it("formats all TOP_MEAN archive completion outcomes after completion", () => {
        const prefix = "TOP_MEAN run completed successfully.";
        expect(formatTopMeanCompletionMessage({ archiveRequested: false, archiveComplete: false }))
            .to.equal(`${prefix} Archive not saved (toggle off).`);
        expect(formatTopMeanCompletionMessage({
            archiveRequested: true,
            archiveComplete: false,
        })).to.equal(`${prefix} Archive not saved (disabled by TOP_MEAN_ARCHIVE_LOG_DIR).`);
        expect(formatTopMeanCompletionMessage({
            archiveRequested: true,
            archiveComplete: true,
            archiveDir: "C:\\archive\\run",
        })).to.equal(`${prefix} Archive saved: C:\\archive\\run.`);
        expect(formatTopMeanCompletionMessage({
            archiveRequested: true,
            archiveComplete: false,
            archiveError: "disk full",
        })).to.equal(`${prefix} Archive save failed: disk full.`);
    });

    it("persists the active run id and restores it after a tab-style reset", () => {
        setupForAnalysis();
        svc().batchRun.persistActiveServerRun("batch-owned");
        svc().activeServerRunId = null;

        expect(svc().loadPersistedActiveServerRun()?.runId).to.equal("batch-owned");
    });

    it("persists replay mode and disables switch-irrelevant controls without changing their values", () => {
        expect(readTopMeanReplayMode()).to.equal("horizon");
        const dom = setupForAnalysis();
        dom.batchBacktestSp500TopMeanHorizons.value = "6,18";
        dom.batchBacktestSp500TopMeanSelectionCooldownEnabled.checked = true;
        dom.batchBacktestSp500TopMeanSelectionCooldownBars.value = "9";
        dom.batchBacktestSp500TopMeanReplayMode.value = "asset_switch";
        dom.batchBacktestSp500TopMeanReplayMode.dispatchEvent(new Event("change"));

        expect(dom.batchBacktestSp500TopMeanHorizons.disabled).to.equal(true);
        expect(dom.batchBacktestSp500TopMeanSelectionCooldownEnabled.disabled).to.equal(true);
        expect(dom.batchBacktestSp500TopMeanSelectionCooldownBars.disabled).to.equal(true);
        expect(dom.batchBacktestSp500TopMeanHorizons.value).to.equal("6,18");
        expect(dom.batchBacktestSp500TopMeanSelectionCooldownEnabled.checked).to.equal(true);
        expect(dom.batchBacktestSp500TopMeanSelectionCooldownBars.value).to.equal("9");
        expect(readTopMeanReplayMode()).to.equal("asset_switch");

        dom.batchBacktestSp500TopMeanReplayMode.value = "horizon";
        dom.batchBacktestSp500TopMeanReplayMode.dispatchEvent(new Event("change"));
        expect(dom.batchBacktestSp500TopMeanHorizons.disabled).to.equal(false);
        expect(dom.batchBacktestSp500TopMeanSelectionCooldownEnabled.disabled).to.equal(false);
        expect(dom.batchBacktestSp500TopMeanSelectionCooldownBars.value).to.equal("9");

        persistTopMeanReplayMode("asset_switch");
        expect(readTopMeanReplayMode()).to.equal("asset_switch");
    });

    it("restores switch results with bounded trade details and rejects unknown result modes", () => {
        const armNames = [
            "topRawProfitNow", "topMeanProfitNow", "topRawProfitNowConf", "topZ",
            "topRaw", "topMean", "topMeanRawUnique", "topRawProfit", "topMeanProfit",
            "botRawProfitNow", "botMeanProfitNow", "botZ", "botRaw", "botMean", "botMeanRawUnique",
        ];
        const arm = {
            status: "complete", enteredCount: 1, completedTrades: 1,
            realizedNetPnl: -1, openPositionNetPnl: null, totalNetPnl: -1,
            partialRealizedNetPnl: -1, completedHoldingDurationSec: 3,
            averageCompletedHoldingDurationSec: 3, totalCosts: 0,
            openPosition: null, pendingOrder: null,
            diagnosticCounts: { missingTarget: 0, invalidTimestamp: 0, invalidPrice: 0, dataGap: 0, staleMark: 0, unvaluedPosition: 0 },
        };
        const trades = [{
            arm: "topMean", asset: "TOP_MEAN_DETAIL", decisionTimeSec: -1,
            entryTimeSec: 0, entryPrice: 100, exitTimeSec: 1,
            exitPrice: 101, holdingDurationSec: 1, netPnl: 1,
            entryCost: 0, exitCost: 0, status: "closed",
        }, ...Array.from({ length: 1_005 }, (_, index) => ({
            arm: "topRaw", asset: `A${index}`, decisionTimeSec: index,
            entryTimeSec: index + 1, entryPrice: 100, exitTimeSec: index + 2,
            exitPrice: 99, holdingDurationSec: 1, netPnl: -1,
            entryCost: 0, exitCost: 0, status: "closed",
        }))];
        const result = {
            ...topMeanResultFixture(),
            replayMode: "asset_switch",
            horizons: [],
            annualReports: [],
            assetSwitch: {
                semanticsVersion: "asset_switch.v1",
                windowStartSec: 0, windowEndSec: 10, independentWindow: false,
                sizing: "fixed_entry_notional_non_compounding", notionalPerEntry: 1_000,
                slippageRate: 0, commissionRate: 0,
                valuation: "last_closed_candle_close_at_or_before_window_end",
                coverage: { requestedAssets: 1, loadedAssets: 1, missingAssets: 0, invalidSeries: 0 },
                arms: Object.fromEntries(armNames.map((name) => [name, arm])),
                trades,
                tradeCount: 1_006,
            },
        } as any;
        persistLatestTopMeanResult(result);
        const restored = readLatestTopMeanResult();
        expect(restored?.replayMode).to.equal("asset_switch");
        expect(restored?.assetSwitch?.trades).to.have.length(21);
        expect(restored?.assetSwitch?.trades?.filter((row) => row.arm === "topRaw")).to.have.length(20);
        expect(restored?.assetSwitch?.trades?.some((row) => row.asset === "TOP_MEAN_DETAIL")).to.equal(true);
        const retainedTopRaw = restored?.assetSwitch?.trades?.filter((row) => row.arm === "topRaw") ?? [];
        expect(retainedTopRaw[retainedTopRaw.length - 1]?.asset).to.equal("A1004", "the most recent full-window rows are retained");
        expect(restored?.assetSwitch?.tradeCount).to.equal(1_006);

        const envelope = JSON.parse((globalThis as any).localStorage.getItem(TOP_MEAN_LATEST_RESULT_STORAGE.key));
        envelope.data.replayMode = "future_mode";
        (globalThis as any).localStorage.setItem(TOP_MEAN_LATEST_RESULT_STORAGE.key, JSON.stringify(envelope));
        expect(readLatestTopMeanResult()).to.equal(null);
    });

    it("keeps multi-year switch snapshots within a small storage budget", () => {
        const armNames = [
            "topRawProfitNow", "topMeanProfitNow", "topRawProfitNowConf", "topZ",
            "topRaw", "topMean", "topMeanRawUnique", "topRawProfit", "topMeanProfit",
            "botRawProfitNow", "botMeanProfitNow", "botZ", "botRaw", "botMean", "botMeanRawUnique",
        ];
        const arms = Object.fromEntries(armNames.map((name) => [name, {
            status: "complete", enteredCount: 1_001, completedTrades: 1_000,
            realizedNetPnl: 100, openPositionNetPnl: 0, totalNetPnl: 100,
            partialRealizedNetPnl: 100, completedHoldingDurationSec: 10_000,
            averageCompletedHoldingDurationSec: 10, totalCosts: 5,
            openPosition: null, pendingOrder: null,
            diagnosticCounts: { missingTarget: 0, invalidTimestamp: 0, invalidPrice: 0, dataGap: 0, staleMark: 0, unvaluedPosition: 0 },
        }]));
        const yearTrades = (year: number) => Array.from({ length: 15_000 }, (_, index) => ({
            arm: armNames[index % armNames.length],
            asset: `ASSET${index % 100}`,
            decisionTimeSec: Math.floor(Date.UTC(year, 0, 1) / 1_000) + index,
            entryTimeSec: Math.floor(Date.UTC(year, 0, 1) / 1_000) + index + 1,
            entryPrice: 100,
            exitTimeSec: Math.floor(Date.UTC(year, 0, 1) / 1_000) + index + 2,
            exitPrice: 101,
            holdingDurationSec: 1,
            netPnl: 10,
            entryCost: 1,
            exitCost: 1,
            status: "closed",
        }));
        const makeSwitch = (year: number) => ({
            semanticsVersion: "asset_switch.v1",
            windowStartSec: Math.floor(Date.UTC(year, 0, 1) / 1_000),
            windowEndSec: Math.floor(Date.UTC(year, 11, 31) / 1_000),
            independentWindow: year !== 2021,
            sizing: "fixed_entry_notional_non_compounding",
            notionalPerEntry: 1_000,
            slippageRate: 0,
            commissionRate: 0,
            valuation: "last_closed_candle_close_at_or_before_window_end",
            coverage: { requestedAssets: 100, loadedAssets: 100, missingAssets: 0, invalidSeries: 0 },
            arms,
            trades: yearTrades(year),
            tradeCount: 15_000,
        });
        const result = {
            ...topMeanResultFixture(),
            replayMode: "asset_switch",
            horizons: [],
            assetSwitch: makeSwitch(2021),
            annualReports: [2022, 2023, 2024, 2025, 2026].map((year) => ({
                year,
                sampleFromSec: Math.floor(Date.UTC(year, 0, 1) / 1_000),
                sampleToSec: Math.floor(Date.UTC(year, 11, 31) / 1_000),
                replayMode: "asset_switch",
                horizons: [],
                assetSwitch: makeSwitch(year),
                warnings: [],
                reportLines: [`annual ${year}`],
            })),
        } as any;

        persistLatestTopMeanResult(result);
        const serialized = (globalThis as any).localStorage.getItem(TOP_MEAN_LATEST_RESULT_STORAGE.key) as string;
        const bytes = new TextEncoder().encode(serialized).byteLength;
        const saved = JSON.parse(serialized).data;
        expect(bytes, "persisted snapshot has room under normal browser storage quotas").to.be.lessThan(256 * 1024);
        expect(saved.assetSwitch.trades).to.have.length(armNames.length * 20);
        for (const annual of saved.annualReports) {
            expect(Object.prototype.hasOwnProperty.call(annual.assetSwitch, "trades"), `${annual.year} stores no trade rows`).to.equal(false);
            expect(annual.assetSwitch.tradeCount, `${annual.year} preserves the full scalar count`).to.equal(15_000);
            expect(annual.assetSwitch.arms.topMean.totalNetPnl).to.equal(100);
        }
        expect(readLatestTopMeanResult()?.annualReports).to.have.length(5);
    });

    it("renders annual switch arms as independent position replays with separate raw snapshot context", () => {
        const dom = setupForAnalysis();
        const arms = [
            "topRawProfitNow", "topMeanProfitNow", "topRawProfitNowConf", "topZ",
            "topRaw", "topMean", "topMeanRawUnique", "topRawProfit", "topMeanProfit",
            "botRawProfitNow", "botMeanProfitNow", "botZ", "botRaw", "botMean", "botMeanRawUnique",
        ];
        const arm = {
            status: "complete", enteredCount: 0, completedTrades: 0,
            realizedNetPnl: 0, openPositionNetPnl: null, totalNetPnl: 0,
            partialRealizedNetPnl: 0, completedHoldingDurationSec: 0,
            averageCompletedHoldingDurationSec: null, totalCosts: 0,
            openPosition: null, pendingOrder: null,
            diagnosticCounts: { missingTarget: 0, invalidTimestamp: 0, invalidPrice: 0, dataGap: 0, staleMark: 0, unvaluedPosition: 0 },
        };
        const makeSwitch = (independentWindow: boolean, net: number) => ({
            semanticsVersion: "asset_switch.v1",
            windowStartSec: 1_735_689_600, windowEndSec: 1_767_225_599,
            independentWindow, sizing: "fixed_entry_notional_non_compounding",
            notionalPerEntry: 1_000, slippageRate: 0, commissionRate: 0,
            valuation: "last_closed_candle_close_at_or_before_window_end",
            coverage: { requestedAssets: 1, loadedAssets: 1, missingAssets: 0, invalidSeries: 0 },
            arms: Object.fromEntries(arms.map((name) => [name, { ...arm, totalNetPnl: net }])),
        });
        const result = {
            ...topMeanResultFixture(),
            replayMode: "asset_switch",
            horizons: [],
            assetSwitch: makeSwitch(false, 3),
            currentSnapshot: {
                snapshot: { asOf: 1, artifacts: 1, openPositions: 0, candidates: [], winners: [], reason: "empty" },
                stats: { artifactsProcessed: 1, openPositions: 0, positiveCandidates: 0, staleEndpoints: 0, missingEndpoints: 0, malformedArtifacts: 0, tieCount: 0, durationMs: 0 },
            },
            annualReports: [{
                year: 2025,
                sampleFromSec: 1_735_689_600,
                sampleToSec: 1_767_225_599,
                replayMode: "asset_switch",
                horizons: [],
                assetSwitch: makeSwitch(true, -2),
                warnings: [],
                reportLines: ["annual independent report"],
            }],
            reportLines: [],
        } as any;
        svc().topMean.renderTopMeanResults(dom, result);
        expect(dom.batchBacktestSp500TopMeanResults.innerHTML).to.include("cross-sectional raw-score view");
        expect(dom.batchBacktestSp500TopMeanResults.innerHTML).to.include("Independent Asset-Switch Calendar-Year Replays");
        expect(dom.batchBacktestSp500TopMeanResults.innerHTML).to.include("Independent 2025 Asset-Switch Replay");
        expect(dom.batchBacktestSp500TopMeanResults.innerHTML).to.include("LOOK-AHEAD RESEARCH");
        expect(dom.batchBacktestSp500TopMeanResults.innerHTML).to.include("−$2.00");
    });

    it("shows full history for a full-history switch run with decisions and entries in the UI and copied output", async () => {
        const dom = setupForAnalysis();
        const arms = [
            "topRawProfitNow", "topMeanProfitNow", "topRawProfitNowConf", "topZ",
            "topRaw", "topMean", "topMeanRawUnique", "topRawProfit", "topMeanProfit",
            "botRawProfitNow", "botMeanProfitNow", "botZ", "botRaw", "botMean", "botMeanRawUnique",
        ];
        const arm = {
            status: "complete", enteredCount: 1, completedTrades: 0,
            realizedNetPnl: null, openPositionNetPnl: 5, totalNetPnl: 5,
            partialRealizedNetPnl: 0, completedHoldingDurationSec: 0,
            averageCompletedHoldingDurationSec: null, totalCosts: 0,
            openPosition: null, pendingOrder: null,
            diagnosticCounts: { missingTarget: 0, invalidTimestamp: 0, invalidPrice: 0, dataGap: 0, staleMark: 0, unvaluedPosition: 0 },
        };
        const windowEndSec = Math.floor(Date.parse("2024-02-03T00:00:00.000Z") / 1_000);
        const result = {
            ...topMeanResultFixture(),
            replayMode: "asset_switch",
            horizons: [],
            assetSwitch: {
                semanticsVersion: "asset_switch.v1",
                decisionCount: 3,
                windowStartSec: null,
                windowEndSec,
                independentWindow: false,
                sizing: "fixed_entry_notional_non_compounding",
                notionalPerEntry: 1_000,
                slippageRate: 0,
                commissionRate: 0,
                valuation: "last_closed_candle_close_at_or_before_window_end",
                coverage: { requestedAssets: 1, loadedAssets: 1, missingAssets: 0, invalidSeries: 0 },
                arms: Object.fromEntries(arms.map((name) => [name, arm])),
                trades: [],
                tradeCount: 1,
            },
            reportLines: [],
        } as any;
        svc().topMean.latestTopMeanResult = result;
        svc().topMean.renderTopMeanResults(dom, result);
        expect(dom.batchBacktestSp500TopMeanResults.innerHTML).to.include("Full history through 2024-02-03");
        expect(dom.batchBacktestSp500TopMeanResults.innerHTML).to.not.include("No decision events");

        const priorNavigator = (globalThis as any).navigator;
        let copiedText = "";
        Object.defineProperty(globalThis, "navigator", {
            configurable: true,
            value: { clipboard: { writeText: async (text: string) => { copiedText = text; } } },
        });
        try {
            await svc().topMean.copySp500TopMeanResults();
        } finally {
            if (priorNavigator === undefined) delete (globalThis as any).navigator;
            else Object.defineProperty(globalThis, "navigator", { configurable: true, value: priorNavigator });
        }
        expect(copiedText).to.include("full history through 2024-02-03T00:00:00.000Z");
        expect(copiedText).to.not.include("no decision events");
    });

    it("restores the completed TOP_MEAN Coordinator result after a tab-style reset", () => {
        // Intent: a completed coordinator result is user-visible research
        // output, not transient run state. Reloading the Batch tab must restore
        // the rendered result and its Copy/Download actions.
        const dom = setupForAnalysis();
        const result = topMeanResultFixture();
        result.annualReports = [{
            year: 2025,
            sampleFromSec: 1735689600,
            sampleToSec: 1767225599,
            horizons: [],
            warnings: [],
            reportLines: ["RESTORE_MARKER_ANNUAL_REPORT"],
        }];
        svc().topMean.persistLatestTopMeanResult(result);

        svc().latestTopMeanResult = null;
        dom.batchBacktestSp500TopMeanResults.innerHTML = "";
        dom.batchBacktestSp500TopMeanCopyBtn.disabled = true;
        dom.batchBacktestSp500TopMeanCopyOpenScoreBtn.disabled = true;
        dom.batchBacktestSp500TopMeanDownloadBtn.disabled = true;

        svc().loadPersistedLatestTopMeanResult(dom);

        expect(svc().latestTopMeanResult).to.deep.equal({ ...result, replayMode: "horizon" });
        expect(dom.batchBacktestSp500TopMeanResults.innerHTML).to.include("RESTORE_MARKER_ANNUAL_REPORT");
        expect(dom.batchBacktestSp500TopMeanResults.innerHTML).to.not.include("AAA");
        expect(dom.batchBacktestSp500TopMeanCopyBtn.disabled).to.equal(false);
        expect(dom.batchBacktestSp500TopMeanCopyOpenScoreBtn.disabled).to.equal(false);
        expect(dom.batchBacktestSp500TopMeanDownloadBtn.disabled).to.equal(false);
    });

    it("clears the stale TOP_MEAN Stop state immediately after a server restart", async () => {
        const dom = setupForAnalysis();
        svc().topMean.setActiveTopMeanRunId("lost-after-restart");
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

        expect(svc().topMean.getActiveTopMeanRunId()).to.equal(null);
        expect(JSON.parse((globalThis as any).localStorage.getItem("sp500_top_mean_active_run_id")).data).to.equal(null);
        expect(dom.batchBacktestSp500TopMeanRunBtn.style.display).to.equal("block");
        expect(dom.batchBacktestSp500TopMeanStopBtn.style.display).to.equal("none");
        expect(dom.batchBacktestSp500TopMeanProgressText.textContent).to.include("server restarted");
    });

    it("clears local TOP_MEAN state when Stop confirms no matching server run", async () => {
        const dom = setupForAnalysis();
        svc().topMean.setActiveTopMeanRunId("stale-stop-run");
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

        expect(svc().topMean.getActiveTopMeanRunId()).to.equal(null);
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
                    selector: "TOP_MEAN_PROFIT_NOW",
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
                    selector: "TOP_MEAN_RAW_UNIQUE",
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
        // The card shows the in-card dropdown's arm only; the other arms stay
        // in Copy Result so the card cannot grow with the arm count.
        svc().latestTopMeanResult = result;
        dom.batchBacktestSp500TopMeanResults.dispatchEvent({
            type: "change",
            target: { id: "batchBacktestSp500TopMeanLatestArmSelector", value: "TOP_MEAN_PROFIT_NOW" },
        } as unknown as Event);
        expect(dom.batchBacktestSp500TopMeanResults.innerHTML).to.include("TOP_MEAN_PROFIT_NOW");
        expect(dom.batchBacktestSp500TopMeanResults.innerHTML).to.include("TIE / SKIP: AAA, CCC");
        expect(dom.batchBacktestSp500TopMeanResults.innerHTML).to.not.include("<strong>TOP_RAW</strong>");
        expect(dom.batchBacktestSp500TopMeanResults.innerHTML).to.not.include("<strong>TOP_MEAN_RAW_UNIQUE</strong>");
        const copiedLines = svc().topMean.formatLatestOpenScoreSelectionLines(result.latestSelections);
        expect(copiedLines).to.include(
            "TOP_MEAN_PROFIT_NOW NOW | direction=LONG | asset=TIE_SKIP[AAA,CCC] | mean=n/a | score=n/a | activePairs=n/a | pool=2 | reason=tied",
        );
        expect(copiedLines).to.include(
            "TOP_MEAN_RAW_UNIQUE NOW | direction=LONG | asset=CCC | mean=0.25 | score=2 | activePairs=8 | pool=3 | reason=selected",
        );
    });

    it("TIE BREAK alphabetical resolves tied latest picks to the first sorted asset", () => {
        const dom = setupForAnalysis();
        dom.batchBacktestSp500TopMeanTieBreak.value = "alpha";
        const result = topMeanResultFixture();
        result.latestSelections = {
            decisionTime: 1_700_000_000,
            selections: [
                {
                    selector: "TOP_MEAN_PROFIT_NOW",
                    direction: "long",
                    asset: null,
                    tiedAssets: ["CCC", "AAA"],
                    score: null,
                    mean: null,
                    activePairs: null,
                    eligibleCandidates: 2,
                    reason: "tied",
                },
            ],
        };

        svc().renderTopMeanResults(dom, result);

        const html = dom.batchBacktestSp500TopMeanResults.innerHTML;
        expect(html).to.include("Tie-break ALPHABETICAL applied");
        // Alphabetically-first tied asset wins even though CCC was listed first.
        expect(html).to.include(">AAA</td>");
        const copiedLines = svc().topMean.formatLatestOpenScoreSelectionLines(result.latestSelections);
        expect(copiedLines).to.include(
            "TOP_MEAN_PROFIT_NOW NOW | direction=LONG | asset=AAA | mean=n/a | score=n/a | activePairs=n/a | pool=2 | reason=selected",
        );
        // The unresolved copy path must not leak the tie form.
        expect(copiedLines.join("\n")).to.not.include("TIE_SKIP");
    });

    it("Latest OPEN_SCORE arm switch re-renders the selected arm with ranked candidates", () => {
        const dom = setupForAnalysis();
        const result = topMeanResultFixture();
        result.latestSelections = {
            decisionTime: 1_700_000_000,
            selections: [
                {
                    selector: "TOP_MEAN",
                    direction: "long",
                    asset: "AAA",
                    tiedAssets: [],
                    score: 9,
                    mean: 0.75,
                    activePairs: 12,
                    eligibleCandidates: 5,
                    reason: "selected",
                    topCandidates: [
                        { asset: "AAA", score: 9, mean: 0.75, activePairs: 12 },
                        { asset: "BBB", score: 6, mean: 0.5, activePairs: 12 },
                        { asset: "CCC", score: 3, mean: 0.25, activePairs: 12 },
                        { asset: "DDD", score: 2, mean: 0.2, activePairs: 12 },
                        { asset: "EEE", score: 1, mean: 0.1, activePairs: 12 },
                    ],
                },
                {
                    selector: "TOP_RAW",
                    direction: "long",
                    asset: "ZZZ",
                    tiedAssets: [],
                    score: 20,
                    mean: 1.0,
                    activePairs: 5,
                    eligibleCandidates: 5,
                    reason: "selected",
                    topCandidates: [
                        { asset: "ZZZ", score: 20, mean: 1.0, activePairs: 5 },
                        { asset: "AAA", score: 9, mean: 0.75, activePairs: 12 },
                        { asset: "BBB", score: 6, mean: 0.5, activePairs: 12 },
                    ],
                },
            ],
        };
        svc().latestTopMeanResult = result;

        // Per-year performance fixtures in the shared comparison format
        // (full window + two calendar years) for both switchable arms.
        const fullTopMeanComparison = {
            events: 3493, topMean: 0.0165, randomMean: 0.0053, delta: 0.0112,
            topMedian: 0.01, blockMeans: [], ciLower: 0.0013, ciUpper: 0.0228,
            positiveBlocks: 7, totalBlocks: 10,
        };
        result.horizons[0].latestArms = {
            TOP_MEAN: fullTopMeanComparison,
            TOP_RAW: {
                events: 3200, topMean: 0.02, randomMean: 0.004, delta: 0.016,
                topMedian: 0.01, blockMeans: [], ciLower: 0.002, ciUpper: 0.03,
                positiveBlocks: 8, totalBlocks: 10,
            },
        };
        result.annualReports = [
            {
                year: 2021,
                sampleFromSec: 0,
                sampleToSec: 1,
                horizons: [{
                    horizon: 12,
                    events: 505,
                    topMean: fullTopMeanComparison,
                    topAssets: [],
                    latestArms: {
                        TOP_MEAN: {
                            events: 505, topMean: 0.0315, randomMean: 0.0114, delta: 0.02,
                            topMedian: 0.02, blockMeans: [], ciLower: 0.0022, ciUpper: 0.0414,
                            positiveBlocks: 7, totalBlocks: 10,
                        },
                        TOP_RAW: {
                            events: 0, topMean: null, randomMean: null, delta: null,
                            topMedian: null, blockMeans: [], ciLower: null, ciUpper: null,
                            positiveBlocks: 0, totalBlocks: 0,
                        },
                    },
                }],
                warnings: [],
                reportLines: [],
            },
            {
                year: 2022,
                sampleFromSec: 1,
                sampleToSec: 2,
                horizons: [{
                    horizon: 12,
                    events: 586,
                    topMean: fullTopMeanComparison,
                    topAssets: [],
                    latestArms: {
                        TOP_MEAN: {
                            events: 586, topMean: 0.0035, randomMean: 0.0071, delta: -0.0037,
                            topMedian: 0, blockMeans: [], ciLower: -0.0253, ciUpper: 0.0167,
                            positiveBlocks: 5, totalBlocks: 10,
                        },
                    },
                }],
                warnings: [],
                reportLines: [],
            },
        ];

        dom.batchBacktestSp500TopMeanResults.dispatchEvent({
            type: "change",
            target: { id: "batchBacktestSp500TopMeanLatestArmSelector", value: "TOP_MEAN" },
        } as unknown as Event);
        let html = dom.batchBacktestSp500TopMeanResults.innerHTML;
        // Ranked detail is capped at 3 candidates with the pick badged.
        expect(html).to.include("Top 3 candidates at this event");
        expect(html).to.include("AAA</strong><span class=\"batch-top-badge\">PICK</span>");
        expect(html).to.include("+0.500");
        expect(html).to.include("BBB");
        expect(html).to.include("CCC");
        expect(html).to.not.include("DDD");
        expect(html).to.not.include("<strong>TOP_RAW</strong>");
        // Per-year performance lines follow the shared comparison format.
        expect(html).to.include("Performance by year — Horizon 12 bars");
        expect(html).to.include("full: n=3493 top=+1.65% rand=+0.53% deltaMed=+1.12% CI95=[+0.13%,+2.28%] +blocks=7/10");
        expect(html).to.include("2021: n=505 top=+3.15% rand=+1.14% deltaMed=+2.00% CI95=[+0.22%,+4.14%] +blocks=7/10");
        expect(html).to.include("2022: n=586 top=+0.35% rand=+0.71% deltaMed=-0.37% CI95=[-2.53%,+1.67%] +blocks=5/10");

        dom.batchBacktestSp500TopMeanResults.dispatchEvent({
            type: "change",
            target: { id: "batchBacktestSp500TopMeanLatestArmSelector", value: "TOP_RAW" },
        } as unknown as Event);
        html = dom.batchBacktestSp500TopMeanResults.innerHTML;
        expect(html).to.include("<strong>TOP_RAW</strong>");
        expect(html).to.include("ZZZ</strong><span class=\"batch-top-badge\">PICK</span>");
        expect(html).to.not.include("<strong>TOP_MEAN</strong>");
        // The in-card dropdown re-renders with the chosen arm selected.
        expect(html).to.include(`value="TOP_RAW" selected`);
        // Performance lines follow the arm: TOP_RAW's full line replaces
        // TOP_MEAN's, and its zero-event year is omitted rather than zero-filled.
        expect(html).to.include("full: n=3200 top=+2.00% rand=+0.40% deltaMed=+1.60% CI95=[+0.20%,+3.00%] +blocks=8/10");
        expect(html).to.not.include("full: n=3493");
        expect(html).to.not.include("2021: n=505");
    });

    it("Latest OPEN_SCORE card degrades gracefully when a result predates ranked candidates", () => {
        const dom = setupForAnalysis();
        const result = topMeanResultFixture();
        result.latestSelections = {
            decisionTime: 1_700_000_000,
            selections: [{
                selector: "TOP_MEAN",
                direction: "long",
                asset: "AAA",
                tiedAssets: [],
                score: 9,
                mean: 0.75,
                activePairs: 12,
                eligibleCandidates: 2,
                reason: "selected",
            }],
        };
        svc().renderTopMeanResults(dom, result);
        const html = dom.batchBacktestSp500TopMeanResults.innerHTML;
        expect(html).to.include("AAA");
        expect(html).to.include("unavailable for this result");
        expect(html).to.not.include("batch-top-badge");
    });

    it("TIE BREAK random picks a stable tied asset per decision event", () => {
        const dom = setupForAnalysis();
        dom.batchBacktestSp500TopMeanTieBreak.value = "random";
        const result = topMeanResultFixture();
        result.latestSelections = {
            decisionTime: 1_700_000_000,
            selections: [
                {
                    selector: "TOP_MEAN_PROFIT_NOW",
                    direction: "long",
                    asset: null,
                    tiedAssets: ["CCC", "AAA", "BBB"],
                    score: null,
                    mean: null,
                    activePairs: null,
                    eligibleCandidates: 3,
                    reason: "tied",
                },
            ],
        };

        svc().renderTopMeanResults(dom, result);
        const html1 = dom.batchBacktestSp500TopMeanResults.innerHTML;
        // Stable: a second render/copy of the same event picks the same asset.
        svc().renderTopMeanResults(dom, result);
        const html2 = dom.batchBacktestSp500TopMeanResults.innerHTML;
        expect(html1).to.equal(html2);
        expect(html1).to.include("Tie-break RANDOM applied");

        const copied1 = svc().topMean.formatLatestOpenScoreSelectionLines(result.latestSelections);
        const copied2 = svc().topMean.formatLatestOpenScoreSelectionLines(result.latestSelections);
        expect(copied1).to.deep.equal(copied2);
        const pick = copied1.find((l: string) => l.startsWith("TOP_MEAN_PROFIT_NOW NOW"))!;
        expect(pick).to.include("reason=selected");
        // The pick must be one of the tied assets.
        const asset = pick.split("asset=")[1]!.split(" ")[0]!;
        expect(["AAA", "BBB", "CCC"]).to.include(asset);
    });

    it("TIE BREAK resolves a tied current-snapshot decision in the banner", () => {
        const dom = setupForAnalysis();
        dom.batchBacktestSp500TopMeanTieBreak.value = "alpha";
        const result = topMeanResultFixture();
        result.currentSnapshot = {
            snapshot: {
                asOf: 1_699_999_000,
                artifacts: 2,
                openPositions: 2,
                reason: "tied",
                winners: [
                    { asset: "CCC", mean: 1, score: "2", activePairs: "8" },
                    { asset: "AAA", mean: 1, score: "2", activePairs: "8" },
                ],
                candidates: [
                    { asset: "CCC", mean: 1, score: "2", activePairs: "8" },
                    { asset: "AAA", mean: 1, score: "2", activePairs: "8" },
                ],
                decisionTime: 1_700_000_000,
                entryPairs: 2,
            },
            stats: {},
            decision: {
                status: "NO_TRADE",
                reason: "tied",
                asset: null,
                decisionTime: 1_700_000_000,
                candidates: [],
                winners: [],
                entryPairs: 2,
                entryRule: "first_target_bar_strictly_after_decision",
                researchNotionalUsd: 1000,
                researchHoldBars: 24,
                researchExitRule: "24th_bar_close",
                verification: "algorithmic_endpoint_check",
                configurationAssumption: "one_strategy_configuration",
            },
        } as any;

        svc().renderTopMeanResults(dom, result);

        const html = dom.batchBacktestSp500TopMeanResults.innerHTML;
        // decisionTime (1_700_000_000) >= asOf (1_699_999_000): window open,
        // so the alphabetical tie-break (AAA) becomes a LONG trade decision.
        expect(html).to.include("ALGORITHMIC TRADE DECISION — LONG AAA");
        expect(html).to.include("Current Pick (tie-break)");
        expect(html).to.include("Tie-break ALPHABETICAL applied");
    });

    it("shows the latest TOP_MEAN selection while its horizon is ongoing", () => {
        const dom = setupForAnalysis();
        const result = topMeanResultFixture();
        const decisionTime = Math.floor(Date.parse("2026-08-21T16:00:00.000Z") / 1000);
        result.annualReports = [{
            year: 2026,
            sampleFromSec: Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000),
            sampleToSec: Math.floor(Date.parse("2026-12-31T23:59:59.000Z") / 1000),
            horizons: [],
            warnings: [],
            reportLines: ["annual"],
            eventDetails: [{
                decisionTime: decisionTime - 7 * 24 * 3600,
                entryTime: decisionTime - 6 * 24 * 3600,
                exitTime: decisionTime,
                horizonBars: 12,
                selector: "TOP_MEAN",
                direction: "long",
                asset: "AMD",
                selectedReturn: -0.0326,
                controlReturn: -0.0169,
                delta: -0.0157,
                eligibleCandidates: 44,
            }],
        }];
        result.latestSelections = {
            decisionTime,
            selections: [{
                selector: "TOP_MEAN",
                direction: "long",
                asset: "MU",
                tiedAssets: [],
                score: 18,
                mean: 0.9,
                activePairs: 20,
                eligibleCandidates: 47,
                reason: "selected",
            }],
        };

        svc().latestTopMeanResult = result;
        svc().renderTopMeanResults(dom, result);
        svc().toggleSp500TopMeanOpenScoreDetails();

        const details = dom.batchBacktestSp500TopMeanDetails.innerHTML;
        expect(details).to.include("Calendar Year 2026 | 2 selector rows");
        expect(details).to.include("2026-08-21 16:00:00");
        expect(details).to.include("MU");
        expect(details).to.include("NEXT BAR");
        expect(details).to.include("ONGOING");
        expect(details).to.include("n/a");
        expect(details).to.include("AMD");
    });

    it("shows every ongoing TOP_MEAN selection between the last completed row and the latest data", () => {
        const dom = setupForAnalysis();
        const result = topMeanResultFixture();
        const decisionTimes = [
            Math.floor(Date.parse("2026-08-14T12:00:00.000Z") / 1000),
            Math.floor(Date.parse("2026-08-17T12:00:00.000Z") / 1000),
            Math.floor(Date.parse("2026-08-21T16:00:00.000Z") / 1000),
        ];
        result.latestSelections = null;
        result.ongoingEventDetails = [
            { decisionTime: decisionTimes[0], horizonBars: 12, selector: "TOP_MEAN", direction: "long", asset: "AMD", eligibleCandidates: 44 },
            { decisionTime: decisionTimes[1], horizonBars: 12, selector: "TOP_MEAN", direction: "long", asset: "AMD", eligibleCandidates: 45 },
            { decisionTime: decisionTimes[2], horizonBars: 12, selector: "TOP_MEAN", direction: "long", asset: "MU", eligibleCandidates: 47 },
            { decisionTime: decisionTimes[2], horizonBars: 24, selector: "TOP_MEAN", direction: "long", asset: "MU", eligibleCandidates: 47 },
        ];

        svc().latestTopMeanResult = result;
        svc().renderTopMeanResults(dom, result);
        svc().toggleSp500TopMeanOpenScoreDetails();

        const details = dom.batchBacktestSp500TopMeanDetails.innerHTML;
        expect(details).to.include("Selected Window | 4 selector rows");
        expect(details).to.include("2026-08-14 12:00:00");
        expect(details).to.include("2026-08-17 12:00:00");
        expect(details).to.include("2026-08-21 16:00:00");
        expect(details).to.include("AMD");
        expect(details).to.include("MU");
        expect(details.indexOf("2026-08-14 12:00:00")).to.be.lessThan(details.indexOf("2026-08-17 12:00:00"));
        expect(details.indexOf("2026-08-17 12:00:00")).to.be.lessThan(details.indexOf("2026-08-21 16:00:00"));
    });

    it("keeps ownership after a rejected Stop and clears it after an accepted Stop", async () => {
        setupForAnalysis();
        svc().activeServerRunId = "batch-owned";
        svc().batchRun.persistActiveServerRun("batch-owned");
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
        svc().batchRun.persistActiveServerRun("batch-fatal");
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
        svc().batchRun.setServerHasArtifacts(true);
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
        const accepted = svc().batchRun.reconcileStatusRows(dom, recovery, 0);
        expect(accepted.length, "only the 2 unseen rows are accepted").to.equal(2);
        expect(accepted.map((r: any) => r.symbol)).to.deep.equal(["DDD", "EEE"]);
        expect(svc().lastResults.length, "lastResults has 5 rows total").to.equal(5);
    });

    it("drains a page whose continuation starts exactly after the current page", async () => {
        const dom = setupForAnalysis();
        const firstPage = [
            { symbol: "ROW_0", status: "profitable", barCount: 100 },
            { symbol: "ROW_1", status: "profitable", barCount: 100 },
        ] as any;
        const secondPage = [
            { symbol: "ROW_2", status: "profitable", barCount: 100 },
            { symbol: "ROW_3", status: "profitable", barCount: 100 },
        ] as any;
        let pageRequests = 0;

        await withMockFetch((url) => {
            pageRequests += 1;
            expect(url).to.include("after=2");
            return {
                ok: true,
                status: 200,
                text: JSON.stringify({
                    runMismatch: false,
                    lastRun: { rows: secondPage, rowOffset: 2, nextOffset: null },
                }),
            };
        }, async () => {
            await svc().batchRun.drainStatusRows(
                dom,
                { rows: firstPage, rowOffset: 0, nextOffset: 2 },
                "batch-pagination",
                "lastRun",
                { limit: 2, maxRows: 4 },
            );
        });

        expect(pageRequests, "the exact page boundary must not stop the drain").to.equal(1);
        expect(svc().lastResults.map((row: any) => row.symbol)).to.deep.equal([
            "ROW_0", "ROW_1", "ROW_2", "ROW_3",
        ]);
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
        svc().batchRun.persistActiveServerRun("batch-recovered");

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

    it("re-enables Generate & Apply after a Batch run ends", async () => {
        // Regression: the run's finally-block calls setRunBusy(false) while
        // runInFlight is still true, so the balanced-generator buttons were
        // computed from a still-blocked lock and stayed disabled forever
        // after the run. The server run is mocked as an immediate HTTP
        // failure: it unwinds through the same finally-block as a success.
        const dom = setupForAnalysis();
        dom.batchBacktestSymbols.value = "BTCUSDT";
        // Register the current strategy so the run preflight passes and the
        // run reaches the mocked server (the failure path shares the same
        // finally-block restore as a successful run).
        // The settings reader instanceof-checks DOM element globals; the
        // fake-DOM harness has none, so stub the three it touches.
        const savedGlobals = {
            HTMLInputElement: (globalThis as any).HTMLInputElement,
            HTMLSelectElement: (globalThis as any).HTMLSelectElement,
            HTMLTextAreaElement: (globalThis as any).HTMLTextAreaElement,
        };
        class FakeHtmlElement {}
        (globalThis as any).HTMLInputElement = class extends FakeHtmlElement {};
        (globalThis as any).HTMLSelectElement = class extends FakeHtmlElement {};
        (globalThis as any).HTMLTextAreaElement = class extends FakeHtmlElement {};
        // The fake rules <select multiple> has no selectedOptions.
        (dom.batchBacktestTradeGateRules as any).selectedOptions = [];
        const strategyKey = (state as any).currentStrategyKey as string;
        const fakeStrategy = {
            name: "lifecycle-test-strategy",
            defaultParams: {},
            params: [],
            execute: () => ({ signals: [] }),
        } as any;
        registerLoadedBuiltInStrategy(strategyKey, fakeStrategy);
        strategyRegistry.register(strategyKey, fakeStrategy);
        await withMockFetch(() => ({
            ok: false,
            status: 500,
            text: JSON.stringify({ error: "server exploded" }),
        }), async () => {
            await svc().runBatch();
        });
        // Prove the run actually reached the server call and unwound through
        // the run's finally-block (not a preflight short-circuit).
        expect(dom.batchBacktestStatus.textContent, "run reached the mocked server").to.include("server exploded");
        expect(dom.batchBacktestBalancedGenerateBtn.disabled, "Generate & Apply must be clickable after the run ends").to.equal(false);
        strategyRegistry.unregister(strategyKey);
        unregisterLoadedBuiltInStrategy(strategyKey);
        (globalThis as any).HTMLInputElement = savedGlobals.HTMLInputElement;
        (globalThis as any).HTMLSelectElement = savedGlobals.HTMLSelectElement;
        (globalThis as any).HTMLTextAreaElement = savedGlobals.HTMLTextAreaElement;
    });

    it("re-enables Generate & Apply when analysis busy state finishes", async () => {
        // Regression: finishAnalysisBusy hard-disabled both balanced buttons
        // and never restored them after clearing analysisInFlight.
        const dom = setupForAnalysis();
        svc().analysisInFlight = true;
        svc().beginAnalysisBusy(dom);
        expect(dom.batchBacktestBalancedGenerateBtn.disabled, "Generate & Apply disabled while analysis runs").to.equal(true);
        await svc().finishAnalysisBusy(dom);
        expect(dom.batchBacktestBalancedGenerateBtn.disabled, "Generate & Apply must be clickable after analysis ends").to.equal(false);
    });

    it("re-enables Generate & Apply after a Stop request settles", async () => {
        // Regression: the post-Stop busy restore bakes the buttons disabled
        // (runInFlight still held at setRunBusy time) and nothing refreshed
        // them once pendingStopPromise settled.
        const dom = setupForAnalysis();
        svc().runInFlight = true;
        svc().batchRun.setRunBusy(dom, false);
        svc().runInFlight = false;
        expect(dom.batchBacktestBalancedGenerateBtn.disabled, "precondition: buttons baked disabled by the busy restore").to.equal(true);
        await withMockFetch(() => ({
            ok: true,
            status: 200,
            text: JSON.stringify({ ok: true }),
        }), async () => {
            await svc().requestServerStop();
        });
        await new Promise((r) => setTimeout(r, 0));
        expect(dom.batchBacktestBalancedGenerateBtn.disabled, "Generate & Apply must be clickable after Stop settles").to.equal(false);
    });
});

