import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { median_distance_bar_rejection } from "../../lib/strategies/lib/median_distance_bar_rejection";
import { return_sign_streak_fade } from "../../lib/strategies/lib/return_sign_streak_fade";
import { cumulative_return_percentile_reversion } from "../../lib/strategies/lib/cumulative_return_percentile_reversion";
import { return_zscore_extreme_reversion } from "../../lib/strategies/lib/return_zscore_extreme_reversion";
import { body_proportion_percentile_fade } from "../../lib/strategies/lib/body_proportion_percentile_fade";
import { return_reversal_count_reversion } from "../../lib/strategies/lib/return_reversal_count_reversion";
import { decay_pressure_percentile_reversion } from "../../lib/strategies/lib/decay_pressure_percentile_reversion";
import { close_location_streak_mean_reversion } from "../../lib/strategies/lib/close_location_streak_mean_reversion";
import { median_crossing_frequency_fade } from "../../lib/strategies/lib/median_crossing_frequency_fade";
import { volatility_zscore_reversion_trigger } from "../../lib/strategies/lib/volatility_zscore_reversion_trigger";
import { volatility_percentile_reversion_fade } from "../../lib/strategies/lib/volatility_percentile_reversion_fade";
import { range_volatility_divergence_fade } from "../../lib/strategies/lib/range_volatility_divergence_fade";
import { volatility_breakout_follow } from "../../lib/strategies/lib/volatility_breakout_follow";
import { historical_volatility_envelope_fade } from "../../lib/strategies/lib/historical_volatility_envelope_fade";
import { atr_normalized_range_reversion } from "../../lib/strategies/lib/atr_normalized_range_reversion";
import { volatility_skewness_exhaustion } from "../../lib/strategies/lib/volatility_skewness_exhaustion";
import { volatility_gated_close_acceptance } from "../../lib/strategies/lib/volatility_gated_close_acceptance";
import { volatility_autocorrelation_gated_reversion } from "../../lib/strategies/lib/volatility_autocorrelation_gated_reversion";
import { compression_ratio_expansion_reversion } from "../../lib/strategies/lib/compression_ratio_expansion_reversion";
import { volatility_weighted_momentum_autocorrelation } from "../../lib/strategies/lib/volatility_weighted_momentum_autocorrelation";
import { entropy_decay_momentum_acceleration } from "../../lib/strategies/lib/entropy_decay_momentum_acceleration";
import { initiative_pressure_acceleration_follow } from "../../lib/strategies/lib/initiative_pressure_acceleration_follow";
import { close_acceptance_decay_weighted_drift } from "../../lib/strategies/lib/close_acceptance_decay_weighted_drift";
import { skewness_reversal_momentum_ignite } from "../../lib/strategies/lib/skewness_reversal_momentum_ignite";
import { range_efficiency_regime_ignition } from "../../lib/strategies/lib/range_efficiency_regime_ignition";
import { volume_correlation_trend_follow } from "../../lib/strategies/lib/volume_correlation_trend_follow";
import { atr_adjusted_streak_momentum } from "../../lib/strategies/lib/atr_adjusted_streak_momentum";
import { autocorrelation_crossover_momentum } from "../../lib/strategies/lib/autocorrelation_crossover_momentum";
import { wick_imbalance_thrust_continuation } from "../../lib/strategies/lib/wick_imbalance_thrust_continuation";

// Generate a dummy dataset of synthetic ratio bars (scale-invariant)
function generateMockData(length = 100): OHLCVData[] {
    const data: OHLCVData[] = [];
    let price = 100.0;
    const startTime = 1700000000;

    for (let i = 0; i < length; i++) {
        // Create an oscillating pattern with occasional outliers
        const change = Math.sin(i * 0.5) * 2.0 + (i % 15 === 0 ? 5.0 : 0) - (i % 20 === 0 ? 6.0 : 0);
        const open = price;
        const close = price + change;
        const high = Math.max(open, close) + 0.5;
        const low = Math.min(open, close) - 0.5;
        data.push({
            time: (startTime + i * 3600) as Time,
            open,
            high,
            low,
            close,
            volume: 100 + (i % 10) * 10,
        });
        price = close;
    }
    return data;
}

describe("Synthetic Ratio Strategies Smoke Tests", () => {
    const mockData = generateMockData(120);

    it("median_distance_bar_rejection executes and normalizes", () => {
        expect(median_distance_bar_rejection.name).to.equal("Median Distance Bar Rejection");
        const signals = median_distance_bar_rejection.execute(mockData, median_distance_bar_rejection.defaultParams);
        expect(signals).to.be.an("array");
        const norm = median_distance_bar_rejection.normalizeParams({ lookback: "10.5", zscoreThreshold: "2.5" });
        expect(norm.lookback).to.equal(11);
        expect(norm.zscoreThreshold).to.equal(2.5);
    });

    it("return_sign_streak_fade executes and normalizes", () => {
        expect(return_sign_streak_fade.name).to.equal("Return Sign Streak Fade");
        const signals = return_sign_streak_fade.execute(mockData, return_sign_streak_fade.defaultParams);
        expect(signals).to.be.an("array");
        const norm = return_sign_streak_fade.normalizeParams({ lookback: "3.2", streakMin: "4.7" });
        expect(norm.lookback).to.equal(3);
        expect(norm.streakMin).to.equal(5);
    });

    it("cumulative_return_percentile_reversion executes and normalizes", () => {
        expect(cumulative_return_percentile_reversion.name).to.equal("Cumulative Return Percentile Reversion");
        const signals = cumulative_return_percentile_reversion.execute(mockData, cumulative_return_percentile_reversion.defaultParams);
        expect(signals).to.be.an("array");
        const norm = cumulative_return_percentile_reversion.normalizeParams({ lookback: "20.1", pctlExtreme: "0.95" });
        expect(norm.lookback).to.equal(20);
        expect(norm.pctlExtreme).to.equal(0.95);
    });

    it("return_zscore_extreme_reversion executes and normalizes", () => {
        expect(return_zscore_extreme_reversion.name).to.equal("Return Z-Score Extreme Reversion");
        const signals = return_zscore_extreme_reversion.execute(mockData, return_zscore_extreme_reversion.defaultParams);
        expect(signals).to.be.an("array");
        const norm = return_zscore_extreme_reversion.normalizeParams({ lookback: "15", zscoreThreshold: "2.2" });
        expect(norm.lookback).to.equal(15);
        expect(norm.zscoreThreshold).to.equal(2.2);
    });

    it("body_proportion_percentile_fade executes and normalizes", () => {
        expect(body_proportion_percentile_fade.name).to.equal("Body Proportion Percentile Fade");
        const signals = body_proportion_percentile_fade.execute(mockData, body_proportion_percentile_fade.defaultParams);
        expect(signals).to.be.an("array");
        const norm = body_proportion_percentile_fade.normalizeParams({ lookback: "25", pctlExtreme: "0.80" });
        expect(norm.lookback).to.equal(25);
        expect(norm.pctlExtreme).to.equal(0.80);
    });

    it("return_reversal_count_reversion executes and normalizes", () => {
        expect(return_reversal_count_reversion.name).to.equal("Return Reversal Count Reversion");
        const signals = return_reversal_count_reversion.execute(mockData, return_reversal_count_reversion.defaultParams);
        expect(signals).to.be.an("array");
        const norm = return_reversal_count_reversion.normalizeParams({ lookback: "15.4", crossingMin: "8" });
        expect(norm.lookback).to.equal(15);
        expect(norm.crossingMin).to.equal(8);
    });

    it("decay_pressure_percentile_reversion executes and normalizes", () => {
        expect(decay_pressure_percentile_reversion.name).to.equal("Decay Pressure Percentile Reversion");
        const signals = decay_pressure_percentile_reversion.execute(mockData, decay_pressure_percentile_reversion.defaultParams);
        expect(signals).to.be.an("array");
        const norm = decay_pressure_percentile_reversion.normalizeParams({ lookback: "35", pctlExtreme: "0.88" });
        expect(norm.lookback).to.equal(35);
        expect(norm.pctlExtreme).to.equal(0.88);
    });

    it("close_location_streak_mean_reversion executes and normalizes", () => {
        expect(close_location_streak_mean_reversion.name).to.equal("Close Location Streak Mean Reversion");
        const signals = close_location_streak_mean_reversion.execute(mockData, close_location_streak_mean_reversion.defaultParams);
        expect(signals).to.be.an("array");
        const norm = close_location_streak_mean_reversion.normalizeParams({ lookback: "4", streakMin: "4" });
        expect(norm.lookback).to.equal(4);
        expect(norm.streakMin).to.equal(4);
    });

    it("median_crossing_frequency_fade executes and normalizes", () => {
        expect(median_crossing_frequency_fade.name).to.equal("Median Crossing Frequency Fade");
        const signals = median_crossing_frequency_fade.execute(mockData, median_crossing_frequency_fade.defaultParams);
        expect(signals).to.be.an("array");
        const norm = median_crossing_frequency_fade.normalizeParams({ lookback: "25", crossingMin: "6" });
        expect(norm.lookback).to.equal(25);
        expect(norm.crossingMin).to.equal(6);
    });

    it("volatility_zscore_reversion_trigger executes and normalizes", () => {
        expect(volatility_zscore_reversion_trigger.name).to.equal("Volatility Z-Score Reversion Trigger");
        const signals = volatility_zscore_reversion_trigger.execute(mockData, volatility_zscore_reversion_trigger.defaultParams);
        expect(signals).to.be.an("array");
        const norm = volatility_zscore_reversion_trigger.normalizeParams({ lookback: "25", volZThreshold: "2.3" });
        expect(norm.lookback).to.equal(25);
        expect(norm.volZThreshold).to.equal(2.3);
    });

    it("volatility_percentile_reversion_fade executes and normalizes", () => {
        expect(volatility_percentile_reversion_fade.name).to.equal("Volatility Percentile Reversion Fade");
        const signals = volatility_percentile_reversion_fade.execute(mockData, volatility_percentile_reversion_fade.defaultParams);
        expect(signals).to.be.an("array");
        const norm = volatility_percentile_reversion_fade.normalizeParams({ lookback: "30", volThreshold: "0.85", zThreshold: "1.9" });
        expect(norm.lookback).to.equal(30);
        expect(norm.volThreshold).to.equal(0.85);
        expect(norm.zThreshold).to.equal(1.9);
    });

    it("range_volatility_divergence_fade executes and normalizes", () => {
        expect(range_volatility_divergence_fade.name).to.equal("Range Volatility Divergence Fade");
        const signals = range_volatility_divergence_fade.execute(mockData, range_volatility_divergence_fade.defaultParams);
        expect(signals).to.be.an("array");
        const norm = range_volatility_divergence_fade.normalizeParams({ lookback: "25", rangePctThreshold: "0.90", maxVolPercentile: "0.35" });
        expect(norm.lookback).to.equal(25);
        expect(norm.rangePctThreshold).to.equal(0.90);
        expect(norm.maxVolPercentile).to.equal(0.35);
    });

    it("volatility_breakout_follow executes and normalizes", () => {
        expect(volatility_breakout_follow.name).to.equal("Volatility Breakout Follow");
        const signals = volatility_breakout_follow.execute(mockData, volatility_breakout_follow.defaultParams);
        expect(signals).to.be.an("array");
        const norm = volatility_breakout_follow.normalizeParams({ lookback: "25", zThreshold: "1.9" });
        expect(norm.lookback).to.equal(25);
        expect(norm.zThreshold).to.equal(1.9);
    });

    it("historical_volatility_envelope_fade executes and normalizes", () => {
        expect(historical_volatility_envelope_fade.name).to.equal("Historical Volatility Envelope Fade");
        const signals = historical_volatility_envelope_fade.execute(mockData, historical_volatility_envelope_fade.defaultParams);
        expect(signals).to.be.an("array");
        const norm = historical_volatility_envelope_fade.normalizeParams({ lookback: "25", multiplier: "2.5" });
        expect(norm.lookback).to.equal(25);
        expect(norm.multiplier).to.equal(2.5);
    });

    it("atr_normalized_range_reversion executes and normalizes", () => {
        expect(atr_normalized_range_reversion.name).to.equal("ATR Normalized Range Reversion");
        const signals = atr_normalized_range_reversion.execute(mockData, atr_normalized_range_reversion.defaultParams);
        expect(signals).to.be.an("array");
        const norm = atr_normalized_range_reversion.normalizeParams({ lookback: "20", shockPercentile: "0.95" });
        expect(norm.lookback).to.equal(20);
        expect(norm.shockPercentile).to.equal(0.95);
    });

    it("volatility_skewness_exhaustion executes and normalizes", () => {
        expect(volatility_skewness_exhaustion.name).to.equal("Volatility Skewness Exhaustion");
        const signals = volatility_skewness_exhaustion.execute(mockData, volatility_skewness_exhaustion.defaultParams);
        expect(signals).to.be.an("array");
        const norm = volatility_skewness_exhaustion.normalizeParams({ lookback: "35", skewThreshold: "1.8" });
        expect(norm.lookback).to.equal(35);
        expect(norm.skewThreshold).to.equal(1.8);
    });

    it("volatility_gated_close_acceptance executes and normalizes", () => {
        expect(volatility_gated_close_acceptance.name).to.equal("Volatility Gated Close Acceptance");
        const signals = volatility_gated_close_acceptance.execute(mockData, volatility_gated_close_acceptance.defaultParams);
        expect(signals).to.be.an("array");
        const norm = volatility_gated_close_acceptance.normalizeParams({ lookback: "25", maxVolPercentile: "0.30", acceptanceThreshold: "0.75" });
        expect(norm.lookback).to.equal(25);
        expect(norm.maxVolPercentile).to.equal(0.30);
        expect(norm.acceptanceThreshold).to.equal(0.75);
    });

    it("volatility_autocorrelation_gated_reversion executes and normalizes", () => {
        expect(volatility_autocorrelation_gated_reversion.name).to.equal("Volatility Autocorrelation Gated Reversion");
        const signals = volatility_autocorrelation_gated_reversion.execute(mockData, volatility_autocorrelation_gated_reversion.defaultParams);
        expect(signals).to.be.an("array");
        const norm = volatility_autocorrelation_gated_reversion.normalizeParams({ lookback: "30", acThreshold: "0.25", zThreshold: "1.8" });
        expect(norm.lookback).to.equal(30);
        expect(norm.acThreshold).to.equal(0.25);
        expect(norm.zThreshold).to.equal(1.8);
    });

    it("compression_ratio_expansion_reversion executes and normalizes", () => {
        expect(compression_ratio_expansion_reversion.name).to.equal("Compression Ratio Expansion Reversion");
        const signals = compression_ratio_expansion_reversion.execute(mockData, compression_ratio_expansion_reversion.defaultParams);
        expect(signals).to.be.an("array");
        const norm = compression_ratio_expansion_reversion.normalizeParams({ lookback: "25", compressThreshold: "0.25", rangePercentileMin: "0.75" });
        expect(norm.lookback).to.equal(25);
        expect(norm.compressThreshold).to.equal(0.25);
        expect(norm.rangePercentileMin).to.equal(0.75);
    });

    it("volatility_weighted_momentum_autocorrelation executes and normalizes", () => {
        expect(volatility_weighted_momentum_autocorrelation.name).to.equal("Volatility-Weighted Momentum Autocorrelation");
        const signals = volatility_weighted_momentum_autocorrelation.execute(mockData, volatility_weighted_momentum_autocorrelation.defaultParams);
        expect(signals).to.be.an("array");
        const norm = volatility_weighted_momentum_autocorrelation.normalizeParams({ lookback: "25", minAutoCorr: "0.3" });
        expect(norm.lookback).to.equal(25);
        expect(norm.minAutoCorr).to.equal(0.3);
    });

    it("entropy_decay_momentum_acceleration executes and normalizes", () => {
        expect(entropy_decay_momentum_acceleration.name).to.equal("Entropy Decay Momentum Acceleration");
        const signals = entropy_decay_momentum_acceleration.execute(mockData, entropy_decay_momentum_acceleration.defaultParams);
        expect(signals).to.be.an("array");
        const norm = entropy_decay_momentum_acceleration.normalizeParams({ lookback: "25", entropyPercentileMax: "0.25" });
        expect(norm.lookback).to.equal(25);
        expect(norm.entropyPercentileMax).to.equal(0.25);
    });

    it("initiative_pressure_acceleration_follow executes and normalizes", () => {
        expect(initiative_pressure_acceleration_follow.name).to.equal("Initiative Pressure Acceleration Follow");
        const signals = initiative_pressure_acceleration_follow.execute(mockData, initiative_pressure_acceleration_follow.defaultParams);
        expect(signals).to.be.an("array");
        const norm = initiative_pressure_acceleration_follow.normalizeParams({ lookback: "30", accThreshold: "0.35" });
        expect(norm.lookback).to.equal(30);
        expect(norm.accThreshold).to.equal(0.35);
    });

    it("close_acceptance_decay_weighted_drift executes and normalizes", () => {
        expect(close_acceptance_decay_weighted_drift.name).to.equal("Close Acceptance Decay Weighted Drift");
        const signals = close_acceptance_decay_weighted_drift.execute(mockData, close_acceptance_decay_weighted_drift.defaultParams);
        expect(signals).to.be.an("array");
        const norm = close_acceptance_decay_weighted_drift.normalizeParams({ lookback: "20", decayFactor: "0.80" });
        expect(norm.lookback).to.equal(20);
        expect(norm.decayFactor).to.equal(0.80);
    });

    it("skewness_reversal_momentum_ignite executes and normalizes", () => {
        expect(skewness_reversal_momentum_ignite.name).to.equal("Skewness Reversal Momentum Ignite");
        const signals = skewness_reversal_momentum_ignite.execute(mockData, skewness_reversal_momentum_ignite.defaultParams);
        expect(signals).to.be.an("array");
        const norm = skewness_reversal_momentum_ignite.normalizeParams({ lookback: "35", skewChange: "0.90" });
        expect(norm.lookback).to.equal(35);
        expect(norm.skewChange).to.equal(0.90);
    });

    it("range_efficiency_regime_ignition executes and normalizes", () => {
        expect(range_efficiency_regime_ignition.name).to.equal("Range Efficiency Regime Ignition");
        const signals = range_efficiency_regime_ignition.execute(mockData, range_efficiency_regime_ignition.defaultParams);
        expect(signals).to.be.an("array");
        const norm = range_efficiency_regime_ignition.normalizeParams({ lookback: "25", efficiencyMin: "0.55", rangePercentileMin: "0.80" });
        expect(norm.lookback).to.equal(25);
        expect(norm.efficiencyMin).to.equal(0.55);
        expect(norm.rangePercentileMin).to.equal(0.80);
    });

    it("volume_correlation_trend_follow executes and normalizes", () => {
        expect(volume_correlation_trend_follow.name).to.equal("Volume Correlation Trend Follow");
        const signals = volume_correlation_trend_follow.execute(mockData, volume_correlation_trend_follow.defaultParams);
        expect(signals).to.be.an("array");
        const norm = volume_correlation_trend_follow.normalizeParams({ lookback: "25", correlationThreshold: "0.40" });
        expect(norm.lookback).to.equal(25);
        expect(norm.correlationThreshold).to.equal(0.40);
    });

    it("atr_adjusted_streak_momentum executes and normalizes", () => {
        expect(atr_adjusted_streak_momentum.name).to.equal("ATR Adjusted Streak Momentum");
        const signals = atr_adjusted_streak_momentum.execute(mockData, atr_adjusted_streak_momentum.defaultParams);
        expect(signals).to.be.an("array");
        const norm = atr_adjusted_streak_momentum.normalizeParams({ lookback: "20", minStreak: "4" });
        expect(norm.lookback).to.equal(20);
        expect(norm.minStreak).to.equal(4);
    });

    it("autocorrelation_crossover_momentum executes and normalizes", () => {
        expect(autocorrelation_crossover_momentum.name).to.equal("Autocorrelation Crossover Momentum");
        const signals = autocorrelation_crossover_momentum.execute(mockData, autocorrelation_crossover_momentum.defaultParams);
        expect(signals).to.be.an("array");
        const norm = autocorrelation_crossover_momentum.normalizeParams({ shortLookback: "12", longLookback: "40" });
        expect(norm.shortLookback).to.equal(12);
        expect(norm.longLookback).to.equal(40);
    });

    it("wick_imbalance_thrust_continuation executes and normalizes", () => {
        expect(wick_imbalance_thrust_continuation.name).to.equal("Wick Imbalance Thrust Continuation");
        const signals = wick_imbalance_thrust_continuation.execute(mockData, wick_imbalance_thrust_continuation.defaultParams);
        expect(signals).to.be.an("array");
        const norm = wick_imbalance_thrust_continuation.normalizeParams({ lookback: "25", maxWickPercentile: "0.30", rocZThreshold: "1.5" });
        expect(norm.lookback).to.equal(25);
        expect(norm.maxWickPercentile).to.equal(0.30);
        expect(norm.rocZThreshold).to.equal(1.5);
    });
});
