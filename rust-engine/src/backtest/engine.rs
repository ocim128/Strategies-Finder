//! Backtesting Engine Core
//!
//! Rust port of backtest.ts with optimizations for 5M+ candle bars.
use crate::indicators::{
    calculate_adx, calculate_atr, calculate_ema, calculate_rsi, calculate_sma,
};
use crate::types::{
    AdvancedSizingConfig, BacktestResult, BacktestSettings, EntryConfirmationMode, EquityPoint,
    ExecutionModel, KellyFraction, RiskMode, Signal, SignalType, Time, Trade, TradeDirection,
    TradeSizingConfig, TradeSizingMode, TradeType, OHLCV,
};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, RwLock};
/// Internal position state during backtest
#[derive(Debug, Clone)]
struct Position {
    entry_time: Time,
    entry_price: f64,
    size: f64,
    entry_commission_per_share: f64,
    stop_loss_price: Option<f64>,
    take_profit_price: Option<f64>,
    risk_per_share: f64,
    bars_in_trade: u32,
    extreme_price: f64,
    partial_target_price: Option<f64>,
    partial_taken: bool,
    break_even_applied: bool,
    realized_pnl: f64,
    trade_type: TradeType,
}
#[derive(Debug, Default)]
struct KellySizingState {
    trade_history: VecDeque<f64>,
}
impl KellySizingState {
    fn update(&mut self, pnl: f64) {
        if !pnl.is_finite() {
            return;
        }
        self.trade_history.push_back(pnl);
        if self.trade_history.len() > 100 {
            self.trade_history.pop_front();
        }
    }
    fn resolve_allocation(
        &self,
        capital: f64,
        position_size_percent: f64,
        fixed_trade_amount: f64,
        settings: &AdvancedSizingConfig,
    ) -> f64 {
        let mut wins = 0usize;
        let mut losses = 0usize;
        let mut total_win_amount = 0.0;
        let mut total_loss_amount = 0.0;
        for pnl in &self.trade_history {
            if *pnl > 0.0 {
                wins += 1;
                total_win_amount += *pnl;
            } else if *pnl < 0.0 {
                losses += 1;
                total_loss_amount += pnl.abs();
            }
        }
        let trade_count = wins + losses;
        let fallback = if fixed_trade_amount > 0.0 {
            fixed_trade_amount
        } else {
            capital * (position_size_percent / 100.0)
        };
        if trade_count == 0 || losses == 0 {
            return fallback;
        }
        let average_win = total_win_amount / wins.max(1) as f64;
        let average_loss = total_loss_amount / losses as f64;
        let raw_win_rate = wins as f64 / trade_count as f64;
        let win_rate = raw_win_rate.min(settings.kelly_win_rate_cap);
        let payoff_ratio = average_win / average_loss;
        let raw_kelly_fraction = if payoff_ratio > 0.0 {
            win_rate - ((1.0 - win_rate) / payoff_ratio)
        } else {
            0.0
        };
        let capped_kelly_fraction = raw_kelly_fraction.clamp(0.0, 0.25);
        let fraction_multiplier = match settings.kelly_fraction {
            KellyFraction::Full => 1.0,
            KellyFraction::Quarter => 0.25,
            KellyFraction::Half => 0.5,
        };
        let applied_fraction = capped_kelly_fraction * fraction_multiplier;
        let profit_factor = total_win_amount / total_loss_amount;
        let is_valid = trade_count >= 5
            && average_loss > 0.0
            && profit_factor >= settings.kelly_profit_factor_cap
            && applied_fraction > 0.0;
        if is_valid {
            capital * applied_fraction
        } else {
            fallback
        }
    }
}
#[derive(Debug, Clone, Copy)]
struct NormalizedSettings {
    atr_period: usize,
    stop_loss_atr: f64,
    take_profit_atr: f64,
    trailing_atr: f64,
    partial_take_profit_at_r: f64,
    partial_take_profit_percent: f64,
    break_even_at_r: f64,
    time_stop_bars: u32,
    risk_max_hold_bars: u32,
    risk_max_hold_enabled: bool,
    risk_mode: RiskMode,
    stop_loss_percent: f64,
    take_profit_percent: f64,
    stop_loss_enabled: bool,
    take_profit_enabled: bool,
    trend_ema_period: usize,
    trend_ema_slope_bars: usize,
    atr_percent_min: f64,
    atr_percent_max: f64,
    adx_period: usize,
    adx_min: f64,
    adx_max: f64,
    entry_confirmation: EntryConfirmationMode,
    confirm_lookback: usize,
    volume_sma_period: usize,
    volume_multiplier: f64,
    rsi_period: usize,
    rsi_bullish: f64,
    rsi_bearish: f64,
    execution_model: ExecutionModel,
    allow_same_bar_exit: bool,
    slippage_rate: f64,
    risk_cooldown_enabled: bool,
    risk_cooldown_bars: u32,
}
#[derive(Debug, Clone)]
struct IndicatorSeries {
    atr: Arc<Vec<f64>>,
    ema_trend: Arc<Vec<f64>>,
    adx: Arc<Vec<f64>>,
    volume_sma: Arc<Vec<f64>>,
    rsi: Arc<Vec<f64>>,
}
#[derive(Debug, Clone)]
struct PreparedSignal {
    time: Time,
    signal_type: SignalType,
    price: f64,
    bar_index: usize,
    order: usize,
}
fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}
fn get_series_value(series: &[f64], index: usize) -> Option<f64> {
    series.get(index).copied().filter(|value| value.is_finite())
}
fn normalize_settings(settings: &BacktestSettings) -> NormalizedSettings {
    NormalizedSettings {
        atr_period: settings.atr_period.max(1) as usize,
        stop_loss_atr: settings.stop_loss_atr.max(0.0),
        take_profit_atr: settings.take_profit_atr.max(0.0),
        trailing_atr: settings.trailing_atr.max(0.0),
        partial_take_profit_at_r: settings.partial_take_profit_at_r.max(0.0),
        partial_take_profit_percent: clamp(
            settings.partial_take_profit_percent.max(0.0),
            0.0,
            100.0,
        ),
        break_even_at_r: settings.break_even_at_r.max(0.0),
        time_stop_bars: settings.time_stop_bars,
        risk_max_hold_bars: settings.risk_max_hold_bars,
        risk_max_hold_enabled: settings.risk_max_hold_enabled,
        risk_mode: settings.risk_mode,
        stop_loss_percent: settings.stop_loss_percent.max(0.0),
        take_profit_percent: settings.take_profit_percent.max(0.0),
        stop_loss_enabled: settings.stop_loss_enabled,
        take_profit_enabled: settings.take_profit_enabled,
        trend_ema_period: settings.trend_ema_period as usize,
        trend_ema_slope_bars: settings.trend_ema_slope_bars as usize,
        atr_percent_min: settings.atr_percent_min.max(0.0),
        atr_percent_max: settings.atr_percent_max.max(0.0),
        adx_period: settings.adx_period as usize,
        adx_min: settings.adx_min.max(0.0),
        adx_max: settings.adx_max.max(0.0),
        entry_confirmation: settings.entry_confirmation,
        confirm_lookback: settings.confirm_lookback.max(1) as usize,
        volume_sma_period: settings.volume_sma_period.max(1) as usize,
        volume_multiplier: settings.volume_multiplier.max(0.0),
        rsi_period: settings.rsi_period.max(1) as usize,
        rsi_bullish: clamp(settings.rsi_bullish, 0.0, 100.0),
        rsi_bearish: clamp(settings.rsi_bearish, 0.0, 100.0),
        execution_model: settings.execution_model,
        allow_same_bar_exit: settings.allow_same_bar_exit,
        slippage_rate: settings.slippage_bps.max(0.0) / 10_000.0,
        risk_cooldown_enabled: settings.risk_cooldown_enabled,
        risk_cooldown_bars: settings.risk_cooldown_bars,
    }
}

#[inline]
fn apply_slippage(price: f64, is_buy: bool, slippage_rate: f64) -> f64 {
    if !slippage_rate.is_finite() || slippage_rate <= 0.0 {
        return price;
    }
    if is_buy {
        price * (1.0 + slippage_rate)
    } else {
        price * (1.0 - slippage_rate)
    }
}

#[inline]
fn execution_shift(config: &NormalizedSettings) -> usize {
    match config.execution_model {
        ExecutionModel::SignalClose => 0,
        ExecutionModel::NextOpen | ExecutionModel::NextClose => 1,
    }
}

#[inline]
fn resolve_execution_price(
    data: &[OHLCV],
    signal: &Signal,
    signal_index: usize,
    execution_index: usize,
    config: &NormalizedSettings,
) -> f64 {
    if config.execution_model == ExecutionModel::SignalClose && execution_index == signal_index {
        return signal.price;
    }
    match config.execution_model {
        ExecutionModel::NextOpen => data[execution_index].open,
        ExecutionModel::SignalClose | ExecutionModel::NextClose => data[execution_index].close,
    }
}
fn normalize_trade_direction(direction: TradeDirection) -> TradeDirection {
    match direction {
        TradeDirection::Short => TradeDirection::Short,
        _ => TradeDirection::Long, // TS backtest is long/short only; treat Both as long.
    }
}
fn passes_entry_confirmation(
    data: &[OHLCV],
    entry_index: usize,
    config: &NormalizedSettings,
    indicators: &IndicatorSeries,
    trade_direction: TradeDirection,
) -> bool {
    match config.entry_confirmation {
        EntryConfirmationMode::None => true,
        EntryConfirmationMode::Close => {
            if entry_index == 0 {
                return false;
            }
            let lookback = config.confirm_lookback;
            let start = entry_index.saturating_sub(lookback);
            let is_short = trade_direction == TradeDirection::Short;
            if is_short {
                let mut lowest_low = f64::INFINITY;
                for bar in data.iter().take(entry_index).skip(start) {
                    lowest_low = lowest_low.min(bar.low);
                }
                return data[entry_index].close < lowest_low;
            }
            let mut highest_high = f64::NEG_INFINITY;
            for bar in data.iter().take(entry_index).skip(start) {
                highest_high = highest_high.max(bar.high);
            }
            data[entry_index].close > highest_high
        }
        EntryConfirmationMode::Volume => {
            let volume_sma = get_series_value(&indicators.volume_sma, entry_index);
            if volume_sma.is_none() {
                return false;
            }
            data[entry_index].volume >= volume_sma.unwrap() * config.volume_multiplier
        }
        EntryConfirmationMode::Rsi => {
            let rsi = get_series_value(&indicators.rsi, entry_index);
            if rsi.is_none() {
                return false;
            }
            let rsi = rsi.unwrap();
            if trade_direction == TradeDirection::Short {
                rsi <= config.rsi_bearish
            } else {
                rsi >= config.rsi_bullish
            }
        }
    }
}
fn passes_regime_filters(
    data: &[OHLCV],
    entry_index: usize,
    config: &NormalizedSettings,
    indicators: &IndicatorSeries,
    trade_direction: TradeDirection,
) -> bool {
    let is_short = trade_direction == TradeDirection::Short;
    if config.trend_ema_period > 0 {
        let ema = get_series_value(&indicators.ema_trend, entry_index);
        if ema.is_none() {
            return false;
        }
        let ema = ema.unwrap();
        if is_short {
            if data[entry_index].close >= ema {
                return false;
            }
        } else if data[entry_index].close <= ema {
            return false;
        }
        if config.trend_ema_slope_bars > 0 {
            let slope_index = entry_index as isize - config.trend_ema_slope_bars as isize;
            if slope_index < 0 {
                return false;
            }
            let previous_ema = get_series_value(&indicators.ema_trend, slope_index as usize);
            if previous_ema.is_none() {
                return false;
            }
            let previous_ema = previous_ema.unwrap();
            if is_short {
                if ema >= previous_ema {
                    return false;
                }
            } else if ema <= previous_ema {
                return false;
            }
        }
    }
    if config.atr_percent_min > 0.0 || config.atr_percent_max > 0.0 {
        let atr = get_series_value(&indicators.atr, entry_index);
        if atr.is_none() {
            return false;
        }
        let atr_percent = (atr.unwrap() / data[entry_index].close) * 100.0;
        if config.atr_percent_min > 0.0 && atr_percent < config.atr_percent_min {
            return false;
        }
        if config.atr_percent_max > 0.0 && atr_percent > config.atr_percent_max {
            return false;
        }
    }
    if config.adx_min > 0.0 || config.adx_max > 0.0 {
        let adx = get_series_value(&indicators.adx, entry_index);
        if adx.is_none() {
            return false;
        }
        let adx = adx.unwrap();
        if config.adx_min > 0.0 && adx < config.adx_min {
            return false;
        }
        if config.adx_max > 0.0 && adx > config.adx_max {
            return false;
        }
    }
    true
}
fn resolve_signal_index(data: &[OHLCV], signal: &Signal) -> Option<usize> {
    if let Some(index) = signal.bar_index {
        if index < data.len() {
            return Some(index);
        }
    }
    data.binary_search_by_key(&signal.time, |candle| candle.time)
        .ok()
}
fn prepare_signals(
    data: &[OHLCV],
    signals: &[Signal],
    config: &NormalizedSettings,
    indicators: &IndicatorSeries,
    trade_direction: TradeDirection,
) -> Vec<PreparedSignal> {
    let is_short = trade_direction == TradeDirection::Short;
    let entry_type = if is_short {
        SignalType::Sell
    } else {
        SignalType::Buy
    };
    let exit_type = if is_short {
        SignalType::Buy
    } else {
        SignalType::Sell
    };
    let signal_execution_shift = execution_shift(config);
    let mut prepared: Vec<PreparedSignal> = Vec::with_capacity(signals.len());
    for (order, signal) in signals.iter().enumerate() {
        let Some(signal_index) = resolve_signal_index(data, signal) else {
            continue;
        };
        if signal.signal_type == exit_type {
            let execution_index = signal_index + signal_execution_shift;
            if execution_index >= data.len() {
                continue;
            }
            prepared.push(PreparedSignal {
                time: data[execution_index].time,
                signal_type: signal.signal_type,
                price: resolve_execution_price(data, signal, signal_index, execution_index, config),
                bar_index: execution_index,
                order,
            });
            continue;
        }
        if signal.signal_type != entry_type {
            continue;
        }
        let confirmation_index = if config.entry_confirmation == EntryConfirmationMode::Close {
            signal_index + 1
        } else {
            signal_index
        };
        if confirmation_index >= data.len()
            || !passes_entry_confirmation(
                data,
                confirmation_index,
                config,
                indicators,
                trade_direction,
            )
        {
            continue;
        }
        if !passes_regime_filters(
            data,
            confirmation_index,
            config,
            indicators,
            trade_direction,
        ) {
            continue;
        }
        let execution_index = confirmation_index + signal_execution_shift;
        if execution_index >= data.len() {
            continue;
        }
        let entry_price =
            resolve_execution_price(data, signal, signal_index, execution_index, config);
        prepared.push(PreparedSignal {
            time: data[execution_index].time,
            signal_type: entry_type,
            price: entry_price,
            bar_index: execution_index,
            order,
        });
    }
    prepared.sort_by(|a, b| {
        a.bar_index
            .cmp(&b.bar_index)
            .then_with(|| a.order.cmp(&b.order))
    });
    prepared
}
#[inline]
fn resolve_stop_loss_exit_price(candle: &OHLCV, stop_loss: f64, is_short: bool) -> f64 {
    if (is_short && candle.open >= stop_loss) || (!is_short && candle.open <= stop_loss) {
        candle.open
    } else {
        stop_loss
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PositionExitMode {
    OpenOnly,
    StopLossOnly,
    Full,
}

#[inline]
fn is_entry_cooldown_enabled(config: &NormalizedSettings) -> bool {
    config.risk_cooldown_enabled && config.risk_cooldown_bars > 0
}

#[inline]
fn is_entry_cooldown_active(cooldown_until_bar_index: Option<usize>, bar_index: usize) -> bool {
    cooldown_until_bar_index.is_some_and(|until| until >= bar_index)
}

#[inline]
fn arm_entry_cooldown_if_closed(
    was_open: bool,
    position: &Option<Position>,
    cooldown_until_bar_index: &mut Option<usize>,
    bar_index: usize,
    config: &NormalizedSettings,
) {
    if was_open && position.is_none() && is_entry_cooldown_enabled(config) {
        *cooldown_until_bar_index =
            Some(bar_index + config.risk_cooldown_bars.saturating_sub(1) as usize);
    }
}

#[allow(clippy::too_many_arguments)]
fn process_position_exits(
    position: &mut Option<Position>,
    trades: &mut Vec<Trade>,
    capital: &mut f64,
    trade_id: &mut u32,
    candle: &OHLCV,
    atr_value: Option<f64>,
    config: &NormalizedSettings,
    is_short: bool,
    direction_factor: f64,
    mode: PositionExitMode,
    commission_rate: f64,
    kelly_state: &mut Option<KellySizingState>,
) {
    if let Some(stop_loss) = position.as_ref().and_then(|pos| pos.stop_loss_price) {
        let stop_hit = match mode {
            PositionExitMode::OpenOnly => {
                if is_short {
                    candle.open >= stop_loss
                } else {
                    candle.open <= stop_loss
                }
            }
            PositionExitMode::StopLossOnly | PositionExitMode::Full => {
                if is_short {
                    candle.high >= stop_loss
                } else {
                    candle.low <= stop_loss
                }
            }
        };
        if stop_hit {
            let size = position.as_ref().map(|pos| pos.size).unwrap_or(0.0);
            exit_position(
                position,
                trades,
                capital,
                trade_id,
                resolve_stop_loss_exit_price(candle, stop_loss, is_short),
                candle.time,
                size,
                commission_rate,
                config.slippage_rate,
                "stop_loss",
                kelly_state,
            );
        }
    }

    if mode == PositionExitMode::StopLossOnly || position.is_none() {
        return;
    }

    if let Some(take_profit) = position.as_ref().and_then(|pos| pos.take_profit_price) {
        let take_hit = match mode {
            PositionExitMode::OpenOnly => {
                if is_short {
                    candle.open <= take_profit
                } else {
                    candle.open >= take_profit
                }
            }
            PositionExitMode::Full => {
                if is_short {
                    candle.low <= take_profit
                } else {
                    candle.high >= take_profit
                }
            }
            PositionExitMode::StopLossOnly => false,
        };
        if take_hit {
            let size = position.as_ref().map(|pos| pos.size).unwrap_or(0.0);
            exit_position(
                position,
                trades,
                capital,
                trade_id,
                take_profit,
                candle.time,
                size,
                commission_rate,
                config.slippage_rate,
                "take_profit",
                kelly_state,
            );
        }
    }

    if mode == PositionExitMode::OpenOnly || position.is_none() {
        return;
    }

    let mut partial_exit_taken = false;
    if position.as_ref().is_some_and(|pos| !pos.partial_taken) {
        if let Some(partial_target) = position.as_ref().and_then(|pos| pos.partial_target_price) {
            let partial_hit = if is_short {
                candle.low <= partial_target
            } else {
                candle.high >= partial_target
            };
            if partial_hit {
                let partial_size = position
                    .as_ref()
                    .map(|pos| pos.size * (config.partial_take_profit_percent / 100.0))
                    .unwrap_or(0.0);
                if partial_size > 0.0 {
                    exit_position(
                        position,
                        trades,
                        capital,
                        trade_id,
                        partial_target,
                        candle.time,
                        partial_size,
                        commission_rate,
                        config.slippage_rate,
                        "partial",
                        kelly_state,
                    );
                    if let Some(pos) = position.as_mut() {
                        pos.partial_taken = true;
                    }
                    partial_exit_taken = true;
                }
            }
        }
    }

    // TypeScript returns the first partial trigger for the bar. Do not let
    // max-hold or the legacy time stop immediately close the remainder, but
    // continue through position-state updates below.
    if !partial_exit_taken {
        if let Some(pos) = position.as_ref() {
            if config.risk_max_hold_enabled
                && config.risk_max_hold_bars > 0
                && pos.bars_in_trade >= config.risk_max_hold_bars
            {
                let size = pos.size;
                exit_position(
                    position,
                    trades,
                    capital,
                    trade_id,
                    candle.close,
                    candle.time,
                    size,
                    commission_rate,
                    config.slippage_rate,
                    "time_stop",
                    kelly_state,
                );
            }
        }

        if let Some(pos) = position.as_ref() {
            if config.time_stop_bars > 0 && pos.bars_in_trade >= config.time_stop_bars {
                let is_losing = if is_short {
                    candle.close >= pos.entry_price
                } else {
                    candle.close <= pos.entry_price
                };
                if !pos.partial_taken && is_losing {
                    let size = pos.size;
                    exit_position(
                        position,
                        trades,
                        capital,
                        trade_id,
                        candle.close,
                        candle.time,
                        size,
                        commission_rate,
                        config.slippage_rate,
                        "time_stop",
                        kelly_state,
                    );
                }
            }
        }
    }

    if let Some(atr_value) = atr_value {
        if let Some(pos) = position.as_mut() {
            if config.break_even_at_r > 0.0 && pos.risk_per_share > 0.0 && !pos.break_even_applied {
                let break_even_target = pos.entry_price
                    + direction_factor * pos.risk_per_share * config.break_even_at_r;
                let break_even_hit = if is_short {
                    candle.low <= break_even_target
                } else {
                    candle.high >= break_even_target
                };
                if break_even_hit {
                    pos.stop_loss_price = Some(match pos.stop_loss_price {
                        None => pos.entry_price,
                        Some(existing) => {
                            if is_short {
                                existing.min(pos.entry_price)
                            } else {
                                existing.max(pos.entry_price)
                            }
                        }
                    });
                    pos.break_even_applied = true;
                }
            }
            if config.trailing_atr > 0.0 {
                let trail_stop =
                    pos.extreme_price - direction_factor * atr_value * config.trailing_atr;
                let should_update = match pos.stop_loss_price {
                    None => true,
                    Some(existing) => {
                        if is_short {
                            trail_stop < existing
                        } else {
                            trail_stop > existing
                        }
                    }
                };
                if should_update {
                    pos.stop_loss_price = Some(trail_stop);
                }
            }
        }
    }
    if let Some(pos) = position.as_mut() {
        pos.extreme_price = if is_short {
            pos.extreme_price.min(candle.low)
        } else {
            pos.extreme_price.max(candle.high)
        };
    }
}

#[allow(clippy::too_many_arguments)]
fn exit_position(
    position: &mut Option<Position>,
    trades: &mut Vec<Trade>,
    capital: &mut f64,
    trade_id: &mut u32,
    exit_price: f64,
    exit_time: Time,
    exit_size: f64,
    commission_rate: f64,
    slippage_rate: f64,
    exit_reason: &str,
    kelly_state: &mut Option<KellySizingState>,
) {
    let Some(mut pos) = position.take() else {
        return;
    };
    if exit_size <= 0.0 {
        *position = Some(pos);
        return;
    }
    let size = exit_size.min(pos.size);
    let filled_exit_price = apply_slippage(
        exit_price,
        matches!(pos.trade_type, TradeType::Short),
        slippage_rate,
    );
    let exit_value = size * filled_exit_price;
    let entry_value = size * pos.entry_price;
    let commission = exit_value * commission_rate;
    let entry_commission = pos.entry_commission_per_share * size;
    let direction_factor = match pos.trade_type {
        TradeType::Short => -1.0,
        TradeType::Long => 1.0,
    };
    let raw_pnl = (exit_value - entry_value) * direction_factor;
    let total_pnl = raw_pnl - entry_commission - commission;
    let pnl_percent = if entry_value > 0.0 {
        (total_pnl / entry_value) * 100.0
    } else {
        0.0
    };
    *capital += raw_pnl - commission;
    *trade_id += 1;
    trades.push(Trade {
        id: *trade_id,
        trade_type: pos.trade_type,
        entry_time: pos.entry_time,
        entry_price: pos.entry_price,
        exit_time,
        exit_price: filled_exit_price,
        pnl: total_pnl,
        pnl_percent,
        size,
        exit_reason: exit_reason.to_string(),
        fees: Some(entry_commission + commission),
    });
    pos.realized_pnl += total_pnl;
    pos.size -= size;
    if pos.size > 0.0 {
        *position = Some(pos);
    } else if let Some(state) = kelly_state.as_mut() {
        state.update(pos.realized_pnl);
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum IndicatorKind {
    Atr,
    Ema,
    Adx,
    VolumeSma,
    Rsi,
}
type IndicatorCache = RwLock<HashMap<(IndicatorKind, usize), Arc<Vec<f64>>>>;

pub(crate) struct MarketSeries {
    highs: Vec<f64>,
    lows: Vec<f64>,
    closes: Vec<f64>,
    volumes: Vec<f64>,
    indicator_cache: IndicatorCache,
}
impl MarketSeries {
    fn get_or_compute<F>(&self, kind: IndicatorKind, period: usize, compute: F) -> Arc<Vec<f64>>
    where
        F: FnOnce() -> Vec<f64>,
    {
        if let Some(cached) = self
            .indicator_cache
            .read()
            .expect("market indicator cache lock poisoned")
            .get(&(kind, period))
        {
            return cached.clone();
        }

        let mut cache = self
            .indicator_cache
            .write()
            .expect("market indicator cache lock poisoned");
        if let Some(cached) = cache.get(&(kind, period)) {
            return cached.clone();
        }
        let computed = Arc::new(compute());
        cache.insert((kind, period), computed.clone());
        computed
    }

    fn get_or_compute_atr(&self, period: usize) -> Arc<Vec<f64>> {
        self.get_or_compute(IndicatorKind::Atr, period, || {
            calculate_atr(&self.highs, &self.lows, &self.closes, period)
        })
    }

    fn get_or_compute_ema(&self, period: usize) -> Arc<Vec<f64>> {
        self.get_or_compute(IndicatorKind::Ema, period, || {
            calculate_ema(&self.closes, period)
        })
    }

    fn get_or_compute_adx(&self, period: usize) -> Arc<Vec<f64>> {
        self.get_or_compute(IndicatorKind::Adx, period, || {
            calculate_adx(&self.highs, &self.lows, &self.closes, period)
        })
    }

    fn get_or_compute_volume_sma(&self, period: usize) -> Arc<Vec<f64>> {
        self.get_or_compute(IndicatorKind::VolumeSma, period, || {
            calculate_sma(&self.volumes, period)
        })
    }

    fn get_or_compute_rsi(&self, period: usize) -> Arc<Vec<f64>> {
        self.get_or_compute(IndicatorKind::Rsi, period, || {
            calculate_rsi(&self.closes, period)
        })
    }
}
pub(crate) fn build_market_series(data: &[OHLCV]) -> MarketSeries {
    MarketSeries {
        highs: data.iter().map(|d| d.high).collect(),
        lows: data.iter().map(|d| d.low).collect(),
        closes: data.iter().map(|d| d.close).collect(),
        volumes: data.iter().map(|d| d.volume).collect(),
        indicator_cache: RwLock::new(HashMap::new()),
    }
}
/// Run a full backtest
///
/// # Arguments
/// * `data` - OHLCV candle data
/// * `signals` - Trading signals from strategy
/// * `initial_capital` - Starting capital
/// * `position_size_percent` - Position size as percentage of capital
/// * `commission_percent` - Commission per trade (percentage)
/// * `settings` - Backtest settings (stops, filters, etc.)
/// * `sizing` - Optional trade sizing config (fixed amount vs percentage)
///
/// # Returns
/// Complete backtest results with all statistics
#[must_use]
#[allow(clippy::too_many_arguments)]
pub fn run_backtest(
    data: &[OHLCV],
    signals: &[Signal],
    initial_capital: f64,
    position_size_percent: f64,
    commission_percent: f64,
    settings: &BacktestSettings,
    sizing: Option<&TradeSizingConfig>,
    compact: bool,
) -> BacktestResult {
    let market_series = build_market_series(data);
    run_backtest_with_market_series_options(
        data,
        signals,
        initial_capital,
        position_size_percent,
        commission_percent,
        settings,
        sizing,
        compact,
        false,
        false,
        false,
        &market_series,
    )
}
#[must_use]
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_backtest_with_market_series_options(
    data: &[OHLCV],
    signals: &[Signal],
    initial_capital: f64,
    position_size_percent: f64,
    commission_percent: f64,
    settings: &BacktestSettings,
    sizing: Option<&TradeSizingConfig>,
    compact: bool,
    retain_trades: bool,
    skip_drawdown: bool,
    skip_sharpe_ratio: bool,
    market_series: &MarketSeries,
) -> BacktestResult {
    if data.is_empty() {
        return BacktestResult::default();
    }
    let config = normalize_settings(settings);
    let trade_direction = normalize_trade_direction(settings.trade_direction);
    let is_short = trade_direction == TradeDirection::Short;
    let direction_factor = if is_short { -1.0 } else { 1.0 };
    let sizing_mode = sizing.map_or(TradeSizingMode::Percent, |s| s.mode);
    let fixed_trade_amount = sizing.map_or(0.0, |s| s.fixed_trade_amount.max(0.0));
    let kelly_settings =
        sizing.map_or_else(AdvancedSizingConfig::default, |s| s.advanced_sizing.clone());
    let needs_atr = config.stop_loss_atr > 0.0
        || config.take_profit_atr > 0.0
        || config.trailing_atr > 0.0
        || config.atr_percent_min > 0.0
        || config.atr_percent_max > 0.0
        || config.partial_take_profit_at_r > 0.0
        || config.break_even_at_r > 0.0;
    let atr = if needs_atr {
        market_series.get_or_compute_atr(config.atr_period)
    } else {
        Arc::new(Vec::new())
    };
    let ema_trend = if config.trend_ema_period > 0 {
        market_series.get_or_compute_ema(config.trend_ema_period)
    } else {
        Arc::new(Vec::new())
    };
    let use_adx = config.adx_min > 0.0 || config.adx_max > 0.0;
    let adx = if use_adx {
        let adx_period = config.adx_period.max(1);
        market_series.get_or_compute_adx(adx_period)
    } else {
        Arc::new(Vec::new())
    };
    let volume_sma = if config.entry_confirmation == EntryConfirmationMode::Volume {
        market_series.get_or_compute_volume_sma(config.volume_sma_period)
    } else {
        Arc::new(Vec::new())
    };
    let rsi = if config.entry_confirmation == EntryConfirmationMode::Rsi {
        market_series.get_or_compute_rsi(config.rsi_period)
    } else {
        Arc::new(Vec::new())
    };
    let indicators = IndicatorSeries {
        atr,
        ema_trend,
        adx,
        volume_sma,
        rsi,
    };
    let prepared_signals = prepare_signals(data, signals, &config, &indicators, trade_direction);
    let commission_rate = commission_percent / 100.0;
    let entry_signal_type = if is_short {
        SignalType::Sell
    } else {
        SignalType::Buy
    };
    let exit_signal_type = if is_short {
        SignalType::Buy
    } else {
        SignalType::Sell
    };
    let mut capital = initial_capital;
    let mut position: Option<Position> = None;
    let mut kelly_state =
        (sizing_mode == TradeSizingMode::KellyCriterion).then(KellySizingState::default);
    let mut trades: Vec<Trade> = Vec::with_capacity(prepared_signals.len() / 2);
    let mut equity_curve: Vec<EquityPoint> = if compact {
        Vec::new()
    } else {
        Vec::with_capacity(data.len())
    };
    let mut trade_id: u32 = 0;
    let mut signal_idx: usize = 0;
    let mut signal_exit_reentry_cooldown_until_bar_index: Option<usize> = None;
    let mut peak_equity = initial_capital;
    let mut max_drawdown = 0.0;
    let mut max_drawdown_percent = 0.0;
    let mut update_drawdown = |equity: f64| {
        if equity > peak_equity {
            peak_equity = equity;
        } else {
            let drawdown = peak_equity - equity;
            if drawdown > max_drawdown {
                max_drawdown = drawdown;
                max_drawdown_percent = if peak_equity > 0.0 {
                    drawdown / peak_equity * 100.0
                } else {
                    0.0
                };
            }
        }
    };
    let mut i = 0;
    while i < data.len() {
        // Finder compact runs do not retain an equity curve. When the single
        // position is flat, candles before the next indexed signal cannot
        // change capital or any other state, so jump over that idle span.
        // This is the Rust equivalent of the TypeScript Finder fast path.
        if compact && position.is_none() {
            match prepared_signals
                .get(signal_idx)
                .map(|signal| signal.bar_index)
            {
                Some(next_signal_index) if next_signal_index > i => {
                    i = next_signal_index;
                    continue;
                }
                None => break,
                _ => {}
            }
        }
        let candle = &data[i];
        let next_open = config.execution_model == ExecutionModel::NextOpen;
        let position_was_open_at_bar_start = position.is_some();
        let mut opened_this_bar = false;
        if next_open && position.is_some() {
            process_position_exits(
                &mut position,
                &mut trades,
                &mut capital,
                &mut trade_id,
                candle,
                get_series_value(&indicators.atr, i),
                &config,
                is_short,
                direction_factor,
                PositionExitMode::OpenOnly,
                commission_rate,
                &mut kelly_state,
            );
            arm_entry_cooldown_if_closed(
                position_was_open_at_bar_start,
                &position,
                &mut signal_exit_reentry_cooldown_until_bar_index,
                i,
                &config,
            );
        }
        if position.is_some() && !next_open {
            if let Some(pos) = position.as_mut() {
                pos.bars_in_trade += 1;
            }
            process_position_exits(
                &mut position,
                &mut trades,
                &mut capital,
                &mut trade_id,
                candle,
                get_series_value(&indicators.atr, i),
                &config,
                is_short,
                direction_factor,
                PositionExitMode::Full,
                commission_rate,
                &mut kelly_state,
            );
        }
        if !next_open {
            arm_entry_cooldown_if_closed(
                position_was_open_at_bar_start,
                &position,
                &mut signal_exit_reentry_cooldown_until_bar_index,
                i,
                &config,
            );
        }
        let position_was_open_before_signals = position.is_some();
        while signal_idx < prepared_signals.len()
            && prepared_signals[signal_idx].time <= candle.time
        {
            let signal = &prepared_signals[signal_idx];
            if signal.time == candle.time {
                if signal.signal_type == entry_signal_type
                    && position.is_none()
                    && !is_entry_cooldown_active(signal_exit_reentry_cooldown_until_bar_index, i)
                {
                    let atr_index = if next_open { i.checked_sub(1) } else { Some(i) };
                    let atr_value =
                        atr_index.and_then(|index| get_series_value(&indicators.atr, index));
                    let requires_atr_for_entry = config.stop_loss_atr > 0.0
                        || config.take_profit_atr > 0.0
                        || config.trailing_atr > 0.0
                        || config.partial_take_profit_at_r > 0.0
                        || config.break_even_at_r > 0.0;
                    if requires_atr_for_entry && atr_value.is_none() {
                        signal_idx += 1;
                        continue;
                    }
                    let allocated_capital =
                        if sizing_mode == TradeSizingMode::Fixed && fixed_trade_amount > 0.0 {
                            fixed_trade_amount
                        } else if sizing_mode == TradeSizingMode::KellyCriterion {
                            kelly_state.as_ref().map_or_else(
                                || {
                                    if fixed_trade_amount > 0.0 {
                                        fixed_trade_amount
                                    } else {
                                        capital * (position_size_percent / 100.0)
                                    }
                                },
                                |state| {
                                    state.resolve_allocation(
                                        capital,
                                        position_size_percent,
                                        fixed_trade_amount,
                                        &kelly_settings,
                                    )
                                },
                            )
                        } else {
                            capital * (position_size_percent / 100.0)
                        };
                    let trade_value = allocated_capital / (1.0 + commission_rate);
                    let entry_commission = trade_value * commission_rate;
                    let entry_price = apply_slippage(signal.price, !is_short, config.slippage_rate);
                    if !entry_price.is_finite() || entry_price <= 0.0 {
                        signal_idx += 1;
                        continue;
                    }
                    let shares = trade_value / entry_price;
                    let stop_loss_price = match atr_value {
                        Some(atr_val) if config.stop_loss_atr > 0.0 => {
                            Some(entry_price - direction_factor * config.stop_loss_atr * atr_val)
                        }
                        Some(atr_val) if config.trailing_atr > 0.0 => {
                            Some(entry_price - direction_factor * config.trailing_atr * atr_val)
                        }
                        _ => None,
                    };
                    let take_profit_price = match atr_value {
                        Some(atr_val) if config.take_profit_atr > 0.0 => {
                            Some(entry_price + direction_factor * config.take_profit_atr * atr_val)
                        }
                        _ => None,
                    };
                    let mut risk_per_share = 0.0;
                    if config.risk_mode == RiskMode::Percentage {
                        if config.stop_loss_enabled && config.stop_loss_percent > 0.0 {
                            risk_per_share = entry_price * (config.stop_loss_percent / 100.0);
                        }
                    } else if let Some(atr_val) = atr_value {
                        if config.stop_loss_atr > 0.0 {
                            risk_per_share = config.stop_loss_atr * atr_val;
                        }
                    }
                    let partial_target_price =
                        if risk_per_share > 0.0 && config.partial_take_profit_at_r > 0.0 {
                            Some(
                                entry_price
                                    + direction_factor
                                        * risk_per_share
                                        * config.partial_take_profit_at_r,
                            )
                        } else {
                            None
                        };
                    let mut final_stop_loss_price = stop_loss_price;
                    let mut final_take_profit_price = take_profit_price;
                    if config.risk_mode == RiskMode::Percentage {
                        if config.stop_loss_enabled && config.stop_loss_percent > 0.0 {
                            final_stop_loss_price = Some(
                                entry_price
                                    * (1.0 - direction_factor * (config.stop_loss_percent / 100.0)),
                            );
                        }
                        if config.take_profit_enabled && config.take_profit_percent > 0.0 {
                            final_take_profit_price = Some(
                                entry_price
                                    * (1.0
                                        + direction_factor * (config.take_profit_percent / 100.0)),
                            );
                        }
                    }
                    position = Some(Position {
                        entry_time: signal.time,
                        entry_price,
                        size: shares,
                        entry_commission_per_share: if shares > 0.0 {
                            entry_commission / shares
                        } else {
                            0.0
                        },
                        stop_loss_price: final_stop_loss_price,
                        take_profit_price: final_take_profit_price,
                        risk_per_share,
                        bars_in_trade: 0,
                        extreme_price: entry_price,
                        partial_target_price,
                        partial_taken: false,
                        break_even_applied: false,
                        realized_pnl: 0.0,
                        trade_type: if is_short {
                            TradeType::Short
                        } else {
                            TradeType::Long
                        },
                    });
                    capital -= entry_commission;
                    opened_this_bar = true;
                } else if signal.signal_type == exit_signal_type
                    && position.is_some()
                    && (config.allow_same_bar_exit
                        || position
                            .as_ref()
                            .map(|pos| pos.entry_time != signal.time)
                            .unwrap_or(true))
                {
                    let size = position.as_ref().map(|pos| pos.size).unwrap_or(0.0);
                    exit_position(
                        &mut position,
                        &mut trades,
                        &mut capital,
                        &mut trade_id,
                        signal.price,
                        signal.time,
                        size,
                        commission_rate,
                        config.slippage_rate,
                        "signal",
                        &mut kelly_state,
                    );
                    arm_entry_cooldown_if_closed(
                        true,
                        &position,
                        &mut signal_exit_reentry_cooldown_until_bar_index,
                        i,
                        &config,
                    );
                }
            }
            signal_idx += 1;
        }
        if next_open && position.is_some() {
            if !opened_this_bar {
                if let Some(pos) = position.as_mut() {
                    pos.bars_in_trade += 1;
                }
            }
            process_position_exits(
                &mut position,
                &mut trades,
                &mut capital,
                &mut trade_id,
                candle,
                get_series_value(&indicators.atr, i),
                &config,
                is_short,
                direction_factor,
                if opened_this_bar && !config.allow_same_bar_exit {
                    PositionExitMode::StopLossOnly
                } else {
                    PositionExitMode::Full
                },
                commission_rate,
                &mut kelly_state,
            );
            arm_entry_cooldown_if_closed(
                opened_this_bar || position_was_open_before_signals,
                &position,
                &mut signal_exit_reentry_cooldown_until_bar_index,
                i,
                &config,
            );
        }
        let mut current_equity = capital;
        if let Some(pos) = position.as_ref() {
            let unrealized_pnl = (candle.close - pos.entry_price) * pos.size * direction_factor;
            current_equity += unrealized_pnl;
        }
        if compact {
            update_drawdown(current_equity);
        } else {
            equity_curve.push(EquityPoint {
                time: candle.time,
                value: current_equity,
            });
        }
        i += 1;
    }
    let final_position_open = position.is_some();
    if let Some(pos) = position.as_ref() {
        let last_candle = data.last().unwrap();
        let size = pos.size;
        exit_position(
            &mut position,
            &mut trades,
            &mut capital,
            &mut trade_id,
            last_candle.close,
            last_candle.time,
            size,
            commission_rate,
            0.0,
            "end_of_data",
            &mut kelly_state,
        );
        if compact {
            update_drawdown(capital);
        } else if let Some(last_point) = equity_curve.last_mut() {
            last_point.value = capital;
        }
    }
    let (max_dd, max_dd_pct) = if skip_drawdown {
        (0.0, 0.0)
    } else if compact {
        (max_drawdown, max_drawdown_percent)
    } else {
        calculate_max_drawdown(&equity_curve, initial_capital)
    };
    let mut result = calculate_backtest_stats(
        trades,
        equity_curve,
        initial_capital,
        capital,
        max_dd,
        max_dd_pct,
    );
    if skip_sharpe_ratio {
        result.sharpe_ratio = 0.0;
    }
    result.final_position_open = final_position_open;
    if compact {
        if !retain_trades {
            result.trades.clear();
        }
        result.equity_curve.clear();
    }
    result
}
/// Calculate maximum drawdown from equity curve
#[must_use]
pub fn calculate_max_drawdown(equity_curve: &[EquityPoint], initial_capital: f64) -> (f64, f64) {
    if equity_curve.is_empty() {
        return (0.0, 0.0);
    }
    let mut peak = initial_capital;
    let mut max_drawdown = 0.0;
    let mut max_drawdown_percent = 0.0;
    for point in equity_curve {
        if point.value > peak {
            peak = point.value;
        }
        let drawdown = peak - point.value;
        let drawdown_pct = if peak > 0.0 {
            drawdown / peak * 100.0
        } else {
            0.0
        };
        if drawdown > max_drawdown {
            max_drawdown = drawdown;
            max_drawdown_percent = drawdown_pct;
        }
    }
    (max_drawdown, max_drawdown_percent)
}
/// Calculate all backtest statistics from trades
#[must_use]
pub fn calculate_backtest_stats(
    trades: Vec<Trade>,
    equity_curve: Vec<EquityPoint>,
    initial_capital: f64,
    final_capital: f64,
    max_drawdown: f64,
    max_drawdown_percent: f64,
) -> BacktestResult {
    let total_trades = trades.len() as u32;
    if total_trades == 0 {
        return BacktestResult {
            trades,
            equity_curve,
            ..Default::default()
        };
    }
    let net_profit = final_capital - initial_capital;
    let net_profit_percent = (net_profit / initial_capital) * 100.0;
    let mut win_count = 0_u32;
    let mut loss_count = 0_u32;
    let mut total_wins = 0.0;
    let mut total_losses = 0.0;
    for trade in &trades {
        if trade.pnl > 0.0 {
            win_count += 1;
            total_wins += trade.pnl;
        } else {
            loss_count += 1;
            total_losses += trade.pnl.abs();
        }
    }
    let win_rate_fraction = if total_trades > 0 {
        win_count as f64 / total_trades as f64
    } else {
        0.0
    };
    let avg_win = if win_count > 0 {
        total_wins / win_count as f64
    } else {
        0.0
    };
    let avg_loss = if loss_count > 0 {
        total_losses / loss_count as f64
    } else {
        0.0
    };
    let avg_trade = net_profit / total_trades as f64;
    let profit_factor = if total_losses > 0.0 {
        total_wins / total_losses
    } else if total_wins > 0.0 {
        f64::INFINITY
    } else {
        0.0
    };
    let expectancy = (win_rate_fraction * avg_win) - ((1.0 - win_rate_fraction) * avg_loss);
    let sharpe_ratio = calculate_sharpe_ratio(&trades);
    BacktestResult {
        trades,
        net_profit,
        net_profit_percent,
        win_rate: win_rate_fraction * 100.0,
        expectancy,
        avg_trade,
        profit_factor,
        max_drawdown,
        max_drawdown_percent,
        total_trades,
        winning_trades: win_count,
        losing_trades: loss_count,
        avg_win,
        avg_loss,
        sharpe_ratio,
        equity_curve,
        final_position_open: false,
    }
}
/// Calculate Sharpe Ratio from trades
fn calculate_sharpe_ratio(trades: &[Trade]) -> f64 {
    if trades.len() < 2 {
        return 0.0;
    }
    let n = trades.len() as f64;
    let mean = trades.iter().map(|trade| trade.pnl_percent).sum::<f64>() / n;
    let variance = trades
        .iter()
        .map(|trade| (trade.pnl_percent - mean).powi(2))
        .sum::<f64>()
        / (n - 1.0);
    let std_dev = variance.sqrt();
    if std_dev == 0.0 {
        return 0.0;
    }
    mean / std_dev
}
#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;
    use serde::Deserialize;
    fn create_test_data(n: usize) -> Vec<OHLCV> {
        (0..n)
            .map(|i| {
                let base = 100.0 + (i as f64 * 0.1);
                OHLCV::new(
                    i as i64 * 60000, // 1 minute bars
                    base,
                    base + 0.5,
                    base - 0.3,
                    base + 0.2,
                    1000.0,
                )
            })
            .collect()
    }

    #[derive(Debug, Deserialize)]
    struct ParityFixture {
        cases: Vec<ParityCase>,
    }

    #[derive(Debug, Deserialize)]
    struct ParityCase {
        name: String,
        data: Vec<OHLCV>,
        signals: Vec<Signal>,
        settings: BacktestSettings,
        capital: ParityCapital,
        #[serde(rename = "rustDirectParity", default = "default_true")]
        rust_direct_parity: bool,
        expected: ParityExpected,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ParityCapital {
        initial_capital: f64,
        position_size_percent: f64,
        commission_percent: f64,
        sizing: TradeSizingConfig,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ParityExpected {
        trades: Vec<ParityTrade>,
        net_profit: f64,
        net_profit_percent: f64,
        total_trades: u32,
        winning_trades: u32,
        losing_trades: u32,
        max_drawdown: f64,
        max_drawdown_percent: f64,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ParityTrade {
        id: u32,
        #[serde(rename = "type")]
        trade_type: TradeType,
        entry_time: Time,
        entry_price: f64,
        exit_time: Time,
        exit_price: f64,
        pnl: f64,
        pnl_percent: f64,
        size: f64,
        fees: f64,
        exit_reason: String,
    }

    const fn default_true() -> bool {
        true
    }

    fn assert_close(actual: f64, expected: f64, label: &str) {
        let tolerance = 1e-9 * actual.abs().max(expected.abs()).max(1.0);
        assert!(
            (actual - expected).abs() <= tolerance,
            "{label}: actual {actual} expected {expected} tolerance {tolerance}"
        );
    }

    #[test]
    fn shared_typescript_golden_fixture_covers_next_open_execution_contract() {
        let fixture: ParityFixture = serde_json::from_str(include_str!(
            "../../../tests/fixtures/rust-next-open-parity.json"
        ))
        .expect("shared Rust/TypeScript parity fixture must deserialize");

        for case in fixture.cases {
            if !case.rust_direct_parity {
                // TypeScript currently normalizes partial-take-profit fields
                // out of the public engine settings. The Rust kernel still
                // carries the ordering regression test below, but this case
                // is intentionally not admitted as a cross-engine workload.
                continue;
            }
            let result = run_backtest(
                &case.data,
                &case.signals,
                case.capital.initial_capital,
                case.capital.position_size_percent,
                case.capital.commission_percent,
                &case.settings,
                Some(&case.capital.sizing),
                false,
            );
            assert_eq!(
                result.trades.len(),
                case.expected.trades.len(),
                "{} trade count",
                case.name
            );
            for (index, (actual, expected)) in result
                .trades
                .iter()
                .zip(case.expected.trades.iter())
                .enumerate()
            {
                assert_eq!(actual.id, expected.id, "{} trade {index} id", case.name);
                assert_eq!(
                    actual.trade_type, expected.trade_type,
                    "{} trade {index} type",
                    case.name
                );
                assert_eq!(
                    actual.entry_time, expected.entry_time,
                    "{} trade {index} entry time",
                    case.name
                );
                assert_close(
                    actual.entry_price,
                    expected.entry_price,
                    &format!("{} trade {index} entry price", case.name),
                );
                assert_eq!(
                    actual.exit_time, expected.exit_time,
                    "{} trade {index} exit time",
                    case.name
                );
                assert_close(
                    actual.exit_price,
                    expected.exit_price,
                    &format!("{} trade {index} exit price", case.name),
                );
                assert_close(
                    actual.pnl,
                    expected.pnl,
                    &format!("{} trade {index} pnl", case.name),
                );
                assert_close(
                    actual.pnl_percent,
                    expected.pnl_percent,
                    &format!("{} trade {index} pnl percent", case.name),
                );
                assert_close(
                    actual.size,
                    expected.size,
                    &format!("{} trade {index} size", case.name),
                );
                assert_close(
                    actual.fees.unwrap_or(0.0),
                    expected.fees,
                    &format!("{} trade {index} fees", case.name),
                );
                assert_eq!(
                    actual.exit_reason, expected.exit_reason,
                    "{} trade {index} exit reason",
                    case.name
                );
            }
            assert_close(
                result.net_profit,
                case.expected.net_profit,
                &format!("{} net profit", case.name),
            );
            assert_close(
                result.net_profit_percent,
                case.expected.net_profit_percent,
                &format!("{} net profit percent", case.name),
            );
            assert_eq!(
                result.total_trades, case.expected.total_trades,
                "{} total trades",
                case.name
            );
            assert_eq!(
                result.winning_trades, case.expected.winning_trades,
                "{} winning trades",
                case.name
            );
            assert_eq!(
                result.losing_trades, case.expected.losing_trades,
                "{} losing trades",
                case.name
            );
            assert_close(
                result.max_drawdown,
                case.expected.max_drawdown,
                &format!("{} max drawdown", case.name),
            );
            assert_close(
                result.max_drawdown_percent,
                case.expected.max_drawdown_percent,
                &format!("{} max drawdown percent", case.name),
            );
        }
    }
    #[test]
    fn test_backtest_no_trades() {
        let data = create_test_data(100);
        let signals: Vec<Signal> = vec![];
        let settings = BacktestSettings::default();
        let result = run_backtest(&data, &signals, 10000.0, 2.0, 0.1, &settings, None, false);
        assert_eq!(result.total_trades, 0);
        assert_eq!(result.net_profit, 0.0);
    }
    #[test]
    fn market_series_reuses_indicator_results_across_backtests() {
        let data = create_test_data(100);
        let market_series = build_market_series(&data);

        let first = market_series.get_or_compute_atr(14);
        let second = market_series.get_or_compute_atr(14);

        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(
            market_series
                .indicator_cache
                .read()
                .expect("market indicator cache lock poisoned")
                .len(),
            1
        );
    }
    #[test]
    fn signal_time_fallback_uses_sorted_data_without_building_a_map() {
        let data = create_test_data(3);
        let signal = Signal::buy(60000, 100.0);

        assert_eq!(resolve_signal_index(&data, &signal), Some(1));
        assert_eq!(
            resolve_signal_index(&data, &Signal::buy(90000, 100.0)),
            None
        );
    }
    #[test]
    fn test_backtest_single_trade() {
        let data = create_test_data(100);
        let signals = vec![Signal::buy(0, 100.0), Signal::sell(50 * 60000, 105.0)];
        let mut settings = BacktestSettings::default();
        settings.stop_loss_atr = 0.0;
        settings.take_profit_atr = 0.0;
        settings.trailing_atr = 0.0;
        settings.partial_take_profit_at_r = 0.0;
        settings.break_even_at_r = 0.0;
        settings.trend_ema_period = 0;
        settings.adx_max = 0.0;
        settings.trade_direction = TradeDirection::Long;
        let result = run_backtest(&data, &signals, 10000.0, 100.0, 0.0, &settings, None, false);
        assert!(result.total_trades >= 1);
    }
    #[test]
    fn compact_idle_bar_skip_preserves_trade_metrics() {
        let data = create_test_data(5000);
        let signals = vec![
            Signal::buy(1000 * 60000, 200.0),
            Signal::sell(3000 * 60000, 205.0),
        ];
        let mut settings = BacktestSettings::default();
        settings.stop_loss_atr = 0.0;
        settings.take_profit_atr = 0.0;
        settings.trailing_atr = 0.0;
        settings.partial_take_profit_at_r = 0.0;
        settings.break_even_at_r = 0.0;
        settings.trend_ema_period = 0;
        settings.adx_max = 0.0;
        settings.trade_direction = TradeDirection::Long;
        let full = run_backtest(&data, &signals, 10000.0, 100.0, 0.0, &settings, None, false);
        let compact = run_backtest(&data, &signals, 10000.0, 100.0, 0.0, &settings, None, true);
        assert_eq!(compact.total_trades, full.total_trades);
        assert_eq!(compact.winning_trades, full.winning_trades);
        assert_eq!(compact.losing_trades, full.losing_trades);
        assert!((compact.net_profit - full.net_profit).abs() < 1e-9);
    }
    #[test]
    fn test_same_bar_exit_policy_matches_signal_order() {
        let data = vec![
            OHLCV::new(0, 100.0, 102.0, 99.0, 100.0, 1000.0),
            OHLCV::new(60000, 105.0, 106.0, 104.0, 105.0, 1000.0),
        ];
        let signals = vec![Signal::buy(0, 100.0), Signal::sell(0, 101.0)];
        let mut same_bar_enabled = BacktestSettings::default();
        same_bar_enabled.allow_same_bar_exit = true;
        let enabled_result = run_backtest(
            &data,
            &signals,
            10000.0,
            100.0,
            0.0,
            &same_bar_enabled,
            None,
            false,
        );
        let disabled_result = run_backtest(
            &data,
            &signals,
            10000.0,
            100.0,
            0.0,
            &BacktestSettings::default(),
            None,
            false,
        );
        assert_eq!(enabled_result.total_trades, 1);
        assert_eq!(disabled_result.total_trades, 1);
        assert_eq!(enabled_result.trades[0].exit_price, 101.0);
        assert_eq!(disabled_result.trades[0].exit_price, 105.0);
    }
    #[test]
    fn realistic_execution_model_applies_shifted_fills_and_slippage() {
        let data = vec![
            OHLCV::new(0, 100.0, 102.0, 99.0, 101.0, 1000.0),
            OHLCV::new(1, 110.0, 112.0, 109.0, 111.0, 1000.0),
            OHLCV::new(2, 120.0, 122.0, 119.0, 121.0, 1000.0),
        ];
        let signals = vec![Signal::buy(0, 101.0), Signal::sell(1, 111.0)];
        let mut settings = BacktestSettings::default();
        settings.execution_model = ExecutionModel::NextOpen;
        settings.slippage_bps = 100.0;
        settings.trade_direction = TradeDirection::Long;

        let result = run_backtest(
            &data, &signals, 10_000.0, 100.0, 0.0, &settings, None, false,
        );

        assert_eq!(result.total_trades, 1);
        assert!((result.trades[0].entry_price - 111.1).abs() < 1e-9);
        assert!((result.trades[0].exit_price - 118.8).abs() < 1e-9);
        assert_eq!(result.trades[0].entry_time, 1);
        assert_eq!(result.trades[0].exit_time, 2);
    }
    #[test]
    fn next_open_risk_exit_respects_entry_bar_ordering() {
        let data = vec![
            OHLCV::new(0, 100.0, 100.0, 100.0, 100.0, 1000.0),
            OHLCV::new(1, 100.0, 110.0, 99.0, 105.0, 1000.0),
            OHLCV::new(2, 120.0, 121.0, 119.0, 120.0, 1000.0),
        ];
        let signals = vec![Signal::buy(0, 100.0)];
        let mut settings = BacktestSettings::default();
        settings.execution_model = ExecutionModel::NextOpen;
        settings.risk_mode = RiskMode::Percentage;
        settings.take_profit_enabled = true;
        settings.take_profit_percent = 5.0;
        settings.trade_direction = TradeDirection::Long;

        let result = run_backtest(
            &data, &signals, 10_000.0, 100.0, 0.0, &settings, None, false,
        );

        assert_eq!(result.total_trades, 1);
        assert_eq!(result.trades[0].entry_time, 1);
        assert_eq!(result.trades[0].exit_time, 2);
        assert!((result.trades[0].exit_price - 105.0).abs() < 1e-9);
    }

    #[test]
    fn max_hold_closes_long_and_short_positions_at_the_boundary() {
        let data = vec![
            OHLCV::new(0, 100.0, 101.0, 99.0, 100.0, 1000.0),
            OHLCV::new(1, 100.0, 103.0, 99.0, 102.0, 1000.0),
            OHLCV::new(2, 104.0, 106.0, 103.0, 105.0, 1000.0),
            OHLCV::new(3, 106.0, 108.0, 105.0, 107.0, 1000.0),
        ];
        let mut long_settings = BacktestSettings::default();
        long_settings.risk_max_hold_enabled = true;
        long_settings.risk_max_hold_bars = 1;
        long_settings.trade_direction = TradeDirection::Long;
        let long = run_backtest(
            &data,
            &[Signal::buy(0, 100.0)],
            10_000.0,
            100.0,
            0.0,
            &long_settings,
            None,
            false,
        );
        assert_eq!(long.total_trades, 1);
        assert_eq!(long.trades[0].entry_time, 0);
        assert_eq!(long.trades[0].exit_time, 1);
        assert_eq!(long.trades[0].exit_reason, "time_stop");

        let mut short_settings = long_settings;
        short_settings.trade_direction = TradeDirection::Short;
        let short = run_backtest(
            &data,
            &[Signal::sell(0, 100.0)],
            10_000.0,
            100.0,
            0.0,
            &short_settings,
            None,
            false,
        );
        assert_eq!(short.total_trades, 1);
        assert_eq!(short.trades[0].entry_time, 0);
        assert_eq!(short.trades[0].exit_time, 1);
        assert_eq!(short.trades[0].exit_reason, "time_stop");
    }

    #[test]
    fn max_hold_signal_exit_wins_at_the_boundary_and_suppresses_entry_bar_exit() {
        let data = vec![
            OHLCV::new(0, 100.0, 101.0, 99.0, 100.0, 1000.0),
            OHLCV::new(1, 100.0, 103.0, 99.0, 102.0, 1000.0),
            OHLCV::new(2, 110.0, 111.0, 109.0, 110.0, 1000.0),
            OHLCV::new(3, 110.0, 111.0, 109.0, 110.0, 1000.0),
        ];
        let mut settings = BacktestSettings::default();
        settings.execution_model = ExecutionModel::NextOpen;
        settings.risk_max_hold_enabled = true;
        settings.risk_max_hold_bars = 1;
        settings.trade_direction = TradeDirection::Long;
        let result = run_backtest(
            &data,
            &[Signal::buy(0, 100.0), Signal::sell(1, 100.0)],
            10_000.0,
            100.0,
            0.0,
            &settings,
            None,
            false,
        );
        assert_eq!(result.total_trades, 1);
        assert_eq!(result.trades[0].entry_time, 1);
        assert_eq!(result.trades[0].exit_time, 2);
        assert_eq!(result.trades[0].exit_reason, "signal");
        assert_eq!(result.trades[0].exit_price, 110.0);

        let mut entry_bar_settings = settings;
        entry_bar_settings.risk_max_hold_bars = 0;
        entry_bar_settings.take_profit_enabled = true;
        entry_bar_settings.risk_mode = RiskMode::Percentage;
        entry_bar_settings.take_profit_percent = 1.0;
        let entry_bar = run_backtest(
            &data,
            &[Signal::buy(0, 100.0)],
            10_000.0,
            100.0,
            0.0,
            &entry_bar_settings,
            None,
            false,
        );
        assert_eq!(entry_bar.total_trades, 1);
        assert_eq!(entry_bar.trades[0].entry_time, 1);
        assert_eq!(entry_bar.trades[0].exit_time, 2);
        assert_eq!(entry_bar.trades[0].exit_reason, "take_profit");
    }

    #[test]
    fn partial_exit_returns_before_max_hold_on_the_same_bar() {
        let data = vec![
            OHLCV::new(0, 100.0, 100.0, 100.0, 100.0, 1000.0),
            OHLCV::new(1, 100.0, 100.0, 100.0, 100.0, 1000.0),
            OHLCV::new(2, 100.0, 112.0, 99.0, 105.0, 1000.0),
        ];
        let mut settings = BacktestSettings::default();
        settings.atr_period = 1;
        settings.risk_mode = RiskMode::Percentage;
        settings.stop_loss_enabled = true;
        settings.stop_loss_percent = 10.0;
        settings.partial_take_profit_at_r = 1.0;
        settings.partial_take_profit_percent = 50.0;
        settings.risk_max_hold_enabled = true;
        settings.risk_max_hold_bars = 1;
        settings.trade_direction = TradeDirection::Long;

        let result = run_backtest(
            &data,
            &[Signal::buy(1, 100.0)],
            10_000.0,
            100.0,
            0.0,
            &settings,
            None,
            false,
        );

        assert_eq!(result.total_trades, 2);
        assert_eq!(result.trades[0].exit_reason, "partial");
        assert_eq!(result.trades[0].exit_time, 2);
        assert_eq!(result.trades[1].exit_reason, "end_of_data");
        assert_eq!(result.trades[1].exit_time, 2);

        settings.partial_take_profit_percent = 100.0;
        let fully_partial_result = run_backtest(
            &data,
            &[Signal::buy(1, 100.0)],
            10_000.0,
            100.0,
            0.0,
            &settings,
            None,
            false,
        );

        assert_eq!(fully_partial_result.total_trades, 1);
        assert_eq!(fully_partial_result.trades[0].exit_reason, "partial");
        assert_eq!(fully_partial_result.trades[0].exit_time, 2);
    }

    #[test]
    fn next_open_atr_risk_uses_the_signal_bar_atr_source() {
        let data = vec![
            OHLCV::new(0, 100.0, 101.0, 100.0, 100.0, 1000.0),
            OHLCV::new(1, 100.0, 110.0, 95.0, 100.0, 1000.0),
            OHLCV::new(2, 100.0, 101.0, 99.0, 100.0, 1000.0),
        ];
        let mut settings = BacktestSettings::default();
        settings.execution_model = ExecutionModel::NextOpen;
        settings.atr_period = 1;
        settings.stop_loss_atr = 1.0;
        settings.trade_direction = TradeDirection::Long;
        let result = run_backtest(
            &data,
            &[Signal::buy(0, 100.0)],
            10_000.0,
            100.0,
            0.0,
            &settings,
            None,
            false,
        );
        assert_eq!(result.total_trades, 1);
        assert_eq!(result.trades[0].exit_reason, "stop_loss");
        assert_eq!(result.trades[0].exit_price, 99.0);
    }

    #[test]
    fn end_of_data_uses_raw_close_and_trade_pnl_percent_includes_fees() {
        let data = vec![
            OHLCV::new(0, 100.0, 101.0, 99.0, 100.0, 1000.0),
            OHLCV::new(1, 110.0, 111.0, 109.0, 110.0, 1000.0),
        ];
        let mut settings = BacktestSettings::default();
        settings.slippage_bps = 100.0;
        let eod = run_backtest(
            &data,
            &[Signal::buy(0, 100.0)],
            10_000.0,
            100.0,
            1.0,
            &settings,
            None,
            false,
        );
        assert_eq!(eod.total_trades, 1);
        assert_eq!(eod.trades[0].exit_price, 110.0);
        assert_eq!(eod.trades[0].exit_reason, "end_of_data");
        let entry_value = eod.trades[0].entry_price * eod.trades[0].size;
        assert!(
            (eod.trades[0].pnl_percent - (eod.trades[0].pnl / entry_value * 100.0)).abs() < 1e-9
        );
    }

    #[test]
    fn occupied_position_ignores_additional_entry_signals() {
        let data = vec![
            OHLCV::new(0, 100.0, 101.0, 99.0, 100.0, 1000.0),
            OHLCV::new(1, 101.0, 102.0, 100.0, 101.0, 1000.0),
            OHLCV::new(2, 102.0, 103.0, 101.0, 102.0, 1000.0),
        ];
        let mut settings = BacktestSettings::default();
        settings.trade_direction = TradeDirection::Long;
        let result = run_backtest(
            &data,
            &[
                Signal::buy(0, 100.0),
                Signal::buy(1, 101.0),
                Signal::sell(2, 102.0),
            ],
            10_000.0,
            100.0,
            0.0,
            &settings,
            None,
            false,
        );
        assert_eq!(result.total_trades, 1);
        assert_eq!(result.trades[0].entry_time, 0);
        assert_eq!(result.trades[0].exit_time, 2);
    }
    #[test]
    fn entry_cooldown_blocks_same_bar_reentry_after_signal_exit() {
        let data = vec![
            OHLCV::new(0, 100.0, 101.0, 99.0, 100.0, 1000.0),
            OHLCV::new(1, 100.0, 101.0, 99.0, 100.0, 1000.0),
            OHLCV::new(2, 100.0, 101.0, 99.0, 100.0, 1000.0),
        ];
        let signals = vec![
            Signal::buy(0, 100.0),
            Signal::sell(1, 100.0),
            Signal::buy(1, 100.0),
        ];
        let mut settings = BacktestSettings::default();
        settings.risk_cooldown_enabled = true;
        settings.risk_cooldown_bars = 1;
        settings.trade_direction = TradeDirection::Long;

        let result = run_backtest(
            &data, &signals, 10_000.0, 100.0, 0.0, &settings, None, false,
        );

        assert_eq!(result.total_trades, 1);
        assert_eq!(result.trades[0].exit_time, 1);
    }
    #[test]
    fn test_kelly_sizing_matches_configured_fraction_and_fallback() {
        let mut state = KellySizingState::default();
        for pnl in [100.0, 100.0, 100.0, 100.0, -50.0] {
            state.update(pnl);
        }
        let settings = AdvancedSizingConfig::default();
        let allocation = state.resolve_allocation(10000.0, 10.0, 500.0, &settings);
        // raw Kelly = 0.7 - (0.3 / 2.0) = 0.55, capped at 0.25, half = 0.125.
        assert!((allocation - 1250.0).abs() < f64::EPSILON);
        let mut invalid = KellySizingState::default();
        invalid.update(-50.0);
        assert_eq!(
            invalid.resolve_allocation(10000.0, 10.0, 500.0, &settings),
            500.0
        );
    }
    #[test]
    fn test_max_drawdown() {
        let equity = vec![
            EquityPoint {
                time: 0,
                value: 10000.0,
            },
            EquityPoint {
                time: 1,
                value: 11000.0,
            },
            EquityPoint {
                time: 2,
                value: 9000.0,
            }, // 18.18% drawdown from 11000
            EquityPoint {
                time: 3,
                value: 10500.0,
            },
        ];
        let (dd, dd_pct) = calculate_max_drawdown(&equity, 10000.0);
        assert!((dd - 2000.0).abs() < 0.01);
        assert!((dd_pct - 18.18).abs() < 0.1);
    }
    #[test]
    fn test_sharpe_ratio() {
        let trades = vec![
            Trade {
                id: 1,
                trade_type: TradeType::Long,
                entry_time: 0,
                entry_price: 100.0,
                exit_time: 1,
                exit_price: 102.0,
                pnl: 2.0,
                pnl_percent: 2.0,
                size: 1.0,
                exit_reason: "signal".to_string(),
                fees: None,
            },
            Trade {
                id: 2,
                trade_type: TradeType::Long,
                entry_time: 2,
                entry_price: 100.0,
                exit_time: 3,
                exit_price: 101.0,
                pnl: 1.0,
                pnl_percent: 1.0,
                size: 1.0,
                exit_reason: "signal".to_string(),
                fees: None,
            },
            Trade {
                id: 3,
                trade_type: TradeType::Long,
                entry_time: 4,
                entry_price: 100.0,
                exit_time: 5,
                exit_price: 99.0,
                pnl: -1.0,
                pnl_percent: -1.0,
                size: 1.0,
                exit_reason: "signal".to_string(),
                fees: None,
            },
        ];
        let sharpe = calculate_sharpe_ratio(&trades);
        assert!(sharpe.is_finite());
    }
}
