import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateBalancedPairList } from "../lib/batch-backtest/balanced-pair-list-generator";
import { normalizeAssetPairSet } from "../lib/batch-backtest/sp500-top-mean-archive-log";

const root = process.cwd();
const l1MetaPath = join(root, "archive", "batch-open-score", "sp500_top_mean_1788443592188_cgd3", "meta.json");
const l1Meta = JSON.parse(readFileSync(l1MetaPath, "utf8")) as { canonicalAssets?: unknown; manifest?: { pairs?: { pairs?: unknown } } };
assert.ok(Array.isArray(l1Meta.manifest?.pairs?.pairs), "L1 meta has no pair list");

// v1.1 fix: the generator must be fed the MARKED asset tokens (e.g. "AAPL•") so
// emitted pairs carry the IBKR marker and the loader routes them to the IBKR
// price CSVs. Feeding canonicalAssets produced Binance-style USDT-derived
// tokens (KHCUSDT), which are wrong for this data surface. The marked catalog
// is derived from L1's own submitted pair legs — the exact submission form
// that loaded successfully for the entire L1 campaign.
const l1PairsRaw = l1Meta.manifest!.pairs!.pairs as string[];
const markedAssets = new Set<string>();
for (const pair of l1PairsRaw) {
    for (const leg of pair.split("+")) {
        const trimmed = leg.trim();
        if (!trimmed.endsWith("•")) throw new Error(`L1 leg lacks IBKR marker suffix: "${leg}"`);
        markedAssets.add(trimmed);
    }
}
const assets = [...markedAssets].sort((left, right) => left.localeCompare(right));
assert.equal(assets.length, 136, "L2 catalog must contain 136 L1 assets");
assert.deepEqual([...assets].sort((left, right) => left.localeCompare(right)), assets, "L1 marked assets must be sorted");

const generated = generateBalancedPairList({ assets, maxPairs: 5555, seed: 2 });
if (!generated.ok) throw new Error(generated.errors.join("; "));
assert.equal(generated.pairs.length, 5555);
for (const pair of generated.pairs) {
    for (const leg of pair.split("+")) {
        assert.ok(leg.endsWith("•"), `emitted leg lost the IBKR marker: ${pair}`);
    }
}
const degrees = Object.values(generated.degreeByAsset);
assert.deepEqual([Math.min(...degrees), median(degrees), Math.max(...degrees)], [81, 82, 82]);

const pairListSha256 = generated.provenance.executionOrderSha256;
const sortedSetSha256 = generated.provenance.sortedSetSha256;
if (!pairListSha256 || !sortedSetSha256) throw new Error("Generator did not emit SHA-256 pair-list provenance");
const catalogSha256 = hashLineList(assets);
const l1Pairs = normalizeAssetPairSet(l1Meta.manifest!.pairs!.pairs as string[]);
const l2Pairs = normalizeAssetPairSet(generated.pairs);
assert.ok(l1Pairs && l2Pairs);
let intersection = 0;
for (const pair of l2Pairs) if (l1Pairs.has(pair)) intersection += 1;
const union = new Set([...l1Pairs, ...l2Pairs]).size;
const jaccard = intersection / union;
assert.equal(intersection, 3351);
assert.equal(union, 7759);
assert.equal(Number(jaccard.toFixed(6)), 0.431886);
assert.ok(jaccard <= 0.8);

const registry = {
    schema: "pool-registry.v1",
    poolVersion: "BAL5555-S2.v1",
    assets,
    catalogSha256,
    pairs: generated.pairs,
    pairListSha256,
    relationshipSet: {
        normalization: "normalizeAssetPairSet; undirected canonical scoring-asset pairs",
        l1PoolVersion: "L1 archive manifest pair set",
        intersection,
        union,
        jaccard,
        gate: "jaccard <= 0.80",
    },
    provenance: {
        algorithm: generated.provenance.algorithm,
        effectiveSeed: generated.provenance.effectiveSeed,
        executionOrderSha256: pairListSha256,
        sortedSetSha256,
        generatorProvenance: generated.provenance,
    },
};
const docsDir = join(root, "docs", "pairlist-pools");
mkdirSync(docsDir, { recursive: true });
writeFileSync(join(docsDir, "BAL5555-S2.v1.json"), `${JSON.stringify(registry, null, 2)}\n`, "utf8");
writeFileSync(join(docsDir, "BAL5555-S2.v1.txt"), `${generated.pairs.join("\n")}\n`, "utf8");
console.log(`Wrote BAL5555-S2.v1 (${assets.length} assets, ${generated.pairs.length} pairs, degree=${Math.min(...degrees)}/${median(degrees)}/${Math.max(...degrees)}, Jaccard=${jaccard.toFixed(6)})`);

function median(values: readonly number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = sorted.length >> 1;
    return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function hashLineList(lines: readonly string[]): string {
    return createHash("sha256").update(`${lines.join("\n")}\n`, "utf8").digest("hex");
}
