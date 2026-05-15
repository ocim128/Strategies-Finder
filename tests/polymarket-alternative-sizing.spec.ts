import { expect } from "chai";
import { describe, it } from "node:test";
import { applyPolymarketAlternativeSizing } from "../lib/polymarket-alternative-sizing";
import { resolvePolymarketTradePayout } from "../lib/polymarket-payout";
import { TradesRenderer } from "../lib/renderers/tradesRenderer";
import type { BacktestResult, BacktestSettings, OHLCVData, Time, Trade } from "../lib/types/strategies";
import type { CapitalSettings } from "../lib/types/backtest";
import type { TradePolymarketOutcome } from "../lib/types/polymarket-outcomes";

function makeData(count: number): OHLCVData[] {
    return Array.from({ length: count }, (_, index) => ({
        time: (1_700_000_000 + index * 300) as Time,
        open: 100 + index,
        high: 101 + index,
        low: 99 + index,
        close: 100 + index,
        volume: 1000,
    }));
}

function makeTrade(id: number, entryTime: Time, marketPnl: number, source: TradePolymarketOutcome["marketExitSource"] = "resolution"): Trade {
    return {
        id,
        type: "long",
        entryTime,
        entryPrice: 100,
        exitTime: entryTime,
        exitPrice: 100,
        pnl: marketPnl >= 0 ? 10 : -10,
        pnlPercent: marketPnl >= 0 ? 1 : -1,
        size: 1,
        exitReason: "signal",
        polymarketOutcome: {
            eventStartTs: Number(entryTime),
            eventEndTs: Number(entryTime) + 300,
            eventSlug: `event-${id}`,
            marketSlug: `event-${id}`,
            prediction: "yes",
            actualOutcomeUp: marketPnl >= 0 ? 1 : 0,
            isWin: marketPnl >= 0,
            marketEntryPrice: source === "duplicate" ? null : 0.5,
            marketExitPrice: source === "duplicate" ? null : 0.5 + marketPnl,
            marketExitSource: source,
            marketPnl: source === "duplicate" ? null : marketPnl,
        },
    };
}

function makeResult(trades: Trade[]): BacktestResult {
    return {
        trades,
        netProfit: 0,
        netProfitPercent: 0,
        winRate: 0,
        expectancy: 0,
        avgTrade: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: trades.length,
        winningTrades: 0,
        losingTrades: 0,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
        polymarketTradeSummary: {
            seriesId: "test",
            outcomeRowsLoaded: trades.length,
            scoredTrades: trades.length,
            missingOutcomeTrades: 0,
        },
    };
}

function makeCapital(overrides: Partial<CapitalSettings>): CapitalSettings {
    return {
        initialCapital: 1000,
        positionSize: 100,
        commission: 0,
        sizingMode: "martingale",
        fixedTradeAmount: 100,
        advancedSizing: {
            martingaleMultiplier: 2,
            martingaleMaxSequence: 4,
            martingaleResetOnWin: true,
        },
        ...overrides,
    };
}

function applySizing(args: {
    trades: Trade[];
    capital?: Partial<CapitalSettings>;
    alternativeSizingEnabled?: boolean;
    settings?: BacktestSettings;
}): BacktestResult {
    const data = makeData(6);
    return applyPolymarketAlternativeSizing({
        result: makeResult(args.trades),
        chartData: data,
        backtestSettings: { executionModel: "next_open", ...(args.settings ?? {}) },
        capitalSettings: makeCapital(args.capital ?? {}),
        alternativeSizingEnabled: args.alternativeSizingEnabled ?? true,
    });
}

describe("Polymarket alternative sizing", () => {
    it("derives payout eligibility and skips duplicate trades", () => {
        const trade = makeTrade(1, makeData(2)[1]!.time, 0.5);
        const payout = resolvePolymarketTradePayout(trade);
        expect(payout.payout?.entryPrice).to.equal(0.5);
        expect(payout.payout?.sharePnl).to.equal(0.5);

        const duplicate = makeTrade(2, makeData(2)[1]!.time, 0, "duplicate");
        const skipped = resolvePolymarketTradePayout(duplicate);
        expect(skipped.payout).to.equal(null);
        expect(skipped.skipReason).to.equal("duplicate");
    });

    it("does not apply when alternative sizing is disabled or percent", () => {
        const data = makeData(3);
        const trades = [makeTrade(1, data[1]!.time, 0.5)];

        expect(applySizing({ trades, alternativeSizingEnabled: false }).trades[0]!.polymarketOutcome?.sizedStake).to.equal(undefined);
        expect(applySizing({ trades, capital: { sizingMode: "percent" } }).trades[0]!.polymarketOutcome?.sizedStake).to.equal(undefined);
    });

    it("sizes fixed amount alternative sizing from the configured base trade amount", () => {
        const data = makeData(3);
        const result = applySizing({
            trades: [makeTrade(1, data[1]!.time, 0.5)],
            capital: {
                sizingMode: "fixed",
                fixedTradeAmount: 100,
            },
        });

        expect(result.trades[0]!.polymarketOutcome?.sizedStake).to.equal(100);
        expect(result.trades[0]!.polymarketOutcome?.sizedShares).to.equal(200);
        expect(result.trades[0]!.polymarketOutcome?.sizedPnl).to.equal(100);
        expect(result.polymarketTradeSummary?.sizedSizingMode).to.equal("fixed");
        expect(result.polymarketTradeSummary?.sizedNetProfit).to.equal(100);
        expect(result.polymarketTradeSummary?.sizedAvgStake).to.equal(100);
    });

    it("sizes martingale from Polymarket losses instead of chart pnl", () => {
        const data = makeData(4);
        const result = applySizing({
            trades: [
                { ...makeTrade(1, data[1]!.time, -0.5), pnl: 50 },
                makeTrade(2, data[2]!.time, 0.5),
            ],
        });

        expect(result.trades[0]!.polymarketOutcome?.sizedStake).to.equal(1);
        expect(result.trades[0]!.polymarketOutcome?.sizedPnl).to.equal(-1);
        expect(result.trades[1]!.polymarketOutcome?.sizedStake).to.equal(2);
        expect(result.trades[1]!.polymarketOutcome?.sizedPnl).to.equal(2);
        expect(result.polymarketTradeSummary?.sizedFinalEquity).to.equal(1001);
    });

    it("sizes anti-martingale from Polymarket wins", () => {
        const data = makeData(4);
        const result = applySizing({
            trades: [
                makeTrade(1, data[1]!.time, 0.5),
                makeTrade(2, data[2]!.time, 0.5),
            ],
            capital: {
                sizingMode: "anti_martingale",
                advancedSizing: {
                    martingaleMultiplier: 2,
                    martingaleMaxSequence: 4,
                },
            },
        });

        expect(result.trades[0]!.polymarketOutcome?.sizedStake).to.equal(1);
        expect(result.trades[1]!.polymarketOutcome?.sizedStake).to.equal(2);
        expect(result.polymarketTradeSummary?.sizedNetProfit).to.equal(3);
    });

    it("lets Kelly change Polymarket dollar stake after enough unit-return history", () => {
        const data = makeData(6);
        const result = applySizing({
            trades: [
                makeTrade(1, data[0]!.time, 0.5),
                makeTrade(2, data[1]!.time, 0.5),
                makeTrade(3, data[2]!.time, 0.5),
                makeTrade(4, data[3]!.time, 0.5),
                makeTrade(5, data[4]!.time, -0.5),
                makeTrade(6, data[5]!.time, 0.5),
            ],
            capital: {
                sizingMode: "kelly_criterion",
                advancedSizing: {
                    kellyFraction: "half",
                    kellyWinRateCap: 0.7,
                    kellyProfitFactorCap: 1.2,
                },
            },
        });

        expect(result.trades[0]!.polymarketOutcome?.sizedStake).to.equal(1);
        expect(result.trades[4]!.polymarketOutcome?.sizedStake).to.equal(1);
        expect(result.trades[5]!.polymarketOutcome?.sizedStake).to.be.greaterThan(100);
    });

    it("floors positive Kelly Polymarket allocations to the $1 base stake", () => {
        const data = makeData(6);
        const result = applySizing({
            trades: [
                makeTrade(1, data[0]!.time, 0.3339),
                makeTrade(2, data[1]!.time, 0.3339),
                makeTrade(3, data[2]!.time, 0.3339),
                makeTrade(4, data[3]!.time, -0.5),
                makeTrade(5, data[4]!.time, -0.5),
                makeTrade(6, data[5]!.time, 0.3339),
            ],
            capital: {
                sizingMode: "kelly_criterion",
                advancedSizing: {
                    kellyFraction: "half",
                    kellyWinRateCap: 0.7,
                    kellyProfitFactorCap: 1,
                },
            },
        });

        expect(result.trades[5]!.polymarketOutcome?.sizedStake).to.equal(1);
    });

    it("does not require chart candle indexing for Kelly sizing", () => {
        const data = makeData(2);
        const result = applyPolymarketAlternativeSizing({
            result: makeResult([makeTrade(1, data[1]!.time, 0.5)]),
            chartData: [],
            backtestSettings: { executionModel: "next_open" },
            capitalSettings: makeCapital({ sizingMode: "kelly_criterion" }),
            alternativeSizingEnabled: true,
        });

        expect(result.trades[0]!.polymarketOutcome?.sizedStake).to.equal(1);
    });

    it("caps stake to bankroll and skips later trades after depletion", () => {
        const data = makeData(4);
        const result = applySizing({
            trades: [
                makeTrade(1, data[1]!.time, -0.5),
                makeTrade(2, data[2]!.time, 0.5),
            ],
            capital: {
                initialCapital: 0.5,
                fixedTradeAmount: 1000,
            },
        });

        expect(result.trades[0]!.polymarketOutcome?.sizedStake).to.equal(0.5);
        expect(result.trades[0]!.polymarketOutcome?.sizedStakeCapped).to.equal(true);
        expect(result.trades[1]!.polymarketOutcome?.sizedStake).to.equal(undefined);
        expect(result.polymarketTradeSummary?.sizedNoCapitalTrades).to.equal(1);
        expect(result.polymarketTradeSummary?.sizedSkippedTrades).to.equal(1);
    });

    it("does not let skipped Polymarket trades update martingale state", () => {
        const data = makeData(5);
        const result = applySizing({
            trades: [
                makeTrade(1, data[1]!.time, 0, "duplicate"),
                makeTrade(2, data[2]!.time, -0.5),
                makeTrade(3, data[3]!.time, 0.5),
            ],
        });

        expect(result.trades[0]!.polymarketOutcome?.sizedStake).to.equal(undefined);
        expect(result.trades[1]!.polymarketOutcome?.sizedStake).to.equal(1);
        expect(result.trades[2]!.polymarketOutcome?.sizedStake).to.equal(2);
    });

    it("renders sized Polymarket stake and profit in the trade row", () => {
        const data = makeData(3);
        const result = applySizing({
            trades: [makeTrade(1, data[1]!.time, 0.5)],
        });
        const renderer = new TradesRenderer() as unknown as {
            renderTradeItem: (trade: Trade, formatPrice: (price: number) => string, formatDate: (time: Trade["entryTime"]) => string) => string;
        };

        const html = renderer.renderTradeItem(
            result.trades[0]!,
            (price) => price.toFixed(2),
            (time) => String(time)
        );

        expect(html).to.include("Poly Stake: $1.00");
        expect(html).to.include("Shares: 2.00 @ 50.0c");
        expect(html).to.include("Profit:");
        expect(html).to.include("+$1.00");
        expect(html).to.not.include("Entry Value:");
    });
});
