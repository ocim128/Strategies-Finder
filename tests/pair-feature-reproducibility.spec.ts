import { expect } from "chai";
import { describe, it, after } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePairFeaturePack } from "../lib/pair-features/generate";
import type { PairFeatureFamilyManifest, PairFeaturePackManifest } from "../lib/pair-features/types";
import { createPairFeatureFixture } from "./fixtures/pair-features/fixture";

const roots: string[] = [];
const FEATURE_IDS = ["feat_fp_spread_log_return_b12_r1", "feat_fp_trade_mean_net_pct_t8_r1"] as const;

function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "pair-feature-reproducibility-"));
    roots.push(root);
    return root;
}

async function referencedPaths(root: string, result: Awaited<ReturnType<typeof generatePairFeaturePack>>): Promise<string[]> {
    const packPath = join(root, ...result.packPath.split("/"));
    const pack = JSON.parse((await readFile(packPath)).toString("utf8")) as PairFeaturePackManifest;
    const paths = [result.releasePath, result.packPath, ...pack.familyManifests.map((family) => family.path)];
    for (const familyRef of pack.familyManifests) {
        const family = JSON.parse((await readFile(join(root, ...familyRef.path.split("/")))).toString("utf8")) as PairFeatureFamilyManifest;
        for (const feature of family.features) for (const pair of feature.pairs) paths.push(pair.values.path, pair.valid.path, pair.observations.path);
    }
    return paths.sort();
}

async function readPaths(root: string, paths: readonly string[]): Promise<Buffer[]> {
    return Promise.all(paths.map((path) => readFile(join(root, ...path.split("/")))));
}

async function expectRejected(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
    try {
        await promise;
    } catch (error) {
        expect(error instanceof Error ? error.message : String(error)).to.match(pattern);
        return;
    }
    expect.fail("Expected the promise to reject.");
}

describe("pair feature reproducibility", () => {
    after(() => {
        for (const root of roots) rmSync(root, { recursive: true, force: true });
    });

    it("reuses every column and gives request-order permutations the same manifest", async () => {
        const root = makeRoot();
        await createPairFeatureFixture(root);
        const first = await generatePairFeaturePack(root, "v0", FEATURE_IDS);
        const firstPaths = await referencedPaths(root, first);
        const firstBytes = await readPaths(root, firstPaths);
        const second = await generatePairFeaturePack(root, "v0", [...FEATURE_IDS].reverse());
        const secondPaths = await referencedPaths(root, second);
        const secondBytes = await readPaths(root, secondPaths);
        expect(second.packDigest).to.equal(first.packDigest);
        expect(second.computedColumns).to.equal(0);
        expect(second.reusedColumns).to.equal(6);
        expect(secondPaths).to.deep.equal(firstPaths);
        secondBytes.forEach((bytes, index) => expect(bytes.equals(firstBytes[index]!)).to.equal(true));
    });

    it("concurrent duplicate generation converges on one deterministic pack", async () => {
        const root = makeRoot();
        await createPairFeatureFixture(root);
        const results = await Promise.all([
            generatePairFeaturePack(root, "v0", FEATURE_IDS),
            generatePairFeaturePack(root, "v0", FEATURE_IDS),
        ]);
        expect(results[0]!.packDigest).to.equal(results[1]!.packDigest);
        expect(results[0]!.familyManifests).to.deep.equal(results[1]!.familyManifests);
    });

    it("rejects a corrupt published column instead of trusting its filename", async () => {
        const root = makeRoot();
        await createPairFeatureFixture(root);
        const result = await generatePairFeaturePack(root, "v0", [FEATURE_IDS[0]]);
        const pack = JSON.parse(readFileSync(join(root, ...result.packPath.split("/")), "utf8")) as PairFeaturePackManifest;
        const family = JSON.parse((await readFile(join(root, ...pack.familyManifests[0]!.path.split("/")))).toString("utf8")) as PairFeatureFamilyManifest;
        const valuesPath = family.features[0]!.pairs[0]!.values.path;
        const absoluteValuesPath = join(root, ...valuesPath.split("/"));
        const before = await readFile(absoluteValuesPath);
        await writeFile(absoluteValuesPath, Buffer.from("corrupt", "utf8"));
        await expectRejected(generatePairFeaturePack(root, "v0", [FEATURE_IDS[0]]), /Existing values column hash mismatch/);
        expect((await readFile(absoluteValuesPath)).equals(Buffer.from("corrupt", "utf8"))).to.equal(true);
        expect(before.equals(Buffer.from("corrupt", "utf8"))).to.equal(false);
    });
});
