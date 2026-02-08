import {
	type BacktestSettings,
	type OHLCVData,
	type Signal,
	type Time,
	compareTime,
	runBacktestCompact
} from "../strategies/index";
import { calculateSharpeRatioFromReturns, sanitizeSharpeRatio } from "../strategies/performance-metrics";
import type {
	EndpointSelectionAdjustment,
	FinderDurabilityContext,
	FinderDurabilityMetrics,
	FinderOptions
} from "./types";

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function disabledDurability(): FinderDurabilityMetrics {
	return {
		enabled: false,
		score: 0,
		inSampleNetProfitPercent: 0,
		inSampleProfitFactor: 0,
		outOfSampleNetProfitPercent: 0,
		outOfSampleProfitFactor: 0,
		outOfSampleSharpeRatio: 0,
		outOfSampleMaxDrawdownPercent: 0,
		outOfSampleTrades: 0,
		pass: false
	};
}

function stripSignalBarIndex(signal: Signal): Signal {
	if (signal.barIndex === undefined) return signal;
	const { barIndex: _barIndex, ...withoutBarIndex } = signal;
	return withoutBarIndex;
}

function filterSignalsInRange(signals: Signal[], startTime: Time | null, endTime: Time | null): Signal[] {
	if (startTime === null || endTime === null) return [];
	return signals
		.filter(signal =>
			compareTime(signal.time, startTime) >= 0 &&
			compareTime(signal.time, endTime) <= 0
		)
		// Durability runs each split on sliced data; stale absolute barIndex values can misalign fills.
		.map(stripSignalBarIndex);
}

export function buildSelectionResult(
	raw: EndpointSelectionAdjustment["result"],
	lastDataTime: Time | null,
	initialCapital: number
): EndpointSelectionAdjustment {
	if (lastDataTime === null || raw.trades.length === 0) {
		return { result: raw, adjusted: false, removedTrades: 0 };
	}

	const filteredTrades = raw.trades.filter(trade => compareTime(trade.exitTime, lastDataTime) < 0);
	const removedTrades = raw.trades.length - filteredTrades.length;
	if (removedTrades <= 0) {
		return { result: raw, adjusted: false, removedTrades: 0 };
	}

	const winningTrades = filteredTrades.filter(t => t.pnl > 0);
	const losingTrades = filteredTrades.filter(t => t.pnl <= 0);
	const totalProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
	const totalLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));
	const totalTrades = filteredTrades.length;

	const avgWin = winningTrades.length > 0 ? totalProfit / winningTrades.length : 0;
	const avgLoss = losingTrades.length > 0 ? totalLoss / losingTrades.length : 0;
	const winRate = totalTrades > 0 ? winningTrades.length / totalTrades : 0;
	const lossRate = totalTrades > 0 ? losingTrades.length / totalTrades : 0;
	const netProfit = filteredTrades.reduce((sum, t) => sum + t.pnl, 0);
	const netProfitPercent = initialCapital > 0 ? (netProfit / initialCapital) * 100 : 0;
	const expectancy = (winRate * avgWin) - (lossRate * avgLoss);
	const avgTrade = totalTrades > 0 ? netProfit / totalTrades : 0;
	const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;

	const returns = filteredTrades.map(t => t.pnlPercent);
	const sharpeRatio = calculateSharpeRatioFromReturns(returns);

	return {
		result: {
			...raw,
			trades: filteredTrades,
			netProfit,
			netProfitPercent,
			winRate: winRate * 100,
			expectancy,
			avgTrade,
			profitFactor,
			totalTrades,
			winningTrades: winningTrades.length,
			losingTrades: losingTrades.length,
			avgWin,
			avgLoss,
			sharpeRatio
		},
		adjusted: true,
		removedTrades
	};
}

export function createDurabilityContext(options: FinderOptions, data: OHLCVData[]): FinderDurabilityContext {
	if (!options.durabilityEnabled || data.length < 200 || data.length > 500000) {
		return {
			enabled: false,
			inSampleData: [],
			outOfSampleData: [],
			inSampleStartTime: null,
			inSampleEndTime: null,
			outOfSampleStartTime: null,
			outOfSampleEndTime: null,
			minOOSTrades: options.durabilityMinOOSTrades,
			minScore: options.durabilityMinScore
		};
	}

	const holdoutRatio = Math.max(0.1, Math.min(0.5, options.durabilityHoldoutPercent / 100));
	const minInSampleBars = 120;
	const minOutOfSampleBars = 60;
	const rawSplitIndex = Math.floor(data.length * (1 - holdoutRatio));
	const splitIndex = Math.max(minInSampleBars, Math.min(data.length - minOutOfSampleBars, rawSplitIndex));

	if (splitIndex <= 0 || splitIndex >= data.length - 1) {
		return {
			enabled: false,
			inSampleData: [],
			outOfSampleData: [],
			inSampleStartTime: null,
			inSampleEndTime: null,
			outOfSampleStartTime: null,
			outOfSampleEndTime: null,
			minOOSTrades: options.durabilityMinOOSTrades,
			minScore: options.durabilityMinScore
		};
	}

	const inSampleData = data.slice(0, splitIndex);
	const outOfSampleData = data.slice(splitIndex);
	return {
		enabled: inSampleData.length > 0 && outOfSampleData.length > 0,
		inSampleData,
		outOfSampleData,
		inSampleStartTime: inSampleData[0]?.time ?? null,
		inSampleEndTime: inSampleData[inSampleData.length - 1]?.time ?? null,
		outOfSampleStartTime: outOfSampleData[0]?.time ?? null,
		outOfSampleEndTime: outOfSampleData[outOfSampleData.length - 1]?.time ?? null,
		minOOSTrades: options.durabilityMinOOSTrades,
		minScore: options.durabilityMinScore
	};
}

export function evaluateDurability(
	signals: Signal[],
	backtestSettings: BacktestSettings,
	context: FinderDurabilityContext,
	initialCapital: number,
	positionSize: number,
	commission: number,
	sizingMode: 'percent' | 'fixed',
	fixedTradeAmount: number
): FinderDurabilityMetrics {
	if (!context.enabled) return disabledDurability();

	const inSampleSignals = filterSignalsInRange(signals, context.inSampleStartTime, context.inSampleEndTime);
	const outOfSampleSignals = filterSignalsInRange(signals, context.outOfSampleStartTime, context.outOfSampleEndTime);
	const sizing = { mode: sizingMode, fixedTradeAmount };
	const inSample = runBacktestCompact(
		context.inSampleData,
		inSampleSignals,
		initialCapital,
		positionSize,
		commission,
		backtestSettings,
		sizing
	);
	const outOfSample = runBacktestCompact(
		context.outOfSampleData,
		outOfSampleSignals,
		initialCapital,
		positionSize,
		commission,
		backtestSettings,
		sizing
	);

	const inPf = Number.isFinite(inSample.profitFactor)
		? Math.min(4, Math.max(0, inSample.profitFactor))
		: 4;
	const outPf = Number.isFinite(outOfSample.profitFactor)
		? Math.min(4, Math.max(0, outOfSample.profitFactor))
		: 4;
	const pfScore = clamp((outPf - 0.8) / 1.7, 0, 1);
	const netScore = clamp((outOfSample.netProfitPercent + 2) / 8, 0, 1);
	const ddScore = 1 - clamp(outOfSample.maxDrawdownPercent / 12, 0, 1);
	const oosSharpe = sanitizeSharpeRatio(outOfSample.sharpeRatio);
	const sharpeScore = clamp((oosSharpe + 0.4) / 1.4, 0, 1);
	const consistency = inPf > 0 ? clamp(outPf / Math.max(1, inPf), 0, 1.25) / 1.25 : 0;
	const tradeSufficiency = Math.min(1, outOfSample.totalTrades / Math.max(1, context.minOOSTrades));

	let rawScore = 100 * (
		0.35 * pfScore +
		0.25 * netScore +
		0.15 * ddScore +
		0.15 * consistency +
		0.10 * sharpeScore
	);
	rawScore *= tradeSufficiency;

	if (outOfSample.netProfitPercent <= 0) rawScore *= 0.75;
	if (outPf < 1) rawScore *= 0.75;
	const finalScore = Math.round(clamp(rawScore, 0, 100));
	const pass = (
		outOfSample.totalTrades >= context.minOOSTrades &&
		finalScore >= context.minScore &&
		outOfSample.netProfitPercent >= 0 &&
		outPf >= 1
	);

	return {
		enabled: true,
		score: finalScore,
		inSampleNetProfitPercent: inSample.netProfitPercent,
		inSampleProfitFactor: inPf,
		outOfSampleNetProfitPercent: outOfSample.netProfitPercent,
		outOfSampleProfitFactor: outPf,
		outOfSampleSharpeRatio: oosSharpe,
		outOfSampleMaxDrawdownPercent: outOfSample.maxDrawdownPercent,
		outOfSampleTrades: outOfSample.totalTrades,
		pass
	};
}
