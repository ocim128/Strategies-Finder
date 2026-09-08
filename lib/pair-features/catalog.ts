import releaseV0Json from "./releases/v0.json";
import releaseV1Json from "./releases/v1.json";
import { computeGrandfatheredIntervalCv, computeGrandfatheredFireCount } from "./families/fires";
import {
    computeAr1HalfLife,
    computeAr1RSquared,
    computeAr1Slope,
    computeGrandfatheredHalfLife,
    computeGrandfatheredReturnAutocorrelation,
    computeGrandfatheredVarianceRatio,
    computeReturnAutocorrelation,
    computeVarianceRatio,
} from "./families/dependence";
import {
    computeGrandfatheredAtrRatio,
    computeGrandfatheredSpreadVolatilityRatio,
    computeAbsoluteReturnAutocorrelation,
    computeDownsideRms as computeReturnDownsideRms,
    computeNormalizedAtr,
    computeReturnStd,
    computeShortLongStdRatio,
    computeUpsideRms,
} from "./families/volatility";
import {
    computeTradeMeanNetPct,
} from "./families/trades";
import {
    computeGrandfatheredDrawdown,
    computeGrandfatheredLosingStreak,
    computeGrandfatheredMedianMae,
    computeTradeDownsideRms,
    computeTradeMeanNetPctV1,
    computeTradeMedianNetPct,
    computeTradeProfitFactor,
    computeTradeWinFraction,
} from "./families/trades-v1";
import {
    computeSpreadLogReturn,
} from "./families/spread";
import {
    computeSpreadDistanceAboveMin as computeSpreadDistanceAboveMinV1,
    computeSpreadDistanceBelowMax as computeSpreadDistanceBelowMaxV1,
    computeSpreadDistanceToMedian as computeSpreadDistanceToMedianV1,
    computeSpreadEfficiency as computeSpreadEfficiencyV1,
    computeSpreadIncrementStreak,
    computeSpreadLogReturnV1,
    computeSpreadOlsSlope,
    computeSpreadZScore,
} from "./families/spread-v1";
import type {
    PairFeatureDefinition,
    PairFeatureEvaluationContext,
    PairFeatureEvaluationResult,
    PairFeatureRelease,
} from "./types";

export const V0_RELEASE = releaseV0Json as unknown as PairFeatureRelease;
export const V1_RELEASE = releaseV1Json as unknown as PairFeatureRelease;
export const PAIR_FEATURE_RELEASES: ReadonlyMap<string, PairFeatureRelease> = new Map([
    [V0_RELEASE.releaseId, V0_RELEASE],
    [V1_RELEASE.releaseId, V1_RELEASE],
]);

export interface PairFeatureCatalogEntry {
    definition: PairFeatureDefinition;
    evaluate: (context: PairFeatureEvaluationContext) => PairFeatureEvaluationResult;
}

const evaluators: Record<string, PairFeatureCatalogEntry["evaluate"]> = {
    feat_fp_spread_log_return_b12_r1: ({ bars, signalBarIndex }) => computeSpreadLogReturn(bars, signalBarIndex),
    feat_fp_trade_mean_net_pct_t8_r1: ({ historicalTrades }) => computeTradeMeanNetPct(historicalTrades),
    feat_pairLosingStreakPrior: ({ historicalTrades }) => computeGrandfatheredLosingStreak(historicalTrades),
    feat_pairDrawdownPctPrior: ({ historicalTrades }) => computeGrandfatheredDrawdown(historicalTrades),
    feat_pairMedianMaePctPrior: ({ bars, historicalTrades }) => computeGrandfatheredMedianMae(bars, historicalTrades),
    feat_spreadReturnAutocorr20: ({ bars, signalBarIndex }) => computeGrandfatheredReturnAutocorrelation(bars, signalBarIndex),
    feat_spreadVarianceRatio5: ({ bars, signalBarIndex }) => computeGrandfatheredVarianceRatio(bars, signalBarIndex),
    feat_spreadHalfLifeBars20: ({ bars, signalBarIndex }) => computeGrandfatheredHalfLife(bars, signalBarIndex),
    feat_atrRatio5Over20: ({ bars, signalBarIndex }) => computeGrandfatheredAtrRatio(bars, signalBarIndex),
    feat_pairSpreadVolatilityRatio5Over20: ({ bars, signalBarIndex }) => computeGrandfatheredSpreadVolatilityRatio(bars, signalBarIndex),
    feat_pairFiresInLast20Bars: ({ historicalEntries, signalBarIndex }) => computeGrandfatheredFireCount(historicalEntries, signalBarIndex),
    feat_pairInterFireIntervalCvPrior: ({ historicalEntries, signalBarIndex }) => computeGrandfatheredIntervalCv(historicalEntries, signalBarIndex),
};

for (const window of [12, 48, 240]) {
    if (window !== 12) evaluators[`feat_fp_spread_log_return_b${window}_r1`] = ({ bars, signalBarIndex }) => computeSpreadLogReturnV1(bars, signalBarIndex, window);
    evaluators[`feat_fp_spread_zscore_b${window}_r1`] = ({ bars, signalBarIndex }) => computeSpreadZScore(bars, signalBarIndex, window);
    evaluators[`feat_fp_spread_distance_to_median_b${window}_r1`] = ({ bars, signalBarIndex }) => computeSpreadDistanceToMedianV1(bars, signalBarIndex, window);
    evaluators[`feat_fp_spread_distance_below_max_b${window}_r1`] = ({ bars, signalBarIndex }) => computeSpreadDistanceBelowMaxV1(bars, signalBarIndex, window);
    evaluators[`feat_fp_spread_distance_above_min_b${window}_r1`] = ({ bars, signalBarIndex }) => computeSpreadDistanceAboveMinV1(bars, signalBarIndex, window);
    evaluators[`feat_fp_spread_ols_slope_b${window}_r2`] = ({ bars, signalBarIndex }) => computeSpreadOlsSlope(bars, signalBarIndex, window);
    evaluators[`feat_fp_spread_efficiency_ratio_b${window}_r1`] = ({ bars, signalBarIndex }) => computeSpreadEfficiencyV1(bars, signalBarIndex, window);
    evaluators[`feat_fp_volatility_return_std_b${window}_r1`] = ({ bars, signalBarIndex }) => computeReturnStd(bars, signalBarIndex, window);
    evaluators[`feat_fp_volatility_downside_rms_b${window}_r1`] = ({ bars, signalBarIndex }) => computeReturnDownsideRms(bars, signalBarIndex, window);
    evaluators[`feat_fp_volatility_upside_rms_b${window}_r1`] = ({ bars, signalBarIndex }) => computeUpsideRms(bars, signalBarIndex, window);
    evaluators[`feat_fp_volatility_normalized_atr_b${window}_r1`] = ({ bars, signalBarIndex }) => computeNormalizedAtr(bars, signalBarIndex, window);
}
for (const [window, suffix] of [[48, "b48"], [240, "b240"]] as const) {
    for (const lag of [1, 4]) {
        evaluators[`feat_fp_dependence_return_acf_${suffix}_l${lag}_r1`] = ({ bars, signalBarIndex }) => computeReturnAutocorrelation(bars, signalBarIndex, window, lag);
    }
    evaluators[`feat_fp_dependence_variance_ratio_${suffix}_h4_r1`] = ({ bars, signalBarIndex }) => computeVarianceRatio(bars, signalBarIndex, window, 4);
}
for (const metric of ["slope", "r_squared", "half_life"] as const) {
    evaluators[`feat_fp_dependence_ar1_${metric}_b48_r1`] = ({ bars, signalBarIndex }) => metric === "slope"
        ? computeAr1Slope(bars, signalBarIndex, 48)
        : metric === "r_squared" ? computeAr1RSquared(bars, signalBarIndex, 48) : computeAr1HalfLife(bars, signalBarIndex, 48);
}
evaluators.feat_fp_spread_up_increment_streak_r1 = ({ bars, signalBarIndex }) => computeSpreadIncrementStreak(bars, signalBarIndex, "up");
evaluators.feat_fp_spread_down_increment_streak_r1 = ({ bars, signalBarIndex }) => computeSpreadIncrementStreak(bars, signalBarIndex, "down");
evaluators.feat_fp_volatility_std_ratio_b12_over_b240_r1 = ({ bars, signalBarIndex }) => computeShortLongStdRatio(bars, signalBarIndex);
evaluators.feat_fp_volatility_abs_return_acf_b48_l1_r1 = ({ bars, signalBarIndex }) => computeAbsoluteReturnAutocorrelation(bars, signalBarIndex, 48);
for (const window of [8, 32, 128]) {
    if (window !== 8) evaluators[`feat_fp_trade_mean_net_pct_t${window}_r1`] = ({ historicalTrades }) => computeTradeMeanNetPctV1(historicalTrades, window);
    evaluators[`feat_fp_trade_median_net_pct_t${window}_r1`] = ({ historicalTrades }) => computeTradeMedianNetPct(historicalTrades, window);
    evaluators[`feat_fp_trade_win_fraction_t${window}_r1`] = ({ historicalTrades }) => computeTradeWinFraction(historicalTrades, window);
    evaluators[`feat_fp_trade_downside_rms_t${window}_r1`] = ({ historicalTrades }) => computeTradeDownsideRms(historicalTrades, window);
    evaluators[`feat_fp_trade_profit_factor_t${window}_r1`] = ({ historicalTrades }) => computeTradeProfitFactor(historicalTrades, window);
}

function catalogForRelease(release: PairFeatureRelease): readonly PairFeatureCatalogEntry[] {
    return release.definitions.map((definition) => {
        const evaluate = evaluators[definition.id];
        if (!evaluate) throw new Error(`No ${release.releaseId} evaluator is registered for ${definition.id}.`);
        return { definition, evaluate };
    });
}

export const V0_FEATURE_CATALOG = catalogForRelease(V0_RELEASE);
// Deferred v2 scope: tails/bar geometry, cross-time changes, history support,
// and closed-trade excursions/duration beyond the initial tranche.
export const V1_FEATURE_CATALOG = catalogForRelease(V1_RELEASE);
const entriesById = new Map<string, PairFeatureCatalogEntry>([
    ...V0_FEATURE_CATALOG,
    ...V1_FEATURE_CATALOG,
].map((entry) => [entry.definition.id, entry] as const));
const entriesByRelease = new Map<string, ReadonlyMap<string, PairFeatureCatalogEntry>>([
    [V0_RELEASE.releaseId, new Map(V0_FEATURE_CATALOG.map((entry) => [entry.definition.id, entry] as const))],
    [V1_RELEASE.releaseId, new Map(V1_FEATURE_CATALOG.map((entry) => [entry.definition.id, entry] as const))],
]);

export function getPairFeatureCatalogEntry(featureId: string): PairFeatureCatalogEntry | null {
    return entriesById.get(featureId) ?? null;
}

export function getPairFeatureCatalogEntryForRelease(libraryRelease: string, featureId: string): PairFeatureCatalogEntry | null {
    return entriesByRelease.get(libraryRelease)?.get(featureId) ?? null;
}

export function getPairFeatureRelease(libraryRelease: string): PairFeatureRelease | null {
    return PAIR_FEATURE_RELEASES.get(libraryRelease) ?? null;
}
