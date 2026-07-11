/**
 * Helper to consume newline-delimited JSON (NDJSON) streams.
 * Maps event types to camelCase handlers, e.g. 'symbol_failed' -> 'onSymbolFailed'.
 *
 * `requireTerminal` (default false): when true, a stream that reaches EOF
 * without first processing a `done` or `fatal` event throws
 * `StreamEndedBeforeTerminalError`. Without this flag the consumer resolves
 * normally at EOF — the original behavior that Crypto/IBKR/Stability rely on
 * (they track terminal state themselves). Callers whose correctness depends on
 * a terminal event (Batch Run, Batch Miner, Finder Universe) should opt in so
 * a truncated stream surfaces as an error instead of partial data presented as
 * complete.
 */
export class StreamEndedBeforeTerminalError extends Error {
    constructor(message = "NDJSON stream ended before a terminal (done/fatal) event.") {
        super(message);
        this.name = "StreamEndedBeforeTerminalError";
    }
}

export async function consumeNdjsonStream<T extends { type: string }>(
    body: ReadableStream<Uint8Array>,
    handlers: Record<string, ((event: any) => void) | undefined>,
    options?: { requireTerminal?: boolean }
): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawTerminal = false;

    const toHandlerKey = (type: string): string => {
        const camel = type.replace(/_([a-z])/g, (_, g) => g.toUpperCase());
        return "on" + camel.charAt(0).toUpperCase() + camel.slice(1);
    };

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let newlineIndex: number;
            while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, newlineIndex).trim();
                buffer = buffer.slice(newlineIndex + 1);
                if (!line) continue;
                let event: T;
                try {
                    event = JSON.parse(line) as T;
                } catch {
                    continue;
                }
                const handlerKey = toHandlerKey(event.type);
                const handler = handlers[handlerKey];
                if (handler) {
                    handler(event);
                }
                if (event.type === "done" || event.type === "fatal") {
                    sawTerminal = true;
                    return;
                }
            }
        }
        if (options?.requireTerminal && !sawTerminal) {
            throw new StreamEndedBeforeTerminalError();
        }
    } finally {
        reader.releaseLock();
    }
}
