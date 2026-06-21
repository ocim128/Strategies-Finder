import type { StrategyConfig } from "../settings-manager";

export interface SharedChartContext {
    symbol: string;
    interval: string;
}

export interface SharedSyntheticApplyPlan {
    suppressCount: number;
    nextSymbol: string;
    nextInterval: string;
    syntheticPair: StrategyConfig["syntheticPair"] | null;
}

export function buildSharedSyntheticApplyPlan(args: {
    config: Pick<StrategyConfig, "syntheticPair">;
    currentSymbol: string;
    currentInterval: string;
    context: SharedChartContext;
}): SharedSyntheticApplyPlan {
    const willChangeSymbol = args.currentSymbol !== args.context.symbol;
    const willChangeInterval = args.currentInterval !== args.context.interval;
    return {
        suppressCount: args.config.syntheticPair
            ? (willChangeSymbol ? 1 : 0) + (willChangeInterval ? 1 : 0)
            : 0,
        nextSymbol: args.context.symbol,
        nextInterval: args.context.interval,
        syntheticPair: args.config.syntheticPair ?? null,
    };
}
