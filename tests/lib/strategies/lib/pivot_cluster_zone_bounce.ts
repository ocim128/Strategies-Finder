import { Strategy } from "../../types/strategies";
import { getCloses, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData, getHighs, getLows } from '../strategy-helpers';
// pivot-helpers.ts assumes to exist but maybe its not available with this exact API. We'll reconstruct the pivot density.

export const pivot_cluster_zone_bounce: Strategy = {
  name: 'Pivot Cluster Zone Bounce',
  description: 'When multiple confirmed swing pivots cluster within a narrow price band, they create a high-density S/R zone — the market has reversed at this level repeatedly. A bounce from a zone with 3+ nearby pivots carries more structural significance than a bounce from any single pivot because it reflects collective market memory of that level.',
  defaultParams: { pivotDepth: 5, clusterTolerancePct: 0.5, minClusterSize: 3 },
  paramLabels: { pivotDepth: 'Pivot Depth', clusterTolerancePct: 'Tolerance %', minClusterSize: 'Min Pivots in Zone' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['pivotDepth', 'clusterTolerancePct', 'minClusterSize'] },
  execute: (data, params) => {
    const { pivotDepth, clusterTolerancePct, minClusterSize } = params as { pivotDepth: number; clusterTolerancePct: number; minClusterSize: number };
    const cleanData = ensureCleanData(data);
    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    const closes = getCloses(cleanData);
    
    const pivots: { index: number; price: number; isHigh: boolean; confirmationIndex: number }[] = [];
    
    for (let i = pivotDepth * 2; i < cleanData.length; i++) {
        let isHigh = true;
        let isLow = true;
        const centerHigh = highs[i - pivotDepth]!;
        const centerLow = lows[i - pivotDepth]!;
        
        for (let j = 1; j <= pivotDepth; j++) {
            if (highs[i - pivotDepth - j]! > centerHigh || highs[i - pivotDepth + j]! > centerHigh) isHigh = false;
            if (lows[i - pivotDepth - j]! < centerLow || lows[i - pivotDepth + j]! < centerLow) isLow = false;
        }
        
        if (isHigh) pivots.push({ index: i - pivotDepth, price: centerHigh, isHigh: true, confirmationIndex: i });
        if (isLow) pivots.push({ index: i - pivotDepth, price: centerLow, isHigh: false, confirmationIndex: i });
    }

    return createSignalLoop(cleanData, [], (i: number) => {
      const close = closes[i];
      const prevClose = closes[i - 1];
      if (close === null || prevClose === null) return null;

      // Filter pivots confirmed up to bar i
      const activePivots = pivots.filter(p => p.confirmationIndex < i);
      
      let maxSupportClusterSize = 0;
      let maxResistanceClusterSize = 0;

      for (const pivot of activePivots) {
          const distancePct = Math.abs(close - pivot.price) / pivot.price * 100;
          if (distancePct < clusterTolerancePct) {
              const cluster = activePivots.filter(p => p.isHigh === pivot.isHigh && Math.abs(p.price - pivot.price) / p.price * 100 < clusterTolerancePct);
              if (!pivot.isHigh && cluster.length > maxSupportClusterSize) maxSupportClusterSize = cluster.length;
              if (pivot.isHigh && cluster.length > maxResistanceClusterSize) maxResistanceClusterSize = cluster.length;
          }
      }

      if (maxSupportClusterSize >= minClusterSize && close > prevClose) return createBuySignal(cleanData, i, 'pivot_cluster_zone_bounce_buy');
      if (maxResistanceClusterSize >= minClusterSize && close < prevClose) return createSellSignal(cleanData, i, 'pivot_cluster_zone_bounce_sell');
      
      return null;
    });
  }
};