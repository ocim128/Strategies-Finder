import type { IncomingMessage, ServerResponse } from "node:http";
import { setImmediate } from "node:timers/promises";
import type { ViteHttpResponse } from "./vite-http-utils";

export interface RequestExecution {
    signal: AbortSignal;
    checkpoint(): Promise<void>;
    dispose(): void;
}

/** Request-owned work only: durable Finder/Batch jobs must survive disconnects. */
export function createRequestExecution(req: IncomingMessage, response: ViteHttpResponse): RequestExecution {
    const res = response as ViteHttpResponse & Partial<Pick<ServerResponse, "on" | "off" | "writableEnded" | "destroyed">>;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => { if (!res.writableEnded) abort(); };
    req.on?.("aborted", abort);
    res.on?.("close", close);
    res.on?.("error", abort);
    if (req.aborted || res.destroyed) abort();
    let lastYield = performance.now();
    return {
        signal: controller.signal,
        async checkpoint() {
            controller.signal.throwIfAborted();
            if (performance.now() - lastYield >= 20) {
                await setImmediate(undefined, { signal: controller.signal });
                lastYield = performance.now();
            }
            controller.signal.throwIfAborted();
        },
        dispose() {
            req.off?.("aborted", abort);
            res.off?.("close", close);
            res.off?.("error", abort);
        },
    };
}
