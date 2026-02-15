import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveBacktestSettingsFromRaw } from "../lib/backtest-settings-resolver";
import { trimToClosedCandles } from "../lib/closed-candle-utils";
import { strategies } from "../lib/strategies/library";
import { btc_queen_v1_backtest_overrides } from "../lib/strategies/lib/btc_queen_v1";
import { sol_queen_v1_backtest_overrides } from "../lib/strategies/lib/sol_queen_v1";
import { calculateSharpeRatioFromReturns } from "../lib/strategies/performance-metrics";
import { runBacktest, type OHLCVData, type BacktestResult, type BacktestSettings, type StrategyParams, type Time } from "../lib/strategies";
import { parseTimeToUnixSeconds } from "../lib/time-normalization";

type RawPortfolioConfig = {
    name?: string;
    period?: {
        startDate?: string;
        endDate?: string;
    };
    allocation: {
        totalCapital: number;
        commissionPercent: number;
        positionSizePercent: number;
        slippageBps?: number;
    };
    sleeves: RawSleeveConfig[];
    output?: {
        outDirPrefix?: string;
        fileName?: string;
    };
};

type RawSleeveConfig = {
    id: string;
    strategyKey: string;
    symbol: string;
    interval: string;
    weight: number;
    dataPath: string;
    params?: StrategyParams;
    backtestSettingsOverrides?: Partial<BacktestSettings>;
};

type SleeveRun = {
    id: string;
    strategyKey: string;
    symbol: string;
    interval: string;
    weight: number;
    capital: number;
    bars: number;
    params: StrategyParams;
    backtestSettings: BacktestSettings;
    result: BacktestResult;
    dailyEquity: Map<string, number>;
};

type ParsedDataFile = {
    bars: OHLCVData[];
    symbol: string | null;
    interval: string | null;
};

type CombinedDailyRow = Record<string, string | number>;

const LOCKED_BACKTEST_OVERRIDES: Record<string, Partial<BacktestSettings>> = {
    sol_queen_v1: sol_queen_v1_backtest_overrides,
    btc_queen_v1: btc_queen_v1_backtest_overrides,
};

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBar(row: unknown): OHLCVData | null {
    if (Array.isArray(row)) {
        if (row.length < 5) return null;
        const time = parseTimeToUnixSeconds(row[0]);
        const open = Number(row[1]);
        const high = Number(row[2]);
        const low = Number(row[3]);
        const close = Number(row[4]);
        const volume = row.length > 5 ? Number(row[5]) : 0;
        if (time === null) return null;
        if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return null;
        return { time: time as Time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 };
    }

    if (!isObject(row)) return null;
    const time = parseTimeToUnixSeconds(
        row.time ?? row.t ?? row.timestamp ?? row.date ?? row.datetime ?? row.start ?? row.openTime
    );
    const open = Number(row.open ?? row.o);
    const high = Number(row.high ?? row.h);
    const low = Number(row.low ?? row.l);
    const close = Number(row.close ?? row.c);
    const volume = Number(row.volume ?? row.v ?? 0);
    if (time === null) return null;
    if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return null;
    return { time: time as Time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 };
}

function parseDataFile(raw: unknown): ParsedDataFile {
    let symbol: string | null = null;
    let interval: string | null = null;
    let rows: unknown[] = [];

    if (Array.isArray(raw)) {
        rows = raw;
    } else if (isObject(raw)) {
        if (typeof raw.symbol === "string" && raw.symbol.trim()) symbol = raw.symbol.trim();
        if (typeof raw.interval === "string" && raw.interval.trim()) interval = raw.interval.trim();
        if (Array.isArray(raw.data)) rows = raw.data;
        else if (Array.isArray(raw.ohlcv)) rows = raw.ohlcv;
        else if (Array.isArray(raw.candles)) rows = raw.candles;
    }

    const parsed = rows
        .map((row) => parseBar(row))
        .filter((bar): bar is OHLCVData => Boolean(bar))
        .sort((a, b) => Number(a.time) - Number(b.time));

    const deduped: OHLCVData[] = [];
    for (const bar of parsed) {
        const last = deduped[deduped.length - 1];
        if (last && Number(last.time) === Number(bar.time)) {
            deduped[deduped.length - 1] = bar;
        } else {
            deduped.push(bar);
        }
    }
    return { bars: deduped, symbol, interval };
}

function toDateKey(time: Time): string {
    return new Date(Number(time) * 1000).toISOString().slice(0, 10);
}

function dateToUnixStart(dateStr: string): number {
    const parsed = Date.parse(`${dateStr}T00:00:00Z`);
    if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid period date: ${dateStr}`);
    }
    return Math.floor(parsed / 1000);
}

function dateToUnixEnd(dateStr: string): number {
    return dateToUnixStart(dateStr) + 86399;
}

function filterBarsByPeriod(
    bars: OHLCVData[],
    startDate?: string,
    endDate?: string
): OHLCVData[] {
    const startUnix = startDate ? dateToUnixStart(startDate) : Number.NEGATIVE_INFINITY;
    const endUnix = endDate ? dateToUnixEnd(endDate) : Number.POSITIVE_INFINITY;
    return bars.filter((bar) => {
        const t = Number(bar.time);
        return t >= startUnix && t <= endUnix;
    });
}

function buildDailyEquityMap(
    equityCurve: { time: Time; value: number }[],
    fallbackBars: OHLCVData[],
    initialCapital: number
): Map<string, number> {
    const daily = new Map<string, number>();
    const source = equityCurve.length > 0
        ? equityCurve
        : fallbackBars.map((bar) => ({ time: bar.time, value: initialCapital }));
    for (const point of source) {
        daily.set(toDateKey(point.time), point.value);
    }
    return daily;
}

function dateRange(startDate: string, endDate: string): string[] {
    const out: string[] = [];
    const start = Date.parse(`${startDate}T00:00:00Z`);
    const end = Date.parse(`${endDate}T00:00:00Z`);
    for (let t = start; t <= end; t += 86_400_000) {
        out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
}

function calculateMaxDrawdownPercent(values: number[]): number {
    if (values.length === 0) return 0;
    let peak = values[0];
    let maxDd = 0;
    for (const value of values) {
        if (value > peak) {
            peak = value;
            continue;
        }
        if (peak <= 0) continue;
        const dd = ((peak - value) / peak) * 100;
        if (dd > maxDd) maxDd = dd;
    }
    return maxDd;
}

function parseAndValidateConfig(configPath: string): RawPortfolioConfig {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as RawPortfolioConfig;
    if (!raw || !Array.isArray(raw.sleeves) || raw.sleeves.length === 0) {
        throw new Error("Portfolio config must include at least one sleeve.");
    }
    if (!raw.allocation || !Number.isFinite(Number(raw.allocation.totalCapital)) || Number(raw.allocation.totalCapital) <= 0) {
        throw new Error("allocation.totalCapital must be a positive number.");
    }
    return raw;
}

function inferDefaultDirection(strategyKey: string): BacktestSettings["tradeDirection"] {
    const strategy = strategies[strategyKey];
    const direction = strategy?.metadata?.direction;
    if (direction === "long" || direction === "short") return direction;
    return "both";
}

function buildBacktestSettingsForSleeve(
    sleeve: RawSleeveConfig,
    slippageBps: number
): BacktestSettings {
    const lockedOverrides = LOCKED_BACKTEST_OVERRIDES[sleeve.strategyKey] ?? {};
    const raw: Partial<BacktestSettings> = {
        tradeFilterMode: "none",
        executionModel: "next_open",
        allowSameBarExit: false,
        slippageBps,
        tradeDirection: inferDefaultDirection(sleeve.strategyKey),
        ...lockedOverrides,
        ...(sleeve.backtestSettingsOverrides ?? {}),
    };

    const resolved = resolveBacktestSettingsFromRaw(raw as BacktestSettings, {
        captureSnapshots: false,
        coerceWithoutUiToggles: true,
    });
    resolved.confirmationStrategies = [];
    resolved.confirmationStrategyParams = {};
    return resolved;
}

async function runPortfolio(configPathArg?: string): Promise<void> {
    const configPath = path.resolve(configPathArg ?? "scripts/horizon_portfolio.json");
    const config = parseAndValidateConfig(configPath);

    const totalCapital = Number(config.allocation.totalCapital);
    const commissionPercent = Number(config.allocation.commissionPercent ?? 0.1);
    const positionSizePercent = Number(config.allocation.positionSizePercent ?? 100);
    const slippageBps = Number(config.allocation.slippageBps ?? 1);

    const weightSum = config.sleeves.reduce((sum, sleeve) => sum + Number(sleeve.weight), 0);
    if (!Number.isFinite(weightSum) || weightSum <= 0) {
        throw new Error("Sleeve weights must sum to a positive value.");
    }

    const sleeveRuns: SleeveRun[] = [];
    for (const sleeve of config.sleeves) {
        const strategy = strategies[sleeve.strategyKey];
        if (!strategy) throw new Error(`Unknown strategy key: ${sleeve.strategyKey}`);

        const resolvedDataPath = path.resolve(sleeve.dataPath);
        const rawData = JSON.parse(fs.readFileSync(resolvedDataPath, "utf8"));
        const parsed = parseDataFile(rawData);
        const trimmed = trimToClosedCandles(parsed.bars, sleeve.interval);
        const periodFiltered = filterBarsByPeriod(trimmed, config.period?.startDate, config.period?.endDate);
        if (periodFiltered.length === 0) {
            throw new Error(`No bars left after period filter for ${sleeve.id} (${sleeve.strategyKey}).`);
        }

        const weight = Number(sleeve.weight) / weightSum;
        const sleeveCapital = totalCapital * weight;
        const params: StrategyParams = {
            ...strategy.defaultParams,
            ...(sleeve.params ?? {}),
        };
        const settings = buildBacktestSettingsForSleeve(sleeve, slippageBps);

        const signals = strategy.execute(periodFiltered, params);
        const result = runBacktest(
            periodFiltered,
            signals,
            sleeveCapital,
            positionSizePercent,
            commissionPercent,
            settings,
            {
                mode: "percent",
                fixedTradeAmount: sleeveCapital * 0.1,
            }
        );
        const dailyEquity = buildDailyEquityMap(result.equityCurve, periodFiltered, sleeveCapital);
        sleeveRuns.push({
            id: sleeve.id,
            strategyKey: sleeve.strategyKey,
            symbol: sleeve.symbol,
            interval: sleeve.interval,
            weight,
            capital: sleeveCapital,
            bars: periodFiltered.length,
            params,
            backtestSettings: settings,
            result,
            dailyEquity,
        });
    }

    const firstDates = sleeveRuns
        .map((run) => Array.from(run.dailyEquity.keys())[0])
        .filter((v): v is string => Boolean(v))
        .sort();
    const lastDates = sleeveRuns
        .map((run) => {
            const keys = Array.from(run.dailyEquity.keys());
            return keys[keys.length - 1];
        })
        .filter((v): v is string => Boolean(v))
        .sort();

    if (firstDates.length === 0 || lastDates.length === 0) {
        throw new Error("Unable to build daily equity for portfolio.");
    }

    const rangeStart = config.period?.startDate ?? firstDates[0];
    const rangeEnd = config.period?.endDate ?? lastDates[lastDates.length - 1];
    const days = dateRange(rangeStart, rangeEnd);

    const lastBySleeve = new Map<string, number>();
    for (const run of sleeveRuns) {
        lastBySleeve.set(run.id, run.capital);
    }

    const combinedDailyEquity: CombinedDailyRow[] = [];
    const totalValues: number[] = [];
    for (const day of days) {
        const row: CombinedDailyRow = { date: day };
        let totalEquity = 0;

        for (const run of sleeveRuns) {
            const existing = run.dailyEquity.get(day);
            const value = Number.isFinite(existing as number)
                ? (existing as number)
                : (lastBySleeve.get(run.id) ?? run.capital);
            lastBySleeve.set(run.id, value);
            row[`${run.id}Equity`] = value;
            totalEquity += value;
        }

        row.totalEquity = totalEquity;
        row.totalReturnPercent = ((totalEquity - totalCapital) / totalCapital) * 100;
        combinedDailyEquity.push(row);
        totalValues.push(totalEquity);
    }

    const totalReturnPercent = totalValues.length > 0
        ? ((totalValues[totalValues.length - 1] - totalCapital) / totalCapital) * 100
        : 0;
    const maxDrawdownPercent = calculateMaxDrawdownPercent(totalValues);
    const dailyReturns: number[] = [];
    for (let i = 1; i < totalValues.length; i++) {
        const prev = totalValues[i - 1];
        const curr = totalValues[i];
        if (prev > 0) dailyReturns.push((curr - prev) / prev);
    }
    const sharpeRatio = calculateSharpeRatioFromReturns(dailyReturns);
    const sharpeAnnualizedApprox = sharpeRatio * Math.sqrt(365);

    const missionGate = {
        maxDrawdownPercentLt: 15,
        netProfitPercentGt: 200,
    };
    const missionAccomplished = maxDrawdownPercent < missionGate.maxDrawdownPercentLt && totalReturnPercent > missionGate.netProfitPercentGt;

    const sleevesSummary = Object.fromEntries(
        sleeveRuns.map((run) => {
            const rawWeight = config.sleeves.find((s) => s.id === run.id)?.weight ?? run.weight;
            return [run.id, {
                strategyKey: run.strategyKey,
                symbol: run.symbol,
                interval: run.interval,
                weight: Number(rawWeight),
                normalizedWeight: run.weight,
                capital: run.capital,
                bars: run.bars,
                netProfitPercent: run.result.netProfitPercent,
                maxDrawdownPercent: run.result.maxDrawdownPercent,
                profitFactor: run.result.profitFactor,
                sharpeRatio: run.result.sharpeRatio,
                totalTrades: run.result.totalTrades,
                backtestSettings: run.backtestSettings,
                params: run.params,
            }];
        })
    );

    const outDirPrefix = config.output?.outDirPrefix || "operation-horizon-phase8-portfolio";
    const dateTag = new Date().toISOString().slice(0, 10);
    const outDir = path.resolve(`batch-runs/${outDirPrefix}-${dateTag}`);
    fs.mkdirSync(outDir, { recursive: true });
    const outputFileName = config.output?.fileName || "horizon-portfolio-summary.json";
    const outPath = path.join(outDir, outputFileName);

    const report = {
        generatedAt: new Date().toISOString(),
        configPath,
        portfolioName: config.name ?? "horizon-portfolio",
        period: {
            startDate: rangeStart,
            endDate: rangeEnd,
        },
        allocation: {
            totalCapital,
            commissionPercent,
            positionSizePercent,
            slippageBps,
            sleeveCount: sleeveRuns.length,
            weightSum,
        },
        sleeves: sleevesSummary,
        portfolio: {
            totalReturnPercent,
            netProfitPercent: totalReturnPercent,
            maxDrawdownPercent,
            sharpeRatio,
            sharpeAnnualizedApprox,
            dailyPoints: combinedDailyEquity.length,
            missionGate,
            missionAccomplished,
        },
        combinedDailyEquity,
    };

    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

    const summaryPath = path.join(outDir, "horizon-portfolio-summary.txt");
    const lines: string[] = [];
    lines.push(`Operation Horizon Phase 8 Portfolio (${new Date().toISOString()})`);
    lines.push(`config: ${configPath}`);
    lines.push(`period: ${rangeStart} -> ${rangeEnd}`);
    lines.push(`portfolio return: ${totalReturnPercent.toFixed(2)}%`);
    lines.push(`portfolio max drawdown: ${maxDrawdownPercent.toFixed(2)}%`);
    lines.push(`mission gate: MaxDD < 15% and Net Profit > 200%`);
    lines.push(`mission verdict: ${missionAccomplished ? "MISSION ACCOMPLISHED" : "NOT YET"}`);
    lines.push("");
    for (const run of sleeveRuns) {
        lines.push(
            `${run.id} (${run.strategyKey}) | net=${run.result.netProfitPercent.toFixed(2)}% ` +
            `PF=${run.result.profitFactor.toFixed(2)} DD=${run.result.maxDrawdownPercent.toFixed(2)}% trades=${run.result.totalTrades}`
        );
    }
    fs.writeFileSync(summaryPath, `${lines.join("\n")}\n`, "utf8");

    console.log(`[phase8-portfolio] wrote ${outPath}`);
    console.log(`[phase8-portfolio] wrote ${summaryPath}`);
    console.log(
        `[phase8-portfolio] portfolio net=${totalReturnPercent.toFixed(2)}% ` +
        `maxDD=${maxDrawdownPercent.toFixed(2)}% verdict=${missionAccomplished ? "MISSION ACCOMPLISHED" : "NOT YET"}`
    );
}

const isDirectRun = (() => {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
})();

if (isDirectRun) {
    runPortfolio(process.argv[2]).catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`operation-horizon-phase8-portfolio failed: ${message}`);
        process.exitCode = 1;
    });
}
