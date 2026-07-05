/**
 * Helper to consume newline-delimited JSON (NDJSON) streams.
 * Maps event types to camelCase handlers, e.g. 'symbol_failed' -> 'onSymbolFailed'.
 */
export async function consumeNdjsonStream<T extends { type: string }>(
    body: ReadableStream<Uint8Array>,
    handlers: Record<string, ((event: any) => void) | undefined>
): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

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
                    return;
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}
