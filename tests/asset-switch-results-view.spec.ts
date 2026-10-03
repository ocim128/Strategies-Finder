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
        assert.ok(selectors.includes('topCoverage'));
        assert.ok(!selectors.includes('>topMeanProfit<'));
        assert.ok(!selectors.includes('>topRawProfit<'));
        assert.ok(research.includes('>topMeanProfit<') && research.includes('>topRawProfit<'));
        assert.ok(!research.includes('>topMean<'));
        assert.equal((selectors.match(/<article /g) ?? []).length, 18);
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
        const html = renderAssetSwitchReplay(summary, '<Independent 2025>');
        assert.equal((html.match(/<article /g) ?? []).length, 15);
        assert.ok(html.includes('&lt;Independent 2025&gt;'));
        assert.ok(html.includes('No decision events'));
        assert.ok(html.includes('data-value="">n/a'));
        assert.ok(!html.includes('>topCoverage<'));
    });
});
