/**
 * Offline IBKR CSV aggregator.
 *
 * Reads `price-data/ibkr/csv/{fromInterval}/*.csv`, aggregates each symbol to
 * a coarser `--interval` using the same `aggregateSyntheticBars` the live
 * synthetic pair pipeline uses, and writes the result to
 * `price-data/ibkr/csv/{interval}/*.csv`.
 *
 * Why this exists: for a 4h IBKR synthetic pair, the live loader seeds from
 * 30m (8:1 ratio) and aggregates in-memory every run. With 1000 pairs the
 * 30m intermediates dominate the browser heap and OOM the tab before Mine
 * Timing can even run. Pre-aggregating once offline collapses the per-run
 * 30m footprint entirely — the loader reads the 4h CSV directly.
 *
 * Idempotent: skips a symbol when the destination CSV already has the same
 * bar count and last-bar timestamp. Safe to re-run after syncing new 30m
 * data; only changed symbols get rewritten.
 *
 * The 30m CSVs are NOT deleted — they remain the source of truth for
 * re-aggregation and for any intraday pairs that still need them.
 *
 * Usage:
 *   npm run ibkr:aggregate                                 # 30m -> 4h, all symbols
 *   npm run ibkr:aggregate -- --interval 1h                # 30m -> 1h
 *   npm run ibkr:aggregate -- --symbol AAPL                # single symbol
 *   npm run ibkr:aggregate -- --dry-run                    # plan only, no writes
 *   npm run ibkr:aggregate -- --from 30m --interval 4h     # explicit
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { aggregateSyntheticBars } from "./lib/synthetic-pair";
import {
    getCsvPath,
    parseCsvCandleLines,
    writeCsv,
} from "../lib/ibkr-data/ibkr-data-vite-plugin";
import type { OHLCVData } from "../lib/types/strategies";
import { parseIntervalSeconds } from "../lib/interval-utils";

interface CliOptions {
    fromInterval: string;
    toInterval: string;
    symbol: string | null;
    dryRun: boolean;
    force: boolean;
    help: boolean;
}

const APP_ROOT = process.cwd();
const IBKR_CSV_DIR = resolve(APP_ROOT, "price-data", "ibkr", "csv");
// Shrink-guard thresholds (audit: a truncated 30m source must NOT silently
// overwrite a much larger existing 4h). A write is "refused" when the new
// bar count is below SHRINK_GUARD_RATIO of the existing destination AND the
// existing destination is above SHRINK_GUARD_MIN_EXISTING bars (so a fresh
// write or a tiny destination isn't false-positive-blocked). Override with
// `--force` only when you have confirmed the source genuinely shrank and you
// want the smaller output.
const SHRINK_GUARD_RATIO = 0.5;
const SHRINK_GUARD_MIN_EXISTING = 100;

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run ibkr:aggregate -- [options]",
        "",
        "Options:",
        "  --from <interval>    Source interval to read (default: 30m)",
        "  --interval <interval> Target interval to write (default: 4h)",
        "  --symbol <SYMBOL>    Aggregate only this symbol (optional)",
        "  --dry-run            List planned writes without writing",
        "  --force              Overwrite even when the output would be much smaller",
        "                       than the existing destination (refused by default)",
        "  -h, --help           Show this help",
        "",
        "Examples:",
        "  npm run ibkr:aggregate",
        "  npm run ibkr:aggregate -- --interval 1h",
        "  npm run ibkr:aggregate -- --symbol AAPL --dry-run",
    ].join("\n"));
}

function parseArgs(argv: readonly string[]): CliOptions {
    const options: CliOptions = {
        fromInterval: "30m",
        toInterval: "4h",
        symbol: null,
        dryRun: false,
        force: false,
        help: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i]!;
        switch (arg) {
            case "-h":
            case "--help":
                options.help = true;
                break;
            case "--from":
                options.fromInterval = argv[++i];
                break;
            case "--interval":
                options.toInterval = argv[++i];
                break;
            case "--symbol":
                options.symbol = argv[++i];
                break;
            case "--dry-run":
                options.dryRun = true;
                break;
            case "--force":
                options.force = true;
                break;
            default:
                if (arg.startsWith("--")) {
                    throw new Error(`Unknown option: ${arg}`);
                }
                throw new Error(`Unexpected positional argument: ${arg}`);
        }
    }
    if (!options.fromInterval) throw new Error("--from is required");
    if (!options.toInterval) throw new Error("--interval is required");
    return options;
}

function readCsv(symbol: string, interval: string): OHLCVData[] {
    const filePath = getCsvPath(symbol, interval);
    if (!existsSync(filePath)) return [];
    const lines = readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    return parseCsvCandleLines(lines);
}

function listSymbols(fromInterval: string): string[] {
    const fromDir = resolve(IBKR_CSV_DIR, fromInterval);
    if (!existsSync(fromDir)) return [];
    return readdirSync(fromDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv"))
        .map((entry) => entry.name.replace(/\.csv$/i, ""))
        .sort((a, b) => a.localeCompare(b));
}

function lastBarTimestamp(candles: OHLCVData[]): number | null {
    for (let i = candles.length - 1; i >= 0; i -= 1) {
        const ts = Number(candles[i]!.time);
        if (Number.isFinite(ts)) return ts;
    }
    return null;
}

function shouldSkip(symbol: string, toInterval: string, expected: OHLCVData[]): boolean {
    const existing = readCsv(symbol, toInterval);
    if (existing.length === 0) return false;
    if (existing.length !== expected.length) return false;
    return lastBarTimestamp(existing) === lastBarTimestamp(expected);
}

interface AggregateOutcome {
    symbol: string;
    status: "written" | "skipped" | "empty" | "no-change" | "refused";
    barsIn: number;
    barsOut: number;
    bytesWritten?: number;
    reason?: string;
}

/**
 * Shrink-guard (audit: a truncated 30m source must NOT silently overwrite a
 * much larger existing 4h). Returns true when the write should be REFUSED —
 * the aggregated output is materially smaller than the existing destination.
 * A fresh write (no existing destination) or a tiny destination is never
 * refused; only a clear shrink is. `--force` overrides by skipping this
 * check entirely at the call site.
 *
 * Exported for unit tests.
 */
export function shouldRefuseShrink(symbol: string, toInterval: string, aggregated: readonly OHLCVData[]): { refuse: boolean; existingCount: number } {
    const existing = readCsv(symbol, toInterval);
    if (existing.length === 0) return { refuse: false, existingCount: 0 };
    if (existing.length < SHRINK_GUARD_MIN_EXISTING) return { refuse: false, existingCount: existing.length };
    const ratio = aggregated.length / existing.length;
    return { refuse: ratio < SHRINK_GUARD_RATIO, existingCount: existing.length };
}

function aggregateOne(symbol: string, options: CliOptions): AggregateOutcome {
    const source = readCsv(symbol, options.fromInterval);
    if (source.length === 0) {
        return { symbol, status: "empty", barsIn: 0, barsOut: 0, reason: `no ${options.fromInterval} CSV` };
    }
    const aggregated = aggregateSyntheticBars(source, options.toInterval);
    if (aggregated.length === 0) {
        return { symbol, status: "empty", barsIn: source.length, barsOut: 0, reason: "aggregation produced 0 bars" };
    }
    if (shouldSkip(symbol, options.toInterval, aggregated)) {
        return { symbol, status: "skipped", barsIn: source.length, barsOut: aggregated.length, reason: "destination already matches" };
    }
    // Shrink-guard: refuse to overwrite a much larger destination unless the
    // caller passed `--force`. This is the backstop that catches a truncated
    // 30m source before it destroys the existing 4h history. `--dry-run`
    // still reports the refusal (no write either way).
    if (!options.force) {
        const { refuse, existingCount } = shouldRefuseShrink(symbol, options.toInterval, aggregated);
        if (refuse) {
            return {
                symbol,
                status: "refused",
                barsIn: source.length,
                barsOut: aggregated.length,
                reason: `REFUSED: aggregated ${aggregated.length} bars would overwrite ${existingCount} existing bars (<${Math.round(SHRINK_GUARD_RATIO * 100)}%). The ${options.fromInterval} source likely shrank. Restore ${options.fromInterval}/${symbol}.csv from its .bak, or re-run with --force to overwrite anyway.`,
            };
        }
    }
    if (options.dryRun) {
        return { symbol, status: "no-change", barsIn: source.length, barsOut: aggregated.length };
    }
    const beforeBytes = existsSync(getCsvPath(symbol, options.toInterval))
        ? statSync(getCsvPath(symbol, options.toInterval)).size
        : 0;
    writeCsv(symbol, options.toInterval, aggregated);
    const afterBytes = statSync(getCsvPath(symbol, options.toInterval)).size;
    return {
        symbol,
        status: "written",
        barsIn: source.length,
        barsOut: aggregated.length,
        bytesWritten: afterBytes - beforeBytes,
    };
}

function validateIntervals(fromInterval: string, toInterval: string): void {
    const fromSecs = parseIntervalSeconds(fromInterval);
    const toSecs = parseIntervalSeconds(toInterval);
    if (!fromSecs || fromSecs <= 0) throw new Error(`Invalid --from interval: ${fromInterval}`);
    if (!toSecs || toSecs <= 0) throw new Error(`Invalid --interval: ${toInterval}`);
    if (fromSecs >= toSecs) {
        throw new Error(`--from (${fromInterval}) must be a finer interval than --interval (${toInterval})`);
    }
    if (toSecs % fromSecs !== 0) {
        throw new Error(`--interval (${toInterval}) must be an exact multiple of --from (${fromInterval})`);
    }
}

function main(): void {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printUsage();
        return;
    }
    validateIntervals(options.fromInterval, options.toInterval);

    const symbols = options.symbol ? [options.symbol.toUpperCase()] : listSymbols(options.fromInterval);
    if (symbols.length === 0) {
        console.log(`No CSVs found in price-data/ibkr/csv/${options.fromInterval}/`);
        return;
    }

    console.log(
        `${options.dryRun ? "[dry-run] " : ""}Aggregating ${symbols.length} symbol(s): `
        + `${options.fromInterval} -> ${options.toInterval}`,
    );

    const outcomes: AggregateOutcome[] = [];
    for (const symbol of symbols) {
        const outcome = aggregateOne(symbol, options);
        outcomes.push(outcome);
        const barsInStr = outcome.barsIn.toLocaleString();
        const barsOutStr = outcome.barsOut.toLocaleString();
        switch (outcome.status) {
            case "written":
                console.log(`  ${symbol}: ${barsInStr} -> ${barsOutStr} bars (written)`);
                break;
            case "skipped":
                console.log(`  ${symbol}: skipped (${outcome.reason})`);
                break;
            case "no-change":
                console.log(`  ${symbol}: ${barsInStr} -> ${barsOutStr} bars (dry-run, no write)`);
                break;
            case "refused":
                console.log(`  ${symbol}: ${barsInStr} -> ${barsOutStr} bars (REFUSED — ${outcome.reason})`);
                break;
            case "empty":
                console.log(`  ${symbol}: empty (${outcome.reason})`);
                break;
        }
    }

    const written = outcomes.filter((o) => o.status === "written").length;
    const skipped = outcomes.filter((o) => o.status === "skipped").length;
    const empty = outcomes.filter((o) => o.status === "empty").length;
    const planned = outcomes.filter((o) => o.status === "no-change").length;
    const refused = outcomes.filter((o) => o.status === "refused").length;
    console.log(
        `\nDone: ${written} written, ${skipped} skipped, ${empty} empty, ${planned} planned (dry-run), ${refused} refused.`,
    );
}

// Run only when invoked directly as a CLI, not when imported for tests.
// Compares the entrypoint path against this module's URL using fileURLToPath
// so it works on Windows (where import.meta.url is a file:// URL and
// process.argv[1] is a backslash path).
import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main();
}
