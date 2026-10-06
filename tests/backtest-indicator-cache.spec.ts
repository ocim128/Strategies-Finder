/**
 * Bounded period caches for the shared EMA/ATR/ADX indicator helpers.
 *
 * Parameter sweeps walk many periods per dataset, and the dataset-keyed
 * WeakMaps retain every computed series for the dataset's lifetime. The
 * bounded policy (INDICATOR_PERIOD_CACHE_CAPACITY) keeps the hottest periods
 * cached: hits refresh recency, insertion evicts the least-recently used
 * period, and evicted recomputation is value-equivalent. Other indicator
 * families stay unbounded and out of scope here.
 */
import { expect } from "chai";
import { describe, it } from "node:test";
import {
    calculateADX,
    calculateATR,
    calculateEMA,
    INDICATOR_PERIOD_CACHE_CAPACITY,
} from "../lib/strategies/indicators";

const LENGTH = 300;
const data = Array.from({ length: LENGTH }, (_, index) => 100 + Math.sin(index / 9) * 5 + index * 0.01);
const highs = data.map((close) => close + 1);
const lows = data.map((close) => close - 1);

function fillPeriods(beyond: number, compute: (period: number) => unknown): void {
    for (let period = 200; period < 200 + beyond; period += 1) {
        compute(period);
    }
}

describe("bounded indicator period caches", () => {
    it("retains a computed period and serves the identical series on repeat calls", () => {
        const first = calculateEMA(data, 12);
        expect(calculateEMA(data, 12)).to.equal(first);

        const atrFirst = calculateATR(highs, lows, data, 14);
        expect(calculateATR(highs, lows, data, 14)).to.equal(atrFirst);

        const adxFirst = calculateADX(highs, lows, data, 14);
        expect(calculateADX(highs, lows, data, 14)).to.equal(adxFirst);
    });

    it("evicts least-recently used periods beyond capacity and recomputes value-equivalently", () => {
        const victim = 15;
        const original = calculateEMA(data, victim);

        // Push past capacity with untouched periods so `victim` is the LRU entry.
        fillPeriods(INDICATOR_PERIOD_CACHE_CAPACITY + 2, (period) => calculateEMA(data, period));

        const recomputed = calculateEMA(data, victim);
        expect(recomputed).to.not.equal(original);
        expect(recomputed).to.deep.equal(original);

        // The evicted entry was replaced by live periods, not unbounded growth:
        // re-fetching a recently inserted period still returns its reference.
        const recent = calculateEMA(data, 200 + INDICATOR_PERIOD_CACHE_CAPACITY + 1);
        expect(calculateEMA(data, 200 + INDICATOR_PERIOD_CACHE_CAPACITY + 1)).to.equal(recent);
    });

    it("refreshes recency on a hit so touched periods survive insertion", () => {
        const survivor = 20;
        const survivorSeries = calculateEMA(data, survivor);

        // Fill the cache so `survivor` is the oldest entry.
        fillPeriods(INDICATOR_PERIOD_CACHE_CAPACITY - 1, (period) => calculateEMA(data, period));
        // A hit moves `survivor` to the newest position.
        expect(calculateEMA(data, survivor)).to.equal(survivorSeries);
        // One more insertion would evict an untouched oldest entry — not the touched one.
        calculateEMA(data, 350);

        expect(calculateEMA(data, survivor)).to.equal(survivorSeries);
    });

    it("bounds ATR and ADX period maps with the same recency and value-equivalence contract", () => {
        const atrVictim = 21;
        const atrOriginal = calculateATR(highs, lows, data, atrVictim);
        fillPeriods(INDICATOR_PERIOD_CACHE_CAPACITY + 2, (period) => calculateATR(highs, lows, data, period));
        const atrRecomputed = calculateATR(highs, lows, data, atrVictim);
        expect(atrRecomputed).to.not.equal(atrOriginal);
        expect(atrRecomputed).to.deep.equal(atrOriginal);

        const adxSurvivor = 22;
        const adxSeries = calculateADX(highs, lows, data, adxSurvivor);
        fillPeriods(INDICATOR_PERIOD_CACHE_CAPACITY - 1, (period) => calculateADX(highs, lows, data, period));
        expect(calculateADX(highs, lows, data, adxSurvivor)).to.equal(adxSeries);
        calculateADX(highs, lows, data, 350);
        expect(calculateADX(highs, lows, data, adxSurvivor)).to.equal(adxSeries);
    });

    it("keeps numerical kernels deterministic across eviction and recomputation", () => {
        const period = 26;
        const reference = calculateEMA(data, period).map((value) => value ?? NaN);
        for (let round = 0; round < 3; round += 1) {
            fillPeriods(INDICATOR_PERIOD_CACHE_CAPACITY + 2, (p) => calculateEMA(data, p));
            const again = calculateEMA(data, period).map((value) => value ?? NaN);
            expect(again).to.deep.equal(reference);
        }
    });
});
