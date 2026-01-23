import { Strategy } from './types';
import { rsi_oversold } from './lib/rsi-oversold';
import { triple_ma } from './lib/triple-ma';
import { vwap_crossover } from './lib/vwap-crossover';
import { rsi_macd_combo } from './lib/rsi-macd-combo';
import { volume_profile } from './lib/volume-profile';
import { donchian_breakout } from './lib/donchian-breakout';
import { supertrend_strategy } from './lib/supertrend';
import { parabolic_sar } from './lib/parabolic-sar';
import { momentum_strategy } from './lib/momentum';
import { fib_speed_fan } from './lib/fib-speed-fan';
import { fib_speed_fan_corrected } from './lib/fib-speed-fan-corrected';
import { fib_speed_fan_corrected2 } from './lib/fib-speed-fan-corrected2';
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
import { reversal_detection_pro } from './lib/reversal-detection-pro';

export const strategies: Record<string, Strategy> = {
    rsi_oversold,
    triple_ma,
    vwap_crossover,
    rsi_macd_combo,
    volume_profile,
    donchian_breakout,
    supertrend_strategy,
    parabolic_sar,
    momentum_strategy,
    fib_speed_fan,
    fib_speed_fan_corrected,
    fib_speed_fan_corrected2,
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
    reversal_detection_pro,
};

