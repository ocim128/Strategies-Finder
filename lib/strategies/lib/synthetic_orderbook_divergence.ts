import { Strategy } from "../../types/strategies";
import { getHighs, getLows, getCloses, getVolumes, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { extractBarMetricSeries } from './price-action-frequency-core';
import { buildRollingZScore } from './price-action-statistics-core';
import { calculateCMF } from '../indicators';

export const synthetic_orderbook_divergence: Strategy = {
  name: 'Synthetic Orderbook Divergence',
  description: 'Z-scores the Chaikin Money Flow to locate massive algorithmic capital inflows/outflows, then fades them if the price intra-bar geometry entirely refuses to yield ground.',
  defaultParams: { cmfLookback: 20, zscoreExtreme: 2.5, closeLocExtreme: 0.2 },
  paramLabels: { cmfLookback: 'CMF Window', zscoreExtreme: 'Z-Score Extreme', closeLocExtreme: 'Close Loc Extreme' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['cmfLookback', 'zscoreExtreme', 'closeLocExtreme'] },
  execute: (data, params) => {
    const { cmfLookback, zscoreExtreme, closeLocExtreme } = params as { cmfLookback: number; zscoreExtreme: number; closeLocExtreme: number };
    const cleanData = ensureCleanData(data);
    
    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    const closes = getCloses(cleanData);
    const volumes = getVolumes(cleanData);

    const cmf = calculateCMF(highs, lows, closes, volumes, cmfLookback);
    const cmfNumeric = cmf.map(v => v === null ? 0 : v);
    const zscore = buildRollingZScore(cmfNumeric, cmfLookback);
    
    const closeLocation = extractBarMetricSeries(cleanData, 'closeMidpointDev');

    return createSignalLoop(cleanData, [], (i: number) => {
      if (i < cmfLookback * 2) return null;
      
      const currZ = zscore[i];
      const cLoc = closeLocation[i];

      if (currZ === null || cLoc === null) return null;

      if (currZ < -zscoreExtreme && cLoc > (1.0 - closeLocExtreme)) return createBuySignal(cleanData, i, 'synthetic_orderbook_divergence_buy');
      if (currZ > zscoreExtreme && cLoc < closeLocExtreme) return createSellSignal(cleanData, i, 'synthetic_orderbook_divergence_sell');
      
      return null;
    });
  }
};