import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sweepScoreEvents } from "../lib/batch-backtest/open-score-replay/event-sweep";
import { buildCausalSweepFixture, serializeSweepResult } from "./helpers/causal-sweep-fixture";

/**
 * Pins the causal-arm event sweep against a reference snapshot captured from
 * the pre-optimization implementation (string-comparison graph sorts, cold
 * conjugate-gradient starts, string-keyed TemporalSupport, per-bucket endpoint
 * flatMaps). The optimized sweep — integer name ranks, incremental open-pair
 * edge list, warm-started solver, nested-map vote ledger — must reproduce it
 * byte-for-byte, or the optimization is wrong.
 */
async function main(): Promise<void> {
    const fixture = buildCausalSweepFixture();
    const outcome = await sweepScoreEvents({
        enableCausalArms: true,
        interval: fixture.interval,
        mode: "horizon",
        assetNames: fixture.assetNames,
        validDegree: fixture.validDegree,
        pairEndpoints: fixture.pairEndpoints,
        streams: fixture.streams,
        profitableStreams: fixture.profitableStreams,
        sampleFromSec: undefined,
        sampleToSec: undefined,
        shouldStop: () => false,
        onPhase: () => undefined,
        pairCount: fixture.streams.length,
        assetCount: fixture.assetNames.length,
    });
    assert.equal(outcome.ok, true, "causal sweep must succeed on the fixture");
    const reference = JSON.parse(
        readFileSync(join("tests", "fixtures", "causal-sweep-reference.json"), "utf8"),
    ).result;
    const actual = serializeSweepResult(
        outcome.ok ? outcome.result.events : [],
        outcome.ok ? outcome.result.causalArmDiagnostics : undefined,
    );
    assert.deepEqual(actual, reference, "optimized causal sweep diverged from the pre-optimization reference");
    assert.ok(outcome.ok && outcome.result.events.length > 100, "fixture must produce a meaningful event count");
    console.log(`PASS: sp500-top-mean-causal-sweep.spec.ts (events=${outcome.ok ? outcome.result.events.length : 0})`);
}

main().catch((error) => {
    console.error("FAIL: sp500-top-mean-causal-sweep.spec.ts", error);
    process.exit(1);
});
