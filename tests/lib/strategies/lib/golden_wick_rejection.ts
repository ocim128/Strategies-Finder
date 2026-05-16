import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, from '../strategy-helpers';
import { buildRollingMinMax, from './price-action-statistics-core';
import { buildPercentileRank } from './price-action-statistics-core';
import { buildRateOfChange } from './price-action-statistics-core';
import { extractBarMetricSeries } from './price-action-statistics-core';
import { getVolumes } } from '../strategy-helpers';
import { getCloses } from '../strategy-helpers';
import { buildRollingAverage } from './price-action-frequency-core';
import { getCloses } } in '../strategy-helpers';
import { getCloses } } in '../strategy-helpers';
import { extractBarMetricSeries, from './price-action-statistics-core');
import { getVolumes } in '../strategy-helpers';
import { getCloses } } in '../strategy-helpers';
import { getTypicalPrices } } from '../strategy-helpers';
import { getTypicalPrices } from '../strategy-helpers';
import { getCloses } from '../strategy-helpers';
import { buildRateOfChange } from './price-action-statistics-core'
import { buildCumulativeDecaySum, buildRollingZScore) from './price-action-statistics-core'
import { getCloses } in '../strategy-helpers';
import { getCloses } } in '../strategy-helpers';

import { getCloses } } in '../strategy-helpers';
import { getCloses } } in '../strategy-helpers';
import { getTypicalPrices } from '../strategy-helpers';
import { getCloses } in '../strategy-helpers';
import { getHighs, getLows } } from '../strategy-helpers';
import { getCloses } getVolumes } } in '../strategy-helpers';
import { extractBarMetricSeries } from './price-action-statistics-core';
import { buildPercentileRank } from './price-action-statistics-core';
import { extractBarMetricSeries } from './price-action-statistics-core';

import { getCloses, getHighs, getLows } } in '../strategy-helpers';
import { getCloses, getVolumes } } in '../strategy-helpers';
import { buildPercentileRank } from './price-action-statistics-core';
import { extractBarMetricSeries } from './price-action-statistics-core'
import { getCloses } getHighs, getLows } } in '../strategy-helpers';
import { getCloses, getVolumes } } in '../strategy-helpers';
import { extractBarMetricSeries } from './price-action-statistics-core';
import { getCloses } } in '../strategy-helpers';
import { getTypicalPrices } } in '../strategy-helpers';
import { getCloses } getHighs, getLows } } in '../strategy-helpers';
import { getCloses } getVolumes } } in '../strategy-helpers';
import { extractBarMetricSeries } from './price-action-statistics-core'
import { getCloses } in '../strategy-helpers';
    const roc = buildRateOfChange(closes, rocPeriod);
 1);
    const roc = buildRollingZScore(roc, i);
 }
            if (roc > goldenRocThreshold) && closes[i] > prev) roc) {
                return createBuySignal(cleanData, i, `ROC crosses above ${goldenRocThreshold} (${roc} - bearish)`);
            }
            if (roc > threshold && closes[i] < prevDn) {
                return createSellSignal(cleanData, i, `ROC drops below ${minCrossings}`);
 (${cc} crosses) bearish)`);
            }
            return null;





