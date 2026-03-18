export interface EnsembleRuleSpec {
    id: string;
    label: string;
    minFamilyAgree?: number;
    maxFamilyOppose?: number;
    minFamilyAgreeRatio?: number;
}

export interface EnsembleRuleEvaluation {
    rule: EnsembleRuleSpec;
    trainSamples: number;
    trainExpectancy: number;
    validationSamples: number;
    validationExpectancy: number;
    fullTrades: number;
    fullExpectancy: number;
    validated: boolean;
}

export interface EnsembleRuleSelection {
    mode: "validated" | "train_only";
    evaluation: EnsembleRuleEvaluation;
}

export function selectEnsembleRuleSelection(
    evaluations: EnsembleRuleEvaluation[],
    minSamples: number
): EnsembleRuleSelection | null {
    const validated = evaluations
        .filter((evaluation) => evaluation.validated)
        .sort((left, right) => {
            if (left.validationExpectancy !== right.validationExpectancy) {
                return right.validationExpectancy - left.validationExpectancy;
            }
            if (left.fullExpectancy !== right.fullExpectancy) {
                return right.fullExpectancy - left.fullExpectancy;
            }
            return right.validationSamples - left.validationSamples;
        })[0];
    if (validated) {
        return {
            mode: "validated",
            evaluation: validated,
        };
    }

    const trainOnly = evaluations
        .filter((evaluation) =>
            evaluation.trainSamples >= minSamples
            && evaluation.validationSamples >= minSamples
            && Number.isFinite(evaluation.trainExpectancy)
            && Number.isFinite(evaluation.fullExpectancy)
            && evaluation.fullExpectancy > 0
        )
        .sort((left, right) => {
            if (left.trainExpectancy !== right.trainExpectancy) {
                return right.trainExpectancy - left.trainExpectancy;
            }
            if (left.fullExpectancy !== right.fullExpectancy) {
                return right.fullExpectancy - left.fullExpectancy;
            }
            return right.validationExpectancy - left.validationExpectancy;
        })[0];

    return trainOnly
        ? {
            mode: "train_only",
            evaluation: trainOnly,
        }
        : null;
}
