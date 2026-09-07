import { reference_alphabetical, reference_loudest_atr } from "./references";
import { crowd_range_consensus } from "./crowd_range_consensus";
import { crowd_relative_contrarian } from "./crowd_relative_contrarian";
import { directional_close_location } from "./directional_close_location";
import { direction_adjusted_gap_target } from "./direction_adjusted_gap_target";
import { fresh_fire_recency } from "./fresh_fire_recency";
import { hedge_volatility_balance } from "./hedge_volatility_balance";
import { historical_spread_calm } from "./historical_spread_calm";
import { pair_win_rate_shrinkage } from "./pair_win_rate_shrinkage";
import { relative_atr_cleanliness } from "./relative_atr_cleanliness";
import { shared_leg_overlap_target } from "./shared_leg_overlap_target";
import type { PairSelectionRule } from "./types";

const pairSelectionRuleDefinitions = [
    reference_alphabetical,
    reference_loudest_atr,
    directional_close_location,
    direction_adjusted_gap_target,
    relative_atr_cleanliness,
    pair_win_rate_shrinkage,
    fresh_fire_recency,
    shared_leg_overlap_target,
    crowd_relative_contrarian,
    crowd_range_consensus,
    historical_spread_calm,
    hedge_volatility_balance,
] as const satisfies readonly PairSelectionRule[];

if (new Set(pairSelectionRuleDefinitions.map((rule) => rule.key)).size !== pairSelectionRuleDefinitions.length) {
    throw new Error("Duplicate pair-selection rule key.");
}

export const pairSelectionRuleRegistry: ReadonlyMap<string, PairSelectionRule> = new Map(
    pairSelectionRuleDefinitions.map((rule) => [rule.key, rule] as const),
);

export function getPairSelectionRule(key: string): PairSelectionRule | undefined {
    return pairSelectionRuleRegistry.get(key);
}
