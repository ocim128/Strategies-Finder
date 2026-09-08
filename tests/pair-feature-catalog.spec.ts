import { expect } from "chai";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { hashBytes, hashFile, canonicalJson } from "../lib/pair-features/artifact-io";
import { V1_FEATURE_CATALOG, V1_RELEASE } from "../lib/pair-features/catalog";
import { pairSelectionRuleRegistry } from "../lib/pair-selection/registry";

const grandfathered = new Map([
    ["pair_losing_streak_rebound", "feat_pairLosingStreakPrior"],
    ["pair_drawdown_recovery_target", "feat_pairDrawdownPctPrior"],
    ["historical_adverse_excursion_target", "feat_pairMedianMaePctPrior"],
    ["spread_return_autocorrelation_target", "feat_spreadReturnAutocorr20"],
    ["spread_variance_ratio_target", "feat_spreadVarianceRatio5"],
    ["spread_mean_reversion_halflife", "feat_spreadHalfLifeBars20"],
    ["volatility_expansion_ratio_target", "feat_atrRatio5Over20"],
    ["spread_volatility_trend_ratio", "feat_pairSpreadVolatilityRatio5Over20"],
    ["signal_burst_density_target", "feat_pairFiresInLast20Bars"],
    ["inter_fire_cadence_regularity", "feat_pairInterFireIntervalCvPrior"],
]);

describe("pair feature catalog v1", () => {
    it("publishes a sorted, fully pinned four-family tranche", async () => {
        expect(V1_RELEASE.releaseId).to.equal("v1");
        expect(V1_RELEASE.definitions.length).to.equal(V1_FEATURE_CATALOG.length);
        expect(V1_RELEASE.definitions.length).to.be.within(40, 80);
        for (let index = 1; index < V1_RELEASE.definitions.length; index += 1) {
            expect(V1_RELEASE.definitions[index - 1]!.id < V1_RELEASE.definitions[index]!.id).to.equal(true);
        }
        for (const definition of V1_RELEASE.definitions) {
            expect(definition.id).to.be.a("string").and.not.empty;
            expect(definition.family).to.be.oneOf(["spread", "dependence", "volatility", "trades", "fires"]);
            expect(definition.revision).to.equal(1);
            expect(definition.units).to.be.a("string").and.not.empty;
            expect(definition.directionConvention).to.be.a("string").and.not.empty;
            expect(definition.cutoff).to.be.a("string").and.not.empty;
            expect(definition.formula).to.be.a("string").and.not.empty;
            expect(definition.minimumObservations).to.be.a("number").and.at.least(0);
            expect(definition.missingPolicy).to.be.a("string").and.not.empty;
            expect(definition.expectedValueFixtures?.length ?? 0).to.be.greaterThan(0);
            expect(definition.implementationFiles.length).to.be.greaterThan(0);
            for (const implementation of definition.implementationFiles) {
                const file = await hashFile(implementation.path);
                expect(file.sha256).to.equal(implementation.sha256);
            }
            const withoutDigest = Object.fromEntries(Object.entries(definition).filter(([key]) => key !== "definitionDigest"));
            expect(hashBytes(Buffer.from(canonicalJson(withoutDigest), "utf8"))).to.equal(definition.definitionDigest);
            expect(V1_FEATURE_CATALOG.some((entry) => entry.definition.id === definition.id)).to.equal(true);
        }
    });

    it("pins the ten grandfathered names to the exact registered rule reads", () => {
        expect(grandfathered.size).to.equal(10);
        for (const [ruleKey, featureId] of grandfathered) {
            const rule = pairSelectionRuleRegistry.get(ruleKey);
            expect(rule?.metadata?.featureRequirements).to.deep.equal({ libraryRelease: "v1", columns: [featureId] });
            expect(V1_RELEASE.definitions.some((definition) => definition.id === featureId)).to.equal(true);
        }
    });

    it("keeps grandfathered names explicitly separate from the future feat_fp convention", async () => {
        const ids = V1_RELEASE.definitions.map((definition) => definition.id);
        for (const featureId of grandfathered.values()) expect(featureId.startsWith("feat_fp_")).to.equal(false);
        expect(ids.filter((id) => id.startsWith("feat_fp_")).length).to.be.greaterThan(40);
        expect((await readFile("lib/pair-features/releases/v1.json", "utf8"))).to.contain("grandfathered");
    });
});
