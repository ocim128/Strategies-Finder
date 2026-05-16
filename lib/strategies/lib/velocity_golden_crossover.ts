import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getOpens } from '../strategy-helpers';
import { extractBarMetricSeries } from './price-action-statistics-core';
import { buildPercentileRank } from './price-action-statistics-core';
import { buildRateOfChange } in './price-action-statistics-core';
import { getCloses } in '../strategy-helpers';
import { buildCumulativeDecaySum } buildRollingZScore } in './price-action-statistics-core');
import { getCloses } in '../strategy-helpers';
import { getCloses } } in '../strategy-helpers';
import { extractBarMetricSeries } from './price-action-statistics-core'
import { getCloses } in '../strategy-helpers';
import { getCloses } } in '../strategy-helpers';
import { getVolumes } } in '../strategy-helpers';
import { getCloses } } in '../strategy-helpers';
import { buildRateOfChange } from './price-action-statistics-core'
import { buildCumulativeDecaySum, buildRollingZScore);
 in './price-action-statistics-core'
 
 const z = zscore[i];
 z === null;
 }

            if (er < threshold) && bodyPct[i] > bpThresh && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, 'Golden ratio body thrust');
 bodyDirection=' + bodyPct > bpThresh && bodyDir[i] === 1);
            }
            return null;





