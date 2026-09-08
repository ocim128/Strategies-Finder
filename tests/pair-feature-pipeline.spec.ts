import { expect } from "chai";
import { after, describe, it } from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashFile } from "../lib/pair-features/artifact-io";
import { computePairFeaturePackScales } from "../lib/pair-selection/scales";
import { ensurePairFeatures } from "../lib/pair-selection/feature-access";
import { createPairFeatureFixture } from "./fixtures/pair-features/fixture";
import { makeFeatureRule } from "./fixtures/pair-features/rules";

const roots: string[] = [];

async function columnHashes(folder: string): Promise<Record<string, string>> {
    const definitionDirs = await readdir(path.join(folder, "feature-packs", "columns"));
    const result: Record<string, string> = {};
    for (const definition of definitionDirs.sort()) {
        const pairDirs = await readdir(path.join(folder, "feature-packs", "columns", definition));
        for (const pair of pairDirs.sort()) {
            for (const file of ["values.f64le.gz", "valid.u8.gz", "observations.u32le.gz"]) {
                const relative = `feature-packs/columns/${definition}/${pair}/${file}`;
                result[relative] = (await hashFile(path.join(folder, ...relative.split("/")))).sha256;
            }
        }
    }
    return result;
}

after(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("automatic pair feature preparation", () => {
    it("uses one captured folder for overlapping requirement sets and derives pack scales", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "pair-feature-pipeline-"));
        roots.push(root);
        await createPairFeatureFixture(root);
        const ledgerBefore = (await hashFile(path.join(root, "ledger.jsonl"))).sha256;
        const first = makeFeatureRule("pipeline_first", ["feat_fp_spread_zscore_b12_r1", "feat_fp_trade_median_net_pct_t8_r1"]);
        const progress: string[] = [];
        await ensurePairFeatures(root, [first], undefined, (event) => progress.push(event.familyId));
        expect(progress).to.deep.equal(["spread", "trades"]);
        const firstHashes = await columnHashes(root);

        const requirementSets = [
            ["feat_fp_spread_zscore_b12_r1"],
            ["feat_fp_dependence_return_acf_b48_l1_r1"],
            ["feat_fp_volatility_return_std_b12_r1", "feat_fp_volatility_return_std_b48_r1"],
            ["feat_fp_trade_win_fraction_t8_r1", "feat_fp_trade_median_net_pct_t8_r1"],
            ["feat_fp_spread_zscore_b12_r1", "feat_fp_dependence_variance_ratio_b48_h4_r1"],
        ] as const;
        for (const [index, columns] of requirementSets.entries()) await ensurePairFeatures(root, [makeFeatureRule(`pipeline_${index}`, columns)]);
        expect((await hashFile(path.join(root, "ledger.jsonl"))).sha256).to.equal(ledgerBefore);
        const afterHashes = await columnHashes(root);
        for (const [file, digest] of Object.entries(firstHashes)) expect(afterHashes[file]).to.equal(digest);
        const packScales = await computePairFeaturePackScales(root);
        expect(packScales.feat_fp_spread_zscore_b12_r1).to.not.equal(undefined);
        expect(packScales.feat_fp_trade_median_net_pct_t8_r1).to.not.equal(undefined);
        expect(packScales.feat_fp_spread_zscore_b12_r1!.nullShare).to.equal(0);
    });

    it("cancels after a family without publishing a new success pack and keeps prior packs readable", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "pair-feature-pipeline-cancel-"));
        roots.push(root);
        await createPairFeatureFixture(root);
        const priorRule = makeFeatureRule("pipeline_prior", ["feat_fp_spread_zscore_b12_r1"]);
        await ensurePairFeatures(root, [priorRule]);
        const packsBefore = await readdir(path.join(root, "feature-packs", "manifests"));
        const controller = new AbortController();
        let message = "";
        try {
            await ensurePairFeatures(root, [makeFeatureRule("pipeline_cancel", ["feat_fp_spread_zscore_b48_r1", "feat_fp_trade_win_fraction_t8_r1"])], controller.signal, () => controller.abort());
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        expect(message).to.match(/cancelled/);
        expect(await readdir(path.join(root, "feature-packs", "manifests"))).to.deep.equal(packsBefore);
        const prepared = await ensurePairFeatures(root, [priorRule]);
        expect(prepared.columns.size).to.equal(1);
    });

    it("converges concurrent duplicate preparation on deterministic artifacts", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "pair-feature-pipeline-concurrent-"));
        roots.push(root);
        await createPairFeatureFixture(root);
        const requested = makeFeatureRule("pipeline_concurrent", ["feat_fp_dependence_return_acf_b48_l1_r1", "feat_fp_volatility_return_std_b12_r1"]);
        const prepared = await Promise.all([ensurePairFeatures(root, [requested]), ensurePairFeatures(root, [requested])]);
        expect(prepared[0]!.columns.size).to.equal(2);
        expect(prepared[1]!.columns.size).to.equal(2);
        expect(await readdir(path.join(root, "feature-packs", "manifests"))).to.have.length(1);
    });
});
