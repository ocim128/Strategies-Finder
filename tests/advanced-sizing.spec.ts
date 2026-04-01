import { expect } from "chai";
import { describe, it } from "node:test";
import { calculateKelly, createKellySizingState, updateKellyState } from "../lib/strategies/sizing/kelly-criterion";
import { updateMartingaleState, resolveMartingaleMultiplier, createMartingaleState } from "../lib/strategies/sizing/martingale";
import { calculateSecureF } from "../lib/strategies/sizing/optimal-f";
import { resolveVolTargetingMultiplier } from "../lib/strategies/sizing/volatility-targeting";
import { buildPositionFromSignal } from "../lib/strategies/backtest/position-builder";
import { normalizeBacktestSettings } from "../lib/strategies/backtest/backtest-utils";
import { runBacktest, type OHLCVData, type Signal, type Time } from "../lib/strategies";
import { runStrategyBacktest } from "../lib/finder/finder-runner-shared";

describe("Advanced sizing", () => {
    it("calculates half Kelly from rolling trade history", () => {
        const state = createKellySizingState();
        for (let i = 0; i < 6; i++) {
            updateKellyState(state, { pnl: 200, isWin: true });
        }
        for (let i = 0; i < 4; i++) {
            updateKellyState(state, { pnl: -80, isWin: false });
        }

        const result = calculateKelly(state, {
            kellyFraction: "half",
            kellyWinRateCap: 0.95,
            kellyProfitFactorCap: 1.2,
        });

        expect(result.isValid).to.equal(true);
        expect(result.appliedFraction).to.be.closeTo(0.125, 0.001);
    });

    it("scales up when realized volatility is below the target", () => {
        const calmData: OHLCVData[] = [
            { time: "2024-01-01" as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: "2024-01-02" as Time, open: 100, high: 101, low: 99, close: 100.4, volume: 1000 },
            { time: "2024-01-03" as Time, open: 100.4, high: 101, low: 100, close: 100.8, volume: 1000 },
            { time: "2024-01-04" as Time, open: 100.8, high: 101.4, low: 100.5, close: 101.1, volume: 1000 },
            { time: "2024-01-05" as Time, open: 101.1, high: 101.7, low: 100.8, close: 101.3, volume: 1000 },
        ];

        const multiplier = resolveVolTargetingMultiplier(calmData, calmData.length - 1, {
            volTargetAnnual: 0.25,
            volLookbackBars: 4,
            volScalingMethod: "sma",
        });

        expect(multiplier).to.be.greaterThan(1);
    });

    it("progresses and resets martingale sequences correctly", () => {
        const state = createMartingaleState();
        updateMartingaleState(state, { pnl: -100, isWin: false }, { martingaleMaxSequence: 4 }, false);
        expect(resolveMartingaleMultiplier(state, { martingaleMultiplier: 2 })).to.equal(2);

        updateMartingaleState(state, { pnl: -50, isWin: false }, { martingaleMaxSequence: 4 }, false);
        expect(resolveMartingaleMultiplier(state, { martingaleMultiplier: 2 })).to.equal(4);

        updateMartingaleState(state, { pnl: 120, isWin: true }, { martingaleResetOnWin: true }, false);
        expect(resolveMartingaleMultiplier(state, { martingaleMultiplier: 2 })).to.equal(1);
    });

    it("keeps secure f below or equal to optimal f", () => {
        const result = calculateSecureF([120, -60, 80, -40, 110, -30, 70, 55], {
            secureFMethod: "bootstrap",
            optimalFBootstrapSamples: 50,
            secureFConfidence: 0.9,
        });

        expect(result.optimalF).to.be.greaterThan(0);
        expect(result.secureF).to.be.greaterThan(0);
        expect(result.secureF).to.be.at.most(result.optimalF);
    });

    it("sizes martingale entries above the base amount after a loss", () => {
        const data: OHLCVData[] = [
            { time: "2024-02-01" as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: "2024-02-02" as Time, open: 100, high: 101, low: 89, close: 90, volume: 1000 },
            { time: "2024-02-03" as Time, open: 100, high: 100, low: 99, close: 100, volume: 1000 },
            { time: "2024-02-04" as Time, open: 100, high: 111, low: 99, close: 110, volume: 1000 },
        ];
        const signals: Signal[] = [
            { time: "2024-02-01" as Time, type: "buy", price: 100 },
            { time: "2024-02-02" as Time, type: "sell", price: 90 },
            { time: "2024-02-03" as Time, type: "buy", price: 100 },
            { time: "2024-02-04" as Time, type: "sell", price: 110 },
        ];

        const result = runBacktest(
            data,
            signals,
            1000,
            100,
            0,
            { executionModel: "signal_close" },
            {
                mode: "martingale",
                fixedTradeAmount: 100,
                advancedSizing: {
                    martingaleMultiplier: 2,
                    martingaleMaxSequence: 4,
                    martingaleResetOnWin: true,
                },
            }
        );

        expect(result.totalTrades).to.equal(2);
        expect(result.trades[0].size).to.be.closeTo(1, 1e-9);
        expect(result.trades[1].size).to.be.closeTo(2, 1e-9);
    });

    it("uses Kelly allocation directly from capital when history is strong enough", () => {
        const config = normalizeBacktestSettings({ riskMode: "simple", executionModel: "signal_close" });
        const signal: Signal = { time: "2024-03-01" as Time, type: "buy", price: 100 };
        const data: OHLCVData[] = [
            { time: "2024-03-01" as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
        ];

        const state = createKellySizingState();
        for (let i = 0; i < 8; i++) {
            updateKellyState(state, { pnl: 150, isWin: true });
        }
        for (let i = 0; i < 2; i++) {
            updateKellyState(state, { pnl: -50, isWin: false });
        }

        const built = buildPositionFromSignal({
            signal,
            barIndex: 0,
            capital: 10000,
            initialCapital: 10000,
            positionSizePercent: 100,
            commissionRate: 0,
            slippageRate: 0,
            settings: config,
            data,
            atrArray: [null],
            tradeDirection: "long",
            sizingMode: "kelly_criterion",
            fixedTradeAmount: 1000,
            advancedSizing: {
                kellyFraction: "half",
                kellyWinRateCap: 0.9,
                kellyProfitFactorCap: 1.2,
            },
            smartSizingState: {
                recentVelocityScores: [],
                kellyState: state,
            },
        });

        expect(built).to.not.equal(null);
        expect(built!.nextPosition.size).to.be.greaterThan(10);
    });

    it("passes Finder advanced Kelly sizing through to the backtest engine", () => {
        const captured: Array<{
            mode: string;
            fixedTradeAmount: number;
            advancedSizing?: { kellyFraction?: string };
        }> = [];
        const data: OHLCVData[] = [
            { time: "2024-03-01" as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
        ];
        const signals: Signal[] = [{ time: "2024-03-01" as Time, type: "buy", price: 100 }];

        runStrategyBacktest({
            strategy: {
                name: "Finder Kelly passthrough",
                description: "Regression test",
                defaultParams: {},
                execute: () => signals,
            },
            data,
            signals,
            params: {},
            capitalSettings: {
                initialCapital: 10000,
                positionSize: 100,
                commission: 0,
                sizingMode: "kelly_criterion",
                fixedTradeAmount: 1000,
                advancedSizing: {
                    kellyFraction: "quarter",
                },
            },
            backtestSettings: { executionModel: "signal_close" },
            backtestFn: ((...args: unknown[]) => {
                captured.push(args[6] as {
                    mode: string;
                    fixedTradeAmount: number;
                    advancedSizing?: { kellyFraction?: string };
                });
                return {
                    netProfit: 0,
                    netProfitPercent: 0,
                    totalTrades: 0,
                    winningTrades: 0,
                    losingTrades: 0,
                    winRate: 0,
                    avgTrade: 0,
                    avgBarsInTrade: 0,
                    maxDrawdown: 0,
                    maxDrawdownPercent: 0,
                    profitFactor: 0,
                    expectancy: 0,
                    sharpeRatio: 0,
                    trades: [],
                    equityCurve: [],
                };
            }) as typeof runBacktest,
        });

        expect(captured).to.have.length(1);
        expect(captured[0]?.mode).to.equal("kelly_criterion");
        expect(captured[0]?.advancedSizing?.kellyFraction).to.equal("quarter");
    });
});
