import releaseJson from "./releases/v0.json";
import { computeSpreadLogReturn } from "./families/spread";
import { computeTradeMeanNetPct } from "./families/trades";
import type {
    PairFeatureDefinition,
    PairFeatureEvaluationContext,
    PairFeatureEvaluationResult,
    PairFeatureRelease,
} from "./types";

export const V0_RELEASE = releaseJson as unknown as PairFeatureRelease;

export interface PairFeatureCatalogEntry {
    definition: PairFeatureDefinition;
    evaluate: (context: PairFeatureEvaluationContext) => PairFeatureEvaluationResult;
}

const evaluators: Readonly<Record<string, PairFeatureCatalogEntry["evaluate"]>> = {
    feat_fp_spread_log_return_b12_r1: ({ bars, signalBarIndex }) => computeSpreadLogReturn(bars, signalBarIndex),
    feat_fp_trade_mean_net_pct_t8_r1: ({ signalBarIndex, historicalTrades }) => computeTradeMeanNetPct(
        historicalTrades.filter((trade) => trade.exitBarIndex < signalBarIndex),
    ),
};

export const V0_FEATURE_CATALOG: readonly PairFeatureCatalogEntry[] = V0_RELEASE.definitions.map((definition) => {
    const evaluate = evaluators[definition.id];
    if (!evaluate) throw new Error(`No v0 evaluator is registered for ${definition.id}.`);
    return { definition, evaluate };
});

export function getPairFeatureCatalogEntry(featureId: string): PairFeatureCatalogEntry | null {
    return V0_FEATURE_CATALOG.find((entry) => entry.definition.id === featureId) ?? null;
}
