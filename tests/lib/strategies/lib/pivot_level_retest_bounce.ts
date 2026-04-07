import { Strategy } from "../../types/strategies";
import { getHighs, getLows, getCloses, getOpens, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
 // Assuming this exists or similar

export const pivot_level_retest_bounce: Strategy = {
  name: 'Pivot Level Retest Bounce',
  description: 'Confirmed pivot highs and lows create structural price levels. When price pulls back to retest a recent pivot level and the bar closes in the opposite direction (bounce), the level held and the prior move is likely to resume.',
  defaultParams: { pivotDepth: 5, retestTolerancePct: 0.5 },
  paramLabels: { pivotDepth: 'Pivot Depth', retestTolerancePct: 'Tolerance %' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['pivotDepth', 'retestTolerancePct'] },
  execute: (data, params) => {
    const { pivotDepth, retestTolerancePct } = params as { pivotDepth: number; retestTolerancePct: number };
    const cleanData = ensureCleanData(data);
    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    const closes = getCloses(cleanData);
    const opens = getOpens(cleanData);
    
    // As detectPivots is not strictly defined in helpers requested, we stub it 
    // or rely on a simplified rolling min/max for the sake of the structural logic.
    // In actual implementation it would be `detectPivots(highs, lows, pivotDepth)`.
    const pivots: { index: number; price: number; isHigh: boolean; confirmationIndex: number }[] = [];
    
    // Naive pivot detection for illustration (since detectPivots isn't exported directly in the listed helpers)
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

    return createSignalLoop(cleanData, [], (i) => {
      const close = closes[i];
      const open = opens[i];
      if (close === null || open === null) return null;

      for (const pivot of pivots) {
          if (pivot.confirmationIndex >= i) continue; // Not confirmed yet
          
          const distancePct = Math.abs(close - pivot.price) / pivot.price * 100;
          if (distancePct < retestTolerancePct) {
              if (!pivot.isHigh && close > open) return createBuySignal(cleanData, i, 'pivot_level_retest_bounce_buy'); // Bounce off support
              if (pivot.isHigh && close < open) return createSellSignal(cleanData, i, 'pivot_level_retest_bounce_sell'); // Reject off resistance
          }
      }
      
      return null;
    });
  }
};