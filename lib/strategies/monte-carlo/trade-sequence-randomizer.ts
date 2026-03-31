import type { Trade } from "../../types/strategies";
import { createSeededRandom } from "./utils";

/**
 * Randomizes the sequence of trades to test path dependency.
 * Keeps trade magnitudes fixed but shuffles their order.
 */
export function randomizeTradeSequence(
    trades: Trade[],
    seed: number
): Trade[] {
    if (trades.length === 0) return [];
    
    const tradeReturns = trades.map((trade, index) => ({
        pnlPercent: trade.pnlPercent,
        pnl: trade.pnl,
        originalIndex: index,
        originalTrade: trade,
    }));
    
    const shuffled = fisherYatesShuffle(tradeReturns, seed);
    
    // Rebuild trades with shuffled order but new timestamps
    return shuffled.map((item, newIndex) => ({
        ...item.originalTrade,
        id: newIndex,
        entryTime: trades[newIndex]?.entryTime ?? item.originalTrade.entryTime,
        exitTime: trades[newIndex]?.exitTime ?? item.originalTrade.exitTime,
    }));
}

/**
 * Fisher-Yates shuffle with seeded random
 */
function fisherYatesShuffle<T>(array: T[], seed: number): T[] {
    const random = createSeededRandom(seed);
    const result = [...array];
    
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    
    return result;
}

/**
 * Generate multiple randomized sequences
 */
export function generateRandomizedSequences(
    trades: Trade[],
    seed: number,
    count: number
): Trade[][] {
    return Array.from({ length: count }, (_, i) => 
        randomizeTradeSequence(trades, seed + i)
    );
}
