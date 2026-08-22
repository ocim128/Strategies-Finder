import {
    evaluateSignalExitTrades,
    buildTradeAnnotationFromSignalExitResult,
    indexSignalExitOutcomesByEntryTs,
} from "../lib/polymarket-signal-exit-evaluator";
import { indexPricePointsByEvent, findEntryFill, findSignalExitFill } from "../lib/polymarket-price-points";
import {
    resolveEffectivePolymarketExitMode,
    isSignalExitSameEventMode,
    isSameEventPolymarketExitMode,
    SAME_EVENT_SUPPORTED_RANK_MODES,
} from "../lib/polymarket-exit-mode";
import type { PolymarketPricePoint } from "../lib/local-sqlite-polymarket-api";
import type { PolymarketOutcomeRow } from "../lib/types/polymarket-outcomes";
import type { Trade } from "../lib/types/strategies";
import { resolveBacktestSettingsFromRaw } from "../lib/backtest-settings-resolver";
import { normalizeStoredHuntRunSettings, DEFAULT_HUNT_RUN_SETTINGS } from "../lib/hunt/hunt-model";
import assert from "node:assert/strict";
import { test } from "node:test";

function ok(cond: boolean, label: string): void {
    assert.ok(cond, label);
}

function eq<T>(actual: T, expected: T, label: string): void {
    assert.deepEqual(actual, expected, label);
}

function approx(actual: number, expected: number, tolerance: number, label: string): void {
    assert.ok(Math.abs(actual - expected) <= tolerance, label);
}

function makeOutcome(overrides: Partial<PolymarketOutcomeRow> = {}): PolymarketOutcomeRow {
    return {
        series_id: "BTCUSDT_5m",
        event_slug: "test-event",
        market_slug: "test-market",
        interval: "5m",
        event_start_ts: 1000,
        event_end_ts: 1300,
        yes_token_id: "yes-token",
        no_token_id: "no-token",
        yes_open_price: 0.55,
        yes_entry_minute_1_price: 0.56,
        yes_entry_minute_2_price: 0.57,
        yes_entry_minute_3_price: 0.58,
        yes_entry_minute_4_price: 0.59,
        resolved_outcome_up: 1,
        resolution_source: "test",
        updated_at: 1000,
        ...overrides,
    };
}

function makeTrade(overrides: Partial<Trade> = {}): Trade {
    return {
        id: 1,
        type: "long",
        entryTime: 1020 as any,
        entryPrice: 100,
        exitTime: 1050 as any,
        exitPrice: 105,
        pnl: 5,
        pnlPercent: 5,
        size: 1,
        exitReason: "signal",
        ...overrides,
    };
}

function makePricePoint(overrides: Partial<PolymarketPricePoint> = {}): PolymarketPricePoint {
    return {
        series_id: "BTCUSDT_5m",
        event_start_ts: 1000,
        event_end_ts: 1300,
        market_slug: "",
        yes_token_id: "yes-token",
        no_token_id: "no-token",
        ts: 1020,
        yes_price: 0.55,
        no_price: 0.45,
        updated_at: 1020,
        ...overrides,
    };
}

test("polymarket signal exit evaluator", () => {

console.log("\n=== resolveEffectivePolymarketExitMode ===");

eq(
    resolveEffectivePolymarketExitMode({
        interval: "1m",
        executionModel: "next_open",
        polymarketAnnotationEnabled: true,
        requestedMode: "signal_exit_same_event",
    }),
    "signal_exit_same_event",
    "1m + next_open + enabled → signal_exit_same_event"
);

eq(
    resolveEffectivePolymarketExitMode({
        interval: "1s",
        executionModel: "signal_close",
        polymarketAnnotationEnabled: true,
        requestedMode: "signal_exit_same_event",
    }),
    "signal_exit_same_event",
    "1s + signal_close \u2192 signal_exit_same_event"
);

eq(
    resolveEffectivePolymarketExitMode({
        interval: "1s",
        executionModel: "signal_close",
        polymarketAnnotationEnabled: true,
        requestedMode: "chart_exit_same_event",
    }),
    "chart_exit_same_event",
    "1s + signal_close \u2192 chart_exit_same_event"
);

eq(
    resolveEffectivePolymarketExitMode({
        interval: "1m",
        executionModel: "next_open",
        polymarketAnnotationEnabled: true,
        requestedMode: "chart_exit_same_event",
    }),
    "chart_exit_same_event",
    "1m + next_open \u2192 chart_exit_same_event"
);

eq(
    resolveEffectivePolymarketExitMode({
        interval: "1s",
        executionModel: "signal_close",
        polymarketAnnotationEnabled: true,
        requestedMode: "resolve_hold",
    }),
    "resolve_hold",
    "1s + signal_close + requested resolve_hold \u2192 resolve_hold"
);

eq(
    resolveEffectivePolymarketExitMode({
        interval: "1s",
        executionModel: "next_open",
        polymarketAnnotationEnabled: true,
        requestedMode: "resolve_hold",
    }),
    "resolve_hold",
    "1s + next_open + requested resolve_hold \u2192 resolve_hold"
);

eq(
    resolveEffectivePolymarketExitMode({
        interval: "1s",
        executionModel: "next_close",
        polymarketAnnotationEnabled: true,
        requestedMode: "resolve_hold",
    }),
    "resolve_hold",
    "1s + next_close + requested resolve_hold \u2192 resolve_hold"
);

eq(
    resolveEffectivePolymarketExitMode({
        interval: "5m",
        executionModel: "next_open",
        polymarketAnnotationEnabled: true,
        requestedMode: "signal_exit_same_event",
    }),
    "resolve_hold",
    "5m interval → downgrade to resolve_hold"
);

eq(
    resolveEffectivePolymarketExitMode({
        interval: "1m",
        executionModel: "signal_close",
        polymarketAnnotationEnabled: true,
        requestedMode: "signal_exit_same_event",
    }),
    "resolve_hold",
    "1m + signal_close execution → downgrade to resolve_hold"
);

eq(
    resolveEffectivePolymarketExitMode({
        interval: "1m",
        executionModel: "next_open",
        polymarketAnnotationEnabled: false,
        requestedMode: "signal_exit_same_event",
    }),
    "resolve_hold",
    "annotation disabled → resolve_hold"
);

eq(
    resolveEffectivePolymarketExitMode({
        interval: "1m",
        executionModel: "next_open",
        polymarketAnnotationEnabled: true,
        requestedMode: "resolve_hold",
    }),
    "resolve_hold",
    "requested resolve_hold → resolve_hold"
);

eq(
    resolveEffectivePolymarketExitMode({
        interval: "1m",
        executionModel: "signal_close",
        polymarketAnnotationEnabled: true,
        requestedMode: "chart_exit_same_event",
    }),
    "resolve_hold",
    "1m + signal_close chart exit -> downgrade to resolve_hold"
);

console.log("\n=== isSignalExitSameEventMode ===");

ok(isSignalExitSameEventMode("signal_exit_same_event"), "signal_exit_same_event is signal exit");
ok(!isSignalExitSameEventMode("chart_exit_same_event"), "chart_exit_same_event is not signal exit");
ok(!isSignalExitSameEventMode("resolve_hold"), "resolve_hold is not signal exit");
ok(!isSignalExitSameEventMode(undefined), "undefined is not signal exit");
ok(isSameEventPolymarketExitMode("chart_exit_same_event"), "chart_exit_same_event is same-event exit");
ok(isSameEventPolymarketExitMode("signal_exit_same_event"), "signal_exit_same_event is same-event exit");

console.log("\n=== SAME_EVENT_SUPPORTED_RANK_MODES ===");

ok(SAME_EVENT_SUPPORTED_RANK_MODES.has("expectancy"), "expectancy is supported");
ok(SAME_EVENT_SUPPORTED_RANK_MODES.has("profitFactor"), "profitFactor is supported");
ok(!SAME_EVENT_SUPPORTED_RANK_MODES.has("balanced" as any), "balanced is not supported");
ok(!SAME_EVENT_SUPPORTED_RANK_MODES.has("accuracy" as any), "accuracy is not supported");

console.log("\n=== price point indexing ===");

{
    const points = [
        makePricePoint({ ts: 1010, yes_price: 0.50, no_price: 0.50 }),
        makePricePoint({ ts: 1015, yes_price: null, no_price: null }),
        makePricePoint({ ts: 1020, yes_price: 0.55, no_price: 0.45 }),
        makePricePoint({ ts: 1050, yes_price: 0.60, no_price: 0.40 }),
    ];

    const index = indexPricePointsByEvent(points);
    ok(index.pointsByEventStart.has(1000), "event indexed");
    const eventPoints = index.pointsByEventStart.get(1000)!;
    eq(eventPoints.length, 4, "four points in event");
    eq(eventPoints[0].ts, 1010, "sorted by ts");
}

console.log("\n=== findEntryFill ===");

{
    const points = [
        makePricePoint({ ts: 1010, yes_price: 0.50, no_price: 0.50 }),
        makePricePoint({ ts: 1020, yes_price: 0.55, no_price: 0.45 }),
        makePricePoint({ ts: 1050, yes_price: 0.60, no_price: 0.40 }),
    ];

    const fill = findEntryFill(points, 1015, "yes");
    ok(fill !== null, "entry fill found");
    if (fill) {
        eq(fill.ts, 1020, "entry fill at first point >= entryTs");
        approx(fill.price, 0.55, 0.001, "entry fill uses yes price");
    }

    const noFill = findEntryFill(points, 1020, "no");
    ok(noFill !== null, "entry fill at exact timestamp");
    if (noFill) {
        approx(noFill.price, 0.45, 0.001, "entry fill uses no price for short");
    }

    const nullFill = findEntryFill(points, 1100, "yes");
    eq(nullFill, null, "no fill after last point");

    const gapFill = findEntryFill(points, 1011, "yes");
    ok(gapFill !== null, "entry fill skips null-price point after lower bound");
    if (gapFill) {
        eq(gapFill.ts, 1020, "entry fill advances to next priced point");
    }
}

console.log("\n=== findSignalExitFill ===");

{
    const points = [
        makePricePoint({ ts: 1010, yes_price: 0.50, no_price: 0.50 }),
        makePricePoint({ ts: 1020, yes_price: 0.55, no_price: 0.45 }),
        makePricePoint({ ts: 1040, yes_price: null, no_price: null }),
        makePricePoint({ ts: 1050, yes_price: 0.60, no_price: 0.40 }),
    ];

    const fill = findSignalExitFill(points, 1030, "yes");
    ok(fill !== null, "signal exit fill found");
    if (fill) {
        eq(fill.ts, 1020, "latest point <= exitTs");
        approx(fill.price, 0.55, 0.001, "uses yes price");
    }

    const nullFill = findSignalExitFill(points, 1005, "yes");
    eq(nullFill, null, "no point before exitTs");

    const gapFill = findSignalExitFill(points, 1045, "yes");
    ok(gapFill !== null, "signal exit fill skips trailing null-price point before upper bound");
    if (gapFill) {
        eq(gapFill.ts, 1020, "signal exit fill rewinds to last priced point");
    }
}

console.log("\n=== evaluateSignalExitTrades: long enters and exits by signal ===");

{
    const trade = makeTrade({
        type: "long",
        entryTime: 1020 as any,
        exitTime: 1050 as any,
        exitReason: "signal",
    });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300, resolved_outcome_up: 1 });
    const pricePoints = [
        makePricePoint({ ts: 1020, yes_price: 0.50, no_price: 0.50 }),
        makePricePoint({ ts: 1050, yes_price: 0.60, no_price: 0.40 }),
    ];

    const { results, summary } = evaluateSignalExitTrades({
        trades: [trade],
        outcomes: [outcome],
        pricePoints,
    });

    eq(results.length, 1, "one result");
    const r = results[0]!;
    eq(r.exitSource, "signal", "exited by signal");
    approx(r.entryPrice!, 0.50, 0.001, "entry price is yes at 1020");
    approx(r.exitPrice!, 0.60, 0.001, "exit price is yes at 1050");
    approx(r.pnl!, 0.10, 0.001, "pnl = exit - entry = 0.10");
    ok(r.isProfitable === true, "long profitable");
    eq(summary.scoredTrades, 1, "1 scored trade");
    eq(summary.signalExitedTrades, 1, "1 signal exited");
    eq(summary.resolvedTrades, 0, "0 resolved");
}

console.log("\n=== evaluateSignalExitTrades: prebuilt price index ===");

{
    const trade = makeTrade({
        type: "long",
        entryTime: 1020 as any,
        exitTime: 1050 as any,
        exitReason: "signal",
    });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300, resolved_outcome_up: 1 });
    const pricePoints = [
        makePricePoint({ ts: 1020, yes_price: 0.50, no_price: 0.50 }),
        makePricePoint({ ts: 1050, yes_price: 0.60, no_price: 0.40 }),
    ];
    const priceIndex = indexPricePointsByEvent(pricePoints);
    const outcomeByEntryTs = indexSignalExitOutcomesByEntryTs([1020], [outcome]);

    const fromRaw = evaluateSignalExitTrades({
        trades: [trade],
        outcomes: [outcome],
        pricePoints,
    });
    const fromIndex = evaluateSignalExitTrades({
        trades: [trade],
        outcomes: [outcome],
        priceIndex,
        outcomeByEntryTs,
    });

    eq(fromIndex.results.length, fromRaw.results.length, "prebuilt index keeps result count");
    eq(fromIndex.results[0]!.exitSource, fromRaw.results[0]!.exitSource, "prebuilt index keeps exit source");
    approx(fromIndex.results[0]!.pnl!, fromRaw.results[0]!.pnl!, 0.000001, "prebuilt index keeps pnl");
    approx(fromIndex.summary.netPnl, fromRaw.summary.netPnl, 0.000001, "prebuilt index keeps summary pnl");
}

console.log("\n=== evaluateSignalExitTrades: short enters and exits by signal ===");

{
    const trade = makeTrade({
        id: 2,
        type: "short",
        entryTime: 1020 as any,
        exitTime: 1050 as any,
        exitReason: "signal",
    });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300, resolved_outcome_up: 0 });
    const pricePoints = [
        makePricePoint({ ts: 1020, yes_price: 0.50, no_price: 0.50 }),
        makePricePoint({ ts: 1050, yes_price: 0.40, no_price: 0.60 }),
    ];

    const { results } = evaluateSignalExitTrades({
        trades: [trade],
        outcomes: [pricePoints.length > 0 ? outcome : outcome],
        pricePoints,
    });

    eq(results.length, 1, "one result");
    const r = results[0]!;
    eq(r.exitSource, "signal", "short exited by signal");
    approx(r.entryPrice!, 0.50, 0.001, "entry price is no at 1020");
    approx(r.exitPrice!, 0.60, 0.001, "exit price is no at 1050");
    approx(r.pnl!, 0.10, 0.001, "pnl = 0.60 - 0.50 = 0.10");
    ok(r.isProfitable === true, "short profitable");
}

console.log("\n=== evaluateSignalExitTrades: no same-event signal exit → resolution ===");

{
    const trade = makeTrade({
        entryTime: 1020 as any,
        exitTime: 1350 as any,
        exitReason: "stop_loss",
    });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300, resolved_outcome_up: 1 });
    const pricePoints = [
        makePricePoint({ ts: 1020, yes_price: 0.50, no_price: 0.50 }),
    ];

    const { results } = evaluateSignalExitTrades({
        trades: [trade],
        outcomes: [outcome],
        pricePoints,
    });

    const r = results[0]!;
    eq(r.exitSource, "resolution", "non-signal exit → resolution");
    approx(r.exitPrice!, 1, 0.001, "YES side, outcome up → 1");
}

console.log("\n=== evaluateSignalExitTrades: chart-exit mode exits on non-signal chart close ===");

{
    const trade = makeTrade({
        entryTime: 1020 as any,
        exitTime: 1050 as any,
        exitReason: "time_stop",
    });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300, resolved_outcome_up: 0 });
    const pricePoints = [
        makePricePoint({ ts: 1020, yes_price: 0.50, no_price: 0.50 }),
        makePricePoint({ ts: 1050, yes_price: 0.62, no_price: 0.38 }),
    ];

    const { results, summary } = evaluateSignalExitTrades({
        trades: [trade],
        outcomes: [outcome],
        pricePoints,
        evaluationMode: "chart_exit_same_event",
    });

    const r = results[0]!;
    eq(r.exitSource, "signal", "chart close uses same-event quote exit source");
    approx(r.exitPrice!, 0.62, 0.001, "YES side exits at chart close quote");
    approx(r.pnl!, 0.12, 0.001, "pnl uses chart close quote, not final outcome");
    eq(summary.signalExitedTrades, 1, "same-event exit counted");
    eq(summary.resolvedTrades, 0, "resolution fallback not used");
    const annotation = buildTradeAnnotationFromSignalExitResult(r, "chart_exit_same_event");
    eq(annotation?.evaluationMode, "chart_exit_same_event", "annotation stores chart-exit mode");
}

console.log("\n=== evaluateSignalExitTrades: duplicate trades inside one event ===");

{
    const t1 = makeTrade({ id: 1, entryTime: 1020 as any, exitReason: "signal" });
    const t2 = makeTrade({ id: 2, entryTime: 1040 as any, exitReason: "signal" });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300 });
    const pricePoints = [
        makePricePoint({ ts: 1020, yes_price: 0.50, no_price: 0.50 }),
        makePricePoint({ ts: 1050, yes_price: 0.60, no_price: 0.40 }),
    ];

    const { results, summary } = evaluateSignalExitTrades({
        trades: [t1, t2],
        outcomes: [outcome],
        pricePoints,
    });

    eq(results.length, 2, "two results emitted: one scored, one duplicate");
    eq(results[0]!.trade.id, 1, "first trade wins");
    eq(results[0]!.exitSource !== "duplicate", true, "first trade is not duplicate");
    eq(results[1]!.exitSource, "duplicate", "second trade is marked as duplicate");
    eq(results[1]!.pnl, null, "duplicate trade has no pnl");
    eq(summary.duplicateTradesIgnored, 1, "duplicate trade counted");
    eq(summary.unscoredTrades, 1, "duplicate trade counted as unscored");
}

console.log("\n=== evaluateSignalExitTrades: missing outcome row → unscored ===");

{
    const trade = makeTrade({ entryTime: 1500 as any });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300 });
    const pricePoints = [
        makePricePoint({ ts: 1020, yes_price: 0.50, no_price: 0.50 }),
    ];

    const { results, summary } = evaluateSignalExitTrades({
        trades: [trade],
        outcomes: [outcome],
        pricePoints,
    });

    eq(results.length, 1, "one result emitted");
    eq(results[0]!.exitSource, "no_event", "trade is marked as no_event");
    eq(summary.missingOutcomeTrades, 1, "missing outcome row counted");
    eq(summary.unscoredTrades, 1, "missing outcome row counted as unscored");
}

console.log("\n=== evaluateSignalExitTrades: missing entry quote → unscored ===");

{
    const trade = makeTrade({ entryTime: 1020 as any });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300 });
    const pricePoints: PolymarketPricePoint[] = [];

    const { results, summary } = evaluateSignalExitTrades({
        trades: [trade],
        outcomes: [outcome],
        pricePoints,
    });

    eq(results.length, 1, "result exists but with missing source");
    eq(results[0]!.exitSource, "missing", "exit source is missing");
    eq(summary.missingPriceTrades, 1, "1 missing price trade");
    eq(summary.scoredTrades, 0, "0 scored trades");
}

console.log("\n=== evaluateSignalExitTrades: entry price filter skips edge-priced trades ===");

{
    const trade = makeTrade({ entryTime: 1020 as any });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300, resolved_outcome_up: 1 });
    const pricePoints = [
        makePricePoint({ ts: 1020, yes_price: 0.2, no_price: 0.8 }),
        makePricePoint({ ts: 1050, yes_price: 0.3, no_price: 0.7 }),
    ];

    const { results, summary } = evaluateSignalExitTrades({
        trades: [trade],
        outcomes: [outcome],
        pricePoints,
        entryPriceFilterCents: 20,
    });
    const annotation = buildTradeAnnotationFromSignalExitResult(results[0]!);

    eq(results[0]!.exitSource, "entry_price_filtered", "edge entry is marked as price-filtered");
    eq(summary.entryPriceFilteredTrades, 1, "price-filtered trade counted");
    eq(summary.scoredTrades, 0, "price-filtered trade is not scored");
    eq(summary.unscoredTrades, 1, "price-filtered trade is unscored");
    eq(annotation?.marketExitSource, "entry_price_filtered", "annotation preserves price-filtered source");
    eq(annotation?.marketEntryPrice, 0.2, "annotation keeps the filtered entry price");
}

console.log("\n=== evaluateSignalExitTrades: optional entry cutoff skips late-event trades ===");

{
    const trade = makeTrade({ entryTime: 1288 as any, exitTime: 1290 as any, exitReason: "take_profit" });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300, resolved_outcome_up: 1 });
    const pricePoints = [
        makePricePoint({ ts: 1288, yes_price: 0.55, no_price: 0.45 }),
    ];

    const disabled = evaluateSignalExitTrades({
        trades: [trade],
        outcomes: [outcome],
        pricePoints,
        entryCutoffSeconds: 15,
    });
    const enabled = evaluateSignalExitTrades({
        trades: [trade],
        outcomes: [outcome],
        pricePoints,
        entryCutoffEnabled: true,
        entryCutoffSeconds: 15,
    });
    const annotation = buildTradeAnnotationFromSignalExitResult(enabled.results[0]!);

    eq(disabled.summary.scoredTrades, 1, "cutoff seconds alone does not filter");
    eq(enabled.results[0]!.exitSource, "entry_time_filtered", "late entry is marked as time-filtered");
    eq(enabled.summary.entryTimeFilteredTrades, 1, "time-filtered trade counted");
    eq(enabled.summary.scoredTrades, 0, "time-filtered trade is not scored");
    eq(enabled.summary.unscoredTrades, 1, "time-filtered trade is unscored");
    eq(annotation?.marketExitSource, "entry_time_filtered", "annotation preserves time-filtered source");
}

console.log("\n=== evaluateSignalExitTrades: same entry quote can also serve as a flat same-event exit ===");

{
    const trade = makeTrade({
        entryTime: 1015 as any,
        exitTime: 1050 as any,
        exitReason: "signal",
    });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300, resolved_outcome_up: 1 });
    const pricePoints = [
        makePricePoint({ ts: 1020, yes_price: 0.55, no_price: 0.45 }),
    ];

    const { results, summary } = evaluateSignalExitTrades({
        trades: [trade],
        outcomes: [outcome],
        pricePoints,
    });

    const r = results[0]!;
    ok(r.entryPrice !== null, "entry fill found at 1020 >= 1015");
    eq(r.exitSource, "signal", "latest quote before exit can reuse the entry quote");
    approx(r.exitPrice!, 0.55, 0.001, "exit price reuses the entry quote");
    eq(r.pnl, 0, "same-quote exit produces flat pnl");
    eq(summary.missingPriceTrades, 0, "no missing price trade");
    eq(summary.scoredTrades, 1, "trade is scored");
    eq(summary.neutralTrades, 1, "flat same-quote exit is neutral");
}

console.log("\n=== evaluateSignalExitTrades: optional multi-trade signal exit per event ===");

{
    const t1 = makeTrade({ id: 1, entryTime: 1020 as any, exitTime: 1030 as any, exitReason: "signal" });
    const t2 = makeTrade({ id: 2, entryTime: 1040 as any, exitTime: 1050 as any, exitReason: "signal" });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300 });
    const pricePoints = [
        makePricePoint({ ts: 1020, yes_price: 0.50, no_price: 0.50 }),
        makePricePoint({ ts: 1030, yes_price: 0.60, no_price: 0.40 }),
        makePricePoint({ ts: 1040, yes_price: 0.55, no_price: 0.45 }),
        makePricePoint({ ts: 1050, yes_price: 0.58, no_price: 0.42 }),
    ];

    const { results, summary } = evaluateSignalExitTrades({
        trades: [t1, t2],
        outcomes: [outcome],
        pricePoints,
        allowMultipleTradesPerEvent: true,
    });

    eq(results.length, 2, "two results emitted");
    eq(results[0]!.exitSource, "signal", "first trade exits by signal");
    eq(results[1]!.exitSource, "signal", "second same-event trade also exits by signal");
    eq(summary.scoredTrades, 2, "both same-event trades are scored");
    eq(summary.duplicateTradesIgnored, 0, "no duplicate trades counted");
    eq(summary.unscoredTrades, 0, "no duplicate unscored trades");
    eq(summary.allowMultipleTradesPerEvent, true, "summary records multi-trade mode");
    approx(summary.netPnl, 0.13, 0.001, "both trade pnls contribute");
}

console.log("\n=== evaluateSignalExitTrades: zero-offset limit entry can reuse the signal-exit quote ===");

{
    const trade = makeTrade({
        entryTime: 1015 as any,
        exitTime: 1050 as any,
        exitReason: "signal",
    });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300, resolved_outcome_up: 1 });
    const pricePoints = [
        makePricePoint({ ts: 1050, yes_price: 0.55, no_price: 0.45 }),
    ];

    const { results, summary } = evaluateSignalExitTrades({
        trades: [trade],
        outcomes: [outcome],
        pricePoints,
        limitEntry: {
            enabled: true,
            priceMode: "signal_offset",
            offsetCents: 0,
            priceCents: 50,
        },
    });

    const r = results[0]!;
    eq(r.entrySource, "limit", "entry source is limit");
    eq(r.entryStatus, "filled", "zero-offset limit entry fills at the signal-exit quote");
    eq(r.entryFillTs, 1050, "limit entry uses the exact signal-exit timestamp");
    approx(r.entryPrice!, 0.55, 0.001, "entry price uses the first available quote");
    eq(r.exitSource, "signal", "signal exit still wins at the same timestamp");
    approx(r.exitPrice!, 0.55, 0.001, "exit reuses the same quote");
    eq(r.pnl, 0, "same-timestamp limit entry and signal exit is flat");
    eq(summary.scoredTrades, 1, "trade is scored");
    eq(summary.limitEntryFilledTrades, 1, "limit entry fill counted");
    eq(summary.limitEntryMissedTrades, 0, "zero-offset exact timestamp is not missed");
    eq(summary.neutralTrades, 1, "flat same-timestamp trade is neutral");
}

console.log("\n=== evaluateSignalExitTrades: fixed limit entry is flat when filled on the signal-exit quote ===");

{
    const trade = makeTrade({
        entryTime: 1015 as any,
        exitTime: 1050 as any,
        exitReason: "signal",
    });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300, resolved_outcome_up: 1 });
    const pricePoints = [
        makePricePoint({ ts: 1020, yes_price: 0.70, no_price: 0.30 }),
        makePricePoint({ ts: 1050, yes_price: 0.55, no_price: 0.45 }),
    ];

    const { results, summary } = evaluateSignalExitTrades({
        trades: [trade],
        outcomes: [outcome],
        pricePoints,
        limitEntry: {
            enabled: true,
            priceMode: "fixed_price",
            priceCents: 60,
        },
    });

    const r = results[0]!;
    eq(r.entryStatus, "filled", "fixed limit fills on the signal-exit quote");
    eq(r.entryFillTs, 1050, "entry fill uses the exact signal-exit timestamp");
    approx(r.entryPrice!, 0.60, 0.001, "entry remains the fixed limit price");
    eq(r.exitSource, "signal", "same quote is still treated as a signal exit");
    approx(r.exitPrice!, 0.60, 0.001, "same-timestamp signal exit is flat to the limit fill");
    eq(r.pnl, 0, "same-timestamp fixed limit fill and signal exit is flat");
    eq(summary.scoredTrades, 1, "trade is scored");
    eq(summary.neutralTrades, 1, "flat same-timestamp fixed limit trade is neutral");
    eq(summary.losingTrades, 0, "same-timestamp fixed limit fill is not an instant loss");
}

console.log("\n=== evaluateSignalExitTrades: entry quote after the chart exit stays missing ===");

{
    const trade = makeTrade({
        entryTime: 1015 as any,
        exitTime: 1050 as any,
        exitReason: "signal",
    });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300, resolved_outcome_up: 1 });
    const pricePoints = [
        makePricePoint({ ts: 1080, yes_price: 0.60, no_price: 0.40 }),
    ];

    const { results, summary } = evaluateSignalExitTrades({
        trades: [trade],
        outcomes: [outcome],
        pricePoints,
    });

    const r = results[0]!;
    ok(r.entryPrice !== null, "entry fill can still be found after the chart exit");
    eq(r.exitSource, "missing", "no local quote exists at or before the chart exit after entry pricing");
    eq(r.exitPrice, null, "exit price is null for missing quote");
    eq(summary.missingPriceTrades, 1, "1 missing price trade");
    eq(summary.scoredTrades, 0, "0 scored trades");
}

console.log("\n=== evaluateSignalExitTrades: missing first trade does not block later resolution in the same event ===");

{
    const t1 = makeTrade({
        id: 10,
        type: "long",
        entryTime: 1015 as any,
        exitTime: 1050 as any,
        exitReason: "signal",
    });
    const t2 = makeTrade({
        id: 11,
        type: "short",
        entryTime: 1060 as any,
        exitTime: 1090 as any,
        exitReason: "time_stop",
    });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300, resolved_outcome_up: 1 });
    const pricePoints = [
        makePricePoint({ ts: 1080, yes_price: 0.60, no_price: 0.40 }),
    ];

    const { results, summary } = evaluateSignalExitTrades({
        trades: [t1, t2],
        outcomes: [outcome],
        pricePoints,
    });

    eq(results.length, 2, "two results emitted");
    eq(results[0]!.exitSource, "missing", "first trade stays missing");
    eq(results[1]!.exitSource, "resolution", "later trade scores by resolution");
    approx(results[1]!.entryPrice!, 0.40, 0.001, "later short uses NO entry fill");
    approx(results[1]!.exitPrice!, 0, 0.001, "outcome up resolves NO to 0");
    eq(summary.missingPriceTrades, 1, "missing first trade counted once");
    eq(summary.resolvedTrades, 1, "later trade counted as resolved");
    eq(summary.scoredTrades, 1, "later trade is scored");
    eq(summary.duplicateTradesIgnored, 0, "later scored trade is not forced into duplicate");
}

console.log("\n=== evaluateSignalExitTrades: missing first trade does not block later signal exit in the same event ===");

{
    const t1 = makeTrade({
        id: 12,
        type: "long",
        entryTime: 1015 as any,
        exitTime: 1050 as any,
        exitReason: "signal",
    });
    const t2 = makeTrade({
        id: 13,
        type: "long",
        entryTime: 1070 as any,
        exitTime: 1115 as any,
        exitReason: "signal",
    });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300, resolved_outcome_up: 1 });
    const pricePoints = [
        makePricePoint({ ts: 1080, yes_price: 0.60, no_price: 0.40 }),
        makePricePoint({ ts: 1110, yes_price: 0.66, no_price: 0.34 }),
    ];

    const { results, summary } = evaluateSignalExitTrades({
        trades: [t1, t2],
        outcomes: [outcome],
        pricePoints,
    });

    eq(results.length, 2, "two results emitted");
    eq(results[0]!.exitSource, "missing", "first trade stays missing");
    eq(results[1]!.exitSource, "signal", "later trade scores by signal exit");
    approx(results[1]!.entryPrice!, 0.60, 0.001, "later long uses later entry fill");
    approx(results[1]!.exitPrice!, 0.66, 0.001, "later long uses later signal exit fill");
    eq(summary.missingPriceTrades, 1, "missing first trade counted once");
    eq(summary.signalExitedTrades, 1, "later trade counted as signal-exited");
    eq(summary.scoredTrades, 1, "later trade is scored");
    eq(summary.duplicateTradesIgnored, 0, "later scored trade is not forced into duplicate");
}

console.log("\n=== evaluateSignalExitTrades: post-signal limit entry fills at the configured price ===");

{
    const trade = makeTrade({
        id: 20,
        type: "long",
        entryTime: 1010 as any,
        exitTime: 1080 as any,
        exitReason: "signal",
    });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300, resolved_outcome_up: 1 });
    const pricePoints = [
        makePricePoint({ ts: 1010, yes_price: 0.60, no_price: 0.40 }),
        makePricePoint({ ts: 1030, yes_price: 0.50, no_price: 0.50 }),
        makePricePoint({ ts: 1080, yes_price: 0.62, no_price: 0.38 }),
    ];

    const { results, summary } = evaluateSignalExitTrades({
        trades: [trade],
        outcomes: [outcome],
        pricePoints,
        limitEntry: { enabled: true, priceCents: 50 },
    });

    const r = results[0]!;
    eq(r.entrySource, "limit", "entry source is limit");
    eq(r.entryStatus, "filled", "limit entry filled");
    eq(r.entryFillTs, 1030, "limit fill timestamp is retained");
    approx(r.entryPrice!, 0.50, 0.001, "entry price is configured limit");
    approx(r.exitPrice!, 0.62, 0.001, "signal exit uses existing quote logic");
    approx(r.pnl!, 0.12, 0.001, "pnl uses limit entry price");
    eq(summary.scoredTrades, 1, "filled limit entry is scored");
    eq(summary.limitEntryAttempts, 1, "one limit attempt");
    eq(summary.limitEntryFilledTrades, 1, "one limit fill");
    eq(summary.missingPriceTrades, 0, "filled limit entry is not missing price");
    approx(summary.avgLimitEntryImprovement!, 0.10, 0.001, "entry improvement uses first available side price");
}

console.log("\n=== evaluateSignalExitTrades: target exit can beat chart signal exit ===");

{
    const trade = makeTrade({
        id: 23,
        type: "long",
        entryTime: 1010 as any,
        exitTime: 1080 as any,
        exitReason: "signal",
    });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300, resolved_outcome_up: 0 });
    const pricePoints = [
        makePricePoint({ ts: 1010, yes_price: 0.60, no_price: 0.40 }),
        makePricePoint({ ts: 1040, yes_price: 0.82, no_price: 0.18 }),
        makePricePoint({ ts: 1080, yes_price: 0.70, no_price: 0.30 }),
    ];

    const { results, summary } = evaluateSignalExitTrades({
        trades: [trade],
        outcomes: [outcome],
        pricePoints,
        limitEntry: {
            enabled: true,
            priceCents: 60,
            exitEnabled: true,
            exitMode: "entry_offset",
            exitOffsetCents: 20,
        },
    });

    const r = results[0]!;
    eq(r.exitSource, "target", "target exit fills before chart signal");
    approx(r.exitTargetPrice!, 0.80, 0.001, "target is entry + 20c");
    approx(r.exitPrice!, 0.80, 0.001, "exit price is target limit");
    approx(r.pnl!, 0.20, 0.001, "target pnl is realized before resolution");
    eq(summary.targetExitedTrades, 1, "target exit counted");
    eq(summary.signalExitedTrades, 0, "chart signal did not execute after target");
    eq(summary.limitExitFilledTrades, 1, "limit exit fill counted");
}

console.log("\n=== evaluateSignalExitTrades: chart signal can beat target exit ===");

{
    const trade = makeTrade({
        id: 24,
        type: "long",
        entryTime: 1010 as any,
        exitTime: 1030 as any,
        exitReason: "signal",
    });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300, resolved_outcome_up: 1 });
    const pricePoints = [
        makePricePoint({ ts: 1010, yes_price: 0.60, no_price: 0.40 }),
        makePricePoint({ ts: 1030, yes_price: 0.65, no_price: 0.35 }),
        makePricePoint({ ts: 1060, yes_price: 0.82, no_price: 0.18 }),
    ];

    const { results, summary } = evaluateSignalExitTrades({
        trades: [trade],
        outcomes: [outcome],
        pricePoints,
        limitEntry: {
            enabled: true,
            priceCents: 60,
            exitEnabled: true,
            exitMode: "entry_offset",
            exitOffsetCents: 20,
        },
    });

    const r = results[0]!;
    eq(r.exitSource, "signal", "chart signal exits before later target touch");
    approx(r.exitTargetPrice!, 0.80, 0.001, "target was still tracked");
    approx(r.exitPrice!, 0.65, 0.001, "signal exit price wins the race");
    eq(summary.signalExitedTrades, 1, "signal exit counted");
    eq(summary.targetExitedTrades, 0, "target exit not counted");
    eq(summary.limitExitFallbackTrades, 1, "unfilled target falls back to signal");
}

console.log("\n=== evaluateSignalExitTrades: unreachable target falls back to resolution ===");

{
    const trade = makeTrade({
        id: 25,
        type: "long",
        entryTime: 1010 as any,
        exitReason: "time_stop",
    });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300, resolved_outcome_up: 1 });
    const pricePoints = [
        makePricePoint({ ts: 1010, yes_price: 0.80, no_price: 0.20 }),
        makePricePoint({ ts: 1040, yes_price: 0.90, no_price: 0.10 }),
    ];

    const { results, summary } = evaluateSignalExitTrades({
        trades: [trade],
        outcomes: [outcome],
        pricePoints,
        limitEntry: {
            enabled: true,
            priceCents: 80,
            exitEnabled: true,
            exitMode: "entry_offset",
            exitOffsetCents: 20,
        },
    });

    const r = results[0]!;
    eq(r.exitSource, "resolution", "unreachable target falls back to resolve hold");
    eq(r.exitTargetPrice, null, "target at or above $1 is represented as null");
    eq(r.exitStatus, "unreachable", "unreachable status retained");
    approx(r.exitPrice!, 1, 0.001, "resolved YES win exits at $1");
    eq(summary.limitExitUnreachableTrades, 1, "unreachable target counted");
    eq(summary.limitExitFallbackTrades, 1, "resolution fallback counted");
}

console.log("\n=== evaluateSignalExitTrades: missed limit attempt does not block a later same-event fill ===");

{
    const t1 = makeTrade({
        id: 21,
        type: "long",
        entryTime: 1010 as any,
        exitTime: 1060 as any,
        exitReason: "signal",
    });
    const t2 = makeTrade({
        id: 22,
        type: "long",
        entryTime: 1090 as any,
        exitTime: 1120 as any,
        exitReason: "signal",
    });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300, resolved_outcome_up: 1 });
    const pricePoints = [
        makePricePoint({ ts: 1010, yes_price: 0.70, no_price: 0.30 }),
        makePricePoint({ ts: 1090, yes_price: 0.49, no_price: 0.51 }),
        makePricePoint({ ts: 1120, yes_price: 0.60, no_price: 0.40 }),
    ];

    const { results, summary } = evaluateSignalExitTrades({
        trades: [t1, t2],
        outcomes: [outcome],
        pricePoints,
        limitEntry: { enabled: true, priceCents: 50 },
    });

    eq(results.length, 2, "two results emitted");
    eq(results[0]!.entryStatus, "invalid_window", "first limit touch after signal exit is invalid");
    eq(results[0]!.exitSource, "missing", "invalid limit attempt is unscored");
    eq(results[1]!.entryStatus, "filled", "later same-event trade can still fill");
    eq(results[1]!.exitSource, "signal", "later filled trade exits by its own signal");
    approx(results[1]!.pnl!, 0.10, 0.001, "later filled trade keeps its realized signal-exit pnl");
    eq(summary.limitEntryAttempts, 2, "both limit attempts count");
    eq(summary.limitEntryFilledTrades, 1, "later limit fill counted");
    eq(summary.limitEntryMissedTrades, 1, "missed attempt counted");
    eq(summary.limitEntryInvalidWindowTrades, 1, "invalid-window attempt counted");
    eq(summary.duplicateTradesIgnored, 0, "unfilled attempt does not force a duplicate");
    eq(summary.scoredTrades, 1, "later filled trade is scored");
    eq(summary.missingPriceTrades, 0, "invalid limit window is not generic missing price");
}

console.log("\n=== evaluateSignalExitTrades: zero pnl is neutral, not profitable ===");

{
    const trade = makeTrade({
        entryTime: 1015 as any,
        exitTime: 1050 as any,
        exitReason: "signal",
    });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300, resolved_outcome_up: 1 });
    const pricePoints = [
        makePricePoint({ ts: 1020, yes_price: 0.55, no_price: 0.45 }),
        makePricePoint({ ts: 1050, yes_price: 0.55, no_price: 0.45 }),
    ];

    const { results, summary } = evaluateSignalExitTrades({
        trades: [trade],
        outcomes: [outcome],
        pricePoints,
    });

    eq(results[0]!.pnl, 0, "trade pnl is zero");
    eq(results[0]!.isProfitable, null, "trade-level isProfitable stays neutral at zero pnl");
    eq(summary.scoredTrades, 1, "trade is still scored");
    eq(summary.profitableTrades, 0, "zero pnl does not count as profitable");
    eq(summary.losingTrades, 0, "zero pnl does not count as losing");
    eq(summary.neutralTrades, 1, "zero pnl counts as neutral");
    eq(summary.profitFactor, 0, "zero pnl contributes no profit factor");
}

console.log("\n=== buildTradeAnnotationFromSignalExitResult ===");

{
    const trade = makeTrade({ entryTime: 1020 as any, exitReason: "signal" });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300 });
    const annotation = buildTradeAnnotationFromSignalExitResult({
        trade,
        outcome,
        side: "yes",
        entryPrice: 0.50,
        exitPrice: 0.60,
        exitTs: 1050,
        exitSource: "signal",
        pnl: 0.10,
        isProfitable: true,
        actualOutcomeUp: 1,
        isWin: true,
    });

    if (annotation === null) throw new Error("expected signal-exit annotation");
    eq(annotation.evaluationMode, "signal_exit_same_event", "mode is signal_exit_same_event");
    eq(annotation.marketExitSource, "signal", "exit source is signal");
    approx(annotation.marketPnl!, 0.10, 0.001, "pnl annotated");
    ok(annotation.isProfitable === true, "isProfitable annotated");
}

{
    const trade = makeTrade({ entryTime: 1020 as any, exitReason: "signal" });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300 });
    const annotation = buildTradeAnnotationFromSignalExitResult({
        trade,
        outcome,
        side: "yes",
        entryPrice: 0.50,
        exitPrice: null,
        exitTs: null,
        exitSource: "missing",
        pnl: null,
        isProfitable: null,
        actualOutcomeUp: 1,
        isWin: true,
    });

    eq(annotation, null, "missing-price results do not create trade annotations");
}

console.log("\n=== settings resolver: polymarketExitMode ===");

{
    const withSignalExit = resolveBacktestSettingsFromRaw({
        polymarketExitMode: "signal_exit_same_event",
        polymarketSignalExitAllowMultipleTradesPerEvent: true,
        riskSettingsToggle: true,
    } as any);
    eq(withSignalExit.polymarketExitMode, "signal_exit_same_event", "signal_exit_same_event preserved");
    eq(withSignalExit.polymarketSignalExitAllowMultipleTradesPerEvent, true, "multi-trade setting preserved");
    const withChartExit = resolveBacktestSettingsFromRaw({
        polymarketExitMode: "chart_exit_same_event",
        riskSettingsToggle: true,
    } as any);
    eq(withChartExit.polymarketExitMode, "chart_exit_same_event", "chart_exit_same_event preserved");

    const withDefault = resolveBacktestSettingsFromRaw({
        riskSettingsToggle: true,
    } as any);
    eq(withDefault.polymarketExitMode, "resolve_hold", "default is resolve_hold");
    eq(withDefault.polymarketSignalExitAllowMultipleTradesPerEvent, false, "multi-trade default is false");

    const withInvalid = resolveBacktestSettingsFromRaw({
        polymarketExitMode: "invalid_mode",
        riskSettingsToggle: true,
    } as any);
    eq(withInvalid.polymarketExitMode, "resolve_hold", "invalid mode → resolve_hold");
}

console.log("\n=== hunt model: polymarketExitMode ===");

{
    eq(DEFAULT_HUNT_RUN_SETTINGS.polymarketExitMode, "resolve_hold", "hunt default is resolve_hold");
    eq(DEFAULT_HUNT_RUN_SETTINGS.polymarketSignalExitAllowMultipleTradesPerEvent, false, "hunt multi-trade default is false");

    const withSignalExit = normalizeStoredHuntRunSettings({
        polymarketExitMode: "signal_exit_same_event",
        polymarketSignalExitAllowMultipleTradesPerEvent: true,
    });
    eq(withSignalExit.polymarketExitMode, "signal_exit_same_event", "hunt preserves signal_exit_same_event");
    eq(withSignalExit.polymarketSignalExitAllowMultipleTradesPerEvent, true, "hunt preserves multi-trade setting");
    const withChartExit = normalizeStoredHuntRunSettings({
        polymarketExitMode: "chart_exit_same_event",
    });
    eq(withChartExit.polymarketExitMode, "chart_exit_same_event", "hunt preserves chart_exit_same_event");

    const withInvalid = normalizeStoredHuntRunSettings({
        polymarketExitMode: "garbage",
    });
    eq(withInvalid.polymarketExitMode, "resolve_hold", "hunt invalid → resolve_hold");
}

});
