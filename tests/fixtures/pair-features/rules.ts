import type { PairSelectionRule } from "../../../lib/pair-selection/types";
import { scoreByFeature } from "./scoring";

export const spreadId = "feat_fp_spread_log_return_b12_r1";
export const tradeId = "feat_fp_trade_mean_net_pct_t8_r1";
const sourceFiles = ["tests/fixtures/pair-features/rules.ts", "tests/fixtures/pair-features/scoring.ts"];

export function makeFeatureRule(key: string, columns: readonly string[]): PairSelectionRule {
    return {
        key,
        name: key,
        description: key,
        defaultParams: {},
        paramLabels: {},
        metadata: { featureRequirements: { libraryRelease: "v1", columns }, sourceFiles },
        score: (candidate) => scoreByFeature(candidate, columns[0]!),
    };
}

export const spreadRule: PairSelectionRule = {
    key: "fixture_feature_spread",
    name: "FIXTURE_FEATURE_SPREAD",
    description: "Reads the prepared spread feature.",
    defaultParams: {},
    paramLabels: {},
    metadata: { featureRequirements: { libraryRelease: "v0", columns: [spreadId] }, sourceFiles },
    score: (candidate) => scoreByFeature(candidate, spreadId),
};

export const tradeRule: PairSelectionRule = {
    key: "fixture_feature_trade",
    name: "FIXTURE_FEATURE_TRADE",
    description: "Reads the prepared trade feature and its count.",
    defaultParams: {},
    paramLabels: {},
    metadata: { featureRequirements: { libraryRelease: "v0", columns: [tradeId, `${tradeId}_n`] }, sourceFiles },
    score: (candidate) => scoreByFeature(candidate, tradeId),
};

export const nullableTradeRule: PairSelectionRule = {
    ...tradeRule,
    key: "fixture_feature_trade_nullable",
    name: "FIXTURE_FEATURE_TRADE_NULLABLE",
    score: (candidate) => candidate[tradeId] === null ? Number.NEGATIVE_INFINITY : scoreByFeature(candidate, tradeId),
};
