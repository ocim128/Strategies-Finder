/**
 * TOP_MEAN results presentation: the Phase-1 current-snapshot banner, the
 * Latest OPEN_SCORE Selector Picks card (one arm at a time), display-side
 * tie-break resolution, and the clipboard text builders that mirror the UI.
 *
 * Rendering is stateless: the caller (run owner) supplies the selected arm
 * and the tie-break mode; no lifecycle state lives here.
 */
import type {
    OpenScoreUsdLatestSelection,
    OpenScoreUsdLatestSelections,
    OpenScoreUsdLatestSelectorName,
    ReplayComparison,
} from "../open-score-replay/types";
import type { TopMeanCurrentSnapshot } from "../sp500-top-mean-stream-types";
import type { TopMeanResultSummary } from "../sp500-top-mean-coordinator-engine";
import { formatTopMeanPerformanceLines } from "../sp500-top-mean-performance";
import { escapeHtml } from "../../html-escape";
import { hasAssetSwitchDecisionEvents, REPLAY_ARM_FIELDS } from "../open-score-replay/arm-contract";

/**
 * The Latest OPEN_SCORE card's arm picker is GENERATED inside the card (it is
 * not a structural id): the card re-renders on every run/restore, so change
 * events are delegated to the persistent results container (see the service's
 * bindEvents).
 */
export const LATEST_ARM_SELECTOR_ID = "batchBacktestSp500TopMeanLatestArmSelector";
export const LATEST_ARM_SELECTOR_NAMES: readonly OpenScoreUsdLatestSelectorName[] = [
    "TOP_MEAN",
    "TOP_RAW",
    "TOP_MEAN_RAW_UNIQUE",
    "TOP_RAW_PROFIT_NOW",
    "TOP_MEAN_PROFIT_NOW",
    "TOP_RAW_PROFIT_NOW_CONF",
    "TOP_Z",
    "BOT_RAW",
    "BOT_MEAN",
    "BOT_MEAN_RAW_UNIQUE",
    "BOT_RAW_PROFIT_NOW",
    "BOT_MEAN_PROFIT_NOW",
    "BOT_Z",
];

export function normalizeLatestArm(value: string | null | undefined): OpenScoreUsdLatestSelectorName {
    return LATEST_ARM_SELECTOR_NAMES.includes(value as OpenScoreUsdLatestSelectorName)
        ? value as OpenScoreUsdLatestSelectorName
        : "TOP_MEAN";
}

/** TOP_MEAN tie-break display mode shared by the banner and the picks card. */
export type TopMeanTieBreakMode = "off" | "alpha" | "random";

export function formatTopMeanCompletionMessage(summary: {
    archiveComplete?: boolean;
    archiveRequested?: boolean;
    archiveDir?: string;
    archiveError?: string;
}): string {
    const prefix = "TOP_MEAN run completed successfully.";
    if (summary.archiveRequested === false) {
        return `${prefix} Archive not saved (toggle off).`;
    }
    if (summary.archiveError) {
        return `${prefix} Archive save failed: ${summary.archiveError}.`;
    }
    if (summary.archiveComplete === true) {
        return summary.archiveDir
            ? `${prefix} Archive saved: ${summary.archiveDir}.`
            : `${prefix} Archive saved.`;
    }
    return `${prefix} Archive not saved (disabled by TOP_MEAN_ARCHIVE_LOG_DIR).`;
}

export function mergeTopMeanArchiveStatus(
    result: TopMeanResultSummary,
    status: {
        archiveComplete?: boolean;
        archiveRequested?: boolean;
        archiveDir?: string;
        archiveError?: string;
    },
): TopMeanResultSummary {
    return {
        ...result,
        ...(status.archiveComplete !== undefined ? { archiveComplete: status.archiveComplete } : {}),
        ...(status.archiveRequested !== undefined ? { archiveRequested: status.archiveRequested } : {}),
        ...(status.archiveDir !== undefined ? { archiveDir: status.archiveDir } : {}),
        ...(status.archiveError !== undefined ? { archiveError: status.archiveError } : {}),
    };
}

export function pickTieBreakAsset(assets: readonly string[], mode: "alpha" | "random", seed: number): string | null {
    if (assets.length === 0) return null;
    const sorted = [...assets].sort((a, b) => a.localeCompare(b));
    if (mode === "alpha") return sorted[0]!;
    // Seeded murmur-style finalizer over the seed (decision time), so the
    // pick is uniform across the tied set yet deterministic per event.
    let x = (seed ^ 0x9e3779b9) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 2246822507) >>> 0;
    x = Math.imul(x ^ (x >>> 13), 3266489909) >>> 0;
    x = (x ^ (x >>> 16)) >>> 0;
    return sorted[x % sorted.length]!;
}

/** Resolve `reason: "tied"` rows of the latest OPEN_SCORE picks per mode. */
export function applyTieBreakToLatest(
    latest: OpenScoreUsdLatestSelections,
    mode: TopMeanTieBreakMode,
): OpenScoreUsdLatestSelections {
    if (mode === "off") return latest;
    return {
        ...latest,
        selections: latest.selections.map((selection) => {
            if (selection.reason !== "tied" || selection.tiedAssets.length === 0) return selection;
            const picked = pickTieBreakAsset(selection.tiedAssets, mode, latest.decisionTime);
            if (picked === null) return selection;
            // Per-tied-asset score/mean are not in the tie row, so they
            // stay null (rendered as n/a) — the pick is the decision.
            return { ...selection, asset: picked, reason: "selected" as const };
        }),
    };
}

export function topMeanTieBreakNote(mode: TopMeanTieBreakMode): string {
    return mode === "alpha"
        ? "Tie-break ALPHABETICAL applied: tied picks resolved to the alphabetically-first tied asset."
        : mode === "random"
            ? "Tie-break RANDOM applied: tied picks resolved to a seeded random tied asset (stable per decision event)."
            : "Tie-break off: ties stay unresolved (TIE / SKIP).";
}

/**
 * When the current snapshot's top is tied and the mode resolves ties,
 * return the one picked winner asset (seeded per decisionTime), else null.
 */
export function tieBreakPickedAsset(currentSnapshot: TopMeanCurrentSnapshot, mode: TopMeanTieBreakMode): string | null {
    if (mode === "off") return null;
    const snap: any = currentSnapshot.snapshot;
    const winners: any[] = Array.isArray(snap?.winners) ? snap.winners : [];
    if (winners.length < 2) return null;
    const assets = winners.map((w) => String(w.asset ?? "")).filter((a) => a !== "");
    const seed = currentSnapshot.decision?.decisionTime ?? snap?.asOf ?? 0;
    return pickTieBreakAsset(assets, mode, seed);
}

/** Snapshot winners restricted to the tie-break pick (all of them when null). */
export function winnersAfterTieBreak(currentSnapshot: TopMeanCurrentSnapshot, picked: string | null): any[] {
    const snap: any = currentSnapshot.snapshot;
    const winners: any[] = Array.isArray(snap?.winners) ? snap.winners : [];
    if (picked === null) return winners;
    return winners.filter((w) => String(w.asset ?? "") === picked);
}

/**
 * A tied snapshot decision (reason "tied", asset null) resolves to the
 * tie-break pick. The entry-window rule is re-checked for the picked
 * asset: LONG only when the latest reconstructed decision event is not
 * older than the common closed candle, mirroring the reducer.
 */
export function resolveTiedDecision(
    decision: TopMeanCurrentSnapshot["decision"],
    picked: string | null,
    asOfSec: number | null,
): TopMeanCurrentSnapshot["decision"] {
    if (!decision || decision.reason !== "tied" || picked === null) return decision;
    const entryWindowOpen = asOfSec !== null && decision.decisionTime !== null && decision.decisionTime >= asOfSec;
    return {
        ...decision,
        status: entryWindowOpen ? "LONG_NEXT_BAR" : "NO_TRADE",
        reason: entryWindowOpen ? "latest_decision_event" : "entry_window_expired",
        asset: picked,
    };
}

function latestSelectionText(selection: OpenScoreUsdLatestSelection): string {
    return selection.reason === "selected"
        ? selection.asset ?? "NO SELECTION"
        : selection.reason === "tied"
            ? `TIE / SKIP: ${selection.tiedAssets.join(", ")}`
            : "NO SELECTION";
}

function formatLatestMean(mean: number | null): string {
    return mean === null ? "--" : `${mean >= 0 ? "+" : ""}${mean.toFixed(3)}`;
}

function formatLatestScore(score: number | null): string {
    return score === null ? "--" : `${score >= 0 ? "+" : ""}${score}`;
}

export function renderLatestOpenScoreSelections(
    summary: TopMeanResultSummary,
    latestArm: OpenScoreUsdLatestSelectorName,
    mode: TopMeanTieBreakMode,
): string {
    const latestInput = summary.latestSelections;
    if (!latestInput) return "";
    const latest = applyTieBreakToLatest(latestInput, mode);
    const decisionLabel = new Date(latest.decisionTime * 1000)
        .toISOString()
        .slice(0, 19)
        .replace("T", " ") + " UTC";
    // One arm at a time: every arm in one card was unusably long on large
    // universes. The arm comes from the in-card dropdown; the full list
    // stays available via Copy Result.
    const selection = latest.selections.find((entry) => entry.selector === latestArm)
        ?? latest.selections[0];
    let html = `<div class="batch-report-card">`;
    html += `<div class="batch-report-title">Latest OPEN_SCORE Selector Picks</div>`;
    html += `<div class="batch-report-note">decision event: ${escapeHtml(decisionLabel)}</div>`;
    html += renderLatestArmSelector(latestArm);
    if (selection) {
        html += `<table class="finder-table batch-report-table"><thead><tr><th>Selector</th><th>Direction</th><th>Selection</th><th>Mean</th><th>Score</th><th>Active Pairs</th><th>Pool</th></tr></thead><tbody>`;
        html += `<tr><td><strong>${escapeHtml(selection.selector)}</strong></td><td class="${selection.reason === "selected" && selection.direction === "long" ? "is-positive" : selection.reason === "selected" && selection.direction === "short" ? "is-negative" : ""}"><strong>${escapeHtml(selection.direction.toUpperCase())}</strong></td><td>${escapeHtml(latestSelectionText(selection))}</td><td>${escapeHtml(formatLatestMean(selection.mean))}</td><td>${escapeHtml(formatLatestScore(selection.score))}</td><td>${escapeHtml(selection.activePairs ?? "--")}</td><td>${escapeHtml(selection.eligibleCandidates)}</td></tr>`;
        html += `</tbody></table>`;
        html += renderLatestOpenScoreTopCandidates(selection);
        html += renderLatestArmYearPerformance(summary, selection.selector);
    } else {
        html += `<div class="batch-report-note">No selector arms in this result.</div>`;
    }
    html += `<div class="batch-report-note batch-report-note--after">${escapeHtml(topMeanTieBreakNote(mode))} Research selectors only.</div>`;
    html += `</div>`;
    return html;
}

/**
 * Generated (non-structural) arm picker inside the Latest OPEN_SCORE
 * card. Change events are delegated to the results container in the
 * service's bindEvents because re-rendering the card replaces this element.
 */
function renderLatestArmSelector(latestArm: OpenScoreUsdLatestSelectorName): string {
    const options = LATEST_ARM_SELECTOR_NAMES
        .map((name) => `<option value="${name}"${name === latestArm ? " selected" : ""}>${name}</option>`)
        .join("");
    return `<div class="batch-field batch-field--inline"><label class="batch-field-label" for="${LATEST_ARM_SELECTOR_ID}">Selector arm</label><select class="param-input batch-open-score-details-selector" id="${LATEST_ARM_SELECTOR_ID}" title="Pick which selector arm this card shows, including its top 3 ranked candidates at the decision event. The full arm list stays available via Copy Result.">${options}</select></div>`;
}

/**
 * Ranked candidate detail for the latest event, capped at 3 by the
 * engine. The current pick (including a tie-break resolution) is badged.
 * Results produced before topCandidates existed render the fallback note.
 */
function renderLatestOpenScoreTopCandidates(selection: OpenScoreUsdLatestSelection): string {
    // The engine caps at 3; slice again so hand-built or future payloads
    // cannot grow the card.
    const candidates = (Array.isArray(selection.topCandidates) ? selection.topCandidates : []).slice(0, 3);
    if (candidates.length === 0) {
        return `<div class="batch-report-note">Top-candidate detail is unavailable for this result (produced by an older run).</div>`;
    }
    let html = `<div class="batch-report-subheading">Top ${candidates.length} candidates at this event | ranked by ${escapeHtml(selection.selector)}</div>`;
    html += `<table class="finder-table batch-report-table"><thead><tr><th>Rank</th><th>Asset</th><th>Score</th><th>Mean</th><th>Active Pairs</th></tr></thead><tbody>`;
    candidates.forEach((candidate, index) => {
        const isPick = selection.asset !== null && candidate.asset === selection.asset;
        html += `<tr${isPick ? ` class="batch-report-row-top"` : ""}>`;
        html += `<td>${index + 1}</td>`;
        html += `<td><strong>${escapeHtml(candidate.asset)}</strong>${isPick ? `<span class="batch-top-badge">PICK</span>` : ""}</td>`;
        html += `<td>${escapeHtml(formatLatestScore(candidate.score))}</td>`;
        html += `<td>${escapeHtml(formatLatestMean(candidate.mean))}</td>`;
        html += `<td>${escapeHtml(candidate.activePairs)}</td>`;
        html += `</tr>`;
    });
    html += `</tbody></table>`;
    return html;
}

/** One report line in the shared OPEN_SCORE comparison format. */
export function formatReplayComparisonLine(comparison: ReplayComparison): string {
    const pct = (value: number | null): string =>
        value === null ? "n/a" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
    return `n=${comparison.events}`
        + ` top=${pct(comparison.topMean)}`
        + ` rand=${pct(comparison.randomMean)}`
        + ` deltaMed=${pct(comparison.delta)}`
        + ` CI95=[${pct(comparison.ciLower)},${pct(comparison.ciUpper)}]`
        + ` +blocks=${comparison.positiveBlocks}/${comparison.totalBlocks}`;
}

/**
 * Per-year performance lines for the selected arm, in the same
 * comparison format as the OPEN_SCORE report. "full" comes from the
 * full-window horizons; the year lines from the coordinator's calendar-
 * year replays (annualReports). Results produced before latestArms
 * existed render nothing here.
 */
function renderLatestArmYearPerformance(
    summary: TopMeanResultSummary,
    arm: OpenScoreUsdLatestSelectorName,
): string {
    const blocks: string[] = [];
    for (const horizon of summary.horizons ?? []) {
        const lines: string[] = [];
        const full = horizon.latestArms?.[arm];
        if (full && full.events > 0) {
            lines.push(`full: ${formatReplayComparisonLine(full)}`);
        }
        for (const annual of summary.annualReports ?? []) {
            const comparison = annual.horizons
                ?.find((annualHorizon) => annualHorizon.horizon === horizon.horizon)
                ?.latestArms?.[arm];
            if (comparison && comparison.events > 0) {
                lines.push(`${annual.year}: ${formatReplayComparisonLine(comparison)}`);
            }
        }
        if (lines.length > 0) {
            blocks.push(
                `<div class="batch-report-subheading">Performance by year — Horizon ${escapeHtml(String(horizon.horizon))} bars</div>`
                + `<pre class="batch-report-pre">${escapeHtml(lines.join("\n"))}</pre>`,
            );
        }
    }
    return blocks.join("");
}

export function formatLatestOpenScoreSelectionLines(
    latestInput: OpenScoreUsdLatestSelections,
    mode: TopMeanTieBreakMode,
): string[] {
    const latest = applyTieBreakToLatest(latestInput, mode);
    const lines = [
        "----------------------------------------------------------------------",
        "LATEST OPEN_SCORE SELECTOR PICKS",
        "----------------------------------------------------------------------",
        `decisionTime=${latest.decisionTime}`,
    ];
    for (const selection of latest.selections) {
        const asset = selection.reason === "selected"
            ? selection.asset ?? "NONE"
            : selection.reason === "tied"
                ? `TIE_SKIP[${selection.tiedAssets.join(",")}]`
                : "NONE";
        lines.push(
            `${selection.selector} NOW | direction=${selection.direction.toUpperCase()} | asset=${asset} | ` +
            `mean=${selection.mean ?? "n/a"} | score=${selection.score ?? "n/a"} | ` +
            `activePairs=${selection.activePairs ?? "n/a"} | pool=${selection.eligibleCandidates} | reason=${selection.reason}`,
        );
    }
    lines.push("");
    return lines;
}

export function renderTopMeanResults(
    dom: { batchBacktestSp500TopMeanResults: { innerHTML: string } },
    summary: TopMeanResultSummary,
    opts: { latestArm: OpenScoreUsdLatestSelectorName; tieMode: TopMeanTieBreakMode },
): void {
    if (!summary || !Array.isArray(summary.horizons)) return;

    let html = "";

    if ((summary.selectionCooldownBars ?? 0) > 0) {
        html += `<div class="batch-report-note">Selection cooldown: ${summary.selectionCooldownBars} target-asset bars per selector arm; annual replay windows reset independently. The current snapshot uses raw scores, while cooldown applies to historical replay picks.</div>`;
    }

    // 0. Current TOP_MEAN snapshot (Phase 1): positions open at the latest
    // common closed candle. Surfaced separately from the historical
    // OPEN_SCORE replay leaderboard below — the two answer different
    // questions (cross-sectional "now" vs per-event historical edge).
    if (summary.currentSnapshot) {
        html += renderCurrentTopMeanBanner(summary.currentSnapshot, opts.tieMode);
        if (summary.replayMode === "asset_switch") {
            html += `<div class="batch-report-note">The current snapshot is a cross-sectional raw-score view. Asset-switch replay results below include their own held position and pending orders.</div>`;
        }
    }
    if (summary.latestSelections) {
        html += renderLatestOpenScoreSelections(summary, opts.latestArm, opts.tieMode);
    }

    if (summary.performance) {
        const performanceLines = formatTopMeanPerformanceLines(summary.performance);
        html += `<div class="batch-report-card">`;
        html += `<div class="batch-report-title">Coordinator Performance</div>`;
        html += `<pre class="batch-report-pre">${escapeHtml(performanceLines.join("\n"))}</pre>`;
        html += `</div>`;
    }

    if (summary.replayMode === "asset_switch" && summary.assetSwitch) {
        html += renderAssetSwitchReplay(summary.assetSwitch);
    }

    // No per-horizon asset leaderboard section here on purpose: it rendered
    // every asset per horizon and became unusably long on large universes.
    // Top assets remain available via the Copy button (top 10 per horizon).
    const annualReports = Array.isArray(summary.annualReports) ? summary.annualReports : [];
    if (annualReports.length > 0) {
        html += `<div class="batch-report-subheading batch-report-subheading--accent">${summary.replayMode === "asset_switch" ? "Independent Asset-Switch Calendar-Year Replays" : "OPEN_SCORE USD Calendar-Year Reports"}</div>`;
        for (const annual of annualReports) {
            const fromLabel = new Date(annual.sampleFromSec * 1000).toISOString().slice(0, 10);
            const toLabel = new Date(annual.sampleToSec * 1000).toISOString().slice(0, 10);
            html += `<details class="batch-report-details">`;
            html += `<summary>${escapeHtml(annual.year)} | ${escapeHtml(fromLabel)}..${escapeHtml(toLabel)}</summary>`;
            html += `<pre class="batch-report-pre">${escapeHtml(annual.reportLines.join("\n"))}</pre>`;
            if (summary.replayMode === "asset_switch" && annual.assetSwitch) {
                html += renderAssetSwitchReplay(annual.assetSwitch, `Independent ${annual.year} Asset-Switch Replay`);
            }
            html += `</details>`;
        }
    }
    dom.batchBacktestSp500TopMeanResults.innerHTML = html;
}

function renderAssetSwitchReplay(
    summary: NonNullable<TopMeanResultSummary["assetSwitch"]>,
    heading = "Asset-Switch Replay",
): string {
    const money = (value: number | null): string => {
        if (value === null || !Number.isFinite(value)) return "n/a";
        const tone = value > 0 ? "is-positive" : value < 0 ? "is-negative" : "";
        const sign = value > 0 ? "+" : value < 0 ? "−" : "";
        return `<span${tone ? ` class="${tone}"` : ""}>${sign}$${Math.abs(value).toFixed(2)}</span>`;
    };
    let html = `<div class="batch-report-subheading batch-report-subheading--accent">${escapeHtml(heading)}</div>`;
    html += `<div class="batch-report-note">${escapeHtml(summary.semanticsVersion)} | fixed $${summary.notionalPerEntry.toLocaleString()} per entry, non-compounding | costs include slippage and commission | entry and switch orders fill at the next target open. Each arm is a separate long-only position path; unavailable data is not ranked.</div>`;
    const windowLabel = !hasAssetSwitchDecisionEvents(summary)
        ? "No decision events"
        : summary.windowStartSec === null
            ? `Full history through ${new Date(summary.windowEndSec * 1000).toISOString().slice(0, 10)}`
            : `${new Date(summary.windowStartSec * 1000).toISOString().slice(0, 10)}..${new Date(summary.windowEndSec * 1000).toISOString().slice(0, 10)}`;
    html += `<div class="batch-report-note">Window: ${windowLabel} | target data ${summary.coverage.loadedAssets}/${summary.coverage.requestedAssets} loaded${summary.tradeCount !== undefined ? ` | ${summary.tradeCount.toLocaleString()} trade records` : ""}</div>`;
    html += `<div class="batch-report-grid">`;
    for (const arm of REPLAY_ARM_FIELDS) {
        const result = summary.arms[arm];
        if (!result) continue;
        const position = result.openPosition;
        const pending = result.pendingOrder;
        const holding = position?.holdingDurationSec === null || position?.holdingDurationSec === undefined
            ? ""
            : ` | held ${(position.holdingDurationSec / 86400).toFixed(1)} days`;
        const openLine = position
            ? `<div class="batch-report-note">Open: ${escapeHtml(position.asset)} | mark ${money(position.openNetPnl)}${holding}</div>`
            : "";
        const pendingLine = pending
            ? `<div class="batch-report-note">Pending ${escapeHtml(pending.side)}${pending.destinationAsset ? ` ${escapeHtml(pending.destinationAsset)}` : ""}${pending.scheduledTimeSec === null ? " | waiting for target data" : ` | ${new Date(pending.scheduledTimeSec * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`}</div>`
            : "";
        const lookAhead = arm === "topRawProfit" || arm === "topMeanProfit";
        html += `<article class="batch-report-card"><div class="batch-report-title">${escapeHtml(arm)}${lookAhead ? " | LOOK-AHEAD RESEARCH" : ""}</div>`;
        html += `<div><strong>${escapeHtml(result.status.replaceAll("_", " ").toUpperCase())}</strong> | total ${money(result.totalNetPnl)} | realized ${money(result.realizedNetPnl)} | open ${money(result.openPositionNetPnl)}</div>`;
        html += `<div>${result.completedTrades.toLocaleString()} closed | ${result.enteredCount.toLocaleString()} entries | costs $${result.totalCosts.toFixed(2)}</div>`;
        html += openLine + pendingLine;
        html += `</article>`;
    }
    html += `</div>`;
    return html;
}

/**
 * Phase-1 current snapshot banner. Renders the cross-sectional TOP_MEAN
 * pick(s) at the latest common closed candle. Kept visually separate from
 * the historical leaderboard — different question, different evidence.
 * Reuses the existing results container; no new DOM id.
 */
export function renderCurrentTopMeanBanner(
    currentSnapshot: TopMeanCurrentSnapshot,
    tieMode: TopMeanTieBreakMode,
): string {
    const snap = currentSnapshot.snapshot;
    const tiePicked = tieBreakPickedAsset(currentSnapshot, tieMode);
    const winners = winnersAfterTieBreak(currentSnapshot, tiePicked);
    const asOfSec: number | null = snap?.asOf ?? null;
    const asOfLabel = typeof asOfSec === "number"
        ? new Date(asOfSec * 1000).toISOString().slice(0, 19).replace("T", " ") + " UTC"
        : "no common endpoint";
    const reason: string = snap?.reason ?? "empty";
    const stats = currentSnapshot.stats;
    const decision = resolveTiedDecision(currentSnapshot.decision, tiePicked, asOfSec);
    const decisionStatus = (decision as { status?: string } | undefined)?.status;

    // Collapsible (default collapsed): the full banner is long on large
    // universes, so the summary line carries the decision outcome and the
    // user opens the card for the evidence.
    const summaryLabel = decisionStatus === "LONG_NEXT_BAR" && decision?.asset
        ? `TOP_MEAN ALGORITHMIC TRADE DECISION — LONG ${decision.asset}`
        : "TOP_MEAN ALGORITHMIC TRADE DECISION — NO TRADE";
    let html = `<details class="batch-report-card batch-report-details">`;
    html += `<summary>${escapeHtml(summaryLabel)}</summary>`;
    html += `<div class="batch-report-note">as-of: ${asOfLabel} | artifacts ${snap?.artifacts ?? 0} | open positions ${snap?.openPositions ?? 0} | candidates ${snap?.candidates?.length ?? 0} | stale ${stats.staleEndpoints ?? 0} | missing ${stats.missingEndpoints ?? 0}</div>`;

    if (decisionStatus === "LONG_NEXT_BAR" && decision?.asset) {
        const decisionLabel = typeof decision.decisionTime === "number"
            ? new Date(decision.decisionTime * 1000).toISOString().slice(0, 19).replace("T", " ") + " UTC"
            : "unknown";
        html += `<div class="batch-report-decision">`;
        html += `<strong>ALGORITHMIC TRADE DECISION — LONG ${escapeHtml(decision.asset)}:</strong> enter on the first target-asset bar strictly after the ${escapeHtml(decisionLabel)} decision event. Research case: $${escapeHtml(decision.researchNotionalUsd)} notional, hold ${escapeHtml(decision.researchHoldBars)} bars, exit at ${escapeHtml(decision.researchExitRule.replaceAll("_", " "))}.`;
        html += `</div>`;
    } else {
        const reasonText = decision?.reason === "entry_window_expired"
            ? `The latest unique ${escapeHtml(decision.asset ?? "TOP_MEAN")} decision event is older than the common data endpoint, so the algorithm will not chase the missed entry.`
            : decision?.reason === "tied"
                ? "The latest decision event is tied, so the algorithm has no unique asset."
                : decision?.reason === "no_positive_candidates"
                    ? "The latest decision event has no positive TOP_MEAN candidate."
                    : decisionStatus === "VERIFY_ENTRY_WINDOW"
                        ? "This is a legacy saved result. Run TOP_MEAN again to compute the algorithmic entry decision."
                        : "The latest decision event is unavailable.";
        html += `<div class="batch-report-decision batch-report-decision--flat">`;
        html += `<strong>ALGORITHMIC TRADE DECISION — NO TRADE:</strong> ${reasonText}`;
        html += `</div>`;
    }
    html += `<div class="batch-report-note"><strong>ASSUMPTION:</strong> This trade decision is built from one selected strategy configuration only. It does not combine or confirm multiple strategy configurations.</div>`;

    if (winners.length === 0) {
        const noPickMsg = reason === "tied"
            ? "Tie at the top — no unique pick."
            : reason === "no_positive_candidates"
                ? "No positive-score asset with an open position."
                : reason === "no_open_positions"
                    ? "No open positions at the common endpoint."
                    : "No provable current snapshot (missing or mixed endpoints).";
        html += `<div class="batch-report-warning">${noPickMsg}</div>`;
        html += `</details>`;
        return html;
    }

    html += `<div class="batch-pick-row">`;
    for (const w of winners) {
        const mean = Number(w.mean ?? 0);
        const meanSign = mean >= 0 ? "+" : "";
        html += `<div class="batch-pick-card">`;
        html += `<div class="batch-pick-label">${winners.length > 1 ? "Tied Winner" : tiePicked !== null ? "Current Pick (tie-break)" : "Current Pick"}</div>`;
        html += `<div class="batch-pick-asset">${escapeHtml(w.asset)}</div>`;
        html += `<div class="batch-pick-meta">mean=${meanSign}${mean.toFixed(2)} | score=${escapeHtml(w.score)} | activePairs=${escapeHtml(w.activePairs)}</div>`;
        html += `</div>`;
    }
    html += `</div>`;
    if (winners.length > 1) {
        html += `<div class="batch-report-note batch-report-note--after">Tie shown as-is — no arbitrary asset-name tie-break. Treat as an unresolved decision.</div>`;
    } else if (tiePicked !== null) {
        html += `<div class="batch-report-note batch-report-note--after">${escapeHtml(topMeanTieBreakNote(tieMode))}</div>`;
    }

    const leaderboard: any[] = Array.isArray(snap?.candidates) ? snap.candidates.slice(0, 10) : [];
    html += `<div class="batch-report-subheading">CURRENT TOP_MEAN Leaderboard — top ${leaderboard.length}</div>`;
    html += `<table class="finder-table batch-report-table"><thead><tr><th>Rank</th><th>Asset</th><th>Mean</th><th>Score</th><th>Active Pairs</th></tr></thead><tbody>`;
    leaderboard.forEach((candidate, index) => {
        const mean = Number(candidate.mean ?? 0);
        const meanSign = mean >= 0 ? "+" : "";
        const isTop = index === 0;
        html += `<tr${isTop ? ` class="batch-report-row-top"` : ""}><td>${index + 1}</td><td><strong>${escapeHtml(candidate.asset)}</strong></td><td>${meanSign}${mean.toFixed(2)}</td><td>${escapeHtml(candidate.score)}</td><td>${escapeHtml(candidate.activePairs)}</td></tr>`;
    });
    html += `</tbody></table>`;
    html += `</details>`;
    return html;
}

/**
 * Phase-1 current snapshot lines for the Copy Results output. Mirrors the
 * banner content in plain text so the clipboard surface matches the UI.
 */
export function formatCurrentTopMeanLines(
    currentSnapshot: any,
    tieMode: TopMeanTieBreakMode,
): string[] {
    const snap: any = currentSnapshot.snapshot ?? currentSnapshot;
    const tiePicked = tieBreakPickedAsset(currentSnapshot, tieMode);
    const winners: any[] = winnersAfterTieBreak(currentSnapshot, tiePicked);
    const asOfSec: number | null = snap?.asOf ?? null;
    const asOfLabel = typeof asOfSec === "number"
        ? new Date(asOfSec * 1000).toISOString().slice(0, 19).replace("T", " ") + " UTC"
        : "no common endpoint";
    const reason: string = snap?.reason ?? "empty";
    const stats: any = currentSnapshot.stats ?? {};
    const decision: any = resolveTiedDecision(currentSnapshot.decision, tiePicked, asOfSec);

    const lines: string[] = [];
    lines.push("----------------------------------------------------------------------");
    lines.push("TOP_MEAN ALGORITHMIC TRADE DECISION");
    lines.push("----------------------------------------------------------------------");
    lines.push(`as-of=${asOfLabel} | artifacts=${snap?.artifacts ?? 0} | openPositions=${snap?.openPositions ?? 0} | candidates=${snap?.candidates?.length ?? 0} | stale=${stats.staleEndpoints ?? 0} | missing=${stats.missingEndpoints ?? 0}`);
    if (decision?.status === "LONG_NEXT_BAR" && decision.asset) {
        lines.push(`ALGORITHMIC TRADE DECISION | LONG_NEXT_BAR | asset=${decision.asset} | decisionTime=${decision.decisionTime ?? "NONE"} | entryRule=${decision.entryRule} | researchNotionalUsd=${decision.researchNotionalUsd} | researchHoldBars=${decision.researchHoldBars} | researchExit=${decision.researchExitRule} | entryPairs=${decision.entryPairs}`);
    } else {
        lines.push(`ALGORITHMIC TRADE DECISION | NO_TRADE | reason=${decision?.reason ?? "legacy_snapshot_without_decision"} | asset=${decision?.asset ?? "NONE"} | decisionTime=${decision?.decisionTime ?? "NONE"}`);
    }
    lines.push("DECISION ASSUMPTION | built from one selected strategy configuration only; no multi-configuration confirmation");
    if (winners.length === 0) {
        const noPickMsg = reason === "tied"
            ? "tied at top — no unique pick"
            : reason === "no_positive_candidates"
                ? "no positive-score asset with an open position"
                : reason === "no_open_positions"
                    ? "no open positions at the common endpoint"
                    : "no provable current snapshot (missing or mixed endpoints)";
        lines.push(`CURRENT TOP_MEAN | NO PICK | ${noPickMsg}`);
    } else {
        for (const w of winners) {
            const mean = Number(w.mean ?? 0);
            const meanSign = mean >= 0 ? "+" : "";
            lines.push(`CURRENT TOP_MEAN | asOf=${asOfLabel} | winners=${w.asset} | mean=${meanSign}${mean.toFixed(2)} | score=${w.score} | activePairs=${w.activePairs}`);
        }
        if (winners.length > 1) {
            lines.push(`CURRENT TOP_MEAN | tie across ${winners.length} assets — unresolved decision`);
        } else if (tiePicked !== null) {
            lines.push(`CURRENT TOP_MEAN | ${topMeanTieBreakNote(tieMode)}`);
        }
        const leaderboard: any[] = Array.isArray(snap?.candidates) ? snap.candidates.slice(0, 10) : [];
        lines.push(`CURRENT TOP_MEAN LEADERBOARD | top ${leaderboard.length}`);
        leaderboard.forEach((candidate, index) => {
            const mean = Number(candidate.mean ?? 0);
            const meanSign = mean >= 0 ? "+" : "";
            lines.push(`CURRENT TOP_MEAN | rank=${index + 1} | asset=${candidate.asset} | mean=${meanSign}${mean.toFixed(2)} | score=${candidate.score} | activePairs=${candidate.activePairs}`);
        });
    }
    lines.push("");
    return lines;
}
