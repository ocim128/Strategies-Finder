import { expect } from "chai";
import { describe, it } from "node:test";
import type { PolymarketClob1sQuoteRow } from "../lib/second-market/types";
import type { PolymarketOutcomeRow } from "../lib/types/polymarket-outcomes";
import type { Signal, Trade } from "../lib/types/strategies";
import type {
    ExecutionLabOpenPaperPosition,
    ExecutionLabSessionSnapshot,
    PaperEntryRecord,
    PaperExitRecord,
    PaperUnfilledRecord,
} from "../lib/execution-lab/execution-lab-model";
import {
    collectEntryPriceFilterParityMismatches,
} from "../lib/execution-lab/execution-parity";
import {
    buildEvaluatedSignals,
    createExecutionLabPaperState,
    evaluateExecutionLabPaperTick,
} from "../lib/execution-lab/paper-session";

const EVENT_START = 1_700_000_000;
const EVENT_END = EVENT_START + 300;

function snapshot(
    allowMultipleTradesPerEvent = false,
    entryPriceFilterCents = 0,
    entryCutoffEnabled = false,
    entryCutoffSeconds = 15
): ExecutionLabSessionSnapshot {
    return {
        sessionId: "session-1",
        symbol: "BTCUSDT",
        outcomeSymbol: "BTCUSDT",
        interval: "1s",
        strategyKey: "test_strategy",
        strategyName: "Test Strategy",
        params: {},
        backtestSettings: {
            polymarketEntryPriceFilterCents: entryPriceFilterCents,
            polymarketEntryCutoffEnabled: entryCutoffEnabled,
            polymarketEntryCutoffSeconds: entryCutoffSeconds,
        },
        capitalSettings: {
            initialCapital: 10000,
            positionSize: 100,
            commission: 0,
            sizingMode: "percent",
            fixedTradeAmount: 100,
        },
        polymarketSettings: {},
        outcomeInterval: "5m",
        seriesId: "10684",
        exitMode: "resolve_hold",
        allowMultipleTradesPerEvent,
        stakeUsd: 5,
        startedAtIso: "2026-01-01T00:00:00.000Z",
    };
}

function outcome(resolvedUp: 0 | 1, resolutionSource = "test"): PolymarketOutcomeRow {
    return {
        series_id: "10684",
        event_slug: "btc-event",
        market_slug: "btc-event",
        interval: "5m",
        event_start_ts: EVENT_START,
        event_end_ts: EVENT_END,
        yes_token_id: "yes",
        no_token_id: "no",
        yes_open_price: null,
        yes_entry_minute_1_price: null,
        yes_entry_minute_2_price: null,
        yes_entry_minute_3_price: null,
        yes_entry_minute_4_price: null,
        resolved_outcome_up: resolvedUp,
        resolution_source: resolutionSource,
        updated_at: EVENT_END + 1,
    };
}

function quote(ts: number, yesAsk: number, yesBid: number, symbol = "BTCUSDT"): PolymarketClob1sQuoteRow {
    return {
        series_id: "10684",
        symbol: symbol as PolymarketClob1sQuoteRow["symbol"],
        outcome_interval: "5m",
        event_start_ts: EVENT_START,
        event_end_ts: EVENT_END,
        condition_id: "condition",
        market_slug: "btc-event",
        yes_token_id: "yes",
        no_token_id: "no",
        sample_ts: ts,
        yes_bid: yesBid,
        yes_ask: yesAsk,
        yes_mid: (yesAsk + yesBid) / 2,
        yes_last: null,
        no_bid: 1 - yesAsk,
        no_ask: 1 - yesBid,
        no_mid: 0.5,
        no_last: null,
        source: "polymarket_clob_1s",
        source_ts_ms: ts * 1000,
        quote_age_ms: 0,
        quality_flags: "",
        updated_at: ts,
    };
}

function trade(id: number, type: Trade["type"], entryTs: number, exitTs = EVENT_END + 1): Trade {
    return {
        id,
        type,
        entryTime: entryTs,
        entryPrice: 100,
        exitTime: exitTs,
        exitPrice: 101,
        pnl: 1,
        pnlPercent: 1,
        size: 1,
        exitReason: "end_of_data",
    };
}

function signal(type: Signal["type"], ts: number): Signal {
    return {
        time: ts,
        type,
        price: 100,
    };
}

function tick(args: {
    state: ReturnType<typeof createExecutionLabPaperState>;
    latestTs: number;
    trades: Trade[];
    signals?: Signal[];
    quotes?: PolymarketClob1sQuoteRow[];
    outcomes?: PolymarketOutcomeRow[];
}) {
    return evaluateExecutionLabPaperTick(args.state, {
        latestCandleTimeSec: args.latestTs,
        latestCandle: {
            time: args.latestTs,
            open: 100,
            high: 101,
            low: 99,
            close: 100,
            volume: 1,
        },
        trades: args.trades,
        signals: buildEvaluatedSignals(args.signals ?? []),
        quotes: args.quotes ?? [],
        outcomes: args.outcomes ?? [],
        recordedAtIso: "2026-01-01T00:00:01.000Z",
        feedLagSec: 2,
    });
}

describe("Execution Lab paper session", () => {
    it("fills long trades at YES ask and resolves with fixed stake sizing", () => {
        const state = createExecutionLabPaperState(snapshot());
        const result = tick({
            state,
            latestTs: EVENT_END + 1,
            trades: [trade(1, "long", EVENT_START + 10)],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [quote(EVENT_START + 10, 0.5, 0.48)],
            outcomes: [outcome(1)],
        });
        const entry = result.records.find((record): record is PaperEntryRecord => record.recordType === "paper_entry");
        const exit = result.records.find((record): record is PaperExitRecord => record.recordType === "paper_exit");

        expect(entry?.side).to.equal("yes");
        expect(entry?.entryPrice).to.equal(0.5);
        expect(entry?.shares).to.equal(10);
        expect(result.acceptedEntries).to.have.length(1);
        expect(result.acceptedEntries[0]?.conditionId).to.equal("condition");
        expect(result.acceptedEntries[0]?.yesTokenId).to.equal("yes");
        expect(exit?.exitPrice).to.equal(1);
        expect(exit?.pnlUsd).to.equal(5);
        expect(state.realizedPnlUsd).to.equal(5);
    });

    it("fills short trades at NO ask", () => {
        const state = createExecutionLabPaperState(snapshot());
        const result = tick({
            state,
            latestTs: EVENT_END + 1,
            trades: [trade(1, "short", EVENT_START + 10)],
            signals: [signal("sell", EVENT_START + 9)],
            quotes: [quote(EVENT_START + 10, 0.58, 0.56)],
            outcomes: [outcome(0)],
        });
        const entry = result.records.find((record): record is PaperEntryRecord => record.recordType === "paper_entry");

        expect(entry?.side).to.equal("no");
        expect(entry?.entryPrice).to.be.closeTo(0.44, 1e-12);
        expect(entry?.shares).to.be.closeTo(5 / 0.44, 1e-9);
    });

    it("prices close-based 1s executions at the candle close second", () => {
        const closeSnapshot = snapshot();
        closeSnapshot.backtestSettings.executionModel = "signal_close";
        const state = createExecutionLabPaperState(closeSnapshot);
        const closedTrade = trade(1, "long", EVENT_START + 10, EVENT_START + 12);
        closedTrade.exitReason = "signal";
        const result = tick({
            state,
            latestTs: EVENT_START + 13,
            trades: [closedTrade],
            signals: [signal("buy", EVENT_START + 10)],
            quotes: [
                quote(EVENT_START + 10, 0.57, 0.56),
                quote(EVENT_START + 11, 0.58, 0.57),
                quote(EVENT_START + 12, 0.60, 0.59),
                quote(EVENT_START + 13, 0.63, 0.62),
            ],
        });
        const entry = result.records.find((record): record is PaperEntryRecord => record.recordType === "paper_entry");
        const exit = result.records.find((record): record is PaperExitRecord => record.recordType === "paper_exit");

        expect(entry?.signalTimeSec).to.equal(EVENT_START + 10);
        expect(entry?.entryTimeSec).to.equal(EVENT_START + 11);
        expect(entry?.entryQuoteTs).to.equal(EVENT_START + 11);
        expect(entry?.entryPrice).to.equal(0.58);
        expect(exit?.exitTimeSec).to.equal(EVENT_START + 13);
        expect(exit?.exitPrice).to.equal(0.62);
    });

    it("exits open paper positions at the configured Polymarket take-profit target", () => {
        const protectedSnapshot = snapshot();
        protectedSnapshot.backtestSettings.polymarketProtectionTakeProfitEnabled = true;
        protectedSnapshot.backtestSettings.polymarketProtectionTakeProfitCents = 5;
        const state = createExecutionLabPaperState(protectedSnapshot);
        tick({
            state,
            latestTs: EVENT_START + 10,
            trades: [trade(1, "long", EVENT_START + 10)],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [quote(EVENT_START + 10, 0.50, 0.48)],
        });

        const protectedExit = tick({
            state,
            latestTs: EVENT_START + 12,
            trades: [trade(1, "long", EVENT_START + 10)],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [
                quote(EVENT_START + 10, 0.50, 0.48),
                quote(EVENT_START + 12, 0.58, 0.56),
            ],
        });
        const exit = protectedExit.records.find((record): record is PaperExitRecord => record.recordType === "paper_exit");

        expect(exit?.exitReason).to.equal("polymarket_take_profit");
        expect(exit?.exitTimeSec).to.equal(EVENT_START + 12);
        expect(exit?.exitPrice).to.equal(0.55);
        expect(exit?.pnlUsd).to.be.closeTo(0.5, 1e-12);
        expect(state.openPositions.size).to.equal(0);
    });

    it("exits open paper positions at the observed sell quote when Polymarket stop-loss triggers", () => {
        const protectedSnapshot = snapshot();
        protectedSnapshot.backtestSettings.polymarketProtectionStopLossEnabled = true;
        protectedSnapshot.backtestSettings.polymarketProtectionStopLossCents = 5;
        const state = createExecutionLabPaperState(protectedSnapshot);
        tick({
            state,
            latestTs: EVENT_START + 10,
            trades: [trade(1, "long", EVENT_START + 10)],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [quote(EVENT_START + 10, 0.50, 0.48)],
        });

        const protectedExit = tick({
            state,
            latestTs: EVENT_START + 12,
            trades: [trade(1, "long", EVENT_START + 10)],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [
                quote(EVENT_START + 10, 0.50, 0.48),
                quote(EVENT_START + 12, 0.46, 0.44),
            ],
        });
        const exit = protectedExit.records.find((record): record is PaperExitRecord => record.recordType === "paper_exit");

        expect(exit?.exitReason).to.equal("polymarket_stop_loss");
        expect(exit?.exitTimeSec).to.equal(EVENT_START + 12);
        expect(exit?.exitPrice).to.equal(0.44);
        expect(exit?.pnlUsd).to.be.closeTo(-0.6, 1e-12);
        expect(state.openPositions.size).to.equal(0);
    });

    it("scans loaded quote ranges for paper Polymarket protection exits between polls", () => {
        const protectedSnapshot = snapshot();
        protectedSnapshot.backtestSettings.polymarketProtectionTakeProfitEnabled = true;
        protectedSnapshot.backtestSettings.polymarketProtectionTakeProfitCents = 5;
        const state = createExecutionLabPaperState(protectedSnapshot);
        tick({
            state,
            latestTs: EVENT_START + 10,
            trades: [trade(1, "long", EVENT_START + 10)],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [quote(EVENT_START + 10, 0.50, 0.48)],
        });

        const protectedExit = tick({
            state,
            latestTs: EVENT_START + 13,
            trades: [trade(1, "long", EVENT_START + 10)],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [
                quote(EVENT_START + 10, 0.50, 0.48),
                quote(EVENT_START + 11, 0.53, 0.52),
                quote(EVENT_START + 12, 0.58, 0.56),
                quote(EVENT_START + 13, 0.54, 0.53),
            ],
        });
        const exit = protectedExit.records.find((record): record is PaperExitRecord => record.recordType === "paper_exit");

        expect(exit?.exitReason).to.equal("polymarket_take_profit");
        expect(exit?.exitTimeSec).to.equal(EVENT_START + 12);
        expect(exit?.exitPrice).to.equal(0.55);
    });

    it("does not let a later paper protection quote override an earlier chart exit", () => {
        const protectedSnapshot = snapshot();
        protectedSnapshot.backtestSettings.polymarketProtectionTakeProfitEnabled = true;
        protectedSnapshot.backtestSettings.polymarketProtectionTakeProfitCents = 5;
        const state = createExecutionLabPaperState(protectedSnapshot);
        tick({
            state,
            latestTs: EVENT_START + 10,
            trades: [trade(1, "long", EVENT_START + 10, EVENT_START + 12)],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [quote(EVENT_START + 10, 0.50, 0.48)],
        });
        const closedTrade = trade(1, "long", EVENT_START + 10, EVENT_START + 12);
        closedTrade.exitReason = "signal";

        const closed = tick({
            state,
            latestTs: EVENT_START + 13,
            trades: [closedTrade],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [
                quote(EVENT_START + 10, 0.50, 0.48),
                quote(EVENT_START + 12, 0.54, 0.52),
                quote(EVENT_START + 13, 0.58, 0.56),
            ],
        });
        const exit = closed.records.find((record): record is PaperExitRecord => record.recordType === "paper_exit");

        expect(exit?.exitReason).to.equal("signal");
        expect(exit?.exitTimeSec).to.equal(EVENT_START + 12);
        expect(exit?.exitPrice).to.equal(0.52);
    });

    it("requires exact outcome symbol, series, token, and timestamp quote matches", () => {
        const state = createExecutionLabPaperState(snapshot());
        const result = tick({
            state,
            latestTs: EVENT_END + 1,
            trades: [trade(1, "long", EVENT_START + 10)],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [
                quote(EVENT_START + 10, 0.1, 0.09, "XRPUSDT"),
                quote(EVENT_START + 10, 0.6, 0.58),
            ],
            outcomes: [outcome(1)],
        });
        const entry = result.records.find((record): record is PaperEntryRecord => record.recordType === "paper_entry");

        expect(entry?.entryPrice).to.equal(0.6);
    });

    it("logs unfilled entries when the exact entry quote is missing", () => {
        const state = createExecutionLabPaperState(snapshot());
        const result = tick({
            state,
            latestTs: EVENT_START + 20,
            trades: [trade(1, "long", EVENT_START + 10)],
            signals: [signal("buy", EVENT_START + 9)],
            outcomes: [outcome(1)],
        });
        const unfilled = result.records.find((record): record is PaperUnfilledRecord => record.recordType === "paper_unfilled");

        expect(unfilled?.reason).to.equal("missing_entry_quote");
    });

    it("blocks edge-priced entries without claiming the event slot", () => {
        const state = createExecutionLabPaperState(snapshot(false, 20));
        const secondTrade = trade(2, "long", EVENT_START + 20);
        const result = tick({
            state,
            latestTs: EVENT_START + 25,
            trades: [
                trade(1, "long", EVENT_START + 10),
                secondTrade,
            ],
            signals: [
                signal("buy", EVENT_START + 9),
                signal("buy", EVENT_START + 19),
            ],
            quotes: [
                quote(EVENT_START + 10, 0.20, 0.18),
                quote(EVENT_START + 20, 0.55, 0.53),
            ],
            outcomes: [outcome(1)],
        });

        const unfilled = result.records.find((record): record is PaperUnfilledRecord =>
            record.recordType === "paper_unfilled" && record.reason === "entry_price_filtered"
        );
        const entry = result.records.find((record): record is PaperEntryRecord => record.recordType === "paper_entry");

        expect(unfilled?.entryTimeSec).to.equal(EVENT_START + 10);
        expect(unfilled?.entryPrice).to.equal(0.20);
        expect(entry?.entryTimeSec).to.equal(EVENT_START + 20);
        expect(entry?.entryPrice).to.equal(0.55);
        expect(state.totalEntries).to.equal(1);
    });

    it("blocks entries inside the Polymarket event cutoff", () => {
        const state = createExecutionLabPaperState(snapshot(false, 0, true, 15));
        const lateTrade = trade(1, "long", EVENT_END - 10);
        const result = tick({
            state,
            latestTs: EVENT_END - 5,
            trades: [lateTrade],
            signals: [signal("buy", EVENT_END - 11)],
            quotes: [
                quote(EVENT_END - 10, 0.55, 0.53),
            ],
            outcomes: [outcome(1)],
        });

        const unfilled = result.records.find((record): record is PaperUnfilledRecord =>
            record.recordType === "paper_unfilled" && record.reason === "entry_too_close_to_close"
        );

        expect(unfilled?.entryTimeSec).to.equal(EVENT_END - 10);
        expect(result.acceptedEntries).to.have.length(0);
        expect(state.totalEntries).to.equal(0);
    });

    it("flags existing paper positions that violate the entry price filter as parity mismatches", () => {
        const state = createExecutionLabPaperState(snapshot(false, 20));
        const sourceTrade = trade(1, "short", EVENT_START + 10);
        const position: ExecutionLabOpenPaperPosition = {
            tradeId: "filtered-position",
            sourceTrade,
            seriesId: "10684",
            eventStartTs: EVENT_START,
            eventEndTs: EVENT_END,
            marketSlug: "btc-event",
            conditionId: "condition",
            yesTokenId: "yes",
            noTokenId: "no",
            side: "no",
            chartDirection: "short",
            signalTimeSec: EVENT_START + 9,
            entryTimeSec: EVENT_START + 10,
            entryQuoteTs: EVENT_START + 10,
            entryPrice: 0.15,
            stakeUsd: 5,
            shares: 5 / 0.15,
        };
        state.openPositions.set(position.tradeId, position);

        const mismatches = collectEntryPriceFilterParityMismatches(state, EVENT_START + 20);

        expect(mismatches).to.have.length(1);
        expect(mismatches[0]?.mismatchType).to.equal("entry_price_filter_violation");
        expect(mismatches[0]?.tradeId).to.equal("filtered-position");
    });

    it("ignores raw strategy signals that do not become configured trades", () => {
        const state = createExecutionLabPaperState(snapshot());
        const result = tick({
            state,
            latestTs: EVENT_START + 10,
            trades: [],
            signals: [signal("buy", EVENT_START + 10), signal("sell", EVENT_START + 10)],
            quotes: [quote(EVENT_START + 10, 0.5, 0.48)],
        });

        expect(result.records).to.deep.equal([]);
        expect(result.markers).to.deep.equal([]);
    });

    it("logs only the executed trade signal instead of every raw strategy signal", () => {
        const state = createExecutionLabPaperState(snapshot());
        const result = tick({
            state,
            latestTs: EVENT_START + 10,
            trades: [trade(1, "long", EVENT_START + 10)],
            signals: [
                signal("buy", EVENT_START + 9),
                signal("sell", EVENT_START + 9),
                signal("buy", EVENT_START + 11),
            ],
            quotes: [quote(EVENT_START + 10, 0.5, 0.48)],
        });
        const signalRecords = result.records.filter((record) => record.recordType === "signal_seen");

        expect(signalRecords.length).to.equal(1);
        expect(signalRecords[0]?.recordType === "signal_seen" ? signalRecords[0].signalType : null).to.equal("buy");
        expect(signalRecords[0]?.recordType === "signal_seen" ? signalRecords[0].signalTimeSec : null).to.equal(EVENT_START + 9);
        expect(result.markers.some((marker) => marker.kind === "entry")).to.equal(true);
    });

    it("blocks duplicate same-event trades unless the snapshot allows them", () => {
        const blockedState = createExecutionLabPaperState(snapshot(false));
        const blocked = tick({
            state: blockedState,
            latestTs: EVENT_END + 1,
            trades: [
                trade(1, "long", EVENT_START + 10),
                trade(2, "long", EVENT_START + 20),
            ],
            signals: [signal("buy", EVENT_START + 9), signal("buy", EVENT_START + 19)],
            quotes: [
                quote(EVENT_START + 10, 0.5, 0.48),
                quote(EVENT_START + 20, 0.5, 0.48),
            ],
            outcomes: [outcome(1)],
        });
        const duplicate = blocked.records.find((record): record is PaperUnfilledRecord =>
            record.recordType === "paper_unfilled" && record.reason === "duplicate_event"
        );

        expect(blockedState.totalEntries).to.equal(1);
        expect(duplicate?.reason).to.equal("duplicate_event");

        const allowedState = createExecutionLabPaperState(snapshot(true));
        tick({
            state: allowedState,
            latestTs: EVENT_END + 1,
            trades: [
                trade(1, "long", EVENT_START + 10),
                trade(2, "long", EVENT_START + 20),
            ],
            signals: [signal("buy", EVENT_START + 9), signal("buy", EVENT_START + 19)],
            quotes: [
                quote(EVENT_START + 10, 0.5, 0.48),
                quote(EVENT_START + 20, 0.5, 0.48),
            ],
            outcomes: [outcome(1)],
        });

        expect(allowedState.totalEntries).to.equal(2);
    });

    it("blocks a later opposite-side entry in the same event after a signal exit when multi-trade mode is off", () => {
        const blockedSnapshot = snapshot(false);
        blockedSnapshot.exitMode = "signal_exit_same_event";
        const state = createExecutionLabPaperState(blockedSnapshot);
        const firstTrade = trade(1, "short", EVENT_START + 10, EVENT_START + 20);
        firstTrade.exitReason = "signal";
        const repeatedFirstTrade = trade(1, "short", EVENT_START + 10, EVENT_START + 20);
        repeatedFirstTrade.exitReason = "signal";
        const secondTrade = trade(2, "long", EVENT_START + 25, EVENT_START + 30);
        secondTrade.exitReason = "signal";
        const first = tick({
            state,
            latestTs: EVENT_START + 20,
            trades: [firstTrade],
            signals: [signal("sell", EVENT_START + 9)],
            quotes: [
                quote(EVENT_START + 10, 0.6, 0.58),
                quote(EVENT_START + 20, 0.5, 0.48),
            ],
        });
        const second = tick({
            state,
            latestTs: EVENT_START + 30,
            trades: [
                repeatedFirstTrade,
                secondTrade,
            ],
            signals: [
                signal("sell", EVENT_START + 9),
                signal("buy", EVENT_START + 24),
            ],
            quotes: [
                quote(EVENT_START + 10, 0.6, 0.58),
                quote(EVENT_START + 20, 0.5, 0.48),
                quote(EVENT_START + 25, 0.7, 0.68),
                quote(EVENT_START + 30, 0.75, 0.73),
            ],
        });
        const duplicate = second.records.find((record): record is PaperUnfilledRecord =>
            record.recordType === "paper_unfilled" && record.reason === "duplicate_event"
        );

        expect(first.records.some((record) => record.recordType === "paper_exit")).to.equal(true);
        expect(state.totalEntries).to.equal(1);
        expect(duplicate?.reason).to.equal("duplicate_event");
    });

    it("keeps end-of-data trades open before event end and resolves later", () => {
        const state = createExecutionLabPaperState(snapshot());
        const first = tick({
            state,
            latestTs: EVENT_START + 20,
            trades: [trade(1, "long", EVENT_START + 10, EVENT_START + 20)],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [quote(EVENT_START + 10, 0.5, 0.48)],
            outcomes: [outcome(1)],
        });

        expect(first.records.some((record) => record.recordType === "paper_exit")).to.equal(false);
        expect(state.openPositions.size).to.equal(1);

        const second = tick({
            state,
            latestTs: EVENT_END + 1,
            trades: [trade(1, "long", EVENT_START + 10, EVENT_END + 1)],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [quote(EVENT_START + 10, 0.5, 0.48)],
            outcomes: [outcome(1)],
        });

        expect(second.records.some((record) => record.recordType === "paper_exit")).to.equal(true);
        expect(state.openPositions.size).to.equal(0);
    });

    it("closes paper trades when the backtest closes by max-hold or risk exit before event end", () => {
        const state = createExecutionLabPaperState(snapshot());
        tick({
            state,
            latestTs: EVENT_START + 10,
            trades: [trade(1, "long", EVENT_START + 10, EVENT_START + 13)],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [quote(EVENT_START + 10, 0.5, 0.48)],
        });
        const closedTrade = trade(1, "long", EVENT_START + 10, EVENT_START + 13);
        closedTrade.exitReason = "time_stop";
        const closed = tick({
            state,
            latestTs: EVENT_START + 13,
            trades: [closedTrade],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [
                quote(EVENT_START + 10, 0.5, 0.48),
                quote(EVENT_START + 13, 0.72, 0.7),
            ],
        });
        const exit = closed.records.find((record): record is PaperExitRecord => record.recordType === "paper_exit");

        expect(exit?.exitReason).to.equal("time_stop");
        expect(exit?.exitTimeSec).to.equal(EVENT_START + 13);
        expect(exit?.exitPrice).to.equal(0.7);
        expect(state.openPositions.size).to.equal(0);
        expect(state.totalClosed).to.equal(1);
    });

    it("allows zero bid exits when an outcome is effectively worthless", () => {
        const state = createExecutionLabPaperState(snapshot());
        tick({
            state,
            latestTs: EVENT_START + 10,
            trades: [trade(1, "short", EVENT_START + 10, EVENT_START + 13)],
            signals: [signal("sell", EVENT_START + 9)],
            quotes: [quote(EVENT_START + 10, 1, 0.99)],
        });
        const closedTrade = trade(1, "short", EVENT_START + 10, EVENT_START + 13);
        closedTrade.exitReason = "signal";
        const closed = tick({
            state,
            latestTs: EVENT_START + 13,
            trades: [closedTrade],
            signals: [signal("sell", EVENT_START + 9)],
            quotes: [
                quote(EVENT_START + 10, 1, 0.99),
                quote(EVENT_START + 13, 1, 0.99),
            ],
        });
        const exit = closed.records.find((record): record is PaperExitRecord => record.recordType === "paper_exit");

        expect(exit?.exitReason).to.equal("signal");
        expect(exit?.exitPrice).to.equal(0);
        expect(exit?.pnlUsd).to.equal(-5);
        expect(state.openPositions.size).to.equal(0);
    });

    it("does not use a later quote for a missed backtest exit second", () => {
        const state = createExecutionLabPaperState(snapshot());
        tick({
            state,
            latestTs: EVENT_START + 10,
            trades: [trade(1, "long", EVENT_START + 10, EVENT_START + 13)],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [quote(EVENT_START + 10, 0.5, 0.48)],
        });
        const closedTrade = trade(1, "long", EVENT_START + 10, EVENT_START + 13);
        closedTrade.exitReason = "signal";
        const closed = tick({
            state,
            latestTs: EVENT_START + 15,
            trades: [closedTrade],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [
                quote(EVENT_START + 10, 0.5, 0.48),
                quote(EVENT_START + 14, 0.72, 0.7),
            ],
        });
        const exit = closed.records.find((record): record is PaperExitRecord => record.recordType === "paper_exit");
        const unfilled = closed.records.find((record): record is PaperUnfilledRecord =>
            record.recordType === "paper_unfilled" && record.reason === "missing_exit_quote"
        );

        expect(exit).to.equal(undefined);
        expect(unfilled?.tradeId).to.equal("session-1|test_strategy|BTCUSDT|1700000000|yes|1700000009|1700000010");
        expect(unfilled?.expectedExitTimeSec).to.equal(EVENT_START + 13);
        expect(state.openPositions.size).to.equal(0);
    });

    it("logs missing exit quotes when a backtest exit cannot be priced", () => {
        const state = createExecutionLabPaperState(snapshot());
        tick({
            state,
            latestTs: EVENT_START + 10,
            trades: [trade(1, "long", EVENT_START + 10, EVENT_START + 13)],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [quote(EVENT_START + 10, 0.5, 0.48)],
        });
        const closedTrade = trade(1, "long", EVENT_START + 10, EVENT_START + 13);
        closedTrade.exitReason = "time_stop";
        const result = tick({
            state,
            latestTs: EVENT_START + 13,
            trades: [closedTrade],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [quote(EVENT_START + 10, 0.5, 0.48)],
        });
        const unfilled = result.records.find((record): record is PaperUnfilledRecord =>
            record.recordType === "paper_unfilled" && record.reason === "missing_exit_quote"
        );

        expect(unfilled?.reason).to.equal("missing_exit_quote");
        expect(unfilled?.tradeId).to.equal("session-1|test_strategy|BTCUSDT|1700000000|yes|1700000009|1700000010");
        expect(unfilled?.expectedExitReason).to.equal("time_stop");
        expect(unfilled?.expectedExitTimeSec).to.equal(EVENT_START + 13);
        expect(state.openPositions.size).to.equal(0);
    });

    it("moves open trades to pending settlement after event end even when current quotes no longer reference the old event", () => {
        const state = createExecutionLabPaperState(snapshot());
        tick({
            state,
            latestTs: EVENT_START + 10,
            trades: [trade(1, "long", EVENT_START + 10)],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [quote(EVENT_START + 10, 0.5, 0.48)],
        });
        const ended = tick({
            state,
            latestTs: EVENT_END + 1,
            trades: [trade(1, "long", EVENT_START + 10)],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [],
            outcomes: [],
        });

        expect(ended.records.some((record) => record.recordType === "paper_resolution_pending")).to.equal(true);
        expect(state.openPositions.size).to.equal(0);
        expect(state.pendingSettlements.size).to.equal(1);
    });

    it("does not open an opposite-side paper trade while another paper trade is still open", () => {
        const state = createExecutionLabPaperState(snapshot(true));
        tick({
            state,
            latestTs: EVENT_START + 20,
            trades: [trade(1, "short", EVENT_START + 10, EVENT_START + 20)],
            signals: [signal("sell", EVENT_START + 9)],
            quotes: [quote(EVENT_START + 10, 0.6, 0.58)],
        });
        const second = tick({
            state,
            latestTs: EVENT_START + 30,
            trades: [
                trade(1, "short", EVENT_START + 10, EVENT_START + 20),
                trade(2, "long", EVENT_START + 25, EVENT_START + 30),
            ],
            signals: [
                signal("sell", EVENT_START + 9),
                signal("buy", EVENT_START + 24),
            ],
            quotes: [
                quote(EVENT_START + 10, 0.6, 0.58),
                quote(EVENT_START + 25, 0.7, 0.68),
            ],
        });
        const blocked = second.records.find((record): record is PaperUnfilledRecord =>
            record.recordType === "paper_unfilled" && record.reason === "open_position"
        );

        expect(state.totalEntries).to.equal(1);
        expect(state.openPositions.size).to.equal(1);
        expect(blocked?.reason).to.equal("open_position");
    });

    it("logs unresolved resolution pending once and finalizes when an outcome appears", () => {
        const state = createExecutionLabPaperState(snapshot());
        const unresolved = tick({
            state,
            latestTs: EVENT_END + 1,
            trades: [trade(1, "long", EVENT_START + 10)],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [quote(EVENT_START + 10, 0.5, 0.48)],
            outcomes: [outcome(0, "second_market_clob_unresolved")],
        });
        const repeated = tick({
            state,
            latestTs: EVENT_END + 2,
            trades: [trade(1, "long", EVENT_START + 10)],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [quote(EVENT_START + 10, 0.5, 0.48)],
            outcomes: [outcome(0, "second_market_clob_unresolved")],
        });
        expect(unresolved.records.filter((record) => record.recordType === "paper_resolution_pending").length).to.equal(1);
        expect(state.openPositions.size).to.equal(0);
        expect(state.pendingSettlements.size).to.equal(1);
        expect(repeated.records.filter((record) => record.recordType === "paper_resolution_pending").length).to.equal(0);

        const resolved = tick({
            state,
            latestTs: EVENT_END + 3,
            trades: [trade(1, "long", EVENT_START + 10)],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [quote(EVENT_START + 10, 0.5, 0.48)],
            outcomes: [outcome(0)],
        });

        expect(resolved.records.some((record) => record.recordType === "paper_exit")).to.equal(true);
        expect(state.pendingSettlements.size).to.equal(0);
    });

    it("does not duplicate records for a repeated latest candle", () => {
        const state = createExecutionLabPaperState(snapshot());
        const first = tick({
            state,
            latestTs: EVENT_START + 20,
            trades: [trade(1, "long", EVENT_START + 10)],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [quote(EVENT_START + 10, 0.5, 0.48)],
        });
        const second = tick({
            state,
            latestTs: EVENT_START + 20,
            trades: [trade(1, "long", EVENT_START + 10)],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [quote(EVENT_START + 10, 0.5, 0.48)],
        });

        expect(first.records.length).to.be.greaterThan(0);
        expect(first.acceptedEntries).to.have.length(1);
        expect(second.records).to.deep.equal([]);
        expect(second.acceptedEntries).to.deep.equal([]);
    });

    it("ignores warmup trades and signals before the last processed live candle", () => {
        const state = createExecutionLabPaperState(snapshot());
        state.lastProcessedCandleTimeSec = EVENT_START + 20;

        const result = tick({
            state,
            latestTs: EVENT_START + 21,
            trades: [trade(1, "long", EVENT_START + 10)],
            signals: [signal("buy", EVENT_START + 9)],
            quotes: [quote(EVENT_START + 10, 0.5, 0.48)],
        });

        expect(result.records).to.deep.equal([]);
        expect(state.openPositions.size).to.equal(0);
    });
});
