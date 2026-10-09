import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareReplayMetricValues, renderAssetSwitchReplay } from "../lib/batch-backtest/browser/asset-switch-results-view";
import { createEmptyAssetSwitchSummary } from "../lib/batch-backtest/open-score-replay/asset-switch";

describe("Asset-switch performance presentation", () => {
    it("sorts numeric performance, including losses and zero, with unavailable values last", () => {
        const values = [null, -20, 2, 100, 0, -3, NaN, Infinity];
        assert.deepEqual([...values].sort((a, b) => compareReplayMetricValues(a, b, false)), [100, 2, 0, -3, -20, null, NaN, Infinity]);
        assert.deepEqual([...values].sort((a, b) => compareReplayMetricValues(a, b, true)), [-20, -3, 0, 2, 100, null, NaN, Infinity]);
        assert.equal(compareReplayMetricValues(2, 2, true), 0);
    });

    it("separates look-ahead arms in both views and preserves position and pending-order context", () => {
        const summary = createEmptyAssetSwitchSummary({ evaluationCutoffSec: 1_700_001_000, enableCausalArms: true });
        summary.arms.topMean.totalNetPnl = 125.5;
        summary.arms.topMean.openPosition = {
            asset: '<CRWD>', entryDecisionTimeSec: 1, entryTimeSec: 2, entryPrice: 100,
            markTimeSec: 3, markPrice: 110, markAgeSec: 0, openNetPnl: 10,
            entryCost: 1, holdingDurationSec: 86_400,
        };
        summary.arms.topMean.pendingOrder = { side: "sell", destinationAsset: '<VEEV>', decisionTimeSec: 3, scheduledTimeSec: null };
        const html = renderAssetSwitchReplay(summary);
        const split = html.indexOf('batch-replay-group--research');
        const selectors = html.slice(0, split);
        const research = html.slice(split);
        assert.ok(selectors.includes('topMean'));
        assert.ok(selectors.includes('topStableSupport'));
        assert.ok(!selectors.includes('>topMeanProfit<'));
        assert.ok(!selectors.includes('>topRawProfit<'));
        assert.ok(research.includes('>topMeanProfit<') && research.includes('>topRawProfit<'));
        assert.ok(!research.includes('>topMean<'));
        assert.equal((selectors.match(/<article /g) ?? []).length, 16);
        assert.equal((research.match(/<article /g) ?? []).length, 2);
        assert.ok(html.includes('data-batch-replay-panel="table" hidden'));
        assert.ok(html.includes('data-batch-replay-panel="cards"'));
        assert.ok(html.includes('+$125.50'));
        assert.ok(html.includes('data-value="125.5"'));
        assert.ok(html.includes('Open: &lt;CRWD&gt;'));
        assert.ok(html.includes('held 1.0 days'));
        assert.ok(html.includes('Pending sell &lt;VEEV&gt; | waiting for target data'));
        assert.ok(html.includes('LOOK-AHEAD RESEARCH'));
    });

    it("supports older results without optional arms and escapes report headings", () => {
        const summary = createEmptyAssetSwitchSummary({ evaluationCutoffSec: 1_700_001_000 });
        delete summary.arms.topRawDirectional;
        const html = renderAssetSwitchReplay(summary, '<Independent 2025>');
        assert.equal((html.match(/<article /g) ?? []).length, 15);
        assert.ok(html.includes('&lt;Independent 2025&gt;'));
        assert.ok(html.includes('No decision events'));
        assert.ok(html.includes('data-value="">n/a'));
        assert.ok(!html.includes('>topStableSupport<'));
    });

    it("shows the directional arm and short holding/pending direction in cards and tables", () => {
        const summary = createEmptyAssetSwitchSummary({ evaluationCutoffSec: 1_700_001_000, directionalTotalPairs: 1_000 });
        summary.arms.topRawDirectional!.openPosition = {
            asset: "NVDA", direction: "short", entryDecisionTimeSec: 1, entryTimeSec: 2, entryPrice: 100,
            markTimeSec: 3, markPrice: 90, markAgeSec: 0, openNetPnl: 100, entryCost: 0, holdingDurationSec: 1,
        };
        summary.arms.topRawDirectional!.pendingOrder = { side: "buy", direction: "long", destinationAsset: "NVDA", decisionTimeSec: 3, scheduledTimeSec: null };
        const html = renderAssetSwitchReplay(summary);
        assert.ok(html.includes('TOP_RAW_DIRECTIONAL'));
        assert.equal((html.match(/Open: NVDA SHORT/g) ?? []).length, 2);
        assert.equal((html.match(/Pending buy NVDA \(LONG\)/g) ?? []).length, 2);
        assert.ok(html.includes('minimum 25%'));
        assert.ok(html.includes('1000 total pairs (long ≥ +250, short ≤ −250)'));
        assert.ok(html.includes('Below minimum closes the position at the next target open'));
        assert.ok(html.includes('Votes start on the third subsequent pair candle'));
        assert.ok(!html.includes('separate long-only position path'));
        delete summary.directionalTotalPairs;
        assert.ok(renderAssetSwitchReplay(summary).includes('Rerun for the 25% threshold'));
        delete summary.directionalBelowMinimumPolicy;
        assert.ok(renderAssetSwitchReplay(summary).includes('Rerun to apply the below-minimum exit rule'));
        delete summary.directionalVoteDelayBars;
        assert.ok(renderAssetSwitchReplay(summary).includes('Rerun to apply third-bar votes'));
    });
});
