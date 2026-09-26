/**
 * Finder date-range Data Window.
 *
 * Locks the contracts of the `date_range` data-slice mode:
 *
 *  - SLICE SEMANTICS: `date_range` keeps bars whose time falls inside
 *    [from 00:00:00, to 23:59:59] UTC (inclusive on both ends), across unix-
 *    second, unix-millisecond, and ISO-string bar times; bars with
 *    unparseable times are dropped; a missing boundary is unbounded.
 *  - OOS COMPLEMENT: `date_range_after` is every bar strictly after `to`
 *    (empty when `to` is absent); `resolveOosDataSlice` /
 *    `resolveUniverseOosSlice` map date_range to it, the IS window and its
 *    complement partition the data, and the half-window mappings are
 *    unchanged.
 *  - RANGE NORMALIZATION: invalid bounds drop out (unbounded, never an empty
 *    window) and an inverted range is swapped.
 *  - OPTION FLOW: `buildFinderOptions` carries the sanitized range only.
 *  - WORKER PATH: the parallel universe worker's dataset cache applies the
 *    date window, and a full worker task produces symbol results measured on
 *    the sliced window (barCount in the survivor breakdown).
 */

import { expect } from "chai";
import { describe, it, before, after } from "node:test";
import { strategyRegistry } from "../strategyRegistry";
import {
    buildFinderOptions,
    normalizeFinderDataSlice,
    normalizeFinderDateInput,
    normalizeFinderDateRange,
    resolveOosDataSlice,
    sliceFinderDataWindow,
} from "../lib/finder/finder-manager-logic";
import { resolveUniverseOosSlice } from "../lib/finder/finder-universe-oos";
import {
    createUniverseWorkerDatasetCache,
    runFinderUniverseStrategyWorkerTask,
} from "../lib/finder/server/finder-universe-strategy-worker";
import type { FinderOptions } from "../lib/types/finder";
import type { CapitalSettings } from "../lib/types/backtest";
import type { BacktestSettings, OHLCVData, Strategy, Time } from "../lib/types/strategies";

const STRATEGY_KEY = "date_range_test_strategy";

const testStrategy: Strategy = {
    name: "Date Range Test",
    description: "Buys early and sells on the last bar of the evaluation window.",
    defaultParams: { threshold: 1 },
    paramLabels: { threshold: "Threshold" },
    execute(data) {
        if (data.length < 3) return [];
        return [
            { time: data[0]!.time, type: "buy", price: data[0]!.close },
            { time: data[data.length - 1]!.time, type: "sell", price: data[data.length - 1]!.close },
        ];
    },
};

const settings: BacktestSettings = {
    executionModel: "signal_close",
    tradeDirection: "long",
    allowSameBarExit: true,
    slippageBps: 0,
    marketMode: "all",
};

const capitalSettings: CapitalSettings = {
    initialCapital: 10000,
    positionSize: 100,
    commission: 0,
    sizingMode: "percent",
    fixedTradeAmount: 1000,
};

/** Daily bars ascending from `fromIso` through `toIso`; unix seconds or ms. */
function makeDailyBars(fromIso: string, toIso: string, toMs = false): OHLCVData[] {
    const bars: OHLCVData[] = [];
    const cursor = Date.parse(fromIso);
    const end = Date.parse(toIso);
    let close = 100;
    for (let ms = cursor; ms <= end; ms += 86_400_000) {
        const time = (toMs ? ms : Math.floor(ms / 1000)) as Time;
        bars.push({ time, open: close, high: close + 1, low: close - 1, close, volume: 1000 });
        close += 1;
    }
    return bars;
}

function barMs(time: Time): number {
    return typeof time === "number" && time > 9_999_999_999 ? time : (time as number) * 1000;
}

function countBarsInYear(bars: OHLCVData[], year: number): number {
    const from = Date.UTC(year, 0, 1);
    const to = Date.UTC(year + 1, 0, 1);
    return bars.filter((bar) => barMs(bar.time) >= from && barMs(bar.time) < to).length;
}

describe("finder date-range data window", () => {
    before(() => {
        strategyRegistry.register(STRATEGY_KEY, testStrategy);
    });
    after(() => {
        strategyRegistry.unregister(STRATEGY_KEY);
    });

    it("normalizes the slice mode: date_range accepted, internal OOS value rejected", () => {
        expect(normalizeFinderDataSlice("date_range")).to.equal("date_range");
        expect(normalizeFinderDataSlice("date_range_after")).to.equal("all");
        expect(normalizeFinderDataSlice("half_oldest")).to.equal("half_oldest");
        expect(normalizeFinderDataSlice("nonsense")).to.equal("all");
    });

    it("normalizes date ranges: invalid bounds drop out and inverted ranges swap", () => {
        expect(normalizeFinderDateRange("2020-01-01", "2023-12-31")).to.deep.equal({
            from: "2020-01-01",
            to: "2023-12-31",
        });
        // Inverted input is swapped, not emptied.
        expect(normalizeFinderDateRange("2023-12-31", "2020-01-01")).to.deep.equal({
            from: "2020-01-01",
            to: "2023-12-31",
        });
        // Invalid/empty bounds are unbounded, never an empty window.
        expect(normalizeFinderDateRange("not-a-date", "2020-01-01")).to.deep.equal({ to: "2020-01-01" });
        expect(normalizeFinderDateRange("", "  ")).to.deep.equal({});
        expect(normalizeFinderDateInput("2020-01-01")).to.equal("2020-01-01");
        expect(normalizeFinderDateInput("junk")).to.equal(undefined);
    });

    it("slices unix-second bars inclusively on both boundaries", () => {
        const bars = makeDailyBars("2019-06-01", "2022-06-01");
        const range = { from: "2020-01-01", to: "2020-12-31" };
        const sliced = sliceFinderDataWindow(bars, "date_range", range);
        expect(sliced).to.have.lengthOf(countBarsInYear(bars, 2020));
        // First bar is the first bar on/after the range start; last bar is the
        // last bar on/before the range end (whole end day inclusive).
        expect(barMs(sliced[0]!.time)).to.be.at.least(Date.parse("2020-01-01"));
        expect(barMs(sliced[0]!.time)).to.be.at.most(Date.parse("2020-01-02"));
        expect(barMs(sliced[sliced.length - 1]!.time)).to.be.at.least(Date.parse("2020-12-30"));
        expect(barMs(sliced[sliced.length - 1]!.time)).to.be.at.most(Date.parse("2020-12-31") + 86_399_000);
    });

    it("slices millisecond and ISO-string bar times with the same boundaries", () => {
        const secBars = makeDailyBars("2019-06-01", "2022-06-01");
        const msBars = makeDailyBars("2019-06-01", "2022-06-01", true);
        const isoBars = msBars.map((bar) => ({
            ...bar,
            time: new Date(bar.time as number).toISOString().slice(0, 10),
        }));
        const range = { from: "2021-03-01", to: "2021-09-30" };
        const fromSec = Date.parse("2021-03-01") / 1000;
        const toSec = Date.parse("2021-09-30") / 1000 + 86399;
        const expectedCount = secBars.filter((bar) => {
            const t = bar.time as number;
            return t >= fromSec && t <= toSec;
        }).length;
        expect(expectedCount).to.be.greaterThan(100);
        expect(sliceFinderDataWindow(secBars, "date_range", range)).to.have.lengthOf(expectedCount);
        expect(sliceFinderDataWindow(msBars, "date_range", range)).to.have.lengthOf(expectedCount);
        expect(sliceFinderDataWindow(isoBars, "date_range", range)).to.have.lengthOf(expectedCount);
    });

    it("treats missing boundaries as unbounded and drops unparseable times", () => {
        const bars = makeDailyBars("2019-06-01", "2022-06-01");
        // No bounds at all: every parseable bar survives.
        expect(sliceFinderDataWindow(bars, "date_range", {})).to.have.lengthOf(bars.length);
        // Only `from`: everything from that date onward.
        const fromOnly = sliceFinderDataWindow(bars, "date_range", { from: "2021-01-01" });
        expect(fromOnly.length).to.be.lessThan(bars.length);
        expect(barMs(fromOnly[0]!.time)).to.be.at.least(Date.parse("2021-01-01"));
        // Only `to`: everything up to that date.
        const toOnly = sliceFinderDataWindow(bars, "date_range", { to: "2020-01-01" });
        expect(barMs(toOnly[toOnly.length - 1]!.time)).to.be.at.most(Date.parse("2020-01-01") + 86_399_000);
        // Unparseable bar times cannot be placed in a window and are dropped.
        const withJunk = [...bars, { time: "not-a-date" as Time, open: 1, high: 2, low: 0, close: 1, volume: 1 }];
        expect(sliceFinderDataWindow(withJunk, "date_range", { from: "2019-06-01", to: "2022-06-01" }))
            .to.have.lengthOf(bars.length);
        // Empty input stays empty.
        expect(sliceFinderDataWindow([], "date_range", { from: "2020-01-01", to: "2021-01-01" })).to.deep.equal([]);
    });

    it("resolves the date-range OOS complement to every bar strictly after `to`", () => {
        expect(resolveOosDataSlice("date_range")).to.equal("date_range_after");
        expect(resolveUniverseOosSlice("date_range")).to.equal("date_range_after");
        // Half-window mappings unchanged; fifth-windows still have no OOS.
        expect(resolveOosDataSlice("half_oldest")).to.equal("half_newest");
        expect(resolveOosDataSlice("5")).to.equal(null);

        const bars = makeDailyBars("2019-06-01", "2022-06-01");
        const range = { from: "2020-01-01", to: "2020-12-31" };
        const is = sliceFinderDataWindow(bars, "date_range", range);
        const after = sliceFinderDataWindow(bars, "date_range_after", range);
        expect(after.length).to.be.greaterThan(0);
        expect(barMs(after[0]!.time)).to.be.at.least(Date.parse("2021-01-01"));
        // The IS window and its forward complement partition everything from
        // `from` onward (bars BEFORE `from` belong to neither — forward
        // validation never looks back).
        const fromSec = Date.parse("2020-01-01") / 1000;
        const onOrAfterFrom = bars.filter((bar) => (bar.time as number) >= fromSec);
        expect(is.length + after.length).to.equal(onOrAfterFrom.length);
        // Without a `to` boundary the forward window is empty.
        expect(sliceFinderDataWindow(bars, "date_range_after", { from: "2020-01-01" })).to.deep.equal([]);
    });

    it("buildFinderOptions carries the sanitized range and drops invalid bounds", () => {
        const base = {
            useAdvancedSort: false,
            advancedSortValues: [],
            primarySort: "expectancy" as const,
            secondarySort: "profitFactor" as const,
            mode: "random" as const,
            dataSlice: "date_range" as const,
            topN: 5,
            steps: 3,
            rangePercent: 35,
            maxRuns: 4,
            tradeFilterEnabled: false,
            minTrades: 0,
            maxTrades: Number.POSITIVE_INFINITY,
            freezeRiskManagement: false,
        };
        const withRange = buildFinderOptions({
            ...base,
            dataRangeFrom: "2020-01-01",
            dataRangeTo: "2023-12-31",
        } as Parameters<typeof buildFinderOptions>[0]);
        expect(withRange.dataRangeFrom).to.equal("2020-01-01");
        expect(withRange.dataRangeTo).to.equal("2023-12-31");
        const cleaned = buildFinderOptions({ ...base, dataRangeFrom: "junk", dataRangeTo: "" } as Parameters<typeof buildFinderOptions>[0]);
        expect(cleaned.dataRangeFrom).to.equal(undefined);
        expect(cleaned.dataRangeTo).to.equal(undefined);
    });

    it("worker dataset cache applies the date window to loaded datasets", async () => {
        const bars = makeDailyBars("2019-06-01", "2022-06-01");
        const cache = createUniverseWorkerDatasetCache({
            dataSlice: "date_range",
            dateRange: { from: "2020-01-01", to: "2020-12-31" },
            loadDataset: async () => bars,
        });
        const sliced = await cache.load("SYM", "1d");
        expect(sliced).to.have.lengthOf(countBarsInYear(bars, 2020));
        // Cache hit returns the same sliced series.
        expect(cache.get("SYM", "1d")).to.equal(sliced);
    });

    it("worker task end-to-end: survivors are measured on the date-window slice", async () => {
        const bars = makeDailyBars("2019-06-01", "2022-06-01");
        const options: FinderOptions = {
            scope: "symbol_universe",
            mode: "random",
            randomSeed: 7,
            sortPriority: ["netProfit"],
            useAdvancedSort: false,
            topN: 5,
            steps: 2,
            rangePercent: 10,
            maxRuns: 2,
            dataSlice: "date_range",
            dataRangeFrom: "2020-01-01",
            dataRangeTo: "2020-12-31",
            tradeFilterEnabled: false,
            minTrades: 0,
            maxTrades: Number.POSITIVE_INFINITY,
            universe: {
                symbols: ["SYM"],
                minActiveSymbols: 1,
                minTotalTrades: 1,
                minProfitableActiveRatio: 0,
                sortPriority: ["profitableActiveRatio", "medianExpectancy", "worstNetProfit"],
            },
        } as unknown as FinderOptions;
        const result = await runFinderUniverseStrategyWorkerTask({
            task: {
                taskIndex: 0,
                runId: "date-range-worker-test",
                interval: "1d",
                symbols: ["SYM"],
                options,
                settings,
                capitalSettings,
                strategyKey: STRATEGY_KEY,
                exitStrategyKeys: [],
                useRustEnginePreference: false,
            },
            loadDataset: async () => bars,
            abortSignal: new AbortController().signal,
            isCancelled: () => false,
            onProgress: () => undefined,
        });
        expect(result.results.length).to.be.greaterThan(0);
        const sym = result.results[0]!.symbols.find((entry) => entry.symbol === "SYM");
        expect(sym, "survivor must carry the SYM breakdown").to.exist;
        // The bar count proves the evaluation ran on the 2020 slice, not the
        // full 2019-2022 series.
        expect(sym!.barCount).to.equal(countBarsInYear(bars, 2020));
        expect(sym!.barCount).to.be.lessThan(bars.length);
    });
});
