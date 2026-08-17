import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    extractValidTimestampsFromCsvPayload,
    scanDataIntegrity,
    summarizeDataIntegrity,
    type DataIntegrityScan,
} from "../lib/market-data/data-integrity-scan";

const CSV_DIR = resolve(process.cwd(), "price-data", "ibkr", "csv", "30m");

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run data:preflight",
        "  npm run data:preflight -- --json",
        "",
        "Scans local price-data/ibkr/csv/30m/*.csv for deterministic data defects.",
    ].join("\n"));
}

function parseArgs(argv: readonly string[]): { json: boolean; help: boolean } {
    let json = false;
    let help = false;
    for (const arg of argv) {
        if (arg === "--json") json = true;
        else if (arg === "--help" || arg === "-h") help = true;
        else throw new Error(`Unknown option: ${arg}`);
    }
    return { json, help };
}

function listCsvSymbols(): string[] {
    if (!existsSync(CSV_DIR)) return [];
    return readdirSync(CSV_DIR)
        .filter((name) => name.toLowerCase().endsWith(".csv"))
        .map((name) => name.slice(0, -4))
        .sort((left, right) => left.localeCompare(right));
}

function scanAllSymbols(): ReturnType<typeof summarizeDataIntegrity> {
    const symbols = listCsvSymbols();
    if (symbols.length === 0) {
        throw new Error(`No 30m CSV files found in ${CSV_DIR}`);
    }

    const quoteTimestampSets = new Map<string, ReadonlySet<number>>();
    for (const quoteSymbol of ["SPY", "NVDA"]) {
        const path = resolve(CSV_DIR, `${quoteSymbol}.csv`);
        if (!existsSync(path)) continue;
        const payload = readFileSync(path, "utf8");
        quoteTimestampSets.set(quoteSymbol, new Set(extractValidTimestampsFromCsvPayload(payload)));
    }

    const scans: DataIntegrityScan[] = [];
    for (const symbol of symbols) {
        const payload = readFileSync(resolve(CSV_DIR, `${symbol}.csv`), "utf8");
        scans.push(scanDataIntegrity(symbol, payload, { quoteTimestampSets }));
    }
    return summarizeDataIntegrity(scans);
}

function formatLastBar(timestamp: number | null): string {
    return timestamp === null ? "n/a" : new Date(timestamp * 1000).toISOString();
}

function formatAge(ageDays: number | null): string {
    return ageDays === null ? "n/a" : ageDays.toFixed(2);
}

function printTable(summary: ReturnType<typeof summarizeDataIntegrity>): void {
    console.log("SYMBOL | LAST_BAR | AGE_D | BARS | MAX_GAP_BARS | DUPES | JUMPS | DEPTH | VERDICT");
    for (const scan of summary.scans) {
        console.log([
            scan.symbol,
            formatLastBar(scan.lastBarTimestamp),
            formatAge(scan.lastBarAgeDays),
            scan.barCount,
            scan.maxGapBars.toFixed(2),
            scan.duplicateTimestamps,
            scan.splitJumpCandidates,
            scan.historyDepthCohort,
            scan.verdict,
        ].join(" | "));
        for (const issue of [...scan.blockingIssues, ...scan.warnings]) {
            console.log(`DETAIL | symbol=${scan.symbol} | ${issue}`);
        }
    }
    console.log(`PREFLIGHT | verdict=${summary.verdict} | symbols=${summary.symbols} pass=${summary.pass} warn=${summary.warn} block=${summary.block}`);
}

function main(): void {
    try {
        const options = parseArgs(process.argv.slice(2));
        if (options.help) {
            printUsage();
            return;
        }
        const summary = scanAllSymbols();
        if (options.json) console.log(JSON.stringify(summary));
        else printTable(summary);
        process.exitCode = summary.verdict === "BLOCK" ? 1 : 0;
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
    }
}

main();
