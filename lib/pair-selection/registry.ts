import { reference_alphabetical, reference_loudest_atr } from "./references";
import { crowd_range_consensus } from "./crowd_range_consensus";
import { crowd_relative_contrarian } from "./crowd_relative_contrarian";
import { directional_close_location } from "./directional_close_location";
import { direction_adjusted_gap_target } from "./direction_adjusted_gap_target";
import { fresh_fire_recency } from "./fresh_fire_recency";
import { hedge_volatility_balance } from "./hedge_volatility_balance";
import { historical_spread_calm } from "./historical_spread_calm";
import { historical_adverse_excursion_target } from "./historical_adverse_excursion_target";
import { inter_fire_cadence_regularity } from "./inter_fire_cadence_regularity";
import { pair_drawdown_recovery_target } from "./pair_drawdown_recovery_target";
import { pair_win_rate_shrinkage } from "./pair_win_rate_shrinkage";
import { pair_losing_streak_rebound } from "./pair_losing_streak_rebound";
import { relative_atr_cleanliness } from "./relative_atr_cleanliness";
import { shared_leg_overlap_target } from "./shared_leg_overlap_target";
import { signal_burst_density_target } from "./signal_burst_density_target";
import { spread_mean_reversion_halflife } from "./spread_mean_reversion_halflife";
import { spread_return_autocorrelation_target } from "./spread_return_autocorrelation_target";
import { spread_variance_ratio_target } from "./spread_variance_ratio_target";
import { spread_volatility_trend_ratio } from "./spread_volatility_trend_ratio";
import { volatility_expansion_ratio_target } from "./volatility_expansion_ratio_target";
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
    pair_losing_streak_rebound,
    pair_drawdown_recovery_target,
    historical_adverse_excursion_target,
    spread_return_autocorrelation_target,
    spread_variance_ratio_target,
    spread_mean_reversion_halflife,
    volatility_expansion_ratio_target,
    spread_volatility_trend_ratio,
    signal_burst_density_target,
    inter_fire_cadence_regularity,
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
