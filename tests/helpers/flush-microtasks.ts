/**
 * Drain pending microtask checkpoints (promise chains queued by the code
 * under test) without arbitrary sleeps. Two macrotask turns are enough for
 * every continuation scheduled before the call.
 */
export async function flushMicrotasks(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
}
