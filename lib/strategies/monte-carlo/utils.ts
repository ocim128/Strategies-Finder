/**
 * Create a seeded PRNG (Mulberry32)
 */
export function createSeededRandom(seed: number): () => number {
    let state = seed >>> 0;
    
    return function() {
        state |= 0;
        state = (state + 0x6D2B79F5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Generate Gaussian (normal) random numbers using Box-Muller transform
 */
export function gaussianRandom(random: () => number, mean = 0, stdDev = 1): number {
    const u1 = random();
    const u2 = random();
    
    // Avoid log(0)
    const u1Safe = u1 === 0 ? 1e-10 : u1;
    
    const z0 = Math.sqrt(-2 * Math.log(u1Safe)) * Math.cos(2 * Math.PI * u2);
    return z0 * stdDev + mean;
}
