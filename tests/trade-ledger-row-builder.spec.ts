import { expect } from "chai";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { runBatchBacktest, type BatchSymbolCompletionContext } from "../lib/batch-backtest/batch-backtest-runner";
import {
    TRADE_LEDGER_FEATURE_ATR_PERIOD,
    TRADE_LEDGER_VERSION,
    buildTradeLedgerRowsForPair,
    type TradeLedgerRow,
} from "../lib/batch-backtest/trade-ledger-row-builder";
import { buildAsIfPairModel, evaluateReplayEligibility, type AsIfPairModel } from "../lib/batch-backtest/trade-ledger-asif";
import { resolveExecutorBacktestSettings } from "../lib/backtest-executor";
import { calculateATR } from "../lib/strategies/indicators";
import type { CapitalSettings } from "../lib/types/backtest";
import type { BacktestSettings, OHLCVData, Signal, Strategy, Time, Trade } from "../lib/types/strategies";

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
        // (flat + unblocked but no trade matched â€” a counted category).
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
        // row's fillPrice legitimately reads bar i+1 â€” that IS the fill.)
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

    it("computes v3 pair-fire spacing, spread volatility, and aligned leg ratio", () => {
        const alternatingCloses = (count: number, changePct: number): number[] => {
            const closes = [100];
            for (let i = 0; i < count - 1; i += 1) {
                closes.push(closes[i]! * (1 + (i % 2 === 0 ? changePct : -changePct) / 100));
            }
            return closes;
        };
        const pairCloses = alternatingCloses(24, 10);
        const baseCloses = alternatingCloses(24, 20);
        const quoteCloses = alternatingCloses(24, 10);
        const pairData = pairCloses.map((close, index) => ({
            time: barTime(index),
            open: close,
            high: close + 1,
            low: close - 1,
            close,
            volume: 1000,
        }));
        const signals = [21, 23].map((index) => makeSignal({
            time: pairData[index]!.time,
            type: "buy",
            price: pairData[index]!.close,
            barIndex: index,
        }));
        const { rows } = buildTradeLedgerRowsForPair({
            pair: "BASE+QUOTE",
            baseSymbol: "BASEUSDT",
            quoteSymbol: "QUOTEUSDT",
            data: pairData,
            signals,
            trades: [],
            context: { ...ledgerContext, executionModel: "signal_close" },
            baseCloses,
            quoteCloses,
        });

        expect(rows[0]!.baseSymbol).to.equal("BASEUSDT");
        expect(rows[0]!.quoteSymbol).to.equal("QUOTEUSDT");
        expect(rows[0]!.feat_barsSincePairLastFire).to.equal(null);
        expect(rows[1]!.feat_barsSincePairLastFire).to.equal(2);
        // The twenty prior changes are exactly alternating +10%/-10% and
        // +20%/-20%, so their population standard deviations are 10 and 20.
        expect(rows[0]!.feat_pairSpreadVolatility20).to.be.closeTo(10, 1e-12);
        expect(rows[0]!.feat_legVolatilityRatio20).to.be.closeTo(2, 1e-12);
    });

    it("returns null for v3 volatility warm-up, invalid closes, missing legs, and zero quote volatility", () => {
        const alternatingCloses = (count: number, changePct: number): number[] => {
            const values = [100];
            for (let i = 0; i < count - 1; i += 1) {
                values.push(values[i]! * (1 + (i % 2 === 0 ? changePct : -changePct) / 100));
            }
            return values;
        };
        const closes = Array.from({ length: 24 }, (_, index) => 100 + index);
        const data = closes.map((close, index) => ({
            time: barTime(index),
            open: close,
            high: close + 1,
            low: close - 1,
            close,
            volume: 1000,
        }));
        const build = (
            index: number,
            pairCloses = closes,
            baseCloses?: readonly (number | null)[],
            quoteCloses?: readonly (number | null)[],
        ) => buildTradeLedgerRowsForPair({
            pair: "BASE+QUOTE",
            data: data.map((bar, barIndex) => ({ ...bar, close: pairCloses[barIndex]! })),
            signals: [makeSignal({ time: barTime(index), type: "buy", price: pairCloses[index]!, barIndex: index })],
            trades: [],
            context: { ...ledgerContext, executionModel: "signal_close" },
            baseCloses,
            quoteCloses,
        }).rows[0]!;

        expect(build(19).feat_pairSpreadVolatility20).to.equal(null);
        const invalidPair = [...closes];
        invalidPair[1] = 0;
        expect(build(21, invalidPair, alternatingCloses(24, 20), alternatingCloses(24, 10)).feat_pairSpreadVolatility20).to.equal(null);
        expect(build(21, closes, undefined, undefined).feat_legVolatilityRatio20).to.equal(null);
        expect(build(21, closes, alternatingCloses(20, 20), alternatingCloses(20, 10)).feat_legVolatilityRatio20).to.equal(null);
        expect(build(21, closes, alternatingCloses(24, 20), Array(24).fill(100)).feat_legVolatilityRatio20).to.equal(null);
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

    it("records fixed-horizon prices from the fill bar and direction-adjusted returns", () => {
        const handBars: OHLCVData[] = [
            100, 101, 102, 110, 111,
        ].map((close, index) => ({
            time: barTime(index),
            open: close - 1,
            high: close + 1,
            low: close - 2,
            close,
            volume: 1,
        }));
        const long = buildTradeLedgerRowsForPair({
            pair: "HAND",
            data: handBars,
            signals: [makeSignal({ time: barTime(1), type: "buy", barIndex: 1 })],
            trades: [],
            context: { ...ledgerContext, executionModel: "signal_close", ledgerHorizons: [2] },
        }).rows[0]!;
        expect(long.horizons["2"]).to.deep.equal({
            entryTimeSec: BASE_TIME + HOUR,
            entryPrice: 100,
            exitTimeSec: BASE_TIME + 3 * HOUR,
            exitPrice: 110,
            pnlPercent: 110 / 100 - 1,
            status: "ok",
        });

        const nextOpen = buildTradeLedgerRowsForPair({
            pair: "HAND",
            data: handBars,
            signals: [makeSignal({ time: barTime(1), type: "buy", barIndex: 1 })],
            trades: [],
            context: { ...ledgerContext, ledgerHorizons: [2] },
        }).rows[0]!;
        expect(nextOpen.horizons["2"]!.entryTimeSec).to.equal(BASE_TIME + 2 * HOUR);
        expect(nextOpen.horizons["2"]!.entryPrice).to.equal(101);
        expect(nextOpen.horizons["2"]!.exitTimeSec).to.equal(BASE_TIME + 4 * HOUR);
        expect(nextOpen.horizons["2"]!.exitPrice).to.equal(111);

        const short = buildTradeLedgerRowsForPair({
            pair: "HAND",
            data: handBars,
            signals: [makeSignal({ time: barTime(1), type: "sell", barIndex: 1 })],
            trades: [],
            context: { ...ledgerContext, tradeDirection: "short", executionModel: "signal_close", ledgerHorizons: [2] },
        }).rows[0]!;
        expect(short.horizons["2"]!.pnlPercent).to.be.closeTo(-0.1, 1e-12);

        const censored = buildTradeLedgerRowsForPair({
            pair: "HAND",
            data: handBars,
            signals: [makeSignal({ time: barTime(3), type: "buy", barIndex: 3 })],
            trades: [],
            context: { ...ledgerContext, executionModel: "signal_close", ledgerHorizons: [2] },
        }).rows[0]!;
        expect(censored.horizons["2"]).to.deep.equal({
            entryTimeSec: BASE_TIME + 3 * HOUR,
            entryPrice: 109,
            exitTimeSec: null,
            exitPrice: null,
            pnlPercent: null,
            status: "right_censored",
        });
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
        // fills at bar 13 open â€” exactly the engine's exit timing.
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

        // Cooldown + maxOpenTrades are POSITION-state â€” never blockers.
        const cooldown = resolveExecutorBacktestSettings({
            ...ledgerSettings, riskCooldownEnabled: true, riskCooldownBars: 3, maxOpenTrades: 2, interval: "4h",
        } as BacktestSettings, "4h");
        expect(evaluateReplayEligibility(cooldown, ledgerCapital).eligible).to.equal(true);
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

describe("batch completion context forwarding", () => {
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
        // Non-synthetic rows drop their own signals (memory contract)â€¦
        expect(captured[0]!.rowSignals).to.equal(undefined);
        // â€¦but the context forwards the engine-consumed signals.
        expect(captured[0]!.contextSignals?.length).to.equal(2);
    });

    it("child process with --expose-gc proves the forwarded context is collectable (W5)", () => {
        // The in-process spec cannot force GC (global.gc is undefined without
        // --expose-gc), so the collection check runs in a child process that
        // has it. The child asserts the WeakRef collects after the callback
        // resolves and exits non-zero on failure â€” the check ALWAYS executes.
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
            // The child must actually RUN the check â€” a skip is a failure.
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
