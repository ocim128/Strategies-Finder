import { parseTimeToUnixSeconds } from "../time-normalization";
import type { Trade } from "../types/strategies";

export interface BatchYearlyPnlBucket {
    netPnl: number;
    trades: number;
}

export type BatchYearlyPnl = Record<string, BatchYearlyPnlBucket>;

/** Group completed trades by the UTC calendar year of their exit. */
export function groupTradesByExitYear(trades: readonly Trade[]): BatchYearlyPnl {
    const grouped: BatchYearlyPnl = {};
    for (const trade of trades) {
        const exitSeconds = parseTimeToUnixSeconds(trade.exitTime);
        if (exitSeconds === null || !Number.isFinite(trade.pnl)) continue;
        const year = new Date(exitSeconds * 1000).getUTCFullYear();
        const key = String(year);
        const bucket = grouped[key] ??= { netPnl: 0, trades: 0 };
        bucket.netPnl += trade.pnl;
        bucket.trades += 1;
    }
    return grouped;
}

/** Parse the compact scalar representation used by server-side Batch rows. */
export function parseYearlyPnl(value: string | null | undefined): BatchYearlyPnl {
    const parsed: BatchYearlyPnl = {};
    if (!value) return parsed;
    for (const part of value.split("|")) {
        const match = /^(\d{4}):([+-]?(?:\d+(?:\.\d+)?|\.\d+))\((\d+)\)$/.exec(part.trim());
        if (!match) continue;
        const netPnl = Number(match[2]);
        const trades = Number(match[3]);
        if (!Number.isFinite(netPnl) || !Number.isInteger(trades) || trades < 0) continue;
        parsed[match[1]!] = { netPnl, trades };
    }
    return parsed;
}

/** Add yearly buckets from multiple symbols without changing their order. */
export function aggregateYearlyPnl(summaries: readonly BatchYearlyPnl[]): BatchYearlyPnl {
    const aggregate: BatchYearlyPnl = {};
    for (const summary of summaries) {
        for (const [year, bucket] of Object.entries(summary)) {
            if (!Number.isFinite(bucket.netPnl) || !Number.isInteger(bucket.trades)) continue;
            const current = aggregate[year] ??= { netPnl: 0, trades: 0 };
            current.netPnl += bucket.netPnl;
            current.trades += bucket.trades;
        }
    }
    return aggregate;
}

function formatPnl(value: number): string {
    if (!Number.isFinite(value)) return "n/a";
    const rounded = Math.round(value * 100) / 100;
    const amount = Math.abs(rounded).toFixed(2).replace(/0$/, "");
    return `${rounded >= 0 ? "+" : "-"}${amount}`;
}

/** Format yearly buckets in deterministic ascending-year order. */
export function formatYearlyPnl(summary: BatchYearlyPnl): string {
    return Object.entries(summary)
        .filter(([year, bucket]) => /^\d{4}$/.test(year) && Number.isFinite(bucket.netPnl) && Number.isInteger(bucket.trades))
        .sort(([yearA], [yearB]) => Number(yearA) - Number(yearB))
        .map(([year, bucket]) => `${year}:${formatPnl(bucket.netPnl)}(${bucket.trades})`)
        .join("|");
}

/** Resolve a row's yearly data for both full in-tab rows and scalar server rows. */
export function getBatchRowYearlyPnl(row: {
    yearlyPnl?: string;
    result?: { trades?: readonly Trade[] };
}): BatchYearlyPnl {
    if (typeof row.yearlyPnl === "string") return parseYearlyPnl(row.yearlyPnl);
    return groupTradesByExitYear(row.result?.trades ?? []);
}
