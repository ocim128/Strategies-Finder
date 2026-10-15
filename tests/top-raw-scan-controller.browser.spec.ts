import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TopRawScanController } from "../lib/batch-backtest/browser/top-raw-scan-controller";
import { createFakeBatchBacktestDom } from "./helpers/fake-batch-backtest-dom";
import { readScanActive, readScanPreferences, readScanResult, saveScanActive, saveScanPreferences, saveScanResult, normalizeScanResult } from "../lib/batch-backtest/browser/top-raw-scan-store";
import type { ScanResult } from "../lib/batch-backtest/top-raw-scan-contract";
import { state } from "../lib/state";
import { strategyRegistry } from "../strategyRegistry";
import { registerLoadedBuiltInStrategy, unregisterLoadedBuiltInStrategy } from "../lib/strategies/built-in-catalog";
import { backtestService } from "../lib/backtest-service";
import { paramManager } from "../lib/param-manager";
import { makeCapitalSettings } from "./helpers/backtest-settings-fixtures";
import { withTimeout } from "./helpers/with-timeout";
import { builtInStrategyLoaders } from "../lib/strategies/manifest-loaders";
import { summarizeScanFailures } from "../lib/batch-backtest/top-raw-scan-diagnostics";
import { renderScanResults } from "../lib/batch-backtest/browser/top-raw-scan-results-view";

async function fixture(run: (controller: TopRawScanController, dom: ReturnType<typeof createFakeBatchBacktestDom>) => Promise<void>) {
    const previous = { document: globalThis.document, storage: globalThis.localStorage, fetch: globalThis.fetch, settings: backtestService.getBacktestSettings, capital: backtestService.getCapitalSettings, params: paramManager.getValues };
    globalThis.document = { getElementById: () => null } as unknown as Document;
    const entries = new Map<string, string>();
    globalThis.localStorage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value); }, removeItem: key => { entries.delete(key); }, clear: () => entries.clear(), key: index => [...entries.keys()][index] ?? null, get length() { return entries.size; } };
    const dom = createFakeBatchBacktestDom(), controller = new TopRawScanController(() => dom, () => false, () => {});
    const key = state.currentStrategyKey, oldStrategy = strategyRegistry.get(key);
    const strategy = { name: "scan fixture", description: "Test fixture", paramLabels: {}, defaultParams: {}, execute: () => [] };
    registerLoadedBuiltInStrategy(key, strategy); strategyRegistry.register(key, strategy);
    backtestService.getBacktestSettings = () => ({}); backtestService.getCapitalSettings = () => makeCapitalSettings(); paramManager.getValues = () => ({});
    try { await run(controller, dom); }
    finally {
        controller.dispose(); globalThis.document = previous.document; globalThis.localStorage = previous.storage; globalThis.fetch = previous.fetch;
        backtestService.getBacktestSettings = previous.settings; backtestService.getCapitalSettings = previous.capital; paramManager.getValues = previous.params;
        unregisterLoadedBuiltInStrategy(key); strategyRegistry.unregister(key);
        if (oldStrategy) { registerLoadedBuiltInStrategy(key, oldStrategy); strategyRegistry.register(key, oldStrategy); }
    }
}
describe("TOP_RAW browser workflow", () => {
    it("cancels delayed strategy loading without dispatch and resets cancellation for the next Run", async () => fixture(async (controller, dom) => {
        saveScanPreferences({ enabled: true, assetListText: "AAPL•\nMSFT•", opponentsPerAsset: 1, finalistCount: 1, seed: 1 });
        controller.initialize();
        const key = state.currentStrategyKey, loader = builtInStrategyLoaders[key]!;
        const strategy = strategyRegistry.get(key)!;
        let finish!: (value: typeof strategy) => void;
        const loaded = new Promise<typeof strategy>(resolve => { finish = resolve; });
        unregisterLoadedBuiltInStrategy(key); builtInStrategyLoaders[key] = () => loaded;
        const calls: string[] = [];
        globalThis.fetch = async (input, init) => {
            calls.push(String(input)); const req = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({ type: "done", runId: req.runId, phase: "completed", completed: 1, total: 1, message: "done" }) + "\n");
        };
        try {
            const running = controller.run(); assert.equal(dom.batchBacktestScanStop.disabled, false);
            await controller.stop(); finish(strategy); await running;
            assert.deepEqual(calls, []); assert.equal(controller.isBusy(), false);
            await controller.run(); assert.equal(calls.length, 1);
        } finally { finish(strategy); builtInStrategyLoaders[key] = loader; }
    }));
    it("sends a scoped Stop while admission is pending without aborting the Run connection", async () => fixture(async controller => {
        saveScanPreferences({ enabled: true, assetListText: "AAPL•\nMSFT•", opponentsPerAsset: 1, finalistCount: 1, seed: 1 });
        controller.initialize(); let runId = "", finish!: (value: Response) => void, runSignal: AbortSignal | null = null;
        const admission = new Promise<Response>(resolve => { finish = resolve; });
        let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
        globalThis.fetch = async (input, init) => {
            const req = JSON.parse(String(init?.body));
            if (String(input).endsWith("/run")) { runId = req.runId; runSignal = init?.signal ?? null; started(); return admission; }
            assert.equal(req.runId, runId); assert.equal(runSignal?.aborted, false);
            finish(new Response('{"error":"Scan stopped before ownership was acquired."}', { status: 409 }));
            return new Response('{"ok":true,"stopped":false}');
        };
        const running = controller.run(); await withTimeout(ready, 1000, "admission");
        await controller.stop(); await running;
        assert.equal(controller.isBusy(), false); assert.equal(readScanActive(), null);
    }));
    it("defaults old settings off, preserves text across modes and blocks ordinary Run", async () => fixture(async (controller, dom) => {
        localStorage.setItem("playground_top_raw_scan_preferences", JSON.stringify({ enabled: true, seed: "bad" }));
        assert.equal(readScanPreferences().enabled, false);
        dom.batchBacktestSymbols.value = "AAPL•\nMSFT•"; controller.initialize();
        assert.equal(dom.batchBacktestFastTopRaw.checked, false);
        dom.batchBacktestFastTopRaw.checked = true; dom.batchBacktestFastTopRaw.dispatchEvent(new Event("change"));
        assert.equal(dom.batchBacktestRunBtn.disabled, true); assert.equal(dom.batchBacktestBalancedGenerateBtn.disabled, true);
        assert.match(dom.batchBacktestScanBudget.textContent!, /2 assets/);
        dom.batchBacktestFastTopRaw.checked = false; dom.batchBacktestFastTopRaw.dispatchEvent(new Event("change"));
        assert.equal(dom.batchBacktestSymbols.value, "AAPL•\nMSFT•"); assert.equal(dom.batchBacktestRunBtn.disabled, false);
        assert.equal(normalizeScanResult({ schema: "old_top_mean", completed: true }), null);
    }));
    it("rejects HTTP errors without polling nonexistent runs or leaving busy ownership", async () => fixture(async (controller, dom) => {
        saveScanPreferences({ enabled: true, assetListText: "AAPL•\nMSFT•", opponentsPerAsset: 64, finalistCount: 20, seed: 1 });
        controller.initialize(); const calls: string[] = [];
        globalThis.fetch = async input => { calls.push(String(input)); return new Response(JSON.stringify({ error: "shared operation busy" }), { status: 409 }); };
        await controller.run(); assert.equal(controller.isBusy(), false); assert.equal(readScanActive(), null);
        assert.equal(calls.length, 1, dom.batchBacktestScanProgress.textContent!); assert.match(dom.batchBacktestScanProgress.textContent!, /shared operation busy/);
    }));
    it("restores separate estimated/exact results and clears an older export when a new preflight fails", async () => fixture(async (controller, dom) => {
        const assets = ["AAPL•", "MSFT•", "NVDA•", "AMD•"], options = { opponentsPerAsset: 1, finalistCount: 1, seed: 1 };
        const result: ScanResult = {
            schema: "top_raw_scan.result.v1", mode: "fast_top_raw", runId: "previous_scan", status: "completed", cutoff: 1700014400, asOf: 1700000000,
            fingerprint: "fixture", universeHash: "fixture", sourceRevisions: {}, legEndpoints: {}, scoreContract: "unweighted_open_position_sum_v1",
            orientationVersion: "top_raw_scan_orientation_v1", samplingVersion: "top_raw_scan_round_robin_v1", tieVersion: "top_raw_scan_ties_v1", seedDerivation: "fnv1a32_domain_xor_seed_v1",
            requested: options, effective: options, configuration: { strategyKey: state.currentStrategyKey, strategyParams: {}, backtestSettings: {}, capitalSettings: makeCapitalSettings(), interval: "4h" },
            rawCount: 4, canonicalCount: 4, duplicateCount: 0, eligibleAssets: assets, exclusions: [],
            discovery: assets.map((asset, i) => ({ asset, sampledRaw: i === 0 ? 1 : i === 1 ? -1 : 0, estimatedRaw: i === 0 ? 3 : i === 1 ? -3 : 0, sampledDegree: 1, evaluatedDegree: 1, failedDegree: 0, activePositions: i < 2 ? 1 : 0, flatDegree: i < 2 ? 0 : 1, coverageComplete: true })),
            finalists: [{ asset: assets[0]!, candidateRank: 1, exactRaw: 1, evaluatedOpponents: 3, expectedOpponents: 3, failedOpponents: 0, complete: true }],
            cutoffTies: [], omittedCutoffTies: [], globalRankingExact: false, bestVerifiedCandidates: [assets[0]!], reason: "highest_score_among_fully_evaluated_candidates_global_ranking_estimated",
            pairCounts: { discovery: 2, refinement: 2, reused: 1, successful: 4, failed: 0 }, engineUsage: { typescript: 4, rust: 0 }, timings: {},
        };
        assert.equal(normalizeScanResult({ ...result, globalRankingExact: true }), null, "sampled rows cannot acquire a global-exact label");
        assert.equal(normalizeScanResult({ ...result, finalists: [{ ...result.finalists[0], evaluatedOpponents: 2 }] }), null, "missing opponents cannot acquire an exact score");
        assert.equal(normalizeScanResult(result)!.failureDiagnostics, undefined, "old v1 results remain readable");
        const failureDiagnostics = summarizeScanFailures([{ key: "AAPL•+MSFT•", vote: 0, active: 0, engine: "typescript", error: "Missing <endpoint> candle" }]);
        const failed = { ...result, status: "failed" as const, pairCounts: { ...result.pairCounts, failed: 1 }, failureDiagnostics };
        saveScanResult(failed);
        const restored = readScanResult()!;
        assert.deepEqual(restored.failureDiagnostics, failureDiagnostics);
        assert.match(JSON.stringify(restored), /Missing <endpoint> candle/);
        renderScanResults(dom.batchBacktestScanResults, restored);
        assert.match(dom.batchBacktestScanResults.innerHTML, /Missing &lt;endpoint&gt; candle/);
        assert.match(dom.batchBacktestScanResults.innerHTML, /AAPL•\+MSFT•/);
        assert.equal(normalizeScanResult({ ...failed, failureDiagnostics: { ...failureDiagnostics, total: 2 } })!.failureDiagnostics, undefined);
        saveScanResult(result); saveScanPreferences({ ...options, enabled: true, assetListText: assets.join("\n") });
        controller.initialize();
        assert.match(dom.batchBacktestScanResults.innerHTML, /Estimated leaders/); assert.match(dom.batchBacktestScanResults.innerHTML, /Fully scored candidates/);
        assert.match(dom.batchBacktestScanResults.innerHTML, /global ranking estimated/); assert.equal(dom.batchBacktestScanDownload.disabled, false);
        globalThis.fetch = async (_input, init) => {
            const request = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({ type: "done", runId: request.runId, phase: "failed", completed: 4, total: 4, message: "incomplete_coverage", result: { ...failed, runId: request.runId } }) + "\n");
        };
        await controller.run();
        assert.match(dom.batchBacktestScanResults.innerHTML, /Missing &lt;endpoint&gt; candle/);
        const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator"), createUrl = URL.createObjectURL;
        let copied = "", exported: Blob | null = null;
        Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (text: string) => { copied = text; } } } });
        URL.createObjectURL = blob => { exported = blob as Blob; return "blob:scan-export"; };
        globalThis.document.createElement = (() => ({ click() {}, href: "", download: "" })) as unknown as typeof document.createElement;
        try {
            dom.batchBacktestScanCopy.dispatchEvent(new Event("click"));
            dom.batchBacktestScanDownload.dispatchEvent(new Event("click"));
            assert.deepEqual(JSON.parse(copied).failureDiagnostics, failureDiagnostics);
            assert.ok(exported);
            assert.deepEqual(JSON.parse(await (exported as Blob).text()).failureDiagnostics, failureDiagnostics);
        } finally {
            URL.createObjectURL = createUrl;
            if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
            else Reflect.deleteProperty(globalThis, "navigator");
        }
        let cleared = false;
        dom.batchBacktestScanResults.replaceChildren = () => { cleared = true; };
        globalThis.fetch = async (_input, init) => {
            const request = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({ type: "done", runId: request.runId, phase: "failed", completed: 0, total: 0, message: "No common endpoint." }) + "\n");
        };
        await controller.run();
        assert.ok(cleared); assert.equal(controller.isBusy(), false); assert.equal(dom.batchBacktestScanDownload.disabled, true);
        assert.equal(readScanResult(), null, "reload must not restore the previous run as the failed run's result");
        assert.match(dom.batchBacktestScanProgress.textContent!, /No common endpoint/);
    }));
    it("restores active mode, sends scoped Stop, and disposal detaches without cancelling", async () => fixture(async (controller, dom) => {
        let requests: string[] = [];
        globalThis.fetch = async (input, init) => {
            requests.push(String(input));
            if (String(input).endsWith("/stop")) { assert.equal(JSON.parse(String(init?.body)).runId, "reload_scan"); return new Response('{"ok":true,"stopped":true}'); }
            return new Response(JSON.stringify({ runId: "reload_scan", phase: "discovery", completed: 32, total: 300, message: "working" }));
        };
        saveScanActive("reload_scan"); controller.initialize();
        await withTimeout(new Promise<void>(resolve => setTimeout(resolve, 10)), 1000, "reattach");
        assert.equal(controller.isBusy(), true); assert.equal(dom.batchBacktestFastTopRaw.checked, true);
        dom.batchBacktestFastTopRaw.checked = false; dom.batchBacktestFastTopRaw.dispatchEvent(new Event("change"));
        assert.equal(dom.batchBacktestFastTopRaw.checked, true);
        await controller.stop(); assert.ok(requests.some(url => url.endsWith("/stop")));
        requests = []; controller.dispose();
        await withTimeout(new Promise<void>(resolve => setTimeout(resolve, 10)), 1000, "dispose");
        assert.equal(requests.length, 0); assert.equal(readScanActive(), "reload_scan");
    }));
    it("retains every input asset and enables an exportable sync report after failure", async () => fixture(async (controller, dom) => {
        const full = "AAPL•\nMSFT•\nNVDA•";
        saveScanPreferences({ enabled: true, assetListText: full, opponentsPerAsset: 64, finalistCount: 20, seed: 1 });
        controller.initialize(); let submissions = 0;
        globalThis.fetch = async (_input, init) => {
            submissions++; const request = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({ type: "done", runId: request.runId, phase: "failed", completed: 3, total: 3, message: "No common candle.",
                preflight: { schema: "top_raw_scan.preflight.v1", runId: request.runId, interval: "4h", cutoff: 1700014400, requestedAssetCount: 3,
                    usableAssetCount: 2, referenceAsOf: 1700000000, sourceInterval: "30m",
                    assetsToSync: [{ asset: "NVDA•", closedBars: 50, firstTime: null, lastTime: 1700000000, reason: "Missing <target> candle" }] } }) + "\n");
        };
        await controller.run();
        assert.equal(dom.batchBacktestSymbols.value, full); assert.equal(readScanPreferences().assetListText, full);
        assert.equal(submissions, 1, "failure must not start an alternate-universe scan");
        assert.equal(dom.batchBacktestScanPreflight.hidden, false);
        assert.match(dom.batchBacktestScanPreflight.innerHTML, /All 3 requested assets are retained/);
        assert.match(dom.batchBacktestScanPreflight.innerHTML, /2023-11-14T22:13:20/);
        assert.match(dom.batchBacktestScanPreflight.innerHTML, /Missing &lt;target&gt; candle/);
        assert.equal(dom.batchBacktestScanDownload.disabled, false);
        assert.equal(dom.batchBacktestScanDownload.textContent, "Download sync report");
        dom.batchBacktestSymbols.value += "\nGOOG•"; controller.refresh();
        assert.equal(dom.batchBacktestScanPreflight.hidden, true); assert.equal(dom.batchBacktestScanDownload.disabled, true);
    }));
});
