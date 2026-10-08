import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseCliOptions, run } from '../scripts/build-synthetic-pair';

describe('build-synthetic-pair CLI options parser', () => {
    const required = ['--base-symbol','MU•','--quote-symbol','CRWD•','--interval','4h','--bars','2000'];
    it('keeps normal output paths and accepts explicitly labelled stress generation', () => {
        assert.equal(parseCliOptions(required).wickMode,'matched');
        const stress = parseCliOptions([...required,'--wick-mode','worst_case','--source-interval','30m']);
        assert.equal(stress.wickMode,'worst_case');
        assert.equal(stress.sourceInterval,'30m');
        assert.ok(stress.outPath.endsWith('-4h-stress.json'));
    });
    it('rejects invalid modes and incompatible source intervals', () => {
        assert.throws(() => parseCliOptions([...required,'--wick-mode','optimistic']),/--wick-mode/);
        assert.throws(() => parseCliOptions([...required,'--wick-mode']),/--wick-mode/);
        for (const interval of ['3h','1d','bad']) {
            assert.throws(() => parseCliOptions([...required,'--source-interval',interval]),/--source-interval/);
        }
    });
    it('writes an identified stress payload from finer local files without a remote fetch', async () => {
        const dir=mkdtempSync(join(tmpdir(),'synthetic-stress-cli-'));
        try {
            const candles=[{time:0,open:100,high:101,low:99,close:100,volume:10},{time:1800,open:100,high:102,low:98,close:100,volume:20}];
            const baseFile=join(dir,'base.json'), quoteFile=join(dir,'quote.json'), out=join(dir,'stress.json');
            writeFileSync(baseFile,JSON.stringify(candles));
            writeFileSync(quoteFile,JSON.stringify(candles));
            await run([...required,'--wick-mode','worst_case','--source-interval','30m','--base-file',baseFile,'--quote-file',quoteFile,'--out',out]);
            const payload=JSON.parse(readFileSync(out,'utf8'));
            assert.equal(payload.source.wickMode,'worst_case');
            assert.equal(payload.source.sourceInterval,'30m');
            assert.equal(payload.bars,1);
            assert.equal(payload.data[0].high,102/98);
            assert.equal(payload.data[0].low,98/102);
        } finally {
            rmSync(dir,{recursive:true,force:true});
        }
    });
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
