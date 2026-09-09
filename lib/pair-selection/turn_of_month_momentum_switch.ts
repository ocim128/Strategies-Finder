import { directionAdjusted } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

function normalizeBoundaryDays(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function isTurnOfMonth(signalTime: number, boundaryDays: number): boolean {
    const date = new Date(signalTime * 1000);
    if (!Number.isFinite(date.getTime())) return false;
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    return date.getUTCDate() <= boundaryDays || date.getUTCDate() > lastDay - boundaryDays;
}

export const turn_of_month_momentum_switch: PairSelectionRule = {
    key: "turn_of_month_momentum_switch",
    name: "Turn Of Month Momentum Switch",
    description: "Uses directional 48-bar momentum near month boundaries and ATR in the month interior.",
    defaultParams: { boundaryDays: 3 },
    paramLabels: { boundaryDays: "Calendar days from a month boundary for the momentum arm" },
    normalizeParams: (params) => ({
        ...params,
        boundaryDays: normalizeBoundaryDays(params.boundaryDays!),
    }),
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/turn_of_month_momentum_switch.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, params) => {
        if (isTurnOfMonth(candidate.signalTime, normalizeBoundaryDays(params.boundaryDays!))) {
            return directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1)
                ?? Number.NEGATIVE_INFINITY;
        }
        return candidate.feat_atrPct !== null && Number.isFinite(candidate.feat_atrPct)
            ? candidate.feat_atrPct
            : Number.NEGATIVE_INFINITY;
    },
};
