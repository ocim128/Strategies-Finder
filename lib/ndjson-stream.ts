/**
 * Helper to consume newline-delimited JSON (NDJSON) streams.
 * Maps event types to camelCase handlers, e.g. 'symbol_complete' ->
 * 'onSymbolComplete'. Malformed non-empty lines always fail with their 1-based
 * line number; silently accepting a partial protocol is never safe.
 *
 * `requireTerminal` (default false): when true, a stream that reaches EOF
 *   without first processing a terminal event throws. The default terminal
 *   events are `done` and `fatal`; callers can provide `terminalTypes`.
 *   `StreamEndedBeforeTerminalError`. Without this flag the consumer resolves
 *   normally at EOF. Callers whose correctness depends on a terminal event
 *   should opt in.
 */
export class StreamEndedBeforeTerminalError extends Error {
    constructor(message = "NDJSON stream ended before a terminal (done/fatal) event.") {
        super(message);
        this.name = "StreamEndedBeforeTerminalError";
    }
}

export class MalformedNdjsonLineError extends Error {
    /** 1-based line number within the stream. */
    readonly lineNumber: number;
    constructor(lineNumber: number) {
        super(`NDJSON stream contained a malformed line at line ${lineNumber}.`);
        this.name = "MalformedNdjsonLineError";
        this.lineNumber = lineNumber;
    }
}

export interface ConsumeNdjsonStreamOptions {
    requireTerminal?: boolean;
    terminalTypes?: readonly string[];
    onEvent?: (event: { type: string }) => void;
}

export async function consumeNdjsonStream<T extends { type: string }>(
    body: ReadableStream<Uint8Array>,
    handlers: Record<string, ((event: any) => void) | undefined>,
    options?: ConsumeNdjsonStreamOptions
): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawTerminal = false;
    let lineNumber = 0;
    const terminalTypes = options?.terminalTypes ?? ["done", "fatal"];

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
                lineNumber += 1;
                if (!line) continue;
                let event: T;
                try {
                    event = JSON.parse(line) as T;
                } catch {
                    throw new MalformedNdjsonLineError(lineNumber);
                }
                options?.onEvent?.(event);
                const handlerKey = toHandlerKey(event.type);
                const handler = handlers[handlerKey];
                if (handler) {
                    handler(event);
                }
                if (terminalTypes.includes(event.type)) {
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
