import { afterEach, describe, it } from "node:test";
import { expect } from "chai";
import { runSecondMarketFinder } from "../lib/second-market/finder-runner";
import { resetLocalSqlitePolymarketApiAvailabilityForTests } from "../lib/local-sqlite-polymarket-api";
import type { FinderRunInput } from "../lib/finder/finder-runner";
import type { PolymarketClob1sQuoteRow } from "../lib/second-market/types";
import type { OHLCVData, Strategy } from "../lib/types/strategies";

const originalFetch = globalThis.fetch;
const FIXTURE_START_TS = 1_700_000_010;
const FIXTURE_EXIT_SIGNAL_INDEX = 10;
const FIXTURE_ENTRY_TS = FIXTURE_START_TS + 1;
const FIXTURE_EXIT_TS = FIXTURE_START_TS + FIXTURE_EXIT_SIGNAL_INDEX + 1;

afterEach(() => {
    globalThis.fetch = originalFetch;
    resetLocalSqlitePolymarketApiAvailabilityForTests();
});

function quote(ts: number, yesAsk: number, yesBid: number): PolymarketClob1sQuoteRow {
    return {
        series_id: "10684",
        symbol: "BTCUSDT",
        outcome_interval: "5m",
        event_start_ts: 1_700_000_000,
        event_end_ts: 1_700_000_300,
        condition_id: "",
        market_slug: "btc-event",
        yes_token_id: "yes",
        no_token_id: "no",
        sample_ts: ts,
        yes_bid: yesBid,
        yes_ask: yesAsk,
        yes_mid: (yesAsk + yesBid) / 2,
        yes_last: null,
        no_bid: 1 - yesAsk,
        no_ask: 1 - yesBid,
        no_mid: 0.5,
        no_last: null,
        source: "polymarket_clob_1s",
        source_ts_ms: ts * 1000,
        quote_age_ms: 0,
        quality_flags: "",
        updated_at: ts,
    };
}

function candles(): OHLCVData[] {
    return Array.from({ length: 21 }, (_, i) => {
        const close = 100 + Math.min(i, 2);
        return {
            time: (FIXTURE_START_TS + i) as OHLCVData["time"],
            open: close,
            high: close + 1,
            low: close - 1,
            close,
            volume: 1,
        };
    });
}

const strategy: Strategy = {
    name: "Second Market Finder Fixture",
    description: "fixture",
    defaultParams: { threshold: 1 },
    paramLabels: { threshold: "Threshold" },
    execute(data) {
        const exitIndex = Math.min(FIXTURE_EXIT_SIGNAL_INDEX, data.length - 1);
        return [
            { time: data[0]!.time, type: "buy", price: data[0]!.close },
            { time: data[exitIndex]!.time, type: "sell", price: data[exitIndex]!.close },
        ];
    },
};

function makeInput(): FinderRunInput {
    return {
        ohlcvData: candles(),
        symbol: "BTCUSDT",
        interval: "1s",
        options: {
            mode: "grid",
            sortPriority: ["polyExpectancy", "polyPredictions"],
            useAdvancedSort: false,
            topN: 5,
            steps: 2,
            rangePercent: 0,
            maxRuns: 10,
            tradeFilterEnabled: false,
            minTrades: 0,
            maxTrades: Number.POSITIVE_INFINITY,
            freezeRiskManagement: true,
            polymarketScoringEnabled: true,
            polymarketRankMode: "expectancy",
            polymarketMinScoredPredictions: 0,
            polymarketLockOffset: false,
            polymarketAfterTakeProfitOnly: false,
            polymarketExitMode: "resolve_hold",
        },
        settings: {
            executionModel: "next_open",
            allowSameBarExit: true,
            tradeDirection: "both",
            polymarketAnnotationEnabled: true,
        },
        requiresTsEngine: true,
        selectedStrategies: [{ key: "fixture", name: strategy.name, strategy }],
        capitalSettings: {
            initialCapital: 10000,
            positionSize: 100,
            commission: 0,
            sizingMode: "fixed",
            fixedTradeAmount: 1000,
        },
        generateParamSets: () => [{ threshold: 1 }],
    };
}

function stubSecondMarketFetch(rows = [quote(FIXTURE_ENTRY_TS, 0.30, 0.28), quote(FIXTURE_EXIT_TS, 0.60, 0.58)]): void {
    globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/sqlite/status") {
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.pathname === "/api/sqlite/load-polymarket-outcomes") {
            return new Response(JSON.stringify({
                ok: true,
                rows: [{
                    series_id: "10684",
                    event_slug: "btc-event",
                    market_slug: "btc-event",
                    interval: "5m",
                    event_start_ts: 1_700_000_000,
                    event_end_ts: 1_700_000_300,
                    yes_token_id: "yes",
                    no_token_id: "no",
                    yes_open_price: 0.5,
                    yes_entry_minute_1_price: null,
                    yes_entry_minute_2_price: null,
                    yes_entry_minute_3_price: null,
                    yes_entry_minute_4_price: null,
                    resolved_outcome_up: 1,
                    resolution_source: "test",
                    updated_at: 1,
                }],
            }), { status: 200 });
        }
        if (url.pathname === "/api/second-market/clob-quotes") {
            return new Response(JSON.stringify({ ok: true, quotes: rows }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url.pathname}`);
    };
}

describe("second market Finder runner", () => {
    it("loads 1s CLOB context once and supports signal-close signal-exit fills", async () => {
        let clobLoadCount = 0;
        globalThis.fetch = async (input) => {
            const url = new URL(String(input));
            if (url.pathname === "/api/sqlite/status") {
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            if (url.pathname === "/api/sqlite/load-polymarket-outcomes") {
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [{
                        series_id: "10684",
                        event_slug: "btc-event",
                        market_slug: "btc-event",
                        interval: "5m",
                        event_start_ts: 1_700_000_000,
                        event_end_ts: 1_700_000_300,
                        yes_token_id: "yes",
                        no_token_id: "no",
                        yes_open_price: 0.5,
                        yes_entry_minute_1_price: null,
                        yes_entry_minute_2_price: null,
                        yes_entry_minute_3_price: null,
                        yes_entry_minute_4_price: null,
                        resolved_outcome_up: 1,
                        resolution_source: "test",
                        updated_at: 1,
                    }],
                }), { status: 200 });
            }
            if (url.pathname === "/api/second-market/clob-quotes") {
                clobLoadCount++;
                return new Response(JSON.stringify({
                    ok: true,
                    quotes: [
                        quote(1_700_000_010, 0.20, 0.18),
                        quote(FIXTURE_ENTRY_TS, 0.55, 0.53),
                        quote(FIXTURE_START_TS + FIXTURE_EXIT_SIGNAL_INDEX, 0.30, 0.28),
                        quote(FIXTURE_EXIT_TS, 0.60, 0.58),
                        quote(FIXTURE_START_TS + 20, 0.65, 0.63),
                    ],
                    stats: {
                        distinctSeconds: 5,
                        missingSeconds: 0,
                        exactSampleCoveragePct: 100,
                        limit: 250000,
                        truncated: true,
                    },
                }), { status: 200 });
            }
            throw new Error(`Unexpected fetch ${url.pathname}`);
        };

        const input = makeInput();
        input.settings.executionModel = "signal_close";
        input.options.polymarketExitMode = "signal_exit_same_event";

        const statuses: string[] = [];
        const output = await runSecondMarketFinder(input, {
            setProgress: () => undefined,
            setStatus: (text) => statuses.push(text),
            yieldControl: async () => undefined,
            isCancelled: () => false,
            onResultsUpdate: () => undefined,
        });

        expect(clobLoadCount).to.equal(1);
        expect(output.results).to.have.length(1);
        expect(output.results[0]?.polymarketEval?.scoredPredictions).to.equal(1);
        expect(output.results[0]?.polymarketEval?.evaluationMode).to.equal("signal_exit_same_event");
        expect(output.results[0]?.polymarketEval?.expectancy).to.be.closeTo(0.03, 1e-9);
        expect(statuses.some((status) => status.includes("range truncated at 250000 quote rows"))).to.equal(true);
        expect(statuses.some((status) => status.includes("truncated quote range"))).to.equal(true);
        expect(statuses.at(-1)).to.contain("CLOB quote rows");
    });

    it("uses selected resolve-hold mode on supported 1s CLOB Finder runs", async () => {
        globalThis.fetch = async (input) => {
            const url = new URL(String(input));
            if (url.pathname === "/api/sqlite/status") {
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            if (url.pathname === "/api/sqlite/load-polymarket-outcomes") {
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [{
                        series_id: "10684",
                        event_slug: "btc-event",
                        market_slug: "btc-event",
                        interval: "5m",
                        event_start_ts: 1_700_000_000,
                        event_end_ts: 1_700_000_300,
                        yes_token_id: "yes",
                        no_token_id: "no",
                        yes_open_price: 0.5,
                        yes_entry_minute_1_price: null,
                        yes_entry_minute_2_price: null,
                        yes_entry_minute_3_price: null,
                        yes_entry_minute_4_price: null,
                        resolved_outcome_up: 1,
                        resolution_source: "test",
                        updated_at: 1,
                    }],
                }), { status: 200 });
            }
            if (url.pathname === "/api/second-market/clob-quotes") {
                return new Response(JSON.stringify({
                    ok: true,
                    quotes: [
                        quote(FIXTURE_ENTRY_TS, 0.30, 0.28),
                        quote(FIXTURE_EXIT_TS, 0.60, 0.58),
                    ],
                }), { status: 200 });
            }
            throw new Error(`Unexpected fetch ${url.pathname}`);
        };

        const output = await runSecondMarketFinder(makeInput(), {
            setProgress: () => undefined,
            setStatus: () => undefined,
            yieldControl: async () => undefined,
            isCancelled: () => false,
            onResultsUpdate: () => undefined,
        });

        expect(output.results).to.have.length(1);
        expect(output.results[0]?.polymarketEval?.evaluationMode).to.equal("resolve_hold");
        expect(output.results[0]?.polymarketEval?.expectancy).to.be.closeTo(0.70, 1e-9);
        expect(output.results[0]?.polymarketEval?.breakEvenWinRate).to.equal(0.30);
    });

    it("includes backtest diagnostics for entry-strategy second-market Finder runs", async () => {
        globalThis.fetch = async (input) => {
            const url = new URL(String(input));
            if (url.pathname === "/api/sqlite/status") {
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            if (url.pathname === "/api/sqlite/load-polymarket-outcomes") {
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [{
                        series_id: "10684",
                        event_slug: "btc-event",
                        market_slug: "btc-event",
                        interval: "5m",
                        event_start_ts: 1_700_000_000,
                        event_end_ts: 1_700_000_300,
                        yes_token_id: "yes",
                        no_token_id: "no",
                        yes_open_price: 0.5,
                        yes_entry_minute_1_price: null,
                        yes_entry_minute_2_price: null,
                        yes_entry_minute_3_price: null,
                        yes_entry_minute_4_price: null,
                        resolved_outcome_up: 1,
                        resolution_source: "test",
                        updated_at: 1,
                    }],
                }), { status: 200 });
            }
            if (url.pathname === "/api/second-market/clob-quotes") {
                return new Response(JSON.stringify({
                    ok: true,
                    quotes: [
                        quote(FIXTURE_ENTRY_TS, 0.30, 0.28),
                        quote(FIXTURE_EXIT_TS, 0.60, 0.58),
                    ],
                }), { status: 200 });
            }
            throw new Error(`Unexpected fetch ${url.pathname}`);
        };

        const entryStrategy: Strategy = {
            name: "Entry Diagnostics Fixture",
            description: "fixture",
            defaultParams: { threshold: 1 },
            paramLabels: { threshold: "Threshold" },
            metadata: { role: "entry", direction: "both" },
            execute(data) {
                const exitIndex = Math.min(FIXTURE_EXIT_SIGNAL_INDEX, data.length - 1);
                return [
                    { time: data[0]!.time, type: "buy", price: data[0]!.close },
                    { time: data[exitIndex]!.time, type: "sell", price: data[exitIndex]!.close },
                ];
            },
            evaluate(_data, _params, signals = []) {
                return {
                    signals,
                    entryStats: {
                        mode: "fan_retest",
                        winDefinition: "target",
                        targetPct: 1,
                        totalEntries: signals.length,
                        wins: 1,
                        losses: 1,
                        winRate: 50,
                        avgRetestBars: 1,
                        avgRetests: 1,
                        maxBars: 3,
                        maxRetests: 1,
                        minRetestsForWin: 1,
                        entryMode: 1,
                        retestMode: 1,
                        useWick: false,
                        touchTolerancePct: 0,
                    },
                };
            },
        };
        const input = makeInput();
        input.selectedStrategies = [{ key: "entry_fixture", name: entryStrategy.name, strategy: entryStrategy }];

        const output = await runSecondMarketFinder(input, {
            setProgress: () => undefined,
            setStatus: () => undefined,
            yieldControl: async () => undefined,
            isCancelled: () => false,
            onResultsUpdate: () => undefined,
        });

        expect(output.diagnostics?.backtest?.runs).to.equal(1);
        expect(output.diagnostics?.backtest?.avgInputSignals).to.equal(2);
        expect(output.diagnostics?.backtest?.totals.entriesAttempted).to.equal(2);
        expect(Number.isFinite(output.diagnostics?.backtest?.fastPathRuns)).to.equal(true);
        expect(Number.isFinite(output.diagnostics?.backtest?.totals.fastPathRuns)).to.equal(true);
        expect(output.diagnostics?.backtest?.timingsMs).to.have.property("entryEvaluation");
        expect(output.diagnostics?.strategyBreakdown[0]?.backtest?.runs).to.equal(1);
    });

    it("uses the combined-direction side fast path for 1s CLOB Finder trade scoring", async () => {
        stubSecondMarketFetch();
        const input = makeInput();
        input.settings.tradeDirection = "combined";

        const output = await runSecondMarketFinder(input, {
            setProgress: () => undefined,
            setStatus: () => undefined,
            yieldControl: async () => undefined,
            isCancelled: () => false,
            onResultsUpdate: () => undefined,
        });

        expect(output.results).to.have.length(1);
        expect(output.diagnostics?.backtest?.fastPathRuns).to.equal(1);
        expect(output.diagnostics?.backtest?.fastPathBlockers).to.equal(undefined);
        expect(output.diagnostics?.backtest?.avgBarsScanned).to.be.lessThan(candles().length * 2);
        expect(output.diagnostics?.backtest?.avgTradesClosed).to.be.greaterThan(0);
    });

    it("does not count pre-gap 1s candles toward Finder strategy lookbacks", async () => {
        stubSecondMarketFetch([quote(FIXTURE_START_TS + 3601, 0.30, 0.28)]);
        const lookbackStrategy: Strategy = {
            name: "Gap Lookback Fixture",
            description: "fixture",
            defaultParams: { lookback: 4 },
            paramLabels: { lookback: "Lookback" },
            execute(data, params) {
                const lookback = Math.max(1, Math.floor(Number(params.lookback ?? 4)));
                if (data.length <= lookback) return [];
                return [
                    { time: data[lookback - 1]!.time, type: "buy", price: data[lookback - 1]!.close, barIndex: lookback - 1 },
                    { time: data[lookback]!.time, type: "sell", price: data[lookback]!.close, barIndex: lookback },
                ];
            },
        };
        const input = makeInput();
        input.ohlcvData = [
            { time: FIXTURE_START_TS as OHLCVData["time"], open: 100, high: 101, low: 99, close: 100, volume: 1 },
            { time: (FIXTURE_START_TS + 1) as OHLCVData["time"], open: 101, high: 102, low: 100, close: 101, volume: 1 },
            { time: (FIXTURE_START_TS + 2) as OHLCVData["time"], open: 102, high: 103, low: 101, close: 102, volume: 1 },
            { time: (FIXTURE_START_TS + 3600) as OHLCVData["time"], open: 103, high: 104, low: 102, close: 103, volume: 1 },
            { time: (FIXTURE_START_TS + 3601) as OHLCVData["time"], open: 104, high: 105, low: 103, close: 104, volume: 1 },
            { time: (FIXTURE_START_TS + 3602) as OHLCVData["time"], open: 105, high: 106, low: 104, close: 105, volume: 1 },
        ];
        input.selectedStrategies = [{ key: "gap_lookback_fixture", name: lookbackStrategy.name, strategy: lookbackStrategy }];
        input.generateParamSets = () => [{ lookback: 4 }];

        const output = await runSecondMarketFinder(input, {
            setProgress: () => undefined,
            setStatus: () => undefined,
            yieldControl: async () => undefined,
            isCancelled: () => false,
            onResultsUpdate: () => undefined,
        });

        const strategyDiagnostics = output.diagnostics?.strategyBreakdown.find((item) => item.key === "gap_lookback_fixture");
        // Zero-signal runs skip backtest + evaluation, so no result is produced.
        expect(output.results.length).to.equal(0);
        expect(strategyDiagnostics?.runs).to.equal(1);
        expect(strategyDiagnostics?.zeroSignalRuns).to.equal(1);
    });

    it("reports zero-signal second-market Finder runs", async () => {
        stubSecondMarketFetch();
        const noSignalStrategy: Strategy = {
            name: "No Signal Fixture",
            description: "fixture",
            defaultParams: { threshold: 1 },
            paramLabels: { threshold: "Threshold" },
            execute: () => [],
        };
        const input = makeInput();
        input.selectedStrategies = [{ key: "no_signal_fixture", name: noSignalStrategy.name, strategy: noSignalStrategy }];

        const output = await runSecondMarketFinder(input, {
            setProgress: () => undefined,
            setStatus: () => undefined,
            yieldControl: async () => undefined,
            isCancelled: () => false,
            onResultsUpdate: () => undefined,
        });

        const diagnostics = output.diagnostics;
        const strategyDiagnostics = diagnostics?.strategyBreakdown.find((item) => item.key === "no_signal_fixture");
        expect(strategyDiagnostics?.zeroSignalRuns).to.equal(1);
        expect(strategyDiagnostics?.totalMs).to.be.greaterThanOrEqual(0);
        expect(strategyDiagnostics?.runtimePct).to.be.greaterThanOrEqual(0);
        expect(diagnostics?.timingPct.signalGeneration).to.be.greaterThanOrEqual(0);
        expect(diagnostics?.bottlenecks.some((item) => item.includes("produced zero signals"))).to.equal(true);
    });

    it("skips remaining params after a fatal strategy dependency failure", async () => {
        stubSecondMarketFetch();
        const failingStrategy: Strategy = {
            name: "Fatal Import Fixture",
            description: "fixture",
            defaultParams: { threshold: 1 },
            paramLabels: { threshold: "Threshold" },
            execute: () => {
                throw new Error("Check dependency list! Synchronous require cannot resolve module '../time-normalization'.");
            },
        };
        const input = makeInput();
        input.selectedStrategies = [{ key: "fatal_import_fixture", name: failingStrategy.name, strategy: failingStrategy }];
        input.generateParamSets = () => [{ threshold: 1 }, { threshold: 2 }, { threshold: 3 }];
        const statuses: string[] = [];

        const output = await runSecondMarketFinder(input, {
            setProgress: () => undefined,
            setStatus: (text) => statuses.push(text),
            yieldControl: async () => undefined,
            isCancelled: () => false,
            onResultsUpdate: () => undefined,
        });

        const diagnostics = output.diagnostics;
        const strategyDiagnostics = diagnostics?.strategyBreakdown.find((item) => item.key === "fatal_import_fixture");
        expect(output.results).to.deep.equal([]);
        expect(diagnostics?.counts.processedRuns).to.equal(3);
        expect(diagnostics?.counts.failedRuns).to.equal(1);
        expect(diagnostics?.counts.skippedRuns).to.equal(2);
        expect(strategyDiagnostics?.runs).to.equal(1);
        expect(strategyDiagnostics?.failedRuns).to.equal(1);
        expect(strategyDiagnostics?.skippedRuns).to.equal(2);
        expect(diagnostics?.failureBreakdown?.[0]?.runs).to.equal(1);
        expect(statuses.at(-1)).to.contain("2 skipped");
        expect(diagnostics?.bottlenecks.some((item) => item.includes("fatal strategy failure"))).to.equal(true);
    });

    it("rejects 1s CLOB scoring for unsupported execution models", async () => {
        let fetchCount = 0;
        globalThis.fetch = async () => {
            fetchCount++;
            throw new Error("fetch should not be called before execution gating");
        };

        const input = makeInput();
        (input.settings as any).executionModel = "same_bar_open";

        const statuses: string[] = [];
        const output = await runSecondMarketFinder(input, {
            setProgress: () => undefined,
            setStatus: (text) => statuses.push(text),
            yieldControl: async () => undefined,
            isCancelled: () => false,
            onResultsUpdate: () => undefined,
        });

        expect(output.results).to.deep.equal([]);
        expect(fetchCount).to.equal(0);
        expect(statuses.at(-1)).to.equal("1s CLOB Polymarket scoring requires signal_close, next_open, or next_close execution model.");
    });

    it("applies post-signal limit entry settings in 1s CLOB scoring", async () => {
        globalThis.fetch = async (input) => {
            const url = new URL(String(input));
            if (url.pathname === "/api/sqlite/status") {
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            if (url.pathname === "/api/sqlite/load-polymarket-outcomes") {
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [{
                        series_id: "10684",
                        event_slug: "btc-event",
                        market_slug: "btc-event",
                        interval: "5m",
                        event_start_ts: 1_700_000_000,
                        event_end_ts: 1_700_000_300,
                        yes_token_id: "yes",
                        no_token_id: "no",
                        yes_open_price: 0.5,
                        yes_entry_minute_1_price: null,
                        yes_entry_minute_2_price: null,
                        yes_entry_minute_3_price: null,
                        yes_entry_minute_4_price: null,
                        resolved_outcome_up: 1,
                        resolution_source: "test",
                        updated_at: 1,
                    }],
                }), { status: 200 });
            }
            if (url.pathname === "/api/second-market/clob-quotes") {
                return new Response(JSON.stringify({
                    ok: true,
                    quotes: [
                        quote(FIXTURE_START_TS, 0.62, 0.60),
                        quote(FIXTURE_ENTRY_TS, 0.62, 0.60),
                        quote(FIXTURE_ENTRY_TS + 4, 0.50, 0.48),
                        quote(FIXTURE_EXIT_TS, 0.60, 0.58),
                    ],
                }), { status: 200 });
            }
            throw new Error(`Unexpected fetch ${url.pathname}`);
        };

        const input = makeInput();
        input.options.polymarketExitMode = "signal_exit_same_event";
        input.settings.polymarketPostSignalLimitEntryEnabled = true;
        input.settings.polymarketPostSignalLimitEntryPriceCents = 50;

        const output = await runSecondMarketFinder(input, {
            setProgress: () => undefined,
            setStatus: () => undefined,
            yieldControl: async () => undefined,
            isCancelled: () => false,
            onResultsUpdate: () => undefined,
        });

        expect(output.results).to.have.length(1);
        expect(output.results[0]?.polymarketEval?.limitEntryEnabled).to.equal(true);
        expect(output.results[0]?.polymarketEval?.limitEntryFilledTrades).to.equal(1);
        expect(output.results[0]?.polymarketEval?.expectancy).to.be.closeTo(0.08, 1e-9);
    });
});
