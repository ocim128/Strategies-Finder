/** Dependency-free browser/server wire builder for Batch Trade Gate options. */

export interface TradeGateRunOptions {
    enabled: boolean;
    folderId: string;
    ruleIds: string[];
}

export function buildBatchRunTradeGateBodyField(
    options: TradeGateRunOptions | null | undefined,
): Record<string, unknown> {
    if (!options || options.enabled !== true) return {};
    return {
        tradeGate: {
            enabled: true,
            folderId: options.folderId,
            ruleIds: options.ruleIds,
        },
    };
}
