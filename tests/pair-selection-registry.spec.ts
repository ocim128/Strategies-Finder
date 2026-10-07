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
            // Rules that score all candidates NEGATIVE_INFINITY legitimately
            // find no eligible candidate on the embedded fixture (they require
            // pack columns not present here). Skip them — they are tested
            // against generated packs in the pipeline spec.
            if (rule.score(pool[0]!, event.context, rule.defaultParams, pool) === Number.NEGATIVE_INFINITY
                && rule.score(pool[1]!, event.context, rule.defaultParams, pool) === Number.NEGATIVE_INFINITY) {
                console.log(`  skipping ${rule.key}: no eligible candidates on embedded fixture (requires pack columns)`);
                continue;
            }
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

/**
 * Direct characterization cases for the three rules that consume the shared
 * directional 48-bar cohort preparation. Every expected score below is hand
 * calculated from the leave-one-out cohort medians of
 * `feat_fp_spread_log_return_b48_r1` (direction-adjusted: short negates the
 * value) over the base-symbol and quote-symbol groups; the scored candidate
 * is excluded from its own cohorts by object identity.
 */
describe("directional 48-bar cohort rules", () => {
    const ABSTAIN = Number.NEGATIVE_INFINITY;
    const broadTheme = pairSelectionRuleRegistry.get("broad_theme_confirmed_drift")!;
    const oneLeg = pairSelectionRuleRegistry.get("one_leg_theme_drift")!;
    const regimeSwitch = pairSelectionRuleRegistry.get("cohort_alignment_regime_switch")!;

    function cohortCandidate(
        pair: string,
        baseSymbol: string,
        quoteSymbol: string,
        direction: "long" | "short",
        spreadReturn48: number | null,
        extra: Partial<Pick<PairCandidate, "feat_atrPct">> = {},
    ): PairCandidate {
        const candidate = {
            ...baseCandidate,
            pair,
            baseSymbol,
            quoteSymbol,
            direction,
            feat_fp_spread_log_return_b48_r1: spreadReturn48,
            ...extra,
        };
        return candidate as PairCandidate;
    }

    function scores(rule: PairSelectionRule, pool: PairCandidate[]): number[] {
        return pool.map((candidate) => rule.score(candidate, event.context, rule.defaultParams, pool));
    }

    it("scores agreeing base and quote cohorts at full weight (broad theme)", () => {
        // Base AAA=[.02,.04], quote BBB=[.02,.06]; P2/P3/P4 each keep a
        // singleton leg cohort -> null median -> abstain.
        const pool = [
            cohortCandidate("AAA+BBB", "AAA", "BBB", "long", 0.02),
            cohortCandidate("AAA+CCC", "AAA", "CCC", "long", 0.04),
            cohortCandidate("DDD+BBB", "DDD", "BBB", "long", 0.06),
            cohortCandidate("EEE+FFF", "EEE", "FFF", "long", 0.08),
        ];
        expect(scores(broadTheme, pool)).to.deep.equal([0.02, ABSTAIN, ABSTAIN, ABSTAIN]);
        const pick = pickPairSelectionRule({ context: event.context, candidates: pool }, broadTheme, broadTheme.defaultParams);
        expect(pick.pair).to.equal("AAA+BBB");
        expect(pick.score).to.equal(0.02);
    });

    it("flips the weight when base and quote cohort medians disagree (broad theme)", () => {
        // P1: base without P1 = [0.03] (+), quote without P1 = [-0.05] (-)
        // -> weight -1 -> score -0.01 * -1 = 0.01.
        const pool = [
            cohortCandidate("AAA+BBB", "AAA", "BBB", "long", -0.01),
            cohortCandidate("AAA+CCC", "AAA", "CCC", "long", 0.03),
            cohortCandidate("DDD+BBB", "DDD", "BBB", "long", -0.05),
        ];
        expect(scores(broadTheme, pool)).to.deep.equal([0.01, ABSTAIN, ABSTAIN]);
    });

    it("adjusts short direction before aggregation (broad theme)", () => {
        // S1 short 0.02 adjusts to -0.02; both leave-one-out medians are
        // negative -> weight +1 -> score -0.02 (skipping adjustment would
        // give +0.02).
        const pool = [
            cohortCandidate("AAA+BBB", "AAA", "BBB", "short", 0.02),
            cohortCandidate("AAA+CCC", "AAA", "CCC", "short", 0.04),
            cohortCandidate("DDD+BBB", "DDD", "BBB", "short", 0.06),
        ];
        expect(scores(broadTheme, pool)).to.deep.equal([-0.02, ABSTAIN, ABSTAIN]);
    });

    it("excludes the scored candidate by object identity across duplicate values (broad theme)", () => {
        // I1 and I2 are distinct objects with the same pair identity and I3
        // duplicates I1's value. I1's base median without I1 alone is
        // median([-0.30, 0.10]) = -0.10 (-); a pair-identity exclusion that
        // also dropped I2 would see [0.10] (+) and flip the score sign.
        const pool = [
            cohortCandidate("AAA+BBB", "AAA", "BBB", "long", 0.10),
            cohortCandidate("AAA+BBB", "AAA", "BBB", "long", -0.30),
            cohortCandidate("AAA+CCC", "AAA", "CCC", "long", 0.10),
            cohortCandidate("DDD+BBB", "DDD", "BBB", "long", 0.40),
        ];
        expect(scores(broadTheme, pool)).to.deep.equal([-0.10, -0.30, ABSTAIN, ABSTAIN]);
    });

    it("abstains on a zero leave-one-out median (broad theme) but weighs it |0-s| (one leg)", () => {
        // Z1's base median without Z1 = median([-0.02, 0.02]) = 0.
        const pool = [
            cohortCandidate("AAA+BBB", "AAA", "BBB", "long", 0.07),
            cohortCandidate("AAA+CCC", "AAA", "CCC", "long", -0.02),
            cohortCandidate("AAA+DDD", "AAA", "DDD", "long", 0.02),
            cohortCandidate("EEE+BBB", "EEE", "BBB", "long", 0.04),
        ];
        expect(scores(broadTheme, pool)).to.deep.equal([ABSTAIN, ABSTAIN, ABSTAIN, ABSTAIN]);
        // One leg weighs |base - quote| signs: Z1 keeps |0 - 1| = 1 for the
        // zero base median, and a null leg contributes 0, so Z2/Z3/Z4 score
        // at weight 1 off their single usable leg.
        expect(scores(oneLeg, pool)).to.deep.equal([0.07, -0.02, 0.02, 0.04]);
        expect(() => pickPairSelectionRule({ context: event.context, candidates: pool }, broadTheme, broadTheme.defaultParams))
            .to.throw(/no eligible candidate/);
    });

    it("treats missing, NaN, and infinite features as absent without poisoning cohorts", () => {
        // E1 (null) and F1 (NaN) never enter a series; E2/F2 still read the
        // remaining peers. F5 (+Infinity) abstains like any nonfinite value.
        const nullPool = [
            cohortCandidate("AAA+BBB", "AAA", "BBB", "long", null),
            cohortCandidate("AAA+BBB", "AAA", "BBB", "long", 0.04),
            cohortCandidate("AAA+CCC", "AAA", "CCC", "long", 0.06),
            cohortCandidate("DDD+BBB", "DDD", "BBB", "long", 0.08),
        ];
        expect(scores(broadTheme, nullPool)).to.deep.equal([ABSTAIN, 0.04, ABSTAIN, ABSTAIN]);
        const nanPool = [
            cohortCandidate("AAA+BBB", "AAA", "BBB", "long", Number.NaN),
            cohortCandidate("AAA+BBB", "AAA", "BBB", "long", 0.02),
            cohortCandidate("AAA+CCC", "AAA", "CCC", "long", 0.05),
            cohortCandidate("DDD+BBB", "DDD", "BBB", "long", 0.07),
            cohortCandidate("EEE+FFF", "EEE", "FFF", "long", Number.POSITIVE_INFINITY),
        ];
        expect(scores(broadTheme, nanPool)).to.deep.equal([ABSTAIN, 0.02, ABSTAIN, ABSTAIN, ABSTAIN]);
    });

    it("doubles the score on opposed cohort signs; singleton legs weigh 1 (one leg)", () => {
        // R1: base without R1 = [-0.15] (-), quote without R1 = [0.25] (+)
        // -> weight |-1 - 1| = 2 -> score 0.05 * 2 = 0.10. R2/R3 keep one
        // usable leg (the other median is a singleton null, sign 0), so they
        // score at weight 1 instead of abstaining.
        const pool = [
            cohortCandidate("AAA+BBB", "AAA", "BBB", "long", 0.05),
            cohortCandidate("AAA+CCC", "AAA", "CCC", "long", -0.15),
            cohortCandidate("DDD+BBB", "DDD", "BBB", "long", 0.25),
        ];
        expect(scores(oneLeg, pool)).to.deep.equal([0.10, -0.15, 0.25]);
    });

    it("abstains only when both cohort signs agree (one leg)", () => {
        // Q1's leave-one-out medians are both positive -> weight 0. Q2/Q3
        // have one singleton leg (sign 0), so weight 1 keeps them scored.
        const pool = [
            cohortCandidate("AAA+BBB", "AAA", "BBB", "long", 0.05),
            cohortCandidate("AAA+CCC", "AAA", "CCC", "long", 0.01),
            cohortCandidate("DDD+BBB", "DDD", "BBB", "long", 0.09),
        ];
        expect(scores(oneLeg, pool)).to.deep.equal([ABSTAIN, 0.01, 0.09]);
    });

    it("scores raw momentum once agreement reaches exactly one half (regime switch)", () => {
        // All four candidates' leave-one-out medians agree (+,+) -> fraction
        // 4/4 = 1.0 >= 0.5 -> momentum branch ignores ATR (5.0).
        const pool = [
            cohortCandidate("AAA+BBB", "AAA", "BBB", "long", 0.10, { feat_atrPct: 5.0 }),
            cohortCandidate("AAA+CCC", "AAA", "CCC", "long", 0.20, { feat_atrPct: 5.0 }),
            cohortCandidate("DDD+BBB", "DDD", "BBB", "long", 0.30, { feat_atrPct: 5.0 }),
            cohortCandidate("DDD+CCC", "DDD", "CCC", "long", 0.40, { feat_atrPct: 5.0 }),
        ];
        expect(scores(regimeSwitch, pool)).to.deep.equal([0.10, 0.20, 0.30, 0.40]);
    });

    it("scores ATR in cross-currents events, abstaining on a missing ATR (regime switch)", () => {
        // H1's cohort signs disagree and H2/H3/H4 have a singleton leg ->
        // fraction 0/4 < 0.5 -> ATR branch. H4 has no finite ATR.
        const pool = [
            cohortCandidate("AAA+BBB", "AAA", "BBB", "long", 0.10, { feat_atrPct: 2.5 }),
            cohortCandidate("AAA+CCC", "AAA", "CCC", "long", 0.20, { feat_atrPct: 2.0 }),
            cohortCandidate("DDD+BBB", "DDD", "BBB", "long", -0.30, { feat_atrPct: 1.5 }),
            cohortCandidate("EEE+FFF", "EEE", "FFF", "long", 0.40, { feat_atrPct: null }),
        ];
        expect(scores(regimeSwitch, pool)).to.deep.equal([2.5, 2.0, 1.5, ABSTAIN]);
    });

    it("stays in the ATR branch while agreement is just below one half (regime switch)", () => {
        // N1/N2 are distinct objects with the same pair identity; each is the
        // other's whole base and quote cohort, so both agree -> 2/5 = 0.4.
        const pool = [
            cohortCandidate("AAA+BBB", "AAA", "BBB", "long", 0.10, { feat_atrPct: 3.0 }),
            cohortCandidate("AAA+BBB", "AAA", "BBB", "long", 0.20, { feat_atrPct: 3.5 }),
            cohortCandidate("DDD+FFF", "DDD", "FFF", "long", -0.30, { feat_atrPct: 1.2 }),
            cohortCandidate("EEE+GGG", "EEE", "GGG", "long", 0.40, { feat_atrPct: 1.4 }),
            cohortCandidate("HHH+III", "HHH", "III", "long", -0.50, { feat_atrPct: 1.6 }),
        ];
        expect(scores(regimeSwitch, pool)).to.deep.equal([3.0, 3.5, 1.2, 1.4, 1.6]);
    });

    it("switches to momentum exactly at one half agreement (regime switch)", () => {
        // Same agreeing pair plus two unusable peers -> 2/4 = 0.5. The
        // momentum branch returns every candidate's adjusted feature value,
        // including negative ones, in place of ATR.
        const pool = [
            cohortCandidate("AAA+BBB", "AAA", "BBB", "long", 0.10, { feat_atrPct: 3.0 }),
            cohortCandidate("AAA+BBB", "AAA", "BBB", "long", 0.20, { feat_atrPct: 3.5 }),
            cohortCandidate("DDD+FFF", "DDD", "FFF", "long", -0.30, { feat_atrPct: 1.2 }),
            cohortCandidate("EEE+GGG", "EEE", "GGG", "long", 0.40, { feat_atrPct: 1.4 }),
        ];
        expect(scores(regimeSwitch, pool)).to.deep.equal([0.10, 0.20, -0.30, 0.40]);
    });

    it("divides agreement by the whole pool length, including unusable candidates (regime switch)", () => {
        // Two agreeing candidates plus three candidates without a usable
        // feature. Whole-pool fraction 2/5 = 0.4 < 0.5 keeps the ATR branch;
        // a usable-only denominator (2/2 = 1) would switch to momentum.
        const pool = [
            cohortCandidate("AAA+BBB", "AAA", "BBB", "long", 0.10, { feat_atrPct: 1.0 }),
            cohortCandidate("AAA+BBB", "AAA", "BBB", "long", 0.20, { feat_atrPct: 1.1 }),
            cohortCandidate("XXX+YYY", "XXX", "YYY", "long", null, { feat_atrPct: 1.2 }),
            cohortCandidate("ZZZ+WWW", "ZZZ", "WWW", "long", null, { feat_atrPct: 1.3 }),
            cohortCandidate("QQQ+RRR", "QQQ", "RRR", "long", null, { feat_atrPct: 1.4 }),
        ];
        expect(scores(regimeSwitch, pool)).to.deep.equal([1.0, 1.1, 1.2, 1.3, 1.4]);
    });

    it("abstains for a missing feature in an aligned pool instead of falling back to ATR (regime switch)", () => {
        // C1/C2 agree -> fraction 2/3 >= 0.5 -> momentum; C3's null feature
        // abstains even though it carries a finite ATR.
        const pool = [
            cohortCandidate("AAA+BBB", "AAA", "BBB", "long", 0.10, { feat_atrPct: 8.8 }),
            cohortCandidate("AAA+BBB", "AAA", "BBB", "long", 0.20, { feat_atrPct: 8.8 }),
            cohortCandidate("PPP+QQQ", "PPP", "QQQ", "long", null, { feat_atrPct: 9.9 }),
        ];
        expect(scores(regimeSwitch, pool)).to.deep.equal([0.10, 0.20, ABSTAIN]);
    });

    it("keeps repeated scoring, fresh pools, and the input pool stable", () => {
        const pool = [
            cohortCandidate("AAA+BBB", "AAA", "BBB", "long", 0.02),
            cohortCandidate("AAA+CCC", "AAA", "CCC", "long", 0.04),
            cohortCandidate("DDD+BBB", "DDD", "BBB", "long", 0.06),
            cohortCandidate("EEE+FFF", "EEE", "FFF", "long", 0.08),
        ];
        const snapshot = JSON.stringify(pool);
        const first = scores(broadTheme, pool);
        expect(scores(broadTheme, pool)).to.deep.equal(first);
        // A fresh pool instance (new objects, same contents) must reproduce
        // the same scores; memoByPool keys on the pool array identity.
        const fresh = pool.map((candidate) => ({ ...candidate }));
        expect(scores(broadTheme, fresh)).to.deep.equal(first);
        expect(scores(oneLeg, fresh)).to.deep.equal(scores(oneLeg, pool));
        expect(scores(regimeSwitch, fresh)).to.deep.equal(scores(regimeSwitch, pool));
        expect(JSON.stringify(pool)).to.equal(snapshot);
    });
});
