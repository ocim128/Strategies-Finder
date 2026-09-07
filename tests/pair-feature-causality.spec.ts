import { expect } from "chai";
import { describe, it, after } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFloat64Le } from "../lib/pair-features/artifact-io";
import { generatePairFeaturePack } from "../lib/pair-features/generate";
import type { PairFeatureFamilyManifest, PairFeaturePackManifest } from "../lib/pair-features/types";
import { createPairFeatureFixture, type PairFeatureFixtureOptions } from "./fixtures/pair-features/fixture";

const roots: string[] = [];

function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "pair-feature-causality-"));
    roots.push(root);
    return root;
}

async function spreadValues(root: string): Promise<number[]> {
    const result = await generatePairFeaturePack(root, "v0", ["feat_fp_spread_log_return_b12_r1"]);
    const pack = JSON.parse(readFileSync(join(root, ...result.packPath.split("/")), "utf8")) as PairFeaturePackManifest;
    const familyRef = pack.familyManifests.find((candidate) => candidate.path.includes("/families/spread/"))!;
    const family = JSON.parse((await readFile(join(root, ...familyRef.path.split("/")))).toString("utf8")) as PairFeatureFamilyManifest;
    const path = family.features[0]!.pairs[0]!.values.path;
    return decodeFloat64Le(await readFile(join(root, ...path.split("/"))));
}

async function tradeValues(root: string): Promise<number[]> {
    const result = await generatePairFeaturePack(root, "v0", ["feat_fp_trade_mean_net_pct_t8_r1"]);
    const pack = JSON.parse(readFileSync(join(root, ...result.packPath.split("/")), "utf8")) as PairFeaturePackManifest;
    const familyRef = pack.familyManifests.find((candidate) => candidate.path.includes("/families/trades/"))!;
    const family = JSON.parse((await readFile(join(root, ...familyRef.path.split("/")))).toString("utf8")) as PairFeatureFamilyManifest;
    const path = family.features[0]!.pairs[0]!.values.path;
    return decodeFloat64Le(await readFile(join(root, ...path.split("/"))));
}

async function generatedSpread(options?: PairFeatureFixtureOptions): Promise<number[]> {
    const root = makeRoot();
    await createPairFeatureFixture(root, options);
    return spreadValues(root);
}

async function generatedTrades(options?: PairFeatureFixtureOptions): Promise<number[]> {
    const root = makeRoot();
    await createPairFeatureFixture(root, options);
    return tradeValues(root);
}

describe("pair feature causality", () => {
    after(() => {
        for (const root of roots) rmSync(root, { recursive: true, force: true });
    });

    it("does not read the signal bar or later bars for earlier spread values", async () => {
        const baseline = await generatedSpread();
        const futureMutation = await generatedSpread({
            mutateBar: (bars) => {
                for (let index = 13; index < bars.length; index += 1) (bars[index] as unknown as number[])[4] += 1000;
            },
        });
        expect(futureMutation.slice(0, 2)).to.deep.equal(baseline.slice(0, 2));
        expect(futureMutation[2]).to.not.equal(baseline[2]);
    });

    it("changes when a contributing prior spread close changes", async () => {
        const baseline = await generatedSpread();
        const pastMutation = await generatedSpread({ mutateBar: (bars) => { (bars[12] as unknown as number[])[4] *= 2; } });
        expect(pastMutation[1]).to.not.equal(baseline[1]);
    });

    it("excludes same-bar/future trade records and changes on an eligible prior record", async () => {
        const baseline = await generatedTrades();
        const sameBarMutation = await generatedTrades({
            mutateTrade: (trades) => { trades[8]!.pnlPercent = 10000; },
        });
        expect(sameBarMutation).to.deep.equal(baseline);
        const priorMutation = await generatedTrades({
            mutateTrade: (trades) => { trades[0]!.pnlPercent = 100; },
        });
        expect(priorMutation[2]).to.not.equal(baseline[2]);
        expect(priorMutation.slice(0, 2)).to.deep.equal(baseline.slice(0, 2));
    });
});
