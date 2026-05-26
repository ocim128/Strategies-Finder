import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DebugLogger } from '../lib/debug-logger';
import { State } from '../lib/state';

function captureConsoleWarn(run: () => void): unknown[] {
    const originalWarn = console.warn;
    const warnings: unknown[] = [];
    console.warn = (...args: unknown[]) => {
        warnings.push(args);
    };
    try {
        run();
        return warnings;
    } finally {
        console.warn = originalWarn;
    }
}

describe('listener fault isolation', () => {
    it('continues notifying state subscribers after one subscriber throws', () => {
        const localState = new State();
        let secondListenerValue = '';

        localState.subscribe('currentSymbol', () => {
            throw new Error('state listener failed');
        });
        localState.subscribe('currentSymbol', (value) => {
            secondListenerValue = value;
        });

        const warnings = captureConsoleWarn(() => {
            localState.set('currentSymbol', 'BTCUSDT');
        });

        assert.equal(secondListenerValue, 'BTCUSDT');
        assert.equal(warnings.length, 1);
    });

    it('continues notifying debug subscribers after one subscriber throws', () => {
        const logger = new DebugLogger();
        let secondListenerCount = 0;

        logger.subscribe(() => {
            throw new Error('debug listener failed');
        });
        logger.subscribe((entries) => {
            secondListenerCount = entries.length;
        });

        const warnings = captureConsoleWarn(() => {
            logger.info('test.event');
        });

        assert.equal(secondListenerCount, 1);
        assert.equal(warnings.length, 1);
    });

    it('isolates debug subscriber failures when clearing entries', () => {
        const logger = new DebugLogger();
        let clearSeen = false;

        logger.subscribe(() => {
            throw new Error('debug listener failed');
        });
        logger.subscribe((entries) => {
            clearSeen = entries.length === 0;
        });

        const warnings = captureConsoleWarn(() => {
            logger.clear();
        });

        assert.equal(clearSeen, true);
        assert.equal(warnings.length, 1);
    });
});
