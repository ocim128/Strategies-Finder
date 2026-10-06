/**
 * Backtest publication-ownership lifecycle regressions.
 *
 * An interactive run captures its full request (context + stable candle
 * snapshot + publication revision) before the first UI delay. Any context
 * change, result clear, replacement dataset, or competing commit that happens
 * while the run is in flight must prevent it from publishing results,
 * endpoint snapshots, or completion UI. The Rust health-check fetch is the
 * deterministic deferral point: it happens after request capture and before
 * the engine runs.
 */
import { expect } from "chai";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { state } from "../lib/state";
import { backtestService } from "../lib/backtest-service";
import { strategyRegistry } from "../strategyRegistry";
import { rustEngine } from "../lib/rust-engine-client";
import {
    clearCurrentUiBacktestEndpointSnapshot,
    getCurrentUiBacktestEndpointCandles,
    getCurrentUiBacktestEndpointSnapshot,
    setCurrentUiBacktestEndpointCandles,
    setCurrentUiBacktestEndpointSnapshot,
} from "../lib/backtest-endpoint-copy";
import { createEndpointCopySnapshot } from "../lib/backtest-endpoint-facade";
import {
    clearBacktestResults,
    commitBacktestResult,
    commitOhlcvData,
    setCurrentInterval,
    setCurrentSymbol,
    setCurrentStrategyKey,
    setBinanceMarketType,
    setBlockRange,
    setStrategyTimeframeSettings,
} from "../lib/state-actions";
import { executeBacktest } from "../lib/backtest-executor";
import { runBacktest } from "../lib/strategies/index";
import { resampleOHLCV } from "../lib/strategies/resample-utils";
import { waitFor } from "./helpers/wait-for";
import { strategyManifest } from "../lib/strategies/manifest-eager";
import { registerLoadedBuiltInStrategy, unregisterLoadedBuiltInStrategy } from "../lib/strategies/built-in-catalog";
import type { OHLCVData, Signal, Strategy, Time } from "../lib/strategies/index";

// The manifest's real key, so the endpoint preview path (which reloads the
// strategy from the snapshot key through the built-in catalog) resolves the
// same fixture implementation.
const manifestEntry = strategyManifest[0];
if (!manifestEntry) throw new Error("Expected at least one built-in strategy in the manifest");
const SPEC_STRATEGY_KEY = manifestEntry.key;
const BTC = "BTCUSDT";

/**
 * The executor bypasses the Rust health handshake when any signal carries
 * extra fields (reason/triggerPrice/sizeFraction/exit flags), so the fixture
 * strategy emits bare signals only: the handshake is the tests' deterministic
 * deferral point between request capture and publication.
 */
function makeSpecStrategy(): Strategy {
    return {
        name: "Lifecycle Spec Strategy",
        description: "Buys at bar 3 with bare signal shapes and holds to end of data.",
        defaultParams: {},
        paramLabels: {},
        execute: (data) => {
            const signals: Signal[] = [];
            if (data.length > 10) {
                signals.push({ time: data[3]!.time, type: "buy", price: data[3]!.close });
            }
            return signals;
        },
        metadata: { role: "entry", direction: "long" },
    };
}

function makeCandles(): OHLCVData[] {
    // Enough bars for the fixture entries/exits and real warm-ups. The
    // quadratic close path makes head evictions change trade fills, so a
    // mid-run eviction genuinely changes the computed result.
    return Array.from({ length: 60 }, (_, index) => {
        const close = 100 + index * index * 0.01;
        return {
            time: (1700000000 + index * 300) as Time,
            open: close - 0.05,
            high: close + 0.5,
            low: close - 0.5,
            close,
            volume: 10,
        };
    });
}

type DeferredFetch = {
    requests: string[];
    nextHealthDeferred: { promise: Promise<Response>; resolve: (response: Response) => void } | null;
    install(): void;
    restore(): void;
};

function makeDeferredFetch(): DeferredFetch {
    const saved = { fetch: globalThis.fetch } as { fetch: typeof globalThis.fetch };
    const self: DeferredFetch = {
        requests: [],
        nextHealthDeferred: null,
        install() {
            globalThis.fetch = (async (input: RequestInfo | URL) => {
                const url = String(input);
                self.requests.push(url);
                if (url.includes("/api/health")) {
                    if (self.nextHealthDeferred) {
                        return self.nextHealthDeferred.promise;
                    }
                    return new Response("{}", { status: 404 });
                }
                return new Response("{}", { status: 404 });
            }) as typeof fetch;
        },
        restore() {
            globalThis.fetch = saved.fetch;
        },
    };
    return self;
}

function resetEngineHealth(): void {
    // Reset the shared Rust health caches so every deferred run performs a
    // fresh handshake instead of serving the 5s negative-backoff cache.
    const engine = rustEngine as any;
    engine.lastHealthCheck = 0;
    engine.lastHealthCheckFailed = false;
    engine.isAvailable = false;
    engine.healthCheckInFlight = undefined;
}

function deferNextHealth(fetcher: DeferredFetch): { promise: Promise<Response>; resolve: (response: Response) => void } {
    let resolve!: (response: Response) => void;
    const promise = new Promise<Response>((res) => { resolve = res; });
    fetcher.nextHealthDeferred = { promise, resolve };
    return fetcher.nextHealthDeferred;
}

// Saved globals and service overrides.
let savedDocument: any;
let savedLocalStorage: any;
let savedGetBacktestSettings: (() => BacktestSettingsLike) | null = null;
let savedGetCapitalSettings: (() => CapitalSettingsLike) | null = null;

type BacktestSettingsLike = Record<string, unknown>;
type CapitalSettingsLike = Record<string, unknown>;

before(() => {
    savedDocument = (globalThis as any).document;
    savedLocalStorage = (globalThis as any).localStorage;
    (globalThis as any).HTMLInputElement = class {};
    (globalThis as any).HTMLSelectElement = class {};
    const elsById = new Map<string, any>();
    (globalThis as any).__specElements = elsById;
    const fakeEl: any = () => {
        const classes = new Set<string>();
        const attrs = new Map<string, string>();
        const element: any = {
            children: [],
            style: {},
            dataset: {},
            checked: false,
            disabled: false,
            classList: {
                add: (...tokens: string[]) => { for (const t of tokens) classes.add(t); },
                remove: (...tokens: string[]) => { for (const t of tokens) classes.delete(t); },
                toggle: (token: string, force?: boolean) => {
                    const next = force === undefined ? !classes.has(token) : force;
                    if (next) classes.add(token); else classes.delete(token);
                    return next;
                },
                contains: (token: string) => classes.has(token),
            },
            setAttribute: (name: string, value: string) => { attrs.set(name, String(value)); },
            getAttribute: (name: string) => attrs.get(name) ?? null,
            appendChild(child: any) { this.children.push(child); return child; },
        };
        return element;
    };
    (globalThis as any).document = {
        getElementById: (id: string) => {
            if (!elsById.has(id)) elsById.set(id, fakeEl());
            const element = elsById.get(id);
            // The Rust engine preference is read from this toggle; checking it
            // routes the executor through the Rust health handshake that the
            // deferred tests synchronize on.
            if (id === "useRustEngineToggle") element.checked = true;
            return element;
        },
        createElement: () => fakeEl(),
        createDocumentFragment: () => fakeEl(),
        addEventListener: () => {},
        body: fakeEl(),
    };
    (globalThis as any).localStorage = {
        _store: new Map<string, string>(),
        getItem(k: string) { return this._store.has(k) ? this._store.get(k)! : null; },
        setItem(k: string, v: string) { this._store.set(k, v); },
        removeItem(k: string) { this._store.delete(k); },
    };

    // The Rust client captured `fetch` at construction; route it through a
    // call-time lookup so per-test globalThis.fetch stubs are visible.
    (rustEngine as any).fetchImpl = (input: RequestInfo | URL, init?: RequestInit) =>
        globalThis.fetch(input, init);

    // Deterministic engine selection: next_open requires the Rust health
    // handshake, giving tests a stable deferral point inside the executor.
    savedGetBacktestSettings = (backtestService as any).getBacktestSettings.bind(backtestService);
    savedGetCapitalSettings = (backtestService as any).getCapitalSettings.bind(backtestService);
    (backtestService as any).getBacktestSettings = () => ({
        executionModel: "next_open",
        tradeDirection: "long",
    });
    (backtestService as any).getCapitalSettings = () => ({
        initialCapital: 10_000,
        positionSize: 100,
        commission: 0,
        sizingMode: "percent",
        fixedTradeAmount: 0,
    });
});

after(() => {
    unregisterLoadedBuiltInStrategy(SPEC_STRATEGY_KEY);
    (backtestService as any).getBacktestSettings = savedGetBacktestSettings;
    (backtestService as any).getCapitalSettings = savedGetCapitalSettings;
    if (savedDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = savedDocument;
    if (savedLocalStorage === undefined) delete (globalThis as any).localStorage;
    else (globalThis as any).localStorage = savedLocalStorage;
});

beforeEach(() => {
    for (const key of Object.keys(strategyRegistry.getAll())) {
        strategyRegistry.unregister(key);
    }
    const specStrategy = makeSpecStrategy();
    strategyRegistry.register(SPEC_STRATEGY_KEY, specStrategy);
    // The preview/executor path reloads by key from the built-in catalog.
    registerLoadedBuiltInStrategy(SPEC_STRATEGY_KEY, specStrategy);
    // Reset the shared Rust health caches so every test starts cold.
    const engine = rustEngine as any;
    engine.lastHealthCheck = 0;
    engine.lastHealthCheckFailed = false;
    engine.isAvailable = false;
    engine.healthCheckInFlight = undefined;

    setCurrentSymbol(BTC);
    setCurrentInterval("5m");
    setCurrentStrategyKey(SPEC_STRATEGY_KEY);
    setBlockRange(null);
    state.ohlcvData = makeCandles();
    state.binanceMarketType = "spot";
    clearBacktestResults("spec_reset");
    clearCurrentUiBacktestEndpointSnapshot();
});

describe("backtest service publication ownership", () => {
    it("commits an uncontested run with the captured request identity", async () => {
        const fetcher = makeDeferredFetch();
        fetcher.install();
        try {
            await backtestService.runCurrentBacktest();

            expect(state.currentBacktestResult).to.not.equal(null);
            expect(state.currentBacktestResultSource).to.equal("backtest");

            const snapshot = getCurrentUiBacktestEndpointSnapshot();
            expect(snapshot).to.not.equal(null);
            expect(snapshot!.symbol).to.equal(BTC);
            expect(snapshot!.interval).to.equal("5m");
            expect(snapshot!.strategyKey).to.equal(SPEC_STRATEGY_KEY);

            const snapshotCandles = getCurrentUiBacktestEndpointCandles();
            expect(snapshotCandles).to.have.length(state.ohlcvData.length);
        } finally {
            fetcher.restore();
        }
    });

    it("keeps stored endpoint candles frozen against later raw-candle mutation", async () => {
        const fetcher = makeDeferredFetch();
        fetcher.install();
        try {
            await backtestService.runCurrentBacktest();

            const storedCandles = getCurrentUiBacktestEndpointCandles()!;
            const storedClose = storedCandles[0]!.close;
            expect(storedClose).to.equal(100);

            // A live tick mutates the chart data in place after publication.
            state.ohlcvData[0]!.close = 999;
            expect(getCurrentUiBacktestEndpointCandles()![0]!.close).to.equal(storedClose);
        } finally {
            fetcher.restore();
        }
    });

    it("drops the run that is mid-flight when the symbol switches away", async () => {
        const fetcher = makeDeferredFetch();
        fetcher.install();
        try {
            const health = deferNextHealth(fetcher);
            const run = backtestService.runCurrentBacktest();
            await waitFor(() => fetcher.requests.some((url) => url.includes("/api/health")), 5_000, "health fetch");

            setCurrentSymbol("ETHUSDT");
            health.resolve(new Response("{}", { status: 404 }));
            await run;

            expect(state.currentBacktestResult).to.equal(null);
            expect(getCurrentUiBacktestEndpointSnapshot()).to.equal(null);
        } finally {
            fetcher.restore();
        }
    });

    it("drops the run for a change-away-and-back symbol switch", async () => {
        const fetcher = makeDeferredFetch();
        fetcher.install();
        try {
            const health = deferNextHealth(fetcher);
            const run = backtestService.runCurrentBacktest();
            await waitFor(() => fetcher.requests.some((url) => url.includes("/api/health")), 5_000, "health fetch");

            setCurrentSymbol("ETHUSDT");
            setCurrentSymbol(BTC);
            health.resolve(new Response("{}", { status: 404 }));
            await run;

            expect(state.currentBacktestResult).to.equal(null);
            expect(getCurrentUiBacktestEndpointSnapshot()).to.equal(null);
        } finally {
            fetcher.restore();
        }
    });

    it("drops the run when results are cleared during execution", async () => {
        const fetcher = makeDeferredFetch();
        fetcher.install();
        try {
            const health = deferNextHealth(fetcher);
            const run = backtestService.runCurrentBacktest();
            await waitFor(() => fetcher.requests.some((url) => url.includes("/api/health")), 5_000, "health fetch");

            clearBacktestResults("mid_flight_clear");
            health.resolve(new Response("{}", { status: 404 }));
            await run;

            expect(state.currentBacktestResult).to.equal(null);
            expect(getCurrentUiBacktestEndpointSnapshot()).to.equal(null);
        } finally {
            fetcher.restore();
        }
    });

    it("drops the run when a competing result source commits first", async () => {
        const fetcher = makeDeferredFetch();
        fetcher.install();
        try {
            const health = deferNextHealth(fetcher);
            const run = backtestService.runCurrentBacktest();
            await waitFor(() => fetcher.requests.some((url) => url.includes("/api/health")), 5_000, "health fetch");

            commitBacktestResult(
                {
                    trades: [], netProfit: 42, netProfitPercent: 0.42, winRate: 0, expectancy: 0,
                    avgTrade: 0, profitFactor: 0, maxDrawdown: 0, maxDrawdownPercent: 0,
                    totalTrades: 0, winningTrades: 0, losingTrades: 0, avgWin: 0, avgLoss: 0,
                    sharpeRatio: 0, equityCurve: [],
                },
                    "finder_selection",
                { reason: "competing_batch" },
            );
            expect(state.currentBacktestResult!.netProfit).to.equal(42);

            health.resolve(new Response("{}", { status: 404 }));
            await run;

            expect(state.currentBacktestResult!.netProfit).to.equal(42);
            expect(state.currentBacktestResultSource).to.equal("finder_selection");
        } finally {
            fetcher.restore();
        }
    });

    it("drops the run when a replacement dataset commits during execution", async () => {
        const fetcher = makeDeferredFetch();
        fetcher.install();
        try {
            const health = deferNextHealth(fetcher);
            const run = backtestService.runCurrentBacktest();
            await waitFor(() => fetcher.requests.some((url) => url.includes("/api/health")), 5_000, "health fetch");

            commitOhlcvData(makeCandles(), "spec_import");
            health.resolve(new Response("{}", { status: 404 }));
            await run;

            expect(state.currentBacktestResult).to.equal(null);
            expect(getCurrentUiBacktestEndpointSnapshot()).to.equal(null);
        } finally {
            fetcher.restore();
        }
    });

    it("drops the run on interval, strategy, or block-range changes", async () => {
        for (const mutate of [
            () => setCurrentInterval("15m"),
            () => setCurrentStrategyKey("some_other_strategy"),
            () => setBlockRange({ from: 1700000000, to: 1700003000 }),
        ]) {
            // Restore the base context: earlier iterations' mutations must
            // not leak into later ones (an unknown strategy key exits before
            // the engine handshake).
            setCurrentSymbol(BTC);
            setCurrentInterval("5m");
            setCurrentStrategyKey(SPEC_STRATEGY_KEY);
            setBlockRange(null);
            state.ohlcvData = makeCandles();
            clearBacktestResults("spec_reset_case");
            resetEngineHealth();
            const fetcher = makeDeferredFetch();
            fetcher.install();
            try {
                const health = deferNextHealth(fetcher);
                const run = backtestService.runCurrentBacktest();
                await waitFor(() => fetcher.requests.some((url) => url.includes("/api/health")), 5_000, `health fetch for ${mutate.toString()}`);

                mutate();
                health.resolve(new Response("{}", { status: 404 }));
                await run;

                expect(state.currentBacktestResult, mutate.toString()).to.equal(null);
            } finally {
                fetcher.restore();
            }
        }
    });

    it("endpoint preview publishes when uncontested and refuses after a clear or a newer result", async () => {
        const fetcher = makeDeferredFetch();
        fetcher.install();
        try {
            await backtestService.runCurrentBacktest();
            expect(state.currentBacktestResult).to.not.equal(null);

            const uncontested = await backtestService.runLatestUiBacktestEndpointPreview();
            expect(uncontested).to.not.equal(null);
            expect(state.currentBacktestResultSource).to.equal("endpoint_preview");

            // Endpoint previews pinned to the TypeScript engine never touch
            // the Rust handshake, so the race cases publish a snapshot whose
            // recorded engine is "rust": the preview then defers on the same
            // health fetch as the interactive runs.
            const installRustSnapshot = () => {
                const result = state.currentBacktestResult!;
                setCurrentUiBacktestEndpointSnapshot(createEndpointCopySnapshot({
                    symbol: BTC,
                    interval: "5m",
                    strategyKey: SPEC_STRATEGY_KEY,
                    strategyParams: {},
                    backtestSettings: { executionModel: "next_open", tradeDirection: "long" },
                    capitalSettings: {
                        initialCapital: 10_000, positionSize: 100, commission: 0,
                        sizingMode: "percent", fixedTradeAmount: 0,
                    },
                    engineUsed: "rust",
                    nowSec: Math.floor(Date.now() / 1000),
                    blockRange: null,
                    datasetForFingerprint: state.ohlcvData,
                }));
                setCurrentUiBacktestEndpointCandles(state.ohlcvData);
                return result;
            };

            // A clear during the preview run must keep the preview from
            // republishing.
            installRustSnapshot();
            resetEngineHealth();
            const health = deferNextHealth(fetcher);
            const previewPromise = backtestService.runLatestUiBacktestEndpointPreview();
            await waitFor(() => fetcher.requests.filter((url) => url.includes("/api/health")).length >= 2, 5_000, "deferred preview health fetch");
            clearBacktestResults("mid_preview_clear");
            health.resolve(new Response("{}", { status: 404 }));
            expect(await previewPromise).to.equal(null);
            expect(state.currentBacktestResult).to.equal(null);

            // A competing newer result blocks the preview too.
            commitBacktestResult(
                {
                    trades: [], netProfit: 7, netProfitPercent: 0, winRate: 0, expectancy: 0,
                    avgTrade: 0, profitFactor: 0, maxDrawdown: 0, maxDrawdownPercent: 0,
                    totalTrades: 0, winningTrades: 0, losingTrades: 0, avgWin: 0, avgLoss: 0,
                    sharpeRatio: 0, equityCurve: [],
                },
                "finder_selection",
                { reason: "newer_than_preview" },
            );
            installRustSnapshot();
            resetEngineHealth();
            const health2 = deferNextHealth(fetcher);
            const previewPromise2 = backtestService.runLatestUiBacktestEndpointPreview();
            await waitFor(() => fetcher.requests.filter((url) => url.includes("/api/health")).length >= 3, 5_000, "second deferred preview health fetch");
            commitBacktestResult(
                {
                    trades: [], netProfit: 9, netProfitPercent: 0, winRate: 0, expectancy: 0,
                    avgTrade: 0, profitFactor: 0, maxDrawdown: 0, maxDrawdownPercent: 0,
                    totalTrades: 0, winningTrades: 0, losingTrades: 0, avgWin: 0, avgLoss: 0,
                    sharpeRatio: 0, equityCurve: [],
                },
                "finder_selection",
                { reason: "newest_of_all" },
            );
            health2.resolve(new Response("{}", { status: 404 }));
            expect(await previewPromise2).to.equal(null);
            expect(state.currentBacktestResult!.netProfit).to.equal(9);
        } finally {
            fetcher.restore();
        }
    });

    it("executes against the captured request when live candles mutate mid-run", async () => {
        const fetcher = makeDeferredFetch();
        fetcher.install();
        try {
            await backtestService.runCurrentBacktest();
            const controlProfit = state.currentBacktestResult!.netProfit;
            expect(controlProfit).to.not.equal(0);
            clearBacktestResults("spec_captured_execution");

            const liveTailBar = (): OHLCVData => {
                const last = state.ohlcvData[state.ohlcvData.length - 1]!;
                return {
                    time: ((last.time as number) + 300) as Time,
                    open: 140,
                    high: 260,
                    low: 130,
                    close: 250,
                    volume: 5,
                };
            };
            const mutations: Array<{ name: string; mutate: () => void }> = [
                {
                    name: "append",
                    mutate: () => {
                        state.ohlcvData.push(liveTailBar());
                    },
                },
                {
                    name: "evict-and-append",
                    mutate: () => {
                        state.ohlcvData.splice(0, 2);
                        state.ohlcvData.push(liveTailBar());
                    },
                },
                {
                    name: "replace",
                    mutate: () => {
                        const replaced = makeCandles().map((candle) => ({
                            ...candle,
                            close: candle.close * 10,
                            open: candle.open * 10,
                            high: candle.high * 10,
                            low: candle.low * 10,
                        }));
                        state.ohlcvData = replaced;
                    },
                },
            ];

            for (const { name, mutate } of mutations) {
                state.ohlcvData = makeCandles();
                clearBacktestResults("spec_captured_execution");
                resetEngineHealth();
                const health = deferNextHealth(fetcher);
                const run = backtestService.runCurrentBacktest();
                await waitFor(() => fetcher.requests.some((url) => url.includes("/api/health")), 5_000, `health fetch for ${name}`);

                mutate();
                health.resolve(new Response("{}", { status: 404 }));
                await run;

                // Execution, snapshot, and fingerprint describe the captured
                // request, not the mid-run-mutated live dataset.
                expect(state.currentBacktestResult, `${name}: published`).to.not.equal(null);
                expect(state.currentBacktestResult!.netProfit, `${name}: captured execution`).to.equal(controlProfit);

                // Vacuity guard: the mutation is outcome-relevant, so a run
                // STARTED on the mutated dataset computes a different result.
                await backtestService.runCurrentBacktest();
                const mutatedProfit = state.currentBacktestResult!.netProfit;
                expect(mutatedProfit, `${name}: mutation must change the result`).to.not.equal(controlProfit);
            }
        } finally {
            fetcher.restore();
        }
    });

    it("releases the loading UI when the selected strategy is missing", async () => {
        setCurrentStrategyKey("definitely_missing_strategy");
        await backtestService.runCurrentBacktest();

        const elements = (globalThis as any).__specElements as Map<string, any>;
        const button = elements.get("runBacktest");
        assert.equal(button.disabled, false, "run button must be re-enabled");
        assert.equal(button.getAttribute("aria-busy"), "false", "aria-busy must clear");
        assert.equal(button.classList.contains("is-loading"), false, "is-loading must clear");
        const container = elements.get("progressContainer");
        assert.equal(container.classList.contains("active"), false, "progress must deactivate");
        assert.equal(elements.get("progressFill").style.width, "0%", "progress fill must reset");
    });

    it("releases the loading UI on pre-execution failures without disturbing newer runs", async () => {
        const service = backtestService as any;
        const original = service.getBacktestSettings;
        service.getBacktestSettings = () => {
            throw new Error("settings boom");
        };
        try {
            await assert.rejects(
                backtestService.runCurrentBacktest(),
                /settings boom/,
            );
        } finally {
            service.getBacktestSettings = original;
        }

        const elements = (globalThis as any).__specElements as Map<string, any>;
        const button = elements.get("runBacktest");
        assert.equal(button.disabled, false, "run button must be re-enabled");
        assert.equal(button.getAttribute("aria-busy"), "false", "aria-busy must clear");
        assert.equal(button.classList.contains("is-loading"), false, "is-loading must clear");
        const container = elements.get("progressContainer");
        assert.equal(container.classList.contains("active"), false, "progress must deactivate");

        // A newer run still works and finishes cleanly afterwards.
        await backtestService.runCurrentBacktest();
        assert.notEqual(state.currentBacktestResult, null);
    });

    it("supersedes previews through shared publication ownership", async () => {
        const fetcher = makeDeferredFetch();
        fetcher.install();
        try {
            await backtestService.runCurrentBacktest();
            expect(state.currentBacktestResult).to.not.equal(null);

            const installRustSnapshot = () => {
                setCurrentUiBacktestEndpointSnapshot(createEndpointCopySnapshot({
                    symbol: BTC,
                    interval: "5m",
                    strategyKey: SPEC_STRATEGY_KEY,
                    strategyParams: {},
                    backtestSettings: { executionModel: "next_open", tradeDirection: "long" },
                    capitalSettings: {
                        initialCapital: 10_000, positionSize: 100, commission: 0,
                        sizingMode: "percent", fixedTradeAmount: 0,
                    },
                    engineUsed: "rust",
                    nowSec: Math.floor(Date.now() / 1000),
                    blockRange: null,
                    datasetForFingerprint: state.ohlcvData,
                }));
                setCurrentUiBacktestEndpointCandles(state.ohlcvData);
            };
            const healthFetches = () => fetcher.requests.filter((url) => url.includes("/api/health")).length;

            // Strategy change mid-preview: the previously selected strategy's
            // result must not publish after the selection changed.
            installRustSnapshot();
            resetEngineHealth();
            let health = deferNextHealth(fetcher);
            let preview = backtestService.runLatestUiBacktestEndpointPreview();
            await waitFor(() => healthFetches() >= 2, 5_000, "preview health (strategy change)");
            setCurrentStrategyKey("some_other_strategy");
            health.resolve(new Response("{}", { status: 404 }));
            assert.equal(await preview, null, "strategy change must supersede the preview");
            setCurrentStrategyKey(SPEC_STRATEGY_KEY);

            // Change-away-and-back mid-preview.
            installRustSnapshot();
            resetEngineHealth();
            health = deferNextHealth(fetcher);
            preview = backtestService.runLatestUiBacktestEndpointPreview();
            await waitFor(() => healthFetches() >= 3, 5_000, "preview health (away-and-back)");
            setCurrentSymbol("ETHUSDT");
            setCurrentSymbol(BTC);
            health.resolve(new Response("{}", { status: 404 }));
            assert.equal(await preview, null, "change-away-and-back must supersede the preview");

            // Block-range change mid-preview.
            installRustSnapshot();
            resetEngineHealth();
            health = deferNextHealth(fetcher);
            preview = backtestService.runLatestUiBacktestEndpointPreview();
            await waitFor(() => healthFetches() >= 4, 5_000, "preview health (block range)");
            setBlockRange({ from: 1700000000, to: 1700003000 });
            health.resolve(new Response("{}", { status: 404 }));
            assert.equal(await preview, null, "block-range change must supersede the preview");
            setBlockRange(null);

            // Market-type change mid-preview.
            installRustSnapshot();
            resetEngineHealth();
            health = deferNextHealth(fetcher);
            preview = backtestService.runLatestUiBacktestEndpointPreview();
            await waitFor(() => healthFetches() >= 5, 5_000, "preview health (market type)");
            setBinanceMarketType("futures");
            health.resolve(new Response("{}", { status: 404 }));
            assert.equal(await preview, null, "market-type change must supersede the preview");
            setBinanceMarketType("spot");

            // A newer interactive request supersedes the preview as soon as it
            // captures — before the newer run commits anything.
            installRustSnapshot();
            resetEngineHealth();
            health = deferNextHealth(fetcher);
            preview = backtestService.runLatestUiBacktestEndpointPreview();
            await waitFor(() => healthFetches() >= 6, 5_000, "preview health (newer run)");
            const newerRun = backtestService.runCurrentBacktest();
            health.resolve(new Response("{}", { status: 404 }));
            assert.equal(await preview, null, "a newer captured request must supersede the preview");
            await newerRun;
            assert.equal(state.currentBacktestResultSource, "backtest", "the newer run publishes");

            // A newer preview supersedes an older preview.
            installRustSnapshot();
            resetEngineHealth();
            health = deferNextHealth(fetcher);
            const olderPreview = backtestService.runLatestUiBacktestEndpointPreview();
            await waitFor(() => healthFetches() >= 7, 5_000, "preview health (older of two)");
            const newerPreview = backtestService.runLatestUiBacktestEndpointPreview();
            health.resolve(new Response("{}", { status: 404 }));
            assert.equal(await olderPreview, null, "the older preview must be superseded");
            assert.notEqual(await newerPreview, null, "the newer preview publishes");
        } finally {
            fetcher.restore();
        }
    });

    it("does not publish when the strategy timeframe is enabled mid-run", async () => {
        const fetcher = makeDeferredFetch();
        fetcher.install();
        try {
            setStrategyTimeframeSettings({ enabled: false, minutes: 120 });
            const health = deferNextHealth(fetcher);
            const run = backtestService.runCurrentBacktest();
            await waitFor(() => fetcher.requests.some((url) => url.includes("/api/health")), 5_000, "health fetch");

            setStrategyTimeframeSettings({ enabled: true, minutes: 120 });
            health.resolve(new Response("{}", { status: 404 }));
            await run;

            assert.equal(state.currentBacktestResult, null, "timeframe enablement must supersede the pending run");
            assert.equal(getCurrentUiBacktestEndpointSnapshot(), null);
        } finally {
            setStrategyTimeframeSettings({ enabled: false, minutes: 120 });
            fetcher.restore();
        }
    });

    it("does not publish when the strategy timeframe minutes change mid-run", async () => {
        const fetcher = makeDeferredFetch();
        fetcher.install();
        try {
            setStrategyTimeframeSettings({ enabled: true, minutes: 60 });
            const health = deferNextHealth(fetcher);
            const run = backtestService.runCurrentBacktest();
            await waitFor(() => fetcher.requests.some((url) => url.includes("/api/health")), 5_000, "health fetch");

            setStrategyTimeframeSettings({ minutes: 120 });
            health.resolve(new Response("{}", { status: 404 }));
            await run;

            assert.equal(state.currentBacktestResult, null, "a minutes change must supersede the pending run");
        } finally {
            setStrategyTimeframeSettings({ enabled: false, minutes: 120 });
            fetcher.restore();
        }
    });

    it("does not publish for a timeframe change-away-and-back mid-run", async () => {
        const fetcher = makeDeferredFetch();
        fetcher.install();
        try {
            setStrategyTimeframeSettings({ enabled: false, minutes: 120 });
            const health = deferNextHealth(fetcher);
            const run = backtestService.runCurrentBacktest();
            await waitFor(() => fetcher.requests.some((url) => url.includes("/api/health")), 5_000, "health fetch");

            setStrategyTimeframeSettings({ enabled: true, minutes: 120 });
            setStrategyTimeframeSettings({ enabled: false, minutes: 120 });
            health.resolve(new Response("{}", { status: 404 }));
            await run;

            assert.equal(state.currentBacktestResult, null, "change-away-and-back must supersede the pending run");
        } finally {
            setStrategyTimeframeSettings({ enabled: false, minutes: 120 });
            fetcher.restore();
        }
    });

    it("executes wrapped strategies with the captured timeframe settings, not live state", async () => {
        // A registry-wrapped fixture that buys the first supplied candle and
        // sells the second: resampled 120m execution produces one trade over
        // 300 one-minute candles, raw execution produces many.
        const tfStrategyKey = "tf_spec_strategy";
        // Alternating entries/exits: resampled 120m execution yields one
        // trade over 300 one-minute candles, raw execution yields ~150.
        const rawTfStrategy: Strategy = {
            name: "TF Spec Strategy",
            description: "Buys on even candles and sells on odd candles.",
            defaultParams: {},
            paramLabels: {},
            execute: (data) => {
                const signals: Signal[] = [];
                for (let i = 0; i + 1 < data.length; i += 2) {
                    signals.push({ time: data[i]!.time, type: "buy", price: data[i]!.close });
                    signals.push({ time: data[i + 1]!.time, type: "sell", price: data[i + 1]!.close });
                }
                return signals;
            },
            metadata: { role: "entry", direction: "long" },
        };
        strategyRegistry.register(tfStrategyKey, rawTfStrategy);
        const wrapped = strategyRegistry.get(tfStrategyKey)!;
        const oneMinuteCandles: OHLCVData[] = Array.from({ length: 300 }, (_, index) => {
            const close = 100 + index;
            return {
                time: (1700000000 + index * 60) as Time,
                open: close - 0.5,
                high: close + 0.5,
                low: close - 0.5,
                close,
                volume: 10,
            };
        });
        const capitalSettings = {
            initialCapital: 10_000, positionSize: 100, commission: 0,
            sizingMode: "percent" as const, fixedTradeAmount: 0,
        };
        const baseSettings = {
            tradeDirection: "long" as const,
            executionModel: "signal_close" as const,
        };
        const runExecutor = async (settings: Record<string, unknown>) => executeBacktest({
            ohlcvData: oneMinuteCandles,
            interval: "1m",
            primarySymbol: BTC,
            strategyKey: tfStrategyKey,
            strategy: wrapped,
            strategyParams: {},
            backtestSettings: { ...baseSettings, ...settings } as never,
            capitalSettings,
            context: {
                nowSec: Math.floor(Date.now() / 1000),
                blockRange: null,
                engineMode: "typescript" as const,
            },
        });

        try {
            setStrategyTimeframeSettings({ enabled: false, minutes: 120 });

            // Captured timeframe enabled while global state is disabled:
            // execution must resample (one trade), proving the captured
            // settings drive the wrapped strategy.
            setStrategyTimeframeSettings({ enabled: false, minutes: 120 });
            const capturedEnabled = await runExecutor({
                strategyTimeframeEnabled: true,
                strategyTimeframeMinutes: 120,
            });
            assert.equal(capturedEnabled.result.totalTrades, 1, "captured 120m timeframe must resample execution");

            // Captured timeframe disabled while global state is enabled:
            // execution must stay raw (many trades), proving live state does
            // not leak into the captured request.
            setStrategyTimeframeSettings({ enabled: true, minutes: 120 });
            const capturedDisabled = await runExecutor({
                strategyTimeframeEnabled: false,
                strategyTimeframeMinutes: 120,
            });
            assert.equal(
                capturedDisabled.result.totalTrades > 1,
                true,
                `captured-disabled execution must stay raw, got ${capturedDisabled.result.totalTrades}`,
            );

            // Execution and replay agree under identical settings: running
            // the unwrapped fixture directly on the resampled data reproduces
            // the captured-enabled outcome.
            const resampled = resampleOHLCV(oneMinuteCandles, "120m");
            const replay = runBacktest(
                resampled,
                rawTfStrategy.execute(resampled, rawTfStrategy.defaultParams),
                10_000,
                100,
                0,
                { ...baseSettings },
            );
            assert.equal(replay.totalTrades, capturedEnabled.result.totalTrades);
            assert.equal(replay.netProfit, capturedEnabled.result.netProfit);
        } finally {
            setStrategyTimeframeSettings({ enabled: false, minutes: 120 });
            strategyRegistry.unregister(tfStrategyKey);
        }
    });
});
