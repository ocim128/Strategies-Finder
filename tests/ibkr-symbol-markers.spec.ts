import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { markIbkrSymbol, isIbkrSymbol, stripIbkrMarker } from "../lib/local-daily-datasets";

describe('ibkr bullet marker helpers', () => {
    it('marks a bare ticker and is idempotent', () => {
        assert.equal(markIbkrSymbol('NVDA'), 'NVDA\u2022');
        assert.equal(markIbkrSymbol('nvda'), 'NVDA\u2022');
        assert.equal(markIbkrSymbol('NVDA\u2022'), 'NVDA\u2022');
    });

    it('detects and strips bullet-marked symbols and leaves other symbols alone', () => {
        assert.equal(isIbkrSymbol('NVDA\u2022'), true);
        assert.equal(isIbkrSymbol('NVDA\u2666'), false);
        assert.equal(stripIbkrMarker('nvda\u2022'), 'NVDA');
    });
});
