import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../lib/types/strategies";
import { strategyManifest } from "../lib/strategies/manifest-eager";
import { mergeExitStrategySignals } from "../lib/exit-strategy-merge";

const retainedKeys = [
    "rsi_midline_confirmation",
    "cci_zero_line_confirmation",
    "williams_r_midline_confirmation",
    "stochastic_midline_confirmation",
    "parabolic_sar_confirmation",
    "aroon_direction_confirmation",
    "dmi_direction_confirmation",
] as const;

const newKeys = [
    "linear_regression_slope_confirmation",
    "qstick_zero_line_confirmation",
    "chande_momentum_midline_confirmation",
    "fisher_transform_zero_line_confirmation",
    "demarker_midline_confirmation",
    "relative_vigor_cross_confirmation",
    "ease_of_movement_confirmation",
    "force_index_confirmation",
    "accumulation_distribution_slope_confirmation",
    "chande_forecast_oscillator_confirmation",
    "klinger_oscillator_confirmation",
    "coppock_zero_line_confirmation",
] as const;

const keys = [...retainedKeys, ...newKeys] as const;

function buildData(length: number, direction: 1 | -1 = 1): OHLCVData[] {
    const data: OHLCVData[] = [];
    let close = 100;
    for (let i = 0; i < length; i++) {
        const previousClose = close;
        const regimeDirection = i < length / 2 ? direction : -direction;
        close += regimeDirection * (0.15 + (i % 7) * 0.03) + Math.sin(i / 4) * 0.12;
        const open = previousClose - regimeDirection * 0.05 + Math.sin(i / 3) * 0.08;
        data.push({
            time: (1_700_000_000 + i * 60) as Time,
            open,
            high: Math.max(open, close) + 0.7 + (i % 5) * 0.04,
            low: Math.min(open, close) - 0.6 - (i % 3) * 0.05,
            close: Math.max(1, close),
            volume: 1000 + (i % 9) * 100 + Math.round(150 * Math.sin(i / 5)),
        });
    }
    return data;
}

function getStrategy(key: string) {
    const found = strategyManifest.find((entry) => entry.key === key);
    expect(found, `${key} is in the generated manifest`).to.exist;
    return found!.strategy;
}

describe("traditional confirmation strategies", () => {
    it("exposes exactly one optimizable parameter and remains entry-capable", () => {
        for (const key of keys) {
            const strategy = getStrategy(key);
            expect(Object.keys(strategy.defaultParams), `${key} default params`).to.have.length(1);
            expect(Object.keys(strategy.paramLabels), `${key} labels`).to.deep.equal(Object.keys(strategy.defaultParams));
            expect(strategy.metadata?.role, `${key} role`).to.equal("entry");
            expect(strategy.metadata?.direction, `${key} direction`).to.equal("both");
            expect(strategy.metadata?.walkForwardParams, `${key} walk-forward params`)
                .to.deep.equal(Object.keys(strategy.defaultParams));
            expect(strategy.normalizeParams?.(strategy.defaultParams), `${key} normalized defaults`)
                .to.deep.equal(strategy.defaultParams);
        }
    });

    it("executes every retained and new strategy on a sufficiently long dataset", () => {
        const data = buildData(480);
        for (const key of keys) {
            const strategy = getStrategy(key);
            const signals = strategy.execute(data, strategy.defaultParams);
            expect(signals, `${key} signals`).to.be.an("array");
            expect(signals.length, `${key} emits directional state`).to.be.greaterThan(0);
            if ((newKeys as readonly string[]).includes(key)) {
                const signalTypes = new Set(signals.map((signal) => signal.type));
                expect(signalTypes, `${key} supports long and short direction`).to.deep.equal(new Set(["buy", "sell"]));
            }
            for (const signal of signals) {
                expect(["buy", "sell"]).to.include(signal.type);
                expect(signal.barIndex).to.be.a("number");
            }
        }
    });

    it("never changes past signals when future bars are appended", () => {
        const data = buildData(480);
        for (const key of newKeys) {
            const strategy = getStrategy(key);
            const fullSignals = strategy.execute(data, strategy.defaultParams);

            for (const cutoff of [120, 240, 360]) {
                const prefixSignals = strategy.execute(data.slice(0, cutoff), strategy.defaultParams);
                const expectedSignals = fullSignals.filter((signal) => signal.barIndex! < cutoff);
                expect(
                    prefixSignals.map(({ barIndex, time, type, price }) => ({ barIndex, time, type, price })),
                    `${key} prefix ${cutoff}`
                ).to.deep.equal(
                    expectedSignals.map(({ barIndex, time, type, price }) => ({ barIndex, time, type, price }))
                );
            }
        }
    });

    it("timestamps signals on the current bar and remains usable as an exit source", () => {
        const data = buildData(480);
        for (const key of newKeys) {
            const strategy = getStrategy(key);
            const signals = strategy.execute(data, strategy.defaultParams);
            for (const signal of signals) {
                const bar = data[signal.barIndex!];
                expect(signal.time, `${key} signal time`).to.equal(bar.time);
                expect(signal.price, `${key} signal price`).to.equal(bar.close);
            }

            const merged = mergeExitStrategySignals([], signals.slice(0, 3));
            expect(merged, `${key} exit merge`).to.have.length(Math.min(3, signals.length));
            expect(merged.every((signal) => signal.exitOnly === true), `${key} exit-only flags`).to.equal(true);
        }
    });
});
