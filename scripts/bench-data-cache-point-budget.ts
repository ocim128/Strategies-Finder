/**
 * Measurement probe for the DataCache retained-points budget
 * (`DataCache.DEFAULT_MAX_POINTS` in lib/data/data-cache.ts).
 *
 * Runs one deterministic churn workload — a fixed seeded sequence of dataset
 * loads, updates, and realtime growth notifications over a key space larger
 * than any budget holds — under two retention policies:
 *
 * - `entry-only (Infinity)`: the former behavior, bounded only by the
 *   64-entry LRU.
 * - `default (1,000,000 points)`: the shipped dual budget.
 *
 * Reported per policy: retained points at the end, peak retained points,
 * cache evictions, source requests (cache misses that triggered a load),
 * elapsed time for the workload loop, and Node heapUsed around the loop.
 *
 * Measurement caveats, stated rather than hidden: elapsed time covers cache
 * operations plus array bookkeeping in this script, not real network or parse
 * work; heapUsed is a point-in-time Node reading (no forced GC), so it bounds
 * nothing; and source requests here are a counter, not provider calls. The
 * workload is synthetic — it is evidence about cache mechanics under churn,
 * not an end-to-end application benchmark.
 *
 * Usage: npm run bench:data-cache-budget
 */

import { DataCache } from "../lib/data/data-cache";
import type { OHLCVData, Time } from "../lib/types/strategies";

// Deterministic PRNG so every policy sees the identical op sequence.
function makeLcg(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        return state / 0x1_0000_0000;
    };
}

const KEY_COUNT = 80;
const OP_COUNT = 6_000;
const SEED = 2026_10_09;

// Representative dataset sizes: chart-scale loads dominate, large historical
// and research-scale loads appear regularly, and one size class exceeds the
// whole default budget (unretainable under the dual budget).
const SIZE_CLASSES: Array<{ weight: number; size: number }> = [
    { weight: 0.5, size: 4_000 },
    { weight: 0.25, size: 12_000 },
    { weight: 0.15, size: 60_000 },
    { weight: 0.09, size: 120_000 },
    { weight: 0.01, size: 1_200_000 },
];

function pickSize(random: number): number {
    let cumulative = 0;
    for (const entry of SIZE_CLASSES) {
        cumulative += entry.weight;
        if (random <= cumulative) return entry.size;
    }
    return SIZE_CLASSES[SIZE_CLASSES.length - 1]!.size;
}

function makeCandles(size: number, salt: number): OHLCVData[] {
    const candles: OHLCVData[] = new Array(size);
    for (let index = 0; index < size; index += 1) {
        const time = 1_700_000_000 + index * 60;
        const open = 100 + ((index + salt) % 97) * 0.01;
        candles[index] = { time: time as Time, open, high: open + 1, low: open - 1, close: open + 0.5, volume: 1 };
    }
    return candles;
}

interface WorkloadOp {
    kind: "load" | "update" | "notify";
    key: string;
    size: number;
    salt: number;
}

function buildWorkload(): WorkloadOp[] {
    const random = makeLcg(SEED);
    const ops: WorkloadOp[] = [];
    for (let index = 0; index < OP_COUNT; index += 1) {
        const roll = random();
        const kind = roll < 0.8 ? "load" : roll < 0.95 ? "update" : "notify";
        ops.push({
            kind,
            key: `KEY${Math.floor(random() * KEY_COUNT)}::4h`,
            size: pickSize(random()),
            salt: index,
        });
    }
    return ops;
}

interface PolicyResult {
    label: string;
    finalPoints: number;
    peakPoints: number;
    evictions: number;
    sourceRequests: number;
    elapsedMs: number;
    heapUsedStartMb: number;
    heapUsedEndMb: number;
}

function runPolicy(label: string, maxPoints: number, workload: WorkloadOp[]): PolicyResult {
    const cache = new DataCache({ maxPoints });
    // Arrays are fabricated per op so a retained entry always owns distinct
    // storage, like real loads do. This allocation is inside the timed loop —
    // it models the parse/allocate cost that follows a real cache miss.
    let peakPoints = 0;
    let sourceRequests = 0;
    global.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = process.hrtime.bigint();

    for (const op of workload) {
        const cached = cache.get(op.key);
        if (cached === undefined) {
            sourceRequests += 1;
            const candles = makeCandles(op.size, op.salt);
            cache.set(op.key, candles, "network");
        } else if (op.kind === "update") {
            cache.updateCandles(op.key, makeCandles(op.size, op.salt), {});
        } else if (op.kind === "notify") {
            // Model an accepted stream push: grow the cached array in place.
            cached.candles.push({
                time: 1_800_000_000 as OHLCVData["time"],
                open: 100, high: 101, low: 99, close: 100, volume: 1,
            });
            cache.notifyCandleArrayMutation(op.key);
        }
        if (cache.points > peakPoints) peakPoints = cache.points;
    }

    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const heapEnd = process.memoryUsage().heapUsed;
    return {
        label,
        finalPoints: cache.points,
        peakPoints,
        evictions: cache.evictions,
        sourceRequests,
        elapsedMs,
        heapUsedStartMb: heapBefore / 1024 / 1024,
        heapUsedEndMb: heapEnd / 1024 / 1024,
    };
}

function main(): void {
    const workload = buildWorkload();
    console.log(`workload: ${OP_COUNT} deterministic ops over ${KEY_COUNT} keys (seed ${SEED})`);
    console.log(`size classes: ${SIZE_CLASSES.map((c) => c.size).join("/")} points\n`);

    const results = [
        runPolicy("entry-only (Infinity, former policy)", Infinity, workload),
        runPolicy("default (1,000,000 points)", DataCache.DEFAULT_MAX_POINTS, workload),
    ];

    const columns: Array<[string, (row: PolicyResult) => string]> = [
        ["policy", (row) => row.label],
        ["final points", (row) => String(row.finalPoints)],
        ["peak points", (row) => String(row.peakPoints)],
        ["evictions", (row) => String(row.evictions)],
        ["source requests", (row) => String(row.sourceRequests)],
        ["elapsed ms", (row) => row.elapsedMs.toFixed(1)],
        ["heap start/end MB", (row) => `${row.heapUsedStartMb.toFixed(0)}/${row.heapUsedEndMb.toFixed(0)}`],
    ];
    const widths = columns.map(([header, render]) => Math.max(header.length, ...results.map((row) => render(row).length)));
    const header = columns.map(([header], index) => header.padEnd(widths[index]!)).join("  ");
    console.log(header);
    console.log(widths.map((width) => "-".repeat(width)).join("  "));
    for (const row of results) {
        console.log(columns.map(([, render], index) => render(row).padEnd(widths[index]!)).join("  "));
    }
}

main();
