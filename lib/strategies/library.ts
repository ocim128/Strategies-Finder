import { Strategy } from './types';
import { sma_crossover } from './lib/sma-crossover';
import { ema_crossover } from './lib/ema-crossover';
import { rsi_oversold } from './lib/rsi-oversold';
import { macd_crossover } from './lib/macd-crossover';
import { bollinger_bounce } from './lib/bollinger-bounce';
import { triple_ma } from './lib/triple-ma';
import { stochastic_crossover } from './lib/stochastic-crossover';
import { vwap_crossover } from './lib/vwap-crossover';
import { rsi_macd_combo } from './lib/rsi-macd-combo';
import { volume_profile } from './lib/volume-profile';
import { donchian_breakout } from './lib/donchian-breakout';
import { supertrend_strategy } from './lib/supertrend';
import { parabolic_sar } from './lib/parabolic-sar';
import { momentum_strategy } from './lib/momentum';
import { fib_speed_fan } from './lib/fib-speed-fan';
import { fib_retracement } from './lib/fib-retracement';

export const strategies: Record<string, Strategy> = {
    sma_crossover,
    ema_crossover,
    rsi_oversold,
    macd_crossover,
    bollinger_bounce,
    triple_ma,
    stochastic_crossover,
    vwap_crossover,
    rsi_macd_combo,
    volume_profile,
    donchian_breakout,
    supertrend_strategy,
    parabolic_sar,
    momentum_strategy,
    fib_speed_fan,
    fib_retracement
};
