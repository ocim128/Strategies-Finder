/**
 * Shared transport for the five Batch server-side NDJSON POST calls (run,
 * mine, stability-mine, portfolio-fit, mine-prediction). Audit NDJSON-POST-
 * helper finding: each call site duplicated the same four mechanics — JSON
 * POST, `response.ok`/`response.body` validation, best-effort JSON error
 * extraction, and `consumeNdjsonStream(..., { requireTerminal: true })` — and
 * the error-parsing format had already started to drift between methods.
 *
 * This module owns TRANSPORT ONLY. Lifecycle/UI state (button toggles,
 * `beginAnalysisBusy`, `serverHasArtifacts` flips, result renderers) stays at
 * each call site — moving it here would couple the helper to every feature's
 * state machine and break the single-responsibility contract.
 *
 * Handler objects are keyed by event type in camelCase (e.g. `onStart`,
 * `onDone`, `onFatal`), matching `consumeNdjsonStream`'s dispatch convention.
 * Each call site keeps its typed handler object so endpoint-specific events
 * remain compile-checked.
 */

import { consumeNdjsonStream } from "../ndjson-stream";

/**
 * Extract a server error message from a non-2xx response body. The server
 * returns errors as `{ "error": "..." }` JSON; older paths returned plain
 * text. This helper unifies both: try JSON first, fall back to the raw text,
 * fall back to the HTTP status if the body is empty.
 *
 * Returns both the message and the parsed payload (when the body was JSON) so
 * callers that need to inspect the error structurally (e.g. the Stability /
 * Portfolio Fit "no artifacts on server" 400 special case) can do so without
 * re-reading the body.
 */
export async function extractBatchServerError(
    response: Response,
    fallbackStatusText?: string,
): Promise<{ message: string; payload: Record<string, unknown> | null }> {
    const text = await response.text().catch(() => "");
    if (text) {
        try {
            const payload = JSON.parse(text) as Record<string, unknown>;
            const error = payload.error;
            if (typeof error === "string" && error.trim()) {
                return { message: error, payload };
            }
            return { message: text, payload };
        } catch {
            // Not JSON — return the raw text below.
        }
        return { message: text, payload: null };
    }
    return { message: fallbackStatusText ?? `HTTP ${response.status}`, payload: null };
}

/**
 * POST `body` as JSON to `endpoint`, validate the response, and dispatch the
 * NDJSON stream events to `handlers`. Always uses `requireTerminal: true` —
 * every Batch endpoint emits `done` or `fatal` as the last event, and a clean
 * EOF before either is a protocol violation (audit truncated-stream finding).
 *
 * Throws an `Error` carrying the server-supplied message on:
 *   - non-2xx response (parsed via {@link extractBatchServerError})
 *   - response with no body
 *   - any error raised inside a handler (re-thrown verbatim)
 *   - `StreamEndedBeforeTerminalError` from the underlying consumer
 *
 * `onResponse` runs after the response is validated but BEFORE the stream is
 * consumed. The four analysis paths (Mine / Stability / Portfolio Fit / Mine
 * Prediction) use it to call `reissueStopIfNeeded` so a Stop that raced the
 * POST is re-sent after the server has claimed ownership — see
 * `requestServerStop`'s "Fetch resolves after the route owns the miner lock"
 * comment. The Run path leaves it absent.
 *
 * `onNonOkResponse` runs when the response is not 2xx (or has no body),
 * BEFORE the error is thrown. Two analysis paths (Stability / Portfolio Fit)
 * use it to flip `serverHasArtifacts = false` when the server reports
 * "no artifacts" so the next click short-circuits without a round trip. The
 * hook receives the parsed error payload so it can match structurally without
 * re-reading the body.
 */
export async function postBatchNdjson<TEvent extends { type: string }>(
    opts: {
        endpoint: string;
        body: unknown;
        handlers: Record<string, ((event: any) => void) | undefined>;
        signal?: AbortSignal;
        /**
         * Runs after the response is validated (ok + body present), before
         * `consumeNdjsonStream` starts reading. Used by analysis paths to
         * re-issue Stop once the server owns the lock. May throw to abort the
         * stream before it starts.
         */
        onResponse?: (response: Response) => Promise<void> | void;
        /**
         * Runs when the response is not 2xx (or has no body), before the
         * helper throws. Used by Stability and Portfolio Fit to flip
         * `serverHasArtifacts = false` on a "no artifacts on server" 400 so
         * the next click short-circuits. The hook receives the HTTP status
         * and the parsed error payload (when JSON) so it can match
         * structurally; returning a string overrides the thrown message.
         */
        onNonOkResponse?: (status: number, payload: Record<string, unknown> | null) => Promise<void> | void;
    },
): Promise<void> {
    const { endpoint, body, handlers, signal, onResponse, onNonOkResponse } = opts;
    const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
    });
    if (!response.ok || !response.body) {
        const { message, payload } = await extractBatchServerError(response);
        if (onNonOkResponse) await onNonOkResponse(response.status, payload);
        throw new Error(message);
    }
    if (onResponse) await onResponse(response);
    await consumeNdjsonStream<TEvent>(response.body, handlers, { requireTerminal: true });
}
