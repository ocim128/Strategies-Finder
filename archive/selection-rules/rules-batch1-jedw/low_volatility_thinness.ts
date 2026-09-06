import type { SelectionRule } from "./types";

export const low_volatility_thinness: SelectionRule = {
    key: "low_volatility_thinness",
    name: "Low Volatility Thinness",
    description:
        "Ranks candidates by base thinness (100 - activePairCount) divided by volatilityBaseline plus priorScoreStdDev5. Null priorScoreStdDev5 uses volatilityBaseline as neutral dispersion.",
    defaultParams: { volatilityBaseline: 0.01 },
    paramLabels: { volatilityBaseline: "Volatility baseline" },
    normalizeParams(params) {
        const raw = typeof params.volatilityBaseline === "number" && Number.isFinite(params.volatilityBaseline)
            ? params.volatilityBaseline
            : 0.01;
        return { volatilityBaseline: Math.max(Number.EPSILON, raw) };
    },
    score(candidate, _event, params) {
        const baseThinness = 100 - candidate.activePairCount;
        const stdDev = candidate.priorScoreStdDev5 === null
            ? params.volatilityBaseline!
            : candidate.priorScoreStdDev5;
        return baseThinness / (params.volatilityBaseline! + stdDev);
    },
};
