import { expect } from "chai";
import { describe, it } from "node:test";
import {
    sanitizeExecutionLabPathPart,
    validateExecutionLabRecord,
} from "../lib/execution-lab/paper-log-schema";

const baseRecord = {
    sessionId: "session-1",
    recordedAtIso: "2026-01-01T00:00:00.000Z",
    symbol: "BTCUSDT",
    interval: "1s",
    strategyKey: "test_strategy",
} as const;

describe("Execution Lab JSONL schema", () => {
    it("sanitizes strategy and symbol path segments", () => {
        expect(sanitizeExecutionLabPathPart("  My Strategy / BTC  ")).to.equal("my-strategy-btc");
        expect(sanitizeExecutionLabPathPart("")).to.equal("unknown");
    });

    it("accepts valid session start records", () => {
        const validation = validateExecutionLabRecord({
            ...baseRecord,
            recordType: "session_start",
            stakeUsd: 5,
            strategyName: "Test Strategy",
            params: {},
            backtestSettings: {},
            polymarketSettings: {},
            allowMultipleTradesPerEvent: false,
        });

        expect(validation.ok).to.equal(true);
    });

    it("rejects invalid timestamps and non-positive stake", () => {
        expect(validateExecutionLabRecord({
            ...baseRecord,
            recordedAtIso: "not-a-date",
            recordType: "session_stop",
            reason: "user_stop",
            totalEntries: 0,
            totalClosed: 0,
            realizedPnlUsd: 0,
        }).ok).to.equal(false);
        expect(validateExecutionLabRecord({
            ...baseRecord,
            recordType: "session_start",
            stakeUsd: 0,
            strategyName: "Test Strategy",
            params: {},
            backtestSettings: {},
            polymarketSettings: {},
            allowMultipleTradesPerEvent: false,
        }).ok).to.equal(false);
    });

    it("rejects invalid record type and interval values", () => {
        expect(validateExecutionLabRecord({
            ...baseRecord,
            recordType: "unknown",
        }).ok).to.equal(false);
        expect(validateExecutionLabRecord({
            ...baseRecord,
            interval: "1m",
            recordType: "session_stop",
            reason: "user_stop",
        }).ok).to.equal(false);
    });

    it("validates paper entry and exit fields", () => {
        expect(validateExecutionLabRecord({
            ...baseRecord,
            recordType: "paper_entry",
            tradeId: "trade-1",
            side: "yes",
            entryPrice: 0.55,
        }).ok).to.equal(true);
        expect(validateExecutionLabRecord({
            ...baseRecord,
            recordType: "paper_unfilled",
            reason: "entry_price_filtered",
            entryPrice: 0.2,
        }).ok).to.equal(true);
        expect(validateExecutionLabRecord({
            ...baseRecord,
            recordType: "paper_exit",
            tradeId: "trade-1",
            exitReason: "manual",
            exitPrice: 0.6,
        }).ok).to.equal(false);
        expect(validateExecutionLabRecord({
            ...baseRecord,
            recordType: "paper_entry",
            tradeId: "trade-1",
            side: "yes",
            entryPrice: 0,
        }).ok).to.equal(false);
        expect(validateExecutionLabRecord({
            ...baseRecord,
            recordType: "paper_exit",
            tradeId: "trade-1",
            exitReason: "resolution",
            exitPrice: 0,
        }).ok).to.equal(true);
        expect(validateExecutionLabRecord({
            ...baseRecord,
            recordType: "paper_exit",
            tradeId: "trade-1",
            exitReason: "resolution",
            exitPrice: 1.01,
        }).ok).to.equal(false);
    });

    it("validates live trade request and result records", () => {
        expect(validateExecutionLabRecord({
            ...baseRecord,
            recordType: "live_trade_request",
            requestId: "live-1",
            paperTradeId: "paper-1",
            expiresAtSec: 1_700_000_020,
            eventStartTs: 1_700_000_000,
            eventEndTs: 1_700_000_300,
            marketSlug: "btc-event",
            conditionId: "condition",
            tokenId: "yes-token",
            side: "yes",
            stakeUsd: 5,
            signalTimeSec: 1_700_000_010,
            entryTimeSec: 1_700_000_011,
            maxPrice: 0.54,
            orderType: "FAK",
            dryRun: true,
            sizingMode: "fixed",
        }).ok).to.equal(true);
        expect(validateExecutionLabRecord({
            ...baseRecord,
            recordType: "live_trade_result",
            requestId: "live-1",
            paperTradeId: "paper-1",
            status: "dry_run",
            reason: "executor_dry_run",
            currentAsk: 0.53,
            maxPrice: 0.54,
            latencyMs: 25,
        }).ok).to.equal(true);
        expect(validateExecutionLabRecord({
            ...baseRecord,
            recordType: "live_trade_request",
            requestId: "live-1",
            paperTradeId: "paper-1",
            marketSlug: "btc-event",
            conditionId: "condition",
            tokenId: "yes-token",
            side: "yes",
            stakeUsd: 5,
            maxPrice: 0.54,
            orderType: "GTC",
        }).ok).to.equal(false);
        expect(validateExecutionLabRecord({
            ...baseRecord,
            recordType: "live_trade_result",
            requestId: "live-1",
            paperTradeId: "paper-1",
            status: "unknown",
        }).ok).to.equal(false);
        expect(validateExecutionLabRecord({
            ...baseRecord,
            recordType: "live_exit_request",
            requestId: "exit-1",
            entryRequestId: "live-1",
            paperTradeId: "paper-1",
            eventStartTs: 1_700_000_000,
            eventEndTs: 1_700_000_300,
            marketSlug: "btc-event",
            conditionId: "condition",
            tokenId: "yes-token",
            side: "yes",
            shares: 8.5,
            exitTimeSec: 1_700_000_050,
            minPrice: 0.49,
            orderType: "FAK",
            expiresAtSec: 1_700_000_060,
            attempt: 2,
            dryRun: true,
            sizingMode: "fixed",
        }).ok).to.equal(true);
        expect(validateExecutionLabRecord({
            ...baseRecord,
            recordType: "live_exit_result",
            requestId: "exit-1",
            entryRequestId: "live-1",
            paperTradeId: "paper-1",
            status: "rejected",
            reason: "price_moved_below_floor",
            currentBid: 0.48,
            minPrice: 0.49,
            latencyMs: 12,
        }).ok).to.equal(true);
        expect(validateExecutionLabRecord({
            ...baseRecord,
            recordType: "live_exit_request",
            requestId: "exit-1",
            entryRequestId: "live-1",
            paperTradeId: "paper-1",
            marketSlug: "btc-event",
            conditionId: "condition",
            tokenId: "yes-token",
            side: "yes",
            shares: 8.5,
            exitTimeSec: 1_700_000_050,
            minPrice: 0.49,
            orderType: "FAK",
            attempt: 0,
        }).ok).to.equal(false);
    });

    it("validates execution parity mismatch records", () => {
        expect(validateExecutionLabRecord({
            ...baseRecord,
            recordType: "execution_parity_mismatch",
            mismatchType: "missing_exit_quote",
            latestCandleTimeSec: 1778730004,
            detail: "missing exit quote",
            expectedExitTimeSec: 1778730003,
            expectedExitReason: "time_stop",
        }).ok).to.equal(true);
        expect(validateExecutionLabRecord({
            ...baseRecord,
            recordType: "execution_parity_mismatch",
            mismatchType: "entry_price_filter_violation",
            latestCandleTimeSec: 1778730004,
            detail: "paper entry violates price filter",
        }).ok).to.equal(true);
        expect(validateExecutionLabRecord({
            ...baseRecord,
            recordType: "execution_parity_mismatch",
            mismatchType: "late_paper_execution",
            latestCandleTimeSec: 1778730004,
            detail: "paper entry was processed late",
        }).ok).to.equal(true);
        expect(validateExecutionLabRecord({
            ...baseRecord,
            recordType: "execution_parity_mismatch",
            mismatchType: "raw_signal_only",
            latestCandleTimeSec: 1778730004,
            detail: "bad",
        }).ok).to.equal(false);
    });

    it("accepts session stop error messages", () => {
        expect(validateExecutionLabRecord({
            ...baseRecord,
            recordType: "session_stop",
            reason: "error",
            message: "Gamma live outcomes fetch failed: HTTP 500",
            totalEntries: 1,
            totalClosed: 0,
            realizedPnlUsd: 0,
        }).ok).to.equal(true);
    });
});
