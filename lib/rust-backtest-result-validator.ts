import type { BacktestResult } from "./types/strategies";

export type RustBacktestResultValidation =
    | { ok: true; result: BacktestResult }
    | { ok: false; reason: "malformed_response"; message: string };

const NUMERIC_FIELDS = [
    "netProfit",
    "netProfitPercent",
    "winRate",
    "expectancy",
    "avgTrade",
    "maxDrawdown",
    "maxDrawdownPercent",
    "avgWin",
    "avgLoss",
    "sharpeRatio",
] as const;

function invalid(message: string): RustBacktestResultValidation {
    return { ok: false, reason: "malformed_response", message };
}

/**
 * Validate and normalize the generic Rust backtest wire result before it can
 * reach renderers or the TypeScript/Rust parity checks.
 */
export function validateRustBacktestResult(value: unknown): RustBacktestResultValidation {
    if (!value || typeof value !== "object") {
        return invalid("Rust backtest result is not an object");
    }

    const raw = value as Record<string, unknown>;
    if (!Array.isArray(raw.trades) || !Array.isArray(raw.equityCurve)) {
        return invalid("Rust backtest result has invalid trades or equityCurve arrays");
    }
    if (!NUMERIC_FIELDS.every((field) => Number.isFinite(raw[field]))) {
        return invalid("Rust backtest result has a non-finite metric");
    }

    const totalTrades = raw.totalTrades;
    const winningTrades = raw.winningTrades;
    const losingTrades = raw.losingTrades;
    if (![totalTrades, winningTrades, losingTrades].every(
        (count) => Number.isInteger(count) && (count as number) >= 0,
    )) {
        return invalid("Rust backtest result has invalid trade counts");
    }
    if ((totalTrades as number) !== (winningTrades as number) + (losingTrades as number)) {
        return invalid("Rust backtest result trade counts do not reconcile");
    }

    const profitFactor = raw.profitFactor;
    let normalizedProfitFactor: number;
    if (profitFactor === null) {
        normalizedProfitFactor = (totalTrades as number) === 0
            ? 0
            : (winningTrades as number) > 0 && (losingTrades as number) === 0
                ? Number.POSITIVE_INFINITY
                : NaN;
    } else if (Number.isFinite(profitFactor) || profitFactor === Number.POSITIVE_INFINITY) {
        normalizedProfitFactor = profitFactor as number;
    } else {
        normalizedProfitFactor = NaN;
    }
    if (!Number.isFinite(normalizedProfitFactor) && normalizedProfitFactor !== Number.POSITIVE_INFINITY) {
        return invalid("Rust backtest result has an invalid profitFactor");
    }

    if ((totalTrades as number) > 0) {
        const expectedWinRate = ((winningTrades as number) / (totalTrades as number)) * 100;
        const expectedAvgTrade = (raw.netProfit as number) / (totalTrades as number);
        const tolerance = Math.max(0.01, Math.abs(expectedAvgTrade) * 0.15);
        if (Math.abs(expectedWinRate - (raw.winRate as number)) > 1) {
            return invalid("Rust backtest result winRate does not reconcile");
        }
        if (Math.abs(expectedAvgTrade - (raw.avgTrade as number)) > tolerance) {
            return invalid("Rust backtest result avgTrade does not reconcile");
        }
    }

    return {
        ok: true,
        result: { ...raw, profitFactor: normalizedProfitFactor } as unknown as BacktestResult,
    };
}
