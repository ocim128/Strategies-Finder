import type { EntryPreview, EntryPreviewRow, OHLCVData, StrategyParams } from "../../types/strategies";
import { parseTimeToUnixSeconds } from "../../time-normalization";
import { ensureCleanData, getCloses } from "../strategy-helpers";
import { buildEfficiencyRatio, buildRateOfChange, buildRollingZScore } from "./price-action-statistics-core";

type DeadzoneOrbAsymmetricPreviewParams = {
	deadzoneLookback: number;
	efficiencyCeiling: number;
	longBreakoutZscore: number;
	shortBreakoutZscore: number;
};

function formatSigned(value: number): string {
	return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

function formatCountdown(secondsRemaining: number | null): string {
	if (secondsRemaining === null) return "n/a";
	if (secondsRemaining <= 0) return "closed";
	const seconds = Math.max(0, Math.round(secondsRemaining));
	const minutes = Math.floor(seconds / 60);
	const secs = seconds % 60;
	return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

function inferIntervalSeconds(data: OHLCVData[]): number | null {
	if (data.length < 2) return null;
	const latest = parseTimeToUnixSeconds(data[data.length - 1]?.time);
	const previous = parseTimeToUnixSeconds(data[data.length - 2]?.time);
	if (latest === null || previous === null) return null;
	const intervalSeconds = latest - previous;
	return intervalSeconds > 0 ? intervalSeconds : null;
}

function resolveSecondsToNextClose(
	latestOpenSec: number | null,
	intervalSeconds: number | null,
	nowSec: number
): { secondsToClose: number | null; stale: boolean } {
	if (latestOpenSec === null || intervalSeconds === null) {
		return { secondsToClose: null, stale: false };
	}

	const baseCloseSec = latestOpenSec + intervalSeconds;
	if (nowSec < baseCloseSec) {
		return {
			secondsToClose: baseCloseSec - nowSec,
			stale: false };
	}

	return {
		secondsToClose: null,
		stale: true };
}

function buildUnavailablePreview(note: string): EntryPreview {
	return {
		mode: 0,
		direction: "none",
		level: 0,
		fanPrice: null,
		lastClose: null,
		distance: null,
		distancePct: null,
		status: "unavailable",
		title: "Live Signal Preview",
		summary: {
			eyebrow: "Forming Bar",
			headline: "Preview unavailable",
			detail: note,
			tone: "neutral" },
		meta: {
			nearestSide: "none",
			secondsToClose: null,
			isClosedBarPreview: false,
			isStaleData: false },
		rows: [],
		note };
}

function formatThresholdState(gap: number, triggerLabel: string): string {
	if (gap <= 0) {
		return `ready (${triggerLabel})`;
	}
	return `${gap.toFixed(3)} away`;
}

export function buildDeadzoneOrbAsymmetricLivePreview(
	data: OHLCVData[],
	params: StrategyParams
): EntryPreview {
	const clean = ensureCleanData(data);
	const p: DeadzoneOrbAsymmetricPreviewParams = {
		deadzoneLookback: Math.max(3, Math.round(params.deadzoneLookback ?? 20)),
		efficiencyCeiling: Number(params.efficiencyCeiling ?? 0.15),
		longBreakoutZscore: Number(params.longBreakoutZscore ?? 2),
		shortBreakoutZscore: Number(params.shortBreakoutZscore ?? 3) };

	// Validate params are finite numbers to prevent downstream NaN propagation
	if (
		!Number.isFinite(p.deadzoneLookback) ||
		!Number.isFinite(p.efficiencyCeiling) ||
		!Number.isFinite(p.longBreakoutZscore) ||
		!Number.isFinite(p.shortBreakoutZscore)
	) {
		return buildUnavailablePreview("Invalid strategy parameters for preview.");
	}

	if (clean.length < p.deadzoneLookback * 2) {
		return buildUnavailablePreview(
			`Need at least ${p.deadzoneLookback * 2} clean candles before the live preview becomes meaningful.`
		);
	}

	const closes = getCloses(clean);
	const efficiencyRatio = buildEfficiencyRatio(clean, p.deadzoneLookback);
	const rateOfChange = buildRateOfChange(closes, 1);
	const cleanRoc = rateOfChange.map((value) => value ?? 0);
	const zscore = buildRollingZScore(cleanRoc, p.deadzoneLookback);
	const latestIndex = clean.length - 1;

	if (latestIndex <= 0) {
		return buildUnavailablePreview("Need at least two candles to evaluate the forming-bar preview.");
	}

	const erValue = efficiencyRatio[latestIndex - 1];
	const zValue = zscore[latestIndex];
	const lastClose = clean[latestIndex]?.close ?? null;

	if (erValue == null || zValue == null || lastClose == null) {
		return buildUnavailablePreview("Rolling ER and z-score are not populated yet for the current forming bar.");
	}

	// Validate numeric values to prevent toFixed() errors on NaN/undefined
	if (!Number.isFinite(erValue) || !Number.isFinite(zValue) || !Number.isFinite(lastClose)) {
		return buildUnavailablePreview("Invalid numeric values in indicator calculations.");
	}

	const deadzoneActive = erValue < p.efficiencyCeiling;
	const longGap = p.longBreakoutZscore - zValue;
	const shortGap = zValue + p.shortBreakoutZscore;
	const longReady = deadzoneActive && longGap <= 0;
	const shortReady = deadzoneActive && shortGap <= 0;
	const direction = longReady ? "long" : shortReady ? "short" : "none";
	const activeThreshold = direction === "short" ? -p.shortBreakoutZscore : p.longBreakoutZscore;
	const nearestSide = Math.abs(longGap) <= Math.abs(shortGap) ? "long" : "short";
	const nearestGap = nearestSide === "long" ? longGap : shortGap;

	// Validate nearestGap is finite before using toFixed
	if (!Number.isFinite(nearestGap)) {
		return buildUnavailablePreview("Invalid gap calculation - check strategy parameters.");
	}

	const latestOpenSec = parseTimeToUnixSeconds(clean[latestIndex]?.time);
	const intervalSeconds = inferIntervalSeconds(clean);
	const countdownWindow = resolveSecondsToNextClose(
		latestOpenSec,
		intervalSeconds,
		Math.floor(Date.now() / 1000)
	);
	const secondsToClose = countdownWindow.secondsToClose;
	const isStaleData = countdownWindow.stale;

	const rows: EntryPreviewRow[] = [
		{ section: "Decision", label: "Would confirm", value: direction === "none" ? "No" : `${direction} now` },
		{ section: "Decision", label: "Nearest side", value: `${nearestSide} (${nearestGap.toFixed(3)} away)` },
		{ section: "Signal", label: "Close", value: lastClose.toFixed(2) },
		{ section: "Signal", label: "Z-score", value: formatSigned(zValue) },
		{ section: "Gate", label: "ER gate", value: `${erValue.toFixed(3)} < ${p.efficiencyCeiling.toFixed(3)}${deadzoneActive ? " yes" : " no"}` },
		{ section: "Gate", label: "Long", value: formatThresholdState(longGap, `>= ${p.longBreakoutZscore.toFixed(3)}`) },
		{ section: "Gate", label: "Short", value: formatThresholdState(shortGap, `<= ${(-p.shortBreakoutZscore).toFixed(3)}`) },
		{ section: "Timing", label: "Closes in", value: isStaleData ? "stale" : formatCountdown(secondsToClose) },
	];

	const summary = deadzoneActive
		? direction === "long"
			? {
				eyebrow: "Forming Bar",
				headline: "Would confirm long now",
				detail: `ER gate is active and z-score is ${Math.abs(zValue).toFixed(3)} on the long side.`,
				tone: "positive" as const }
			: direction === "short"
				? {
					eyebrow: "Forming Bar",
					headline: "Would confirm short now",
					detail: `ER gate is active and z-score is ${Math.abs(zValue).toFixed(3)} on the short side.`,
					tone: "negative" as const }
				: {
					eyebrow: "Forming Bar",
					headline: "No breakout confirm yet",
					detail: `${nearestSide} side is closest with ${Math.abs(nearestGap).toFixed(3)} left before trigger.`,
					tone: "waiting" as const }
		: {
			eyebrow: "Forming Bar",
			headline: "Deadzone gate not active",
			detail: `Efficiency ratio is still above the ${p.efficiencyCeiling.toFixed(3)} ceiling.`,
			tone: "neutral" as const };

	return {
		mode: 0,
		direction,
		level: activeThreshold,
		fanPrice: lastClose,
		lastClose,
		distance: nearestGap,
		distancePct: null,
		status: direction === "none" ? "waiting" : "triggered",
		title: "Live Signal Preview",
		summary,
		meta: {
			longReady,
			shortReady,
			nearestSide,
			deadzoneActive,
			secondsToClose,
			isClosedBarPreview: false,
			isStaleData },
		rows,
		note: isStaleData
			? "Latest candle is stale relative to your local clock. Running backtest again does not fetch new candles; use Refresh Data or a live feed to update the forming-bar preview."
			: deadzoneActive
				? "Preview only. It uses the forming bar and can disappear before the candle closes."
				: "Deadzone gate is not active on the forming bar yet. Wait for ER to compress before trusting the breakout preview." };
}
