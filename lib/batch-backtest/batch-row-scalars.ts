import { parsePortfolioSyntheticPairSymbol, stripKnownQuoteSuffix } from "../portfolioLab/portfolio-lab-synthetic";
import type { OHLCVData } from "../types/strategies";
import type { BatchBacktestSymbolResult } from "./batch-backtest-runner";

export function computeBuyAndHoldPct(data: readonly OHLCVData[] | undefined | null): number | null {
    if (!data || data.length === 0) return null;
    let first: number | null = null;
    for (const bar of data) {
        if (Number.isFinite(bar.close) && bar.close > 0) {
            first = bar.close;
            break;
        }
    }
    let last: number | null = null;
    for (let i = data.length - 1; i >= 0; i -= 1) {
        const close = data[i]!.close;
        if (Number.isFinite(close) && close > 0) {
            last = close;
            break;
        }
    }
    if (first === null || last === null || first === 0) return null;
    return ((last / first) - 1) * 100;
}

export function computeOpenTradeAssetScores(
    rows: readonly BatchBacktestSymbolResult[],
): { asset: string; score: number }[] {
    const tally = new Map<string, number>();
    for (const row of rows) {
        if (row.openTradeAssetScores) {
            for (const entry of row.openTradeAssetScores) {
                tally.set(entry.asset, (tally.get(entry.asset) ?? 0) + entry.score);
            }
            continue;
        }

        const trades = row.result?.trades;
        if (!trades || trades.length === 0) continue;
        const last = trades[trades.length - 1]!;
        if (last.exitReason !== "end_of_data") continue;
        const sign = last.type === "long" ? 1 : last.type === "short" ? -1 : 0;
        if (sign === 0) continue;

        const parsed = parsePortfolioSyntheticPairSymbol(row.symbol);
        if (parsed) {
            tally.set(parsed.baseAsset, (tally.get(parsed.baseAsset) ?? 0) + sign);
            tally.set(parsed.quoteAsset, (tally.get(parsed.quoteAsset) ?? 0) - sign);
        } else {
            const asset = stripKnownQuoteSuffix(row.symbol);
            if (asset) tally.set(asset, (tally.get(asset) ?? 0) + sign);
        }
    }
    return Array.from(tally.entries())
        .map(([asset, score]) => ({ asset, score }))
        .sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || a.asset.localeCompare(b.asset));
}

export interface CurrentMaxActiveCandidate {
    asset: string;
    score: number;
    activePairs: number;
}

/**
 * Current-state MAX_ACTIVE candidates for the Batch summary. Unlike the
 * historical replay, this describes only positions open at the end of the
 * Batch run. Return every tied winner instead of hiding a tie behind an
 * arbitrary asset-name choice.
 */
export function computeCurrentMaxActiveCandidates(
    rows: readonly BatchBacktestSymbolResult[],
    /**
     * Optional pre-computed asset scores for the same `rows`. When supplied,
     * skips the internal O(N) `computeOpenTradeAssetScores(rows)` call. Callers
     * that already compute the asset-score map for the OPEN_SCORE summary line
     * should thread it through to avoid recomputing the same map per call.
     */
    scores?: { asset: string; score: number }[],
): CurrentMaxActiveCandidate[] {
    const activePairsByAsset = new Map<string, number>();
    for (const row of rows) {
        const rowScores = row.openTradeAssetScores ?? computeOpenTradeAssetScores([row]);
        const assetsInOpenPair = new Set(rowScores.filter((entry) => entry.score !== 0).map((entry) => entry.asset));
        for (const asset of assetsInOpenPair) {
            activePairsByAsset.set(asset, (activePairsByAsset.get(asset) ?? 0) + 1);
        }
    }

    const positives = (scores ?? computeOpenTradeAssetScores(rows))
        .filter((entry) => entry.score > 0)
        .map((entry) => ({
            ...entry,
            activePairs: activePairsByAsset.get(entry.asset) ?? 0,
        }));
    const maxActivePairs = Math.max(0, ...positives.map((entry) => entry.activePairs));
    return positives
        .filter((entry) => entry.activePairs === maxActivePairs)
        .sort((a, b) => b.score - a.score || a.asset.localeCompare(b.asset));
}
