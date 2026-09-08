import { reference_alphabetical, reference_loudest_atr } from "./references";
import { crowd_relative_momentum_isolation } from "./crowd_relative_momentum_isolation";
import { directional_drift_efficiency_product } from "./directional_drift_efficiency_product";
import { directional_ols_drift_rate } from "./directional_ols_drift_rate";
import { directional_spread_efficiency } from "./directional_spread_efficiency";
import { efficiency_weighted_clean_atr } from "./efficiency_weighted_clean_atr";
import { interday_persistence_scaled_momentum } from "./interday_persistence_scaled_momentum";
import { intermediate_directional_spread_momentum } from "./intermediate_directional_spread_momentum";
import { laplace_bayesian_odds_ratio } from "./laplace_bayesian_odds_ratio";
import { laplace_log_odds_win_rate } from "./laplace_log_odds_win_rate";
import { laplace_uniform_win_rate } from "./laplace_uniform_win_rate";
import { multi_horizon_directional_concordance } from "./multi_horizon_directional_concordance";
import { short_horizon_directional_momentum } from "./short_horizon_directional_momentum";
import { variance_ratio_trend_persistence } from "./variance_ratio_trend_persistence";
import { wilson_lower_bound_win_rate } from "./wilson_lower_bound_win_rate";
import type { PairSelectionRule } from "./types";

const pairSelectionRuleDefinitions = [
    reference_alphabetical,
    reference_loudest_atr,
    multi_horizon_directional_concordance,
    intermediate_directional_spread_momentum,
    variance_ratio_trend_persistence,
    interday_persistence_scaled_momentum,
    directional_ols_drift_rate,
    crowd_relative_momentum_isolation,
    directional_spread_efficiency,
    short_horizon_directional_momentum,
    laplace_log_odds_win_rate,
    laplace_uniform_win_rate,
    efficiency_weighted_clean_atr,
    wilson_lower_bound_win_rate,
    directional_drift_efficiency_product,
    laplace_bayesian_odds_ratio,
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
