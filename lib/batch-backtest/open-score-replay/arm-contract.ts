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
    topStableSupport: "TOP_STABLE_SUPPORT",
    topFreshSupport: "TOP_FRESH_SUPPORT",
} as const;

export type ReplayArmField = keyof typeof REPLAY_ARM_TO_FINDER_ARM;
export type FinderArmField = (typeof REPLAY_ARM_TO_FINDER_ARM)[ReplayArmField];

export const REPLAY_ARM_FIELDS = Object.freeze(
    Object.keys(REPLAY_ARM_TO_FINDER_ARM) as ReplayArmField[],
);

export const CAUSAL_ARM_FIELDS = ["topStableSupport", "topFreshSupport"] as const;
export type CausalArmField = typeof CAUSAL_ARM_FIELDS[number];
export type LegacyArmField = Exclude<ReplayArmField, CausalArmField>;
export type ReplayArmResults<T> = Record<LegacyArmField, T> & Partial<Record<CausalArmField, T>>;
export const LEGACY_REPLAY_ARM_FIELDS = REPLAY_ARM_FIELDS.filter((field): field is LegacyArmField => !CAUSAL_ARM_FIELDS.includes(field as CausalArmField));
export const replayArmFields = (enabled?: boolean): readonly ReplayArmField[] => enabled ? REPLAY_ARM_FIELDS : LEGACY_REPLAY_ARM_FIELDS;
export const isCausalArm = (field: ReplayArmField): field is CausalArmField => CAUSAL_ARM_FIELDS.includes(field as CausalArmField);

/** Directional positions require the non-overlapping Hold until switch path. */
export type AssetSwitchArmField = ReplayArmField | "topRawDirectional";
export const RAW_DIRECTIONAL_MINIMUM_FRACTION = 0.25;
export const ASSET_SWITCH_ARM_FIELDS: readonly AssetSwitchArmField[] = [...REPLAY_ARM_FIELDS, "topRawDirectional"];
export const assetSwitchArmFields = (enabled?: boolean, directional = true): readonly AssetSwitchArmField[] => directional ? [...replayArmFields(enabled), "topRawDirectional"] : replayArmFields(enabled);

/** Backward-compatible activity check for result summaries created before decisionCount was persisted. */
export function hasAssetSwitchDecisionEvents(summary: {
    decisionCount?: unknown;
    arms?: Partial<Record<AssetSwitchArmField, { enteredCount?: unknown; completedTrades?: unknown }>>;
}): boolean {
    if (typeof summary.decisionCount === "number" && Number.isFinite(summary.decisionCount) && summary.decisionCount > 0) return true;
    return ASSET_SWITCH_ARM_FIELDS.some((arm) => {
        const metrics = summary.arms?.[arm];
        return (typeof metrics?.enteredCount === "number" && metrics.enteredCount > 0)
            || (typeof metrics?.completedTrades === "number" && metrics.completedTrades > 0);
    });
}
