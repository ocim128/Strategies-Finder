import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

/** Poll an observable condition against one deadline, failing at the source. */
export async function waitFor(
    predicate: () => boolean,
    timeoutMs: number,
    label: string,
): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (!predicate()) {
        const remainingMs = deadline - performance.now();
        if (remainingMs <= 0) throw new Error(`timed out waiting for ${label}`);
        await delay(Math.min(5, remainingMs));
    }
}
