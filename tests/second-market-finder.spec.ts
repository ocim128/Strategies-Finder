import { afterEach, describe, it } from "node:test";
import { expect } from "chai";
import { runSecondMarketFinder } from "../lib/second-market/finder-runner";
import { resetLocalSqlitePolymarketApiAvailabilityForTests } from "../lib/local-sqlite-polymarket-api";
import type { FinderRunInput } from "../lib/finder/finder-runner";
import type { PolymarketClob1sQuoteRow } from "../lib/second-market/types";
import type { OHLCVData, Strategy } from "../lib/types/strategies";

const originalFetch = globalThis.fetch;

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
    return [
        { time: 1_700_000_010 as OHLCVData["time"], open: 100, high: 101, low: 99, close: 100, volume: 1 },
        { time: 1_700_000_020 as OHLCVData["time"], open: 100, high: 102, low: 100, close: 101, volume: 1 },
        { time: 1_700_000_030 as OHLCVData["time"], open: 101, high: 102, low: 100, close: 101, volume: 1 },
    ];
}

const strategy: Strategy = {
    name: "Second Market Finder Fixture",
    description: "fixture",
    defaultParams: { threshold: 1 },
    paramLabels: { threshold: "Threshold" },
    execute(data) {
        return [
            { time: data[0]!.time, type: "buy", price: data[0]!.close },
            { time: data[1]!.time, type: "sell", price: data[1]!.close },
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
            executionModel: "signal_close",
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
        getFinderTimeframesForRun: () => ["1s"],
        loadMultiTimeframeDatasets: async () => [],
        generateParamSets: () => [{ threshold: 1 }],
        buildRandomConfirmationParams: () => ({}),
    };
}

describe("second market Finder runner", () => {
    it("loads 1s CLOB context once and ranks candidates from strict CLOB fills", async () => {
        let clobLoadCount = 0;
        globalThis.fetch = async (input) => {
            const url = new URL(String(input));
            if (url.pathname === "/api/sqlite/status") {
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            if (url.pathname === "/api/sqlite/load-polymarket-outcomes") {
                return new Response(JSON.stringify({ ok: true, rows: [] }), { status: 200 });
            }
            if (url.pathname === "/api/second-market/clob-quotes") {
                clobLoadCount++;
                return new Response(JSON.stringify({
                    ok: true,
                    quotes: [
                        quote(1_700_000_010, 0.55, 0.53),
                        quote(1_700_000_020, 0.60, 0.58),
                    ],
                }), { status: 200 });
            }
            throw new Error(`Unexpected fetch ${url.pathname}`);
        };

        const statuses: string[] = [];
        const output = await runSecondMarketFinder(makeInput(), {
            setProgress: () => undefined,
            setStatus: (text) => statuses.push(text),
            yieldControl: async () => undefined,
            isCancelled: () => false,
            onResultsUpdate: () => undefined,
        });

        expect(clobLoadCount).to.equal(1);
        expect(output.results).to.have.length(1);
        expect(output.results[0]?.polymarketEval?.scoredPredictions).to.equal(1);
        expect(output.results[0]?.polymarketEval?.expectancy).to.be.closeTo(0.03, 1e-9);
        expect(statuses.at(-1)).to.contain("CLOB quote rows");
    });
});
