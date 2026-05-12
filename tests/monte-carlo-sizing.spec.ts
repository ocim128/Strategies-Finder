import { expect } from "chai";
import { describe, it } from "node:test";
import {
    runMonteCarloSimulation,
    type MonteCarloSettings,
    type MonteCarloSizingConfig,
} from "../lib/strategies/monte-carlo";
import { TRADE_SIZING_MODES, type TradeSizingMode } from "../lib/types/backtest";
import type { BacktestResult, OHLCVData, Time, Trade } from "../lib/types/strategies";

function createMonteCarloSettings(overrides: Partial<MonteCarloSettings> = {}): MonteCarloSettings {
    return {
        simulations: 1,
        seed: 1337,
        enableSequenceRandomization: false,
        enableBootstrap: false,
        enableParameterPerturbation: false,
        parameterPerturbationStdDev: 5,
        ruinThresholdPercent: 50,
        initialCapital: 10000,
        ...overrides,
    };
}

function createTrade(id: number, returnFraction: number): Trade {
    const entryPrice = 100;
    const size = 1;
    const pnl = entryPrice * size * returnFraction;
    return {
        id,
        type: "long",
        entryTime: `2024-01-0${id}T00:00:00.000Z` as Time,
        entryPrice,
        exitTime: `2024-01-0${id}T00:01:00.000Z` as Time,
        exitPrice: entryPrice * (1 + returnFraction),
        pnl,
        pnlPercent: returnFraction * 100,
        size,
        fees: 0,
        exitReason: "signal",
    };
}

function createOhlcvData(trades: readonly Trade[]): OHLCVData[] {
    return trades.map((trade, index) => {
        const close = 100 + index;
        return {
            time: trade.entryTime,
            open: close - 0.5,
            high: close + 1,
            low: close - 1,
            close,
            volume: 1000 + index,
        };
    });
}

function createBacktestResult(trades: Trade[]): BacktestResult {
    const netProfit = trades.reduce((sum, trade) => sum + trade.pnl, 0);
    const wins = trades.filter((trade) => trade.pnl > 0);
    const losses = trades.filter((trade) => trade.pnl <= 0);
    return {
        trades,
        netProfit,
        netProfitPercent: netProfit / 100,
        winRate: (wins.length / trades.length) * 100,
        expectancy: trades.length > 0 ? netProfit / trades.length : 0,
        avgTrade: trades.length > 0 ? netProfit / trades.length : 0,
        profitFactor: 1,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: trades.length,
        winningTrades: wins.length,
        losingTrades: losses.length,
        avgWin: wins.length > 0 ? wins.reduce((sum, trade) => sum + trade.pnl, 0) / wins.length : 0,
        avgLoss: losses.length > 0 ? Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0)) / losses.length : 0,
        sharpeRatio: 0,
        equityCurve: [],
    };
}

function createSizingConfig(
    mode: TradeSizingMode,
    trades: readonly Trade[],
    overrides: Partial<MonteCarloSizingConfig> = {},
): MonteCarloSizingConfig {
    return {
        mode,
        positionSizePercent: 10,
        fixedTradeAmount: 100,
        commissionPercent: 0,
        ohlcvData: createOhlcvData(trades),
        advancedSizing: {
            martingaleMultiplier: 2,
            martingaleMaxSequence: 4,
            martingaleResetOnWin: true,
            martingaleResetOnLoss: false,
            martingaleBaseSize: "fixed",
            optimalFBootstrapSamples: 10,
        },
        ...overrides,
    };
}

describe("monte carlo chart sizing", () => {
    it("recomputes anti-martingale allocation along the simulated path", async () => {
        const trades = [
            createTrade(1, 0.1),
            createTrade(2, 0.1),
            createTrade(3, -0.1),
            createTrade(4, 0.1),
            createTrade(5, -0.1),
        ];
        const backtestResult = createBacktestResult(trades);
        const settings = createMonteCarloSettings();

        const fixedPnlResult = await runMonteCarloSimulation(backtestResult, settings);
        expect(fixedPnlResult.metricSamples.netProfitValues[0]).to.be.closeTo(10, 1e-9);

        const sizedResult = await runMonteCarloSimulation(
            backtestResult,
            settings,
            createOhlcvData(trades),
            undefined,
            {
                sizing: createSizingConfig("anti_martingale", trades),
            },
        );

        expect(sizedResult.status).to.equal("success");
        expect(sizedResult.metricSamples.netProfitValues[0]).to.be.closeTo(-20, 1e-9);
    });

    it("changes sequence-only net profit when anti-martingale path order changes", async () => {
        const trades = [
            createTrade(1, 0.1),
            createTrade(2, 0.1),
            createTrade(3, -0.1),
            createTrade(4, 0.08),
            createTrade(5, -0.04),
            createTrade(6, 0.06),
            createTrade(7, -0.03),
            createTrade(8, 0.05),
        ];
        const backtestResult = createBacktestResult(trades);
        const data = createOhlcvData(trades);
        const settings = createMonteCarloSettings({
            simulations: 50,
            seed: 42,
            enableSequenceRandomization: true,
        });

        const result = await runMonteCarloSimulation(
            backtestResult,
            settings,
            data,
            undefined,
            {
                sizing: createSizingConfig("anti_martingale", trades, { ohlcvData: data }),
            },
        );

        const uniqueNetProfits = new Set(result.metricSamples.netProfitValues.map((value) => value.toFixed(6)));
        expect(uniqueNetProfits.size).to.be.greaterThan(1);
    });

    it("accepts every trade sizing mode for chart Monte Carlo paths", async () => {
        const trades = [
            createTrade(1, 0.04),
            createTrade(2, -0.02),
            createTrade(3, 0.03),
            createTrade(4, -0.01),
            createTrade(5, 0.02),
            createTrade(6, -0.015),
        ];
        const backtestResult = createBacktestResult(trades);
        const data = createOhlcvData(trades);

        for (const mode of TRADE_SIZING_MODES) {
            const result = await runMonteCarloSimulation(
                backtestResult,
                createMonteCarloSettings(),
                data,
                undefined,
                {
                    sizing: createSizingConfig(mode, trades, { ohlcvData: data }),
                },
            );

            expect(result.status, mode).to.equal("success");
            expect(Number.isFinite(result.metricSamples.netProfitValues[0]), mode).to.equal(true);
            expect(Number.isFinite(result.metricSamples.maxDrawdownPercentValues[0]), mode).to.equal(true);
        }
    });
});
