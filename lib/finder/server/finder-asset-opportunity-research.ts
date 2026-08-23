import { createHash } from "node:crypto";
import type { BacktestResult, OHLCVData, Trade } from "../../types/strategies";
import { timeKey } from "../../strategies/backtest/backtest-utils";
import { serializeParams } from "../finder-param-math";
import type {
    FinderAssetOpportunityCandidateSummaryRow,
    FinderAssetOpportunityPairContextRow,
} from "../finder-asset-opportunity-research-types";
export type {
    FinderAssetOpportunityCandidateSummaryRow,
    FinderAssetOpportunityPairContextRow,
    FinderFreshWindowJudgmentStatus,
} from "../finder-asset-opportunity-research-types";

export const FINDER_ASSET_OPPORTUNITY_RESEARCH_CHUNK_SIZE = 256;

export function buildFinderAssetOpportunityCandidateFingerprint(
    params: Record<string, number>,
): string {
    return serializeParams(params) || "default";
}

export function buildFinderAssetOpportunityCandidateIdentityHash(args: {
    symbol: string;
    strategyKey: string;
    candidateFingerprint: string;
}): string {
    return createHash("sha256")
        .update(JSON.stringify([args.symbol, args.strategyKey, args.candidateFingerprint]))
        .digest("hex");
}

function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
        ? sorted[middle]!
        : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function barsBetween(
    trade: Trade,
    indexByTime: Map<string, number>,
): number | null {
    const entryIndex = indexByTime.get(timeKey(trade.entryTime));
    const exitIndex = indexByTime.get(timeKey(trade.exitTime));
    if (entryIndex === undefined || exitIndex === undefined) return null;
    return Math.max(0, exitIndex - entryIndex);
}

function buildPathScalars(
    result: BacktestResult,
    candles: OHLCVData[],
): Pick<FinderAssetOpportunityCandidateSummaryRow, "tpHitCount" | "medianBarsToTP" | "medianBarsToTerminal" | "tpFirstShare"> {
    const indexByTime = new Map<string, number>();
    candles.forEach((candle, index) => indexByTime.set(timeKey(candle.time), index));
    const trades = Array.isArray(result.trades) ? result.trades : [];
    const tpTrades = trades.filter((trade) => trade.exitReason === "take_profit");
    const tpBars = tpTrades.flatMap((trade) => {
        const bars = barsBetween(trade, indexByTime);
        return bars === null ? [] : [bars];
    });
    const terminalBars = trades.flatMap((trade) => {
        const bars = barsBetween(trade, indexByTime);
        return bars === null ? [] : [bars];
    });
    return {
        tpHitCount: tpTrades.length,
        medianBarsToTP: tpBars.length >= 3 ? median(tpBars) : null,
        medianBarsToTerminal: median(terminalBars),
        // Each engine Trade is one terminal path. This is the fraction whose
        // terminal exit was a TP; Phase 3 replaces/extends this with the
        // execution-contract first-touch path fields.
        tpFirstShare: trades.length > 0 ? tpTrades.length / trades.length : null,
    };
}

export function buildFinderAssetOpportunityCandidateSummaryRow(args: {
    symbol: string;
    strategyKey: string;
    candidateIndex: number;
    candidateFingerprint: string;
    result?: BacktestResult;
    passesTradeFilter?: boolean;
}): FinderAssetOpportunityCandidateSummaryRow {
    const identityHash = buildFinderAssetOpportunityCandidateIdentityHash(args);
    if (!args.result) {
        return {
            symbol: args.symbol,
            strategyKey: args.strategyKey,
            candidateFingerprint: args.candidateFingerprint,
            identityHash,
            candidateIndex: args.candidateIndex,
            evaluationOk: false,
            passesTradeFilter: false,
            profitFactor: null,
            netProfitPercent: null,
            totalTrades: null,
            tpHitCount: null,
            medianBarsToTP: null,
            medianBarsToTerminal: null,
            tpFirstShare: null,
        };
    }
    return {
        symbol: args.symbol,
        strategyKey: args.strategyKey,
        candidateFingerprint: args.candidateFingerprint,
        identityHash,
        candidateIndex: args.candidateIndex,
        evaluationOk: true,
        passesTradeFilter: args.passesTradeFilter === true,
        profitFactor: Number.isFinite(args.result.profitFactor) ? args.result.profitFactor : null,
        netProfitPercent: Number.isFinite(args.result.netProfitPercent) ? args.result.netProfitPercent : null,
        totalTrades: Number.isFinite(args.result.totalTrades) ? args.result.totalTrades : null,
        ...buildPathScalars(args.result, []),
    };
}

/** Add the candle-aware path scalars to an already-built candidate row. */
export function attachFinderAssetOpportunityPathScalars(
    row: FinderAssetOpportunityCandidateSummaryRow,
    result: BacktestResult,
    candles: OHLCVData[],
): FinderAssetOpportunityCandidateSummaryRow {
    return { ...row, ...buildPathScalars(result, candles) };
}

function meanFinite(values: number[]): number | null {
    return values.length > 0
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : null;
}

function entropyBits(values: string[]): number {
    if (values.length === 0) return 0;
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts.values()].reduce((entropy, count) => {
        const probability = count / values.length;
        return entropy - probability * Math.log2(probability);
    }, 0);
}

/** Build full-pool pair context without consulting the retained top-K rows. */
export function buildFinderAssetOpportunityPairContext(
    rows: readonly FinderAssetOpportunityCandidateSummaryRow[],
    selectedStrategyCount: number,
): FinderAssetOpportunityPairContextRow[] {
    const bySymbol = new Map<string, FinderAssetOpportunityCandidateSummaryRow[]>();
    for (const row of rows) {
        const symbolRows = bySymbol.get(row.symbol) ?? [];
        symbolRows.push(row);
        bySymbol.set(row.symbol, symbolRows);
    }
    const denominator = Math.max(1, Math.floor(selectedStrategyCount));
    return [...bySymbol.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([symbol, symbolRows]) => {
            const tpBars = symbolRows
                .map((row) => row.medianBarsToTP)
                .filter((value): value is number => value !== null && Number.isFinite(value));
            const terminalBars = symbolRows
                .map((row) => row.medianBarsToTerminal)
                .filter((value): value is number => value !== null && Number.isFinite(value));
            const tpShares = symbolRows
                .map((row) => row.tpFirstShare)
                .filter((value): value is number => value !== null && Number.isFinite(value));
            const profitFactors = symbolRows
                .map((row) => row.profitFactor)
                .filter((value): value is number => value !== null && Number.isFinite(value));
            const strategyKeys = symbolRows.map((row) => row.strategyKey);
            const distinctStrategyCount = new Set(strategyKeys).size;
            return {
                symbol,
                candidateCount: symbolRows.length,
                distinctStrategyCount,
                strategyCoverage: distinctStrategyCount / denominator,
                strategyIdEntropy: entropyBits(strategyKeys),
                meanMedianBarsToTP: meanFinite(tpBars),
                meanMedianBarsToTerminal: meanFinite(terminalBars),
                meanTpFirstShare: meanFinite(tpShares),
                topProfitFactor: profitFactors.length > 0 ? Math.max(...profitFactors) : null,
                fullPool: true,
            } satisfies FinderAssetOpportunityPairContextRow;
        });
}
