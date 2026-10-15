import { createSeededRandom } from "../param-math-utils";
import { generateRelationships } from "./balanced-pair-list-generator";
import { scanBudget, TOP_RAW_SCAN_ORIENTATION, TOP_RAW_SCAN_SAMPLING, TOP_RAW_SCAN_TIES, type ScanOptions, type ScanPair, type ScanRow, type ScanVote, type ScanFinalist } from "./top-raw-scan-contract";

export function scanDomainSeed(seed: number, domain: string): number {
    let hash = 2166136261;
    for (let i = 0; i < domain.length; i++) hash = Math.imul(hash ^ domain.charCodeAt(i), 16777619);
    return (hash ^ seed) >>> 0;
}
export function scanPermutation(assets: readonly string[], seed: number, domain: string): string[] {
    const out = [...assets].sort(), random = createSeededRandom(scanDomainSeed(seed, domain));
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!]; }
    return out;
}
export function createScanPopulation(assets: readonly string[], seed: number) {
    const orientation = scanPermutation(assets, seed, TOP_RAW_SCAN_ORIENTATION);
    const positions = new Map(orientation.map((asset, i) => [asset, i]));
    const pair = (a: string, b: string): ScanPair => {
        const x = positions.get(a), y = positions.get(b);
        if (x === undefined || y === undefined || x === y) throw new Error("Pair outside frozen population.");
        const d = (y - x + assets.length) % assets.length;
        const forward = d < assets.length / 2 || (d === assets.length / 2 && x < y);
        const [base, quote] = forward ? [a, b] : [b, a];
        return { key: a < b ? `${a}|${b}` : `${b}|${a}`, base, quote, symbol: `${base}+${quote}` };
    };
    return { pair, orientation };
}
export function planScanDiscovery(assets: readonly string[], options: ScanOptions): ScanPair[] {
    const budget = scanBudget(assets.length, options), population = createScanPopulation(assets, options.seed);
    const sample = scanPermutation(assets, options.seed, TOP_RAW_SCAN_SAMPLING);
    return generateRelationships(sample.length, budget.discovery).map(edge => population.pair(sample[edge.aIdx]!, sample[edge.bIdx]!));
}
export function reduceScanDiscovery(assets: readonly string[], pairs: readonly ScanPair[], votes: ReadonlyMap<string, ScanVote>): ScanRow[] {
    const rows = new Map(assets.map(asset => [asset, { asset, sampledRaw: 0, estimatedRaw: null, sampledDegree: 0, evaluatedDegree: 0, failedDegree: 0, activePositions: 0, flatDegree: 0, coverageComplete: true } as ScanRow]));
    for (const pair of pairs) {
        const vote = votes.get(pair.key);
        for (const [asset, sign] of [[pair.base, 1], [pair.quote, -1]] as const) {
            const row = rows.get(asset)!; row.sampledDegree++;
            if (!vote || vote.error) { row.failedDegree++; row.coverageComplete = false; continue; }
            row.evaluatedDegree++; row.sampledRaw += sign * vote.vote; row.activePositions += vote.active;
            if (vote.active === 0) row.flatDegree++;
        }
    }
    for (const row of rows.values()) row.estimatedRaw = row.evaluatedDegree ? (assets.length - 1) * row.sampledRaw / row.evaluatedDegree : null;
    return [...rows.values()];
}
export function chooseScanFinalists(rows: readonly ScanRow[], count: number, seed: number) {
    const ties = new Map(scanPermutation(rows.map(r => r.asset), seed, TOP_RAW_SCAN_TIES).map((asset, index) => [asset, index]));
    const sorted = [...rows].sort((a, b) => (b.estimatedRaw ?? -Infinity) - (a.estimatedRaw ?? -Infinity) || ties.get(a.asset)! - ties.get(b.asset)!);
    const selected = sorted.slice(0, count), cutoff = selected.at(-1)?.estimatedRaw;
    const tied = sorted.filter(r => r.estimatedRaw === cutoff).map(r => r.asset);
    const cutoffTies = tied.length > 1 ? tied : [];
    return { selected: selected.map(r => r.asset), cutoffTies, omittedCutoffTies: sorted.slice(count).filter(r => r.estimatedRaw === cutoff).map(r => r.asset) };
}
export function planScanRefinement(assets: readonly string[], finalists: readonly string[], seed: number, existing: ReadonlySet<string>): ScanPair[] {
    const population = createScanPopulation(assets, seed), seen = new Set(existing), out: ScanPair[] = [];
    for (const asset of finalists) for (const opponent of assets) {
        if (asset === opponent) continue;
        const pair = population.pair(asset, opponent);
        if (!seen.has(pair.key)) { seen.add(pair.key); out.push(pair); }
    }
    return out;
}
export function reduceScanFinalists(assets: readonly string[], finalists: readonly string[], seed: number, votes: ReadonlyMap<string, ScanVote>): ScanFinalist[] {
    const population = createScanPopulation(assets, seed);
    return finalists.map((asset, index) => {
        let raw = 0, evaluated = 0, failed = 0;
        for (const opponent of assets) {
            if (asset === opponent) continue;
            const pair = population.pair(asset, opponent), vote = votes.get(pair.key);
            if (!vote || vote.error) { failed++; continue; }
            evaluated++; raw += (pair.base === asset ? 1 : -1) * vote.vote;
        }
        const complete = evaluated === assets.length - 1 && failed === 0;
        return { asset, candidateRank: index + 1, exactRaw: complete ? raw : null, evaluatedOpponents: evaluated, expectedOpponents: assets.length - 1, failedOpponents: failed, complete };
    });
}
