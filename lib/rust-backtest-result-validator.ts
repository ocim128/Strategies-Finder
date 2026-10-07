import type { BacktestResult, Time } from "./types/strategies";
import { timeToNumber } from "./strategies/backtest/backtest-utils";

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

const TRADE_NUMERIC_FIELDS = [
    "entryPrice",
    "exitPrice",
    "pnl",
    "pnlPercent",
    "size",
] as const;

function invalid(message: string): RustBacktestResultValidation {
    return { ok: false, reason: "malformed_response", message };
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

/**
 * Rust wire times arrive as finite numbers. Equivalent string and
 * business-day shapes stay acceptable through the shared normalization
 * helper so normalized variants are not rejected; anything unparseable is.
 * The helper's object path can overflow to NaN (an out-of-range business
 * day yields Date.UTC NaN), so the parsed value must be finite too.
 */
function isSupportedTime(time: unknown): boolean {
    if (typeof time === "number") return Number.isFinite(time);
    if (typeof time === "string" || (time !== null && typeof time === "object")) {
        const parsedTime = timeToNumber(time as Time);
        return parsedTime !== null && Number.isFinite(parsedTime);
    }
    return false;
}

/**
 * Validate one returned trade entry. Compact results keep empty histories,
 * and the entry count is deliberately not reconciled with `totalTrades`:
 * retained history is an output option, not a contract.
 */
function tradeEntryError(trade: unknown, requireExitReason: boolean): string | null {
    if (!trade || typeof trade !== "object") return "trade is not an object";
    const raw = trade as Record<string, unknown>;
    if (!Number.isInteger(raw.id) || (raw.id as number) < 0) return "trade has an invalid id";
    if (raw.type !== "long" && raw.type !== "short") return "trade has an invalid type";
    if (!isSupportedTime(raw.entryTime) || !isSupportedTime(raw.exitTime)) {
        return "trade has an invalid entry or exit time";
    }
    if (!TRADE_NUMERIC_FIELDS.every((field) => isFiniteNumber(raw[field]))) {
        return "trade has a non-finite numeric field";
    }
    if (raw.exitReason !== undefined && typeof raw.exitReason !== "string") {
        return "trade has an invalid exitReason";
    }
    if (requireExitReason && typeof raw.exitReason !== "string") {
        return "trade is missing exitReason";
    }
    if (raw.fees !== undefined && raw.fees !== null && !isFiniteNumber(raw.fees)) {
        return "trade has invalid fees";
    }
    return null;
}

function equityPointError(point: unknown): string | null {
    if (!point || typeof point !== "object") return "equity point is not an object";
    const raw = point as Record<string, unknown>;
    if (!isSupportedTime(raw.time)) return "equity point has an invalid time";
    if (!isFiniteNumber(raw.value)) return "equity point has an invalid value";
    return null;
}

/**
 * Validate and normalize the generic Rust backtest wire result before it can
 * reach renderers or the TypeScript/Rust parity checks. Summary metrics,
 * every returned trade entry, and every returned equity point are checked;
 * omitted history (compact results) stays valid.
 */
export function validateRustBacktestResult(
    value: unknown,
    options: { requireExitReason?: boolean } = {},
): RustBacktestResultValidation {
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

    for (const trade of raw.trades) {
        const error = tradeEntryError(trade, options.requireExitReason === true);
        if (error) return invalid(`Rust backtest result ${error}`);
    }
    for (const point of raw.equityCurve) {
        const error = equityPointError(point);
        if (error) return invalid(`Rust backtest result ${error}`);
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
