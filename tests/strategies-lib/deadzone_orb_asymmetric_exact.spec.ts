import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData } from "../lib/strategies";
import { deadzone_orb_asymmetric_long } from "../lib/strategies/lib/deadzone_orb_asymmetric_long";
import { deadzone_orb_asymmetric_long_exact } from "../lib/strategies/lib/deadzone_orb_asymmetric_long_exact";
import { deadzone_orb_asymmetric_short } from "../lib/strategies/lib/deadzone_orb_asymmetric_short";
import { deadzone_orb_asymmetric_short_exact } from "../lib/strategies/lib/deadzone_orb_asymmetric_short_exact";

function createBars(closes: number[]): OHLCVData[] {
	return closes.map((close, index) => ({
		time: index + 1,
		open: close,
		high: close + 0.5,
		low: close - 0.5,
		close,
		volume: 1_000
	}));
}

describe("deadzone_orb_asymmetric exact wrappers", () => {
	it("keeps the long exact wrapper aligned with the raw long strategy", () => {
		const bars = createBars([100, 100, 100, 100, 100.2, 100.1, 100.4, 100.8, 100.6, 100.9, 100.5, 101.1]);
		const params = {
			deadzoneLookback: 3,
			efficiencyCeiling: 1.1,
			longBreakoutZscore: 1,
			shortBreakoutZscore: 3
		};

		expect(deadzone_orb_asymmetric_long_exact.defaultParams).to.deep.equal(deadzone_orb_asymmetric_long.defaultParams);
		expect(deadzone_orb_asymmetric_long_exact.paramLabels).to.deep.equal(deadzone_orb_asymmetric_long.paramLabels);
		expect(deadzone_orb_asymmetric_long_exact.normalizeParams!(params)).to.deep.equal(
			deadzone_orb_asymmetric_long.normalizeParams!(params)
		);
		expect(deadzone_orb_asymmetric_long_exact.execute(bars, params)).to.deep.equal(
			deadzone_orb_asymmetric_long.execute(bars, params)
		);
		expect(deadzone_orb_asymmetric_long_exact.entryPreview?.(bars, params)).to.deep.equal(
			deadzone_orb_asymmetric_long.entryPreview?.(bars, params)
		);
	});

	it("keeps the short exact wrapper aligned with the raw short strategy", () => {
		const bars = createBars([100, 100, 100, 100, 99.9, 100.05, 99.8, 99.4, 99.6, 99.2, 99.5, 99.1]);
		const params = {
			deadzoneLookback: 3,
			efficiencyCeiling: 1.1,
			longBreakoutZscore: -1,
			shortBreakoutZscore: 0.2
		};

		expect(deadzone_orb_asymmetric_short_exact.defaultParams).to.deep.equal(deadzone_orb_asymmetric_short.defaultParams);
		expect(deadzone_orb_asymmetric_short_exact.paramLabels).to.deep.equal(deadzone_orb_asymmetric_short.paramLabels);
		expect(deadzone_orb_asymmetric_short_exact.normalizeParams!(params)).to.deep.equal(
			deadzone_orb_asymmetric_short.normalizeParams!(params)
		);
		expect(deadzone_orb_asymmetric_short_exact.execute(bars, params)).to.deep.equal(
			deadzone_orb_asymmetric_short.execute(bars, params)
		);
		expect(deadzone_orb_asymmetric_short_exact.entryPreview?.(bars, params)).to.deep.equal(
			deadzone_orb_asymmetric_short.entryPreview?.(bars, params)
		);
	});

	it("exposes a live preview row set for the forming bar", () => {
		const bars = createBars([100, 100, 100, 100, 100.2, 100.1, 100.4, 100.8, 100.6, 100.9, 100.5, 101.1]);
		const params = {
			deadzoneLookback: 3,
			efficiencyCeiling: 1.1,
			longBreakoutZscore: 1,
			shortBreakoutZscore: 3
		};

		const originalNow = Date.now;
		Date.now = () => 13_200;
		try {
			const preview = deadzone_orb_asymmetric_long.entryPreview?.(bars, params);
			expect(preview).to.not.equal(undefined);
			expect(preview?.title).to.equal("Live Signal Preview");
			expect(preview?.status).to.equal("triggered");
			expect(preview?.direction).to.equal("long");
			expect(preview?.summary).to.deep.equal({
				eyebrow: "Forming Bar",
				headline: "Would confirm long now",
				detail: "ER gate is active and z-score is 1.035 on the long side.",
				tone: "positive"
			});
			expect(preview?.rows).to.deep.equal([
				{ section: "Decision", label: "Would confirm", value: "long now" },
				{ section: "Decision", label: "Nearest side", value: "long (-0.035 away)" },
				{ section: "Signal", label: "Close", value: "101.10" },
				{ section: "Signal", label: "Z-score", value: "+1.035" },
				{ section: "Gate", label: "ER gate", value: "0.333 < 1.100 yes" },
				{ section: "Gate", label: "Long", value: "ready (>= 1.000)" },
				{ section: "Gate", label: "Short", value: "4.035 away" },
				{ section: "Timing", label: "Closes in", value: "stale" }
			]);
			expect(preview?.note).to.equal(
				"Latest candle is stale relative to your local clock. Running backtest again does not fetch new candles; use Refresh Data or a live feed to update the forming-bar preview."
			);
		} finally {
			Date.now = originalNow;
		}
	});
});
