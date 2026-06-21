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
} from "./signal-committee-score";

export interface CommitteeRowView {
    streamId: string;
    configName: string;
    symbol: string;
    interval: string;
    strategyKey: string;
    /** "long" | "short" | "flat" | "—" */
    directionLabel: string;
    voteLabel: string;
    ageLabel: string;
    gainLabel: string;
    statusLabel: string;
    statusTone: "ok" | "warn" | "error";
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
        | "last_status">,
    memberState: CommitteeMemberState | undefined,
    nowSec: number,
    configNameFromStreamId: string | null
): CommitteeRowView {
    const s = memberState;
    const configName = configNameFromStreamId ?? member.strategy_key;
    const direction = s?.latestEntry?.direction ?? null;
    const trade = s?.latestTrade ?? null;
    const isOpen = Boolean(trade?.isOpen);

    let directionLabel = "—";
    let voteLabel = "0";
    if (s && s.ok && isOpen && direction) {
        directionLabel = direction === "long" ? "LONG" : "SHORT";
        voteLabel = direction === "long" ? "+1" : "-1";
    } else if (s && s.ok) {
        directionLabel = "FLAT";
        voteLabel = "0";
    } else if (s && !s.ok && s.reason === "no_cached_state") {
        // Cron never wrote state. The most useful label depends on WHY:
        // if last_status shows an error, surface that; else "PENDING".
        directionLabel = member.last_status && /error/i.test(member.last_status) ? "ERROR" : "PENDING";
    } else if (s && !s.ok) {
        directionLabel = "ERROR";
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
        voteLabel,
        ageLabel,
        gainLabel,
        statusLabel,
        statusTone,
    };
}

export function renderCommitteeHeader(aggregate: CommitteeAggregate, updatedAtIso: string | null): {
    score: string;
    longShort: string;
    avgAge: string;
    avgGain: string;
    lastUpdated: string;
} {
    const open = aggregate.longCount + aggregate.shortCount;
    const scoreSign = aggregate.score > 0 ? "+" : "";
    return {
        score: open > 0 || aggregate.flatCount > 0 ? `${scoreSign}${aggregate.score}` : "—",
        longShort: `${aggregate.longCount}L / ${aggregate.shortCount}S / ${aggregate.flatCount}Flat`,
        avgAge: formatAgeShort(aggregate.avgAgeSec),
        avgGain: formatPercentSigned(aggregate.avgGainPct),
        lastUpdated: updatedAtIso ? formatTimestampShort(updatedAtIso) : "—",
    };
}

export function renderCommitteeRows(rows: readonly CommitteeRowView[]): string {
    if (rows.length === 0) {
        return `<tr><td colspan="10" style="text-align:center;color:var(--text-secondary);padding:16px;">
            No committee members yet. Click <strong>Add Current Configuration</strong> to start.
        </td></tr>`;
    }
    return rows.map((row) => renderCommitteeRow(row)).join("");
}

function renderCommitteeRow(row: CommitteeRowView): string {
    return `<tr>
        <td>${escapeHtml(row.configName)}</td>
        <td>${escapeHtml(row.symbol)}</td>
        <td>${escapeHtml(row.interval)}</td>
        <td>${escapeHtml(row.strategyKey)}</td>
        <td>${escapeHtml(row.directionLabel)}</td>
        <td>${escapeHtml(row.voteLabel)}</td>
        <td>${escapeHtml(row.ageLabel)}</td>
        <td>${escapeHtml(row.gainLabel)}</td>
        <td class="${toneClass(row.statusTone)}">${escapeHtml(row.statusLabel)}</td>
        <td>
            <button class="btn btn-secondary btn-compact" data-signal-committee-load="${escapeHtml(row.streamId)}" type="button">Load</button>
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
    return `<tr><td colspan="10" style="text-align:center;color:var(--text-secondary);padding:16px;">
        ${escapeHtml(message)}
    </td></tr>`;
}
