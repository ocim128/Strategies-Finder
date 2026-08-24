import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateBalancedPairList } from "../lib/batch-backtest/balanced-pair-list-generator";
import { canonicalizeLegIdentity } from "../lib/synthetic-leg-identity";
import { markIbkrSymbol } from "../lib/local-daily-datasets";

const root = process.cwd();
const sourceMetaPath = join(
    root,
    "archive",
    "batch-open-score",
    "sp500_top_mean_1787544471953_69h7",
    "meta.json",
);
const sourceMeta = JSON.parse(readFileSync(sourceMetaPath, "utf8")) as {
    canonicalAssets?: unknown;
};
assert.ok(Array.isArray(sourceMeta.canonicalAssets), "Archived run has no canonicalAssets array");
const assets = sourceMeta.canonicalAssets as string[];
assert.equal(assets.length, 70, "BAL679 requires exactly 70 assets");
assert.deepEqual([...assets].sort((a, b) => a.localeCompare(b)), assets, "Assets must already be sorted");
assert.equal(new Set(assets).size, assets.length, "Assets must be unique");

const generated = generateBalancedPairList({ assets, maxPairs: 679, seed: 1 });
if (!generated.ok) throw new Error(generated.errors.join("; "));
assert.equal(generated.pairs.length, 679, "Generator must emit 679 pairs");
const degrees = Object.values(generated.degreeByAsset);
assert.ok(Math.max(...degrees) - Math.min(...degrees) <= 1, "Pair degrees must differ by at most one");
assert.ok(generated.provenance.orientationImbalanceMax <= 1, "Orientation imbalance must be at most one");

const pairText = `${generated.pairs.join("\n")}\n`;
const pairListSha256 = createHash("sha256").update(pairText, "utf8").digest("hex");
const markedPairText = `${generated.pairs.map((pair) => {
    const [baseToken, quoteToken] = pair.split("+");
    assert.ok(baseToken && quoteToken, `Malformed generated pair: ${pair}`);
    const base = canonicalizeLegIdentity(baseToken);
    const quote = canonicalizeLegIdentity(quoteToken);
    assert.ok(base && quote, `Cannot canonicalize generated pair: ${pair}`);
    return `${markIbkrSymbol(base.scoringAsset)}+${markIbkrSymbol(quote.scoringAsset)}`;
}).join("\n")}\n`;
const registry = {
    schema: "pool-registry.v1",
    poolVersion: "BAL679.v1",
    assets,
    pairs: generated.pairs,
    pairListSha256,
    provenance: generated.provenance,
};
const registryBytes = Buffer.from(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
const pairTextBytes = Buffer.from(markedPairText, "utf8");

const docsDir = join(root, "docs", "pairlist-pools");
const archiveDir = join(root, "archive", "batch-open-score", "pools");
mkdirSync(docsDir, { recursive: true });
mkdirSync(archiveDir, { recursive: true });
for (const dir of [docsDir, archiveDir]) {
    writeFileSync(join(dir, "BAL679.v1.json"), registryBytes);
    writeFileSync(join(dir, "BAL679.v1.txt"), pairTextBytes);
}

console.log(`Wrote BAL679.v1 (${assets.length} assets, ${generated.pairs.length} pairs, ${pairListSha256})`);
