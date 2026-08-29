/**
 * As-if outcome engine for the trade ledger (v2).
 *
 * For every ENTRY SIGNAL of a pair, computes the trade that WOULD have
 * resulted if it had been entered — using the engine's own math, never a
 * parallel reimplementation:
 *   - entry fill: the same execution shift + price resolution the engine's
 *     `prepareSignals` performs (`getExecutionShift` + `resolveExecutionPrice`),
 *     then `applySlippage` exactly like `buildPositionFromSignal`;
 *   - entry levels: `resolveInitialExitLevels` — the extracted position-builder
 *     arming math (one shared source);
 *   - exit walk: the engine's own exported per-bar handlers
 *     (`processPositionExits` + `updatePositionState`) in the engine's per-bar
 *     order (open-only exits → signal exits → full exits → state update);
 *   - signal exits: the per-pair merged exit-signal series built through the
 *     REAL resolution path (`resolveExitStrategyOverrideSignals` +
 *     `mergeExitStrategySignals` + `prepareSignals`) — the same one a real run
 *     consumes;
 *   - pnl: `calculateTradeExitDetails` — the engine's trade-close math.
 *   - end-of-data: raw last-bar close, matching the engine's `end_of_data`
 *     trades (which pass candle.close to `recordExit` un-slipped).
 *
 * Validity: this is sound only when exits do NOT depend on prior
 * accepted-trade history. `evaluateReplayEligibility` refuses configs whose
 * exits are stateful (adaptive take-profit, path exits, partial take-profit,
 * win-streak stops, dynamic sizing, regime entry filters, both-direction
 * reversals with signal exits on). Cooldown and maxOpenTrades are POSITION
 * rules — the checker's replay state machine handles those itself and they do
 * not block eligibility.
 *
 * Import hygiene: bundled into the vite.config.ts build via the batch plugin.
 * Only node-safe lib modules may be imported here (no lightweight-charts).
 */

import { calculateATR } from "../strategies/indicators";
import { parseTimeToUnixSeconds } from "../time-normalization";
import {
    allowsSignalAsEntry,
    applySlippage,
    directionFactorFor,
    entrySideForDirection,
    exitSideForDirection,
    getExecutionShift,
    isBothLikeTradeDirection,
    normalizeTradeDirection,
    resolveExecutionPrice,
} from "../strategies/backtest/backtest-utils";
import { prepareSignals } from "../strategies/backtest/signal-preparation";
import {
    OPEN_ONLY_POSITION_EXIT_OPTIONS,
    STOP_LOSS_ONLY_POSITION_EXIT_OPTIONS,
    processPositionExits,
    updatePositionState,
} from "../strategies/backtest/exit-handlers";
import { resolveInitialExitLevels } from "../strategies/backtest/position-builder";
import { calculateTradeExitDetails } from "../strategies/backtest/position-stats";
import { resolveExitStrategyOverrideSignals } from "../backtest-executor";
import { mergeExitStrategySignals } from "../exit-strategy-merge";
import type { CapitalSettings, IndicatorSeries, NormalizedSettings, PositionState } from "../types/backtest";
import type {
    BacktestSettings,
    ExecutionModel,
    OHLCVData,
    Signal,
    TradeDirection,
} from "../types/strategies";

/** Bar-count shift from the decision bar to the fill bar. */
function executionShift(executionModel: ExecutionModel): number {
    return getExecutionShift({ executionModel } as unknown as NormalizedSettings);
}

/**
 * Replay eligibility for a RUN config (resolved settings + capital settings).
 * Every blocker names a mechanism whose exits/entries depend on prior
 * accepted-trade history or on engine-side gating the ledger candidates cannot
 * see. Cooldown + maxOpenTrades are position-state and intentionally absent.
 */
export function evaluateReplayEligibility(
    resolved: BacktestSettings,
    capitalSettings: CapitalSettings,
): { eligible: boolean; reasons: string[]; params: TradeLedgerReplayParams } {
    const reasons: string[] = [];
    const config = resolved as never as {
        marketMode?: string;
        trendEmaPeriod?: number;
        atrPercentMin?: number;
        atrPercentMax?: number;
        adxMin?: number;
        adxMax?: number;
        takeProfitMode?: string;
        pathExitEnabled?: boolean;
        pathExitMode?: string;
        partialTakeProfitAtR?: number;
        riskWinStreakStopLossEnabled?: boolean;
        disableSignalExits?: boolean;
    };

    if (config.takeProfitMode !== undefined && config.takeProfitMode !== "fixed") {
        reasons.push(`adaptive_take_profit:${config.takeProfitMode}`);
    }
    if (config.pathExitEnabled === true && (config.pathExitMode ?? "off") !== "off") {
        reasons.push(`path_exit:${config.pathExitMode}`);
    }
    if ((config.partialTakeProfitAtR ?? 0) > 0) {
        reasons.push("partial_take_profit");
    }
    if (config.riskWinStreakStopLossEnabled === true) {
        reasons.push("win_streak_stop_loss");
    }
    const sizingMode = capitalSettings.sizingMode;
    if (sizingMode !== "percent" && sizingMode !== "fixed") {
        reasons.push(`dynamic_sizing:${String(sizingMode)}`);
    }
    const tradeDirection = normalizeTradeDirection(resolved);
    if (isBothLikeTradeDirection(tradeDirection) && config.disableSignalExits !== true) {
        reasons.push("both_direction_reversals");
    }
    // Regime filters gate ENTRIES inside the engine's prepareSignals; ledger
    // candidates are post-confirmation and pre-regime, so the replay would
    // admit entries the engine could never take.
    if (
        (config.marketMode ?? "all") !== "all"
        || (config.trendEmaPeriod ?? 0) > 0
        || (config.atrPercentMin ?? 0) > 0
        || (config.atrPercentMax ?? 0) > 0
        || (config.adxMin ?? 0) > 0
        || (config.adxMax ?? 0) > 0
    ) {
        reasons.push("regime_entry_filters");
    }

    const maxOpenTradesRaw = Number((resolved as { maxOpenTrades?: unknown }).maxOpenTrades);
    const params: TradeLedgerReplayParams = {
        executionModel: resolved.executionModel ?? "next_open",
        tradeDirection,
        allowSameBarExit: resolved.allowSameBarExit === true,
        disableSignalExits: config.disableSignalExits === true,
        // Unlimited overlap resolves to Infinity in the engine — preserve it
        // instead of snapping to 1.
        maxOpenTrades: Number.isFinite(maxOpenTradesRaw) && maxOpenTradesRaw > 0 ? maxOpenTradesRaw : Number.POSITIVE_INFINITY,
        cooldownBars:
            (resolved as { riskCooldownEnabled?: boolean }).riskCooldownEnabled === true
                ? Math.max(0, Number((resolved as { riskCooldownBars?: unknown }).riskCooldownBars ?? 0))
                : 0,
        slippageRate: (resolved.slippageBps ?? 0) / 10000,
        commissionRate: (capitalSettings.commission ?? 0) / 100,
        atrPeriod: Math.max(1, Math.floor(Number(resolved.atrPeriod ?? 14) || 14)),
    };
    return { eligible: reasons.length === 0, reasons, params };
}

export interface TradeLedgerReplayParams {
    executionModel: ExecutionModel;
    tradeDirection: TradeDirection;
    allowSameBarExit: boolean;
    disableSignalExits: boolean;
    maxOpenTrades: number;
    cooldownBars: number;
    slippageRate: number;
    commissionRate: number;
    atrPeriod: number;
}

/** Prepared exit event: execution-shifted bar + pre-slippage fill price. */
export interface AsIfExitEvent {
    barIndex: number;
    price: number;
}

export interface AsIfPairModel extends TradeLedgerReplayParams {
    eligible: boolean;
    reasons: string[];
    shift: number;
    /** The run's resolved settings, as the engine's per-bar handlers read them. */
    config: NormalizedSettings;
    exitEvents: AsIfExitEvent[];
    atr: (number | null)[];
}

export interface AsIfOutcome {
    fillTime: number;
    fillPrice: number;
    exitTime: number;
    exitPrice: number;
    pnlPercent: number;
    barsHeld: number;
    exitReason: string;
}

/**
 * Build the per-pair as-if model: ATR series + the merged exit-signal series.
 * The exit series reuses the REAL exit resolution — override signals via the
 * exported executor path (when active), primary opposite-type signals when
 * signal exits are enabled — merged and execution-shifted exactly like a real
 * run (`mergeExitStrategySignals` + `prepareSignals`).
 */
export async function buildAsIfPairModel(input: {
    data: OHLCVData[];
    primarySignals: readonly Signal[];
    resolvedSettings: BacktestSettings;
    eligibility: ReturnType<typeof evaluateReplayEligibility>;
}): Promise<AsIfPairModel> {
    const { data, primarySignals, resolvedSettings, eligibility } = input;
    const config = resolvedSettings as unknown as NormalizedSettings;
    const params = eligibility.params;
    const shift = executionShift(params.executionModel);

    const highs: number[] = new Array(data.length);
    const lows: number[] = new Array(data.length);
    const closes: number[] = new Array(data.length);
    for (let i = 0; i < data.length; i += 1) {
        highs[i] = data[i]!.high;
        lows[i] = data[i]!.low;
        closes[i] = data[i]!.close;
    }
    const atr = calculateATR(highs, lows, closes, params.atrPeriod);

    const exitEvents: AsIfExitEvent[] = [];
    if (data.length > 0) {
        // ONLY the override signals come from the separate exit resolution —
        // `prepareSignals` itself maps primary opposite-type signals to exits
        // (the engine's merged set is exactly primary + tagged override), so
        // re-adding primary sells here would double-count exit events.
        const rawExitSignals: Signal[] = [];
        if ((resolvedSettings as { exitStrategyOverrideEnabled?: boolean }).exitStrategyOverrideEnabled === true) {
            // The REAL exit-override resolution path (exported from the
            // executor), not a reimplementation. Inert/disabled overrides
            // legitimately return [] — the engine then has no exit-only exits
            // either, so an empty series stays faithful.
            const override = await resolveExitStrategyOverrideSignals({
                data,
                interval: (resolvedSettings as { interval?: string }).interval ?? "",
                settings: resolvedSettings,
                blockRange: null,
            });
            rawExitSignals.push(...override.signals);
        }
        // Regime filters are replay-blocked, so prepareSignals never touches
        // the indicator series — an empty stub is safe here.
        const merged = mergeExitStrategySignals([...primarySignals], rawExitSignals);
        const prepared = prepareSignals(data, merged, config, {} as IndicatorSeries, params.tradeDirection);
        const exitType = params.tradeDirection === "short" ? "buy" : "sell";
        for (const signal of prepared) {
            if (signal.type !== exitType) continue;
            // The engine's exit gate: with disableSignalExits on, only
            // exit-only signals (Exit Strategy Override) can close positions.
            if (params.disableSignalExits && signal.exitOnly !== true) continue;
            if (!Number.isFinite(signal.price)) continue;
            exitEvents.push({ barIndex: Math.trunc(signal.barIndex as number), price: signal.price });
        }
        exitEvents.sort((a, b) => a.barIndex - b.barIndex);
    }

    return {
        ...params,
        eligible: eligibility.eligible,
        reasons: eligibility.reasons,
        shift,
        config,
        exitEvents,
        atr,
    };
}

/**
 * The as-if trade for one entry signal, or right-censoring when the signal's
 * fill bar does not exist (entry too near the data end — the engine drops
 * these entries too).
 */
export function resolveAsIfOutcome(
    model: AsIfPairModel,
    data: OHLCVData[],
    signalBarIndex: number,
    signal: Signal,
): { outcome: AsIfOutcome | null; rightCensored: boolean } {
    const fillBarIndex = signalBarIndex + model.shift;
    if (fillBarIndex < 0 || fillBarIndex >= data.length) {
        return { outcome: null, rightCensored: true };
    }
    const rawFillPrice = resolveExecutionPrice(data, signal, signalBarIndex, fillBarIndex, model.config);
    if (!Number.isFinite(rawFillPrice) || rawFillPrice <= 0) {
        return { outcome: null, rightCensored: true };
    }
    const direction = signal.type === "buy" ? "long" : "short";
    const directionFactor = directionFactorFor(direction);
    const entryFill = applySlippage(rawFillPrice, entrySideForDirection(direction), model.slippageRate);
    const atrBarIndex = model.executionModel === "next_open" ? fillBarIndex - 1 : fillBarIndex;
    // Early bars before the ATR window legitimately have no ATR; levels arm as
    // null exactly like the position builder would with a null atrValue.
    const levels = resolveInitialExitLevels({
        config: model.config,
        entryFillPrice: entryFill,
        directionFactor,
        atrValue: atrBarIndex >= 0 ? model.atr[atrBarIndex] : null,
    });

    const position: PositionState = {
        direction,
        entryTime: data[fillBarIndex]!.time,
        entryPrice: entryFill,
        size: 1,
        entryCommissionPerShare: entryFill * model.commissionRate,
        stopLossPrice: levels.stopLossPrice,
        takeProfitPrice: levels.takeProfitPrice,
        riskPerShare: levels.riskPerShare,
        barsInTrade: 0,
        extremePrice: entryFill,
        partialTargetPrice: levels.partialTargetPrice,
        partialTaken: false,
        breakEvenApplied: false,
        realizedPnl: 0,
    };

    // Binary search for the first exit event at or after the fill bar (the
    // candidate loop is O(signals × log events), never O(signals × events)).
    let lo = 0;
    let hi = model.exitEvents.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (model.exitEvents[mid]!.barIndex < fillBarIndex) lo = mid + 1;
        else hi = mid;
    }
    let eventIdx = lo;

    const exitSide = exitSideForDirection(direction);
    const closeTrade = (exitPrice: number, exitBarIndex: number, exitReason: string): AsIfOutcome => {
        const details = calculateTradeExitDetails(position, exitPrice, position.size, model.commissionRate);
        return {
            fillTime: parseTimeToUnixSeconds(data[fillBarIndex]!.time) ?? 0,
            fillPrice: entryFill,
            exitTime: parseTimeToUnixSeconds(data[exitBarIndex]!.time) ?? 0,
            exitPrice,
            pnlPercent: details.pnlPercent,
            barsHeld: exitBarIndex - fillBarIndex,
            exitReason,
        };
    };

    // Per-bar order mirrors the engine loop: open-only exits → signal exits →
    // full exits → state update. Signal exits honor the same-bar gate
    // (`allowSameBarExit || exit bar after the entry bar`).
    for (let bar = fillBarIndex; bar < data.length; bar += 1) {
        const candle = data[bar]!;
        const openedThisBar = bar === fillBarIndex;

        if (!openedThisBar && model.executionModel === "next_open") {
            const openTrigger = processPositionExits(candle, position, model.config, model.slippageRate, OPEN_ONLY_POSITION_EXIT_OPTIONS, undefined, bar);
            if (openTrigger) return { outcome: closeTrade(openTrigger.exitPrice, bar, openTrigger.exitReason), rightCensored: false };
        }

        while (eventIdx < model.exitEvents.length && model.exitEvents[eventIdx]!.barIndex === bar) {
            const event = model.exitEvents[eventIdx]!;
            eventIdx += 1;
            if (openedThisBar && !model.allowSameBarExit) continue;
            const exitPrice = applySlippage(event.price, exitSide, model.slippageRate);
            return { outcome: closeTrade(exitPrice, bar, "signal"), rightCensored: false };
        }

        if (openedThisBar) {
            if (model.executionModel === "next_open") {
                // finalizeEntryBarState: full exits only when same-bar exits
                // are allowed, otherwise stop-loss only; no state update.
                const entryBarTrigger = processPositionExits(
                    candle,
                    position,
                    model.config,
                    model.slippageRate,
                    model.allowSameBarExit ? undefined : STOP_LOSS_ONLY_POSITION_EXIT_OPTIONS,
                    undefined,
                    bar,
                );
                if (entryBarTrigger) return { outcome: closeTrade(entryBarTrigger.exitPrice, bar, entryBarTrigger.exitReason), rightCensored: false };
            }
            // signal_close / next_close: the position opens at the bar's close
            // and did not exist during the bar — no exits on the entry bar.
            continue;
        }

        position.barsInTrade += 1;
        const trigger = processPositionExits(candle, position, model.config, model.slippageRate, undefined, undefined, bar);
        if (trigger) return { outcome: closeTrade(trigger.exitPrice, bar, trigger.exitReason), rightCensored: false };
        updatePositionState(candle, position, model.config, model.atr[bar]);
    }

    // End of data: the engine records the trade at the last candle's close,
    // passed to recordExit UN-slipped.
    const lastBar = data.length - 1;
    return { outcome: closeTrade(data[lastBar]!.close, lastBar, "end_of_data"), rightCensored: false };
}

/** Entry-candidate gate for ledger rows (mirrors the engine's entry gate). */
export function isEntryCandidate(signal: Signal, tradeDirection: TradeDirection): boolean {
    return signal.exitOnly !== true && allowsSignalAsEntry(signal.type, tradeDirection);
}
