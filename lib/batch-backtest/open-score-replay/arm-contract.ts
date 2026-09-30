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
} as const;

export type ReplayArmField = keyof typeof REPLAY_ARM_TO_FINDER_ARM;
export type FinderArmField = (typeof REPLAY_ARM_TO_FINDER_ARM)[ReplayArmField];

export const REPLAY_ARM_FIELDS = Object.freeze(
    Object.keys(REPLAY_ARM_TO_FINDER_ARM) as ReplayArmField[],
);

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
