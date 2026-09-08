import { expect } from "chai";
import { it } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJson } from "../lib/pair-features/artifact-io";
import { V0_RELEASE, V1_RELEASE, V2_RELEASE, getPairFeatureCatalogEntryForRelease } from "../lib/pair-features/catalog";
import { generatePairFeaturePack, validatePairFeatureLibraryRelease } from "../lib/pair-features/generate";
import { activatePairFeatures, ensurePairFeatures, releasePairFeatures } from "../lib/pair-selection/feature-access";
import { pairSelectionRuleRegistry } from "../lib/pair-selection/registry";
import type { PairCandidate } from "../lib/pair-selection/types";
import { createPairFeatureFixture } from "./fixtures/pair-features/fixture";

it("scores drift efficiency from the corrected OLS column, including zero drift", () => {
    const rule = pairSelectionRuleRegistry.get("directional_drift_efficiency_product")!;
    const event = { signalTime: 1000, interval: "4h", strategyKey: "fixture" };
    for (const direction of ["long", "short"] as const) {
        for (const slope of [null, 0, 2]) {
            const candidate = {
                direction,
                feat_fp_spread_ols_slope_b48_r2: slope,
                feat_fp_spread_efficiency_ratio_b48_r1: 0.5,
            } as unknown as PairCandidate;
            const expected = slope === null ? -Infinity : slope * 0.5 * (direction === "long" ? 1 : -1);
            expect(rule.score(candidate, event, {}, [candidate])).to.equal(expected);
        }
    }
});

it("prepares every active feature-backed rule beside a different immutable archived v1 release", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pair-feature-release-upgrade-"));
    try {
        await createPairFeatureFixture(root);
        const releases = path.join(root, "feature-packs", "releases");
        await mkdir(releases, { recursive: true });
        // Model a folder whose v1 inventory predates the current corrections.
        const archivedV1 = canonicalJson({ ...V0_RELEASE, releaseId: "v1" });
        const v1Path = path.join(releases, "v1.json");
        await writeFile(v1Path, archivedV1);
        const ledgerBefore = await readFile(path.join(root, "ledger.jsonl"));
        let conflict = "";
        try {
            await generatePairFeaturePack(root, "v1", ["feat_fp_spread_up_increment_streak_r1"]);
        } catch (error) {
            conflict = error instanceof Error ? error.message : String(error);
        }
        expect(conflict).to.contain("Published artifact differs from the requested bytes");

        const rules = [...pairSelectionRuleRegistry.values()].filter((rule) => rule.metadata?.featureRequirements);
        expect(rules.length).to.be.greaterThan(3);
        for (const rule of rules) expect(rule.metadata!.featureRequirements!.libraryRelease).to.equal("v2");
        const parentIds = new Set(rules.flatMap((rule) => rule.metadata!.featureRequirements!.columns)
            .map((id) => id.endsWith("_n") ? id.slice(0, -2) : id));
        // Moving active requirements must preserve definitions and evaluators,
        // not silently change the numbers used by their unchanged scoring code.
        for (const id of parentIds) {
            const previous = getPairFeatureCatalogEntryForRelease("v1", id);
            const current = getPairFeatureCatalogEntryForRelease("v2", id);
            expect(previous, id).not.to.equal(null);
            expect(current?.definition, id).to.deep.equal(previous!.definition);
            expect(current?.evaluate, id).to.equal(previous!.evaluate);
        }
        expect(V1_RELEASE.releaseId).to.equal("v1");
        await validatePairFeatureLibraryRelease("v2");
        const prepared = await ensurePairFeatures(root, rules);
        try {
            expect(prepared.columns.size).to.equal(parentIds.size);
            for (const rule of rules) {
                const active = await activatePairFeatures(prepared, rule);
                expect(active!.ruleKey).to.equal(rule.key);
                expect(Object.keys(active!.readCandidateFeatures(0)).sort()).to.deep.equal(
                    [...rule.metadata!.featureRequirements!.columns].sort(),
                );
            }
        } finally {
            releasePairFeatures(prepared);
        }
        expect(await readFile(v1Path, "utf8")).to.equal(archivedV1);
        expect(await readFile(path.join(root, "ledger.jsonl"))).to.deep.equal(ledgerBefore);
        expect(await readFile(path.join(releases, "v2.json"), "utf8")).to.equal(canonicalJson(V2_RELEASE));
        const again = await ensurePairFeatures(root, rules);
        expect(again.columns.size).to.equal(parentIds.size);
        releasePairFeatures(again);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
