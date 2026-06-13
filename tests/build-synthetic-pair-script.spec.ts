import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseCliOptions } from '../scripts/build-synthetic-pair';

describe('build-synthetic-pair CLI options parser', () => {
    it('requires base symbol', () => {
        assert.throws(
            () => parseCliOptions(['--quote-symbol', 'PAXGUSDT', '--interval', '15m', '--bars', '2000']),
            /--base-symbol is required/
        );
    });

    it('requires quote symbol', () => {
        assert.throws(
            () => parseCliOptions(['--base-symbol', 'BNBUSDT', '--interval', '15m', '--bars', '2000']),
            /--quote-symbol is required/
        );
    });

    it('requires interval', () => {
        assert.throws(
            () => parseCliOptions(['--base-symbol', 'BNBUSDT', '--quote-symbol', 'PAXGUSDT', '--bars', '2000']),
            /--interval is required/
        );
    });

    it('requires bars to be at least 1000', () => {
        assert.throws(
            () => parseCliOptions(['--base-symbol', 'BNBUSDT', '--quote-symbol', 'PAXGUSDT', '--interval', '15m', '--bars', '200']),
            /--bars must be a number >= 1000/
        );
    });

    it('parses options and defaults output path to synthetic directory', () => {
        const options = parseCliOptions([
            '--base-symbol', 'bnbusdt',
            '--quote-symbol', 'paxgusdt',
            '--interval', '15m',
            '--bars', '2500',
        ]);

        assert.equal(options.baseSymbol, 'BNBUSDT');
        assert.equal(options.quoteSymbol, 'PAXGUSDT');
        assert.equal(options.symbol, 'BNBPAXG');
        assert.equal(options.interval, '15m');
        assert.equal(options.bars, 2500);
        assert.ok(options.outPath.replace(/\\/g, '/').endsWith('price-data/synthetic/BNBPAXG-15m.json'));
    });

    it('allows explicit symbol and output path override', () => {
        const options = parseCliOptions([
            '--base-symbol', 'ETHUSDT',
            '--quote-symbol', 'PAXGUSDT',
            '--symbol', 'CustomPair',
            '--interval', '5m',
            '--bars', '8000',
            '--out', 'artifacts/custom-pair.json',
        ]);

        assert.equal(options.symbol, 'CUSTOMPAIR');
        assert.ok(options.outPath.replace(/\\/g, '/').endsWith('artifacts/custom-pair.json'));
    });
});
