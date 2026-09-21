import { DEFAULT_SORT_PRIORITY } from "./constants";
import type {
    FinderMetric,
    FinderMode,
    FinderOptions,
    FinderDataSlice,
    FinderOosDataSlice,
    FinderOosVerdict,
    FinderUniverseMetric,
    FinderUniverseOptions,
} from "../types/finder";
import { parseTimeToUnixSeconds } from "../time-normalization";

export interface FinderOptionsInput {
    useAdvancedSort: boolean;
    advancedSortValues: readonly (FinderMetric | undefined)[];
    primarySort: FinderMetric;
    secondarySort: FinderMetric;
    mode: FinderMode;
    dataSlice?: FinderDataSlice;
    dataRangeFrom?: string;
    dataRangeTo?: string;
    topN: number;
    steps: number;
    rangePercent: number;
    maxRuns: number;
    tradeFilterEnabled: boolean;
    minTrades: number;
    maxTrades: number;
    freezeRiskManagement: boolean;
    randomizePathExitParams?: boolean;
    exitStrategyOverrideEnabled?: boolean;
    exitStrategyKey?: string;
    exitStrategyBaseParams?: import("../types/strategies").StrategyParams;
}

export function normalizeFinderDataSlice(value: unknown): FinderDataSlice {
    return value === "1" || value === "2" || value === "3" || value === "4" || value === "5"
        || value === "half_oldest" || value === "half_newest" || value === "date_range"
        ? value
        : "all";
}

/**
 * Sanitize one user-supplied date-window boundary. Accepts anything
 * `Date.parse` understands; canonical input is 'YYYY-MM-DD' (parsed as UTC).
 * Returns undefined for empty/invalid input so a bad value degrades to an
 * unbounded side instead of producing an empty window.
 */
export function normalizeFinderDateInput(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? trimmed : undefined;
}

export interface FinderDateRange {
    from?: string;
    to?: string;
}

/**
 * Normalize both ends of a date window. Invalid ends drop out; an inverted
 * range (from > to) is swapped so a typo cannot silently produce an empty
 * window.
 */
export function normalizeFinderDateRange(from: unknown, to: unknown): FinderDateRange {
    const normalizedFrom = normalizeFinderDateInput(from);
    const normalizedTo = normalizeFinderDateInput(to);
    if (normalizedFrom && normalizedTo) {
        const fromSec = Date.parse(normalizedFrom);
        const toSec = Date.parse(normalizedTo);
        if (Number.isFinite(fromSec) && Number.isFinite(toSec) && fromSec > toSec) {
            return { from: normalizedTo, to: normalizedFrom };
        }
    }
    return {
        ...(normalizedFrom ? { from: normalizedFrom } : {}),
        ...(normalizedTo ? { to: normalizedTo } : {}),
    };
}

/** Inclusive window start in unix seconds, or undefined when unbounded. */
function finderDateRangeFromSec(range: FinderDateRange | undefined): number | undefined {
    const from = normalizeFinderDateInput(range?.from);
    if (!from) return undefined;
    const parsed = Date.parse(from);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}

/** Inclusive window END in unix seconds (whole last day), or undefined when unbounded. */
function finderDateRangeToSec(range: FinderDateRange | undefined): number | undefined {
    const to = normalizeFinderDateInput(range?.to);
    if (!to) return undefined;
    const parsed = Date.parse(to);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) + 86399 : undefined;
}

export function sliceFinderDataWindow<T>(
    data: readonly T[],
    dataSlice: FinderDataSlice | FinderOosDataSlice,
    dateRange?: FinderDateRange,
): T[] {
    if (dataSlice === "all") {
        return data.slice();
    }
    if (data.length === 0) {
        return [];
    }

    if (dataSlice === "half_oldest") {
        return data.slice(0, Math.floor(data.length / 2));
    }
    if (dataSlice === "half_newest") {
        return data.slice(Math.floor(data.length / 2));
    }

    if (dataSlice === "date_range" || dataSlice === "date_range_after") {
        // 'date_range_after' (the OOS complement) is every bar strictly after
        // the range end; with no `to` boundary that window is empty.
        if (dataSlice === "date_range_after") {
            const afterSec = finderDateRangeToSec(dateRange);
            if (afterSec === undefined) {
                return [];
            }
            return data.filter((item) => {
                const timeSec = parseTimeToUnixSeconds((item as { time?: unknown }).time);
                return timeSec !== null && timeSec > afterSec;
            });
        }
        const fromSec = finderDateRangeFromSec(dateRange);
        const toSec = finderDateRangeToSec(dateRange);
        return data.filter((item) => {
            const timeSec = parseTimeToUnixSeconds((item as { time?: unknown }).time);
            if (timeSec === null) return false;
            if (fromSec !== undefined && timeSec < fromSec) return false;
            if (toSec !== undefined && timeSec > toSec) return false;
            return true;
        });
    }

    const sliceIndex = Number(dataSlice) - 1;
    const start = Math.floor((sliceIndex * data.length) / 5);
    const end = dataSlice === "5"
        ? data.length
        : Math.floor(((sliceIndex + 1) * data.length) / 5);
    return data.slice(start, end);
}

/**
 * Returns the data-slice value for the OOS (complementary) window, or null when
 * OOS validation is not applicable to the given IS slice. Half-windows map to
 * their complementary half; the date-range window validates on every bar AFTER
 * its `to` date; fifth-windows do not have a well-defined single complement.
 */
export function resolveOosDataSlice(dataSlice: FinderDataSlice): FinderOosDataSlice | null {
    if (dataSlice === "half_oldest") return "half_newest";
    if (dataSlice === "half_newest") return "half_oldest";
    if (dataSlice === "date_range") return "date_range_after";
    return null;
}

/**
 * IS/OOS gate verdict. Pass requires non-negative OOS net profit and an OOS
 * profit factor of at least 1.0. Returns `inconclusive` (not rejected) when the
 * OOS run produced fewer trades than the IS minTrades floor.
 */
export function computeFinderOosVerdict(args: {
    oosNetProfit: number;
    oosProfitFactor: number;
    oosTotalTrades: number;
    minTrades: number;
}): FinderOosVerdict {
    if (args.oosTotalTrades < Math.max(1, args.minTrades)) {
        return "inconclusive";
    }
    return args.oosNetProfit >= 0 && args.oosProfitFactor >= 1.0
        ? "pass"
        : "fail";
}

export interface FinderUniverseOptionsInput {
    symbols: string[];
    minActiveSymbols: number;
    minTotalTrades: number;
    minProfitableActiveRatio: number;
    primarySort: FinderUniverseMetric;
    secondarySort: FinderUniverseMetric;
}

export function resolveFinderSortPriority(input: {
    useAdvancedSort: boolean;
    advancedSortValues: readonly (FinderMetric | undefined)[];
    primarySort: FinderMetric;
    secondarySort: FinderMetric;
}): FinderMetric[] {
    if (input.useAdvancedSort) {
        const advancedPriority = input.advancedSortValues.filter((value): value is FinderMetric => Boolean(value));
        return advancedPriority.length > 0 ? advancedPriority : [...DEFAULT_SORT_PRIORITY];
    }

    const sortPriority: FinderMetric[] = [input.primarySort];
    if (input.primarySort !== input.secondarySort) {
        sortPriority.push(input.secondarySort);
    }
    if (!sortPriority.includes("netProfit")) {
        sortPriority.push("netProfit");
    }
    return sortPriority;
}

export function resolveFinderUniverseSortPriority(input: {
    primarySort: FinderUniverseMetric;
    secondarySort: FinderUniverseMetric;
}): FinderUniverseMetric[] {
    const sortPriority: FinderUniverseMetric[] = [input.primarySort];
    if (input.secondarySort !== input.primarySort) {
        sortPriority.push(input.secondarySort);
    }
    for (const fallback of ["worstNetProfit", "totalTrades"] as const) {
        if (!sortPriority.includes(fallback)) {
            sortPriority.push(fallback);
        }
    }
    return sortPriority;
}

export function buildFinderUniverseOptions(input: FinderUniverseOptionsInput): FinderUniverseOptions {
    const minActiveSymbols = Math.max(1, Math.round(input.minActiveSymbols));
    const minTotalTrades = Math.max(0, Math.round(input.minTotalTrades));
    const minProfitableActiveRatio = Math.max(0, Math.min(1, input.minProfitableActiveRatio));

    return {
        symbols: input.symbols,
        minActiveSymbols,
        minTotalTrades,
        minProfitableActiveRatio,
        sortPriority: resolveFinderUniverseSortPriority(input),
    };
}

export function buildFinderOptions(input: FinderOptionsInput): FinderOptions {
    const minTrades = input.tradeFilterEnabled ? input.minTrades : 0;
    const maxTrades = input.tradeFilterEnabled ? Math.max(minTrades, input.maxTrades) : Number.POSITIVE_INFINITY;

    const dateRange = normalizeFinderDateRange(input.dataRangeFrom, input.dataRangeTo);
    return {
        mode: input.mode,
        dataSlice: normalizeFinderDataSlice(input.dataSlice),
        ...(dateRange.from ? { dataRangeFrom: dateRange.from } : {}),
        ...(dateRange.to ? { dataRangeTo: dateRange.to } : {}),
        sortPriority: resolveFinderSortPriority(input),
        useAdvancedSort: input.useAdvancedSort,
        topN: input.topN,
        steps: input.steps,
        rangePercent: input.rangePercent,
        maxRuns: input.maxRuns,
        tradeFilterEnabled: input.tradeFilterEnabled,
        minTrades,
        maxTrades,
        freezeRiskManagement: input.freezeRiskManagement,
        randomizePathExitParams: input.randomizePathExitParams === true,
        exitStrategyOverrideEnabled: input.exitStrategyOverrideEnabled === true,
        exitStrategyKey: input.exitStrategyOverrideEnabled === true ? input.exitStrategyKey : undefined,
        exitStrategyBaseParams: input.exitStrategyOverrideEnabled === true ? input.exitStrategyBaseParams : undefined,
    };
}

/**
 * Apply the Finder trade-count eligibility gate to one completed result.
 *
 * `Infinity` is serialized as `null` in the Asset Opportunity request body,
 * so a non-finite max is the wire representation of an unbounded maximum.
 */
export function matchesFinderTradeCountFilter(
    totalTrades: number,
    filter: Pick<FinderOptions, "tradeFilterEnabled" | "minTrades" | "maxTrades">,
): boolean {
    if (!filter.tradeFilterEnabled) return true;
    if (!Number.isFinite(totalTrades)) return false;

    const minTrades = Number.isFinite(filter.minTrades)
        ? Math.max(0, filter.minTrades)
        : 0;
    const maxTrades = Number.isFinite(filter.maxTrades)
        ? Math.max(minTrades, filter.maxTrades)
        : Number.POSITIVE_INFINITY;
    return totalTrades >= minTrades && totalTrades <= maxTrades;
}
