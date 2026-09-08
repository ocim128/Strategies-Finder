import type { PairSelectionRule } from "./types";

export const win_rate_momentum_regime_shift: PairSelectionRule = {
    key: "win_rate_momentum_regime_shift",
    name: "Win Rate Momentum Regime Shift",
    description: "Ranks the change from 32-trade to 8-trade rolling win fraction.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v1",
            columns: [
                "feat_fp_trade_win_fraction_t8_r1",
                "feat_fp_trade_win_fraction_t32_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/win_rate_momentum_regime_shift.ts"],
    },
    score: (candidate) => {
        const w8 = candidate.feat_fp_trade_win_fraction_t8_r1;
        const w32 = candidate.feat_fp_trade_win_fraction_t32_r1;
        if (w8 === null || w32 === null) return Number.NEGATIVE_INFINITY;
        return w8 - w32;
    },
};
