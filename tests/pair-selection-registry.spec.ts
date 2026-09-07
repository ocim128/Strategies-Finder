import { expect } from "chai";
import { describe, it } from "node:test";
import { pairSelectionRuleRegistry } from "../lib/pair-selection/registry";
import { pickPairSelectionRule, type PairSelectionEvent } from "../lib/pair-selection/tally";
import type { PairCandidate } from "../lib/pair-selection/types";

const pool: PairCandidate[] = [
    {
        pair: "AAA+BBB",
        baseSymbol: "AAA",
        quoteSymbol: "BBB",
        direction: "long",
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
    },
    {
        pair: "CCC+DDD",
        baseSymbol: "CCC",
        quoteSymbol: "DDD",
        direction: "short",
        signalTime: 1_700_000_000,
        signalBarIndex: 100,
        feat_entryRangePosition: 25,
        feat_atrPct: 2,
        feat_return20: -0.2,
        feat_gapPct: -0.01,
        feat_dow: 1,
        feat_hour: 12,
        feat_pairWinRatePrior: 0.8,
        feat_pairTradesPrior: 10,
        feat_barsSincePairLastFire: 4,
        feat_pairSpreadVolatility20: 2,
        feat_legVolatilityRatio20: 1.1,
        feat_candidatesAtTime: 2,
    },
];

const event: PairSelectionEvent = {
    context: { signalTime: 1_700_000_000, interval: "4h", strategyKey: "fixture" },
    candidates: pool,
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
            for (const candidate of pool) {
                const score = rule.score(candidate, event.context, rule.defaultParams, pool);
                expect(score === Number.NEGATIVE_INFINITY || Number.isFinite(score), `${rule.key} score`).to.equal(true);
            }
            expect(pickPairSelectionRule(event, rule, rule.defaultParams))
                .to.deep.equal(pickPairSelectionRule(event, rule, rule.defaultParams));
        }
    });
});
