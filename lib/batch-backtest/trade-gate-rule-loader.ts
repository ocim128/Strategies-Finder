import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { TradeGateFeatureRow } from "./trade-ledger-features";

export type TradeGateRulePredicate = (row: TradeGateFeatureRow) => boolean;

export interface TradeGateRuleLoadArgs {
    ruleId: string;
    sourcePath: string;
    source: string;
    sourceHash: string;
}

export interface TradeGateRuleLoaderRun {
    readonly tempDir: string;
    loadRule(args: TradeGateRuleLoadArgs): Promise<TradeGateRulePredicate>;
    dispose(): Promise<void>;
}

type LoadedRuleModule = { default?: unknown };
type EsbuildTransform = (source: string, options: {
    loader: "ts";
    format: "esm";
    sourcefile: string;
    target: "esnext";
    logLevel: "silent";
}) => Promise<{ code: string }>;

const compiledRuleCache = new Map<string, Promise<TradeGateRulePredicate>>();
let transformCount = 0;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function getEsbuildTransform(): Promise<EsbuildTransform> {
    const esbuild = await import("esbuild") as unknown as { transform: EsbuildTransform };
    return esbuild.transform;
}

async function compileAndLoadRule(args: TradeGateRuleLoadArgs, tempDir: string): Promise<TradeGateRulePredicate> {
    const actualHash = createHash("sha256").update(args.source).digest("hex");
    if (actualHash !== args.sourceHash) {
        throw new Error(`Trade Gate rule ${args.ruleId} source hash mismatch before transpile.`);
    }

    let transformed: { code: string };
    try {
        const transform = await getEsbuildTransform();
        transformCount += 1;
        transformed = await transform(args.source, {
            loader: "ts",
            format: "esm",
            sourcefile: args.sourcePath,
            target: "esnext",
            logLevel: "silent",
        });
    } catch (error) {
        throw new Error(`Trade Gate rule ${args.ruleId} failed to transpile ${args.sourcePath}: ${errorMessage(error)}`);
    }

    const compiledPath = join(tempDir, `rule-${args.sourceHash}.mjs`);
    await writeFile(compiledPath, transformed.code, "utf8");
    let loaded: LoadedRuleModule;
    try {
        loaded = await import(pathToFileURL(compiledPath).href) as LoadedRuleModule;
    } catch (error) {
        throw new Error(`Trade Gate rule ${args.ruleId} failed to load transpiled module: ${errorMessage(error)}`);
    }
    if (typeof loaded.default !== "function") {
        throw new Error(`Trade Gate rule ${args.ruleId} must default-export (row) => boolean.`);
    }
    return loaded.default as TradeGateRulePredicate;
}

function loadCompiledRule(args: TradeGateRuleLoadArgs, tempDir: string): Promise<TradeGateRulePredicate> {
    const cached = compiledRuleCache.get(args.sourceHash);
    if (cached) return cached;

    const pending = compileAndLoadRule(args, tempDir);
    compiledRuleCache.set(args.sourceHash, pending);
    void pending.catch(() => {
        if (compiledRuleCache.get(args.sourceHash) === pending) compiledRuleCache.delete(args.sourceHash);
    });
    return pending;
}

export async function createTradeGateRuleLoaderRun(): Promise<TradeGateRuleLoaderRun> {
    const tempDir = await mkdtemp(join(tmpdir(), "strategies-finder-trade-gate-"));
    let disposed = false;
    return {
        tempDir,
        loadRule(args) {
            if (disposed) throw new Error("Trade Gate rule loader run is already disposed.");
            return loadCompiledRule(args, tempDir);
        },
        async dispose() {
            if (disposed) return;
            disposed = true;
            await rm(tempDir, { recursive: true, force: true });
        },
    };
}

/** Test-only observability for the plain-Node loader regression. */
export function getTradeGateRuleLoaderStats(): { transforms: number } {
    return { transforms: transformCount };
}
