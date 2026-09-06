import type { SelectionRule } from "./types";

export const regime_conditioned_flow_switch: SelectionRule = {
    key: "regime_conditioned_flow_switch",
    name: "Regime-Conditioned Flow Switch",
    description:
        "Uses prior vote delta minus 0.1 times coverage slope in bullish regimes, and bearishContractionWeight times negative coverage slope plus 0.1 times vote delta otherwise. Null vote delta and coverage slope are treated as zero.",
    defaultParams: { bearishContractionWeight: 2.0 },
    paramLabels: { bearishContractionWeight: "Bearish contraction weight" },
    score(candidate, _event, params) {
        const delta = candidate.priorSignedVoteDelta3 === null ? 0 : candidate.priorSignedVoteDelta3;
        const slope = candidate.priorCoverageSlope5 === null ? 0 : candidate.priorCoverageSlope5;
        return candidate.regime === "bullish"
            ? delta - 0.1 * slope
            : -params.bearishContractionWeight! * slope + 0.1 * delta;
    },
};
