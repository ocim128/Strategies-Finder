import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A separate small-heap process makes retention regressions deterministic.
// This represents 600,000 trades / ~2.4 million deltas; retaining the raw
// corpus or JS delta rows cannot fit the 128 MiB heap.
async function main(): Promise<void> {
    const { outputFiles } = await build({
        stdin: {
            resolveDir: process.cwd(),
            contents: `
                import assert from "node:assert/strict";
                import { computeCurrentTopMeanSnapshot } from "./lib/batch-backtest/sp500-top-mean-current-snapshot";
                import { scanArtifacts } from "./lib/batch-backtest/open-score-replay/artifact-scan";
                import { sweepScoreEvents } from "./lib/batch-backtest/open-score-replay/event-sweep";
                import { buildAssetSwitchDecisions } from "./lib/batch-backtest/open-score-replay/candidate-selection";
                import { toBatchSyntheticPairAdapter } from "./lib/batch-backtest/compact-pair-artifact";
                let passes = 0;
                const raw = () => (async function* () {
                    passes += 1;
                    for (let pair = 0; pair < 600; pair += 1) {
                        yield {
                            schema: "compact_pair_artifact.v1", pairIndex: pair,
                            symbol: "A+B", baseAsset: "A", quoteAsset: "B",
                            baseSymbol: "A", quoteSymbol: "B", netProfit: 999,
                            dataEndTime: 100000,
                            trades: Array.from({ length: 1000 }, (_, i) => ({
                                type: "long", entryTime: i * 100 + 1,
                                exitTime: i * 100 + 50, pnl: 1,
                                exitReason: i === 999 ? "end_of_data" : "signal",
                            })),
                        };
                    }
                })();
                (async () => {
                    const snapshot = await computeCurrentTopMeanSnapshot(raw);
                    assert.equal(passes, 3, "snapshot must reopen a stream per pass");
                    assert.equal(snapshot.snapshot.openPositions, 600);
                    assert.equal(snapshot.snapshot.winners[0].asset, "A");
                    const scanned = await scanArtifacts({
                        enableCausalArms: true,
                        artifactLoader: () => (async function* () {
                            for await (const artifact of raw()) yield toBatchSyntheticPairAdapter(artifact);
                        })(),
                        shouldStop: () => false, onPhase: () => {}, capTiltWeight: null,
                        lookupMarketCap: null, capTiltActive: false,
                        sampleFromSec: undefined, sampleToSec: undefined,
                    });
                    assert.equal(scanned.ok, true);
                    const scan = scanned.result;
                    const deltas = scan.streams.reduce((sum, stream) => sum + stream.length, 0);
                    assert.equal(deltas, 600 * 3998);
                    const swept = await sweepScoreEvents({
                        enableCausalArms: true, interval: "1m", mode: "asset_switch",
                        assetNames: scan.assetNames, validDegree: scan.validDegree, pairEndpoints: scan.pairEndpoints,
                        streams: scan.streams, profitableStreams: scan.profitableStreams,
                        pairCount: 600, assetCount: 2,
                        shouldStop: () => false, onPhase: () => {},
                        sampleFromSec: undefined, sampleToSec: undefined,
                    });
                    assert.equal(swept.ok, true);
                    assert.equal(swept.result.events.length, 1000);
                    const last = swept.result.events.at(-1);
                    assert.equal(last.causalScores, undefined);
                    assert.ok(last.causalArms.topCoverage.picks.length <= 5);
                    assert.equal(last.rawScore[0], 600);
                    assert.equal(last.rawScoreProfitNow[0], 600);
                    assert.equal(last.activePairCount[0], 600);
                    const names = Array.from({length: 600}, (_, i) => "ASSET" + i);
                    const snapshots = Array.from({length: 1000}, (_, i) => {
                        const scores = Float64Array.from(names, (_, a) => 600 - a);
                        const counts = new Float64Array(600).fill(1);
                        return { timeSec: i, rawScore: scores, activePairCount: counts, rawScoreProfit: scores,
                            activePairCountProfit: counts, rawScoreProfitNow: scores, activePairCountProfitNow: counts,
                            rawScoreProfitNowConf: scores, activePairCountProfitNowConf: counts };
                    });
                    const selected = await buildAssetSwitchDecisions({ events: snapshots, totalEvents: snapshots.length,
                        assetCount: names.length, assetNames: names, captureRanking: true, onPhase() {},
                        onEventProcessed(index) { snapshots[index] = null; } });
                    assert.equal(selected.ok, true);
                    assert.equal(selected.result.rankingEvents.length, 1000);
                    assert.ok(snapshots.every(row => row === null));
                    for (const event of selected.result.rankingEvents) for (const row of Object.values(event.arms)) {
                        assert.equal(row.picks.length, 5);
                    }
                    console.log("PASS: 600,000 trades under a 128 MiB heap");
                })().catch(error => { console.error(error); process.exitCode = 1; });
            `,
        },
        bundle: true,
        platform: "node",
        format: "cjs",
        write: false,
    });
    const dir = mkdtempSync(join(tmpdir(), "top-mean-memory-"));
    try {
        const script = join(dir, "check.cjs");
        writeFileSync(script, outputFiles![0]!.text);
        const result = spawnSync(process.execPath, ["--max-old-space-size=128", script], {
            encoding: "utf8",
            timeout: 60_000,
            maxBuffer: 2 * 1024 * 1024,
        });
        assert.equal(result.error, undefined, result.error?.message);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /600,000 trades under a 128 MiB heap/);
        console.log(result.stdout.trim());
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
