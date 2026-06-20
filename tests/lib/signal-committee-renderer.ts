/**
 * Pure render functions for the Signal Committee tab. No DOM mutation beyond
 * returning HTML strings. The service is responsible for swapping them in.
 */
import { escapeHtml } from "./html-escape";
import {
    formatAgeShort,
    formatPercentSigned,
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

function toneClass(tone: "ok" | "warn" | "error"): string {
    if (tone === "error") return "signal-committee__status--error";
    if (tone === "warn") return "signal-committee__status--warn";
    return "signal-committee__status--ok";
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
