export const POLYMARKET_OUTCOME_INTERVALS = ["5m", "15m", "1h"] as const;

export type PolymarketOutcomeInterval = typeof POLYMARKET_OUTCOME_INTERVALS[number];

export const DEFAULT_POLYMARKET_OUTCOME_INTERVAL: PolymarketOutcomeInterval = "5m";

export const POLYMARKET_OUTCOME_INTERVAL_DURATION_SEC: Record<PolymarketOutcomeInterval, number> = {
    "5m": 300,
    "15m": 900,
    "1h": 3600,
};

export function resolvePolymarketOutcomeInterval(value: unknown): PolymarketOutcomeInterval {
    if (typeof value !== "string") {
        return DEFAULT_POLYMARKET_OUTCOME_INTERVAL;
    }
    const normalized = value.trim().toLowerCase();
    return POLYMARKET_OUTCOME_INTERVALS.includes(normalized as PolymarketOutcomeInterval)
        ? normalized as PolymarketOutcomeInterval
        : DEFAULT_POLYMARKET_OUTCOME_INTERVAL;
}

export function getPolymarketOutcomeIntervalDurationSec(interval: PolymarketOutcomeInterval): number {
    return POLYMARKET_OUTCOME_INTERVAL_DURATION_SEC[interval];
}
