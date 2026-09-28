/**
 * Runtime coordination primitives shared by the replay stages. Bounded-yield
 * scheduling keeps progress callbacks and Stop observable during long loops.
 */

/**
 * Yield to the macrotask queue (Node setImmediate). Server-side only; the
 * vite cjs config bundle never runs these stages in a browser.
 */
export function yieldLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}
