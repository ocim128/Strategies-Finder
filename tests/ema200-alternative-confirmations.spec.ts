import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Strategy, StrategyParams, Time } from "../lib/types/strategies";
import { strategyManifest } from "../lib/strategies/manifest-eager";
import { dema_confirmation } from "../lib/strategies/lib/dema_confirmation";
import { donchian_midpoint_confirmation } from "../lib/strategies/lib/donchian_midpoint_confirmation";
import { hull_ma_confirmation } from "../lib/strategies/lib/hull_ma_confirmation";
import { kama_confirmation } from "../lib/strategies/lib/kama_confirmation";
import { linear_regression_center_confirmation } from "../lib/strategies/lib/linear_regression_center_confirmation";
import { mcginley_dynamic_confirmation } from "../lib/strategies/lib/mcginley_dynamic_confirmation";
import { n_bar_momentum_confirmation } from "../lib/strategies/lib/n_bar_momentum_confirmation";
import { rolling_median_confirmation } from "../lib/strategies/lib/rolling_median_confirmation";
import { typical_price_ema_confirmation } from "../lib/strategies/lib/typical_price_ema_confirmation";
import { volume_weighted_median_confirmation } from "../lib/strategies/lib/volume_weighted_median_confirmation";
import { wilder_ma_confirmation } from "../lib/strategies/lib/wilder_ma_confirmation";
import { zero_lag_ema_confirmation } from "../lib/strategies/lib/zero_lag_ema_confirmation";

type Candidate = {
    key: string;
    paramKey: "lookback" | "period";
    strategy: Strategy;
};

const candidates: Candidate[] = [
    { key: "rolling_median_confirmation", paramKey: "lookback", strategy: rolling_median_confirmation },
    { key: "kama_confirmation", paramKey: "lookback", strategy: kama_confirmation },
    {
        key: "linear_regression_center_confirmation",
        paramKey: "lookback",
        strategy: linear_regression_center_confirmation,
    },
    { key: "donchian_midpoint_confirmation", paramKey: "lookback", strategy: donchian_midpoint_confirmation },
    { key: "zero_lag_ema_confirmation", paramKey: "lookback", strategy: zero_lag_ema_confirmation },
    { key: "hull_ma_confirmation", paramKey: "lookback", strategy: hull_ma_confirmation },
    { key: "wilder_ma_confirmation", paramKey: "lookback", strategy: wilder_ma_confirmation },
    { key: "dema_confirmation", paramKey: "lookback", strategy: dema_confirmation },
    { key: "n_bar_momentum_confirmation", paramKey: "lookback", strategy: n_bar_momentum_confirmation },
    { key: "mcginley_dynamic_confirmation", paramKey: "lookback", strategy: mcginley_dynamic_confirmation },
    { key: "typical_price_ema_confirmation", paramKey: "lookback", strategy: typical_price_ema_confirmation },
    {
        key: "volume_weighted_median_confirmation",
        paramKey: "lookback",
        strategy: volume_weighted_median_confirmation,
    },
];

function buildRegimeData(length: number): OHLCVData[] {
    const data: OHLCVData[] = [];
    let close = 300;

    for (let i = 0; i < length; i++) {
        const previousClose = close;
        const half = Math.floor(length / 2);
        const regimeIndex = i < half ? i : i - half;
        const direction = i < half ? 1 : -1;
        const acceleration = 0.08 + regimeIndex * 0.0012;
        close = Math.max(5, close + direction * acceleration + Math.sin(i / 9) * 0.035);
        const open = previousClose - direction * 0.025;
        data.push({
            time: (1_700_000_000 + i * 60) as Time,
            open,
            high: Math.max(open, close) + 0.8 + (i % 5) * 0.03,
            low: Math.min(open, close) - 0.7 - (i % 7) * 0.02,
            close,
            volume: 900 + (i % 13) * 90,
        });
    }
    return data;
}

function paramsFor(candidate: Candidate, value: number): StrategyParams {
    return { [candidate.paramKey]: value };
}

describe("EMA-200 alternative confirmation strategies", () => {
    it("keeps every candidate entry-capable with exactly one optimizable parameter", () => {
        expect(candidates).to.have.length(12);
        const manifestKeys = new Set(strategyManifest.map(({ key }) => key));

        for (const candidate of candidates) {
            const { strategy, paramKey, key } = candidate;
            expect(manifestKeys.has(key), `${key} generated manifest registration`).to.equal(true);
            expect(Object.keys(strategy.defaultParams), `${key} default params`).to.deep.equal([paramKey]);
            expect(Object.keys(strategy.paramLabels), `${key} labels`).to.deep.equal([paramKey]);
            expect(strategy.metadata?.role, `${key} role`).to.equal("entry");
            expect(strategy.metadata?.direction, `${key} direction`).to.equal("both");
            expect(strategy.metadata?.walkForwardParams, `${key} walk-forward params`).to.deep.equal([paramKey]);
            expect(strategy.normalizeParams?.(strategy.defaultParams), `${key} normalized defaults`)
                .to.deep.equal(strategy.defaultParams);
            expect(strategy.normalizeParams?.(paramsFor(candidate, 19.6))[paramKey], `${key} rounds`)
                .to.equal(20);
            expect(strategy.normalizeParams?.(paramsFor(candidate, -5))[paramKey], `${key} clamps`)
                .to.equal(2);
        }
    });

    it("emits persistent bullish and bearish regime state on current bars", () => {
        const data = buildRegimeData(1800);

        for (const candidate of candidates) {
            const signals = candidate.strategy.execute(data, paramsFor(candidate, 200));
            const signalTypes = new Set(signals.map((signal) => signal.type));
            expect(signalTypes, `${candidate.key} directions`).to.deep.equal(new Set(["buy", "sell"]));
            expect(signals.some((signal, i) =>
                i > 0
                && signal.type === signals[i - 1].type
                && signal.barIndex === signals[i - 1].barIndex! + 1
            ), `${candidate.key} persistent state`).to.equal(true);

            for (const signal of signals) {
                const bar = data[signal.barIndex!];
                expect(signal.time, `${candidate.key} time`).to.equal(bar.time);
                expect(signal.price, `${candidate.key} price`).to.equal(bar.close);
            }
        }
    });

    it("never rewrites historical confirmation state when future bars are appended", () => {
        const data = buildRegimeData(720);

        for (const candidate of candidates) {
            const params = paramsFor(candidate, 40);
            const fullSignals = candidate.strategy.execute(data, params);

            for (const cutoff of [180, 360, 540]) {
                const prefixSignals = candidate.strategy.execute(data.slice(0, cutoff), params);
                const expectedSignals = fullSignals.filter((signal) => signal.barIndex! < cutoff);
                expect(
                    prefixSignals.map(({ barIndex, time, type, price }) => ({ barIndex, time, type, price })),
                    `${candidate.key} prefix ${cutoff}`
                ).to.deep.equal(
                    expectedSignals.map(({ barIndex, time, type, price }) => ({ barIndex, time, type, price }))
                );
            }
        }
    });

    it("keeps direct and Finder-prepared median execution identical", () => {
        const data = buildRegimeData(720);

        for (const candidate of candidates.filter(({ strategy }) =>
            strategy.prepareFinderData && strategy.executePrepared
        )) {
            const params = paramsFor(candidate, 40);
            const directSignals = candidate.strategy.execute(data, params);
            const preparedData = candidate.strategy.prepareFinderData!(data);
            const preparedSignals = candidate.strategy.executePrepared!(preparedData, params, data);
            expect(preparedSignals, `${candidate.key} prepared parity`).to.deep.equal(directSignals);
        }
    });
});
