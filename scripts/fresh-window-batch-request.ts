import fs from "node:fs";
import { buildFreshFoldScheduleFromDataEnd } from "../lib/finder/finder-asset-opportunity-fold";

/**
 * Operator script for fresh-window research batches. The browser toggle
 * selects the program, but the 25-entry foldSchedule + batchRole travel in
 * the request — this script composes them.
 *
 * Usage:
 *   esno scripts/fresh-window-batch-request.ts \
 *     --config "<path to Copy Configuration JSON>" \
 *     --csv "price-data/ibkr/csv/4h/SPY.csv" \
 *     --role collection \
 *     [--symbols "A•+B•,C•+D•"]         # default: all pairs in the config
 *     [--interval 4h] [--base-url http://127.0.0.1:5173]
 *
 * The config file is the browser's Copy Configuration payload
 * ({ finder, backtestSettings, capitalSettings }). This script ENFORCES the
 * frozen agenda settings (eval 1000, TP2/SL2, long, next_open, minTrades 10,
 * slippage 10bps, commission 0.1) regardless of what the file says, and
 * prints every override it applies. A run of this script is a research batch
 * in the fresh-window namespace — judge only with the S0-first analyzer.
 */

const argv = process.argv.slice(2);
const arg = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
};

const configPath = arg("--config");
const csvPath = arg("--csv") ?? "price-data/ibkr/csv/4h/SPY.csv";
const role = arg("--role") ?? "collection";
const interval = arg("--interval") ?? "4h";
const baseUrl = arg("--base-url") ?? "http://127.0.0.1:5173";
const symbolOverride = arg("--symbols");

if (!configPath) {
    console.error("--config <Copy Configuration JSON path> is required");
    process.exit(1);
}
if (role !== "collection" && role !== "judged" && role !== "replication") {
    console.error(`--role must be collection|judged|replication (got ${role})`);
    process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    finder: Record<string, unknown>;
    backtestSettings: Record<string, unknown>;
    capitalSettings: Record<string, unknown>;
};

// ---- Fold schedule: use the same 25-entry builder as the batch tests and
// server contract. It reserves one forward stride after the final fold.
const BAR_SECONDS: Record<string, number> = { "1m": 60, "5m": 300, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400 };
const barSeconds = BAR_SECONDS[interval] ?? 14400;
const lines = fs.readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
const lastTime = new Date(lines[lines.length - 1]!.split(",")[0]!).getTime();
if (!Number.isFinite(lastTime)) throw new Error(`Could not parse last candle time from ${csvPath}`);
const foldSchedule = buildFreshFoldScheduleFromDataEnd(Math.floor(lastTime / 1000), barSeconds);

// ---- Symbols from the config's universe text (or --symbols override).
const universeText = String(config.finder.universeSymbolsText ?? "");
const symbols = symbolOverride
    ? symbolOverride.split(",").map((s) => s.trim()).filter(Boolean)
    : universeText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
if (symbols.length === 0) throw new Error("No symbols found (check universeSymbolsText or --symbols)");

// ---- Options: translate the Copy Configuration finder section into the
// FinderOptions request shape, then ENFORCE the frozen agenda settings.
const f = config.finder;
const overrides: string[] = [];
const enforce = <T>(label: string, current: unknown, frozen: T): T => {
    if (current !== frozen) overrides.push(`${label}: ${String(current)} -> ${String(frozen)}`);
    return frozen;
};
const horizons = String(f.assetOpportunityOosHorizons ?? "12,18,24")
    .split(",").map((x) => Math.floor(Number(x.trim()))).filter((x) => Number.isFinite(x) && x > 0);
const options = {
    scope: "asset_opportunity",
    mode: "random",
    dataSlice: f.dataSlice ?? "all",
    sortPriority: f.sortPrimary ? [f.sortPrimary, f.sortSecondary].filter(Boolean) : ["netProfit"],
    useAdvancedSort: false,
    topN: 10,
    steps: 3,
    rangePercent: 1,
    maxRuns: 1,
    freezeRiskManagement: true,
    randomizePathExitParams: false,
    exitStrategyOverrideEnabled: false,
    tradeFilterEnabled: true,
    minTrades: 10,
    maxTrades: Number.POSITIVE_INFINITY,
    oosValidationEnabled: false,
    assetOpportunity: {
        symbols,
        candidatePoolSize: f.assetOpportunityCandidatePoolSize ?? 3,
        minFreshSupport: f.assetOpportunityMinFreshSupport ?? 1,
        oosIgnoreLastBars: 26,
        evalLastBars: 1000,
        oosHorizons: horizons,
    },
    researchProgram: "fresh-window",
    foldSchedule,
    batchRole: role,
};

const settings = { ...config.backtestSettings };
settings.tradeDirection = enforce("tradeDirection", settings.tradeDirection, "long");
settings.executionModel = enforce("executionModel", settings.executionModel, "next_open");
settings.takeProfitPercent = enforce("takeProfitPercent", settings.takeProfitPercent, 2);
settings.stopLossPercent = enforce("stopLossPercent", settings.stopLossPercent, 2);
settings.takeProfitMode = enforce("takeProfitMode", settings.takeProfitMode, "fixed");
settings.riskMode = enforce("riskMode", settings.riskMode, "percentage");
settings.takeProfitEnabled = enforce("takeProfitEnabled", settings.takeProfitEnabled, true);
settings.stopLossEnabled = enforce("stopLossEnabled", settings.stopLossEnabled, true);
settings.allowSameBarExit = enforce("allowSameBarExit", settings.allowSameBarExit, false);
settings.invertSignals = enforce("invertSignals", settings.invertSignals, false);
settings.slippageBps = enforce("slippageBps", settings.slippageBps, 10);
settings.disableSignalExits = enforce("disableSignalExits", settings.disableSignalExits, false);

const capitalSettings = { ...config.capitalSettings };
capitalSettings.commission = enforce("commission", capitalSettings.commission, 0.1);
capitalSettings.sizingMode = enforce("sizingMode", capitalSettings.sizingMode, "fixed");

const strategyKeys = (f.currentChartSelectedStrategyKeys as string[] | undefined) ?? [];
const runId = `fresh-${role}-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;

const body = {
    runId,
    interval,
    symbols,
    options,
    settings,
    capitalSettings,
    strategyKeys,
    batch: { startHoldoutBars: 12, endHoldoutBars: 300 },
    researchProgram: "fresh-window",
    foldSchedule,
    batchRole: role,
};

console.log("=== Fresh-window batch request ===");
console.log(`runId: ${runId} | role: ${role} | interval: ${interval}`);
console.log(`symbols: ${symbols.length} | strategies: ${strategyKeys.length}`);
console.log(`foldSchedule: 25 entries, foldEnd ${new Date(foldSchedule[0]!.foldEnd * 1000).toISOString()} .. ${new Date(foldSchedule[24]!.foldEnd * 1000).toISOString()}`);
if (overrides.length > 0) {
    console.log("FROZEN-SETTING OVERRIDES applied to your config:");
    for (const line of overrides) console.log(`  - ${line}`);
} else {
    console.log("config already matched the frozen agenda settings");
}

async function main(): Promise<void> {
const response = await fetch(`${baseUrl}/api/finder/asset-opportunity-batch-run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
});
console.log(`\nHTTP ${response.status} ${response.statusText}`);
if (!response.ok || !response.body) {
    console.log(await response.text());
    process.exit(1);
}
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let events = 0;
for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) {
            events += 1;
            try {
                const event = JSON.parse(line.slice(5)) as { type?: string; error?: string; completedIterations?: number; totalIterations?: number };
                if (event.type === "asset_batch_fatal" || event.error) {
                    console.log(`FATAL: ${event.error ?? JSON.stringify(event).slice(0, 300)}`);
                } else if (event.type === "asset_batch_progress" || event.type === "asset_progress") {
                    if (events % 50 === 0) console.log(`progress: iteration ${event.completedIterations ?? "?"}`);
                } else if (event.type && event.type !== "asset_batch_iteration_done") {
                    console.log(`event: ${event.type}${event.totalIterations !== undefined ? ` (${event.totalIterations} total)` : ""}`);
                }
            } catch { /* partial line */ }
        }
        newline = buffer.indexOf("\n");
    }
}
console.log(`\nstream closed after ${events} events.`);
console.log(`Artifacts should be in: archive/fresh-window/`);
console.log(`Judge with: esno scripts/analyze-fresh-window-research.ts --archive-dir "archive/fresh-window" --stride-bars 12 --horizon 12 --seed 42`);
}

void main();
