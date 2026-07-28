import { expect } from "chai";
import { describe, it } from "node:test";
import { buildRollingAutoCorrelation } from "../lib/strategies/lib/price-action-statistics-core";
import type { OHLCVData, Time } from "../lib/types/strategies";

function legacyRollingAutoCorrelation(values: number[], lookback: number, lag: number): (number | null)[] {
	const result: (number | null)[] = new Array(values.length).fill(null);
	for (let i = lookback - 1 + lag; i < values.length; i++) {
		const x = values.slice(i - lookback + 1 - lag, i + 1 - lag);
		const y = values.slice(i - lookback + 1, i + 1);
		const meanX = x.reduce((sum, value) => sum + value, 0) / lookback;
		const meanY = y.reduce((sum, value) => sum + value, 0) / lookback;
		let covariance = 0;
		let varianceX = 0;
		let varianceY = 0;
		for (let j = 0; j < lookback; j++) {
			const dx = x[j]! - meanX;
			const dy = y[j]! - meanY;
			covariance += dx * dy;
			varianceX += dx * dx;
			varianceY += dy * dy;
		}
		const denominator = Math.sqrt(varianceX * varianceY);
		if (denominator <= 0) continue;
		result[i] = covariance / denominator;
	}
	return result;
}

function buildData(length: number): OHLCVData[] {
	let close = 100;
	return Array.from({ length }, (_value, index) => {
		close += Math.sin(index * 0.19) * 0.7 + (((index * 3571) % 97) - 48) * 0.01;
		return {
			time: (1_700_000_000 + index * 300) as Time,
			open: close - 0.1,
			high: close + 0.8,
			low: close - 0.8,
			close,
			volume: 1000 + ((index * 7919) % 500),
		};
	});
}

describe("Rolling autocorrelation Finder hot path", () => {
	it("matches the prior window-scanning calculation across lookbacks and lags", () => {
		const values = buildData(600).map((bar, index, bars) => index === 0 ? 0 : (bar.close - bars[index - 1]!.close) / bars[index - 1]!.close);
		for (const [lookback, lag] of [[3, 1], [17, 1], [41, 3], [90, 7]] as const) {
			const expected = legacyRollingAutoCorrelation(values, lookback, lag);
			const actual = buildRollingAutoCorrelation(values, lookback, lag);
			for (let index = 0; index < values.length; index++) {
				if (expected[index] === null) {
					expect(actual[index], `lookback=${lookback}, lag=${lag}, index=${index}`).to.equal(null);
				} else {
					expect(actual[index], `lookback=${lookback}, lag=${lag}, index=${index}`).to.be.closeTo(expected[index]!, 1e-10);
				}
			}
		}
	});

	it("recovers after a non-finite value leaves the rolling window", () => {
		const values = Array.from({ length: 80 }, (_value, index) => Math.sin(index * 0.23));
		values[12] = Number.NaN;
		const expected = legacyRollingAutoCorrelation(values, 10, 1);
		const actual = buildRollingAutoCorrelation(values, 10, 1);
		for (let index = 0; index < values.length; index++) {
			if (Number.isNaN(expected[index])) {
				expect(Number.isNaN(actual[index]), `index=${index}`).to.equal(true);
			} else if (expected[index] === null) {
				expect(actual[index], `index=${index}`).to.equal(null);
			} else {
				expect(actual[index], `index=${index}`).to.be.closeTo(expected[index]!, 1e-10);
			}
		}
	});
});
