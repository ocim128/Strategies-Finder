// Clean pair-selection registry: 65 entries (diagnostic cleanup 2026-09-08).
import { adverse_channel_bounce_proximity } from "./adverse_channel_bounce_proximity";
import { adverse_increment_streak_rebound } from "./adverse_increment_streak_rebound";
import { autoregressive_persistence_scaled_drift } from "./autoregressive_persistence_scaled_drift";
import { cohort_normalized_directional_rank } from "./cohort_normalized_directional_rank";
import { cointegrated_base_breakout_ratio } from "./cointegrated_base_breakout_ratio";
import { concordant_drift_velocity_product } from "./concordant_drift_velocity_product";
import { cross_sectional_adverse_return_rank } from "./cross_sectional_adverse_return_rank";
import { cross_sectional_drift_autocorrelation_rank_sum } from "./cross_sectional_drift_autocorrelation_rank_sum";
import { cross_sectional_drift_efficiency_rank_sum } from "./cross_sectional_drift_efficiency_rank_sum";
import { cross_sectional_min_rank_concordance } from "./cross_sectional_min_rank_concordance";
import { cross_sectional_momentum_rank_concordance } from "./cross_sectional_momentum_rank_concordance";
import { cross_sectional_rank_acceleration } from "./cross_sectional_rank_acceleration";
import { cross_sectional_trend_volatility_rank_sum } from "./cross_sectional_trend_volatility_rank_sum";
import { crowd_relative_momentum_isolation } from "./crowd_relative_momentum_isolation";
import { directional_drift_acceleration } from "./directional_drift_acceleration";
import { directional_drift_efficiency_product } from "./directional_drift_efficiency_product";
import { directional_increment_streak_persistence } from "./directional_increment_streak_persistence";
import { directional_leg_volatility_dominance_ratio } from "./directional_leg_volatility_dominance_ratio";
import { directional_mean_reversion_zscore } from "./directional_mean_reversion_zscore";
import { directional_ols_drift_rate } from "./directional_ols_drift_rate";
import { directional_spread_distance_to_median } from "./directional_spread_distance_to_median";
import { directional_spread_efficiency } from "./directional_spread_efficiency";
import { directional_spread_sortino_ratio } from "./directional_spread_sortino_ratio";
import { directional_spread_zscore_extremity } from "./directional_spread_zscore_extremity";
import { directional_volatility_asymmetry_ratio } from "./directional_volatility_asymmetry_ratio";
import { directional_volatility_purity_ratio } from "./directional_volatility_purity_ratio";
import { directional_zscore_velocity_expansion } from "./directional_zscore_velocity_expansion";
import { discrete_spread_path_acceleration } from "./discrete_spread_path_acceleration";
import { dispersion_conditioned_horizon_switch } from "./dispersion_conditioned_horizon_switch";
import { divergent_leg_momentum_concordance } from "./divergent_leg_momentum_concordance";
import { donchian_range_expansion_momentum } from "./donchian_range_expansion_momentum";
import { econometric_forward_return_projection } from "./econometric_forward_return_projection";
import { efficiency_weighted_clean_atr } from "./efficiency_weighted_clean_atr";
import { efficient_loud_drift_product } from "./efficient_loud_drift_product";
import { event_beta_deducted_spread_alpha } from "./event_beta_deducted_spread_alpha";
import { event_breadth_directional_concordance } from "./event_breadth_directional_concordance";
import { fast_halflife_adverse_displacement } from "./fast_halflife_adverse_displacement";
import { fresh_trend_emergence_ratio } from "./fresh_trend_emergence_ratio";
import { hub_cluster_momentum_excess } from "./hub_cluster_momentum_excess";
import { institutional_wave_persistence_spread } from "./institutional_wave_persistence_spread";
import { interday_persistence_scaled_momentum } from "./interday_persistence_scaled_momentum";
import { intermediate_directional_spread_momentum } from "./intermediate_directional_spread_momentum";
import { laplace_bayesian_odds_ratio } from "./laplace_bayesian_odds_ratio";
import { laplace_log_odds_win_rate } from "./laplace_log_odds_win_rate";
import { laplace_uniform_win_rate } from "./laplace_uniform_win_rate";
import { linear_determination_scaled_drift } from "./linear_determination_scaled_drift";
import { low_efficiency_exhaustion_spring } from "./low_efficiency_exhaustion_spring";
import { multi_horizon_directional_concordance } from "./multi_horizon_directional_concordance";
import { negative_autocorrelation_bounce_projection } from "./negative_autocorrelation_bounce_projection";
import { pullback_discounted_directional_momentum } from "./pullback_discounted_directional_momentum";
import { reference_alphabetical, reference_loudest_atr } from "./references";
import { short_horizon_directional_momentum } from "./short_horizon_directional_momentum";
import { short_to_intermediate_reversion_gap } from "./short_to_intermediate_reversion_gap";
import { spread_efficiency_acceleration_ratio } from "./spread_efficiency_acceleration_ratio";
import { spread_path_information_ratio } from "./spread_path_information_ratio";
import { spread_range_asymmetry_odds_ratio } from "./spread_range_asymmetry_odds_ratio";
import { trend_to_noise_volatility_ratio } from "./trend_to_noise_volatility_ratio";
import { variance_ratio_mean_reversion_elasticity } from "./variance_ratio_mean_reversion_elasticity";
import { variance_ratio_persistence_excess } from "./variance_ratio_persistence_excess";
import { variance_ratio_trend_persistence } from "./variance_ratio_trend_persistence";
import { volatility_clustering_scaled_momentum } from "./volatility_clustering_scaled_momentum";
import { volatility_impulse_scaled_momentum } from "./volatility_impulse_scaled_momentum";
import { volatility_scaled_adverse_median_reversion } from "./volatility_scaled_adverse_median_reversion";
import { wilson_lower_bound_win_rate } from "./wilson_lower_bound_win_rate";
import type { PairSelectionRule } from "./types";

const pairSelectionRuleDefinitions = [
    adverse_channel_bounce_proximity,
    adverse_increment_streak_rebound,
    autoregressive_persistence_scaled_drift,
    cohort_normalized_directional_rank,
    cointegrated_base_breakout_ratio,
    concordant_drift_velocity_product,
    cross_sectional_adverse_return_rank,
    cross_sectional_drift_autocorrelation_rank_sum,
    cross_sectional_drift_efficiency_rank_sum,
    cross_sectional_min_rank_concordance,
    cross_sectional_momentum_rank_concordance,
    cross_sectional_rank_acceleration,
    cross_sectional_trend_volatility_rank_sum,
    crowd_relative_momentum_isolation,
    directional_drift_acceleration,
    directional_drift_efficiency_product,
    directional_increment_streak_persistence,
    directional_leg_volatility_dominance_ratio,
    directional_mean_reversion_zscore,
    directional_ols_drift_rate,
    directional_spread_distance_to_median,
    directional_spread_efficiency,
    directional_spread_sortino_ratio,
    directional_spread_zscore_extremity,
    directional_volatility_asymmetry_ratio,
    directional_volatility_purity_ratio,
    directional_zscore_velocity_expansion,
    discrete_spread_path_acceleration,
    dispersion_conditioned_horizon_switch,
    divergent_leg_momentum_concordance,
    donchian_range_expansion_momentum,
    econometric_forward_return_projection,
    efficiency_weighted_clean_atr,
    efficient_loud_drift_product,
    event_beta_deducted_spread_alpha,
    event_breadth_directional_concordance,
    fast_halflife_adverse_displacement,
    fresh_trend_emergence_ratio,
    hub_cluster_momentum_excess,
    institutional_wave_persistence_spread,
    interday_persistence_scaled_momentum,
    intermediate_directional_spread_momentum,
    laplace_bayesian_odds_ratio,
    laplace_log_odds_win_rate,
    laplace_uniform_win_rate,
    linear_determination_scaled_drift,
    low_efficiency_exhaustion_spring,
    multi_horizon_directional_concordance,
    negative_autocorrelation_bounce_projection,
    pullback_discounted_directional_momentum,
    reference_alphabetical,
    reference_loudest_atr,
    short_horizon_directional_momentum,
    short_to_intermediate_reversion_gap,
    spread_efficiency_acceleration_ratio,
    spread_path_information_ratio,
    spread_range_asymmetry_odds_ratio,
    trend_to_noise_volatility_ratio,
    variance_ratio_mean_reversion_elasticity,
    variance_ratio_persistence_excess,
    variance_ratio_trend_persistence,
    volatility_clustering_scaled_momentum,
    volatility_impulse_scaled_momentum,
    volatility_scaled_adverse_median_reversion,
    wilson_lower_bound_win_rate,
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
