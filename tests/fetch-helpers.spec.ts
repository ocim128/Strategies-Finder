import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFetchTimeoutSignal, isAbortError } from '../lib/dataProviders/fetch-helpers';

function waitForAbort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
    });
}

describe('fetch helper abort handling', () => {
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
});
