/** Deadlines cover headers AND body consumption for short status/Stop requests. */
export const BATCH_CONTROL_TIMEOUT_MS = 60_000;

export async function requestBatchControl<T>(
    url: string,
    init: RequestInit,
    consume: (response: Response) => Promise<T>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
    const controller = new AbortController();
    const abortFromOwner = (): void => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abortFromOwner();
    else options.signal?.addEventListener("abort", abortFromOwner, { once: true });
    const timer = setTimeout(
        () => controller.abort(new DOMException("Batch control request timed out.", "TimeoutError")),
        options.timeoutMs ?? BATCH_CONTROL_TIMEOUT_MS,
    );
    let rejectOnAbort: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
        rejectOnAbort = () => reject(controller.signal.reason);
        if (controller.signal.aborted) rejectOnAbort();
        else controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
    });
    try {
        // Race also settles promptly if a mocked transport/body ignores abort.
        return await Promise.race([
            Promise.resolve().then(() => {
                controller.signal.throwIfAborted();
                return fetch(url, { ...init, signal: controller.signal });
            }).then((response) => {
                controller.signal.throwIfAborted();
                return consume(response);
            }),
            aborted,
        ]);
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abortFromOwner);
        controller.signal.removeEventListener("abort", rejectOnAbort!);
    }
}
