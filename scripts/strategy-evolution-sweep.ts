import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { strategies } from "../lib/strategies/library";
import { fetchBinanceDataWithLimit } from "../lib/dataProviders/binance";
import { resampleOHLCV } from "../lib/strategies/resample-utils";
import type { OHLCVData, Time } from "../lib/types/strategies";
import { runStrategyStressTests, type StressReport } from "./sol-survivor-stress-tests";

type DatasetSpec = {
    symbol: string;
    interval: string;
    dataPath: string;
    bars: number;
};

type ComboResult = {
    symbol: string;
    interval: string;
    strategyKey: string;
    reportPath: string;
    report: StressReport;
    passCount: number;
    fails: Array<"oos70_30" | "walkForward3m1m" | "feeSlippageSensitivity">;
    compositeScore: number;
    robustPrecheck: {
        verdict: "GO" | "NO_GO" | "UNKNOWN";
        seedPassRate: number | null;
        medianCellPassRate: number | null;
        medianStageCSurvivors: number | null;
    };
};

type FailureAnalysisUnavailable = {
    symbol: string;
    strategyKey: string;
    available: false;
    note: string;
};

type FailureAnalysisAvailable = {
    symbol: string;
    strategyKey: string;
    available: true;
    chosenInterval: string;
    passCount: number;
    verdict: "PASS" | "FAIL";
    failureMode: FailureMode;
    likelyIssue: "entry_logic" | "exit_logic" | "mixed";
    rationale: string;
    metrics: {
        oosBlindMedianNetProfitPercent: number;
        oosBlindMedianMaxDrawdownPercent: number;
        walkForwardNetProfitPercent: number;
        walkForwardMaxDrawdownPercent: number;
        feeSlippageMedianNetProfitPercent: number;
        feeSlippageMedianMaxDrawdownPercent: number;
    };
    reportPath: string;
};

type FailureAnalysisItem = FailureAnalysisUnavailable | FailureAnalysisAvailable;

type FailureMode =
    | "slow_bleed_cost_drag"
    | "drawdown_shock"
    | "mixed_instability";

const TARGET_SYMBOLS = ["BTCUSDT", "SOLUSDT"];
const TARGET_INTERVALS = ["15m", "4h"];
const DEFAULT_SEEDS = [1337, 7331, 2026, 4242, 9001];
const DEFAULT_TICK_BY_SYMBOL: Record<string, number> = {
    BTCUSDT: 0.1,
    SOLUSDT: 0.01,
};

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeName(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function parseBarsFromRaw(raw: unknown): OHLCVData[] {
    const rows = Array.isArray(raw)
        ? raw
        : (isObject(raw) && Array.isArray(raw.data) ? raw.data : []);

    const parsed: OHLCVData[] = [];
    for (const row of rows) {
        if (Array.isArray(row)) {
            if (row.length < 5) continue;
            const t = Number(row[0]);
            const o = Number(row[1]);
            const h = Number(row[2]);
            const l = Number(row[3]);
            const c = Number(row[4]);
            const v = Number(row[5] ?? 0);
            if (!Number.isFinite(t) || !Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) continue;
            const time = (t > 1e12 ? Math.floor(t / 1000) : Math.floor(t)) as Time;
            parsed.push({ time, open: o, high: h, low: l, close: c, volume: Number.isFinite(v) ? v : 0 });
            continue;
        }
        if (!isObject(row)) continue;
        const rawTime = row.time ?? row.t ?? row.timestamp ?? row.openTime;
        const rawOpen = row.open ?? row.o;
        const rawHigh = row.high ?? row.h;
        const rawLow = row.low ?? row.l;
        const rawClose = row.close ?? row.c;
        const rawVolume = row.volume ?? row.v ?? 0;
        const t = Number(rawTime);
        const o = Number(rawOpen);
        const h = Number(rawHigh);
        const l = Number(rawLow);
        const c = Number(rawClose);
        const v = Number(rawVolume);
        if (!Number.isFinite(t) || !Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) continue;
        const time = (t > 1e12 ? Math.floor(t / 1000) : Math.floor(t)) as Time;
        parsed.push({ time, open: o, high: h, low: l, close: c, volume: Number.isFinite(v) ? v : 0 });
    }

    parsed.sort((a, b) => Number(a.time) - Number(b.time));
    const deduped: OHLCVData[] = [];
    for (const bar of parsed) {
        const last = deduped[deduped.length - 1];
        if (last && Number(last.time) === Number(bar.time)) deduped[deduped.length - 1] = bar;
        else deduped.push(bar);
    }
    return deduped;
}

function writeDatasetFile(
    filePath: string,
    symbol: string,
    interval: string,
    provider: string,
    bars: OHLCVData[]
): string {
    if (bars.length === 0) {
        throw new Error(`Cannot write empty dataset: ${filePath}`);
    }
    const payload = {
        symbol,
        interval,
        provider,
        bars: bars.length,
        range: {
            start: new Date(Number(bars[0].time) * 1000).toISOString(),
            end: new Date(Number(bars[bars.length - 1].time) * 1000).toISOString(),
        },
        generatedAt: new Date().toISOString(),
        data: bars.map((bar) => ({
            time: Number(bar.time),
            datetime: new Date(Number(bar.time) * 1000).toISOString(),
            open: Number(bar.open),
            high: Number(bar.high),
            low: Number(bar.low),
            close: Number(bar.close),
            volume: Number(bar.volume ?? 0),
        })),
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload), "utf8");
    return filePath;
}

function readDatasetMeta(filePath: string): DatasetSpec {
    const abs = path.resolve(filePath);
    const raw = JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, unknown>;
    const symbol = String(raw.symbol ?? "").trim().toUpperCase();
    const interval = String(raw.interval ?? "").trim();
    const bars = Number(raw.bars ?? (Array.isArray(raw.data) ? raw.data.length : 0));
    if (!symbol || !interval || !Number.isFinite(bars) || bars <= 0) {
        throw new Error(`Invalid dataset metadata: ${abs}`);
    }
    return { symbol, interval, dataPath: abs, bars };
}

function ensureDatasetFromSqlite(symbol: string, interval: string, outDir: string, minBars: number): string | null {
    const outPath = path.resolve(outDir, `${symbol}-${safeName(interval)}.json`);
    if (fs.existsSync(outPath)) {
        const bars = readDatasetMeta(outPath).bars;
        if (bars >= minBars) return outPath;
    }

    const dbPath = path.resolve("price-data/market-data.sqlite");
    if (!fs.existsSync(dbPath)) return null;

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const rows = db.prepare(
            `SELECT time, open, high, low, close, volume
             FROM candles
             WHERE symbol = ? AND interval = ?
             ORDER BY time ASC`
        ).all(symbol, interval) as Array<Record<string, unknown>>;
        if (!rows || rows.length < minBars) return null;

        const bars: OHLCVData[] = rows.map((row) => ({
            time: Number(row.time) as Time,
            open: Number(row.open),
            high: Number(row.high),
            low: Number(row.low),
            close: Number(row.close),
            volume: Number(row.volume ?? 0),
        }));
        return writeDatasetFile(outPath, symbol, interval, "SQLiteLocal", bars);
    } finally {
        db.close();
    }
}

function ensureDatasetByResample(
    symbol: string,
    targetInterval: string,
    sourcePath: string,
    outDir: string,
    minBars: number
): string | null {
    if (!fs.existsSync(sourcePath)) return null;
    const raw = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    const sourceBars = parseBarsFromRaw(raw);
    if (sourceBars.length === 0) return null;
    const resampled = resampleOHLCV(sourceBars, targetInterval);
    if (resampled.length < minBars) return null;
    const outPath = path.resolve(outDir, `${symbol}-${safeName(targetInterval)}.json`);
    return writeDatasetFile(outPath, symbol, targetInterval, `resample:${path.basename(sourcePath)}`, resampled);
}

async function ensureDatasetFromBinance(
    symbol: string,
    interval: string,
    outDir: string,
    minBars: number
): Promise<string | null> {
    const outPath = path.resolve(outDir, `${symbol}-${safeName(interval)}.json`);
    if (fs.existsSync(outPath)) {
        const bars = readDatasetMeta(outPath).bars;
        if (bars >= minBars) return outPath;
    }

    const targetBars = interval === "15m" ? 8000 : 4000;
    try {
        const bars = await fetchBinanceDataWithLimit(symbol, interval, targetBars, {
            maxRequests: 240,
            requestDelayMs: 80,
        });
        if (!bars || bars.length < minBars) return null;
        return writeDatasetFile(outPath, symbol, interval, "Binance", bars);
    } catch {
        return null;
    }
}

async function resolveDataset(symbol: string, interval: string, generatedDir: string): Promise<DatasetSpec> {
    const directPath = path.resolve(`price-data/robust-lab/${symbol}-${interval}.json`);
    if (fs.existsSync(directPath)) {
        const directMeta = readDatasetMeta(directPath);
        if (directMeta.bars >= 1000) return directMeta;
    }

    const sqlitePath = ensureDatasetFromSqlite(symbol, interval, generatedDir, 1000);
    if (sqlitePath) return readDatasetMeta(sqlitePath);

    if (interval === "4h") {
        const sourceCandidates = [
            path.resolve(`price-data/robust-lab/${symbol}-1h.json`),
            path.resolve(`price-data/robust-lab/${symbol}-2h.json`),
            ensureDatasetFromSqlite(symbol, "1h", generatedDir, 2000),
            ensureDatasetFromSqlite(symbol, "2h", generatedDir, 1000),
        ].filter((v): v is string => Boolean(v));

        for (const sourcePath of sourceCandidates) {
            const resampled = ensureDatasetByResample(symbol, "4h", sourcePath, generatedDir, 1000);
            if (resampled) return readDatasetMeta(resampled);
        }
    }

    const binancePath = await ensureDatasetFromBinance(symbol, interval, generatedDir, 1000);
    if (binancePath) return readDatasetMeta(binancePath);

    throw new Error(`Unable to build dataset for ${symbol} ${interval} (need >=1000 bars).`);
}

function runRobustBatch(configPath: string): void {
    const result = spawnSync(
        "npm",
        ["run", "robust:batch", "--", "--config", configPath],
        {
            stdio: "inherit",
            shell: true,
        }
    );
    if ((result.status ?? 1) !== 0) {
        throw new Error(`robust:batch failed with exit code ${result.status}`);
    }
}

function loadRobustReport(reportPath: string): Map<string, {
    verdict: "GO" | "NO_GO";
    seedPassRate: number | null;
    medianCellPassRate: number | null;
    medianStageCSurvivors: number | null;
}> {
    const map = new Map<string, {
        verdict: "GO" | "NO_GO";
        seedPassRate: number | null;
        medianCellPassRate: number | null;
        medianStageCSurvivors: number | null;
    }>();

    if (!fs.existsSync(reportPath)) return map;

    const raw = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const cells = Array.isArray(raw?.report?.cells) ? raw.report.cells : [];
    for (const cell of cells) {
        if (!isObject(cell)) continue;
        const symbol = String(cell.symbol ?? "").trim().toUpperCase();
        const interval = String(cell.timeframe ?? "").trim();
        const strategyKey = String(cell.strategyKey ?? "").trim();
        const verdict = String(cell.verdict ?? "NO_GO").toUpperCase() === "GO" ? "GO" : "NO_GO";
        if (!symbol || !interval || !strategyKey) continue;
        map.set(`${symbol}|${interval}|${strategyKey}`, {
            verdict,
            seedPassRate: Number.isFinite(Number(cell.seedPassRate)) ? Number(cell.seedPassRate) : null,
            medianCellPassRate: Number.isFinite(Number(cell.medianCellPassRate)) ? Number(cell.medianCellPassRate) : null,
            medianStageCSurvivors: Number.isFinite(Number(cell.medianStageCSurvivors)) ? Number(cell.medianStageCSurvivors) : null,
        });
    }
    return map;
}

function evaluateCombo(report: StressReport): {
    passCount: number;
    fails: Array<"oos70_30" | "walkForward3m1m" | "feeSlippageSensitivity">;
    compositeScore: number;
} {
    const tests: Array<"oos70_30" | "walkForward3m1m" | "feeSlippageSensitivity"> = [
        "oos70_30",
        "walkForward3m1m",
        "feeSlippageSensitivity",
    ];
    const fails = tests.filter((test) => report[test].verdict !== "PASS");
    const passCount = tests.length - fails.length;

    const compositeScore =
        report.oos70_30.blindMedianNetProfitPercent * 0.30 +
        report.walkForward3m1m.combinedOOS.netProfitPercent * 0.30 +
        report.feeSlippageSensitivity.medianNetProfitPercent * 0.40 -
        report.walkForward3m1m.combinedOOS.maxDrawdownPercent * 0.20 -
        report.feeSlippageSensitivity.medianMaxDrawdownPercent * 0.10;

    return { passCount, fails, compositeScore };
}

function classifyFailureMode(result: ComboResult): {
    mode: FailureMode;
    likelyIssue: "entry_logic" | "exit_logic" | "mixed";
    rationale: string;
} {
    const oosNet = result.report.oos70_30.blindMedianNetProfitPercent;
    const oosDd = result.report.oos70_30.blindMedianMaxDrawdownPercent;
    const wfNet = result.report.walkForward3m1m.combinedOOS.netProfitPercent;
    const wfDd = result.report.walkForward3m1m.combinedOOS.maxDrawdownPercent;
    const feeNet = result.report.feeSlippageSensitivity.medianNetProfitPercent;
    const feeDd = result.report.feeSlippageSensitivity.medianMaxDrawdownPercent;

    const worstDd = Math.max(oosDd, wfDd, feeDd);
    if (worstDd >= 35 || (wfDd >= 30 && wfNet < 0)) {
        return {
            mode: "drawdown_shock",
            likelyIssue: "exit_logic",
            rationale: `DD spikes dominate (worst DD=${worstDd.toFixed(2)}%, WF DD=${wfDd.toFixed(2)}%). Losses are concentrated in adverse bursts.`,
        };
    }

    if (feeNet <= 0 && worstDd < 25 && Math.abs(feeNet) <= 8 && Math.abs(oosNet) <= 8) {
        return {
            mode: "slow_bleed_cost_drag",
            likelyIssue: "entry_logic",
            rationale: `Returns decay without catastrophic DD (fee/slip net=${feeNet.toFixed(2)}%, worst DD=${worstDd.toFixed(2)}%). Edge is too weak after costs.`,
        };
    }

    return {
        mode: "mixed_instability",
        likelyIssue: "mixed",
        rationale: `Mixed profile (OOS net=${oosNet.toFixed(2)}%, WF net=${wfNet.toFixed(2)}%, fee/slip net=${feeNet.toFixed(2)}%, worst DD=${worstDd.toFixed(2)}%).`,
    };
}

function recoveryFactor(netProfitPercent: number, maxDrawdownPercent: number): number | null {
    if (!Number.isFinite(netProfitPercent) || !Number.isFinite(maxDrawdownPercent) || maxDrawdownPercent <= 0) {
        return null;
    }
    return netProfitPercent / maxDrawdownPercent;
}

async function main(): Promise<void> {
    const force = process.argv.includes("--force");
    const skipRobust = process.argv.includes("--skip-robust");
    const dateTag = new Date().toISOString().slice(0, 10);
    const runTag = `${dateTag}-btc-sol-15m-4h`;

    const outDir = path.resolve(`batch-runs/strategy-evolution-${runTag}`);
    const stressOutDir = path.join(outDir, "stress-reports");
    const datasetDir = path.resolve(`price-data/robust-lab/generated/strategy-evolution-${runTag}`);
    fs.mkdirSync(stressOutDir, { recursive: true });
    fs.mkdirSync(datasetDir, { recursive: true });

    const datasets: DatasetSpec[] = [];
    for (const symbol of TARGET_SYMBOLS) {
        for (const interval of TARGET_INTERVALS) {
            const dataset = await resolveDataset(symbol, interval, datasetDir);
            datasets.push(dataset);
            console.log(`[dataset] ${dataset.symbol} ${dataset.interval} bars=${dataset.bars} path=${dataset.dataPath}`);
        }
    }

    const strategyKeys = Object.keys(strategies).sort();
    console.log(`[sweep] Datasets=${datasets.length} Strategies=${strategyKeys.length} TotalCombos=${datasets.length * strategyKeys.length}`);

    const robustOutDir = path.resolve(`batch-runs/strategy-evolution-robust-${runTag}`);
    fs.mkdirSync(robustOutDir, { recursive: true });
    const robustConfigPath = path.resolve(`scripts/robust-batch-config.strategy-evolution-${runTag}.json`);
    const robustConfig = {
        strategyKeys: "all",
        seeds: DEFAULT_SEEDS,
        finder: {
            rangePercent: 35,
            maxRuns: 120,
            steps: 3,
            topN: 12,
            minTrades: 40,
        },
        tradeFilterModes: ["none"],
        tradeDirections: ["both"],
        backtestSettings: {
            tradeFilterMode: "none",
            tradeDirection: "both",
            executionModel: "next_open",
            allowSameBarExit: false,
            slippageBps: 5,
        },
        capital: {
            initialCapital: 10000,
            positionSize: 100,
            commission: 0.1,
            sizingMode: "percent",
            fixedTradeAmount: 1000,
        },
        reportPolicy: {
            minSeedRuns: 5,
            minSeedPasses: 3,
            minMedianCellPassRate: 0.01,
            minMedianStageCSurvivors: 2,
            maxMedianDDBreachRate: 0.2,
            maxMedianFoldStabilityPenalty: 1.8,
        },
        output: {
            outDir: robustOutDir,
            filePrefix: "run-seed",
            writePerCellJsonSummary: true,
            writePerCellJsonReport: true,
            writePerCellTableReport: false,
            writeBatchJsonSummary: true,
            writeBatchJsonReport: true,
            writeBatchTableReport: true,
        },
        matrix: datasets.map((dataset) => ({
            label: `${dataset.symbol.toLowerCase()}-${safeName(dataset.interval)}`,
            enabled: true,
            dataPath: dataset.dataPath,
            symbol: dataset.symbol,
            interval: dataset.interval,
        })),
    };
    fs.writeFileSync(robustConfigPath, JSON.stringify(robustConfig, null, 2), "utf8");

    if (!skipRobust) {
        console.log(`[sweep] Running robust batch precheck -> ${robustConfigPath}`);
        runRobustBatch(robustConfigPath);
    } else {
        console.log(`[sweep] Skip robust precheck requested (--skip-robust)`);
    }

    const robustReportPath = path.join(robustOutDir, `batch-go-no-go-${dateTag}.json`);
    const robustMap = loadRobustReport(robustReportPath);

    const results: ComboResult[] = [];
    let completed = 0;
    const total = datasets.length * strategyKeys.length;

    for (const dataset of datasets) {
        const datasetOutDir = path.join(stressOutDir, `${dataset.symbol}-${safeName(dataset.interval)}`);
        fs.mkdirSync(datasetOutDir, { recursive: true });

        for (const strategyKey of strategyKeys) {
            completed += 1;
            const fileName = `${safeName(strategyKey)}.json`;
            const reportPath = path.join(datasetOutDir, fileName);

            let report: StressReport;
            if (!force && fs.existsSync(reportPath)) {
                report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as StressReport;
            } else {
                const tickSize = DEFAULT_TICK_BY_SYMBOL[dataset.symbol] ?? 0.01;
                const outcome = await runStrategyStressTests({
                    dataPath: dataset.dataPath,
                    strategyKey,
                    tickSize,
                    seeds: DEFAULT_SEEDS,
                    finderMaxRuns: 120,
                    walkForwardMaxCombinations: 180,
                    outputDir: datasetOutDir,
                    outputFileName: fileName,
                    quiet: true,
                });
                report = outcome.report;
            }

            const evalResult = evaluateCombo(report);
            const robustKey = `${dataset.symbol}|${dataset.interval}|${strategyKey}`;
            const robustInfo = robustMap.get(robustKey) ?? {
                verdict: "UNKNOWN" as const,
                seedPassRate: null,
                medianCellPassRate: null,
                medianStageCSurvivors: null,
            };

            results.push({
                symbol: dataset.symbol,
                interval: dataset.interval,
                strategyKey,
                reportPath,
                report,
                passCount: evalResult.passCount,
                fails: evalResult.fails,
                compositeScore: evalResult.compositeScore,
                robustPrecheck: robustInfo,
            });

            console.log(`[sweep] ${completed}/${total} ${dataset.symbol} ${dataset.interval} ${strategyKey} -> ${report.overall.verdict} (${evalResult.passCount}/3)`);
        }
    }

    const survivors = results
        .filter((result) => result.passCount === 3)
        .sort((a, b) => b.compositeScore - a.compositeScore);

    const nearMisses = results
        .filter((result) => result.passCount === 2)
        .sort((a, b) => b.compositeScore - a.compositeScore)
        .map((row) => ({
            symbol: row.symbol,
            interval: row.interval,
            strategyKey: row.strategyKey,
            failedTest: row.fails[0],
            passCount: row.passCount,
            compositeScore: row.compositeScore,
            reportPath: row.reportPath,
        }));

    const leaderboard = survivors.map((result, index) => ({
        rank: index + 1,
        symbol: result.symbol,
        interval: result.interval,
        strategyKey: result.strategyKey,
        compositeScore: result.compositeScore,
        robustPrecheck: result.robustPrecheck,
        oos70_30: {
            blindMedianNetProfitPercent: result.report.oos70_30.blindMedianNetProfitPercent,
            blindMedianMaxDrawdownPercent: result.report.oos70_30.blindMedianMaxDrawdownPercent,
        },
        walkForward3m1m: {
            netProfitPercent: result.report.walkForward3m1m.combinedOOS.netProfitPercent,
            maxDrawdownPercent: result.report.walkForward3m1m.combinedOOS.maxDrawdownPercent,
            walkForwardEfficiency: result.report.walkForward3m1m.walkForwardEfficiency,
            parameterStability: result.report.walkForward3m1m.parameterStability,
        },
        feeSlippageSensitivity: {
            seedPassCount: result.report.feeSlippageSensitivity.seedPassCount,
            medianNetProfitPercent: result.report.feeSlippageSensitivity.medianNetProfitPercent,
            medianMaxDrawdownPercent: result.report.feeSlippageSensitivity.medianMaxDrawdownPercent,
        },
        reportPath: result.reportPath,
    }));

    const topRecoveryFactor = results
        .map((row) => {
            const rf = recoveryFactor(
                row.report.feeSlippageSensitivity.medianNetProfitPercent,
                row.report.feeSlippageSensitivity.medianMaxDrawdownPercent
            );
            return {
                symbol: row.symbol,
                interval: row.interval,
                strategyKey: row.strategyKey,
                recoveryFactor: rf,
                passCount: row.passCount,
                oosVerdict: row.report.oos70_30.verdict,
                walkForwardVerdict: row.report.walkForward3m1m.verdict,
                feeSlippageVerdict: row.report.feeSlippageSensitivity.verdict,
                medianNetProfitPercent: row.report.feeSlippageSensitivity.medianNetProfitPercent,
                medianMaxDrawdownPercent: row.report.feeSlippageSensitivity.medianMaxDrawdownPercent,
                reportPath: row.reportPath,
            };
        })
        .filter((row) => row.recoveryFactor !== null)
        .sort((a, b) => Number(b.recoveryFactor) - Number(a.recoveryFactor))
        .slice(0, 5);

    const failureTargets = [
        { symbol: "BTCUSDT", strategyKey: "fib_speed_fan_entry" },
        { symbol: "BTCUSDT", strategyKey: "volatility_compression_trigger" },
        { symbol: "SOLUSDT", strategyKey: "long_short_harvest" },
    ];
    const failureAnalysis: FailureAnalysisItem[] = failureTargets.map((target) => {
        const matches = results.filter((r) => r.symbol === target.symbol && r.strategyKey === target.strategyKey);
        if (matches.length === 0) {
            return {
                ...target,
                available: false,
                note: "No matching result in this sweep.",
            };
        }
        const best = matches.sort((a, b) => b.compositeScore - a.compositeScore)[0];
        const mode = classifyFailureMode(best);
        return {
            ...target,
            available: true,
            chosenInterval: best.interval,
            passCount: best.passCount,
            verdict: best.report.overall.verdict,
            failureMode: mode.mode,
            likelyIssue: mode.likelyIssue,
            rationale: mode.rationale,
            metrics: {
                oosBlindMedianNetProfitPercent: best.report.oos70_30.blindMedianNetProfitPercent,
                oosBlindMedianMaxDrawdownPercent: best.report.oos70_30.blindMedianMaxDrawdownPercent,
                walkForwardNetProfitPercent: best.report.walkForward3m1m.combinedOOS.netProfitPercent,
                walkForwardMaxDrawdownPercent: best.report.walkForward3m1m.combinedOOS.maxDrawdownPercent,
                feeSlippageMedianNetProfitPercent: best.report.feeSlippageSensitivity.medianNetProfitPercent,
                feeSlippageMedianMaxDrawdownPercent: best.report.feeSlippageSensitivity.medianMaxDrawdownPercent,
            },
            reportPath: best.reportPath,
        };
    });

    const summary = {
        generatedAt: new Date().toISOString(),
        runTag,
        seeds: DEFAULT_SEEDS,
        coverage: {
            targetSymbols: TARGET_SYMBOLS,
            targetIntervals: TARGET_INTERVALS,
            datasets: datasets.map((d) => ({ symbol: d.symbol, interval: d.interval, bars: d.bars, dataPath: d.dataPath })),
            strategyCount: strategyKeys.length,
            comboCount: total,
            completedCombos: results.length,
        },
        robustPrecheck: {
            reportPath: robustReportPath,
            goCells: Array.from(robustMap.values()).filter((v) => v.verdict === "GO").length,
            totalCells: robustMap.size,
        },
        survivors: {
            count: leaderboard.length,
            leaderboard,
        },
        nearMisses: {
            count: nearMisses.length,
            items: nearMisses,
        },
        topRecoveryFactor,
        failureAnalysis,
        noSurvivorRecommendation: leaderboard.length === 0
            ? "No Gold-Standard survivors found in BTC/SOL 15m/4h. Next options: widen to 4h-only/15m-only, or evolve strategy logic."
            : null,
    };

    const summaryPath = path.join(outDir, "strategy-evolution-summary.json");
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");

    const txtLines: string[] = [];
    txtLines.push(`Strategy Evolution Sweep - ${new Date().toISOString()}`);
    txtLines.push(`Scope: ${TARGET_SYMBOLS.join(", ")} | ${TARGET_INTERVALS.join(", ")}`);
    txtLines.push(`Combos evaluated: ${results.length}`);
    txtLines.push(`Gold-standard survivors: ${leaderboard.length}`);
    txtLines.push(`Near misses (2/3): ${nearMisses.length}`);
    txtLines.push("");
    txtLines.push("Survivor Leaderboard:");
    if (leaderboard.length === 0) txtLines.push("  none");
    else {
        for (const row of leaderboard) {
            txtLines.push(
                `  #${row.rank} ${row.symbol} ${row.interval} ${row.strategyKey} | score=${row.compositeScore.toFixed(2)} | ` +
                `OOS med=${row.oos70_30.blindMedianNetProfitPercent.toFixed(2)}% DD=${row.oos70_30.blindMedianMaxDrawdownPercent.toFixed(2)}% | ` +
                `WF OOS=${row.walkForward3m1m.netProfitPercent.toFixed(2)}% DD=${row.walkForward3m1m.maxDrawdownPercent.toFixed(2)}% | ` +
                `Fee/Slip med=${row.feeSlippageSensitivity.medianNetProfitPercent.toFixed(2)}%`
            );
        }
    }
    txtLines.push("");
    txtLines.push("Top 5 By Recovery Factor (fee/slippage median):");
    if (topRecoveryFactor.length === 0) txtLines.push("  none");
    else {
        for (let i = 0; i < topRecoveryFactor.length; i++) {
            const row = topRecoveryFactor[i];
            txtLines.push(
                `  #${i + 1} ${row.symbol} ${row.interval} ${row.strategyKey} | RF=${Number(row.recoveryFactor).toFixed(4)} | ` +
                `net=${row.medianNetProfitPercent.toFixed(2)}% dd=${row.medianMaxDrawdownPercent.toFixed(2)}% | pass=${row.passCount}/3`
            );
        }
    }
    txtLines.push("");
    txtLines.push("Failure Analysis:");
    for (const row of failureAnalysis) {
        if (!row.available) {
            txtLines.push(`  ${row.symbol} ${row.strategyKey} | unavailable`);
            continue;
        }
        txtLines.push(
            `  ${row.symbol} ${row.chosenInterval} ${row.strategyKey} | mode=${row.failureMode} | likely=${row.likelyIssue} | ` +
            `oos=${row.metrics.oosBlindMedianNetProfitPercent.toFixed(2)}% dd=${row.metrics.oosBlindMedianMaxDrawdownPercent.toFixed(2)}% | ` +
            `wf=${row.metrics.walkForwardNetProfitPercent.toFixed(2)}% dd=${row.metrics.walkForwardMaxDrawdownPercent.toFixed(2)}% | ` +
            `fee=${row.metrics.feeSlippageMedianNetProfitPercent.toFixed(2)}% dd=${row.metrics.feeSlippageMedianMaxDrawdownPercent.toFixed(2)}%`
        );
    }

    const txtPath = path.join(outDir, "strategy-evolution-summary.txt");
    fs.writeFileSync(txtPath, `${txtLines.join("\n")}\n`, "utf8");

    console.log(`[sweep] Wrote summary: ${summaryPath}`);
    console.log(`[sweep] Wrote text summary: ${txtPath}`);
}

main().catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`strategy-evolution-sweep failed: ${message}`);
    process.exitCode = 1;
});
