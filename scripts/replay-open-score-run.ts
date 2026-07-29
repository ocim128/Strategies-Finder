import {
    iterateRunCompactArtifacts,
    iterateRunRawCompactArtifacts,
    loadManifest,
} from "../lib/batch-backtest/sp500-top-mean-artifact-store";
import {
    runOpenScoreUsdReplay,
    type OpenScoreUsdReplayResult,
} from "../lib/batch-backtest/batch-open-score-usd-replay-engine";
import {
    clearServerBatchDatasetCaches,
    loadServerBatchDataset,
} from "../lib/batch-backtest/server-batch-data-loader";
import type { BatchSyntheticPairArtifact } from "../lib/batch-backtest/batch-synthetic-artifact";

interface CliOptions {
    runId: string;
    horizons: number[];
    sampleFromSec?: number;
    sampleToSec?: number;
    annual: boolean;
    slippageRate: number;
    commissionRate: number;
}

function parseDateSec(value: string, endOfDay: boolean): number {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) {
        throw new Error(`Invalid date: ${value}`);
    }
    return Math.floor(ms / 1000) + (endOfDay ? 24 * 60 * 60 - 1 : 0);
}

function readArg(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseOptions(): CliOptions {
    const runId = readArg("--run-id")?.trim();
    if (!runId) {
        throw new Error("--run-id is required.");
    }

    const horizons = (readArg("--horizons") ?? "48")
        .split(",")
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((value) => Number.isFinite(value) && value > 0);
    if (horizons.length === 0) {
        throw new Error("--horizons must contain at least one positive integer.");
    }

    const from = readArg("--from");
    const to = readArg("--to");
    const slippageBps = Number(readArg("--slippage-bps") ?? "5");
    const commissionPct = Number(readArg("--commission-pct") ?? "0.1");
    if (!Number.isFinite(slippageBps) || slippageBps < 0) {
        throw new Error("--slippage-bps must be a non-negative number.");
    }
    if (!Number.isFinite(commissionPct) || commissionPct < 0) {
        throw new Error("--commission-pct must be a non-negative number.");
    }

    return {
        runId,
        horizons,
        ...(from ? { sampleFromSec: parseDateSec(from, false) } : {}),
        ...(to ? { sampleToSec: parseDateSec(to, true) } : {}),
        annual: process.argv.includes("--annual"),
        slippageRate: slippageBps / 10_000,
        commissionRate: commissionPct / 100,
    };
}

function annualWindows(fromSec: number, toSec: number): Array<{ year: number; fromSec: number; toSec: number }> {
    const firstYear = new Date(fromSec * 1000).getUTCFullYear();
    const lastYear = new Date(toSec * 1000).getUTCFullYear();
    const windows: Array<{ year: number; fromSec: number; toSec: number }> = [];
    for (let year = firstYear; year <= lastYear; year += 1) {
        windows.push({
            year,
            fromSec: Math.max(fromSec, Math.floor(Date.UTC(year, 0, 1) / 1000)),
            toSec: Math.min(toSec, Math.floor(Date.UTC(year + 1, 0, 1) / 1000) - 1),
        });
    }
    return windows;
}

async function collectTargets(runId: string): Promise<Array<{ asset: string; symbol: string }>> {
    const targets = new Map<string, string>();
    for await (const artifact of iterateRunRawCompactArtifacts(runId)) {
        targets.set(artifact.baseAsset, artifact.baseSymbol);
        targets.set(artifact.quoteAsset, artifact.quoteSymbol);
    }
    return Array.from(targets, ([asset, symbol]) => ({ asset, symbol }))
        .sort((a, b) => a.asset.localeCompare(b.asset));
}

async function main(): Promise<void> {
    const options = parseOptions();
    const manifest = loadManifest(options.runId);
    if (!manifest || manifest.status !== "completed") {
        throw new Error(`Completed TOP_MEAN run not found: ${options.runId}`);
    }
    const targets = await collectTargets(options.runId);
    if (targets.length === 0) {
        throw new Error(`Run has no target assets: ${options.runId}`);
    }

    const targetLoader = () => (async function* () {
        for (const target of targets) {
            yield {
                ...target,
                data: await loadServerBatchDataset(target.symbol, manifest.interval),
            };
        }
    })();
    const replay = (
        sampleFromSec: number | undefined,
        sampleToSec: number | undefined,
    ): Promise<OpenScoreUsdReplayResult> => runOpenScoreUsdReplay(
        () => iterateRunCompactArtifacts(options.runId) as unknown as AsyncIterable<BatchSyntheticPairArtifact>,
        targetLoader,
        {
            horizons: options.horizons,
            interval: manifest.interval,
            slippageRate: options.slippageRate,
            commissionRate: options.commissionRate,
            ...(sampleFromSec !== undefined ? { sampleFromSec } : {}),
            ...(sampleToSec !== undefined ? { sampleToSec } : {}),
        },
    );

    try {
        const full = await replay(options.sampleFromSec, options.sampleToSec);
        console.log(full.reportLines.join("\n"));

        if (options.annual) {
            if (options.sampleFromSec === undefined) {
                throw new Error("--annual requires --from.");
            }
            const endSec = options.sampleToSec ?? Math.floor(Date.now() / 1000);
            for (const window of annualWindows(options.sampleFromSec, endSec)) {
                const result = await replay(window.fromSec, window.toSec);
                console.log(`\n================ OPEN_SCORE USD | CALENDAR YEAR ${window.year} ================`);
                console.log(result.reportLines.join("\n"));
            }
        }
    } finally {
        clearServerBatchDatasetCaches();
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
