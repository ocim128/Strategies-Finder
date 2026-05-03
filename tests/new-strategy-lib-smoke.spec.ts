import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Strategy, Time } from "../lib/types/strategies";
import { adx_persistence_vote_quorum } from "../lib/strategies/lib/adx_persistence_vote_quorum";
import { accumulation_distribution_router } from "../lib/strategies/lib/accumulation_distribution_router";
import { atr_normalized_displacement } from "../lib/strategies/lib/atr_normalized_displacement";
import { autocorrelation_persistence_router } from "../lib/strategies/lib/autocorrelation_persistence_router";
import { body_proportion_regime_router } from "../lib/strategies/lib/body_proportion_regime_router";
import { body_relative_distribution_router } from "../lib/strategies/lib/body_relative_distribution_router";
import { close_acceptance_momentum } from "../lib/strategies/lib/close_acceptance_momentum";
import { close_location_persistence_streak } from "../lib/strategies/lib/close_location_persistence_streak";
import { cmf_mfi_conviction_quorum } from "../lib/strategies/lib/cmf_mfi_conviction_quorum";
import { compression_expansion_router } from "../lib/strategies/lib/compression_expansion_router";
import { cumulative_gap_settlement_anchor } from "../lib/strategies/lib/cumulative_gap_settlement_anchor";
import { displacement_velocity_quorum } from "../lib/strategies/lib/displacement_velocity_quorum";
import { distribution_shape_router } from "../lib/strategies/lib/distribution_shape_router";
import { donchian_keltner_squeeze } from "../lib/strategies/lib/donchian_keltner_squeeze";
import { dual_efficiency_momentum_quorum } from "../lib/strategies/lib/dual_efficiency_momentum_quorum";
import { dual_horizon_median_quorum } from "../lib/strategies/lib/dual_horizon_median_quorum";
import { efficiency_momentum_quorum } from "../lib/strategies/lib/efficiency_momentum_quorum";
import { efficiency_regime_router } from "../lib/strategies/lib/efficiency_regime_router";
import { entropy_acceleration_quorum } from "../lib/strategies/lib/entropy_acceleration_quorum";
import { entropy_compressed_roc_alignment } from "../lib/strategies/lib/entropy_compressed_roc_alignment";
import { entropy_kurtosis_composite } from "../lib/strategies/lib/entropy_kurtosis_composite";
import { gap_settlement_quorum } from "../lib/strategies/lib/gap_settlement_quorum";
import { high_efficiency_streak_alignment } from "../lib/strategies/lib/high_efficiency_streak_alignment";
import { initiative_gated_vwap_alignment } from "../lib/strategies/lib/initiative_gated_vwap_alignment";
import { initiative_pressure_median_anchor } from "../lib/strategies/lib/initiative_pressure_median_anchor";
import { initiative_pressure_regime } from "../lib/strategies/lib/initiative_pressure_regime";
import { kurtosis_stability_median_alignment } from "../lib/strategies/lib/kurtosis_stability_median_alignment";
import { mfi_adx_strength_quorum } from "../lib/strategies/lib/mfi_adx_strength_quorum";
import { midpoint_gravity_quorum } from "../lib/strategies/lib/midpoint_gravity_quorum";
import { multi_horizon_disagreement } from "../lib/strategies/lib/multi_horizon_disagreement";
import { participation_streak_regime } from "../lib/strategies/lib/participation_streak_regime";
import { percentile_momentum_or_reversion } from "../lib/strategies/lib/percentile_momentum_or_reversion";
import { poc_displacement_trend_anchor } from "../lib/strategies/lib/poc_displacement_trend_anchor";
import { participation_entropy_router } from "../lib/strategies/lib/participation_entropy_router";
import { range_expansion_acceptance } from "../lib/strategies/lib/range_expansion_acceptance";
import { roc_skewness_quorum } from "../lib/strategies/lib/roc_skewness_quorum";
import { rolling_zscore_boundary_reversion } from "../lib/strategies/lib/rolling_zscore_boundary_reversion";
import { rsi_roc_extreme_quorum } from "../lib/strategies/lib/rsi_roc_extreme_quorum";
import { rsi_stoch_extreme_or } from "../lib/strategies/lib/rsi_stoch_extreme_or";
import { skew_kurtosis_quorum_alignment } from "../lib/strategies/lib/skew_kurtosis_quorum_alignment";
import { skewness_acceleration_composite } from "../lib/strategies/lib/skewness_acceleration_composite";
import { skewness_biased_donchian_router } from "../lib/strategies/lib/skewness_biased_donchian_router";
import { trailing_boundary_composite } from "../lib/strategies/lib/trailing_boundary_composite";
import { true_range_skew_acceptance } from "../lib/strategies/lib/true_range_skew_acceptance";
import { typical_weighting_consensus_quorum } from "../lib/strategies/lib/typical_weighting_consensus_quorum";
import { value_area_volume_composite } from "../lib/strategies/lib/value_area_volume_composite";
import { volume_acceptance_composite_or } from "../lib/strategies/lib/volume_acceptance_composite_or";
import { volume_roc_regime_router } from "../lib/strategies/lib/volume_roc_regime_router";
import { volatility_regime_expansion_router } from "../lib/strategies/lib/volatility_regime_expansion_router";
import { volume_profile_poc_migration } from "../lib/strategies/lib/volume_profile_poc_migration";

const strategies: Strategy[] = [
    adx_persistence_vote_quorum,
    accumulation_distribution_router,
    atr_normalized_displacement,
    autocorrelation_persistence_router,
    body_proportion_regime_router,
    body_relative_distribution_router,
    close_acceptance_momentum,
    close_location_persistence_streak,
    cmf_mfi_conviction_quorum,
    compression_expansion_router,
    cumulative_gap_settlement_anchor,
    displacement_velocity_quorum,
    distribution_shape_router,
    donchian_keltner_squeeze,
    dual_efficiency_momentum_quorum,
    dual_horizon_median_quorum,
    efficiency_momentum_quorum,
    efficiency_regime_router,
    entropy_acceleration_quorum,
    entropy_compressed_roc_alignment,
    entropy_kurtosis_composite,
    gap_settlement_quorum,
    high_efficiency_streak_alignment,
    initiative_gated_vwap_alignment,
    initiative_pressure_median_anchor,
    initiative_pressure_regime,
    kurtosis_stability_median_alignment,
    mfi_adx_strength_quorum,
    midpoint_gravity_quorum,
    multi_horizon_disagreement,
    participation_streak_regime,
    percentile_momentum_or_reversion,
    poc_displacement_trend_anchor,
    participation_entropy_router,
    range_expansion_acceptance,
    roc_skewness_quorum,
    rolling_zscore_boundary_reversion,
    rsi_roc_extreme_quorum,
    rsi_stoch_extreme_or,
    skew_kurtosis_quorum_alignment,
    skewness_acceleration_composite,
    skewness_biased_donchian_router,
    trailing_boundary_composite,
    true_range_skew_acceptance,
    typical_weighting_consensus_quorum,
    value_area_volume_composite,
    volume_acceptance_composite_or,
    volume_roc_regime_router,
    volatility_regime_expansion_router,
    volume_profile_poc_migration,
];

function buildSampleData(length: number): OHLCVData[] {
    const data: OHLCVData[] = [];
    let close = 100;

    for (let i = 0; i < length; i++) {
        const drift = i < length / 2 ? 0.18 : -0.12;
        const wave = Math.sin(i / 6) * 0.75;
        const previousClose = close;
        close = Math.max(5, close + drift + wave * 0.2);
        const open = previousClose + Math.sin(i / 5) * 0.3;
        const high = Math.max(open, close) + 1 + Math.abs(Math.sin(i / 7));
        const low = Math.min(open, close) - 1 - Math.abs(Math.cos(i / 9));
        data.push({
            time: `2024-01-${String((i % 28) + 1).padStart(2, "0")}` as Time,
            open,
            high,
            low,
            close,
            volume: 1000 + (i % 11) * 125 + Math.round(Math.abs(wave) * 200),
        });
    }

    return data;
}

describe("new strategy lib smoke checks", () => {
    it("keeps default parameter contracts aligned", () => {
        for (const strategy of strategies) {
            expect(Object.keys(strategy.paramLabels)).to.deep.equal(Object.keys(strategy.defaultParams));
            expect(strategy.metadata?.walkForwardParams ?? []).to.deep.equal(Object.keys(strategy.defaultParams));
            expect(strategy.normalizeParams?.(strategy.defaultParams) ?? strategy.defaultParams).to.deep.equal(strategy.defaultParams);
        }
    });

    it("executes each strategy with default params without throwing", () => {
        const data = buildSampleData(220);
        for (const strategy of strategies) {
            const signals = strategy.execute(data, strategy.defaultParams);
            expect(signals).to.be.an("array");
            for (const signal of signals) {
                expect(signal.type === "buy" || signal.type === "sell").to.equal(true);
                expect(signal.barIndex).to.be.a("number");
            }
        }
    });
});
