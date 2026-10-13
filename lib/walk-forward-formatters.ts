import type { StrategyParams } from "./strategies/index";

export type WalkForwardBaseParamsSnapshot = {
    strategyKey: string;
    params: StrategyParams;
} | null;

export function formatWalkForwardParamValue(value: number): string {
    if (!Number.isFinite(value)) return String(value);
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(3).replace(/\.?0+$/, "");
}

export function formatWalkForwardBaseParamsSummary(snapshot: WalkForwardBaseParamsSnapshot): string | null {
    if (!snapshot) return null;
    return formatWalkForwardWindowParams(snapshot.params) || null;
}

export function formatWalkForwardWindowParams(params: StrategyParams): string {
    return Object.entries(params)
        .map(([key, value]) => `${key}:${formatWalkForwardParamValue(value)}`)
        .join(", ");
}

export function formatWalkForwardSignedPercent(value: number | null): string {
    if (!Number.isFinite(value)) return "-";
    const n = Number(value);
    const sign = n >= 0 ? "+" : "";
    return `${sign}${n.toFixed(2)}%`;
}
