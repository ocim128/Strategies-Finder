/** Canonical public ordering and cross-panel mapping for replay arms. */
export const REPLAY_ARM_TO_FINDER_ARM = {
    topRawProfitNow: "TOP_RAW_PROFIT_NOW",
    topMeanProfitNow: "TOP_MEAN_PROFIT_NOW",
    topRawProfitNowConf: "TOP_RAW_PROFIT_NOW_CONF",
    topZ: "TOP_Z",
    topRaw: "TOP_RAW",
    topMean: "TOP_MEAN",
    topMeanRawUnique: "TOP_MEAN_RAW_UNIQUE",
    topRawProfit: "TOP_RAW_PROFIT",
    topMeanProfit: "TOP_MEAN_PROFIT",
    botRawProfitNow: "BOT_RAW_PROFIT_NOW",
    botMeanProfitNow: "BOT_MEAN_PROFIT_NOW",
    botZ: "BOT_Z",
    botRaw: "BOT_RAW",
    botMean: "BOT_MEAN",
    botMeanRawUnique: "BOT_MEAN_RAW_UNIQUE",
    topCoverage: "TOP_COVERAGE",
    topStableSupport: "TOP_STABLE_SUPPORT",
    topFreshSupport: "TOP_FRESH_SUPPORT",
    topPriceStrength: "TOP_PRICE_STRENGTH",
    topGraphStrength: "TOP_GRAPH_STRENGTH",
} as const;

export type ReplayArmField = keyof typeof REPLAY_ARM_TO_FINDER_ARM;
export type FinderArmField = (typeof REPLAY_ARM_TO_FINDER_ARM)[ReplayArmField];

export const REPLAY_ARM_FIELDS = Object.freeze(
    Object.keys(REPLAY_ARM_TO_FINDER_ARM) as ReplayArmField[],
);

export const CAUSAL_ARM_FIELDS = ["topCoverage", "topStableSupport", "topFreshSupport", "topPriceStrength", "topGraphStrength"] as const;
export type CausalArmField = typeof CAUSAL_ARM_FIELDS[number];
export type LegacyArmField = Exclude<ReplayArmField, CausalArmField>;
export type ReplayArmResults<T> = Record<LegacyArmField, T> & Partial<Record<CausalArmField, T>>;
export const LEGACY_REPLAY_ARM_FIELDS = REPLAY_ARM_FIELDS.filter((field): field is LegacyArmField => !CAUSAL_ARM_FIELDS.includes(field as CausalArmField));
export const replayArmFields = (enabled?: boolean): readonly ReplayArmField[] => enabled ? REPLAY_ARM_FIELDS : LEGACY_REPLAY_ARM_FIELDS;
export const isCausalArm = (field: ReplayArmField): field is CausalArmField => CAUSAL_ARM_FIELDS.includes(field as CausalArmField);

/** Backward-compatible activity check for result summaries created before decisionCount was persisted. */
export function hasAssetSwitchDecisionEvents(summary: {
    decisionCount?: unknown;
    arms?: Partial<Record<ReplayArmField, { enteredCount?: unknown; completedTrades?: unknown }>>;
}): boolean {
    if (typeof summary.decisionCount === "number" && Number.isFinite(summary.decisionCount) && summary.decisionCount > 0) return true;
    return REPLAY_ARM_FIELDS.some((arm) => {
        const metrics = summary.arms?.[arm];
        return (typeof metrics?.enteredCount === "number" && metrics.enteredCount > 0)
            || (typeof metrics?.completedTrades === "number" && metrics.completedTrades > 0);
    });
}
