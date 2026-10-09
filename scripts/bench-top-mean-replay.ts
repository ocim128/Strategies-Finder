/** Read-only replay benchmark over a completed TOP_MEAN run. Never rewrites its artifacts. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { runOpenScoreUsdReplay } from "../lib/batch-backtest/batch-open-score-usd-replay-engine";
import { iterateRunCompactArtifacts, loadManifest } from "../lib/batch-backtest/sp500-top-mean-artifact-store";
import { runParallelArtifactScan } from "../lib/batch-backtest/sp500-top-mean-scan-pool";
import { loadServerBatchDataset } from "../lib/batch-backtest/server-batch-data-loader";
import { selectClosedCandleWindow } from "../lib/alert-evaluation-window";
import { selectTopMeanReplayTargetWindow } from "../lib/batch-backtest/top-mean-target-window";
import type { BatchSyntheticPairArtifact } from "../lib/batch-backtest/batch-synthetic-artifact";
import type { OHLCVData } from "../lib/types/strategies";
import type { OpenScoreUsdSharedArtifactCache, OpenScoreUsdSharedTargetCacheEntry } from "../lib/batch-backtest/open-score-replay/types";

async function main(): Promise<void> {
    const runId = process.argv[process.argv.indexOf("--run-id") + 1];
    assert.ok(process.argv.includes("--run-id") && runId, "--run-id is required");
    const manifest = loadManifest(runId);
    assert.ok(manifest?.status === "completed", "A completed run is required");
    const cutoff = Math.floor(manifest.createdAt / 1000);
    const mode = manifest.replayMode ?? "horizon";
    const rawTargets = new Map<string, Promise<OHLCVData[]>>();
    const sharedArtifactCache: OpenScoreUsdSharedArtifactCache = {};
    const sharedTargetCache = new Map<string, OpenScoreUsdSharedTargetCacheEntry>();
    const artifactLoader = () => iterateRunCompactArtifacts(runId) as AsyncIterable<BatchSyntheticPairArtifact>;
    let targetSymbols: Map<string, string> | undefined;
    const loadTargetDataset = async (asset: string) => {
        if (!targetSymbols) {
            targetSymbols = new Map();
            for await (const artifact of artifactLoader()) {
                if (artifact.baseSymbol) targetSymbols.set(artifact.baseAsset, artifact.baseSymbol);
                if (artifact.quoteAsset && artifact.quoteSymbol) targetSymbols.set(artifact.quoteAsset, artifact.quoteSymbol);
            }
        }
        const symbol = targetSymbols.get(asset);
        if (!symbol) return null;
        let pending = rawTargets.get(symbol);
        if (!pending) {
            pending = loadServerBatchDataset(symbol, manifest.interval);
            rawTargets.set(symbol, pending);
        }
        const candles = await pending;
        return mode === "asset_switch"
            ? selectTopMeanReplayTargetWindow(candles, manifest.interval, cutoff).executionCandles
            : selectClosedCandleWindow(candles, manifest.interval, cutoff, 1)?.candles ?? [];
    };
    const firstYear = process.argv.includes("--year")
        ? Number(process.argv[process.argv.indexOf("--year") + 1])
        : new Date(cutoff * 1000).getUTCFullYear() - 1;
    assert.ok(Number.isInteger(firstYear), "--year must be an integer");
    for (const year of [undefined, firstYear, firstYear + 1]) {
        const startedAt = performance.now();
        const phases: Record<string, number> = {};
        let phase = "initial", phaseStartedAt = startedAt;
        const result = await runOpenScoreUsdReplay(artifactLoader, undefined, {
            mode, interval: manifest.interval, horizons: [12, 24, 48],
            enableCausalArms: true, enableDirectionalArm: true,
            directionalTotalPairs: manifest.pairCount, evaluationCutoffSec: cutoff,
            slippageRate: 0.0005, commissionRate: 0.001,
            independentWindow: year !== undefined,
            ...(year === undefined ? {} : {
                sampleFromSec: Date.UTC(year, 0, 1) / 1000,
                sampleToSec: Date.UTC(year + 1, 0, 1) / 1000 - 1,
            }),
            loadTargetDataset, sharedTargetCache,
            sharedArtifactCache,
            scanOverride: async () => {
                const outcome = await runParallelArtifactScan({ runId, enableCausalArms: true,
                    enableDirectionalArm: mode === "asset_switch", shouldStop: () => false });
                return outcome.status === "ok" ? { ok: true, result: outcome.result } : null;
            },
            onPhase: (next) => {
                if (next === phase) return;
                phases[phase] = (phases[phase] ?? 0) + performance.now() - phaseStartedAt;
                phase = next; phaseStartedAt = performance.now();
            },
        });
        phases[phase] = (phases[phase] ?? 0) + performance.now() - phaseStartedAt;
        const fingerprint = createHash("sha256").update(JSON.stringify({ ...result,
            reportLines: result.reportLines.map((line) => line.replace(/elapsed=[0-9.]+s/g, "elapsed=Xs")),
        })).digest("hex");
        console.log(JSON.stringify({ window: year ?? "full", wallMs: performance.now() - startedAt,
            phases, fingerprint, pairs: result.pairs, events: result.totalEvents }));
    }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
