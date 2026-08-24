import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { markIbkrSymbol } from "../lib/local-daily-datasets";
import { canonicalizeLegIdentity } from "../lib/synthetic-leg-identity";
import { normalizeAssetPairSet } from "../lib/batch-backtest/sp500-top-mean-archive-log";

const root = process.cwd();
const docsDir = join(root, "docs", "pairlist-pools");
const registryPath = join(docsDir, "BAL679.v1.json");
const textPath = join(docsDir, "BAL679.v1.txt");
const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
    schema: string;
    poolVersion: string;
    assets: string[];
    pairs: string[];
    pairListSha256: string;
    provenance: {
        algorithm: string;
        effectiveSeed: number;
        pairCount: number;
        orientationImbalanceMax: number;
    };
};

assert.equal(registry.schema, "pool-registry.v1");
assert.equal(registry.poolVersion, "BAL679.v1");
assert.equal(registry.assets.length, 70);
assert.deepEqual(
    [...registry.assets].sort((a, b) => a.localeCompare(b)),
    registry.assets,
    "registry assets must be sorted",
);
assert.equal(new Set(registry.assets).size, registry.assets.length, "registry assets must be unique");
assert.equal(registry.pairs.length, 679);
assert.equal(registry.provenance.algorithm, "seeded_round_robin_v1");
assert.equal(registry.provenance.effectiveSeed, 1);
assert.equal(registry.provenance.pairCount, 679);
assert.ok(registry.provenance.orientationImbalanceMax <= 1);

const degree = new Map(registry.assets.map((asset) => [asset, 0]));
const baseDegree = new Map(registry.assets.map((asset) => [asset, 0]));
const quoteDegree = new Map(registry.assets.map((asset) => [asset, 0]));
for (const pair of registry.pairs) {
    const [baseToken, quoteToken] = pair.split("+");
    assert.ok(baseToken && quoteToken, `invalid pair: ${pair}`);
    const base = canonicalizeLegIdentity(baseToken!)?.scoringAsset;
    const quote = canonicalizeLegIdentity(quoteToken!)?.scoringAsset;
    assert.ok(base && quote, `uncanonicalizable pair: ${pair}`);
    assert.ok(degree.has(base!), `pair references unknown base asset: ${base}`);
    assert.ok(degree.has(quote!), `pair references unknown quote asset: ${quote}`);
    degree.set(base!, degree.get(base!)! + 1);
    degree.set(quote!, degree.get(quote!)! + 1);
    baseDegree.set(base!, baseDegree.get(base!)! + 1);
    quoteDegree.set(quote!, quoteDegree.get(quote!)! + 1);
}
const degrees = [...degree.values()];
assert.ok(Math.max(...degrees) - Math.min(...degrees) <= 1);
const orientationImbalance = Math.max(
    ...registry.assets.map((asset) => Math.abs(baseDegree.get(asset)! - quoteDegree.get(asset)!)),
);
assert.equal(orientationImbalance, registry.provenance.orientationImbalanceMax);

const pairText = `${registry.pairs.join("\n")}\n`;
const pairHash = createHash("sha256").update(pairText, "utf8").digest("hex");
assert.equal(registry.pairListSha256, pairHash);
const markedPairs = registry.pairs.map((pair) => {
    const [baseToken, quoteToken] = pair.split("+");
    const base = canonicalizeLegIdentity(baseToken!);
    const quote = canonicalizeLegIdentity(quoteToken!);
    assert.ok(base && quote);
    return `${markIbkrSymbol(base.scoringAsset)}+${markIbkrSymbol(quote.scoringAsset)}`;
});
const markedPairText = `${markedPairs.join("\n")}\n`;
assert.equal(readFileSync(textPath, "utf8"), markedPairText);
assert.notEqual(createHash("sha256").update(readFileSync(textPath, "utf8"), "utf8").digest("hex"), pairHash);

const canonicalPairSet = normalizeAssetPairSet(registry.pairs);
const markedPairSet = normalizeAssetPairSet(markedPairs);
const flippedPairSet = normalizeAssetPairSet(markedPairs.map((pair) => {
    const [base, quote] = pair.split("+");
    return `${quote}+${base}`;
}));
assert.ok(canonicalPairSet && markedPairSet && flippedPairSet);
assert.deepEqual([...markedPairSet].sort(), [...canonicalPairSet].sort());
assert.deepEqual([...flippedPairSet].sort(), [...canonicalPairSet].sort());

const archiveDir = join(root, "archive", "batch-open-score", "pools");
for (const filename of ["BAL679.v1.json", "BAL679.v1.txt"]) {
    const archivePath = join(archiveDir, filename);
    if (existsSync(archivePath)) {
        assert.deepEqual(readFileSync(archivePath), readFileSync(join(docsDir, filename)));
    }
}

console.log("PASS: pairlist-pool-registry.spec.ts");
