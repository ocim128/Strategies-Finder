import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { executeBacktest, type BacktestExecutorRequest } from '../lib/backtest-executor';
import { BACKTEST_ENDPOINT_CAPITAL_SETTINGS } from '../lib/backtest-endpoint-contract';
import { parseIbkrCsvPayload } from '../lib/batch-backtest/server-ibkr-csv-loader';
import { parseIntervalSeconds } from '../lib/interval-utils';
import { timeKey } from '../lib/strategies/backtest/backtest-utils';
import type { BacktestResult, OHLCVData } from '../lib/types/strategies';
import { buildSyntheticPairPayload } from './lib/synthetic-pair';
import { parseOhlcvDataFile } from './lib/ohlcv-file';

/** Closed bars use the envelope; an unfinished next-open bridge has only a known open. */
export function buildStopStressRanges(bars: OHLCVData[], interval: string, nowSec: number): Map<string, { high: number; low: number }> {
    const seconds = parseIntervalSeconds(interval);
    if (!seconds) throw new Error(`Invalid target interval: ${interval}`);
    return new Map(bars.map(bar => [timeKey(bar.time), Number(bar.time) + seconds > nowSec
        ? { high: bar.open, low: bar.open }
        : { high: bar.high, low: bar.low }]));
}

function loadLeg(file: string, sourceInterval: string): OHLCVData[] {
    const text = readFileSync(resolve(file), 'utf8');
    if (/\.csv$/i.test(file)) return parseIbkrCsvPayload(text);
    const parsed = parseOhlcvDataFile(JSON.parse(text));
    if (parsed.interval && parsed.interval !== sourceInterval) {
        throw new Error(`${file} interval ${parsed.interval} does not match --source-interval ${sourceInterval}.`);
    }
    return parsed.bars;
}

function metrics(result: BacktestResult) {
    return {
        totalTrades: result.totalTrades, winningTrades: result.winningTrades, winRate: result.winRate,
        netProfit: result.netProfit, profitFactor: result.profitFactor, maxDrawdownPercent: result.maxDrawdownPercent,
        stopLossExits: result.trades.filter(trade => trade.exitReason === 'stop_loss').length,
        takeProfitExits: result.trades.filter(trade => trade.exitReason === 'take_profit').length,
        entryBarStopLossExits: result.trades.filter(trade => trade.exitReason === 'stop_loss' && timeKey(trade.entryTime) === timeKey(trade.exitTime)).length,
    };
}

export async function runSyntheticStopStress(argv: string[]): Promise<void> {
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log('Usage: npm run synthetic:stress-stops -- --config config.json --strategy dmi_direction_confirmation --base-file MU.csv --quote-file CRWD.csv --source-interval 30m [--out artifacts/synthetic-stop-stress]');
        return;
    }
    const allowed = new Set(['--config', '--strategy', '--base-file', '--quote-file', '--source-interval', '--out']);
    const args = new Map<string, string>();
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i], value = argv[i + 1];
        if (!allowed.has(key) || !value || value.startsWith('--')) throw new Error(`Invalid or missing argument: ${key}`);
        args.set(key, value);
    }
    for (const key of ['--config', '--base-file', '--quote-file', '--source-interval']) {
        if (!args.has(key)) throw new Error(`${key} is required.`);
    }
    const config = JSON.parse(readFileSync(resolve(args.get('--config')!), 'utf8'));
    const strategyKey = args.get('--strategy') ?? config.strategyKey;
    if (!strategyKey || !config.symbol || !config.interval || !config.strategyParams || !config.backtestSettings) {
        throw new Error('Provide --strategy and a config with symbol, interval, strategyParams and backtestSettings.');
    }
    const sourceInterval = args.get('--source-interval')!.toLowerCase();
    const targetSeconds = parseIntervalSeconds(config.interval), sourceSeconds = parseIntervalSeconds(sourceInterval);
    if (!sourceSeconds || !targetSeconds || sourceSeconds > targetSeconds || targetSeconds % sourceSeconds !== 0) {
        throw new Error('The source interval must divide the target interval exactly and cannot be coarser.');
    }
    const nowSec = config.context?.nowSec ?? Math.floor(Date.now() / 1000);
    if (!Number.isFinite(nowSec)) throw new Error('context.nowSec must be finite.');
    const base = loadLeg(args.get('--base-file')!, sourceInterval);
    const quote = loadLeg(args.get('--quote-file')!, sourceInterval);
    const [baseSymbol, quoteSymbol] = config.symbol.split('+');
    if (!baseSymbol || !quoteSymbol) throw new Error('config.symbol must be BASE+QUOTE.');
    const payloadOptions = {baseSymbol, quoteSymbol, symbol:config.symbol, interval:config.interval, base, quote, sourceInterval};
    const matched = buildSyntheticPairPayload(payloadOptions);
    const envelope = buildSyntheticPairPayload({...payloadOptions, wickMode:'worst_case', symbol:`${config.symbol}-STRESS`});
    const candles = parseOhlcvDataFile(matched).bars;
    const stressRanges = buildStopStressRanges(parseOhlcvDataFile(envelope).bars, config.interval, nowSec);
    const request: BacktestExecutorRequest = {
        ohlcvData: candles, interval:config.interval, primarySymbol:config.symbol, strategyKey,
        strategyParams:config.strategyParams, backtestSettings:config.backtestSettings,
        capitalSettings: BACKTEST_ENDPOINT_CAPITAL_SETTINGS,
        context:{nowSec, blockRange:config.context?.blockRange ?? null, engineMode:'typescript'},
        backtestRunOptions:{includeAdvancedAnalytics:false, includeSharpeRatio:false, skipResultPostProcessing:true},
    };
    const baseline = await executeBacktest(request);
    const stress = await executeBacktest({...request, preGeneratedSignals:baseline.signals,
        backtestRunOptions:{...request.backtestRunOptions, stopLossStressRanges:stressRanges}});
    const report = {
        scenario:'worst_case_stop_envelope', strategyKey, symbol:config.symbol, interval:config.interval, sourceInterval,
        nowSec, blockRange:request.context.blockRange, capitalSettings:request.capitalSettings,
        strategyParams:config.strategyParams, backtestSettings:config.backtestSettings,
        bars:candles.length, signalCount:baseline.signals.length,
        assumptions:[
            'Long SL uses base.low/quote.high; short SL uses base.high/quote.low within each source candle.',
            'Signals, indicators, entries, TP, trailing updates and end-of-data prices use the original candles.',
            'Possible SL has priority over TP; unfinished bars contribute only their known open.',
            'Conservative stop scenario, not observed execution or a global worst-case portfolio bound.',
            'Chart-importing envelope.json regenerates signals and widens TP checks; it does not reproduce this adverse-only run.',
        ],
        baseline:metrics(baseline.result), stress:metrics(stress.result),
        winRateDeltaPercentagePoints:stress.result.winRate-baseline.result.winRate,
    };
    const outDir = resolve(args.get('--out') ?? 'artifacts/synthetic-stop-stress');
    mkdirSync(outDir, {recursive:true});
    for (const [name, content] of Object.entries({
        'report.json':report, 'baseline.json':matched, 'envelope.json':envelope,
        'baseline-trades.json':baseline.result.trades, 'stress-trades.json':stress.result.trades,
    })) writeFileSync(resolve(outDir,name), JSON.stringify(content,null,2), 'utf8');
    console.log(JSON.stringify(report,null,2));
    console.log(`Artifacts: ${outDir}`);
}

if (process.argv[1] && /stress-synthetic-stops\.(ts|js)$/i.test(process.argv[1])) {
    runSyntheticStopStress(process.argv.slice(2)).catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
