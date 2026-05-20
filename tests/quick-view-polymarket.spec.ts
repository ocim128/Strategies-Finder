import { expect } from "chai";
import { afterEach, describe, it } from "node:test";
import {
    countDistinctPolymarketOutcomeRows,
    computePolymarketBestBaselineWinRate,
    getQuickViewDiagnosticSections,
    quickViewManager,
    summarizePolymarketExecutionGap,
    summarizePolymarketExpectancyAfterTakeProfit,
    summarizePolymarketExitReasonWinRates,
    summarizePolymarketPayoutDiagnostics,
    summarizePolymarketStreaks,
    summarizeRecentPolymarketForm,
} from "../lib/quick-view";
import { resetLocalSqlitePolymarketApiAvailabilityForTests } from "../lib/local-sqlite-polymarket-api";
import { state } from "../lib/state";
import type { BacktestResult, Trade } from "../lib/strategies/index";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_DOCUMENT = (globalThis as { document?: Document }).document;
const ORIGINAL_HTML_SELECT_ELEMENT = (globalThis as { HTMLSelectElement?: typeof HTMLSelectElement }).HTMLSelectElement;

function makeTrade(id: number, isWin: boolean | null, overrides: Partial<Trade> = {}): Trade {
    return {
        id,
        type: "long",
        entryTime: 1_700_000_000 + id * 300,
        entryPrice: 30_000,
        exitTime: 1_700_000_300 + id * 300,
        exitPrice: 30_100,
        pnl: isWin === false ? -10 : 10,
        pnlPercent: isWin === false ? -0.3 : 0.3,
        size: 1,
        exitReason: "signal",
        polymarketOutcome: isWin === null ? null : {
            eventStartTs: 1_700_000_000 + id * 300,
            eventEndTs: 1_700_000_300 + id * 300,
            eventSlug: `event-${id}`,
            marketSlug: `market-${id}`,
            prediction: "yes",
            actualOutcomeUp: isWin ? 1 : 0,
            isWin,
            marketEntryPrice: 0.5,
        },
        ...overrides,
    };
}

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    resetLocalSqlitePolymarketApiAvailabilityForTests();
    state.currentBacktestResult = null;
    if (typeof ORIGINAL_HTML_SELECT_ELEMENT === "undefined") {
        delete (globalThis as { HTMLSelectElement?: typeof HTMLSelectElement }).HTMLSelectElement;
    } else {
        (globalThis as { HTMLSelectElement?: typeof HTMLSelectElement }).HTMLSelectElement = ORIGINAL_HTML_SELECT_ELEMENT;
    }
    if (typeof ORIGINAL_DOCUMENT === "undefined") {
        delete (globalThis as { document?: Document }).document;
        return;
    }
    (globalThis as { document?: Document }).document = ORIGINAL_DOCUMENT;
});

describe("Quick View Polymarket streak summary", () => {
    it("counts longest win and loss streaks and breaks on missing outcomes", () => {
        const trades = [
            makeTrade(1, true),
            makeTrade(2, true),
            makeTrade(3, false),
            makeTrade(4, false),
            makeTrade(5, false),
            makeTrade(6, null),
            makeTrade(7, true),
            makeTrade(8, true),
            makeTrade(9, true),
            makeTrade(10, false),
        ];

        const summary = summarizePolymarketStreaks(trades);

        expect(summary.longestWinStreak).to.equal(3);
        expect(summary.longestLossStreak).to.equal(3);
    });

    it("summarizes recent form from the latest scored trades only", () => {
        const trades = [
            makeTrade(1, true),
            makeTrade(2, null),
            makeTrade(3, false),
            makeTrade(4, true),
            makeTrade(5, true),
            makeTrade(6, false),
        ];

        const summary = summarizeRecentPolymarketForm(trades, 4);

        expect(summary.recentFormTrades).to.equal(4);
        expect(summary.recentFormWins).to.equal(2);
        expect(summary.recentFormLosses).to.equal(2);
        expect(summary.recentFormWinRate).to.equal(0.5);
    });

    it("summarizes entry win rate by the previous closed trade exit reason", () => {
        const summary = summarizePolymarketExitReasonWinRates([
            makeTrade(1, true, { exitReason: "time_stop" }),
            makeTrade(2, false, { exitReason: "take_profit" }),
            makeTrade(3, true, { exitReason: "signal" }),
            makeTrade(4, false, { exitReason: "time_stop" }),
            makeTrade(5, true, { exitReason: "time_stop" }),
            makeTrade(6, null, { exitReason: "signal" }),
            makeTrade(7, true, { exitReason: "end_of_data" }),
        ]);

        expect(summary.maxHold.trades).to.equal(2);
        expect(summary.maxHold.wins).to.equal(1);
        expect(summary.maxHold.losses).to.equal(1);
        expect(summary.maxHold.winRate).to.equal(0.5);

        expect(summary.takeProfit.trades).to.equal(1);
        expect(summary.takeProfit.wins).to.equal(1);
        expect(summary.takeProfit.losses).to.equal(0);
        expect(summary.takeProfit.winRate).to.equal(1);

        expect(summary.signal.trades).to.equal(2);
        expect(summary.signal.wins).to.equal(1);
        expect(summary.signal.losses).to.equal(1);
        expect(summary.signal.winRate).to.equal(0.5);
    });

    it("summarizes entry expectancy after the previous trade exited by tp", () => {
        const summary = summarizePolymarketExpectancyAfterTakeProfit([
            makeTrade(1, true, {
                exitReason: "take_profit",
                polymarketOutcome: {
                    ...makeTrade(1, true).polymarketOutcome!,
                    marketEntryPrice: 0.45,
                },
            }),
            makeTrade(2, true, {
                exitReason: "signal",
                polymarketOutcome: {
                    ...makeTrade(2, true).polymarketOutcome!,
                    marketEntryPrice: 0.30,
                },
            }),
            makeTrade(3, false, {
                exitReason: "take_profit",
                polymarketOutcome: {
                    ...makeTrade(3, false).polymarketOutcome!,
                    marketEntryPrice: 0.60,
                },
            }),
            makeTrade(4, false, {
                exitReason: "signal",
                polymarketOutcome: {
                    ...makeTrade(4, false).polymarketOutcome!,
                    marketEntryPrice: 0.70,
                },
            }),
            makeTrade(5, true, {
                exitReason: "signal",
                polymarketOutcome: {
                    ...makeTrade(5, true).polymarketOutcome!,
                    marketEntryPrice: null,
                },
            }),
        ]);

        expect(summary.pricedTrades).to.equal(2);
        expect(summary.expectancy).to.be.closeTo(0, 1e-12);
    });

    it("computes the best naive baseline from scored trade outcomes", () => {
        const trades = [
            makeTrade(1, true),
            makeTrade(2, true),
            makeTrade(3, false),
            makeTrade(4, true),
            makeTrade(5, null),
        ];

        const baseline = computePolymarketBestBaselineWinRate(trades);

        expect(baseline).to.equal(0.75);
    });

    it("computes best win streak on the last 100 trades slice", () => {
        const trades: Trade[] = [];
        for (let i = 1; i <= 110; i++) {
            trades.push(makeTrade(i, i <= 10 ? true : false));
        }
        for (let i = 106; i <= 110; i++) {
            trades[i - 1] = makeTrade(i, true);
        }

        const summary = summarizePolymarketStreaks(trades.slice(-100));

        expect(summary.longestWinStreak).to.equal(5);
    });

    it("counts distinct annotated outcome rows instead of defaulting to zero", () => {
        const trades = [
            makeTrade(1, true),
            makeTrade(2, false),
            {
                ...makeTrade(3, true),
                polymarketOutcome: {
                    ...makeTrade(1, true).polymarketOutcome!,
                    isWin: true,
                },
            },
            makeTrade(4, null),
        ];

        expect(countDistinctPolymarketOutcomeRows(trades)).to.equal(2);
    });

    it("keeps only execution diagnostics in Quick View", () => {
        const result = {
            trades: [],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            expectancyBreakdown: {
                sections: [
                    { id: "side", title: "By Side", hint: "", rows: [] },
                    { id: "session_minute", title: "By 5m Session Minute", hint: "", rows: [] },
                    { id: "price_range_position", title: "By Entry Range Position", hint: "", rows: [] },
                ],
            },
        } satisfies BacktestResult;

        expect(getQuickViewDiagnosticSections(result).map((section) => section.id)).to.deep.equal([
            "session_minute",
            "price_range_position",
        ]);
    });

    it("summarizes polymarket payout expectancy from entry prices", () => {
        const summary = summarizePolymarketPayoutDiagnostics([
            makeTrade(1, true, {
                polymarketOutcome: {
                    ...makeTrade(1, true).polymarketOutcome!,
                    marketEntryPrice: 0.4,
                },
            }),
            makeTrade(2, false, {
                polymarketOutcome: {
                    ...makeTrade(2, false).polymarketOutcome!,
                    marketEntryPrice: 0.6,
                },
            }),
        ]);

        expect(summary).to.not.equal(null);
        expect(summary?.pricedTrades).to.equal(2);
        expect(summary?.unpricedScoredTrades).to.equal(0);
        expect(summary?.avgEntryPrice).to.equal(0.5);
        expect(summary?.breakEvenWinRate).to.equal(0.5);
        expect(summary?.winRate).to.equal(0.5);
        expect(summary?.expectancy).to.equal(0);
        expect(summary?.profitFactor).to.equal(1);
        expect(summary?.edgeVsBreakEven).to.equal(0);
    });

    it("uses realized target-exit market pnl in payout summaries", () => {
        const summary = summarizePolymarketPayoutDiagnostics([
            makeTrade(1, false, {
                polymarketOutcome: {
                    ...makeTrade(1, false).polymarketOutcome!,
                    marketEntryPrice: 0.6,
                    marketExitPrice: 0.8,
                    marketExitSource: "target",
                    marketPnl: 0.2,
                    isProfitable: true,
                },
            }),
        ]);

        expect(summary).to.not.equal(null);
        expect(summary?.winRate).to.equal(1);
        expect(summary?.expectancy).to.be.closeTo(0.2, 1e-12);
        expect(summary?.profitFactor).to.equal(Infinity);
    });

    it("keeps unpriced scored trades out of payout maths but reports the exclusion", () => {
        const summary = summarizePolymarketPayoutDiagnostics([
            makeTrade(1, true, {
                polymarketOutcome: {
                    ...makeTrade(1, true).polymarketOutcome!,
                    marketEntryPrice: 0.4,
                },
            }),
            makeTrade(2, false, {
                polymarketOutcome: {
                    ...makeTrade(2, false).polymarketOutcome!,
                    marketEntryPrice: null,
                },
            }),
        ]);

        expect(summary).to.not.equal(null);
        expect(summary?.pricedTrades).to.equal(1);
        expect(summary?.unpricedScoredTrades).to.equal(1);
        expect(summary?.winRate).to.equal(1);
        expect(summary?.expectancy).to.equal(0.6);
        expect(summary?.profitFactor).to.equal(Infinity);
    });

    it("keeps short NO entries at the paid NO price in payout summaries", () => {
        const summary = summarizePolymarketPayoutDiagnostics([
            makeTrade(1, true, {
                type: "short",
                polymarketOutcome: {
                    eventStartTs: 1_700_000_300,
                    eventEndTs: 1_700_000_600,
                    eventSlug: "event-1",
                    marketSlug: "market-1",
                    prediction: "no",
                    actualOutcomeUp: 0,
                    isWin: true,
                    marketEntryPrice: 0.9,
                },
            }),
        ]);

        expect(summary).to.not.equal(null);
        expect(summary?.pricedTrades).to.equal(1);
        expect(summary?.avgEntryPrice).to.equal(0.9);
        expect(summary?.breakEvenWinRate).to.equal(0.9);
        expect(summary?.winRate).to.equal(1);
        expect(summary?.expectancy).to.be.closeTo(0.1, 1e-12);
        expect(summary?.profitFactor).to.equal(Infinity);
        expect(summary?.edgeVsBreakEven).to.be.closeTo(0.1, 1e-12);
    });

    it("builds quick view sections from polymarket payout instead of binance pnl when priced trades exist", () => {
        const result = {
            trades: [
                makeTrade(1, true, {
                    entryTime: 1_699_999_800,
                    pnl: -100,
                    polymarketOutcome: {
                        ...makeTrade(1, true).polymarketOutcome!,
                        marketEntryPrice: 0.4,
                    },
                    entrySnapshot: { priceRangePos: 0.9 },
                }),
                makeTrade(2, false, {
                    entryTime: 1_699_999_860,
                    pnl: 100,
                    polymarketOutcome: {
                        ...makeTrade(2, false).polymarketOutcome!,
                        marketEntryPrice: 0.2,
                    },
                    entrySnapshot: { priceRangePos: 0.1 },
                }),
            ],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 2,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            expectancyBreakdown: {
                sections: [
                    { id: "session_minute", title: "By 5m Session Minute", hint: "", rows: [] },
                    { id: "price_range_position", title: "By Entry Range Position", hint: "", rows: [] },
                ],
            },
        } satisfies BacktestResult;

        const sections = getQuickViewDiagnosticSections(result);
        const minute0 = sections[0]?.rows.find((row) => row.label === "Minute 0");
        const minute1 = sections[0]?.rows.find((row) => row.label === "Minute 1");

        expect(sections.map((section) => section.id)).to.deep.equal(["session_minute"]);
        expect(minute0?.expectancy).to.equal(0.6);
        expect(minute1?.expectancy).to.equal(-0.2);
    });

    it("shows resolve-hold Polymarket expectancy in the Quick View performance cards", () => {
        const content = { style: { display: "" }, innerHTML: "" };
        const empty = { style: { display: "" } };
        (globalThis as { document?: Document }).document = {
            getElementById: (id: string) => {
                if (id === "qvStatsContent") return content as unknown as HTMLElement;
                if (id === "qvEmpty") return empty as unknown as HTMLElement;
                return null;
            },
        } as Document;

        (quickViewManager as any).renderResults({
            trades: [
                makeTrade(1, true, {
                    pnl: -100,
                    polymarketOutcome: {
                        ...makeTrade(1, true).polymarketOutcome!,
                        evaluationMode: "resolve_hold",
                        marketEntryPrice: 0.55,
                        marketExitPrice: 1,
                        marketExitSource: "resolution",
                        marketPnl: 0.45,
                    },
                }),
            ],
            netProfit: -100,
            netProfitPercent: -1,
            winRate: 0,
            expectancy: -100,
            avgTrade: -100,
            profitFactor: 0,
            maxDrawdown: 100,
            maxDrawdownPercent: 1,
            totalTrades: 1,
            winningTrades: 0,
            losingTrades: 1,
            avgWin: 0,
            avgLoss: -100,
            sharpeRatio: 0,
            equityCurve: [],
            marketContext: {
                symbol: "BTCUSDT",
                interval: "5m",
            },
            polymarketTradeSummary: {
                seriesId: "10684",
                outcomeInterval: "5m",
                outcomeRowsLoaded: 1,
                scoredTrades: 1,
                missingOutcomeTrades: 0,
                unscoredTrades: 0,
                evaluationMode: "resolve_hold",
                resolvedTrades: 1,
            },
        } satisfies BacktestResult);

        expect(content.innerHTML).to.contain("Polymarket Exp / Trade");
        expect(content.innerHTML).to.contain("+45.0c");
        expect(content.innerHTML).to.contain("Resolve Hold (final outcome)");
    });

    it("falls back to resolve-hold summary expectancy when Quick View has no priced trade rows", () => {
        const content = { style: { display: "" }, innerHTML: "" };
        const empty = { style: { display: "" } };
        (globalThis as { document?: Document }).document = {
            getElementById: (id: string) => {
                if (id === "qvStatsContent") return content as unknown as HTMLElement;
                if (id === "qvEmpty") return empty as unknown as HTMLElement;
                return null;
            },
        } as Document;

        (quickViewManager as any).renderResults({
            trades: [
                makeTrade(1, null, { polymarketOutcome: undefined }),
            ],
            netProfit: -100,
            netProfitPercent: -1,
            winRate: 0,
            expectancy: -100,
            avgTrade: -100,
            profitFactor: 0,
            maxDrawdown: 100,
            maxDrawdownPercent: 1,
            totalTrades: 1,
            winningTrades: 0,
            losingTrades: 1,
            avgWin: 0,
            avgLoss: -100,
            sharpeRatio: 0,
            equityCurve: [],
            marketContext: {
                symbol: "BTCUSDT",
                interval: "5m",
            },
            polymarketTradeSummary: {
                seriesId: "10684",
                outcomeInterval: "5m",
                outcomeRowsLoaded: 1,
                scoredTrades: 1,
                missingOutcomeTrades: 0,
                unscoredTrades: 0,
                evaluationMode: "resolve_hold",
                resolvedTrades: 1,
                expectancy: 0.45,
                profitFactor: Infinity,
            },
        } satisfies BacktestResult);

        expect(content.innerHTML).to.contain("Polymarket Exp / Trade");
        expect(content.innerHTML).to.contain("+45.0c");
    });

    it("labels native 5m runs as observed minute buckets instead of selected offsets", () => {
        const result = {
            trades: [
                makeTrade(1, true, {
                    entryTime: 1_700_000_000,
                    polymarketOutcome: {
                        ...makeTrade(1, true).polymarketOutcome!,
                        marketEntryPrice: 0.45,
                    },
                }),
            ],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 1,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            expectancyBreakdown: {
                sections: [
                    { id: "session_minute", title: "By 5m Session Minute", hint: "", rows: [] },
                    { id: "price_range_position", title: "By Entry Range Position", hint: "", rows: [] },
                ],
            },
            polymarketTradeSummary: {
                seriesId: "btc-5m",
                outcomeRowsLoaded: 1,
                scoredTrades: 1,
                missingOutcomeTrades: 0,
                unscoredTrades: 0,
            },
        } satisfies BacktestResult;

        const [minuteSection] = getQuickViewDiagnosticSections(result);

        expect(minuteSection?.title).to.equal("Observed 5m Session Minute");
        expect(minuteSection?.hint).to.contain("native 5m Polymarket session scoring");
    });

    it("labels native 15m runs as native session scoring in Quick View", () => {
        const html = (quickViewManager as any).buildPolymarketSection({
            trades: [
                makeTrade(1, true, {
                    polymarketOutcome: {
                        ...makeTrade(1, true).polymarketOutcome!,
                        entryOffset: 10,
                        marketEntryPrice: 0.41,
                    },
                }),
            ],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 1,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            polymarketTradeSummary: {
                seriesId: "btc-15m",
                outcomeInterval: "15m",
                outcomeRowsLoaded: 1,
                scoredTrades: 1,
                missingOutcomeTrades: 0,
                unscoredTrades: 0,
            },
        } satisfies BacktestResult);

        expect(html).to.contain("Run Mode: Native 15m scoring");
        expect(html).to.not.contain("Selected Offset: Minute 10");
    });

    it("rebuilds native 15m polymarket outcomes before rendering Quick View", async () => {
        const eventStartTs = 1_700_000_000;
        const entryTime = eventStartTs + 600;
        (globalThis as { HTMLSelectElement?: typeof HTMLSelectElement }).HTMLSelectElement = class {} as typeof HTMLSelectElement;
        (globalThis as { document?: Document }).document = {
            getElementById: () => null,
        } as Document;

        globalThis.fetch = (async (input) => {
            const url = new URL(
                typeof input === "string"
                    ? input
                    : input instanceof URL
                        ? input.toString()
                        : input.url,
                "http://localhost"
            );

            if (url.pathname === "/api/sqlite/status") {
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/load-polymarket-outcomes") {
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [{
                        series_id: "10422",
                        event_slug: "xrp-15m-1",
                        market_slug: "xrp-15m-1",
                        interval: "15m",
                        event_start_ts: eventStartTs,
                        event_end_ts: eventStartTs + 900,
                        yes_token_id: "yes-1",
                        no_token_id: "no-1",
                        yes_open_price: 0.48,
                        yes_entry_minute_1_price: 0.49,
                        yes_entry_minute_2_price: 0.5,
                        yes_entry_minute_3_price: 0.51,
                        yes_entry_minute_4_price: 0.52,
                        resolved_outcome_up: 1,
                        resolution_source: "test",
                        updated_at: 1,
                    }],
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            throw new Error(`Unexpected URL ${url.pathname}`);
        }) as typeof fetch;

        const enriched = await (quickViewManager as any).ensurePolymarketOutcomes({
            trades: [
                makeTrade(1, true, {
                    entryTime,
                    exitTime: entryTime + 60,
                    polymarketOutcome: undefined,
                }),
            ],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 1,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            marketContext: {
                symbol: "XRPUSDT",
                interval: "1m",
            },
            polymarketTradeSummary: {
                seriesId: "10422",
                outcomeInterval: "15m",
                outcomeRowsLoaded: 1,
                scoredTrades: 1,
                missingOutcomeTrades: 0,
                unscoredTrades: 0,
            },
        } satisfies BacktestResult);

        const html = (quickViewManager as any).buildPolymarketSection(enriched);

        expect(enriched.trades[0]?.polymarketOutcome?.marketSlug).to.equal("xrp-15m-1");
        expect(enriched.trades[0]?.polymarketOutcome?.isWin).to.equal(true);
        expect(html).to.contain("Run Mode: Native 15m scoring");
    });

    it("compares polymarket payout against realized binance execution", () => {
        const summary = summarizePolymarketExecutionGap([
            makeTrade(1, true, {
                pnl: 5,
                polymarketOutcome: {
                    ...makeTrade(1, true).polymarketOutcome!,
                    marketEntryPrice: 0.4,
                },
            }),
            makeTrade(2, true, {
                pnl: -3,
                polymarketOutcome: {
                    ...makeTrade(2, true).polymarketOutcome!,
                    marketEntryPrice: 0.7,
                },
            }),
            makeTrade(3, false, {
                pnl: -4,
                polymarketOutcome: {
                    ...makeTrade(3, false).polymarketOutcome!,
                    marketEntryPrice: 0.2,
                },
            }),
            makeTrade(4, null, { pnl: 9 }),
        ]);

        expect(summary).to.not.equal(null);
        expect(summary?.pricedTrades).to.equal(3);
        expect(summary?.unpricedScoredTrades).to.equal(0);
        expect(summary?.polymarketWinRate).to.be.closeTo(2 / 3, 1e-12);
        expect(summary?.avgEntryPrice).to.be.closeTo((0.4 + 0.7 + 0.2) / 3, 1e-12);
        expect(summary?.breakEvenWinRate).to.be.closeTo((0.4 + 0.7 + 0.2) / 3, 1e-12);
        expect(summary?.polymarketExpectancy).to.be.closeTo(0.7 / 3, 1e-12);
        expect(summary?.realizedWinRate).to.equal(1 / 3);
        expect(summary?.realizedExpectancy).to.equal(-2 / 3);
    });

    it("keeps unpriced scored trades out of the execution-gap subset but reports them", () => {
        const summary = summarizePolymarketExecutionGap([
            makeTrade(1, true, {
                pnl: 5,
                polymarketOutcome: {
                    ...makeTrade(1, true).polymarketOutcome!,
                    marketEntryPrice: 0.4,
                },
            }),
            makeTrade(2, false, {
                pnl: -9,
                polymarketOutcome: {
                    ...makeTrade(2, false).polymarketOutcome!,
                    marketEntryPrice: null,
                },
            }),
        ]);

        expect(summary).to.not.equal(null);
        expect(summary?.pricedTrades).to.equal(1);
        expect(summary?.unpricedScoredTrades).to.equal(1);
        expect(summary?.polymarketWinRate).to.equal(1);
        expect(summary?.realizedWinRate).to.equal(1);
        expect(summary?.realizedExpectancy).to.equal(5);
    });

    it("renders a Quick View handoff to the Polymarket tab instead of selected offset n/a", () => {
        const html = (quickViewManager as any).buildPolymarketSection({
            trades: [
                makeTrade(1, true, {
                    polymarketOutcome: {
                        ...makeTrade(1, true).polymarketOutcome!,
                        marketEntryPrice: 0.48,
                    },
                }),
            ],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 1,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            polymarketTradeSummary: {
                seriesId: "btc-5m",
                outcomeRowsLoaded: 1,
                scoredTrades: 1,
                missingOutcomeTrades: 0,
                unscoredTrades: 0,
            },
        } satisfies BacktestResult);

        expect(html).to.contain("Run Mode: Native 5m scoring");
        expect(html).to.contain("Polymarket tab");
        expect(html).to.not.contain("Selected Offset: n/a");
    });

    it("renders auto entry selection labels for 1m resolve-hold summaries", () => {
        const html = (quickViewManager as any).buildPolymarketSection({
            trades: [
                makeTrade(1, true, {
                    polymarketOutcome: {
                        ...makeTrade(1, true).polymarketOutcome!,
                        entryOffset: 2,
                        marketEntryPrice: 0.54,
                    },
                }),
                makeTrade(2, false, {
                    polymarketOutcome: {
                        ...makeTrade(2, false).polymarketOutcome!,
                        entryOffset: 4,
                        marketEntryPrice: 0.53,
                    },
                }),
            ],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 3,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            polymarketTradeSummary: {
                seriesId: "btc-5m",
                outcomeRowsLoaded: 3,
                scoredTrades: 2,
                missingOutcomeTrades: 0,
                unscoredTrades: 1,
                entrySelectionMode: "actual_entry_minute",
                timingProfile: [],
            },
        } satisfies BacktestResult);

        expect(html).to.contain("Entry Selection: Auto (actual trade minute)");
        expect(html).to.contain("See Polymarket tab for auto-mode diagnostics");
        expect(html).to.not.contain("Selected Offset: Minute");
    });

    it("renders the new quick-view polymarket summary cards", () => {
        const html = (quickViewManager as any).buildPolymarketSection({
            trades: [
                makeTrade(1, true, {
                    exitReason: "signal",
                    polymarketOutcome: {
                        ...makeTrade(1, true).polymarketOutcome!,
                        marketEntryPrice: 0.3,
                    },
                }),
                makeTrade(2, true, {
                    exitReason: "take_profit",
                    polymarketOutcome: {
                        ...makeTrade(2, true).polymarketOutcome!,
                        marketEntryPrice: 0.3,
                    },
                }),
                makeTrade(3, false, {
                    exitReason: "time_stop",
                    polymarketOutcome: {
                        ...makeTrade(3, false).polymarketOutcome!,
                        marketEntryPrice: 0.6,
                    },
                }),
                makeTrade(4, true, {
                    exitReason: "time_stop",
                    polymarketOutcome: {
                        ...makeTrade(4, true).polymarketOutcome!,
                        marketEntryPrice: 0.4,
                    },
                }),
                makeTrade(5, false, {
                    exitReason: "signal",
                    polymarketOutcome: {
                        ...makeTrade(5, false).polymarketOutcome!,
                        marketEntryPrice: 0.4,
                    },
                }),
            ],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 4,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            polymarketTradeSummary: {
                seriesId: "btc-5m",
                outcomeRowsLoaded: 5,
                scoredTrades: 5,
                missingOutcomeTrades: 0,
                unscoredTrades: 0,
            },
        } satisfies BacktestResult);

        expect(html).to.contain("Poly Exp / Trade");
        expect(html).to.contain("+20.0c");
        expect(html).to.contain("Poly Profit Factor");
        expect(html).to.contain("2.00");
        expect(html).to.contain("Avg Win");
        expect(html).to.contain("+66.7c");
        expect(html).to.contain("Avg Loss");
        expect(html).to.contain("-50.0c");
        expect(html).to.contain("Avg Entry Price");
        expect(html).to.contain("40.0c");
        expect(html).to.not.contain("+40.0c");
        expect(html).to.contain("Max Win Streak");
        expect(html).to.contain("Max Loss Streak");
        expect(html).to.contain("Last 50 W/L");
        expect(html).to.contain("3 win - 2 lose");
        expect(html).to.contain("Entry Win % | After Max Hold");
        expect(html).to.contain("50.0% | 2t");
        expect(html).to.contain("Entry Win % | After TP");
        expect(html).to.contain("0.0% | 1t");
        expect(html).to.contain("Entry Exp / Trade | After TP");
        expect(html).to.contain("-60.0c | 1t");
        expect(html).to.contain("Entry Win % | After Signal");
        expect(html).to.contain("100.0% | 1t");
    });

    it("preserves and renders sized polymarket bankroll metrics", () => {
        const result = {
            trades: [makeTrade(1, true), makeTrade(2, false)],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 2,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            polymarketTradeSummary: {
                seriesId: "btc-5m",
                outcomeRowsLoaded: 2,
                scoredTrades: 2,
                missingOutcomeTrades: 0,
                unscoredTrades: 0,
                sizedSizingMode: "anti_martingale",
                sizedInitialCapital: 10_000,
                sizedFinalEquity: 10_250,
                sizedNetProfit: 250,
                sizedNetProfitPercent: 2.5,
                sizedProfitFactor: 2,
                sizedExpectancy: 125,
                sizedMaxDrawdownPercent: 1.25,
                sizedTrades: 2,
                sizedSkippedTrades: 1,
                sizedNoCapitalTrades: 0,
                sizedCappedTrades: 1,
                sizedAvgStake: 1_125,
                sizedMaxStake: 1_250,
            },
        } satisfies BacktestResult;
        const enriched = (quickViewManager as any).withPolymarketTradeSummary(result, result.trades, "btc-5m");
        const html = (quickViewManager as any).buildPolymarketSection(enriched);

        expect(enriched.polymarketTradeSummary?.sizedNetProfit).to.equal(250);
        expect(html).to.contain("Alternative Sizing: Anti-Martingale");
        expect(html).to.contain("Sized Net");
        expect(html).to.contain("+$250.00");
        expect(html).to.contain("Sized Return");
        expect(html).to.contain("+2.50%");
        expect(html).to.contain("Sized PF");
        expect(html).to.contain("Sized Max DD");
        expect(html).to.not.contain("Final Equity");
        expect(html).to.not.contain("Sized Exp / Trade");
        expect(html).to.not.contain("Avg Poly Stake");
        expect(html).to.not.contain("Max Poly Stake");
        expect(html).to.contain("0 no capital | 1 capped");
    });

    it("labels fixed amount sized bankroll metrics in Quick View", () => {
        const result = {
            trades: [makeTrade(1, true)],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 1,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            polymarketTradeSummary: {
                seriesId: "btc-5m",
                outcomeRowsLoaded: 1,
                scoredTrades: 1,
                missingOutcomeTrades: 0,
                sizedSizingMode: "fixed",
                sizedNetProfit: 100,
                sizedNetProfitPercent: 1,
                sizedTrades: 1,
            },
        } satisfies BacktestResult;

        const html = (quickViewManager as any).buildPolymarketSection(result);

        expect(html).to.contain("Alternative Sizing: Fixed Amount");
        expect(html).to.contain("Sized Net");
    });

    it("formats extreme sized bankroll values compactly in Quick View", () => {
        const html = (quickViewManager as any).buildPolymarketSection({
            trades: [makeTrade(1, true)],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 1,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            polymarketTradeSummary: {
                seriesId: "btc-5m",
                outcomeRowsLoaded: 1,
                scoredTrades: 1,
                missingOutcomeTrades: 0,
                unscoredTrades: 0,
                sizedSizingMode: "kelly_criterion",
                sizedInitialCapital: 10_000,
                sizedFinalEquity: 1.0005009959564123e73,
                sizedNetProfit: 1.0005009959564123e73,
                sizedNetProfitPercent: 1.0005009959564123e71,
                sizedProfitFactor: 2.23,
                sizedExpectancy: 1.1028450131794668e69,
                sizedMaxDrawdownPercent: 12.5,
                sizedTrades: 9072,
                sizedSkippedTrades: 4641,
                sizedAvgStake: 1.0493366798419991e70,
                sizedMaxStake: 1.381416276030043e72,
            },
        } satisfies BacktestResult);

        expect(html).to.contain("9,072 sized | 4,641 skipped");
        expect(html).to.contain("+$1.00x10^73");
        expect(html).to.contain("+1.00x10^71");
        expect(html).to.not.contain("1.0005009959564123e+73");
        expect(html).to.not.contain("+$1.00e73");
        expect(html).to.not.contain("+1.00e71%");
        expect(html).to.not.contain("+1.00%");
        expect(html).to.not.contain("Final Equity");
        expect(html).to.not.contain("Sized Exp / Trade");
        expect(html).to.not.contain("Avg Poly Stake");
        expect(html).to.not.contain("Max Poly Stake");
    });

    it("renders post-signal limit-entry diagnostics", () => {
        const html = (quickViewManager as any).buildPolymarketSection({
            trades: [
                makeTrade(1, true, {
                    polymarketOutcome: {
                        ...makeTrade(1, true).polymarketOutcome!,
                        marketEntrySource: "limit",
                        marketEntryStatus: "filled",
                        marketEntryPrice: 0.5,
                        marketEntryLimitPrice: 0.5,
                    },
                }),
                makeTrade(2, true, {
                    polymarketOutcome: {
                        ...makeTrade(2, true).polymarketOutcome!,
                        isWin: null,
                        marketEntrySource: "limit",
                        marketEntryStatus: "not_touched",
                        marketEntryPrice: null,
                        marketEntryLimitPrice: 0.5,
                    },
                }),
            ],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 2,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            polymarketTradeSummary: {
                seriesId: "btc-5m",
                outcomeRowsLoaded: 2,
                scoredTrades: 1,
                missingOutcomeTrades: 0,
                unscoredTrades: 1,
                limitEntryEnabled: true,
                limitEntryPriceCents: 50,
                limitEntryAttempts: 2,
                limitEntryFilledTrades: 1,
                limitEntryMissedTrades: 1,
                limitEntryNotTouchedTrades: 1,
                limitEntryLastMinuteOnlyTrades: 1,
                limitEntryMissingPriceTrades: 1,
                limitEntryInvalidWindowTrades: 1,
                limitEntryFillRate: 0.5,
            },
        } satisfies BacktestResult);

        expect(html).to.contain("Limit Attempts");
        expect(html).to.contain("Limit Filled");
        expect(html).to.contain("Limit Missed");
        expect(html).to.contain("Limit Fill Rate");
        expect(html).to.contain("50.0%");
        expect(html).to.contain("Not Touched");
        expect(html).to.contain("Last-Min Only");
        expect(html).to.contain("Missing Limit Price");
        expect(html).to.contain("Invalid Limit Window");
    });

    it("renders signal-exit same-event summaries from stored polymarket pricing", () => {
        const html = (quickViewManager as any).buildPolymarketSection({
            trades: [
                makeTrade(1, true, {
                    polymarketOutcome: {
                        ...makeTrade(1, true).polymarketOutcome!,
                        evaluationMode: "signal_exit_same_event",
                        isProfitable: true,
                        marketEntryPrice: 0.42,
                        marketExitPrice: 0.60,
                        marketPnl: 0.18,
                        marketExitSource: "signal",
                    },
                }),
                makeTrade(2, false, {
                    polymarketOutcome: {
                        ...makeTrade(2, false).polymarketOutcome!,
                        evaluationMode: "signal_exit_same_event",
                        isProfitable: false,
                        marketEntryPrice: 0.58,
                        marketExitPrice: 0.48,
                        marketPnl: -0.10,
                        marketExitSource: "resolution",
                    },
                }),
            ],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 2,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            polymarketTradeSummary: {
                seriesId: "btc-5m",
                outcomeRowsLoaded: 2,
                scoredTrades: 2,
                missingOutcomeTrades: 0,
                unscoredTrades: 7,
                duplicateTradesIgnored: 7,
                evaluationMode: "signal_exit_same_event",
                profitableTrades: 1,
                losingTrades: 1,
                signalExitedTrades: 1,
                resolvedTrades: 1,
                expectancy: 0.04,
                profitFactor: 1.8,
            },
        } satisfies BacktestResult);

        expect(html).to.contain("Signal Exit (same event)");
        expect(html).to.contain("Poly Profitable");
        expect(html).to.contain("Profitable Trades");
        expect(html).to.contain("Losing Trades");
        expect(html).to.contain("+4.0c");
        expect(html).to.contain("1.80");
        expect(html).to.contain("Signal Exited");
        expect(html).to.contain("Resolved (Held)");
        expect(html).to.contain("Duplicate Trades Ignored");
        expect(html).to.contain("Last 50 P/L/F");
        expect(html).to.contain("Entry Profit % | After Max Hold");
        expect(html).to.contain("Entry Profit % | After TP");
        expect(html).to.contain("Entry Profit % | After Signal");
    });

    it("coerces stale 1s resolve-hold annotations to signal-exit before rendering performance cards", async () => {
        const eventStartTs = 1_700_000_000;
        const tradeEntryTs = eventStartTs + 10;
        const tradeExitTs = eventStartTs + 20;
        let clobRequests = 0;
        const content = { style: { display: "" }, innerHTML: "" };
        const empty = { style: { display: "" } };

        class FakeSelectElement {
            value: string;

            constructor(value = "") {
                this.value = value;
            }
        }
        (globalThis as { HTMLSelectElement?: typeof HTMLSelectElement }).HTMLSelectElement = FakeSelectElement as unknown as typeof HTMLSelectElement;
        const executionModelSelect = new FakeSelectElement("next_open");
        (globalThis as { document?: Document }).document = {
            getElementById: (id: string) => {
                if (id === "qvStatsContent") return content as unknown as HTMLElement;
                if (id === "qvEmpty") return empty as unknown as HTMLElement;
                if (id === "executionModel") return executionModelSelect as unknown as HTMLElement;
                return null;
            },
        } as Document;

        globalThis.fetch = (async (input) => {
            const url = new URL(
                typeof input === "string"
                    ? input
                    : input instanceof URL
                        ? input.toString()
                        : input.url,
                "http://localhost"
            );

            if (url.pathname === "/api/sqlite/status") {
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/load-polymarket-outcomes") {
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [{
                        series_id: "10684",
                        event_slug: "btc-1s-stale",
                        market_slug: "btc-1s-stale",
                        interval: "5m",
                        event_start_ts: eventStartTs,
                        event_end_ts: eventStartTs + 300,
                        yes_token_id: "yes-1",
                        no_token_id: "no-1",
                        yes_open_price: 0.5,
                        yes_entry_minute_1_price: null,
                        yes_entry_minute_2_price: null,
                        yes_entry_minute_3_price: null,
                        yes_entry_minute_4_price: null,
                        resolved_outcome_up: 1,
                        resolution_source: "test",
                        updated_at: 1,
                    }],
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/second-market/clob-quotes") {
                clobRequests++;
                return new Response(JSON.stringify({
                    ok: true,
                    quotes: [
                        {
                            series_id: "10684",
                            symbol: "BTCUSDT",
                            outcome_interval: "5m",
                            event_start_ts: eventStartTs,
                            event_end_ts: eventStartTs + 300,
                            condition_id: "",
                            market_slug: "btc-1s-stale",
                            yes_token_id: "yes-1",
                            no_token_id: "no-1",
                            sample_ts: tradeEntryTs,
                            yes_bid: 0.53,
                            yes_ask: 0.55,
                            yes_mid: 0.54,
                            yes_last: null,
                            no_bid: 0.45,
                            no_ask: 0.47,
                            no_mid: 0.46,
                            no_last: null,
                            source: "polymarket_clob_1s",
                            source_ts_ms: tradeEntryTs * 1000,
                            quote_age_ms: 0,
                            quality_flags: "",
                            updated_at: tradeEntryTs,
                        },
                        {
                            series_id: "10684",
                            symbol: "BTCUSDT",
                            outcome_interval: "5m",
                            event_start_ts: eventStartTs,
                            event_end_ts: eventStartTs + 300,
                            condition_id: "",
                            market_slug: "btc-1s-stale",
                            yes_token_id: "yes-1",
                            no_token_id: "no-1",
                            sample_ts: tradeExitTs,
                            yes_bid: 0.58,
                            yes_ask: 0.60,
                            yes_mid: 0.59,
                            yes_last: null,
                            no_bid: 0.40,
                            no_ask: 0.42,
                            no_mid: 0.41,
                            no_last: null,
                            source: "polymarket_clob_1s",
                            source_ts_ms: tradeExitTs * 1000,
                            quote_age_ms: 0,
                            quality_flags: "",
                            updated_at: tradeExitTs,
                        },
                    ],
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            throw new Error(`Unexpected URL ${url.pathname}`);
        }) as typeof fetch;

        const enriched = await (quickViewManager as any).ensurePolymarketOutcomes({
            trades: [
                makeTrade(1, true, {
                    entryTime: tradeEntryTs,
                    exitTime: tradeExitTs,
                    exitReason: "signal",
                    polymarketOutcome: {
                        ...makeTrade(1, true).polymarketOutcome!,
                        evaluationMode: "resolve_hold",
                        marketEntryPrice: null,
                        marketExitPrice: null,
                        marketPnl: null,
                        marketExitSource: "resolution",
                    },
                }),
            ],
            netProfit: -100,
            netProfitPercent: -1,
            winRate: 0,
            expectancy: -100,
            avgTrade: -100,
            profitFactor: 0,
            maxDrawdown: 100,
            maxDrawdownPercent: 1,
            totalTrades: 1,
            winningTrades: 0,
            losingTrades: 1,
            avgWin: 0,
            avgLoss: -100,
            sharpeRatio: 0,
            equityCurve: [],
            marketContext: {
                symbol: "BTCUSDT",
                interval: "1s",
            },
            polymarketTradeSummary: {
                seriesId: "10684",
                outcomeInterval: "5m",
                outcomeRowsLoaded: 1,
                scoredTrades: 1,
                missingOutcomeTrades: 0,
                unscoredTrades: 0,
                evaluationMode: "resolve_hold",
                resolvedTrades: 1,
            },
        } satisfies BacktestResult);

        (quickViewManager as any).renderResults(enriched);

        expect(clobRequests).to.equal(1);
        expect(enriched.polymarketTradeSummary?.evaluationMode).to.equal("signal_exit_same_event");
        expect(enriched.polymarketTradeSummary?.backtestSlippageCents).to.equal(5);
        expect(enriched.polymarketTradeSummary?.expectancy).to.be.closeTo(-0.07, 1e-9);
        expect(enriched.trades[0]?.polymarketOutcome?.marketEntryPrice).to.equal(0.6);
        expect(enriched.trades[0]?.polymarketOutcome?.marketExitPrice).to.equal(0.53);
        expect(content.innerHTML).to.contain("Polymarket Exp / Trade");
        expect(content.innerHTML).to.contain("-7.0c");
        expect(content.innerHTML).to.contain("Signal Exit (same event)");
    });

    it("rebuilds 1s CLOB signal-exit annotations for a futures-scoped Quick View result", async () => {
        const eventStartTs = 1_700_000_000;
        const tradeEntryTs = eventStartTs + 10;
        const tradeExitTs = eventStartTs + 20;
        let clobRequests = 0;

        class FakeSelectElement {
            value: string;

            constructor(value = "") {
                this.value = value;
            }
        }
        (globalThis as { HTMLSelectElement?: typeof HTMLSelectElement }).HTMLSelectElement = FakeSelectElement as unknown as typeof HTMLSelectElement;
        const executionModelSelect = new FakeSelectElement("next_open");
        (globalThis as { document?: Document }).document = {
            getElementById: (id: string) => id === "executionModel"
                ? (executionModelSelect as unknown as HTMLElement)
                : null,
        } as Document;

        globalThis.fetch = (async (input) => {
            const url = new URL(
                typeof input === "string"
                    ? input
                    : input instanceof URL
                        ? input.toString()
                        : input.url,
                "http://localhost"
            );

            if (url.pathname === "/api/sqlite/status") {
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/load-polymarket-outcomes") {
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [{
                        series_id: "10684",
                        event_slug: "btc-1s-event",
                        market_slug: "btc-1s-event",
                        interval: "5m",
                        event_start_ts: eventStartTs,
                        event_end_ts: eventStartTs + 300,
                        yes_token_id: "yes-1",
                        no_token_id: "no-1",
                        yes_open_price: 0.5,
                        yes_entry_minute_1_price: null,
                        yes_entry_minute_2_price: null,
                        yes_entry_minute_3_price: null,
                        yes_entry_minute_4_price: null,
                        resolved_outcome_up: 1,
                        resolution_source: "test",
                        updated_at: 1,
                    }],
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/second-market/clob-quotes") {
                clobRequests++;
                expect(url.searchParams.get("symbol")).to.equal("BTCUSDT");
                expect(url.searchParams.get("seriesId")).to.equal("10684");
                return new Response(JSON.stringify({
                    ok: true,
                    quotes: [
                        {
                            series_id: "10684",
                            symbol: "BTCUSDT",
                            outcome_interval: "5m",
                            event_start_ts: eventStartTs,
                            event_end_ts: eventStartTs + 300,
                            condition_id: "",
                            market_slug: "btc-1s-event",
                            yes_token_id: "yes-1",
                            no_token_id: "no-1",
                            sample_ts: tradeEntryTs,
                            yes_bid: 0.53,
                            yes_ask: 0.55,
                            yes_mid: 0.54,
                            yes_last: null,
                            no_bid: 0.45,
                            no_ask: 0.47,
                            no_mid: 0.46,
                            no_last: null,
                            source: "polymarket_clob_1s",
                            source_ts_ms: tradeEntryTs * 1000,
                            quote_age_ms: 0,
                            quality_flags: "",
                            updated_at: tradeEntryTs,
                        },
                        {
                            series_id: "10684",
                            symbol: "BTCUSDT",
                            outcome_interval: "5m",
                            event_start_ts: eventStartTs,
                            event_end_ts: eventStartTs + 300,
                            condition_id: "",
                            market_slug: "btc-1s-event",
                            yes_token_id: "yes-1",
                            no_token_id: "no-1",
                            sample_ts: tradeExitTs,
                            yes_bid: 0.58,
                            yes_ask: 0.60,
                            yes_mid: 0.59,
                            yes_last: null,
                            no_bid: 0.40,
                            no_ask: 0.42,
                            no_mid: 0.41,
                            no_last: null,
                            source: "polymarket_clob_1s",
                            source_ts_ms: tradeExitTs * 1000,
                            quote_age_ms: 0,
                            quality_flags: "",
                            updated_at: tradeExitTs,
                        },
                    ],
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            throw new Error(`Unexpected URL ${url.pathname}`);
        }) as typeof fetch;

        const enriched = await (quickViewManager as any).ensurePolymarketOutcomes({
            trades: [
                makeTrade(1, true, {
                    entryTime: tradeEntryTs,
                    exitTime: tradeExitTs,
                    exitReason: "signal",
                    polymarketOutcome: undefined,
                }),
            ],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 1,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            marketContext: {
                symbol: "BINANCE-FUTURES:BTCUSDT",
                interval: "1s",
                binanceMarketType: "futures",
                candleCount: 30,
                firstCandleTime: eventStartTs,
                lastCandleTime: eventStartTs + 30,
            },
        } satisfies BacktestResult);

        const html = (quickViewManager as any).buildPolymarketSection(enriched);

        expect(clobRequests).to.equal(1);
        expect(enriched.polymarketTradeSummary?.evaluationMode).to.equal("signal_exit_same_event");
        expect(enriched.polymarketTradeSummary?.scoredTrades).to.equal(1);
        expect(enriched.polymarketTradeSummary?.backtestSlippageCents).to.equal(5);
        expect(enriched.polymarketTradeSummary?.expectancy).to.be.closeTo(-0.07, 1e-9);
        expect(enriched.trades[0]?.polymarketOutcome?.isWin).to.equal(null);
        expect(enriched.trades[0]?.polymarketOutcome?.isProfitable).to.equal(false);
        expect(enriched.trades[0]?.polymarketOutcome?.marketEntryPrice).to.equal(0.6);
        expect(enriched.trades[0]?.polymarketOutcome?.marketExitPrice).to.equal(0.53);
        expect(enriched.trades[0]?.polymarketOutcome?.marketExitSource).to.equal("signal");
        expect(html).to.contain("Signal Exit (same event)");
        expect(html).to.contain("Signal Exited");
        expect(html).to.contain("-7.0c");
    });

    it("preserves native 15m signal-exit outcome intervals when Quick View rebuilds outcomes", async () => {
        const eventStartTs = 1_700_000_000;
        const tradeEntryTs = eventStartTs + 600;
        class FakeSelectElement {
            value: string;

            constructor(value = "") {
                this.value = value;
            }
        }
        (globalThis as { HTMLSelectElement?: typeof HTMLSelectElement }).HTMLSelectElement = FakeSelectElement as unknown as typeof HTMLSelectElement;
        const executionModelSelect = new FakeSelectElement("next_open");
        (globalThis as { document?: Document }).document = {
            getElementById: (id: string) => id === "executionModel"
                ? (executionModelSelect as unknown as HTMLElement)
                : null,
        } as Document;

        globalThis.fetch = (async (input, init) => {
            const url = new URL(
                typeof input === "string"
                    ? input
                    : input instanceof URL
                        ? input.toString()
                        : input.url,
                "http://localhost"
            );

            if (url.pathname === "/api/sqlite/status") {
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/load-polymarket-outcomes") {
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [{
                        series_id: "10422",
                        event_slug: "xrp-15m-signal",
                        market_slug: "xrp-15m-signal",
                        interval: "15m",
                        event_start_ts: eventStartTs,
                        event_end_ts: eventStartTs + 900,
                        yes_token_id: "yes-1",
                        no_token_id: "no-1",
                        yes_open_price: 0.5,
                        yes_entry_minute_1_price: 0.51,
                        yes_entry_minute_2_price: 0.52,
                        yes_entry_minute_3_price: 0.53,
                        yes_entry_minute_4_price: 0.54,
                        resolved_outcome_up: 1,
                        resolution_source: "test",
                        updated_at: 1,
                    }],
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/load-polymarket-price-points") {
                return new Response(JSON.stringify({ ok: true, rows: [] }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/ensure-polymarket-price-points") {
                const body = JSON.parse(String(init?.body ?? "{}")) as { seriesId?: string };
                expect(body.seriesId).to.equal("10422");
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [
                        {
                            series_id: "10422",
                            event_start_ts: eventStartTs,
                            event_end_ts: eventStartTs + 900,
                            market_slug: "xrp-15m-signal",
                            yes_token_id: "yes-1",
                            no_token_id: "no-1",
                            ts: tradeEntryTs,
                            yes_price: 0.55,
                            no_price: 0.45,
                            updated_at: 1,
                        },
                        {
                            series_id: "10422",
                            event_start_ts: eventStartTs,
                            event_end_ts: eventStartTs + 900,
                            market_slug: "xrp-15m-signal",
                            yes_token_id: "yes-1",
                            no_token_id: "no-1",
                            ts: tradeEntryTs + 120,
                            yes_price: 0.63,
                            no_price: 0.37,
                            updated_at: 1,
                        },
                    ],
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            throw new Error(`Unexpected URL ${url.pathname}`);
        }) as typeof fetch;

        const result = {
            trades: [
                makeTrade(1, true, {
                    entryTime: tradeEntryTs,
                    exitTime: tradeEntryTs + 120,
                    exitReason: "signal",
                    polymarketOutcome: undefined,
                }),
            ],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 1,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            marketContext: {
                symbol: "XRPUSDT",
                interval: "1m",
            },
            polymarketTradeSummary: {
                seriesId: "10422",
                outcomeInterval: "15m",
                outcomeRowsLoaded: 1,
                scoredTrades: 0,
                missingOutcomeTrades: 0,
                unscoredTrades: 1,
                evaluationMode: "signal_exit_same_event",
            },
        } satisfies BacktestResult;
        state.currentBacktestResult = result;

        const enriched = await (quickViewManager as any).ensurePolymarketOutcomes(result);

        expect(enriched.polymarketTradeSummary?.outcomeInterval).to.equal("15m");
        expect(enriched.polymarketTradeSummary?.evaluationMode).to.equal("signal_exit_same_event");
        expect(enriched.polymarketTradeSummary?.backtestSlippageCents).to.equal(5);
        expect(enriched.trades[0]?.polymarketOutcome?.marketExitSource).to.equal("signal");
        expect(enriched.trades[0]?.polymarketOutcome?.marketEntryPrice).to.equal(0.6);
        expect(enriched.trades[0]?.polymarketOutcome?.marketExitPrice).to.equal(0.58);
    });

    it("does not render an empty signal-exit section when no trades were actually priced", () => {
        const html = (quickViewManager as any).buildPolymarketSection({
            trades: [
                makeTrade(1, null),
            ],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 1,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            polymarketTradeSummary: {
                seriesId: "btc-5m",
                outcomeRowsLoaded: 1,
                scoredTrades: 0,
                missingOutcomeTrades: 0,
                unscoredTrades: 1,
                evaluationMode: "signal_exit_same_event",
                missingPriceTrades: 1,
            },
        } satisfies BacktestResult);

        expect(html).to.equal("");
    });

    it("keeps signal-exit flats neutral and excludes duplicate or no-event trades from quick-view form cards", () => {
        const html = (quickViewManager as any).buildPolymarketSection({
            trades: [
                makeTrade(1, true, {
                    exitReason: "time_stop",
                    polymarketOutcome: {
                        ...makeTrade(1, true).polymarketOutcome!,
                        evaluationMode: "signal_exit_same_event",
                        isProfitable: true,
                        marketEntryPrice: 0.40,
                        marketExitPrice: 0.60,
                        marketPnl: 0.20,
                        marketExitSource: "signal",
                    },
                }),
                makeTrade(2, false, {
                    exitReason: "signal",
                    polymarketOutcome: {
                        ...makeTrade(2, false).polymarketOutcome!,
                        evaluationMode: "signal_exit_same_event",
                        isProfitable: false,
                        marketEntryPrice: 0.55,
                        marketExitPrice: 0.35,
                        marketPnl: -0.20,
                        marketExitSource: "resolution",
                    },
                }),
                makeTrade(3, true, {
                    exitReason: "take_profit",
                    polymarketOutcome: {
                        ...makeTrade(3, true).polymarketOutcome!,
                        evaluationMode: "signal_exit_same_event",
                        isProfitable: null,
                        marketEntryPrice: 0.50,
                        marketExitPrice: 0.50,
                        marketPnl: 0,
                        marketExitSource: "signal",
                    },
                }),
                makeTrade(4, true, {
                    polymarketOutcome: {
                        ...makeTrade(4, true).polymarketOutcome!,
                        evaluationMode: "signal_exit_same_event",
                        isWin: null,
                        isProfitable: null,
                        marketEntryPrice: null,
                        marketExitPrice: null,
                        marketPnl: null,
                        marketExitSource: "duplicate",
                    },
                }),
                makeTrade(5, true, {
                    polymarketOutcome: {
                        ...makeTrade(5, true).polymarketOutcome!,
                        eventStartTs: 0,
                        eventEndTs: 0,
                        eventSlug: "",
                        marketSlug: "",
                        actualOutcomeUp: 0,
                        isWin: null,
                        evaluationMode: "signal_exit_same_event",
                        isProfitable: null,
                        marketEntryPrice: null,
                        marketExitPrice: null,
                        marketPnl: null,
                        marketExitSource: "no_event",
                    },
                }),
            ],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 5,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            polymarketTradeSummary: {
                seriesId: "btc-5m",
                outcomeRowsLoaded: 3,
                scoredTrades: 3,
                missingOutcomeTrades: 1,
                unscoredTrades: 2,
                evaluationMode: "signal_exit_same_event",
                profitableTrades: 1,
                losingTrades: 1,
                neutralTrades: 1,
                signalExitedTrades: 2,
                resolvedTrades: 1,
                expectancy: 0,
                profitFactor: 1,
            },
        } satisfies BacktestResult);

        expect(html).to.contain("Neutral Trades");
        expect(html).to.contain("Last 50 P/L/F");
        expect(html).to.contain("1 profit - 1 loss - 1 flat");
        expect(html).to.contain("Entry Profit % | After Max Hold");
        expect(html).to.contain("0.0% | 1t");
        expect(html).to.contain("Entry Profit % | After TP");
        expect(html).to.contain("n/a");
        expect(html).to.contain("Entry Profit % | After Signal");
        expect(html).to.contain("0.0% | 1t");
        expect(html).to.not.contain("0.0% | 2t");
    });

    it("infers fallback signal-exit summary counts without scoring duplicates or no-event trades", () => {
        const result = (quickViewManager as any).withPolymarketTradeSummary({
            trades: [],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 3,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
        } satisfies BacktestResult, [
            makeTrade(1, true, {
                polymarketOutcome: {
                    ...makeTrade(1, true).polymarketOutcome!,
                    evaluationMode: "signal_exit_same_event",
                    isProfitable: true,
                    marketEntryPrice: 0.40,
                    marketExitPrice: 0.60,
                    marketPnl: 0.20,
                    marketExitSource: "signal",
                },
            }),
            makeTrade(2, true, {
                polymarketOutcome: {
                    ...makeTrade(2, true).polymarketOutcome!,
                    evaluationMode: "signal_exit_same_event",
                    isWin: null,
                    isProfitable: null,
                    marketEntryPrice: null,
                    marketExitPrice: null,
                    marketPnl: null,
                    marketExitSource: "duplicate",
                },
            }),
            makeTrade(3, true, {
                polymarketOutcome: {
                    ...makeTrade(3, true).polymarketOutcome!,
                    eventStartTs: 0,
                    eventEndTs: 0,
                    eventSlug: "",
                    marketSlug: "",
                    actualOutcomeUp: 0,
                    isWin: null,
                    evaluationMode: "signal_exit_same_event",
                    isProfitable: null,
                    marketEntryPrice: null,
                    marketExitPrice: null,
                    marketPnl: null,
                    marketExitSource: "no_event",
                },
            }),
        ], "btc-5m");

        expect(result.polymarketTradeSummary?.scoredTrades).to.equal(1);
        expect(result.polymarketTradeSummary?.unscoredTrades).to.equal(2);
        expect(result.polymarketTradeSummary?.missingOutcomeTrades).to.equal(1);
        expect(result.polymarketTradeSummary?.duplicateTradesIgnored).to.equal(1);
    });
});
