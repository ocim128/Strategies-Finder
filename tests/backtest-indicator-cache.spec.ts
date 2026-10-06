/**
 * Bounded period caches for the shared EMA/ATR/ADX indicator helpers.
 *
 * Parameter sweeps walk many periods per dataset, and the dataset-keyed
 * WeakMaps retain every computed series for the dataset's lifetime. The
 * bounded policy keeps the hottest periods cached: hits refresh recency,
 * insertion evicts the least-recently used period, and evicted recomputation
 * is value-equivalent. The bound is a byte budget (adapted to series length
 * and capped at INDICATOR_PERIOD_CACHE_MAX_PERIODS), so short datasets retain
 * every sweep period while long datasets keep the working set bounded. Other
 * indicator families stay unbounded and out of scope here.
 */
import { expect } from "chai";
import { describe, it, afterEach } from "node:test";
import {
    calculateADX,
    calculateATR,
    calculateEMA,
    indicatorPeriodCapacityFor,
    setIndicatorPeriodCacheBudgetForMeasurement,
    INDICATOR_PERIOD_CACHE_BUDGET_BYTES,
    INDICATOR_PERIOD_CACHE_MAX_PERIODS,
} from "../lib/strategies/indicators";

const LENGTH = 300;
const data = Array.from({ length: LENGTH }, (_, index) => 100 + Math.sin(index / 9) * 5 + index * 0.01);
const highs = data.map((close) => close + 1);
const lows = data.map((close) => close - 1);

afterEach(() => {
    setIndicatorPeriodCacheBudgetForMeasurement(null);
});

/** Force a deterministic small capacity so eviction is observable quickly. */
function withSmallBudget(periods: number): void {
    setIndicatorPeriodCacheBudgetForMeasurement(periods * LENGTH * Float64Array.BYTES_PER_ELEMENT);
}

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

    it("derives the capacity from the byte budget and caps it for short series", () => {
        // 300-bar series (~2.4 KB) fit well over the budget cap.
        expect(indicatorPeriodCapacityFor(LENGTH)).to.equal(INDICATOR_PERIOD_CACHE_MAX_PERIODS);
        // 1M-bar series (~8 MB) are limited by the 16 MiB budget.
        const longCapacity = indicatorPeriodCapacityFor(1_000_000);
        expect(longCapacity).to.be.at.least(1);
        expect(longCapacity).to.be.at.most(
            Math.floor(INDICATOR_PERIOD_CACHE_BUDGET_BYTES / (1_000_000 * Float64Array.BYTES_PER_ELEMENT)),
        );
        // The capacity never falls below one period.
        expect(indicatorPeriodCapacityFor(Number.MAX_SAFE_INTEGER)).to.equal(1);
    });

    it("keeps representative sweep periods fully cached at the shipped budget", () => {
        // Representative sweeps touch well under the budget-derived capacity:
        // every period stays cached (identical references, zero recomputation).
        const sweepPeriods = [3, 5, 8, 10, 12, 14, 16, 20, 24, 34, 50, 87, 120, 162, 200];
        const series = sweepPeriods.map((period) => calculateEMA(data, period));
        expect(sweepPeriods.map((period) => calculateEMA(data, period)))
            .to.deep.equal(series);
        for (let index = 0; index < series.length; index += 1) {
            expect(calculateEMA(data, sweepPeriods[index]!)).to.equal(series[index]);
        }
    });

    it("evicts least-recently used periods beyond capacity and recomputes value-equivalently", () => {
        withSmallBudget(16);
        const victim = 15;
        const original = calculateEMA(data, victim);

        // Push past capacity with untouched periods so `victim` is the LRU entry.
        fillPeriods(18, (period) => calculateEMA(data, period));

        const recomputed = calculateEMA(data, victim);
        expect(recomputed).to.not.equal(original);
        expect(recomputed).to.deep.equal(original);

        // The evicted entry was replaced by live periods, not unbounded growth:
        // re-fetching a recently inserted period still returns its reference.
        const recent = calculateEMA(data, 200 + 17);
        expect(calculateEMA(data, 200 + 17)).to.equal(recent);
    });

    it("refreshes recency on a hit so touched periods survive insertion", () => {
        withSmallBudget(16);
        const survivor = 20;
        const survivorSeries = calculateEMA(data, survivor);

        // Fill the cache so `survivor` is the oldest entry.
        fillPeriods(15, (period) => calculateEMA(data, period));
        // A hit moves `survivor` to the newest position.
        expect(calculateEMA(data, survivor)).to.equal(survivorSeries);
        // One more insertion would evict an untouched oldest entry — not the touched one.
        calculateEMA(data, 350);

        expect(calculateEMA(data, survivor)).to.equal(survivorSeries);
    });

    it("bounds ATR and ADX period maps with the same recency and value-equivalence contract", () => {
        withSmallBudget(16);
        const atrVictim = 21;
        const atrOriginal = calculateATR(highs, lows, data, atrVictim);
        fillPeriods(18, (period) => calculateATR(highs, lows, data, period));
        const atrRecomputed = calculateATR(highs, lows, data, atrVictim);
        expect(atrRecomputed).to.not.equal(atrOriginal);
        expect(atrRecomputed).to.deep.equal(atrOriginal);

        const adxSurvivor = 22;
        const adxSeries = calculateADX(highs, lows, data, adxSurvivor);
        fillPeriods(15, (period) => calculateADX(highs, lows, data, period));
        expect(calculateADX(highs, lows, data, adxSurvivor)).to.equal(adxSeries);
        calculateADX(highs, lows, data, 350);
        expect(calculateADX(highs, lows, data, adxSurvivor)).to.equal(adxSeries);
    });

    it("keeps numerical kernels deterministic across eviction and recomputation", () => {
        withSmallBudget(16);
        const period = 26;
        const reference = calculateEMA(data, period).map((value) => value ?? NaN);
        for (let round = 0; round < 3; round += 1) {
            fillPeriods(18, (p) => calculateEMA(data, p));
            const again = calculateEMA(data, period).map((value) => value ?? NaN);
            expect(again).to.deep.equal(reference);
        }
    });
});
