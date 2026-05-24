export type PolymarketExitMode = "resolve_hold" | "signal_exit_same_event" | "chart_exit_same_event";

export function resolvePolymarketExitMode(value: unknown, fallback: PolymarketExitMode = "resolve_hold"): PolymarketExitMode {
    if (typeof value !== "string") {
        return fallback;
    }
    const normalized = value.trim().toLowerCase();
    return normalized === "signal_exit_same_event" || normalized === "chart_exit_same_event" || normalized === "resolve_hold"
        ? normalized
        : fallback;
}

export function isPolymarketOneSecondSignalExitExecutionModel(executionModel?: string): boolean {
    return executionModel === "signal_close" || executionModel === "next_open" || executionModel === "next_close";
}

export function resolveEffectivePolymarketExitMode(args: {
    requestedMode?: PolymarketExitMode;
    interval: string;
    executionModel?: string;
    polymarketAnnotationEnabled?: boolean;
}): PolymarketExitMode {
    const { requestedMode, interval, executionModel, polymarketAnnotationEnabled } = args;
    const requested = resolvePolymarketExitMode(requestedMode);
    const normalizedInterval = interval.trim().toLowerCase();

    if (!polymarketAnnotationEnabled) {
        return "resolve_hold";
    }

    if (normalizedInterval === "1s") {
        return isSameEventPolymarketExitMode(requested)
            && isPolymarketOneSecondSignalExitExecutionModel(executionModel)
            ? requested
            : "resolve_hold";
    }

    if (!isSameEventPolymarketExitMode(requested)) {
        return requested;
    }

    if (normalizedInterval !== "1m") {
        return "resolve_hold";
    }

    if (executionModel !== "next_open") {
        return "resolve_hold";
    }

    return requested;
}

export function isSignalExitSameEventMode(mode: PolymarketExitMode | undefined): boolean {
    return mode === "signal_exit_same_event";
}

export function isChartExitSameEventMode(mode: PolymarketExitMode | undefined): boolean {
    return mode === "chart_exit_same_event";
}

export function isSameEventPolymarketExitMode(mode: PolymarketExitMode | undefined): boolean {
    return mode === "signal_exit_same_event" || mode === "chart_exit_same_event";
}

export const SAME_EVENT_SUPPORTED_RANK_MODES = new Set([
    "expectancy",
    "expectancyTrades",
    "profitFactor",
    "profitFactorTrades",
    "sizedNet",
] as const);

export type SameEventSupportedRankMode = typeof SAME_EVENT_SUPPORTED_RANK_MODES extends Set<infer T>
    ? T
    : never;
