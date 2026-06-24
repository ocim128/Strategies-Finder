/**
 * Pure render functions for the Signal Committee tab. No DOM mutation beyond
 * returning HTML strings. The service is responsible for swapping them in.
 */
import { escapeHtml } from "./html-escape";
import type { AlertSubscription, CommitteeMemberState } from "./alert-service";
import {
    formatAgeShort,
    formatPercentSigned,
    ageSecForRow,
    gainPctForRow,
    type CommitteeAggregate,
    type LegScore,
} from "./signal-committee-score";
import type { ScoreEdgeReport, ScoreEdgeBucket } from "./signal-committee-edge";

export interface CommitteeRowView {
    streamId: string;
    configName: string;
    symbol: string;
    interval: string;
    strategyKey: string;
    /** "LONG" | "SHORT" | "FLAT" | "PENDING" | "ERROR" | "—" */
    directionLabel: string;
    /** Tone for the direction cell. Encodes what the old Vote column said. */
    directionTone: "long" | "short" | "flat" | "pending" | "error" | "none";
    /**
     * +1 / -1 / 0 — kept on the view-model for unit tests and any future
     * consumer, but no longer rendered as its own table column.
     */
    voteLabel: string;
    ageLabel: string;
    gainLabel: string;
    statusLabel: string;
    statusTone: "ok" | "warn" | "error";
    /**
     * Whether the member currently counts toward the committee score. False
     * when the user has deactivated the member (worker `enabled=0`, or the
     * local-synthetic `disabled` flag). Disabled rows render muted with a
     * "disabled" pill and are excluded from the score by the service.
     */
    enabled: boolean;
}

/** Truncation limit for the status cell; full text lives in the diagnostic <pre>. */
const ROW_STATUS_MAX_CHARS = 80;

function toneClass(tone: "ok" | "warn" | "error"): string {
    if (tone === "error") return "signal-committee__status--error";
    if (tone === "warn") return "signal-committee__status--warn";
    return "signal-committee__status--ok";
}

/**
 * Build the renderer-facing view of one committee member.
 *
 * Extracted from the service as a pure function so the status-precedence
 * rules (last_status error vs cached-state reason vs no_cached_state) and
 * direction-label fallbacks are unit-testable without a DOM.
 *
 * Status precedence (most specific first):
 *   1. `last_status` matching /error/i always wins — it records WHY the cron
 *      evaluation failed (e.g. "error:Binance API ...").
 *   2. Otherwise, if cached state is missing/not-ok, the cached `reason`
 *      decides the tone: `no_cached_state` is "warn" (pending), else "error".
 *   3. Otherwise the row is healthy; surface `last_status ?? "ok"`.
 */
export function buildCommitteeRowView(
    member: Pick<AlertSubscription,
        | "stream_id"
        | "symbol"
        | "interval"
        | "strategy_key"
        | "last_status"
        | "enabled">,
    memberState: CommitteeMemberState | undefined,
    nowSec: number,
    configNameFromStreamId: string | null
): CommitteeRowView {
    const s = memberState;
    const configName = configNameFromStreamId ?? member.strategy_key;
    const direction = s?.latestEntry?.direction ?? null;
    const trade = s?.latestTrade ?? null;
    const isOpen = Boolean(trade?.isOpen);
    const enabled = member.enabled === 1;

    let directionLabel = "—";
    let directionTone: CommitteeRowView["directionTone"] = "none";
    let voteLabel = "0";
    if (!enabled) {
        // Deactivated members neither vote nor get re-evaluated. Show a muted
        // DISABLED state regardless of any stale cached trade underneath.
        directionLabel = "DISABLED";
        directionTone = "none";
        voteLabel = "0";
    } else if (s && s.ok && isOpen && direction) {
        directionLabel = direction === "long" ? "LONG" : "SHORT";
        directionTone = direction;
        voteLabel = direction === "long" ? "+1" : "-1";
    } else if (s && s.ok) {
        directionLabel = "FLAT";
        directionTone = "flat";
        voteLabel = "0";
    } else if (s && !s.ok && s.reason === "no_cached_state") {
        // Cron never wrote state. The most useful label depends on WHY:
        // if last_status shows an error, surface that; else "PENDING".
        if (member.last_status && /error/i.test(member.last_status)) {
            directionLabel = "ERROR";
            directionTone = "error";
        } else {
            directionLabel = "PENDING";
            directionTone = "pending";
        }
    } else if (s && !s.ok) {
        directionLabel = "ERROR";
        directionTone = "error";
    }

    const okRow = s?.ok === true;
    const ageSec = okRow && trade
        ? ageSecForRow({
            streamId: member.stream_id,
            ok: true,
            latestTrade: {
                entryTimeSec: trade.entryTimeSec,
                entryPrice: trade.entryPrice,
                isOpen: trade.isOpen,
            },
            latestClose: s?.latestClose ?? null,
        }, nowSec)
        : null;
    const gainPct = okRow && trade
        ? gainPctForRow({
            streamId: member.stream_id,
            ok: true,
            latestTrade: {
                entryTimeSec: trade.entryTimeSec,
                entryPrice: trade.entryPrice,
                isOpen: trade.isOpen,
            },
            latestClose: s?.latestClose ?? null,
            voteDirection: direction,
        })
        : null;

    const ageLabel = formatAgeShort(ageSec);
    const gainLabel = formatPercentSigned(gainPct);

    let statusLabel = "—";
    let statusTone: "ok" | "warn" | "error" = "ok";
    if (!s) {
        // State map miss entirely. last_status is the only signal we have.
        if (member.last_status && /error/i.test(member.last_status)) {
            statusLabel = member.last_status;
            statusTone = "error";
        } else {
            statusLabel = member.last_status ?? "no state";
            statusTone = "warn";
        }
    } else if (!s.ok) {
        // Cached state missing/error. Prefer the cron's last_status (which
        // records WHY evaluation failed, e.g. "error:Binance API ..."),
        // falling back to the cached-state reason.
        if (member.last_status && /error/i.test(member.last_status)) {
            statusLabel = member.last_status;
            statusTone = "error";
        } else {
            statusLabel = s.reason ?? "error";
            statusTone = s.reason === "no_cached_state" ? "warn" : "error";
        }
    } else if (member.last_status && /error/i.test(member.last_status)) {
        statusLabel = member.last_status;
        statusTone = "error";
    } else {
        statusLabel = member.last_status ?? "ok";
    }

    // The full error string can be very long (multi-URL ban messages).
    // Truncate for the table cell; the diagnostic <pre> has the full text.
    if (statusLabel.length > ROW_STATUS_MAX_CHARS) {
        statusLabel = statusLabel.slice(0, ROW_STATUS_MAX_CHARS - 3) + "...";
    }

    return {
        streamId: member.stream_id,
        configName,
        symbol: member.symbol,
        interval: member.interval,
        strategyKey: member.strategy_key,
        directionLabel,
        directionTone,
        voteLabel,
        ageLabel,
        gainLabel,
        statusLabel,
        statusTone,
        enabled,
    };
}

export function renderCommitteeHeader(aggregate: CommitteeAggregate, updatedAtIso: string | null): {
    score: string;
    scoreTone: "positive" | "negative" | "neutral";
    longShort: string;
    avgAge: string;
    avgGain: string;
    lastUpdated: string;
} {
    const open = aggregate.longCount + aggregate.shortCount;
    const scoreSign = aggregate.score > 0 ? "+" : "";
    const hasActivity = open > 0 || aggregate.flatCount > 0;
    return {
        score: hasActivity ? `${scoreSign}${aggregate.score}` : "—",
        scoreTone: !hasActivity || aggregate.score === 0
            ? "neutral"
            : aggregate.score > 0
                ? "positive"
                : "negative",
        longShort: `${aggregate.longCount}L / ${aggregate.shortCount}S / ${aggregate.flatCount}Flat`,
        avgAge: formatAgeShort(aggregate.avgAgeSec),
        avgGain: formatPercentSigned(aggregate.avgGainPct),
        lastUpdated: updatedAtIso ? formatTimestampShort(updatedAtIso) : "—",
    };
}

export function renderCommitteeRows(rows: readonly CommitteeRowView[]): string {
    if (rows.length === 0) {
        return `<tr class="signal-committee__empty-row"><td colspan="9">
            No committee members yet. Click <strong>Add Current Configuration</strong> to start.
        </td></tr>`;
    }
    return rows.map((row) => renderCommitteeRow(row)).join("");
}

const COLSPAN = 9;

function renderCommitteeRow(row: CommitteeRowView): string {
    const directionClass = row.directionTone === "none"
        ? ""
        : `signal-committee__direction--${row.directionTone}`;
    const directionCellClass = directionClass ? ` class="${directionClass}"` : "";
    const rowClass = row.enabled ? "" : ' class="signal-committee__row--disabled"';
    // Toggle button carries the desired NEXT enabled state as `{0|1}:{streamId}`
    // so the service reads the target directly instead of re-deriving it.
    const toggleAttr = row.enabled
        ? `data-signal-committee-toggle-enabled="0:${escapeHtml(row.streamId)}"`
        : `data-signal-committee-toggle-enabled="1:${escapeHtml(row.streamId)}"`;
    const toggleLabel = row.enabled ? "Deactivate" : "Activate";
    const disabledPill = row.enabled
        ? ""
        : ' <span class="signal-committee__disabled-pill">disabled</span>';
    return `<tr${rowClass}>
        <td>${escapeHtml(row.configName)}</td>
        <td>${escapeHtml(row.symbol)}</td>
        <td>${escapeHtml(row.interval)}</td>
        <td>${escapeHtml(row.strategyKey)}</td>
        <td${directionCellClass}>${escapeHtml(row.directionLabel)}</td>
        <td>${escapeHtml(row.ageLabel)}</td>
        <td>${escapeHtml(row.gainLabel)}</td>
        <td class="${toneClass(row.statusTone)}">${escapeHtml(row.statusLabel)}${disabledPill}</td>
        <td>
            <button class="btn btn-secondary btn-compact" data-signal-committee-load="${escapeHtml(row.streamId)}" type="button">Load</button>
            <button class="btn btn-secondary btn-compact" ${toggleAttr} type="button">${toggleLabel}</button>
            <button class="btn btn-secondary btn-compact" data-signal-committee-remove="${escapeHtml(row.streamId)}" type="button">Remove</button>
        </td>
    </tr>`;
}

function formatTimestampShort(iso: string): string {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return "—";
    return new Date(ms).toLocaleTimeString();
}

export function renderEmptyHealthFail(message: string): string {
    return `<tr class="signal-committee__empty-row"><td colspan="${COLSPAN}">
        ${escapeHtml(message)}
    </td></tr>`;
}

// ---------------------------------------------------------------------------
// Per-leg leaderboard
// ---------------------------------------------------------------------------

/**
 * Render the per-leg net-score leaderboard as a row of ranked chips.
 *
 * Decomposes synthetic-pair votes into their underlying legs so directional
 * exposure reads at a glance (e.g. 3 short ZECAPT => ZEC: -3, APT: +3).
 *
 * Returns an empty string when there are no legs (no members with open
 * trades), so the caller can hide the section. Tone mirrors the score badge:
 * positive -> green, negative -> red, neutral -> muted.
 */
export function renderLegLeaderboard(legs: readonly LegScore[]): string {
    if (legs.length === 0) return "";
    const rows = legs.map((leg) => {
        const tone = leg.score === 0 ? "neutral" : leg.score > 0 ? "positive" : "negative";
        const sign = leg.score > 0 ? "+" : "";
        const tally = `${leg.longCount}L · ${leg.shortCount}S`;
        return `<div class="signal-committee__leg-row">
            <span class="signal-committee__leg-symbol" title="${escapeHtml(leg.syntheticOnly ? "synthetic leg" : "direct member")}">${escapeHtml(leg.symbol)}</span>
            <span class="signal-committee__leg-score signal-committee__score--${tone}">${sign}${leg.score}</span>
            <span class="signal-committee__leg-tally">${escapeHtml(tally)}</span>
        </div>`;
    });
    return rows.join("");
}

// ---------------------------------------------------------------------------
// Score Edge Report
// ---------------------------------------------------------------------------

function scoreTone(score: number): "positive" | "negative" | "neutral" {
    return score > 0 ? "positive" : score < 0 ? "negative" : "neutral";
}

function formatPctCell(value: number, digits = 2): string {
    if (!Number.isFinite(value)) return "—";
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(digits)}%`;
}

function renderScoreEdgeBucketRow(bucket: ScoreEdgeBucket): string {
    const cells = bucket.horizons.map((h) => {
        const star = h.thin ? ' <span class="signal-committee__edge-thin" title="thin sample">*</span>' : "";
        return `<td>${formatPctCell(h.meanForwardReturnPct)}<br><span class="signal-committee__edge-sub">adj ${formatPctCell(h.driftAdjustedPct)} · ${h.effectSizeBp.toFixed(1)} bp</span><br><span class="signal-committee__edge-sub">win ${h.winRate.toFixed(2)} · n${h.samples}</span>${star}</td>`;
    }).join("");
    const sign = bucket.score > 0 ? "+" : "";
    const revFlag = bucket.reversal
        ? ' <span class="signal-committee__edge-reversal" title="forward return contradicts the score sign — treat as a fade, not a follow">↺ reversal</span>'
        : "";
    return `<tr>
        <td><span class="signal-committee__edge-score signal-committee__score--${scoreTone(bucket.score)}">${sign}${bucket.score}</span>${revFlag}</td>
        ${cells}
    </tr>`;
}

/**
 * Render the Score Edge Report body as an HTML string.
 *
 * Returns an empty string when `report` is null (caller shows the placeholder
 * hint instead). The report is deterministic; the renderer is pure and does
 * not recompute anything — it only formats the report's numbers.
 */
export function renderScoreEdgeReport(report: ScoreEdgeReport | null): string {
    if (!report) return "";
    const headerCells = report.horizons
        .map((h) => `<th>+${h} bars</th>`)
        .join("");
    const bucketRows = report.buckets
        .map((row) => renderScoreEdgeBucketRow(row))
        .join("");

    const s = report.strategy;
    const stratTone = s.cumulativeReturnPct > 0
        ? "positive"
        : s.cumulativeReturnPct < 0 ? "negative" : "neutral";
    // Significance drives the badge tone: a big alpha that is not significant
    // is the small-edge-times-many-bets trap, so it renders neutral, not green.
    const sigTone = s.significance === "significant"
        ? (s.alphaPct >= 0 ? "positive" : "negative")
        : "neutral";
    const inMarket = s.longBars + s.shortBars;

    const findingsHtml = report.notableFindings.length > 0
        ? `<div class="signal-committee__edge-findings">${report.notableFindings
            .map((f) => `<div class="signal-committee__edge-finding">${escapeHtml(f)}</div>`)
            .join("")}</div>`
        : "";

    return `<div class="signal-committee__edge">
        <div class="portfolio-lab__control-grid">
            <div class="analysis-control portfolio-lab__readout">
                LS cumulative
                <div class="portfolio-lab__badge signal-committee__score--${stratTone}">${formatPctCell(s.cumulativeReturnPct)}</div>
            </div>
            <div class="analysis-control portfolio-lab__readout">
                Buy &amp; hold
                <div class="portfolio-lab__badge">${formatPctCell(s.buyAndHoldReturnPct)}</div>
            </div>
            <div class="analysis-control portfolio-lab__readout">
                Alpha (LS − B&amp;H)
                <div class="portfolio-lab__badge signal-committee__score--${sigTone}" title="Alpha tone is gated by significance — a large alpha that is not significant is small-edge-times-many-bets noise, rendered neutral.">${formatPctCell(s.alphaPct)}</div>
            </div>
            <div class="analysis-control portfolio-lab__readout">
                Significance
                <div class="portfolio-lab__badge signal-committee__score--${sigTone}" title="t = sharpe × √(in-market bars). Large alpha + low t = unreliable.">t=${Number.isFinite(s.tStat) ? s.tStat.toFixed(2) : "—"} · ${escapeHtml(s.significance)}</div>
            </div>
            <div class="analysis-control portfolio-lab__readout">
                LS Sharpe (raw)
                <div class="portfolio-lab__badge">${Number.isFinite(s.sharpeRaw) ? s.sharpeRaw.toFixed(2) : "—"}</div>
            </div>
            <div class="analysis-control portfolio-lab__readout">
                Bars in market
                <div class="portfolio-lab__badge">${inMarket} <span class="signal-committee__edge-sub">(${s.longBars}L/${s.shortBars}S/${s.flatBars}flat)</span></div>
            </div>
            <div class="analysis-control portfolio-lab__readout">
                Score range
                <div class="portfolio-lab__badge">${report.scoreRange.min} .. ${report.scoreRange.max}</div>
            </div>
        </div>

        ${findingsHtml}

        <div class="signal-committee__edge-note">
            Forward return per score bucket. Each cell: mean forward return,
            then <strong>drift-adjusted</strong> (minus the asset's own per-bar
            drift × horizon — removes beta so the number reads as score-specific
            edge), then win rate &amp; sample count. Positive scores predicting
            positive drift-adjusted returns = real edge.
            <span class="signal-committee__edge-thin">*</span> = thin sample.
            <span class="signal-committee__edge-reversal">↺ reversal</span> = forward return contradicts the score — fade, don't follow.
        </div>

        <div class="alert-table-wrapper signal-committee__edge-table">
            <table class="alert-table">
                <thead>
                    <tr>
                        <th>Score</th>
                        ${headerCells}
                    </tr>
                </thead>
                <tbody>${bucketRows || `<tr class="signal-committee__empty-row"><td colspan="${report.horizons.length + 1}">No scored bars.</td></tr>`}</tbody>
            </table>
        </div>
    </div>`;
}
