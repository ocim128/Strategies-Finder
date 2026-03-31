/**
 * Create a seeded PRNG (Mulberry32)
 */
export { createSeededRandom } from "../../param-math-utils";

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
