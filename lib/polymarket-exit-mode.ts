export type PolymarketExitMode = "resolve_hold" | "signal_exit_same_event";

export function resolveEffectivePolymarketExitMode(args: {
    requestedMode?: PolymarketExitMode;
    interval: string;
    executionModel?: string;
    polymarketAnnotationEnabled?: boolean;
}): PolymarketExitMode {
    const { requestedMode, interval, executionModel, polymarketAnnotationEnabled } = args;

    if (!polymarketAnnotationEnabled) {
        return "resolve_hold";
    }

    if (requestedMode !== "signal_exit_same_event") {
        return requestedMode ?? "resolve_hold";
    }

    if (interval !== "1m") {
        return "resolve_hold";
    }

    if (executionModel !== "next_open") {
        return "resolve_hold";
    }

    return "signal_exit_same_event";
}

export function isSignalExitSameEventMode(mode: PolymarketExitMode | undefined): boolean {
    return mode === "signal_exit_same_event";
}

export const SIGNAL_EXIT_SUPPORTED_RANK_MODES = new Set([
    "expectancy",
    "expectancyTrades",
    "profitFactor",
    "profitFactorTrades",
    "sizedNet",
] as const);

export type SignalExitSupportedRankMode = typeof SIGNAL_EXIT_SUPPORTED_RANK_MODES extends Set<infer T>
    ? T
    : never;
