/**
 * Measurement probe for the bounded EMA/ATR/ADX period-cache policy
 * (`INDICATOR_PERIOD_CACHE_BUDGET_BYTES` in lib/strategies/indicators.ts).
 *
 * Compares the shipped byte budget against fixed-count policies across the
 * sweep shapes the Finder actually produces (steps grids of a few periods,
 * representative multi-period analyses, and random-mode samples of up to
 * ~150 distinct periods) plus the pathological full-thrash cycle.
 *
 * Two independent columns per cell — they are NOT the same thing:
 * - `warmHits`: how many warm-pass requests returned the cold-pass series.
 *   Zero hits indicate churn (recomputation), not an empty cache.
 * - `occupancy`: estimated period-map size after the passes,
 *   min(distinct periods, effective capacity). Estimated retention multiplies
 *   occupancy by the series size — it is slot arithmetic, not a heap
 *   measurement, and misses temporary allocation (see the engine guide's
 *   memory-measurement caveat).
 *
 * Usage: npm run bench:indicator-cache
 */

import {
    calculateEMA,
    indicatorPeriodCapacityFor,
    setIndicatorPeriodCacheBudgetForMeasurement,
    INDICATOR_PERIOD_CACHE_BUDGET_BYTES,
} from "../lib/strategies/indicators";

type Policy = { label: string; budgetBytes: number };

const POLICIES: Policy[] = [
    { label: "shipped 16 MiB budget", budgetBytes: INDICATOR_PERIOD_CACHE_BUDGET_BYTES },
    { label: "fixed 32 periods", budgetBytes: 32 * 20_000 * 8 },
    { label: "fixed 128 periods (cap)", budgetBytes: 128 * 20_000 * 8 },
];

// Sweep shapes: [label, distinct periods walked per warm pass].
const SHAPES: Array<[string, number[]]> = [
    ["steps grid (3 periods)", [10, 14, 20]],
    ["representative defaults (8 periods)", [5, 10, 14, 20, 34, 50, 87, 162]],
    ["random-mode sample (40 periods)", Array.from({ length: 40 }, (_, i) => 3 + i * 2)],
    ["random-mode sample (140 periods)", Array.from({ length: 140 }, (_, i) => 3 + i)],
    ["thrash cycle (33 periods)", Array.from({ length: 33 }, (_, i) => 3 + i)],
];

const BARS = 20_000;
const seriesBytes = BARS * Float64Array.BYTES_PER_ELEMENT;

function makeDataset(): number[] {
    return Array.from({ length: BARS }, (_, i) => 100 + Math.sin(i / 9) * 5 + i * 0.01);
}

function measurePass(
    periods: number[],
    data: number[],
): { warmMs: number; warmHits: number } {
    const cold = periods.map((period) => calculateEMA(data, period));
    const warmStartedAt = performance.now();
    const warm = periods.map((period) => calculateEMA(data, period));
    const warmMs = performance.now() - warmStartedAt;
    // A warm result that is not the cold instance was recomputed (churn).
    let warmHits = 0;
    for (let index = 0; index < periods.length; index += 1) {
        if (warm[index] === cold[index]) warmHits += 1;
    }
    // Release the benchmark-held series arrays so a later heap measurement
    // (not performed here) would only see the cache's own retention.
    cold.length = 0;
    warm.length = 0;
    return { warmMs, warmHits };
}

console.log(`bars=${BARS} seriesBytes=${(seriesBytes / 1024).toFixed(0)}KB policies=${POLICIES.length}`);
for (const [shapeLabel, periods] of SHAPES) {
    console.log(`\n${shapeLabel}: ${periods.length} distinct periods, ideal retention ${(periods.length * seriesBytes / 1048576).toFixed(1)} MB`);
    for (const policy of POLICIES) {
        // A fresh dataset per cell: the WeakMap cache is keyed by array
        // identity, so reusing one array would leak hits across policies.
        const data = makeDataset();
        setIndicatorPeriodCacheBudgetForMeasurement(policy.budgetBytes);
        const capacity = indicatorPeriodCapacityFor(BARS);
        const { warmMs, warmHits } = measurePass(periods, data);
        // The period map holds at most min(distinct periods, capacity)
        // entries after these passes, regardless of hit rate.
        const occupancyPeriods = Math.min(periods.length, capacity);
        const occupancyBytes = occupancyPeriods * seriesBytes;
        console.log(
            `  ${policy.label.padEnd(22)} capacity=${String(capacity).padEnd(4)} warmHits=${warmHits}/${periods.length} warmMs=${warmMs.toFixed(2)} occupancy≈${occupancyPeriods} series ≈${(occupancyBytes / 1048576).toFixed(1)} MB (est.)`,
        );
    }
}
setIndicatorPeriodCacheBudgetForMeasurement(null);
