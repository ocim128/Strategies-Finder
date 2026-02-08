import { Strategy } from './types';
import { fib_speed_fan } from './lib/fib-speed-fan';
import { fib_speed_fan_corrected } from './lib/fib-speed-fan-corrected';
import { fib_speed_fan_corrected2 } from './lib/fib-speed-fan-corrected2';
import { fib_speed_fan_entry } from './lib/fib-speed-fan-entry';
import { fib_retracement } from './lib/fib-retracement';
import { day_trading_booster } from './lib/day-trading-booster';
import { volume_pivot_anchored } from './lib/volume-pivot-anchored';
import { macd_x_overlay } from './lib/macd-x-overlay';
import { fib_time_zones } from './lib/fib-time-zones';
import { trend_fib_time } from './lib/trend-fib-time';
import { vol_targeted_trend } from './lib/vol-targeted-trend';
import { gravity_well } from './lib/gravity-well';
import { volatility_cycle_rider } from './lib/volatility-cycle-rider';
import { trap_hunter } from './lib/trap-hunter';
import { supply_demand_zones } from './lib/supply-demand-zones';
import { mtf_impulse_zone_reversal, mtf_impulse_zone_breakout } from './lib/mtf-impulse-zones';
import { chandelier_rsi_ema } from './lib/chandelier_rsi_ema';
import { adaptive_supertrend_kmeans } from './lib/adaptive_supertrend_kmeans';
import { mean_reversion_zscore } from './lib/mean_reversion_zscore';
import { failed_breakout } from './lib/failed_breakout';
import { long_short_harvest } from './lib/long-short-harvest';
import { dynamic_vix_regime } from './lib/dynamic-vix-regime';
import { dynamic_vix_regime_finder } from './lib/dynamic-vix-regime-finder';
import { drawdown_regime_gate } from './lib/drawdown-regime-gate';
import { regime_donchian_breakout } from './lib/regime-donchian-breakout';
import { shock_reversion_trend_gate } from './lib/shock-reversion-trend-gate';
import { momentum_volatility_rotation } from './lib/momentum-volatility-rotation';
import { adx_atr_no_trade_zone } from './lib/adx-atr-no-trade-zone';
import { simple_regression_line } from './lib/simple-regression-line';
import { liquidity_sweep_reclaim } from './lib/liquidity-sweep-reclaim';
import { volatility_compression_break } from './lib/volatility-compression-break';
import { gap_fail_reversal } from './lib/gap-fail-reversal';
import { exhaustion_spike_pullback } from './lib/exhaustion-spike-pullback';
import { session_open_fakeout } from './lib/session-open-fakeout';

export const strategies: Record<string, Strategy> = {
    fib_speed_fan,
    fib_speed_fan_corrected,
    fib_speed_fan_corrected2,
    fib_speed_fan_entry,
    fib_retracement,
    day_trading_booster,
    volume_pivot_anchored,
    macd_x_overlay,
    fib_time_zones,
    trend_fib_time,
    vol_targeted_trend,
    gravity_well,
    volatility_cycle_rider,
    trap_hunter,
    supply_demand_zones,
    mtf_impulse_zone_reversal,
    mtf_impulse_zone_breakout,
    chandelier_rsi_ema,
    adaptive_supertrend_kmeans,
    mean_reversion_zscore,
    failed_breakout,
    long_short_harvest,
    dynamic_vix_regime,
    dynamic_vix_regime_finder,
    drawdown_regime_gate,
    regime_donchian_breakout,
    shock_reversion_trend_gate,
    momentum_volatility_rotation,
    adx_atr_no_trade_zone,
    simple_regression_line,
    liquidity_sweep_reclaim,
    volatility_compression_break,
    gap_fail_reversal,
    exhaustion_spike_pullback,
    session_open_fakeout,
};
