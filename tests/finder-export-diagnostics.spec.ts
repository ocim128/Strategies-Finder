/**
 * Focused payload assertions for the extracted Finder export and diagnostics
 * builders (`lib/finder/browser/finder-export.ts`,
 * `lib/finder/browser/finder-run-diagnostics.ts`).
 *
 * Locks the clipboard payload fields (including non-finite exitAlpha
 * omission), the failure/fallback diagnostics shapes that keep Copy
 * Diagnostics available when no candidates survive, and the clipboard
 * failure/fallback control flow.
 */
import { expect } from "chai";
import { describe, it, after } from "node:test";
import {
    buildCurrentChartMetadataPayload,
    buildUniverseMetadataPayload,
    buildStrategyQualityMetadataPayload,
    buildArmPerformanceTopResultsPayload,
    buildFinderTopResultsPayload,
    buildFinderRunConfigurationPayload,
    buildArmPerformanceDiagnosticsPayload,
    copyTextToClipboard,
} from "../lib/finder/browser/finder-export";
import {
    buildFailureDiagnostics,
    buildFallbackDiagnostics,
    buildStrategyQualityDiagnostics,
    resolveDiagnosticsEngineMode,
} from "../lib/finder/browser/finder-run-diagnostics";
import { normalizeFinderUiState } from "../lib/finder/browser/finder-settings";
import type { FinderArmPerformanceCandidate, FinderResult, FinderUniverseCandidate } from "../lib/types/finder";

function makeChartResult(overrides: Partial<FinderResult> = {}): FinderResult {
    return {
        key: "ema_confirmation",
        name: "EMA Confirmation",
        params: { threshold: 3 },
        result: { netProfit: 120, totalTrades: 30 } as any,
        selectionResult: { netProfit: 100, totalTrades: 25 } as any,
        exitAlpha: Number.NaN,
        oosExitAlpha: Number.NaN,
        ...overrides,
    } as FinderResult;
}

// Minimal DOM/navigator stand-ins for the clipboard fallback path.
function installClipboardFakes(options: {
    clipboardWrite?: () => Promise<void>;
    execCommandResult: boolean;
}): { copied: () => string; events: string[] } {
    let copied = "";
    const events: string[] = [];
    // Node >= 21 defines `navigator` as a getter-only global, so a plain
    // assignment is silently ignored; redefine it instead.
    Object.defineProperty(globalThis, "navigator", {
        value: {
            clipboard: options.clipboardWrite
                ? { writeText: (text: string) => { copied = text; return options.clipboardWrite!(); } }
                : undefined,
        },
        configurable: true,
    });
    (globalThis as any).document = {
        createElement: () => ({
            value: "",
            style: {},
            setAttribute: () => {},
            focus: () => {},
            select: () => {},
            remove: () => {},
        }),
        body: {
            appendChild: (node: { value: string }) => {
                events.push("append");
                copied = node.value;
            },
        },
        execCommand: (command: string) => {
            events.push(`exec:${command}`);
            return options.execCommandResult;
        },
    };
    return { copied: () => copied, events };
}

const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator")?.value;
const savedDocument = (globalThis as any).document;

after(() => {
    Object.defineProperty(globalThis, "navigator", {
        value: savedNavigator,
        configurable: true,
    });
    if (savedDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = savedDocument;
});

describe("Finder metadata payload builders", () => {
    it("includes finite exit alpha fields and omits non-finite ones", () => {
        const payload = buildCurrentChartMetadataPayload(makeChartResult({
            exitAlpha: 1.25,
            oosExitAlpha: 0.75,
        }), 4) as any;
        expect(payload.scope).to.equal("current_chart");
        expect(payload.rank).to.equal(4);
        expect(payload.strategyId).to.equal("ema_confirmation");
        expect(payload.metrics.exitAlpha).to.equal(1.25);
        expect(payload.metrics.oosExitAlpha).to.equal(0.75);
        expect(payload.rawMetrics.exitAlpha).to.equal(1.25);
        expect(payload.selectionMetrics.exitAlpha).to.equal(1.25);
        expect(payload.exitAlpha).to.equal(1.25);
        expect(payload.oosExitAlpha).to.equal(0.75);
        // Unknown strategy keys still produce a payload; metadata degrades to null.
        expect(payload.metadata).to.equal(null);

        const noAlpha = buildCurrentChartMetadataPayload(makeChartResult(), 1) as any;
        expect(noAlpha.metrics).to.not.have.property("exitAlpha");
        expect(noAlpha).to.not.have.property("exitAlpha");
    });

    it("keeps universe summaries, per-symbol metrics, and explicit null OOS alpha", () => {
        const candidate = {
            strategyKey: "universe_test",
            strategyName: "Universe Test",
            params: { threshold: 2 },
            activeSymbols: 3,
            profitableSymbols: 2,
            losingSymbols: 1,
            flatSymbols: 0,
            noTradeSymbols: 0,
            symbols: [{
                symbol: "AAA",
                status: "profitable",
                barCount: 100,
                firstTime: 1,
                lastTime: 2,
                result: {
                    netProfit: 10,
                    netProfitPercent: 10,
                    expectancy: 1,
                    avgTrade: 1,
                    winRate: 60,
                    profitFactor: 2,
                    totalTrades: 12,
                    maxDrawdownPercent: 4,
                    winningTrades: 7,
                    losingTrades: 5,
                    avgWin: 3,
                    avgLoss: -1,
                    sharpeRatio: 1.2,
                    sharpeRatioAvailable: true,
                    drawdownAvailable: true,
                    exitAlpha: Number.NaN,
                },
                oosResult: { exitAlpha: 0.4 },
            }],
            totalTrades: 12,
            profitableActiveRatio: 2 / 3,
            medianExpectancy: 1,
            medianSharpe: 1.2,
            medianSharpeAvailable: true,
            medianNetProfit: 10,
            worstNetProfit: -2,
            bestNetProfit: 10,
            medianExitAlpha: Number.NaN,
            medianOosExitAlpha: 0.4,
        } as unknown as FinderUniverseCandidate;

        const payload = buildUniverseMetadataPayload(candidate, 2) as any;
        expect(payload.scope).to.equal("symbol_universe");
        expect(payload.summary.totalSymbols).to.equal(1);
        expect(payload.summary.profitableActiveRatio).to.be.closeTo(2 / 3, 1e-9);
        expect(payload.summary).to.not.have.property("medianExitAlpha");
        expect(payload.summary.medianOosExitAlpha).to.equal(0.4);
        expect(payload.symbols).to.have.length(1);
        expect(payload.symbols[0].metrics.totalTrades).to.equal(12);
        expect(payload.symbols[0].metrics).to.not.have.property("exitAlpha");
        expect(payload.symbols[0].oosExitAlpha).to.equal(0.4);
    });

    it("maps strategy quality rows with rank, interval metrics, and null OOS", () => {
        const result = {
            strategyKey: "quality_test",
            strategyName: "Quality Test",
            params: {},
            averageExpectancy: 1.5,
            medianExpectancy: 1.2,
            profitFactor: 2,
            averageProfitFactor: 1.9,
            averageSharpe: 1.1,
            totalNetProfit: 90,
            totalTrades: 80,
            weightedWinRate: 61,
            activeSymbols: 5,
            profitableSymbols: 3,
            oos: null,
        } as any;
        const payload = buildStrategyQualityMetadataPayload(result, 1) as any;
        expect(payload.scope).to.equal("strategy_quality");
        expect(payload.rank).to.equal(1);
        expect(payload.metrics.averageExpectancy).to.equal(1.5);
        expect(payload.oos).to.equal(null);
    });

    it("labels Arm rows with the selected arm, its metric, and the run id", () => {
        const candidate = {
            candidateId: "run:candidate-0",
            candidateOrdinal: 0,
            strategyKey: "arm_test",
            strategyName: "Arm Test",
            horizon: 5,
            params: {},
            backtestSettings: {},
            pairCoverage: { requestedPairs: 2, completedPairs: 2, failedPairs: 0, replayTargetLoadFailures: 0, noTradePairs: 0 },
            metrics: { TOP_RAW: 7, TOP_RAW_PROFIT_NOW: 3 },
            exitStrategyKey: null,
            exitStrategyParams: null,
        } as unknown as FinderArmPerformanceCandidate;
        const payload = buildArmPerformanceTopResultsPayload({
            results: [candidate],
            runContext: { runId: "arm-run-1", interval: "4h" } as any,
            inventoryComplete: true,
            selectedArm: "TOP_RAW",
        });
        expect(payload.scope).to.equal("arm_performance");
        expect(payload.selectedArm).to.equal("TOP_RAW");
        expect(payload.runContext).to.deep.equal({ runId: "arm-run-1", interval: "4h" });
        expect(payload.results[0].rank).to.equal(1);
        expect(payload.results[0].runId).to.equal("arm-run-1");
        expect(payload.results[0].selectedArmMetric).to.equal(7);
        expect(payload.results[0].allArmMetrics).to.equal(candidate.metrics);
    });

    it("routes the top-results payload by result scope", () => {
        const base = {
            armRunContext: null,
            armInventoryComplete: true,
            selectedArm: "TOP_RAW_PROFIT_NOW" as const,
        };
        const chart = buildFinderTopResultsPayload({
            ...base,
            latestResults: { scope: "current_chart", results: [makeChartResult()] },
        }) as any[];
        expect(chart).to.have.length(1);
        expect(chart[0].scope).to.equal("current_chart");

        const arm = buildFinderTopResultsPayload({
            ...base,
            latestResults: { scope: "arm_performance", results: [], runContext: null, inventoryComplete: true },
        }) as any;
        expect(arm.scope).to.equal("arm_performance");

        const universe = buildFinderTopResultsPayload({
            ...base,
            latestResults: { scope: "symbol_universe", results: [] },
        });
        expect(universe).to.deep.equal([]);
    });

    it("filters stale strategy keys and nulls the trade cap when the filter is off", () => {
        const uiState = normalizeFinderUiState({
            tradeFilterEnabled: false,
            maxTradesText: "200",
            currentChartSelectedStrategyKeys: ["ema_confirmation", "deleted_custom_strategy"],
            universeSelectedStrategyKeys: ["ghost_strategy"],
        });
        const payload = buildFinderRunConfigurationPayload({
            uiState,
            backtestSettings: { executionModel: "signal_close" } as any,
            capitalSettings: { sizingMode: "fixed_usd" } as any,
        }) as any;
        expect(payload.finder.tradeFilterEnabled).to.equal(false);
        expect(payload.finder.maxTradesText).to.equal(null);
        expect(payload.finder.currentChartSelectedStrategyKeys).to.deep.equal(["ema_confirmation"]);
        expect(payload.finder.universeSelectedStrategyKeys).to.deep.equal([]);
        expect(payload.backtestSettings.executionModel).to.equal("signal_close");
        expect(payload.capitalSettings.sizingMode).to.equal("fixed_usd");
    });

    it("keeps the trade cap when the filter is on", () => {
        const uiState = normalizeFinderUiState({ tradeFilterEnabled: true, maxTradesText: "150" });
        const payload = buildFinderRunConfigurationPayload({
            uiState,
            backtestSettings: {} as any,
            capitalSettings: {} as any,
        }) as any;
        expect(payload.finder.maxTradesText).to.equal("150");
    });
});

describe("Finder diagnostics builders", () => {
    it("prepends the error reason to failure diagnostics bottlenecks", () => {
        const diagnostics = buildFailureDiagnostics({
            kind: "run",
            options: { mode: "random", scope: "current_chart" } as any,
            elapsedMs: 1_234,
            error: "engine exploded badly",
        });
        expect(diagnostics.bottlenecks[0]).to.include("Finder run failed: engine exploded badly");
        expect(diagnostics.timingsMs.total).to.equal(1_234);
        expect(diagnostics.symbol).to.be.a("string");
    });

    it("truncates very long failure reasons", () => {
        const diagnostics = buildFailureDiagnostics({
            kind: "run",
            options: { mode: "random" } as any,
            elapsedMs: 1,
            error: "x".repeat(400),
        });
        expect(diagnostics.bottlenecks[0]!.length).to.be.lessThan(260);
        expect(diagnostics.bottlenecks[0]).to.include("...");
    });

    it("maps load failures into universe failedSymbols with reasons", () => {
        const diagnostics = buildFailureDiagnostics({
            kind: "load",
            options: { mode: "random", scope: "symbol_universe" } as any,
            elapsedMs: 500,
            loadFailures: new Map([
                ["AAA", { error: "no candles" }],
                ["BBB", {}],
            ]),
            totalSymbols: 5,
            loadedSymbols: 3,
        });
        const universe = (diagnostics as any).universe;
        expect(universe.totalSymbols).to.equal(5);
        expect(universe.loadedSymbols).to.equal(3);
        expect(universe.failedSymbols).to.deep.equal([
            { symbol: "AAA", reason: "no candles" },
            { symbol: "BBB", reason: "unknown error" },
        ]);
        expect(diagnostics.timingsMs.dataLoading).to.equal(500);
    });

    it("builds fallback diagnostics that keep Copy Diagnostics meaningful", () => {
        const selection = { key: "ema_confirmation", name: "EMA Confirmation", strategy: {} } as any;
        const diagnostics = buildFallbackDiagnostics({
            options: { mode: "random", maxRuns: 42 } as any,
            results: [makeChartResult({ endpointAdjusted: true })],
            selectedStrategies: [selection],
            ohlcvData: new Array(500).fill({ time: 1, open: 1, high: 1, low: 1, close: 1 }),
            elapsedMs: 250.4,
            requiresTsEngine: true,
        });
        expect(diagnostics.engineMode).to.equal("typescript");
        expect(diagnostics.data.inputBars).to.equal(500);
        expect(diagnostics.counts.processedRuns).to.equal(42);
        expect(diagnostics.counts.endpointAdjusted).to.equal(1);
        expect(diagnostics.strategyBreakdown).to.have.length(1);
        expect(diagnostics.bottlenecks).to.deep.equal([
            "typescript runner returned path-level diagnostics only",
            "Total run time was 250ms",
        ]);
    });

    it("maps strategy quality performance into diagnostics with the audit payload", () => {
        const performance = {
            requestedSymbols: 4,
            loadedSymbols: 3,
            selectedStrategies: 2,
            runs: { planned: 20, completed: 18, failed: 1, noTrade: 1 },
            data: { averageBars: 300 },
            timingsMs: {
                providerResolution: 10,
                dataLoading: 90,
                dataPreparation: 20,
                strategyExecution: 600,
                oosExecution: 200,
                resultReduction: 5,
                yielding: 8,
                total: 0,
            },
        } as any;
        const diagnostics = buildStrategyQualityDiagnostics({
            options: { mode: "random" } as any,
            results: [],
            performance,
            failedSymbolDetails: [{ symbol: "BBB", error: "missing file" }],
            elapsedMs: 950,
        });
        expect(diagnostics.timingsMs.total).to.equal(950);
        expect(diagnostics.timingsMs.dataLoading).to.equal(100);
        expect(diagnostics.timingsMs.backtest).to.equal(800);
        expect(diagnostics.timingsMs.resultRanking).to.equal(5);
        const quality = (diagnostics as any).strategyQuality;
        expect(quality.timingsMs.total).to.equal(950);
        expect(quality.runs.completed).to.equal(18);
    });

    it("labels genetic runs as genetic and everything else typescript", () => {
        expect(resolveDiagnosticsEngineMode({ mode: "genetic" } as any)).to.equal("genetic");
        expect(resolveDiagnosticsEngineMode({ mode: "grid" } as any)).to.equal("typescript");
    });

    it("shapes Arm diagnostics payloads with pair coverage and metrics only", () => {
        const candidate = {
            candidateId: "c0",
            candidateOrdinal: 0,
            strategyKey: "arm_test",
            pairCoverage: { requestedPairs: 1, completedPairs: 1, failedPairs: 0, replayTargetLoadFailures: 0, noTradePairs: 0 },
            metrics: { TOP_RAW: 3 },
        } as unknown as FinderArmPerformanceCandidate;
        const payload = buildArmPerformanceDiagnosticsPayload({
            runContext: { runId: "r1" } as any,
            inventoryComplete: false,
            results: [candidate],
        }) as any;
        expect(payload.scope).to.equal("arm_performance");
        expect(payload.inventoryComplete).to.equal(false);
        expect(payload.results[0].pairCoverage.requestedPairs).to.equal(1);
        expect(payload.results[0].strategyName).to.equal(undefined);
    });
});

describe("copyTextToClipboard", () => {
    it("uses the async clipboard API when available", async () => {
        const fakes = installClipboardFakes({ clipboardWrite: async () => undefined, execCommandResult: false });
        await copyTextToClipboard("hello");
        expect(fakes.copied()).to.equal("hello");
        expect(fakes.events).to.deep.equal([]);
    });

    it("falls back to the hidden textarea when the clipboard API is unavailable", async () => {
        const fakes = installClipboardFakes({ execCommandResult: true });
        await copyTextToClipboard("fallback-text");
        expect(fakes.copied()).to.equal("fallback-text");
        expect(fakes.events).to.deep.equal(["append", "exec:copy"]);
    });

    it("rejects when the fallback copy is rejected too", async () => {
        installClipboardFakes({ execCommandResult: false });
        let caught: unknown = null;
        try {
            await copyTextToClipboard("doomed");
        } catch (error) {
            caught = error;
        }
        expect((caught as Error).message).to.include("Fallback clipboard copy returned false");
    });

    it("falls back when the async clipboard write rejects", async () => {
        const fakes = installClipboardFakes({
            clipboardWrite: async () => {
                throw new Error("not focused");
            },
            execCommandResult: true,
        });
        await copyTextToClipboard("after-reject");
        expect(fakes.copied()).to.equal("after-reject");
        expect(fakes.events).to.deep.equal(["append", "exec:copy"]);
    });
});
