import { expect } from "chai";
import { describe, it } from "node:test";
import {
    selectEnsembleRuleSelection,
    type EnsembleRuleEvaluation,
} from "./lib/strategy-ensemble-rule-selection";

function createEvaluation(overrides: Partial<EnsembleRuleEvaluation>): EnsembleRuleEvaluation {
    return {
        rule: {
            id: "rule",
            label: "Rule",
        },
        trainSamples: 100,
        trainExpectancy: 5,
        validationSamples: 80,
        validationExpectancy: 4,
        fullTrades: 180,
        fullExpectancy: 4.5,
        validated: false,
        ...overrides,
    };
}

describe("Strategy Ensemble selection", () => {
    it("prefers a genuinely validated rule over a stronger in-sample but invalid candidate", () => {
        const unsafeExtreme = createEvaluation({
            rule: { id: "min18", label: "minFamilyAgree >= 18" },
            trainExpectancy: 25,
            validationExpectancy: -5000,
            fullExpectancy: -4000,
            fullTrades: 25,
            validated: false,
        });
        const safeValidated = createEvaluation({
            rule: { id: "oppose3", label: "maxFamilyOppose <= 3" },
            trainExpectancy: 8,
            validationExpectancy: 6,
            fullExpectancy: 7,
            validated: true,
        });

        const selected = selectEnsembleRuleSelection([unsafeExtreme, safeValidated], 5);

        expect(selected).to.not.equal(null);
        expect(selected?.mode).to.equal("validated");
        expect(selected?.evaluation.rule.id).to.equal("oppose3");
    });

    it("falls back to train-only candidates only when the full backtest remains positive", () => {
        const catastrophic = createEvaluation({
            rule: { id: "min17", label: "minFamilyAgree >= 17" },
            trainExpectancy: 19,
            validationExpectancy: -20,
            fullExpectancy: -300,
            fullTrades: 32,
            validated: false,
        });
        const cautiousPositive = createEvaluation({
            rule: { id: "oppose6", label: "maxFamilyOppose <= 6" },
            trainExpectancy: 6,
            validationExpectancy: 2,
            fullExpectancy: 5.5,
            fullTrades: 220,
            validated: false,
        });

        const selected = selectEnsembleRuleSelection([catastrophic, cautiousPositive], 5);

        expect(selected).to.not.equal(null);
        expect(selected?.mode).to.equal("train_only");
        expect(selected?.evaluation.rule.id).to.equal("oppose6");
    });

    it("returns no recommendation when only catastrophic train-only candidates remain", () => {
        const catastrophicA = createEvaluation({
            rule: { id: "min17", label: "minFamilyAgree >= 17" },
            trainExpectancy: 30,
            validationExpectancy: -100,
            fullExpectancy: -500,
            fullTrades: 30,
            validated: false,
        });
        const catastrophicB = createEvaluation({
            rule: { id: "min18", label: "minFamilyAgree >= 18" },
            trainExpectancy: 35,
            validationExpectancy: -200,
            fullExpectancy: -800,
            fullTrades: 25,
            validated: false,
        });

        const selected = selectEnsembleRuleSelection([catastrophicA, catastrophicB], 5);

        expect(selected).to.equal(null);
    });
});
