/**
 * Offline trade-ledger replay checker CLI adapter.
 *
 * Replay, loading, schema, and verdict consumers live in pure/Node leaf
 * modules so the Batch sweep can reuse them without importing this CLI.
 * Compatibility re-exports below preserve the existing script API and tests.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
    loadLedgerForReplay,
    type LoadLedgerOptions,
} from "../lib/batch-backtest/trade-ledger-replay-loader";
import {
    buildCheckerReport,
    type LedgerRule,
} from "../lib/batch-backtest/trade-ledger-replay-core";

export * from "../lib/batch-backtest/trade-ledger-schema";
export * from "../lib/batch-backtest/trade-ledger-replay-loader";
export * from "../lib/batch-backtest/trade-ledger-replay-core";

export interface RunCheckerOptions extends LoadLedgerOptions {}

export async function runChecker(folder: string, ruleFile: string, options: RunCheckerOptions = {}): Promise<string> {
    const loaded = await loadLedgerForReplay(folder, options);
    const resolvedRule = path.resolve(ruleFile);
    if (!existsSync(resolvedRule)) {
        throw new Error(`Rule file not found: ${resolvedRule}`);
    }
    const module = await import(pathToFileURL(resolvedRule).href);
    const rule: unknown = module.default;
    if (typeof rule !== "function") {
        throw new Error(`Rule file must default-export (row) => boolean: ${resolvedRule}`);
    }
    return buildCheckerReport({
        folder,
        ruleName: path.basename(resolvedRule),
        rows: loaded.rows,
        joinedRankCount: loaded.joinedRankCount,
        rule: rule as LedgerRule,
        replay: loaded.replayParams,
        incomplete: loaded.incomplete,
    });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
    const allowIncomplete = argv.includes("--allow-incomplete");
    const positional = argv.filter((arg) => arg !== "--allow-incomplete");
    const [folder, ruleFile] = positional;
    if (!folder || !ruleFile) {
        console.log("Usage: esno scripts/trade-ledger-checker.ts <ledgerFolder> <ruleFile.ts> [--allow-incomplete]");
        console.log("  <ledgerFolder>  per-run folder containing ledger.jsonl (e.g. archive/mining-ledger/2026-08-29_1412_batch-abc)");
        console.log("  <ruleFile.ts>   TS module default-exporting (row) => boolean using only identity/entry/feat_* fields");
        console.log("  --allow-incomplete  proceed on an incomplete ledger (summary certifies failures); the report carries a loud warning banner");
        process.exitCode = 1;
        return;
    }
    try {
        console.log(await runChecker(folder, ruleFile, { allowIncomplete }));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`trade-ledger-checker failed: ${message}`);
        process.exitCode = 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    void main();
}
