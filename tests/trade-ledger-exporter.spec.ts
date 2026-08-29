import { expect } from "chai";
import { describe, it, before, after } from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { Readable } from "node:stream";
import { strategyRegistry } from "../strategyRegistry";
import { processRunBatch, __testInternals } from "../lib/batch-backtest/batch-backtest-vite-plugin";
import { runBatchBacktest, type BatchSymbolCompletionContext } from "../lib/batch-backtest/batch-backtest-runner";
import type { BatchStreamEvent } from "../lib/batch-backtest/batch-backtest-stream-types";
import {
    TRADE_LEDGER_FEATURE_ATR_PERIOD,
    TRADE_LEDGER_VERSION,
    buildBatchRunLedgerBodyField,
    buildTradeLedgerRowsForPair,
    formatLedgerRunStamp,
    sanitizeTradeLedgerFolder,
    TradeLedgerWriter,
    type TradeLedgerRow,
    type TradeLedgerWriterDeps,
} from "../lib/batch-backtest/trade-ledger-exporter";
import { buildAsIfPairModel, evaluateReplayEligibility, type AsIfPairModel } from "../lib/batch-backtest/trade-ledger-asif";
import { resolveExecutorBacktestSettings } from "../lib/backtest-executor";
import { calculateATR } from "../lib/strategies/indicators";
import type { CapitalSettings } from "../lib/types/backtest";
import type { BacktestSettings, OHLCVData, Signal, Strategy, Time, Trade } from "../lib/types/strategies";

const { setRunOwnerForTests, releaseLastResults, setLedgerRootDirForTests } = __testInternals;

// ============================================================================
// Fixtures
// ============================================================================

const BASE_TIME = 1_700_000_000;
const HOUR = 3600;

function makeBars(count: number, basePrice = 100): OHLCVData[] {
    const bars: OHLCVData[] = [];
    let price = basePrice;
    for (let i = 0; i < count; i += 1) {
        price += i % 3 === 0 ? 1 : i % 3 === 1 ? 0.5 : -0.75;
        bars.push({
            time: (BASE_TIME + i * HOUR) as Time,
            open: price - 0.25,
            high: price + 1.5,
            low: price - 1.5,
            close: price,
            volume: 1000,
        });
    }
    return bars;
}

function seconds(time: Time): number {
    return typeof time === "number" ? time : BASE_TIME;
}

function makeTrade(overrides: Partial<Trade> & { id: number; entryTime: Time; entryPrice: number }): Trade {
    return {
        type: "long",
        exitTime: (seconds(overrides.entryTime) + 2 * HOUR) as Time,
        exitPrice: overrides.entryPrice + 1,
        pnl: 10,
        pnlPercent: 1.5,
        size: 1,
        fees: 0.5,
        exitReason: "take_profit",
        ...overrides,
    };
}

function makeSignal(overrides: Partial<Signal> & { time: Time; type: Signal["type"] }): Signal {
    return { price: 100, ...overrides };
}

const ledgerSettings: BacktestSettings = {
    executionModel: "next_open",
    tradeDirection: "long",
    stopLossAtr: 0,
    takeProfitAtr: 0,
    trailingAtr: 0,
    slippageBps: 0,
    marketMode: "all",
    allowSameBarExit: false,
    disableSignalExits: true,
};

const ledgerCapital: CapitalSettings = {
    initialCapital: 10000,
    positionSize: 100,
    commission: 0,
    sizingMode: "percent",
    fixedTradeAmount: 1000,
};

const ledgerContext = {
    tradeDirection: "long" as const,
    executionModel: "next_open" as const,
    maxOpenTrades: 1,
    cooldownBars: 0,
    slippageRate: 0,
};

/** Deterministic as-if model for unit tests (no exit events, no levels). */
function makeModel(overrides: {
    exitEvents?: AsIfPairModel["exitEvents"];
    allowSameBarExit?: boolean;
    maxOpenTrades?: number;
    cooldownBars?: number;
} = {}): AsIfPairModel {
    const eligibility = evaluateReplayEligibility(
        resolveExecutorBacktestSettings({ ...ledgerSettings, interval: "4h" } as BacktestSettings, "4h"),
        ledgerCapital,
    );
    const config = resolveExecutorBacktestSettings({ ...ledgerSettings, interval: "4h" } as BacktestSettings, "4h") as unknown as AsIfPairModel["config"];
    const bars = makeBars(30);
    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);
    const closes = bars.map((b) => b.close);
    return {
        ...eligibility.params,
        eligible: true,
        reasons: [],
        shift: 1,
        config,
        exitEvents: overrides.exitEvents ?? [],
        atr: calculateATR(highs, lows, closes, TRADE_LEDGER_FEATURE_ATR_PERIOD),
        ...(overrides.allowSameBarExit !== undefined ? { allowSameBarExit: overrides.allowSameBarExit } : {}),
        ...(overrides.maxOpenTrades !== undefined ? { maxOpenTrades: overrides.maxOpenTrades } : {}),
        ...(overrides.cooldownBars !== undefined ? { cooldownBars: overrides.cooldownBars } : {}),
    };
}

// ============================================================================
// Row builder
// ============================================================================

describe("trade ledger row builder", () => {
    const data = makeBars(30);
    const barTime = (i: number) => (BASE_TIME + i * HOUR) as Time;

    it("emits one row per entry signal with executed/notExecuted matching and categories", () => {
        const signals: Signal[] = [
            makeSignal({ time: barTime(5), type: "buy", price: data[5]!.close, barIndex: 5 }),
            makeSignal({ time: barTime(9), type: "buy", price: data[9]!.close, barIndex: 9 }),
            makeSignal({ time: barTime(14), type: "buy", price: data[14]!.close, barIndex: 14 }),
            makeSignal({ time: barTime(16), type: "sell", price: data[16]!.close, barIndex: 16 }),
            makeSignal({ time: barTime(20), type: "buy", price: data[20]!.close, barIndex: 20 }),
            // Exit-only signals (Exit Strategy Override) are never entries.
            makeSignal({ time: barTime(21), type: "sell", price: data[21]!.close, barIndex: 21, exitOnly: true }),
        ];
        const trades: Trade[] = [
            makeTrade({ id: 1, entryTime: barTime(6), entryPrice: data[6]!.open, exitTime: barTime(12), exitPrice: data[6]!.open + 1 }),
            makeTrade({ id: 2, entryTime: barTime(15), entryPrice: data[15]!.open }),
        ];

        const { rows, duplicatesCollapsed } = buildTradeLedgerRowsForPair({
            pair: "A+BCP",
            data,
            signals,
            trades,
            context: ledgerContext,
        });

        // Long direction gate: only the 4 buy signals; sell + exitOnly excluded.
        expect(rows.length).to.equal(4);
        expect(duplicatesCollapsed).to.equal(0);

        const [first, suppressedByOpen, secondEntry, lateEntry] = rows;

        expect(first!.direction).to.equal("long");
        expect(first!.signalTime).to.equal(BASE_TIME + 5 * HOUR);
        expect(first!.signalBarIndex).to.equal(5);
        // next_open fill = next bar's open.
        expect(first!.fillTime).to.equal(BASE_TIME + 6 * HOUR);
        expect(first!.fillPrice).to.equal(data[6]!.open);
        expect(first!.executed).to.equal(true);
        expect(first!.notExecutedReason).to.equal(null);
        // Outcome fields exist ONLY on executed rows.
        expect(first!.exitTime).to.equal(BASE_TIME + 12 * HOUR);
        expect(first!.exitPrice).to.equal(data[6]!.open + 1);
        expect(first!.pnlPercent).to.equal(1.5);
        expect(first!.fees).to.equal(0.5);
        expect(first!.exitReason).to.equal("take_profit");

        // Still-open position at the decision bar -> position_open.
        expect(suppressedByOpen!.executed).to.equal(false);
        expect(suppressedByOpen!.notExecutedReason).to.equal("position_open");
        expect("exitTime" in suppressedByOpen!).to.equal(false);
        expect("pnlPercent" in suppressedByOpen!).to.equal(false);

        expect(secondEntry!.executed).to.equal(true);
        expect(secondEntry!.fillPrice).to.equal(data[15]!.open);

        // Prior trade already closed at the decision bar -> match_missing
        // (flat + unblocked but no trade matched — a counted category).
        expect(lateEntry!.executed).to.equal(false);
        expect(lateEntry!.notExecutedReason).to.equal("match_missing");

        // Trailing per-pair stats use STRICTLY earlier executed trades.
        expect(first!.feat_pairTradesPrior).to.equal(0);
        expect(first!.feat_pairWinRatePrior).to.equal(null);
        expect(secondEntry!.feat_pairTradesPrior).to.equal(1);
        expect(lateEntry!.feat_pairTradesPrior).to.equal(2);
        expect(rows.every((row) => row.ledgerVersion === TRADE_LEDGER_VERSION)).to.equal(true);
        // Without an as-if model rows carry the replay-ineligible marker.
        expect(rows.every((row) => row.asIf === null && row.asIfReason === "replay_ineligible")).to.equal(true);
    });

    it("classifies post-exit cooldown blocks explicitly", () => {
        const trades = [
            makeTrade({ id: 1, entryTime: barTime(6), entryPrice: data[6]!.open, exitTime: barTime(12), exitPrice: data[6]!.open + 1 }),
        ];
        const fillingAt13 = [
            makeSignal({ time: barTime(5), type: "buy", price: data[5]!.close, barIndex: 5 }),
            makeSignal({ time: barTime(12), type: "buy", price: data[12]!.close, barIndex: 12 }),
        ];
        const { rows } = buildTradeLedgerRowsForPair({
            pair: "A+BCP",
            data,
            signals: fillingAt13,
            trades,
            context: { ...ledgerContext, cooldownBars: 2 },
        });
        // Trade exits at bar 12; cooldown until bar 12 + 2 - 1 = 13 blocks the
        // fill at bar 13.
        expect(rows[1]!.executed).to.equal(false);
        expect(rows[1]!.notExecutedReason).to.equal("cooldown");
    });

    it("collapses duplicate same-direction signals on the same decision bar (first wins)", () => {
        const signals = [
            makeSignal({ time: barTime(5), type: "buy", price: 111, barIndex: 5 }),
            makeSignal({ time: barTime(5), type: "buy", price: 222, barIndex: 5 }),
        ];
        const { rows, duplicatesCollapsed } = buildTradeLedgerRowsForPair({
            pair: "A+BCP",
            data,
            signals,
            trades: [],
            context: ledgerContext,
        });
        expect(rows.length).to.equal(1);
        expect(duplicatesCollapsed).to.equal(1);
        // First wins.
        expect(rows[0]!.fillPrice).to.equal(data[6]!.open);
        expect(rows[0]!.feat_entryRangePosition).to.be.a("number");
    });

    it("matches trades through slippage with a bounded tolerance (not too loose)", () => {
        const signals = [makeSignal({ time: barTime(5), type: "buy", price: data[5]!.close, barIndex: 5 })];
        const rawFill = data[6]!.open;
        const slippageRate = 5 / 10000;
        const tolerance = rawFill * slippageRate;

        // Just inside the tolerance: matches.
        const inside = [makeTrade({ id: 1, entryTime: barTime(6), entryPrice: rawFill + tolerance * 0.5 })];
        const matched = buildTradeLedgerRowsForPair({
            pair: "A+BCP", data, signals, trades: inside,
            context: { ...ledgerContext, slippageRate },
        });
        expect(matched.rows[0]!.executed).to.equal(true);
        expect(matched.rows[0]!.fillPrice).to.equal(rawFill + tolerance * 0.5);

        // Just outside the tolerance: must NOT match.
        const outside = [makeTrade({ id: 1, entryTime: barTime(6), entryPrice: rawFill + tolerance * 3 })];
        const mismatched = buildTradeLedgerRowsForPair({
            pair: "A+BCP", data, signals, trades: outside,
            context: { ...ledgerContext, slippageRate },
        });
        expect(mismatched.rows[0]!.executed).to.equal(false);
        expect(mismatched.rows[0]!.notExecutedReason).to.equal("match_missing");
    });

    it("treats unlimited maxOpenTrades (Infinity) as never position_open", () => {
        const signals = [
            makeSignal({ time: barTime(5), type: "buy", price: data[5]!.close, barIndex: 5 }),
            makeSignal({ time: barTime(9), type: "buy", price: data[9]!.close, barIndex: 9 }),
        ];
        const trades = [
            makeTrade({ id: 1, entryTime: barTime(6), entryPrice: data[6]!.open, exitTime: barTime(12), exitPrice: data[6]!.open + 1 }),
        ];
        const { rows } = buildTradeLedgerRowsForPair({
            pair: "A+BCP",
            data,
            signals,
            trades,
            context: { ...ledgerContext, maxOpenTrades: Number.POSITIVE_INFINITY },
        });
        // Overlapping position exists but the cap is unlimited.
        expect(rows[1]!.notExecutedReason).to.equal("match_missing");
    });

    it("features are causal: mutating bar i+1 never changes bar i's FEATURES", () => {
        const signals: Signal[] = [
            makeSignal({ time: barTime(5), type: "buy", price: data[5]!.close, barIndex: 5 }),
        ];
        const clean = buildTradeLedgerRowsForPair({ pair: "A+BCP", data, signals, trades: [], context: ledgerContext });

        // The strongest lookahead probe: mutate the bar IMMEDIATELY after the
        // signal bar. A real lookahead bug would read exactly this bar. (The
        // row's fillPrice legitimately reads bar i+1 — that IS the fill.)
        const mutated = data.map((bar) => ({ ...bar }));
        mutated[6] = { ...mutated[6]!, close: 1e9, high: 1e9 + 10, low: 1e9 - 10, open: 1e9 };
        const tampered = buildTradeLedgerRowsForPair({ pair: "A+BCP", data: mutated, signals, trades: [], context: ledgerContext });

        const featureKeys = Object.keys(clean.rows[0]!).filter((k) => k.startsWith("feat_")) as (keyof TradeLedgerRow)[];
        for (const key of featureKeys) {
            expect(JSON.stringify(tampered.rows[0]![key]), String(key)).to.equal(JSON.stringify(clean.rows[0]![key]));
        }
        expect(tampered.rows[0]!.signalTime).to.equal(clean.rows[0]!.signalTime);
        // Sanity: the mutation IS visible to the NEXT bar's own row (gapPct
        // reads bar 6's open; bar 6 is before the ATR window so atrPct is
        // still null there).
        const nextSignal = [makeSignal({ time: barTime(6), type: "buy", price: data[6]!.close, barIndex: 6 })];
        const nextClean = buildTradeLedgerRowsForPair({ pair: "A+BCP", data, signals: nextSignal, trades: [], context: ledgerContext });
        const nextTampered = buildTradeLedgerRowsForPair({ pair: "A+BCP", data: mutated, signals: nextSignal, trades: [], context: ledgerContext });
        expect(nextTampered.rows[0]!.feat_gapPct).to.not.equal(nextClean.rows[0]!.feat_gapPct);
    });

    it("feature ATR is fixed at period 14 regardless of user ATR settings", () => {
        const signals = [makeSignal({ time: barTime(20), type: "buy", price: data[20]!.close, barIndex: 20 })];
        const { rows } = buildTradeLedgerRowsForPair({ pair: "A+BCP", data, signals, trades: [], context: ledgerContext });
        const highs = data.map((b) => b.high);
        const lows = data.map((b) => b.low);
        const closes = data.map((b) => b.close);
        const atr14 = calculateATR(highs, lows, closes, TRADE_LEDGER_FEATURE_ATR_PERIOD)[20]!;
        expect(rows[0]!.feat_atrPct).to.equal((atr14 / closes[20]!) * 100);
    });

    it("computes deterministic hand-checked feature values at the signal bar", () => {
        const signals = [makeSignal({ time: barTime(22), type: "buy", price: data[22]!.close, barIndex: 22 })];
        const { rows } = buildTradeLedgerRowsForPair({ pair: "A+BCP", data, signals, trades: [], context: ledgerContext });
        const row = rows[0]!;
        const prior = data[21]!;
        expect(row.feat_entryRangePosition).to.equal((data[22]!.close - prior.low) / (prior.high - prior.low) * 100);
        expect(row.feat_gapPct).to.equal((data[22]!.open - prior.close) / prior.close * 100);
        expect(row.feat_return20).to.equal((data[22]!.close - data[2]!.close) / data[2]!.close * 100);
        const date = new Date((BASE_TIME + 22 * HOUR) * 1000);
        expect(row.feat_dow).to.equal(date.getUTCDay());
        expect(row.feat_hour).to.equal(date.getUTCHours());
        expect(row.feat_rank).to.equal(null);
        expect(row.feat_candidatesAtTime).to.equal(null);
    });

    it("honors the run's execution model for fill timing", () => {
        const signals = [makeSignal({ time: barTime(5), type: "buy", price: data[5]!.close, barIndex: 5 })];
        const signalClose = buildTradeLedgerRowsForPair({
            pair: "A+BCP",
            data,
            signals,
            trades: [],
            context: { ...ledgerContext, executionModel: "signal_close" },
        });
        expect(signalClose.rows[0]!.fillTime).to.equal(BASE_TIME + 5 * HOUR);
        expect(signalClose.rows[0]!.fillPrice).to.equal(data[5]!.close);

        const nextClose = buildTradeLedgerRowsForPair({
            pair: "A+BCP",
            data,
            signals,
            trades: [],
            context: { ...ledgerContext, executionModel: "next_close" },
        });
        expect(nextClose.rows[0]!.fillTime).to.equal(BASE_TIME + 6 * HOUR);
        expect(nextClose.rows[0]!.fillPrice).to.equal(data[6]!.close);
    });

    it("returns no rows without signals or data", () => {
        expect(buildTradeLedgerRowsForPair({ pair: "P", data, signals: [], trades: [], context: ledgerContext }).rows).to.deep.equal([]);
        expect(buildTradeLedgerRowsForPair({ pair: "P", data: [], signals: [makeSignal({ time: barTime(1), type: "buy" })], trades: [], context: ledgerContext }).rows).to.deep.equal([]);
    });
});

// ============================================================================
// As-if outcomes (engine math via the reused exit path)
// ============================================================================

describe("trade ledger as-if outcomes", () => {
    const data = makeBars(30);
    const barTime = (i: number) => (BASE_TIME + i * HOUR) as Time;

    it("exits on the merged exit-signal series with engine fill math", async () => {
        const resolved = resolveExecutorBacktestSettings({ ...ledgerSettings, interval: "4h" } as BacktestSettings, "4h");
        const eligibility = evaluateReplayEligibility(resolved, ledgerCapital);
        expect(eligibility.eligible).to.equal(true);
        const model = await buildAsIfPairModel({
            data,
            // Long mode with signal exits enabled: the primary sell IS the
            // exit series, execution-shifted like the engine (next_open exit
            // fills the NEXT bar's open).
            primarySignals: [
                makeSignal({ time: barTime(5), type: "buy", price: data[5]!.close, barIndex: 5 }),
                makeSignal({ time: barTime(12), type: "sell", price: data[12]!.close, barIndex: 12 }),
            ],
            resolvedSettings: resolved,
            eligibility,
        });
        expect(model.exitEvents.length).to.equal(1);
        expect(model.exitEvents[0]!.barIndex).to.equal(13);
        expect(model.exitEvents[0]!.price).to.equal(data[13]!.open);

        const { rows } = buildTradeLedgerRowsForPair({
            pair: "A+BCP",
            data,
            signals: [makeSignal({ time: barTime(5), type: "buy", price: data[5]!.close, barIndex: 5 })],
            trades: [],
            context: ledgerContext,
            asIfModel: model,
        });
        const row = rows[0]!;
        // Entry fills at bar 6 open (next_open); the exit signal at bar 12
        // fills at bar 13 open — exactly the engine's exit timing.
        expect(row.asIf).to.not.equal(null);
        expect(row.asIf!.fillTime).to.equal(BASE_TIME + 6 * HOUR);
        expect(row.asIf!.fillPrice).to.equal(data[6]!.open);
        expect(row.asIf!.exitTime).to.equal(BASE_TIME + 13 * HOUR);
        expect(row.asIf!.exitPrice).to.equal(data[13]!.open);
        expect(row.asIf!.barsHeld).to.equal(7);
        expect(row.asIf!.exitReason).to.equal("signal");
        expect(row.asIfReason).to.equal(null);
        // as-if pnl mirrors the engine's calculateTradeExitDetails.
        const expectedPnl = ((data[13]!.open - data[6]!.open) / data[6]!.open) * 100;
        expect(row.asIf!.pnlPercent).to.be.closeTo(expectedPnl, 1e-9);
    });

    it("right-censors signals with no fill bar instead of zero-filling", async () => {
        const model = makeModel();
        const { rows } = buildTradeLedgerRowsForPair({
            pair: "A+BCP",
            data,
            signals: [makeSignal({ time: barTime(29), type: "buy", price: data[29]!.close, barIndex: 29 })],
            trades: [],
            context: ledgerContext,
            asIfModel: model,
        });
        expect(rows[0]!.asIf).to.equal(null);
        expect(rows[0]!.asIfReason).to.equal("right_censored");
    });

    it("stops out through the engine's own per-bar exit handler when no exit signal comes", async () => {
        // ATR-armed stop: crash bar breaches the stop armed at entry. The
        // signal sits late enough that ATR(14) is warm at the sizing bar.
        const stopSettings = resolveExecutorBacktestSettings({
            ...ledgerSettings,
            stopLossAtr: 1.5,
            interval: "4h",
        } as BacktestSettings, "4h");
        const eligibility = evaluateReplayEligibility(stopSettings, ledgerCapital);
        const crash = makeBars(30).map((bar) => ({ ...bar }));
        crash[25] = { ...crash[25]!, low: 40, close: 42, open: 60, high: 62 };
        const model = await buildAsIfPairModel({
            data: crash,
            primarySignals: [makeSignal({ time: barTime(20), type: "buy", price: crash[20]!.close, barIndex: 20 })],
            resolvedSettings: stopSettings,
            eligibility,
        });
        const { rows } = buildTradeLedgerRowsForPair({
            pair: "A+BCP",
            data: crash,
            signals: [makeSignal({ time: barTime(20), type: "buy", price: crash[20]!.close, barIndex: 20 })],
            trades: [],
            context: ledgerContext,
            asIfModel: model,
        });
        expect(rows[0]!.asIf).to.not.equal(null);
        expect(rows[0]!.asIf!.exitReason).to.equal("stop_loss");
        expect(rows[0]!.asIf!.exitTime).to.equal(BASE_TIME + 25 * HOUR);
    });

    it("runs to end_of_data when no levels and no exit signals exist", () => {
        const model = makeModel();
        const { rows } = buildTradeLedgerRowsForPair({
            pair: "A+BCP",
            data,
            signals: [makeSignal({ time: barTime(5), type: "buy", price: data[5]!.close, barIndex: 5 })],
            trades: [],
            context: ledgerContext,
            asIfModel: model,
        });
        expect(rows[0]!.asIf!.exitReason).to.equal("end_of_data");
        expect(rows[0]!.asIf!.exitTime).to.equal(BASE_TIME + 29 * HOUR);
        expect(rows[0]!.asIf!.barsHeld).to.equal(23);
    });

    it("honors the same-bar exit gate on the fill bar", () => {
        const exitAtFill = [{ barIndex: 6, price: 90 }];
        const blocked = buildTradeLedgerRowsForPair({
            pair: "A+BCP",
            data,
            signals: [makeSignal({ time: barTime(5), type: "buy", price: data[5]!.close, barIndex: 5 })],
            trades: [],
            context: ledgerContext,
            asIfModel: makeModel({ exitEvents: exitAtFill, allowSameBarExit: false }),
        });
        expect(blocked.rows[0]!.asIf!.exitReason).to.equal("end_of_data");

        const allowed = buildTradeLedgerRowsForPair({
            pair: "A+BCP",
            data,
            signals: [makeSignal({ time: barTime(5), type: "buy", price: data[5]!.close, barIndex: 5 })],
            trades: [],
            context: ledgerContext,
            asIfModel: makeModel({ exitEvents: exitAtFill, allowSameBarExit: true }),
        });
        expect(allowed.rows[0]!.asIf!.exitReason).to.equal("signal");
        expect(allowed.rows[0]!.asIf!.barsHeld).to.equal(0);
    });

    it("refuses replay for configs with history-dependent exits", () => {
        const base = resolveExecutorBacktestSettings({ ...ledgerSettings, interval: "4h" } as BacktestSettings, "4h");
        expect(evaluateReplayEligibility(base, ledgerCapital).eligible).to.equal(true);

        // Guard flags are evaluated on the config AS THE ENGINE SEES IT; use
        // direct objects because the settings resolver may coerce toggle-
        // gated keys in some shapes.
        const adaptive = { ...base, takeProfitMode: "mfe_bootstrap" } as unknown as BacktestSettings;
        expect(evaluateReplayEligibility(adaptive, ledgerCapital).reasons.join(",")).to.contain("adaptive_take_profit");

        const pathExit = { ...base, pathExitEnabled: true, pathExitMode: "mfe_giveback" } as unknown as BacktestSettings;
        expect(evaluateReplayEligibility(pathExit, ledgerCapital).reasons.join(",")).to.contain("path_exit");

        const partial = { ...base, partialTakeProfitAtR: 0.5 } as unknown as BacktestSettings;
        expect(evaluateReplayEligibility(partial, ledgerCapital).reasons.join(",")).to.contain("partial_take_profit");

        const winStreak = { ...base, riskWinStreakStopLossEnabled: true } as unknown as BacktestSettings;
        expect(evaluateReplayEligibility(winStreak, ledgerCapital).reasons.join(",")).to.contain("win_streak");

        const regime = { ...base, trendEmaPeriod: 50 } as unknown as BacktestSettings;
        expect(evaluateReplayEligibility(regime, ledgerCapital).reasons.join(",")).to.contain("regime_entry_filters");

        const smartSized = evaluateReplayEligibility(base, { ...ledgerCapital, sizingMode: "smart_fixed_velocity_memory" });
        expect(smartSized.reasons.join(",")).to.contain("dynamic_sizing");

        const bothDirections = { ...base, tradeDirection: "both" } as unknown as BacktestSettings;
        expect(evaluateReplayEligibility(bothDirections, ledgerCapital).reasons.join(",")).to.contain("both_direction_reversals");

        // Cooldown + maxOpenTrades are POSITION-state — never blockers.
        const cooldown = resolveExecutorBacktestSettings({
            ...ledgerSettings, riskCooldownEnabled: true, riskCooldownBars: 3, maxOpenTrades: 2, interval: "4h",
        } as BacktestSettings, "4h");
        expect(evaluateReplayEligibility(cooldown, ledgerCapital).eligible).to.equal(true);
    });
});

// ============================================================================
// Writer
// ============================================================================

function makeMemDeps(): { files: Map<string, string>; deps: TradeLedgerWriterDeps; delays: number[] } {
    const files = new Map<string, string>();
    const delays: number[] = [];
    const deps = {
        mkdir: (async (p: unknown) => {
            files.set(String(p), files.get(String(p)) ?? "");
        }) as unknown as TradeLedgerWriterDeps["mkdir"],
        appendFile: (async (p: unknown, data: unknown) => {
            const key = String(p);
            files.set(key, (files.get(key) ?? "") + String(data));
        }) as unknown as TradeLedgerWriterDeps["appendFile"],
        writeFile: (async (p: unknown, data: unknown) => {
            files.set(String(p), String(data));
        }) as unknown as TradeLedgerWriterDeps["writeFile"],
        delay: (async (ms: number) => {
            delays.push(ms);
        }) as unknown as TradeLedgerWriterDeps["delay"],
    };
    return { files, deps, delays };
}

function sampleRow(overrides: Partial<TradeLedgerRow>): TradeLedgerRow {
    return {
        ledgerVersion: 2,
        pair: "A+B",
        direction: "long",
        signalTime: 1000,
        signalBarIndex: 10,
        fillTime: 3600,
        fillPrice: 101,
        executed: true,
        notExecutedReason: null,
        feat_entryRangePosition: 50,
        feat_atrPct: 1,
        feat_return20: 2,
        feat_gapPct: 0.1,
        feat_dow: 1,
        feat_hour: 12,
        feat_pairWinRatePrior: null,
        feat_pairTradesPrior: 0,
        feat_rank: null,
        feat_candidatesAtTime: null,
        asIf: null,
        asIfReason: null,
        exitTime: 7200,
        exitPrice: 103,
        pnlPercent: 2,
        fees: 0.1,
        exitReason: "signal",
        ...overrides,
    };
}

const STARTED_AT = new Date(2026, 7, 29, 14, 12).getTime();

const sampleProvenance = {
    ledgerVersion: 2,
    featureVersion: 2,
    runId: "batch-abc",
    startedAt: new Date(STARTED_AT).toISOString(),
    interval: "4h",
    strategyKey: "s",
    strategyParams: {},
    backtestSettings: {},
    capitalSettings: {},
    engineMode: "typescript" as const,
    executionModel: "next_open",
    tradeDirection: "long",
    riskMode: "percentage",
    fees: { commissionPercent: 0, slippageBps: 5 },
    pairCount: 2,
    symbols: ["A+B", "C+D"],
    replay: {
        replayEligible: true,
        replayBlockers: [],
        maxOpenTrades: 1 as const,
        cooldownBars: 0,
        executionModel: "next_open",
        tradeDirection: "long",
        allowSameBarExit: false,
        disableSignalExits: true,
        slippageRate: 0.0005,
        commissionRate: 0,
    },
};

describe("trade ledger writer", () => {
    it("writes provenance, incremental ledger rows, ranks, and a summary", async () => {
        const { files, deps } = makeMemDeps();
        const writer = await TradeLedgerWriter.create({
            rootDir: "tmp-root",
            folder: "led",
            runId: "batch-abc",
            startedAtMs: STARTED_AT,
            provenance: sampleProvenance,
            deps,
        });
        expect(writer).to.not.equal(null);
        const runDirName = `${formatLedgerRunStamp(STARTED_AT)}_batch-abc`;

        await writer!.appendPairRows({
            rows: [
                sampleRow({ pair: "A+B", executed: true, pnlPercent: 2 }),
                sampleRow({ pair: "A+B", executed: false, notExecutedReason: "position_open" }),
            ],
            duplicatesCollapsed: 3,
            rightCensored: 1,
        });
        // Cross-sectional tuples: two pairs signaling at the same time.
        await writer!.appendPairRows({
            rows: [sampleRow({ pair: "C+D", executed: true, pnlPercent: -1 })],
            duplicatesCollapsed: 0,
            rightCensored: 0,
        });
        const result = await writer!.finalize({
            cancelled: false,
            finishedAtMs: STARTED_AT + 5,
            accounting: { submittedPairs: 3, loadedPairs: 2 },
        });

        expect(result.ledgerComplete).to.equal(true);
        expect(result.totals).to.deep.equal({ pairs: 2, signals: 3, executed: 2, notExecuted: 1 });

        const runDir = path.join("tmp-root", "led", runDirName);
        const provenance = JSON.parse(files.get(path.join(runDir, "provenance.json"))!);
        expect(provenance.runId).to.equal("batch-abc");
        expect(provenance.replay.replayEligible).to.equal(true);
        expect(provenance.featureVersion).to.equal(2);

        const ledgerLines = files.get(path.join(runDir, "ledger.jsonl"))!.split("\n").filter((l) => l.trim());
        expect(ledgerLines.length).to.equal(3);

        const ranks = files.get(path.join(runDir, "signal-ranks.jsonl"))!.split("\n").filter((l) => l.trim())
            .map((l) => JSON.parse(l));
        // Ascending pair order at the shared timestamp: A+B rank 1, C+D rank 2.
        expect(ranks).to.deep.equal([
            { signalTime: 1000, pair: "A+B", rank: 1, candidatesAtTime: 2 },
            { signalTime: 1000, pair: "C+D", rank: 2, candidatesAtTime: 2 },
        ]);

        const summary = JSON.parse(files.get(path.join(runDir, "summary.json"))!);
        expect(summary.ledgerComplete).to.equal(true);
        expect(summary.totals).to.deep.equal({ pairs: 2, signals: 3, executed: 2, notExecuted: 1 });
        expect(summary.suppressionRate).to.equal(1 / 3);
        expect(summary.rightCensored).to.equal(1);
        expect(summary.duplicateSignalsCollapsed).to.equal(3);
        expect(summary.topSuppressedPairs[0]!.pair).to.equal("A+B");
        expect(summary.cancelled).to.equal(false);
        // W4 pair accounting: 3 submitted, 2 loaded, both row-bearing, 1 pair
        // failed to load (3 - 2), 0 empty, no dropped rows.
        expect(summary.submittedPairs).to.equal(3);
        expect(summary.loadedPairs).to.equal(2);
        expect(summary.rowBearingPairs).to.equal(2);
        expect(summary.emptyPairs).to.equal(0);
        expect(summary.failedPairs).to.deep.equal([]);
    });

    it("records write failures instead of throwing, and marks ledgerComplete false", async () => {
        const { files, deps } = makeMemDeps();
        const failingAppend = (async () => {
            // Non-retryable error class: fails on the first attempt.
            throw new Error("disk full");
        }) as unknown as TradeLedgerWriterDeps["appendFile"];
        const writer = await TradeLedgerWriter.create({
            rootDir: "tmp-root",
            folder: "led",
            runId: "batch-err",
            startedAtMs: STARTED_AT,
            provenance: { ...sampleProvenance, runId: "batch-err" },
            deps: { ...deps, appendFile: failingAppend },
        });
        // Append must not throw.
        await writer!.appendPairRows({ rows: [sampleRow({ pair: "LOST+PAIR" })], duplicatesCollapsed: 0, rightCensored: 0 });
        const result = await writer!.finalize({ cancelled: true, finishedAtMs: STARTED_AT + 5 });
        expect(result.ledgerComplete).to.equal(false);
        expect(result.failedWrites).to.equal(2); // ledger append + ranks append
        expect(result.lastError).to.equal("disk full");
        // summary.json (writeFile) still lands, carrying the failure + W2 pair identities.
        const summary = JSON.parse(files.get(path.join("tmp-root", "led", `${formatLedgerRunStamp(STARTED_AT)}_batch-err`, "summary.json"))!);
        expect(summary.ledgerComplete).to.equal(false);
        expect(summary.failedWrites).to.equal(2);
        expect(summary.failedPairs).to.deep.equal(["LOST+PAIR"]);
        expect(summary.cancelled).to.equal(true);
    });

    it("retries transient append errors and lands the row without recording a failure", async () => {
        const { files, deps, delays } = makeMemDeps();
        let ledgerAttempts = 0;
        const flakyAppend = (async (p: unknown, data: unknown) => {
            if (!String(p).endsWith("ledger.jsonl")) {
                const key = String(p);
                files.set(key, (files.get(key) ?? "") + String(data));
                return;
            }
            ledgerAttempts += 1;
            if (ledgerAttempts <= 2) {
                const error = new Error("resource busy") as NodeJS.ErrnoException;
                error.code = "EBUSY";
                throw error;
            }
            const key = String(p);
            files.set(key, (files.get(key) ?? "") + String(data));
        }) as unknown as TradeLedgerWriterDeps["appendFile"];
        const writer = await TradeLedgerWriter.create({
            rootDir: "tmp-root",
            folder: "led",
            runId: "batch-retry",
            startedAtMs: STARTED_AT,
            provenance: { ...sampleProvenance, runId: "batch-retry" },
            deps: { ...deps, appendFile: flakyAppend },
        });
        await writer!.appendPairRows({ rows: [sampleRow({ pair: "OK+PAIR" })], duplicatesCollapsed: 0, rightCensored: 0 });
        const result = await writer!.finalize({ cancelled: false, finishedAtMs: STARTED_AT + 5 });
        // 3 attempts total on the LEDGER path: initial + 2 retries, backoff
        // 50ms then 200ms.
        expect(ledgerAttempts).to.equal(3);
        expect(delays).to.deep.equal([50, 200]);
        expect(result.ledgerComplete).to.equal(true);
        expect(result.failedWrites).to.equal(0);
        const ledgerLines = files.get(path.join("tmp-root", "led", `${formatLedgerRunStamp(STARTED_AT)}_batch-retry`, "ledger.jsonl"))!.split("\n").filter((l) => l.trim());
        expect(ledgerLines.length).to.equal(1);
        expect(JSON.parse(ledgerLines[0]!).pair).to.equal("OK+PAIR");
    });

    it("gives up after 3 attempts on a persistent transient error and records the failed pair", async () => {
        const { files, deps } = makeMemDeps();
        let ledgerAttempts = 0;
        const busyAppend = (async (p: unknown) => {
            if (!String(p).endsWith("ledger.jsonl")) {
                files.set(String(p), "");
                return;
            }
            ledgerAttempts += 1;
            const error = new Error("stale handle") as NodeJS.ErrnoException;
            error.code = "ESTALE";
            throw error;
        }) as unknown as TradeLedgerWriterDeps["appendFile"];
        const writer = await TradeLedgerWriter.create({
            rootDir: "tmp-root",
            folder: "led",
            runId: "batch-stale",
            startedAtMs: STARTED_AT,
            provenance: { ...sampleProvenance, runId: "batch-stale" },
            deps: { ...deps, appendFile: busyAppend },
        });
        await writer!.appendPairRows({ rows: [sampleRow({ pair: "STALE+PAIR" })], duplicatesCollapsed: 0, rightCensored: 0 });
        expect(ledgerAttempts).to.equal(3);
        const result = await writer!.finalize({ cancelled: false, finishedAtMs: STARTED_AT + 5 });
        expect(result.ledgerComplete).to.equal(false);
        expect(result.failedWrites).to.be.at.least(1);
        const summary = JSON.parse(files.get(path.join("tmp-root", "led", `${formatLedgerRunStamp(STARTED_AT)}_batch-stale`, "summary.json"))!);
        expect(summary.failedPairs).to.deep.equal(["STALE+PAIR"]);
    });

    it("rejects unsafe folders and returns null on setup failure", async () => {
        expect(sanitizeTradeLedgerFolder("../escape")).to.equal(null);
        expect(sanitizeTradeLedgerFolder("C:/temp")).to.equal(null);
        expect(sanitizeTradeLedgerFolder("/abs")).to.equal(null);
        expect(sanitizeTradeLedgerFolder("a/./b")).to.equal(null);
        expect(sanitizeTradeLedgerFolder("a//b")).to.equal(null);
        expect(sanitizeTradeLedgerFolder(" archive/mining-ledger ")).to.equal("archive/mining-ledger");
        expect(sanitizeTradeLedgerFolder("a\\b\\c")).to.equal("a/b/c");

        const nullWriter = await TradeLedgerWriter.create({
            rootDir: "tmp-root",
            folder: "../escape",
            runId: "x",
            startedAtMs: STARTED_AT,
            provenance: sampleProvenance,
        });
        expect(nullWriter).to.equal(null);
    });
});

// ============================================================================
// W6: request-body wire contract
// ============================================================================

describe("trade ledger request body wire contract", () => {
    it("omits the ledger field when OFF and includes it when ON", () => {
        expect(buildBatchRunLedgerBodyField({ enabled: false, folder: "x" })).to.deep.equal({});
        expect(buildBatchRunLedgerBodyField(null)).to.deep.equal({});
        expect(buildBatchRunLedgerBodyField(undefined)).to.deep.equal({});
        expect(buildBatchRunLedgerBodyField({ enabled: true, folder: "archive/mining-ledger" })).to.deep.equal({
            tradeLedger: { enabled: true, folder: "archive/mining-ledger" },
        });
    });
});

// ============================================================================
// W8: completionContext.signals forwarding + expiry
// ============================================================================

const ledgerTestStrategy: Strategy = {
    name: "Ledger Test",
    description: "Deterministic buy/sell for ledger integration tests.",
    defaultParams: {},
    paramLabels: {},
    execute(data) {
        if (data.length < 3) return [];
        return [
            { time: data[1]!.time, type: "buy", price: data[1]!.close, barIndex: 1 },
            { time: data[data.length - 1]!.time, type: "sell", price: data[data.length - 1]!.close },
        ];
    },
};

describe("trade ledger completion context forwarding", () => {
    it("forwards the pair's signals to onSymbolComplete and does not retain them on the row", async () => {
        const captured: Array<{ rowSignals: unknown; contextSignals: readonly Signal[] | undefined }> = [];
        await runBatchBacktest(
            {
                interval: "5m",
                strategyKey: "ledger-context-test",
                strategy: ledgerTestStrategy,
                strategyParams: {},
                backtestSettings: ledgerSettings,
                capitalSettings: ledgerCapital,
                symbols: ["PLAIN"],
                loadDataset: () => Promise.resolve(makeBars(6).map((b) => ({ ...b, time: (seconds(b.time) + 1) as Time }))),
                minUsableBars: 1,
            },
            {
                setProgress: () => {},
                setStatus: () => {},
                isCancelled: () => false,
                onSymbolComplete: async (_index, row, context: BatchSymbolCompletionContext | undefined) => {
                    captured.push({ rowSignals: row.signals, contextSignals: context?.signals });
                },
            },
        );
        expect(captured.length).to.equal(1);
        // Non-synthetic rows drop their own signals (memory contract)…
        expect(captured[0]!.rowSignals).to.equal(undefined);
        // …but the context forwards the engine-consumed signals.
        expect(captured[0]!.contextSignals?.length).to.equal(2);
    });

    it("child process with --expose-gc proves the forwarded context is collectable (W5)", () => {
        // The in-process spec cannot force GC (global.gc is undefined without
        // --expose-gc), so the collection check runs in a child process that
        // has it. The child asserts the WeakRef collects after the callback
        // resolves and exits non-zero on failure — the check ALWAYS executes.
        const repoRoot = process.cwd();
        const tsxCli = path.resolve(repoRoot, "../../../node_modules/tsx/dist/cli.mjs");
        expect(existsSync(tsxCli), `tsx cli not found at ${tsxCli}`).to.equal(true);
        const fixturePath = path.join(repoRoot, "artifacts", "test-logs", "trade-ledger-gc-fixture.ts");
        mkdirSync(path.dirname(fixturePath), { recursive: true });
        writeFileSync(fixturePath, GC_CHILD_FIXTURE);
        try {
        const result = spawnSync(process.execPath, [tsxCli, fixturePath], {
            encoding: "utf8",
            timeout: 120_000,
            cwd: repoRoot,
            // --expose-gc must survive any process tsx spawns internally.
            env: { ...process.env, NODE_OPTIONS: "--expose-gc" },
        });
            const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
            // The child must actually RUN the check — a skip is a failure.
            expect(
                output.includes("GC_CHECK_PASSED") || output.includes("GC_CHECK_FAILED"),
                `child did not execute the check: ${output}`,
            ).to.equal(true);
            expect(result.status, output).to.equal(0);
            expect(result.stdout).to.include("GC_CHECK_PASSED");
        } finally {
            rmSync(fixturePath, { force: true });
        }
    });
});

/**
 * Child fixture: runs the real runner once, takes a WeakRef to the forwarded
 * context signals, drops all strong references, forces GC, and exits 0 only
 * when the array was collected.
 */
const GC_CHILD_FIXTURE = `
import { runBatchBacktest } from "../../lib/batch-backtest/batch-backtest-runner";
import type { OHLCVData, Strategy, Time } from "../../lib/types/strategies";

const strategy: Strategy = {
    name: "GC Fixture",
    description: "Deterministic buy/sell for the WeakRef collection check.",
    defaultParams: {},
    paramLabels: {},
    execute(data) {
        if (data.length < 3) return [];
        return [
            { time: data[1]!.time, type: "buy", price: data[1]!.close, barIndex: 1 },
            { time: data[data.length - 1]!.time, type: "sell", price: data[data.length - 1]!.close },
        ];
    },
};

async function main(): Promise<void> {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (typeof gc !== "function") {
        console.error("GC_CHECK_FAILED: --expose-gc missing");
        process.exit(1);
    }
    let weak: WeakRef<readonly unknown[]> | null = null;
    await runBatchBacktest(
        {
            interval: "5m",
            strategyKey: "gc-fixture",
            strategy,
            strategyParams: {},
            backtestSettings: {
                executionModel: "signal_close",
                tradeDirection: "long",
                allowSameBarExit: true,
                slippageBps: 0,
                marketMode: "all",
            },
            capitalSettings: {
                initialCapital: 10000,
                positionSize: 100,
                commission: 0,
                sizingMode: "percent",
                fixedTradeAmount: 1000,
            },
            symbols: ["PLAIN"],
            loadDataset: () => Promise.resolve(
                Array.from({ length: 6 }, (_, i) => ({
                    time: (1_700_000_000 + i * 300) as Time,
                    open: 100 + i,
                    high: 101 + i,
                    low: 99 + i,
                    close: 100 + i,
                    volume: 1000,
                }) as OHLCVData),
            ),
            minUsableBars: 1,
        },
        {
            setProgress: () => {},
            setStatus: () => {},
            isCancelled: () => false,
            onSymbolComplete: async (_index, _row, context) => {
                weak = new WeakRef(context!.signals!);
            },
        },
    );
    // Run the GC cycles WITHOUT polling deref() inside the loop: a non-empty
    // deref() re-pins the target for the current job (WeakRef spec) and would
    // prevent collection entirely.
    for (let attempt = 0; attempt < 8; attempt += 1) {
        gc();
        await new Promise((resolve) => setImmediate(resolve));
    }
    if (weak!.deref() !== undefined) {
        console.error("GC_CHECK_FAILED: context signals still retained");
        process.exit(1);
    }
    console.log("GC_CHECK_PASSED");
}
void main();
`;

// ============================================================================
// processRunBatch integration
// ============================================================================

const STRATEGY_KEY = "trade_ledger_test";

const integrationSettings: BacktestSettings = {
    executionModel: "signal_close",
    tradeDirection: "long",
    allowSameBarExit: true,
    slippageBps: 0,
    marketMode: "all",
};

function makeCandles(closes: number[]): OHLCVData[] {
    return closes.map((close, index) => ({
        time: (1_700_000_000 + index * 300) as Time,
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1000,
    }));
}

async function collectEvents(run: (ev: BatchStreamEvent[]) => Promise<void>): Promise<BatchStreamEvent[]> {
    const events: BatchStreamEvent[] = [];
    await run(events);
    return events;
}

describe("trade ledger processRunBatch integration", () => {
    const tmpRoot = path.join(process.cwd(), "artifacts", "test-logs", "trade-ledger-spec");

    before(() => {
        strategyRegistry.register(STRATEGY_KEY, ledgerTestStrategy);
        rmSync(tmpRoot, { recursive: true, force: true });
        mkdirSync(tmpRoot, { recursive: true });
        setLedgerRootDirForTests(tmpRoot);
    });

    after(async () => {
        setLedgerRootDirForTests(null);
        strategyRegistry.unregister(STRATEGY_KEY);
        await releaseLastResults("ledger_spec_cleanup");
        rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("toggle OFF produces no ledger folder", async () => {
        const owner = 8701;
        setRunOwnerForTests(owner);
        await collectEvents((ev) => processRunBatch(
            {
                interval: "5m",
                strategyKey: STRATEGY_KEY,
                strategy: ledgerTestStrategy,
                strategyParams: {},
                backtestSettings: integrationSettings,
                capitalSettings: ledgerCapital,
                symbols: ["UP"],
                loadDataset: () => Promise.resolve(makeCandles([100, 105, 110, 115, 120])),
                minUsableBars: 1,
            },
            (event) => ev.push(event),
            owner,
            "batch-off",
        ));
        expect(readdirSync(tmpRoot)).to.deep.equal([]);
        setRunOwnerForTests(0);
        await releaseLastResults("toggle_off_end");
    });

    it("toggle ON writes a complete v2 run folder; rows/events are identical to toggle OFF", async () => {
        const makeInput = () => ({
            interval: "5m",
            strategyKey: STRATEGY_KEY,
            strategy: ledgerTestStrategy,
            strategyParams: {},
            backtestSettings: integrationSettings,
            capitalSettings: ledgerCapital,
            symbols: ["UP", "DOWN"],
            loadDataset: (symbol: string) => Promise.resolve(
                symbol === "UP"
                    ? makeCandles([100, 105, 110, 115, 120])
                    : makeCandles([100, 95, 90, 85, 80]),
            ),
            minUsableBars: 1,
        });

        // OFF reference run.
        const ownerOff = 8702;
        setRunOwnerForTests(ownerOff);
        const offEvents = await collectEvents((ev) => processRunBatch(
            { ...makeInput() },
            (event) => ev.push(event),
            ownerOff,
            "batch-ref",
        ));
        const offRows = __testInternals.getRunStateForTests()?.rows ?? [];
        setRunOwnerForTests(0);
        await releaseLastResults("ref_end");

        // ON run.
        const ownerOn = 8703;
        setRunOwnerForTests(ownerOn);
        const onEvents = await collectEvents((ev) => processRunBatch(
            { ...makeInput(), tradeLedger: { enabled: true, folder: "ledger-run" } },
            (event) => ev.push(event),
            ownerOn,
            "batch-ref",
        ));

        // Stream events are byte-identical except wall-clock timings/cache
        // stats (which are not results).
        const strip = (events: BatchStreamEvent[]) => events.map((e) => {
            const { performance: _p, cacheStats: _c, ...rest } = e as typeof e & { performance?: unknown; cacheStats?: unknown };
            return rest;
        });
        expect(JSON.stringify(strip(onEvents))).to.equal(JSON.stringify(strip(offEvents)));
        const onRows = __testInternals.getRunStateForTests()?.rows ?? [];
        expect(JSON.stringify(onRows)).to.equal(JSON.stringify(offRows));

        const done = onEvents[onEvents.length - 1]!;
        expect(done.type).to.equal("done");
        expect((done as Extract<BatchStreamEvent, { type: "done" }>).summary).to.not.include("ledger");

        // Folder contents.
        const runDirs = readdirSync(path.join(tmpRoot, "ledger-run"))
            .filter((entry) => statSync(path.join(tmpRoot, "ledger-run", entry)).isDirectory());
        expect(runDirs.length).to.equal(1);
        const runDir = path.join(tmpRoot, "ledger-run", runDirs[0]!);
        expect(runDirs[0]).to.equal(`${formatLedgerRunStamp(__testInternals.getRunStateForTests()!.startedAt)}_batch-ref`);
        for (const file of ["provenance.json", "ledger.jsonl", "signal-ranks.jsonl", "summary.json"]) {
            expect(existsSync(path.join(runDir, file)), file).to.equal(true);
        }

        const ledgerRows = readFileSync(path.join(runDir, "ledger.jsonl"), "utf8")
            .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as TradeLedgerRow);
        expect(ledgerRows.length).to.equal(2);
        // signal_close + long: the bar-1 buy executes; the trailing sell is
        // not an entry candidate in long mode.
        const buyRow = ledgerRows.find((r) => r.signalBarIndex === 1)!;
        expect(buyRow.executed).to.equal(true);
        expect(buyRow.fillPrice).to.equal(105);
        expect(buyRow.exitTime).to.be.a("number");
        expect(ledgerRows.filter((r) => r.pair === "DOWN").length).to.equal(1);
        // v2: the as-if outcome mirrors the REAL trade's engine math.
        expect(buyRow.asIf).to.not.equal(null);
        expect(buyRow.asIf!.exitReason).to.equal("signal");
        expect(buyRow.asIf!.pnlPercent).to.be.closeTo(buyRow.pnlPercent!, 1e-9);

        const summary = JSON.parse(readFileSync(path.join(runDir, "summary.json"), "utf8"));
        expect(summary.ledgerComplete).to.equal(true);
        expect(summary.totals.signals).to.equal(2);
        expect(summary.totals.executed).to.equal(2);
        expect(summary.ledgerVersion).to.equal(2);

        const provenance = JSON.parse(readFileSync(path.join(runDir, "provenance.json"), "utf8"));
        expect(provenance.runId).to.equal("batch-ref");
        expect(provenance.strategyKey).to.equal(STRATEGY_KEY);
        expect(provenance.pairCount).to.equal(2);
        expect(provenance.replay.replayEligible).to.equal(true);
        expect(provenance.replay.replayBlockers).to.deep.equal([]);

        setRunOwnerForTests(0);
        await releaseLastResults("toggle_on_end");
    });

    it("a ledger setup failure does not fail the run and is visible in the summary", async () => {
        // A FILE where the folder should be: mkdir fails -> writer is null.
        const blocker = path.join(tmpRoot, "blocker");
        writeFileSync(blocker, "not a dir");
        const owner = 8704;
        setRunOwnerForTests(owner);
        const events = await collectEvents((ev) => processRunBatch(
            {
                interval: "5m",
                strategyKey: STRATEGY_KEY,
                strategy: ledgerTestStrategy,
                strategyParams: {},
                backtestSettings: integrationSettings,
                capitalSettings: ledgerCapital,
                symbols: ["UP"],
                loadDataset: () => Promise.resolve(makeCandles([100, 105, 110, 115, 120])),
                minUsableBars: 1,
                tradeLedger: { enabled: true, folder: "blocker/sub" },
            },
            (event) => ev.push(event),
            owner,
            "batch-fail",
        ));
        const done = events[events.length - 1] as Extract<BatchStreamEvent, { type: "done" }>;
        expect(done.type).to.equal("done");
        expect(done.summary).to.include("trade ledger incomplete");
        setRunOwnerForTests(0);
        await releaseLastResults("fail_path_end");
    });
});

// ============================================================================
// W6: HTTP-level route contract (body neutral, stream payloads unchanged)
// ============================================================================

describe("trade ledger HTTP route contract", () => {
    const tmpRoot = path.join(process.cwd(), "artifacts", "test-logs", "trade-ledger-http-spec");

    function captureBatchRoutes(): Map<string, (req: unknown, res: unknown) => Promise<void>> {
        const routes = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
        __testInternals.registerBatchRoutesForTests({
            use: (p: string, handler: (req: unknown, res: unknown) => Promise<void>) => routes.set(p, handler),
        });
        return routes;
    }

    function makeStreamingResponse(): { statusCode: number; chunks: string[]; body: string; headers: Record<string, unknown>; setHeader: (k: string, v: unknown) => void; write: (c: unknown) => boolean; end: (c?: unknown) => void; on: () => void } {
        const response = {
            statusCode: 0,
            chunks: [] as string[],
            body: "",
            headers: {} as Record<string, unknown>,
            setHeader: (k: string, v: unknown) => { response.headers[k] = v; },
            write: (c: unknown) => { response.chunks.push(String(c)); return true; },
            end: (c?: unknown) => {
                if (c !== undefined) response.chunks.push(String(c));
                response.body = response.chunks.join("");
            },
            on: () => response,
        };
        return response;
    }

    function makeRequest(body: unknown): unknown {
        return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
            method: "POST",
            url: "/api/batch-backtest/run",
            headers: { host: "127.0.0.1:5173", "content-type": "application/json" },
            socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", localPort: 5173 },
        });
    }

    before(() => {
        strategyRegistry.register(STRATEGY_KEY, ledgerTestStrategy);
        rmSync(tmpRoot, { recursive: true, force: true });
        mkdirSync(tmpRoot, { recursive: true });
        setLedgerRootDirForTests(tmpRoot);
    });

    after(async () => {
        setLedgerRootDirForTests(null);
        strategyRegistry.unregister(STRATEGY_KEY);
        await releaseLastResults("http_spec_cleanup");
        rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("POST /api/batch-backtest/run: stream payloads identical OFF vs ON; folder only when ON", async () => {
        const routes = captureBatchRoutes();
        const handler = routes.get("/api/batch-backtest/run")!;
        expect(handler).to.not.equal(undefined);

        const makeBody = (withLedger: boolean) => ({
            symbols: ["ZZZNOPE•"],
            interval: "4h",
            strategyKey: STRATEGY_KEY,
            strategyParams: {},
            backtestSettings: integrationSettings,
            capitalSettings: ledgerCapital,
            useRustEnginePreference: false,
            runId: "batch-http",
            ...(withLedger ? { tradeLedger: { enabled: true, folder: "http-ledger" } } : {}),
        });

        setRunOwnerForTests(0);
        const parseEvents = (chunks: string[]) => chunks
            .map((c) => c.trim())
            .filter((c) => c.length > 0)
            .map((c) => JSON.parse(c) as Record<string, unknown>);

        const resOff = makeStreamingResponse();
        await handler(makeRequest(makeBody(false)), resOff);
        const offEvents = parseEvents(resOff.chunks);
        const offDone = offEvents[offEvents.length - 1]!;
        expect(offDone.type, JSON.stringify(offEvents.map((e) => e.type))).to.equal("done");

        const resOn = makeStreamingResponse();
        await handler(makeRequest(makeBody(true)), resOn);
        const onEvents = parseEvents(resOn.chunks);
        const onDone = onEvents[onEvents.length - 1]!;
        expect(onDone.type).to.equal("done");

        // Stream result payloads are unchanged except wall-clock fields.
        const stripChunks = (events: ReturnType<typeof parseEvents>) => events.map((e) => {
            const parsed = { ...e };
            delete parsed.performance;
            delete parsed.cacheStats;
            return parsed;
        });
        expect(stripChunks(onEvents)).to.deep.equal(stripChunks(offEvents));

        // The ON run wrote a ledger folder; the OFF run wrote nothing.
        const ledgerRoot = path.join(tmpRoot, "http-ledger");
        expect(statSync(ledgerRoot).isDirectory()).to.equal(true);
        const runDirs = readdirSync(ledgerRoot);
        expect(runDirs.length).to.equal(1);
        expect(existsSync(path.join(ledgerRoot, runDirs[0]!, "provenance.json"))).to.equal(true);
        expect(JSON.parse(readFileSync(path.join(ledgerRoot, runDirs[0]!, "summary.json"), "utf8")).ledgerVersion).to.equal(2);

        setRunOwnerForTests(0);
        await releaseLastResults("http_end");
    });
});
