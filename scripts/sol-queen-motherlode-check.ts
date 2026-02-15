import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runStrategyStressTests, type StressReport } from "./sol-survivor-stress-tests";
import { sol_queen_v1_backtest_overrides } from "../lib/strategies/lib/sol_queen_v1";
import type { OHLCVData } from "../lib/types/strategies";

type DatasetRun = {
    symbol: string;
    interval: string;
    dataPath: string;
    reportPath: string;
    report: StressReport;
};

function toUnixSeconds(value: unknown): number | null {
    const n = Number(value);
    if (Number.isFinite(n)) return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
    const t = Date.parse(String(value ?? ""));
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function loadBars(filePath: string): OHLCVData[] {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as { data?: Array<Record<string, unknown>> };
    const rows = Array.isArray(raw.data) ? raw.data : [];
    const bars = rows
        .map((row) => {
            const time = toUnixSeconds(row.time ?? row.timestamp ?? row.datetime);
            const open = Number(row.open);
            const high = Number(row.high);
            const low = Number(row.low);
            const close = Number(row.close);
            const volume = Number(row.volume ?? 0);
            if (time === null || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return null;
            return {
                time,
                open,
                high,
                low,
                close,
                volume: Number.isFinite(volume) ? volume : 0,
            } as OHLCVData;
        })
        .filter((bar): bar is OHLCVData => Boolean(bar))
        .sort((a, b) => Number(a.time) - Number(b.time));
    return bars;
}

function resample2hTo4h(input: OHLCVData[]): OHLCVData[] {
    const out: OHLCVData[] = [];
    for (let i = 0; i + 1 < input.length; i += 2) {
        const a = input[i];
        const b = input[i + 1];
        out.push({
            time: a.time,
            open: a.open,
            high: Math.max(a.high, b.high),
            low: Math.min(a.low, b.low),
            close: b.close,
            volume: a.volume + b.volume,
        });
    }
    return out;
}

function ensureEth4hDataset(outDir: string): string {
    const direct = path.resolve("price-data/robust-lab/ETHUSDT-4h.json");
    if (fs.existsSync(direct)) return direct;

    const eth2h = path.resolve("price-data/robust-lab/ETHUSDT-2h.json");
    if (!fs.existsSync(eth2h)) throw new Error("Missing ETH dataset: price-data/robust-lab/ETHUSDT-2h.json");

    const bars4h = resample2hTo4h(loadBars(eth2h));
    const outPath = path.join(outDir, "ETHUSDT-4h.generated.json");
    const payload = {
        symbol: "ETHUSDT",
        interval: "4h",
        provider: "resampled_local_2h",
        bars: bars4h.length,
        generatedAt: new Date().toISOString(),
        data: bars4h,
    };
    fs.writeFileSync(outPath, JSON.stringify(payload), "utf8");
    return outPath;
}

async function runDataset(symbol: string, dataPath: string, outDir: string, tickSize: number): Promise<DatasetRun> {
    const fileName = `${symbol.toLowerCase()}-4h-sol-queen-v1.json`;
    const result = await runStrategyStressTests({
        dataPath,
        strategyKey: "sol_queen_v1",
        tickSize,
        seeds: [1337, 7331, 2026, 4242, 9001],
        finderMaxRuns: 20,
        finderRangePercent: 0,
        finderSteps: 1,
        finderTopN: 1,
        finderMinTrades: 36,
        positionSizePercent: 50,
        backtestSettingsOverrides: {
            ...sol_queen_v1_backtest_overrides,
        },
        outputDir: outDir,
        outputFileName: fileName,
        quiet: true,
    });
    return { symbol, interval: "4h", dataPath, reportPath: result.outPath, report: result.report };
}

async function main(): Promise<void> {
    const dateTag = new Date().toISOString().slice(0, 10);
    const outDir = path.resolve(`batch-runs/sol-queen-motherlode-${dateTag}`);
    fs.mkdirSync(outDir, { recursive: true });

    const btc4h = path.resolve("price-data/robust-lab/generated/strategy-evolution-2026-02-15-btc-sol-15m-4h/BTCUSDT-4h.json");
    if (!fs.existsSync(btc4h)) throw new Error("Missing BTC dataset: BTCUSDT-4h.json");
    const eth4h = ensureEth4hDataset(outDir);

    const runs: DatasetRun[] = [];
    runs.push(await runDataset("BTCUSDT", btc4h, outDir, 0.1));
    runs.push(await runDataset("ETHUSDT", eth4h, outDir, 0.01));

    const summary = {
        generatedAt: new Date().toISOString(),
        strategyKey: "sol_queen_v1",
        lockedBacktestSettings: sol_queen_v1_backtest_overrides,
        tuning: {
            finderRangePercent: 0,
            finderSteps: 1,
            finderTopN: 1,
            finderMaxRuns: 20,
            note: "No tuning: immutable strategy params, fixed finder surface",
        },
        runs: runs.map((row) => ({
            symbol: row.symbol,
            interval: row.interval,
            dataPath: row.dataPath,
            overallVerdict: row.report.overall.verdict,
            oosVerdict: row.report.oos70_30.verdict,
            wfVerdict: row.report.walkForward3m1m.verdict,
            feeVerdict: row.report.feeSlippageSensitivity.verdict,
            oosBlindMedianNetProfitPercent: row.report.oos70_30.blindMedianNetProfitPercent,
            oosBlindMedianMaxDrawdownPercent: row.report.oos70_30.blindMedianMaxDrawdownPercent,
            oosBlindMedianProfitFactor: row.report.oos70_30.blindMedianProfitFactor,
            wfCombinedNetProfitPercent: row.report.walkForward3m1m.combinedOOS.netProfitPercent,
            wfCombinedMaxDrawdownPercent: row.report.walkForward3m1m.combinedOOS.maxDrawdownPercent,
            wfCombinedProfitFactor: row.report.walkForward3m1m.combinedOOS.profitFactor,
            feeMedianNetProfitPercent: row.report.feeSlippageSensitivity.medianNetProfitPercent,
            feeMedianMaxDrawdownPercent: row.report.feeSlippageSensitivity.medianMaxDrawdownPercent,
            feeMedianProfitFactor: row.report.feeSlippageSensitivity.medianProfitFactor,
            reportPath: row.reportPath,
        })),
    };

    const summaryPath = path.join(outDir, "sol-queen-motherlode-summary.json");
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");

    const lines: string[] = [];
    lines.push(`SOL Queen v1 Motherlode Check ${new Date().toISOString()}`);
    for (const row of summary.runs) {
        lines.push(
            `${row.symbol} 4h | overall=${row.overallVerdict} oos=${row.oosVerdict} wf=${row.wfVerdict} fee=${row.feeVerdict}` +
            ` | OOS net=${row.oosBlindMedianNetProfitPercent.toFixed(2)}% PF=${row.oosBlindMedianProfitFactor.toFixed(2)} DD=${row.oosBlindMedianMaxDrawdownPercent.toFixed(2)}%`
        );
    }
    const txtPath = path.join(outDir, "sol-queen-motherlode-summary.txt");
    fs.writeFileSync(txtPath, `${lines.join("\n")}\n`, "utf8");

    console.log(`[motherlode] wrote ${summaryPath}`);
    console.log(`[motherlode] wrote ${txtPath}`);
}

const isDirectRun = (() => {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
})();

if (isDirectRun) {
    main().catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`sol-queen-motherlode-check failed: ${message}`);
        process.exitCode = 1;
    });
}
