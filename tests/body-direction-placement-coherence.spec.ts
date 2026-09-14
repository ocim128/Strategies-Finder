import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runBacktest } from "../lib/strategies/backtest/backtest-engine";
import { body_direction_placement_coherence } from "../lib/strategies/lib/body_direction_placement_coherence";
import type { OHLCVData, Time } from "../lib/types/strategies";

function buildCoherentBars(lastDirection: "up" | "down"): OHLCVData[] {
    return Array.from({ length: 31 }, (_, index) => {
        const bullish = index === 30
            ? lastDirection === "up"
            : index % 2 === 0;

        return {
            time: index as Time,
            open: bullish ? 100 : 102,
            high: 103,
            low: 99,
            close: bullish ? 102 : 100,
            volume: 1,
        };
    });
}

describe("Body Direction Placement Coherence", () => {
    it("fires on a coherent bullish bar", () => {
        const signals = body_direction_placement_coherence.execute(
            buildCoherentBars("up"),
            { coherenceThreshold: 0.7 },
        );

        assert.ok(signals.some((signal) => signal.type === "buy" && signal.barIndex === 30));
    });

    it("fires on a coherent bearish bar", () => {
        const signals = body_direction_placement_coherence.execute(
            buildCoherentBars("down"),
            { coherenceThreshold: 0.7 },
        );

        assert.ok(signals.some((signal) => signal.type === "sell" && signal.barIndex === 30));
    });

    it("turns a bearish signal into a short trade", () => {
        const data = [
            ...buildCoherentBars("down"),
            { time: 31 as Time, open: 100, high: 103, low: 99, close: 102, volume: 1 },
        ];
        const signals = body_direction_placement_coherence.execute(data, { coherenceThreshold: 0.7 });
        const result = runBacktest(data, signals, 10_000, 100, 0, {
            tradeDirection: "short",
            executionModel: "signal_close",
            stopLossEnabled: false,
            takeProfitEnabled: false,
        });

        assert.ok(result.totalTrades > 0);
        assert.ok(result.trades.some((trade) => trade.type === "short"));
    });
});
