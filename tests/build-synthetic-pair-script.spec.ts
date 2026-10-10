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
    it('rejects typoed flags instead of silently ignoring them', () => {
        assert.throws(
            () => parseCliOptions([...required,'--wick-mod','worst_case']),
            /Unknown argument: --wick-mod/
        );
    });
    it('rejects unexpected positional arguments', () => {
        assert.throws(() => parseCliOptions([...required,'stray-positional']),/Unknown argument: stray-positional/);
        assert.throws(() => parseCliOptions(['extra', ...required]),/Unknown argument: extra/);
    });
    it('rejects missing flag values with actionable errors', () => {
        assert.throws(() => parseCliOptions([...required,'--base-file']),/--base-file requires a value/);
        assert.throws(() => parseCliOptions(['--base-symbol','--quote-symbol','X','--interval','4h','--bars','2000']),/--base-symbol requires a value/);
        assert.throws(() => parseCliOptions([...required,'--source-interval']),/--source-interval requires a value/);
    });
    it('rejects an invalid target interval through the shared interval parser', () => {
        assert.throws(
            () => parseCliOptions([...required, '--interval', 'banana']),
            /--interval must be a supported interval/
        );
        assert.equal(parseCliOptions([...required,'--interval','15m']).interval,'15m');
    });
    it('validates the target interval before reading either leg file', async () => {
        await assert.rejects(
            run([...required,'--interval','banana','--base-file','definitely-missing-base.json','--quote-file','definitely-missing-quote.json','--out','never-written.json']),
            /--interval must be a supported interval/
        );
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

describe('build-synthetic-pair CLI run diagnostics', () => {
    const required = ['--base-symbol','MU•','--quote-symbol','CRWD•','--interval','4h','--bars','2000'];

    function writeLocalLegs(dir: string, times: number[]): { baseFile: string; quoteFile: string; out: string } {
        const candles = times.map((time, i) => ({
            time,
            open: 100 + i,
            high: 101 + i,
            low: 99 + i,
            close: 100 + i,
            volume: 10,
        }));
        const baseFile = join(dir, 'base.json');
        const quoteFile = join(dir, 'quote.json');
        writeFileSync(baseFile, JSON.stringify(candles));
        writeFileSync(quoteFile, JSON.stringify(candles));
        return { baseFile, quoteFile, out: join(dir, 'pair.json') };
    }

    it('reports zero source alignment losses for a fully aligned 8:1 aggregation', async (t) => {
        const dir = mkdtempSync(join(tmpdir(), 'synthetic-cli-diag-'));
        try {
            const { baseFile, quoteFile, out } = writeLocalLegs(dir, [0, 1800, 3600, 5400, 7200, 9000, 10800, 12600]);
            const logs: string[] = [];
            t.mock.method(console, 'log', (...args: unknown[]) => { logs.push(args.map(String).join(' ')); });

            await run([...required, '--source-interval', '30m', '--base-file', baseFile, '--quote-file', quoteFile, '--out', out]);

            const summary = logs.find((line) => line.includes('Dropped='));
            assert.ok(summary, 'the run must print its bar-count summary');
            assert.match(summary!, /AlignedSourceBars=8/);
            assert.match(summary!, /SyntheticBars=1/);
            assert.match(summary!, /Dropped=0/, 'fully aligned aggregation must not count bucket merging as dropped bars');
            assert.ok(
                logs.some((line) => line.includes('Aggregated 8 aligned source bars (30m -> 4h)')),
                'the completion line must identify the effective source interval',
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('reports genuine source alignment losses accurately', async (t) => {
        const dir = mkdtempSync(join(tmpdir(), 'synthetic-cli-diag-'));
        try {
            // The base leg has an extra earliest bar with no quote counterpart:
            // aligned source bars drop from 8 to 7 while the final 4h bar count stays 1.
            const baseTimes = [0, 1800, 3600, 5400, 7200, 9000, 10800, 12600];
            const quoteTimes = baseTimes.slice(1);
            const baseFile = join(dir, 'base.json');
            const quoteFile = join(dir, 'quote.json');
            writeFileSync(baseFile, JSON.stringify(baseTimes.map((time, i) => ({
                time, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10,
            }))));
            writeFileSync(quoteFile, JSON.stringify(quoteTimes.map((time, i) => ({
                time, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10,
            }))));

            const logs: string[] = [];
            t.mock.method(console, 'log', (...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
            await run([...required, '--source-interval', '30m', '--base-file', baseFile, '--quote-file', quoteFile, '--out', join(dir, 'pair.json')]);

            const summary = logs.find((line) => line.includes('Dropped='));
            assert.match(summary!, /AlignedSourceBars=7/);
            assert.match(summary!, /SyntheticBars=1/);
            assert.match(summary!, /Dropped=1/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
