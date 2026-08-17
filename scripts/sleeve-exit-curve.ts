import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractCandlesFromCsvPayload } from "../lib/candle-cache";
import {
    aggregateThirtyMinuteToFourHour,
    assessExitQuestion,
    buildExitCurveEntries,
    buildRatioFourHourBars,
    buildSleeveSignalIndices,
    computeSleeveExitCurve,
    EXIT_HORIZONS,
    MIN_SLEEVE_SIGNAL_BARS,
    type ExitCurveHorizon,
    type SleeveExitCurve,
    type SleeveKey,
    type SleeveSeries,
} from "../lib/research/sleeve-exit-curve";

const CSV_DIR = resolve(process.cwd(), "price-data", "ibkr", "csv", "30m");
const SLEEVES: readonly SleeveKey[] = ["eigen", "robustz", "clearanceNVDA", "clearanceFlow2"];

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run analyze:sleeve-exit-curve",
        "",
        "Runs the frozen sleeve signal streams over local IBKR 30m seed CSVs.",
    ].join("\n"));
}

function parseArgs(argv: readonly string[]): { help: boolean } {
    let help = false;
    for (const arg of argv) {
        if (arg === "--help" || arg === "-h") help = true;
        else throw new Error(`Unknown option: ${arg}`);
    }
    return { help };
}

function load30m(symbol: string): ReturnType<typeof extractCandlesFromCsvPayload> {
    const path = resolve(CSV_DIR, `${symbol}.csv`);
    if (!existsSync(path)) return [];
    return extractCandlesFromCsvPayload(readFileSync(path, "utf8"));
}

function buildSleeveEntries(): {
    entries: Record<SleeveKey, ReturnType<typeof buildExitCurveEntries>>;
    series: Record<SleeveKey, SleeveSeries[]>;
    spySeries: ReturnType<typeof aggregateThirtyMinuteToFourHour>;
} {
    if (!existsSync(CSV_DIR)) throw new Error(`Missing data directory: ${CSV_DIR}`);
    const symbols = readdirSync(CSV_DIR)
        .filter((name) => name.toLowerCase().endsWith(".csv"))
        .map((name) => name.slice(0, -4))
        .sort((left, right) => left.localeCompare(right));
    if (symbols.length === 0) throw new Error(`No 30m CSV files found in ${CSV_DIR}`);

    const rawCache = new Map<string, ReturnType<typeof load30m>>();
    const load = (symbol: string) => {
        const cached = rawCache.get(symbol);
        if (cached) return cached;
        const data = load30m(symbol);
        rawCache.set(symbol, data);
        return data;
    };

    const entries = {
        eigen: [],
        robustz: [],
        clearanceNVDA: [],
        clearanceFlow2: [],
    } as Record<SleeveKey, ReturnType<typeof buildExitCurveEntries>>;
    const series = {
        eigen: [],
        robustz: [],
        clearanceNVDA: [],
        clearanceFlow2: [],
    } as Record<SleeveKey, SleeveSeries[]>;
    const nvdaData = load("NVDA");

    for (const symbol of symbols) {
        if (symbol.toUpperCase() === "NVDA") continue;
        const raw = load(symbol);
        if (raw.length === 0) continue;
        const bars = aggregateThirtyMinuteToFourHour(raw);
        if (bars.length < MIN_SLEEVE_SIGNAL_BARS) continue;
        for (const sleeve of ["eigen", "robustz", "clearanceFlow2"] as const) {
            const sleeveEntries = buildExitCurveEntries(symbol, bars, buildSleeveSignalIndices(sleeve, bars));
            if (sleeveEntries.length === 0) continue;
            entries[sleeve].push(...sleeveEntries);
            series[sleeve].push({ symbol, bars });
        }

        const ratioBars = buildRatioFourHourBars(raw, nvdaData);
        if (ratioBars.length < MIN_SLEEVE_SIGNAL_BARS) continue;
        const ratioSymbol = `${symbol}/NVDA`;
        const ratioEntries = buildExitCurveEntries(
            ratioSymbol,
            ratioBars,
            buildSleeveSignalIndices("clearanceNVDA", ratioBars),
        );
        entries.clearanceNVDA.push(...ratioEntries);
        if (ratioEntries.length > 0) series.clearanceNVDA.push({ symbol: ratioSymbol, bars: ratioBars });
    }

    return {
        entries,
        series,
        spySeries: aggregateThirtyMinuteToFourHour(load("SPY")),
    };
}

function formatPercent(value: number | null): string {
    return value === null || !Number.isFinite(value) ? "n/a" : `${(value * 100).toFixed(3)}%`;
}

function formatPp(value: number | null): string {
    return value === null || !Number.isFinite(value) ? "n/a" : `${(value * 100).toFixed(3)}pp`;
}

function printHorizonLine(result: SleeveExitCurve, horizon: ExitCurveHorizon): void {
    const control = result.controls.find((item) => item.horizonBars === horizon.horizonBars);
    console.log([
        "EXIT_CURVE",
        `sleeve=${result.sleeve}`,
        `horizon=${horizon.horizonBars}`,
        `n=${horizon.sampleSize}`,
        `net=${formatPercent(horizon.netReturn)}/t`,
        `MAE=${formatPercent(horizon.mae)}`,
        `MFE=${formatPercent(horizon.mfe)}`,
        `retPerExpBar=${formatPercent(horizon.retPerExposureBar)}/b`,
        `SPYex=${formatPercent(horizon.spyExcess)} (cov ${horizon.spyCoverage.available}/${horizon.spyCoverage.total})`,
        `+blocks=${horizon.positiveBlocks}/${horizon.totalBlocks}`,
    ].join(" | "));
    console.log([
        "CONTROL",
        `sleeve=${result.sleeve}`,
        `horizon=${horizon.horizonBars}`,
        `randomNet=${formatPercent(control?.randomNet ?? null)}/t`,
        `delta=${formatPp(control?.delta ?? null)}`,
    ].join(" | "));
}

function printSummary(result: SleeveExitCurve): void {
    const question = assessExitQuestion(result);
    console.log([
        "SUMMARY",
        `sleeve=${result.sleeve}`,
        `h5Net=${formatPercent(question.fiveBarNet)}`,
        `h12Net=${formatPercent(question.twelveBarNet)}`,
        `retain5of12=${question.retentionRatio === null ? "n/a" : `${(question.retentionRatio * 100).toFixed(1)}%`}`,
        `h5RetPerExp=${formatPercent(question.fiveBarRetPerExposure)}/b`,
        `h12RetPerExp=${formatPercent(question.twelveBarRetPerExposure)}/b`,
        `retPerExpImprove=${question.retPerExposureImprovement === null ? "n/a" : `${(question.retPerExposureImprovement * 100).toFixed(1)}%`}`,
        `improvedBlocks=${question.improvedExposureBlocks === null ? "n/a" : `${question.improvedExposureBlocks}/10`}`,
        `answer=${question.status}`,
    ].join(" | "));
}

function main(): void {
    try {
        const options = parseArgs(process.argv.slice(2));
        if (options.help) {
            printUsage();
            return;
        }
        const { entries, series, spySeries } = buildSleeveEntries();
        console.log(`EXIT_CURVE_ANALYSIS | costs=30bps | horizons=${EXIT_HORIZONS.join(",")}`);
        for (const sleeve of SLEEVES) {
            const result = computeSleeveExitCurve(sleeve, entries[sleeve], series[sleeve], { spySeries });
            for (const horizon of result.horizons) printHorizonLine(result, horizon);
            printSummary(result);
        }
        console.log("NOTE | overlapping signal windows are descriptive; no de-overlap or imputation was applied.");
        process.exitCode = 0;
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
    }
}

main();
