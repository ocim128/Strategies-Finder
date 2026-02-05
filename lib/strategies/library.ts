import { Strategy } from './types';
import { rsi_oversold } from './lib/rsi-oversold';
import { triple_ma } from './lib/triple-ma';
import { vwap_crossover } from './lib/vwap-crossover';

import { volume_profile } from './lib/volume-profile';
import { donchian_breakout } from './lib/donchian-breakout';
import { supertrend_strategy } from './lib/supertrend';
import { supertrend_confirmed } from './lib/supertrend-confirmed';
import { parabolic_sar } from './lib/parabolic-sar';
import { momentum_strategy } from './lib/momentum';
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

export const strategies: Record<string, Strategy> = {
    rsi_oversold,
    triple_ma,
    vwap_crossover,

    volume_profile,
    donchian_breakout,
    supertrend_strategy,
    supertrend_confirmed,
    parabolic_sar,
    momentum_strategy,
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
};
