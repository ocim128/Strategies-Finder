import { expect } from "chai";
import { describe, it } from "node:test";
import fixture from "./fixtures/rust-next-open-parity.json";
import { runBacktest } from "../lib/strategies/backtest/backtest-engine";
import type { BacktestSettings, OHLCVData, Signal } from "../lib/types/strategies";
import type { TradeSizingConfig } from "../lib/types/backtest";

const TRADE_NUMERIC_FIELDS = [
    "entryPrice",
    "exitPrice",
    "pnl",
    "pnlPercent",
    "size",
    "fees",
] as const;

const RESULT_NUMERIC_FIELDS = [
    "netProfit",
    "netProfitPercent",
    "maxDrawdown",
    "maxDrawdownPercent",
] as const;

describe("shared TypeScript/Rust next_open parity fixture", () => {
    it("keeps TypeScript output aligned with the golden fixture", () => {
        for (const testCase of fixture.cases) {
            const result = runBacktest(
                testCase.data as unknown as OHLCVData[],
                testCase.signals as unknown as Signal[],
                testCase.capital.initialCapital,
                testCase.capital.positionSizePercent,
                testCase.capital.commissionPercent,
                testCase.settings as BacktestSettings,
                testCase.capital.sizing as Partial<TradeSizingConfig>,
            );
            const expected = testCase.expected;
            expect(result.trades, testCase.name).to.have.length(expected.trades.length);
            for (let index = 0; index < expected.trades.length; index += 1) {
                const actualTrade = result.trades[index]!;
                const expectedTrade = expected.trades[index]!;
                expect(actualTrade.id, `${testCase.name} trade ${index} id`).to.equal(expectedTrade.id);
                expect(actualTrade.type, `${testCase.name} trade ${index} type`).to.equal(expectedTrade.type);
                expect(actualTrade.entryTime, `${testCase.name} trade ${index} entryTime`).to.equal(expectedTrade.entryTime);
                expect(actualTrade.exitTime, `${testCase.name} trade ${index} exitTime`).to.equal(expectedTrade.exitTime);
                expect(actualTrade.exitReason, `${testCase.name} trade ${index} exitReason`).to.equal(expectedTrade.exitReason);
                for (const field of TRADE_NUMERIC_FIELDS) {
                    expect(actualTrade[field], `${testCase.name} trade ${index} ${field}`).to.be.closeTo(expectedTrade[field], 1e-9);
                }
            }
            for (const field of RESULT_NUMERIC_FIELDS) {
                expect(result[field], `${testCase.name} ${field}`).to.be.closeTo(expected[field], 1e-9);
            }
            expect(result.totalTrades, `${testCase.name} totalTrades`).to.equal(expected.totalTrades);
            expect(result.winningTrades, `${testCase.name} winningTrades`).to.equal(expected.winningTrades);
            expect(result.losingTrades, `${testCase.name} losingTrades`).to.equal(expected.losingTrades);
        }
    });
});
