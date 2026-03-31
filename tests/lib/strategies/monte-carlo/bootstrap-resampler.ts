import type { Trade } from "../../types/strategies";
import { createSeededRandom } from "./utils";

/**
 * Bootstrap resampling - samples trades WITH replacement.
 * This creates new synthetic trade sequences of the same length.
 */
export function bootstrapResample(
    trades: Trade[],
    seed: number
): Trade[] {
    if (trades.length === 0) return [];
    
    const random = createSeededRandom(seed);
    const result: Trade[] = [];
    
    for (let i = 0; i < trades.length; i++) {
        const randomIndex = Math.floor(random() * trades.length);
        const originalTrade = trades[randomIndex];
        
        result.push({
            ...originalTrade,
            id: i,
            // Preserve original trade characteristics
        });
    }
    
    return result;
}

/**
 * Generate multiple bootstrap samples
 */
export function generateBootstrapSamples(
    trades: Trade[],
    seed: number,
    count: number
): Trade[][] {
    return Array.from({ length: count }, (_, i) => 
        bootstrapResample(trades, seed + i)
    );
}

/**
 * Block bootstrap - preserves autocorrelation structure
 * Samples blocks of consecutive trades instead of individual trades
 */
export function blockBootstrapResample(
    trades: Trade[],
    seed: number,
    blockSize: number = 4
): Trade[] {
    if (trades.length === 0) return [];
    
    const random = createSeededRandom(seed);
    const numBlocks = Math.ceil(trades.length / blockSize);
    const result: Trade[] = [];
    
    // Create blocks
    const blocks: Trade[][] = [];
    for (let i = 0; i < trades.length; i += blockSize) {
        blocks.push(trades.slice(i, i + blockSize));
    }
    
    // Sample blocks with replacement
    for (let i = 0; i < numBlocks && result.length < trades.length; i++) {
        const blockIndex = Math.floor(random() * blocks.length);
        const block = blocks[blockIndex];
        result.push(...block);
    }
    
    return result.slice(0, trades.length);
}
