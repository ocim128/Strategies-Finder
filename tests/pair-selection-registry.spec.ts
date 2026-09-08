import { expect } from "chai";
import { describe, it } from "node:test";
import { pairSelectionRuleRegistry } from "../lib/pair-selection/registry";
import { pickPairSelectionRule, type PairSelectionEvent } from "../lib/pair-selection/tally";
import type { PairCandidate, PairSelectionRule } from "../lib/pair-selection/types";
import { spreadRule } from "./fixtures/pair-features/rules";

const baseCandidate = {
    pair: "",
    baseSymbol: "",
    quoteSymbol: "",
    direction: "long" as const,
    signalTime: 1_700_000_000,
    signalBarIndex: 100,
    feat_entryRangePosition: 80,
    feat_atrPct: 1,
    feat_return20: 0.1,
    feat_gapPct: 0.02,
    feat_dow: 1,
    feat_hour: 12,
    feat_pairWinRatePrior: 0.5,
    feat_pairTradesPrior: 5,
    feat_barsSincePairLastFire: 2,
    feat_pairSpreadVolatility20: 1,
    feat_legVolatilityRatio20: 0.9,
    feat_candidatesAtTime: 2,
};

/**
 * A "valid pool" carries every field any registered rule reads, including the
 * v4-bound features that batch-1 rules access through local type extensions.
 * A rule abstaining (-Infinity) on the whole pool is a fixture gap, not a
 * registry contract failure.
 */
const pool: PairCandidate[] = [
    {
        ...baseCandidate,
        pair: "AAA+BBB",
        baseSymbol: "AAA",
        quoteSymbol: "BBB",
        direction: "long",
        feat_pairLosingStreakPrior: 1,
        feat_pairDrawdownPctPrior: 4,
        feat_pairMedianMaePctPrior: 1.2,
        feat_spreadReturnAutocorr20: -0.2,
        feat_spreadVarianceRatio5: 0.8,
        feat_spreadHalfLifeBars20: 6,
        feat_atrRatio5Over20: 1.2,
        feat_pairSpreadVolatilityRatio5Over20: 0.9,
        feat_pairFiresInLast20Bars: 3,
        feat_pairInterFireIntervalCvPrior: 0.4,
    },
    {
        ...baseCandidate,
        pair: "CCC+DDD",
        baseSymbol: "CCC",
        quoteSymbol: "DDD",
        direction: "short",
        feat_entryRangePosition: 25,
        feat_atrPct: 2,
        feat_return20: -0.2,
        feat_gapPct: -0.01,
        feat_pairWinRatePrior: 0.8,
        feat_pairTradesPrior: 10,
        feat_barsSincePairLastFire: 4,
        feat_pairSpreadVolatility20: 2,
        feat_legVolatilityRatio20: 1.1,
        feat_candidatesAtTime: 2,
        feat_pairLosingStreakPrior: 3,
        feat_pairDrawdownPctPrior: 12,
        feat_pairMedianMaePctPrior: 2.4,
        feat_spreadReturnAutocorr20: 0.15,
        feat_spreadVarianceRatio5: 1.3,
        feat_spreadHalfLifeBars20: 11,
        feat_atrRatio5Over20: 0.7,
        feat_pairSpreadVolatilityRatio5Over20: 1.4,
        feat_pairFiresInLast20Bars: 6,
        feat_pairInterFireIntervalCvPrior: 0.9,
    },
] as unknown as PairCandidate[];

const event: PairSelectionEvent = {
    context: { signalTime: 1_700_000_000, interval: "4h", strategyKey: "fixture" },
    candidates: pool,
};

const featureMetadataFixture: PairSelectionRule = {
    ...spreadRule,
    key: "fixture_feature_metadata",
    name: "FIXTURE_FEATURE_METADATA",
    description: "A test-only rule carrying a catalog requirement.",
    metadata: {
        ...spreadRule.metadata,
        featureRequirements: { libraryRelease: "v1", columns: ["feat_fp_spread_zscore_b12_r1"] },
    },
};

describe("pair-selection registry contract", () => {
    it("keeps rule keys unique and parameter metadata aligned", () => {
        const rules = [...pairSelectionRuleRegistry.values()];
        expect(new Set(rules.map((rule) => rule.key)).size).to.equal(rules.length);
        expect(rules.length).to.be.greaterThan(0);

        for (const rule of rules) {
            expect(rule.key).to.match(/^[a-z0-9_]+$/);
            expect(rule.name).to.be.a("string").and.not.empty;
            expect(rule.description).to.be.a("string").and.not.empty;
            expect(Object.keys(rule.defaultParams).sort()).to.deep.equal(Object.keys(rule.paramLabels).sort());
            for (const [key, bounds] of Object.entries(rule.metadata?.paramBounds ?? {})) {
                expect(rule.defaultParams).to.have.property(key);
                expect(bounds.min).to.be.finite;
                expect(bounds.max).to.be.finite;
                expect(bounds.max).to.be.at.least(bounds.min);
                if (bounds.step !== undefined) expect(bounds.step).to.be.greaterThan(0);
            }

            const normalized = rule.normalizeParams?.(rule.defaultParams) ?? rule.defaultParams;
            expect(Object.keys(normalized).sort()).to.deep.equal(Object.keys(rule.defaultParams).sort());
        }
    });

    it("produces deterministic selections without malformed scores on a valid pool", () => {
        for (const rule of pairSelectionRuleRegistry.values()) {
            // Rules declaring catalog featureRequirements read pack columns the
            // embedded fixture does not carry; their correctness is exercised
            // against generated packs in tests/pair-feature-access.spec.ts and
            // tests/pair-feature-pipeline.spec.ts.
            if (rule.metadata?.featureRequirements) continue;
            for (const candidate of pool) {
                const score = rule.score(candidate, event.context, rule.defaultParams, pool);
                expect(score === Number.NEGATIVE_INFINITY || Number.isFinite(score), `${rule.key} score`).to.equal(true);
            }
            expect(pickPairSelectionRule(event, rule, rule.defaultParams))
                .to.deep.equal(pickPairSelectionRule(event, rule, rule.defaultParams));
        }
    });

    it("keeps feature requirements on test rules explicit", () => {
        expect(featureMetadataFixture.metadata?.featureRequirements).to.deep.equal({
            libraryRelease: "v1",
            columns: ["feat_fp_spread_zscore_b12_r1"],
        });
    });
});
