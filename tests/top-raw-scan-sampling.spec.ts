import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseScanAssets, scanBudget, validateScanOptions, type ScanVote } from "../lib/batch-backtest/top-raw-scan-contract";
import { createScanPopulation, planScanDiscovery, planScanRefinement, reduceScanDiscovery, chooseScanFinalists, reduceScanFinalists } from "../lib/batch-backtest/top-raw-scan-sampling";

const assets = (n: number) => Array.from({ length: n }, (_, i) => `ASSET${i}•`);
describe("TOP_RAW scan input and bounded sampling", () => {
    it("accepts the complete maintained Nasdaq template and rejects ambiguous rows", () => {
        const templates = JSON.parse(readFileSync("lib/batch-backtest/batch-symbol-templates.json", "utf8"));
        assert.ok(parseScanAssets(templates.nasdaq).assets.length > 1000);
        assert.deepEqual(parseScanAssets(" aapl•\nMSFT•\nAAPL• "), { assets: ["AAPL•", "MSFT•"], rawCount: 3, duplicateCount: 1 });
        for (const bad of ["AAPL•\nMSFT", "AAPL•+MSFT•\nNVDA•", "AAPL•\nBTCUSDT", "AAPL•\nAAPL•"]) assert.throws(() => parseScanAssets(bad));
        assert.throws(() => parseScanAssets("A•\n".repeat(5001)), /5,000/);
        assert.throws(() => parseScanAssets("x".repeat(300000)), /256/);
        for (const options of [{ seed: -1 }, { seed: 0x100000000 }, { opponentsPerAsset: 0 }, { finalistCount: 101 }, { seed: null }, { opponentsPerAsset: "64" }]) assert.throws(() => validateScanOptions(options));
        assert.equal(validateScanOptions({ seed: 0 }).seed, 0);
        assert.throws(() => scanBudget(5000, { opponentsPerAsset: 256, finalistCount: 100, seed: 1 }), /1,000,000/);
    });
    it("preserves uniqueness, degree spread, input-order independence and stable direction", () => {
        for (let n = 2; n < 33; n++) for (const k of [1, 2, 3, 7, 32]) {
            const universe = assets(n), options = { opponentsPerAsset: k, finalistCount: 2, seed: 17 };
            const pairs = planScanDiscovery(universe, options);
            assert.deepEqual(pairs, planScanDiscovery([...universe].reverse(), options));
            assert.equal(new Set(pairs.map(p => p.key)).size, Math.min(n * (n - 1) / 2, Math.ceil(n * Math.min(k, n - 1) / 2)));
            const degrees = new Map(universe.map(a => [a, 0]));
            const full = createScanPopulation(universe, options.seed);
            for (const pair of pairs) { assert.notEqual(pair.base, pair.quote); degrees.set(pair.base, degrees.get(pair.base)! + 1); degrees.set(pair.quote, degrees.get(pair.quote)! + 1); assert.deepEqual(pair, full.pair(pair.quote, pair.base)); }
            assert.ok(Math.max(...degrees.values()) - Math.min(...degrees.values()) <= 1);
            assert.ok(Math.min(...degrees.values()) >= 1);
            const refined = planScanRefinement(universe, universe.slice(0, 2), options.seed, new Set(pairs.map(p => p.key)));
            for (const pair of refined) assert.deepEqual(pair, full.pair(pair.quote, pair.base));
        }
    });
    it("has symmetric empirical opponent inclusion across seeds", () => {
        const universe = assets(9), counts = new Map<string, number>();
        for (let seed = 0; seed < 4000; seed++) for (const pair of planScanDiscovery(universe, { opponentsPerAsset: 2, finalistCount: 2, seed })) counts.set(pair.key, (counts.get(pair.key) ?? 0) + 1);
        const mean = 1000;
        assert.equal(counts.size, 36);
        for (const count of counts.values()) assert.ok(Math.abs(count - mean) < 180, `inclusion ${count}`);
    });
    it("allocates only emitted relationships at 5,000 assets", () => {
        const universe = assets(5000), options = { opponentsPerAsset: 64, finalistCount: 20, seed: 1 };
        const pairs = planScanDiscovery(universe, options);
        assert.equal(pairs.length, 160000);
        const extra = planScanRefinement(universe, universe.slice(0, 20), 1, new Set(pairs.map(p => p.key)));
        assert.ok(extra.length <= 99790);
        assert.ok(pairs.length + extra.length <= scanBudget(5000, options).upper);
    });
    it("can miss the exhaustive winner even when the selected candidate has an exact positive score", () => {
        const universe = assets(8), options = { seed: 19, opponentsPerAsset: 1, finalistCount: 1 };
        const sample = planScanDiscovery(universe, options), pop = createScanPopulation(universe, options.seed);
        const hidden = sample[0]!.base, sampledOpponent = sample[0]!.quote, apparent = sample[1]!.base;
        const votes = new Map<string, ScanVote>(), sums = new Map(universe.map(asset => [asset, 0]));
        for (let i = 0; i < universe.length; i++) for (let j = i + 1; j < universe.length; j++) {
            const pair = pop.pair(universe[i]!, universe[j]!);
            let vote = 0;
            if ((pair.base === hidden || pair.quote === hidden) && pair.base !== sampledOpponent && pair.quote !== sampledOpponent) vote = pair.base === hidden ? 1 : -1;
            if (pair.key === sample[1]!.key) vote = pair.base === apparent ? 2 : -2;
            votes.set(pair.key, { key: pair.key, vote, active: Math.abs(vote), engine: "typescript" });
            sums.set(pair.base, sums.get(pair.base)! + vote); sums.set(pair.quote, sums.get(pair.quote)! - vote);
        }
        const selected = chooseScanFinalists(reduceScanDiscovery(universe, sample, votes), 1, options.seed).selected;
        assert.deepEqual(selected, [apparent]); assert.ok(!selected.includes(hidden));
        const verified = reduceScanFinalists(universe, selected, options.seed, votes)[0]!;
        assert.equal(verified.complete, true); assert.equal(verified.exactRaw, 1);
        assert.equal(sums.get(hidden), 6); assert.ok(sums.get(hidden)! > verified.exactRaw!);
    });
    it("counts flat opponents, freezes estimates, and never gives missing pairs exact scores", () => {
        const universe = assets(8), options = { opponentsPerAsset: 2, finalistCount: 3, seed: 3 };
        const sample = planScanDiscovery(universe, options), votes = new Map<string, ScanVote>();
        const population = createScanPopulation(universe, options.seed);
        // Independent exhaustive aggregation, with multiple/offsetting position counts.
        const expected = new Map(universe.map(a => [a, 0]));
        for (let i = 0; i < universe.length; i++) for (let j = i + 1; j < universe.length; j++) {
            const pair = population.pair(universe[i]!, universe[j]!), vote = (i * 3 + j) % 5 - 2;
            votes.set(pair.key, { key: pair.key, vote, active: Math.abs(vote), engine: "typescript" });
            expected.set(pair.base, expected.get(pair.base)! + vote); expected.set(pair.quote, expected.get(pair.quote)! - vote);
        }
        const rows = reduceScanDiscovery(universe, sample, votes), frozen = structuredClone(rows);
        for (const row of rows) assert.equal(row.estimatedRaw, 7 * row.sampledRaw / row.sampledDegree);
        const selection = chooseScanFinalists(rows, 3, options.seed);
        const exact = reduceScanFinalists(universe, selection.selected, options.seed, votes);
        for (const row of exact) assert.equal(row.exactRaw, expected.get(row.asset));
        assert.deepEqual(rows, frozen);
        const removed = sample[0]!; votes.delete(removed.key);
        const incomplete = reduceScanDiscovery(universe, sample, votes);
        assert.equal(incomplete.find(r => r.asset === removed.base)!.coverageComplete, false);
        assert.equal(reduceScanFinalists(universe, [removed.base], 3, votes)[0]!.exactRaw, null);
        const zeros = new Map(sample.map(p => [p.key, { key: p.key, vote: 0, active: 0, engine: "typescript" as const }]));
        const flat = reduceScanDiscovery(universe, sample, zeros);
        assert.ok(flat.every(r => r.estimatedRaw === 0 && r.flatDegree === r.sampledDegree && r.coverageComplete));
        const ties = chooseScanFinalists(flat, 3, 3);
        assert.equal(ties.cutoffTies.length, 8); assert.equal(ties.omittedCutoffTies.length, 5);
    });
    it("accumulates per-arm sums and ranks finalists by the selected arm", () => {
        const universe = assets(6), seed = 5, options = { opponentsPerAsset: 64, finalistCount: 3, seed };
        const sample = planScanDiscovery(universe, options), population = createScanPopulation(universe, seed);
        const votes = new Map<string, ScanVote>();
        // ASSET2 wins raw votes, ASSET1 wins both profit-now arms. The gated
        // vote and its confidence are antisymmetric, so the side sign and the
        // vote sign cancel: each pair contributes a constant to its asset.
        for (let i = 0; i < universe.length; i++) for (let j = i + 1; j < universe.length; j++) {
            const pair = population.pair(universe[i]!, universe[j]!);
            const raw = pair.base === universe[2] ? 3 : pair.quote === universe[2] ? -3 : 1;
            const gated = pair.base === universe[1] ? 40 : pair.quote === universe[1] ? -40 : pair.base === universe[2] ? -2 : 2;
            votes.set(pair.key, { key: pair.key, vote: raw, active: Math.abs(raw), engine: "typescript", profitNow: gated, profitNowConf: gated / 4 });
        }
        const rows = reduceScanDiscovery(universe, sample, votes);
        assert.equal(chooseScanFinalists(rows, 1, seed, "top_raw").selected[0]!, universe[2]);
        assert.equal(chooseScanFinalists(rows, 1, seed, "top_raw_profit_now").selected[0]!, universe[1]);
        assert.equal(chooseScanFinalists(rows, 1, seed, "top_mean_profit_now").selected[0]!, universe[1]);
        assert.equal(chooseScanFinalists(rows, 1, seed, "top_raw_profit_now_conf").selected[0]!, universe[1]);
        const maxActiveRows = reduceScanDiscovery(universe, planScanDiscovery(universe, { opponentsPerAsset: 1, finalistCount: 1, seed }), votes);
        assert.ok(maxActiveRows.every(row => row.activeDegree <= row.sampledDegree && row.estimatedActiveDegree! <= (universe.length - 1)));
        const finalist = reduceScanFinalists(universe, [universe[1], universe[2]], seed, votes);
        const byAsset = new Map(finalist.map(row => [row.asset, row]));
        assert.ok(byAsset.get(universe[1])!.complete);
        assert.equal(byAsset.get(universe[1])!.exactProfitNow, 40 * (universe.length - 1));
        assert.equal(byAsset.get(universe[1])!.exactProfitNowConf, 10 * (universe.length - 1));
        assert.equal(byAsset.get(universe[1])!.exactProfitNowActiveDegree, universe.length - 1);
        // Mean arms divide sums; with every pair active the mean equals the raw value.
        assert.equal(byAsset.get(universe[2])!.exactRaw! / byAsset.get(universe[2])!.exactActiveDegree!, 3);
    });
});
