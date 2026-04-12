import { evaluateSignalExitTrades, buildTradeAnnotationFromSignalExitResult } from "../lib/polymarket-signal-exit-evaluator";
import { indexPricePointsByEvent, findEntryFill, findSignalExitFill } from "../lib/polymarket-price-points";
import { resolveEffectivePolymarketExitMode, isSignalExitSameEventMode, SIGNAL_EXIT_SUPPORTED_RANK_MODES } from "../lib/polymarket-exit-mode";
import type { PolymarketPricePoint } from "../lib/local-sqlite-polymarket-api";
import type { PolymarketOutcomeRow } from "../lib/types/polymarket-outcomes";
import type { Trade } from "../lib/types/strategies";
import { resolveBacktestSettingsFromRaw } from "../lib/backtest-settings-resolver";
import { normalizeStoredHuntRunSettings, DEFAULT_HUNT_RUN_SETTINGS } from "../lib/hunt/hunt-model";

let testCount = 0;
let passCount = 0;
let failCount = 0;

function ok(cond: boolean, label: string): void {
    testCount++;
    if (cond) {
        passCount++;
        console.log(`  ✓ ${label}`);
    } else {
        failCount++;
        console.error(`  ✗ ${label}`);
    }
}

function eq<T>(actual: T, expected: T, label: string): void {
    ok(actual === expected, `${label} → ${JSON.stringify(actual)} === ${JSON.stringify(expected)}`);
}

function approx(actual: number, expected: number, tolerance: number, label: string): void {
    ok(Math.abs(actual - expected) <= tolerance, `${label} → ${actual} ≈ ${expected} (±${tolerance})`);
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
    "signal_close execution → downgrade to resolve_hold"
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

console.log("\n=== isSignalExitSameEventMode ===");

ok(isSignalExitSameEventMode("signal_exit_same_event"), "signal_exit_same_event is signal exit");
ok(!isSignalExitSameEventMode("resolve_hold"), "resolve_hold is not signal exit");
ok(!isSignalExitSameEventMode(undefined), "undefined is not signal exit");

console.log("\n=== SIGNAL_EXIT_SUPPORTED_RANK_MODES ===");

ok(SIGNAL_EXIT_SUPPORTED_RANK_MODES.has("expectancy"), "expectancy is supported");
ok(SIGNAL_EXIT_SUPPORTED_RANK_MODES.has("profitFactor"), "profitFactor is supported");
ok(!SIGNAL_EXIT_SUPPORTED_RANK_MODES.has("balanced"), "balanced is not supported");
ok(!SIGNAL_EXIT_SUPPORTED_RANK_MODES.has("accuracy"), "accuracy is not supported");

console.log("\n=== price point indexing ===");

{
    const points = [
        makePricePoint({ ts: 1010, yes_price: 0.50, no_price: 0.50 }),
        makePricePoint({ ts: 1020, yes_price: 0.55, no_price: 0.45 }),
        makePricePoint({ ts: 1050, yes_price: 0.60, no_price: 0.40 }),
    ];

    const index = indexPricePointsByEvent(points);
    ok(index.pointsByEventStart.has(1000), "event indexed");
    const eventPoints = index.pointsByEventStart.get(1000)!;
    eq(eventPoints.length, 3, "three points in event");
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
}

console.log("\n=== findSignalExitFill ===");

{
    const points = [
        makePricePoint({ ts: 1010, yes_price: 0.50, no_price: 0.50 }),
        makePricePoint({ ts: 1020, yes_price: 0.55, no_price: 0.45 }),
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

    const { results, summary } = evaluateSignalExitTrades({
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

console.log("\n=== evaluateSignalExitTrades: duplicate trades inside one event ===");

{
    const t1 = makeTrade({ id: 1, entryTime: 1020 as any, exitReason: "signal" });
    const t2 = makeTrade({ id: 2, entryTime: 1040 as any, exitReason: "signal" });
    const outcome = makeOutcome({ event_start_ts: 1000, event_end_ts: 1300 });
    const pricePoints = [
        makePricePoint({ ts: 1020, yes_price: 0.50, no_price: 0.50 }),
    ];

    const { results } = evaluateSignalExitTrades({
        trades: [t1, t2],
        outcomes: [outcome],
        pricePoints,
    });

    eq(results.length, 1, "only one trade scored per event");
    eq(results[0]!.trade.id, 1, "first trade wins");
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

console.log("\n=== evaluateSignalExitTrades: missing same-event exit quote → unscored ===");

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
    eq(r.exitSource, "missing", "exit ts=1050 but only point at 1020 is before entry; no usable exit quote → missing");
    eq(r.exitPrice, null, "exit price is null for missing quote");
    eq(summary.missingPriceTrades, 1, "1 missing price trade");
    eq(summary.scoredTrades, 0, "0 scored trades");
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

    eq(annotation.evaluationMode, "signal_exit_same_event", "mode is signal_exit_same_event");
    eq(annotation.marketExitSource, "signal", "exit source is signal");
    approx(annotation.marketPnl!, 0.10, 0.001, "pnl annotated");
    ok(annotation.isProfitable === true, "isProfitable annotated");
}

console.log("\n=== settings resolver: polymarketExitMode ===");

{
    const withSignalExit = resolveBacktestSettingsFromRaw({
        polymarketExitMode: "signal_exit_same_event",
        riskSettingsToggle: true,
    } as any);
    eq(withSignalExit.polymarketExitMode, "signal_exit_same_event", "signal_exit_same_event preserved");

    const withDefault = resolveBacktestSettingsFromRaw({
        riskSettingsToggle: true,
    });
    eq(withDefault.polymarketExitMode, "resolve_hold", "default is resolve_hold");

    const withInvalid = resolveBacktestSettingsFromRaw({
        polymarketExitMode: "invalid_mode",
        riskSettingsToggle: true,
    } as any);
    eq(withInvalid.polymarketExitMode, "resolve_hold", "invalid mode → resolve_hold");
}

console.log("\n=== hunt model: polymarketExitMode ===");

{
    eq(DEFAULT_HUNT_RUN_SETTINGS.polymarketExitMode, "resolve_hold", "hunt default is resolve_hold");

    const withSignalExit = normalizeStoredHuntRunSettings({
        polymarketExitMode: "signal_exit_same_event",
    });
    eq(withSignalExit.polymarketExitMode, "signal_exit_same_event", "hunt preserves signal_exit_same_event");

    const withInvalid = normalizeStoredHuntRunSettings({
        polymarketExitMode: "garbage",
    });
    eq(withInvalid.polymarketExitMode, "resolve_hold", "hunt invalid → resolve_hold");
}

console.log("\n=== summary ===");
console.log(`  ${passCount}/${testCount} passed`);
if (failCount > 0) {
    console.error(`  ${failCount} FAILED`);
    process.exit(1);
}
