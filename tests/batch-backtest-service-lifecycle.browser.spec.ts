/** Browser-visible analysis lifecycle regressions not covered by plugin specs. */
import { expect } from "chai";
import { describe, it, before, after } from "node:test";
import { batchBacktestService } from "../lib/batch-backtest/batch-backtest-service";
import type { BatchBacktestDom } from "../lib/batch-backtest/batch-backtest-dom";

function fakeEl(): any {
    const listeners = new Map<string, Array<() => void>>();
    const classes = new Set<string>();
    const el: any = {
        style: { display: "", width: "" },
        disabled: false,
        value: "",
        checked: false,
        textContent: "",
        hidden: false,
        classList: {
            add(...cls: string[]) { for (const c of cls) classes.add(c); },
            remove(...cls: string[]) { for (const c of cls) classes.delete(c); },
            toggle(cls: string, force?: boolean) {
                if (force === undefined) { if (classes.has(cls)) classes.delete(cls); else classes.add(cls); }
                else if (force) classes.add(cls); else classes.delete(cls);
            },
            contains(cls: string) { return classes.has(cls); },
        },
        replaceChildren: () => { el.children = []; },
        appendChild: (child: any) => { el.children = el.children ?? []; el.children.push(child); return child; },
        addEventListener: (type: string, handler: () => void) => {
            const arr = listeners.get(type) ?? [];
            arr.push(handler);
            listeners.set(type, arr);
        },
        removeEventListener: () => {},
        // Drive the REAL handler bound by bindEvents. Returns true iff a
        // handler was actually invoked, so tests can assert wiring.
        click(): boolean {
            const arr = listeners.get("click");
            if (!arr || arr.length === 0) return false;
            for (const handler of arr) handler();
            return true;
        },
        children: [] as any[],
        setAttribute: () => {},
    };
    return el;
}

function fakeDom(): BatchBacktestDom {
    const el = () => fakeEl();
    return {
        batchbacktestTab: el(),
        batchBacktestSymbols: el(),
        batchBacktestSymbolTemplate: el(),
        batchBacktestUseCurrent: el(),
        batchBacktestClear: el(),
        batchBacktestRunBtn: el(),
        batchBacktestStopBtn: el(),
        batchBacktestCopyBtn: el(),
        batchBacktestCopyBenchmarkBtn: el(),
        batchBacktestMineBtn: el(),
        batchBacktestCopyMinerBtn: el(),
        batchBacktestAutoRunStability: el(),
        batchBacktestStabilitySubsetSize: el(),
        batchBacktestStabilityReruns: el(),
        batchBacktestStabilitySeed: el(),
        batchBacktestStabilityMineBtn: el(),
        batchBacktestCopyStabilityBtn: el(),
        batchBacktestPortfolioFitBtn: el(),
        batchBacktestCopyPortfolioFitBtn: el(),
        batchBacktestPortfolioFitSummary: el(),
        batchBacktestPortfolioFitResults: el(),
        batchBacktestMinePredictionBtn: el(),
        batchBacktestCopyMinePredictionBtn: el(),
        batchBacktestMinePredictionSummary: el(),
        batchBacktestMinePredictionFrom: { value: "" },
        batchBacktestMinePredictionTo: { value: "" },
        batchBacktestMinePredictionDirection: { value: "both" },
        batchBacktestMinePredictionSampleBars: { value: "25" },
        batchBacktestMinePredictionSampleStep: { value: "80" },
        batchBacktestMinePredictionHorizons: { value: "12,24,48" },
        batchBacktestProgress: el(),
        batchBacktestProgressFill: el(),
        batchBacktestProgressText: el(),
        batchBacktestStatus: el(),
        batchBacktestSummary: el(),
        batchBacktestSummaryGrid: el(),
        batchBacktestMinerSummary: el(),
        batchBacktestMinerResults: el(),
        batchBacktestResults: el(),
        batchBacktestEmpty: el(),
    } as unknown as BatchBacktestDom;
}

/** Fetch mock responder type. */
type FetchResponse = {
    ok: boolean;
    status: number;
    body?: ReadableStream<Uint8Array> | null;
    text?: string;
};
type FetchResponder = (url: string, init?: any) => FetchResponse | Promise<FetchResponse>;

function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
} {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
}

function ndjsonStream(lines: object[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode(content));
            controller.close();
        },
    });
}

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
    if (savedDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = savedDocument;
    if (savedLocalStorage === undefined) delete (globalThis as any).localStorage;
    else (globalThis as any).localStorage = savedLocalStorage;
    (globalThis as any).fetch = savedFetch;
});

function svc(): any { return batchBacktestService as any; }

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
    (globalThis as any).localStorage._store.clear();
    s.buildCurrentRunFingerprint = () => fingerprint;
    return dom;
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

function successStabilityResponder(): FetchResponder {
    return (url) => {
        if (url.includes("/status")) {
            return { ok: true, status: 200, text: JSON.stringify({ lastRun: { hasArtifacts: true, fingerprint: "fp-test", interval: "5m" } }) };
        }
        if (url.includes("/stability-mine")) {
            return { ok: true, status: 200, body: ndjsonStream([{ type: "done", ok: true, result: { rows: [{ asset: "BTC" }] } }]) };
        }
        return { ok: true, status: 200, text: "{}" };
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BatchBacktestService analysis lifecycle", () => {
    it("persists the active run id and restores it after a tab-style reset", () => {
        setupForAnalysis();
        svc().persistActiveServerRun("batch-owned");
        svc().activeServerRunId = null;

        expect(svc().loadPersistedActiveServerRun()?.runId).to.equal("batch-owned");
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

    it("completes a Stability run successfully and restores the tab to idle", async () => {
        const dom = setupForAnalysis();
        svc().lastStabilityResult = { rows: [{ asset: "BTC" }] };

        await withMockFetch(successStabilityResponder(), async () => {
            await svc().runStabilityMine();
        });

        // SUCCESS state — not just cleanup-after-error. The service must have
        // stored the result and enabled the copy button, and the summary must
        // not show an error.
        expect(svc().lastStabilityResult, "successful Stability result must be stored").to.not.equal(null);
        expect(dom.batchBacktestCopyStabilityBtn.disabled, "copy button must be enabled on success").to.equal(false);
        expect(dom.batchBacktestMinerSummary.textContent, "summary must not show an error").to.not.include("error");
        // Lifecycle cleanup.
        expect((dom.batchbacktestTab as any).classList.contains("is-running"), "is-running must be removed").to.equal(false);
        expect((dom.batchBacktestStopBtn as any).style.display).to.equal("none");
        expect(dom.batchBacktestRunBtn.disabled).to.equal(false);
    });

    it("does not treat a failed status preflight as proof that artifacts were deleted", async () => {
        setupForAnalysis();
        let stabilityPosts = 0;

        await withMockFetch((url) => {
            if (url.includes("/status")) {
                return { ok: false, status: 401, text: "unauthorized" };
            }
            if (url.includes("/stability-mine")) {
                stabilityPosts += 1;
                return { ok: true, status: 200, body: ndjsonStream([{ type: "done", ok: true, result: { rows: [{ asset: "BTC" }] } }]) };
            }
            return { ok: true, status: 200, text: "{}" };
        }, async () => {
            await svc().runStabilityMine();
        });

        expect(stabilityPosts).to.equal(1);
        expect(svc().lastStabilityResult).to.not.equal(null);
    });

    it("only one analysis POST is issued after a rapid double-click", async () => {
        setupForAnalysis();
        svc().lastStabilityResult = { rows: [{ asset: "BTC" }] };
        let stabilityPosts = 0;

        await withMockFetch((url) => {
            if (url.includes("/status")) {
                return { ok: true, status: 200, text: JSON.stringify({ lastRun: { hasArtifacts: true, fingerprint: "fp-test", interval: "5m" } }) };
            }
            if (url.includes("/stability-mine")) {
                stabilityPosts += 1;
                return { ok: true, status: 200, body: ndjsonStream([{ type: "done", ok: true, result: { rows: [{ asset: "BTC" }] } }]) };
            }
            return { ok: true, status: 200, text: "{}" };
        }, async () => {
            const p1 = svc().runStabilityMine();
            const p2 = svc().runStabilityMine();
            await Promise.all([p1, p2]);
        });

        expect(stabilityPosts, "double-click must produce exactly one analysis POST").to.equal(1);
    });

    it("Stop clicked via the REAL handler during preflight prevents the analysis POST", async () => {
        const dom = setupForAnalysis();
        svc().lastStabilityResult = { rows: [{ asset: "BTC" }] };
        let stabilityPosts = 0;

        await withMockFetch((url) => {
            if (url.includes("/status")) {
                return { ok: true, status: 200, text: JSON.stringify({ lastRun: { hasArtifacts: true, fingerprint: "fp-test", interval: "5m" } }) };
            }
            if (url.includes("/stability-mine")) {
                stabilityPosts += 1;
                return { ok: true, status: 200, body: ndjsonStream([{ type: "done", ok: true, result: { rows: [{ asset: "BTC" }] } }]) };
            }
            return { ok: true, status: 200, text: "{}" };
        }, async () => {
            const promise = svc().runStabilityMine();
            const invoked = (dom.batchBacktestStopBtn as any).click();
            expect(invoked, "the real Stop click handler must be bound").to.equal(true);
            await promise;
        });

        expect(stabilityPosts, "Stop during preflight must prevent the analysis POST").to.equal(0);
        expect((dom.batchbacktestTab as any).classList.contains("is-running")).to.equal(false);
    });

    it("issues a distinct second /stop after the POST establishes while the first Stop is still pending", async () => {
        const dom = setupForAnalysis();
        svc().lastStabilityResult = { rows: [{ asset: "BTC" }] };
        let stopPosts = 0;
        let stabilityPosts = 0;
        const postStarted = deferred<void>();
        const postResponse = deferred<FetchResponse>();
        const firstStopResponse = deferred<FetchResponse>();

        await withMockFetch(async (url) => {
            if (url.includes("/status")) {
                return { ok: true, status: 200, text: JSON.stringify({ lastRun: { hasArtifacts: true, fingerprint: "fp-test", interval: "5m" } }) };
            }
            if (url.includes("/stability-mine")) {
                stabilityPosts += 1;
                postStarted.resolve();
                return postResponse.promise;
            }
            if (url.includes("/stop")) {
                stopPosts += 1;
                if (stopPosts === 1) return firstStopResponse.promise;
                return { ok: true, status: 200, text: "{}" };
            }
            return { ok: true, status: 200, text: "{}" };
        }, async () => {
            const promise = svc().runStabilityMine();
            await postStarted.promise;
            (dom.batchBacktestStopBtn as any).click();
            postResponse.resolve({
                ok: true,
                status: 200,
                body: ndjsonStream([{ type: "done", ok: false, cancelled: true, summary: "cancelled" }]),
            });
            while (stopPosts < 2) await Promise.resolve();
            expect(dom.batchBacktestRunBtn.disabled).to.equal(true);
            expect(dom.batchBacktestStabilityMineBtn.disabled).to.equal(true);
            firstStopResponse.resolve({ ok: true, status: 200, text: "{}" });
            await promise;
        });

        expect(stabilityPosts, "the analysis POST must have reached the server").to.equal(1);
        expect(stopPosts, "Stop requested mid-POST must issue an original and post-ownership Stop").to.equal(2);
        expect((dom.batchbacktestTab as any).classList.contains("is-running")).to.equal(false);
    });

    it("disables Mine, Stability, AND Mine Prediction after clearStaleResults (audit Mine-Prediction-gating finding)", () => {
        // Intent being locked (AGENTS.md rule 8): all three artifact-action
        // buttons share the SAME gate. Mine Prediction used to stay enabled
        // after `clearStaleResults` (only Mine and Stability were disabled),
        // letting the user click a stale button and only then see "Run Batch
        // first." The shared `updateArtifactActionButtons` helper is now the
        // single source of truth.
        const dom = setupForAnalysis();
        // Pre-state: artifacts available + fingerprint set, so all buttons
        // would be enabled by the helper.
        svc().serverHasArtifacts = true;
        svc().lastRunFingerprint = "fp-test";
        svc().updateArtifactActionButtons(dom);
        expect(dom.batchBacktestMineBtn.disabled, "Mine enabled before clear").to.equal(false);
        expect(dom.batchBacktestStabilityMineBtn.disabled, "Stability enabled before clear").to.equal(false);
        expect(dom.batchBacktestMinePredictionBtn.disabled, "Mine Prediction enabled before clear").to.equal(false);
        // clearStaleResults flips all three off via the helper.
        svc().clearStaleResults(dom);
        expect(dom.batchBacktestMineBtn.disabled, "Mine disabled after clear").to.equal(true);
        expect(dom.batchBacktestStabilityMineBtn.disabled, "Stability disabled after clear").to.equal(true);
        expect(dom.batchBacktestMinePredictionBtn.disabled, "Mine Prediction disabled after clear (regression)").to.equal(true);
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
