import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    createFetchTimeoutSignal,
    fetchWithTimeoutAndRetry,
    isAbortError,
    readJsonOrText,
    extractApiError,
} from '../lib/dataProviders/fetch-helpers';

const originalFetch = globalThis.fetch;

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
