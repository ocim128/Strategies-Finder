import { reference_alphabetical, reference_loudest_atr } from "./references";
import { multi_horizon_directional_concordance } from "./multi_horizon_directional_concordance";
import { intermediate_directional_spread_momentum } from "./intermediate_directional_spread_momentum";
import { variance_ratio_trend_persistence } from "./variance_ratio_trend_persistence";
import { interday_persistence_scaled_momentum } from "./interday_persistence_scaled_momentum";
import { directional_ols_drift_rate } from "./directional_ols_drift_rate";
import { crowd_relative_momentum_isolation } from "./crowd_relative_momentum_isolation";
import { directional_spread_efficiency } from "./directional_spread_efficiency";
import { short_horizon_directional_momentum } from "./short_horizon_directional_momentum";
import { laplace_log_odds_win_rate } from "./laplace_log_odds_win_rate";
import { laplace_uniform_win_rate } from "./laplace_uniform_win_rate";
import { efficiency_weighted_clean_atr } from "./efficiency_weighted_clean_atr";
import { wilson_lower_bound_win_rate } from "./wilson_lower_bound_win_rate";
import { directional_drift_efficiency_product } from "./directional_drift_efficiency_product";
import { laplace_bayesian_odds_ratio } from "./laplace_bayesian_odds_ratio";
import { directional_drift_acceleration } from "./directional_drift_acceleration";
import { directional_increment_streak_persistence } from "./directional_increment_streak_persistence";
import { directional_spread_zscore_extremity } from "./directional_spread_zscore_extremity";
import { pullback_discounted_directional_momentum } from "./pullback_discounted_directional_momentum";
import { cross_sectional_momentum_rank_concordance } from "./cross_sectional_momentum_rank_concordance";
import { cross_sectional_drift_efficiency_rank_sum } from "./cross_sectional_drift_efficiency_rank_sum";
import { cross_sectional_trend_volatility_rank_sum } from "./cross_sectional_trend_volatility_rank_sum";
import { event_breadth_directional_concordance } from "./event_breadth_directional_concordance";
import { divergent_leg_momentum_concordance } from "./divergent_leg_momentum_concordance";
import { directional_volatility_asymmetry_ratio } from "./directional_volatility_asymmetry_ratio";
import { hub_cluster_momentum_excess } from "./hub_cluster_momentum_excess";
import { directional_spread_sortino_ratio } from "./directional_spread_sortino_ratio";
import { linear_determination_scaled_drift } from "./linear_determination_scaled_drift";
import { concordant_drift_velocity_product } from "./concordant_drift_velocity_product";
import { autoregressive_persistence_scaled_drift } from "./autoregressive_persistence_scaled_drift";
import { directional_spread_distance_to_median } from "./directional_spread_distance_to_median";
import { directional_zscore_velocity_expansion } from "./directional_zscore_velocity_expansion";
import { cross_sectional_drift_autocorrelation_rank_sum } from "./cross_sectional_drift_autocorrelation_rank_sum";
import { directional_leg_volatility_dominance_ratio } from "./directional_leg_volatility_dominance_ratio";
import { spread_range_asymmetry_odds_ratio } from "./spread_range_asymmetry_odds_ratio";
import { variance_ratio_persistence_excess } from "./variance_ratio_persistence_excess";
import { spread_path_information_ratio } from "./spread_path_information_ratio";
import { volatility_clustering_scaled_momentum } from "./volatility_clustering_scaled_momentum";
import { volatility_impulse_scaled_momentum } from "./volatility_impulse_scaled_momentum";
import { event_beta_deducted_spread_alpha } from "./event_beta_deducted_spread_alpha";
import { fresh_trend_emergence_ratio } from "./fresh_trend_emergence_ratio";
import { cross_sectional_min_rank_concordance } from "./cross_sectional_min_rank_concordance";
import { spread_efficiency_acceleration_ratio } from "./spread_efficiency_acceleration_ratio";
import { cohort_normalized_directional_rank } from "./cohort_normalized_directional_rank";
import { discrete_spread_path_acceleration } from "./discrete_spread_path_acceleration";
import { cointegrated_base_breakout_ratio } from "./cointegrated_base_breakout_ratio";
import { econometric_forward_return_projection } from "./econometric_forward_return_projection";
import { donchian_range_expansion_momentum } from "./donchian_range_expansion_momentum";
import { efficient_loud_drift_product } from "./efficient_loud_drift_product";
import { dispersion_conditioned_horizon_switch } from "./dispersion_conditioned_horizon_switch";
import { institutional_wave_persistence_spread } from "./institutional_wave_persistence_spread";
import { directional_volatility_purity_ratio } from "./directional_volatility_purity_ratio";
import { cross_sectional_rank_acceleration } from "./cross_sectional_rank_acceleration";
import { trend_to_noise_volatility_ratio } from "./trend_to_noise_volatility_ratio";
import { directional_mean_reversion_zscore } from "./directional_mean_reversion_zscore";
import { variance_ratio_mean_reversion_elasticity } from "./variance_ratio_mean_reversion_elasticity";
import { negative_autocorrelation_bounce_projection } from "./negative_autocorrelation_bounce_projection";
import { fast_halflife_adverse_displacement } from "./fast_halflife_adverse_displacement";
import { volatility_scaled_adverse_median_reversion } from "./volatility_scaled_adverse_median_reversion";
import { low_efficiency_exhaustion_spring } from "./low_efficiency_exhaustion_spring";
import { cross_sectional_adverse_return_rank } from "./cross_sectional_adverse_return_rank";
import { adverse_increment_streak_rebound } from "./adverse_increment_streak_rebound";
import { short_to_intermediate_reversion_gap } from "./short_to_intermediate_reversion_gap";
import { adverse_channel_bounce_proximity } from "./adverse_channel_bounce_proximity";
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
    directional_drift_acceleration,
    directional_increment_streak_persistence,
    directional_spread_zscore_extremity,
    pullback_discounted_directional_momentum,
    cross_sectional_momentum_rank_concordance,
    cross_sectional_drift_efficiency_rank_sum,
    cross_sectional_trend_volatility_rank_sum,
    event_breadth_directional_concordance,
    divergent_leg_momentum_concordance,
    directional_volatility_asymmetry_ratio,
    hub_cluster_momentum_excess,
    directional_spread_sortino_ratio,
    linear_determination_scaled_drift,
    concordant_drift_velocity_product,
    autoregressive_persistence_scaled_drift,
    directional_spread_distance_to_median,
    directional_zscore_velocity_expansion,
    cross_sectional_drift_autocorrelation_rank_sum,
    directional_leg_volatility_dominance_ratio,
    spread_range_asymmetry_odds_ratio,
    variance_ratio_persistence_excess,
    spread_path_information_ratio,
    volatility_clustering_scaled_momentum,
    volatility_impulse_scaled_momentum,
    event_beta_deducted_spread_alpha,
    fresh_trend_emergence_ratio,
    cross_sectional_min_rank_concordance,
    spread_efficiency_acceleration_ratio,
    cohort_normalized_directional_rank,
    discrete_spread_path_acceleration,
    cointegrated_base_breakout_ratio,
    econometric_forward_return_projection,
    donchian_range_expansion_momentum,
    efficient_loud_drift_product,
    dispersion_conditioned_horizon_switch,
    institutional_wave_persistence_spread,
    directional_volatility_purity_ratio,
    cross_sectional_rank_acceleration,
    trend_to_noise_volatility_ratio,
    directional_mean_reversion_zscore,
    variance_ratio_mean_reversion_elasticity,
    negative_autocorrelation_bounce_projection,
    fast_halflife_adverse_displacement,
    volatility_scaled_adverse_median_reversion,
    low_efficiency_exhaustion_spring,
    cross_sectional_adverse_return_rank,
    adverse_increment_streak_rebound,
    short_to_intermediate_reversion_gap,
    adverse_channel_bounce_proximity,
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
