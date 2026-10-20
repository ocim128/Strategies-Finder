import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    createFetchTimeoutSignal,
    fetchWithTimeoutAndRetry,
    fetchAndConsumeWithTimeoutAndRetry,
    isAbortError,
    readJsonOrText,
    extractApiError,
    resolveRetryWaitMs,
    MAX_RETRY_WAIT_MS,
} from '../lib/dataProviders/fetch-helpers';
import { fetchLocalApiWithBody } from '../lib/local-api-transport';

const originalFetch = globalThis.fetch;

describe('retry pacing', () => {
    it('grows exponentially and never exceeds the policy ceiling', () => {
        // random=1 pins the jittered value at the ceiling of its window.
        const wait = (attempt: number, baseDelayMs = 250) =>
            resolveRetryWaitMs({ attempt, baseDelayMs, random: () => 1 });

        assert.equal(wait(1), 250);
        assert.equal(wait(2), 500);
        assert.equal(wait(3), 1000);
        // The exponent is capped, so a far-out attempt stops doubling instead
        // of overflowing into an unbounded wait.
        assert.equal(wait(20), 16_000);
        assert.ok(wait(20) < MAX_RETRY_WAIT_MS);
    });

    it('jitters within the upper half of the window so concurrent workers do not resume in lockstep', () => {
        const schedule = [0, 0.25, 0.5, 0.75, 0.999].map(
            (value) => resolveRetryWaitMs({ attempt: 1, baseDelayMs: 1000, random: () => value }),
        );
        // The floor is half the ceiling: a draw near zero must not retry a
        // rate-limited provider immediately.
        assert.deepEqual(schedule, [500, 625, 750, 875, 999]);
        assert.equal(new Set(schedule).size, schedule.length, 'distinct random draws must produce distinct waits');
    });

    it('clamps an upstream Retry-After hint instead of parking the run for an hour', () => {
        const clamped = resolveRetryWaitMs({ attempt: 1, baseDelayMs: 250, retryAfterMs: 3_600_000, random: () => 1 });
        assert.equal(clamped, MAX_RETRY_WAIT_MS);

        // A small hint is honored (jittered downward only), never ignored.
        const honored = resolveRetryWaitMs({ attempt: 1, baseDelayMs: 250, retryAfterMs: 4000, random: () => 1 });
        assert.equal(honored, 4000);
        const jittered = resolveRetryWaitMs({ attempt: 1, baseDelayMs: 250, retryAfterMs: 4000, random: () => 0.5 });
        assert.equal(jittered, 3000);
    });

    it('keeps a zero base delay at zero so tests and callers can opt out of waiting', () => {
        assert.equal(resolveRetryWaitMs({ attempt: 5, baseDelayMs: 0, random: () => 0.99 }), 0);
    });
});

describe('price response body deadlines', () => {
    afterEach(() => { globalThis.fetch = originalFetch; });
    for (const phase of ['headers', 'body'] as const) {
        it(`retries its own deadline during ${phase} without treating it as caller cancellation`, async t => {
            t.mock.timers.enable({ apis: ['setTimeout'] });
            let calls = 0;
            globalThis.fetch = async (_input, init) => {
                if (++calls > 1) return new Response('{"ok":true}');
                const signal = init!.signal!;
                if (phase === 'headers') {
                    return new Promise<Response>((_resolve, reject) => {
                        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
                    });
                }
                return new Response(new ReadableStream({
                    start(controller) { signal.addEventListener('abort', () => controller.error(signal.reason), { once: true }); },
                }));
            };
            const result = fetchAndConsumeWithTimeoutAndRetry('https://example.test/data', {}, r => r.json(), {
                timeoutMs: 25, maxAttempts: 2, baseDelayMs: 0,
            });
            await new Promise<void>(resolve => setImmediate(resolve));
            t.mock.timers.tick(25);
            assert.deepEqual(await result, { ok: true });
            assert.equal(calls, 2);
        });
    }

    it('preserves TimeoutError after the retry budget is exhausted', async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        let calls = 0;
        globalThis.fetch = async (_input, init) => {
            calls++;
            return new Promise<Response>((_resolve, reject) => {
                init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            });
        };
        const result = assert.rejects(fetchAndConsumeWithTimeoutAndRetry('https://example.test/data', {}, r => r.text(), {
            timeoutMs: 25, maxAttempts: 2, baseDelayMs: 0,
        }), { name: 'TimeoutError' });
        t.mock.timers.tick(25);
        await new Promise<void>(resolve => setImmediate(resolve));
        t.mock.timers.tick(25);
        await result;
        assert.equal(calls, 2);
    });

    it('never retries caller cancellation even when the caller uses a TimeoutError reason', async () => {
        const parent = new AbortController();
        let calls = 0;
        globalThis.fetch = async () => {
            calls++;
            const reason = new DOMException('Caller deadline', 'TimeoutError');
            parent.abort(reason);
            throw reason;
        };
        await assert.rejects(fetchAndConsumeWithTimeoutAndRetry('https://example.test/data', {}, r => r.text(), {
            signal: parent.signal, maxAttempts: 3, baseDelayMs: 0,
        }), { name: 'TimeoutError' });
        assert.equal(calls, 1);
    });
    for (const transport of ['provider', 'local'] as const) {
        const readBody = (signal?: AbortSignal) => transport === 'provider'
            ? fetchAndConsumeWithTimeoutAndRetry('https://example.test/data', {}, response => response.text(), { signal, timeoutMs: 25 })
            : fetchLocalApiWithBody('/price-data/test.csv', { signal }, 25, response => response.text());

        function installStalledBody() {
            let bodyStarted = false;
            globalThis.fetch = async (_input, init) => new Response(new ReadableStream({
                start(controller) {
                    bodyStarted = true;
                    const signal = init!.signal!;
                    signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
                },
            }));
            return () => bodyStarted;
        }

        it(`${transport}: aborts a stalled body after headers arrive`, async t => {
            t.mock.timers.enable({ apis: ['setTimeout'] });
            const bodyStarted = installStalledBody();
            const result = assert.rejects(readBody(), error => isAbortError(error));
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(bodyStarted(), true);
            t.mock.timers.tick(25);
            await result;
        });

        it(`${transport}: observes caller cancellation while consuming the body`, async () => {
            const bodyStarted = installStalledBody();
            const parent = new AbortController();
            const result = assert.rejects(readBody(parent.signal), error => isAbortError(error));
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(bodyStarted(), true);
            parent.abort();
            await result;
        });
    }

    it('consumes only the terminal retry response', async () => {
        let calls = 0;
        let consumed = 0;
        let discarded = 0;
        globalThis.fetch = async () => {
            calls++;
            return calls === 1
                ? new Response(new ReadableStream({ cancel: () => { discarded++; } }), { status: 429 })
                : new Response('{"ok":true}');
        };
        const data = await fetchAndConsumeWithTimeoutAndRetry('https://example.test/data', {}, async response => {
            consumed++;
            return response.json();
        }, { maxAttempts: 2, baseDelayMs: 0 });
        assert.deepEqual(data, { ok: true });
        assert.equal(calls, 2);
        assert.equal(consumed, 1);
        assert.equal(discarded, 1);
    });
});

function waitForAbort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
    });
}

describe('fetch helper abort handling', () => {
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('treats nullish and primitive errors as non-abort errors', () => {
        assert.equal(isAbortError(null), false);
        assert.equal(isAbortError(undefined), false);
        assert.equal(isAbortError('AbortError'), false);
    });

    it('aborts timeout-scoped requests with an abort-like error', async () => {
        const timeout = createFetchTimeoutSignal(undefined, 1);
        try {
            assert.ok(timeout.signal);
            await waitForAbort(timeout.signal);
            assert.equal(timeout.signal.aborted, true);
            assert.equal(isAbortError((timeout.signal as AbortSignal & { reason?: unknown }).reason), true);
        } finally {
            timeout.cleanup();
        }
    });

    it('propagates caller aborts through the composed signal', () => {
        const parent = new AbortController();
        const timeout = createFetchTimeoutSignal(parent.signal, 1000);
        try {
            assert.ok(timeout.signal);
            parent.abort();
            assert.equal(timeout.signal.aborted, true);
            assert.equal(isAbortError((timeout.signal as AbortSignal & { reason?: unknown }).reason), true);
        } finally {
            timeout.cleanup();
        }
    });

    it('retries transient HTTP responses before returning the final response', async () => {
        let calls = 0;
        globalThis.fetch = (async () => {
            calls += 1;
            return new Response(JSON.stringify({ calls }), {
                status: calls === 1 ? 429 : 200,
                headers: { 'content-type': 'application/json' },
            });
        }) as typeof fetch;

        const response = await fetchWithTimeoutAndRetry('https://example.test/data', {}, {
            maxAttempts: 2,
            baseDelayMs: 0,
        });

        assert.equal(response.status, 200);
        assert.equal(calls, 2);
    });
});

describe('readJsonOrText', () => {
    it('parses a JSON content-type body as json, leaving text null', async () => {
        const response = new Response(JSON.stringify({ ok: false, error: 'boom' }), {
            headers: { 'content-type': 'application/json; charset=utf-8' },
        });
        const result = await readJsonOrText(response);
        assert.deepEqual(result.json, { ok: false, error: 'boom' });
        assert.equal(result.text, null);
    });

    it('returns text and a parsed json when a non-JSON body parses as JSON', async () => {
        // Workers/proxies sometimes answer with a text/html error page that is
        // actually valid JSON; both fields let the caller render a useful message.
        const response = new Response(JSON.stringify({ error: 'still works' }), {
            headers: { 'content-type': 'text/html' },
        });
        const result = await readJsonOrText(response);
        assert.deepEqual(result.json, { error: 'still works' });
        assert.equal(result.text, JSON.stringify({ error: 'still works' }));
    });

    it('returns text only when the body is not parseable as JSON', async () => {
        const response = new Response('<html>gateway down</html>', {
            headers: { 'content-type': 'text/html' },
        });
        const result = await readJsonOrText(response);
        assert.equal(result.json, null);
        assert.equal(result.text, '<html>gateway down</html>');
    });

    it('returns null/null for an empty body', async () => {
        const response = new Response('', { headers: { 'content-type': 'text/plain' } });
        const result = await readJsonOrText(response);
        assert.equal(result.json, null);
        assert.equal(result.text, null);
    });
});

describe('extractApiError', () => {
    it('pulls a trimmed .error string from an { ok, error } payload', () => {
        assert.equal(extractApiError({ ok: false, error: '  nope  ' }), 'nope');
    });

    it('falls back to the supplied fallback when no usable error string is present', () => {
        assert.equal(extractApiError({ ok: false }, 'HTTP 502'), 'HTTP 502');
        assert.equal(extractApiError({ error: '   ' }, 'HTTP 502'), 'HTTP 502');
        assert.equal(extractApiError(null, 'HTTP 502'), 'HTTP 502');
    });

    it('returns null when neither payload nor fallback has a message', () => {
        assert.equal(extractApiError({ ok: false }), null);
        assert.equal(extractApiError({}, null), null);
    });
});
