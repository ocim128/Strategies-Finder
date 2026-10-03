/**
 * TOP_MEAN OPEN_SCORE event-details presentation: the Show/Hide details
 * section, selector/year filters, completed vs ONGOING rows, and the
 * truncation notices. Year slicing is a client-side filter on decision time —
 * no additional server data is fetched (wire-safety keeps per-year rows off
 * the wire). Rendering is stateless; lifecycle state stays with the run owner.
 */
import type {
    OpenScoreUsdEventDetail,
    OpenScoreUsdEventDetailSelector,
    OpenScoreUsdOngoingEventDetail,
    ReplayArmField,
} from "../open-score-replay/types";
import type { TopMeanResultSummary } from "../sp500-top-mean-coordinator-engine";
import type { BatchBacktestDom } from "../batch-backtest-dom";
import { escapeHtml } from "../../html-escape";
import { CAUSAL_ARM_FIELDS, REPLAY_ARM_TO_FINDER_ARM } from "../open-score-replay/arm-contract";
import { formatCausalArmAvailabilityLines } from "./top-mean-results-view";

export type OngoingTopMeanEventDetail = OpenScoreUsdOngoingEventDetail;

export interface TopMeanOpenScoreDetailSection {
    label: string;
    rows: OpenScoreUsdEventDetail[];
    ongoingRows: OngoingTopMeanEventDetail[];
}

export function resetTopMeanOpenScoreDetails(dom: BatchBacktestDom): void {
    dom.batchBacktestSp500TopMeanDetailsSelector.disabled = true;
    dom.batchBacktestSp500TopMeanDetailsYear.disabled = true;
    dom.batchBacktestSp500TopMeanDetailsYear.value = "";
    dom.batchBacktestSp500TopMeanDetailsBtn.disabled = true;
    dom.batchBacktestSp500TopMeanDetailsBtn.textContent = "Show OPEN_SCORE Details";
    dom.batchBacktestSp500TopMeanDetails.hidden = true;
    dom.batchBacktestSp500TopMeanDetails.innerHTML = "";
}

export function syncTopMeanOpenScoreDetailsControl(
    dom: BatchBacktestDom,
    summary: TopMeanResultSummary,
): void {
    const annualHasDetails = summary.annualReports?.some(
        (annual) => Array.isArray(annual.eventDetails) && annual.eventDetails.length > 0,
    ) === true;
    const fullRangeHasDetails =
        Array.isArray(summary.openScoreEventDetails)
        && summary.openScoreEventDetails.length > 0;
    const hasOngoingRows = buildOngoingEventDetails(summary).length > 0;
    const annualHasSwitchTrades = summary.annualReports?.some(
        (annual) => (annual.assetSwitch?.tradeCount ?? annual.assetSwitch?.trades?.length ?? 0) > 0,
    ) === true;
    const fullRangeHasSwitchTrades = (summary.assetSwitch?.tradeCount ?? summary.assetSwitch?.trades?.length ?? 0) > 0;
    const hasDetails = annualHasDetails || fullRangeHasDetails || hasOngoingRows
        || annualHasSwitchTrades || fullRangeHasSwitchTrades;
    dom.batchBacktestSp500TopMeanDetailsBtn.disabled = !hasDetails;
    dom.batchBacktestSp500TopMeanDetailsSelector.disabled = !hasDetails;
    dom.batchBacktestSp500TopMeanDetailsYear.disabled = !hasDetails;
    syncTopMeanDetailYearOptions(dom, summary);
    dom.batchBacktestSp500TopMeanDetailsBtn.textContent = "Show OPEN_SCORE Details";
    dom.batchBacktestSp500TopMeanDetails.hidden = true;
    dom.batchBacktestSp500TopMeanDetails.innerHTML = "";
}

export function getTopMeanOpenScoreDetailSelector(
    dom: BatchBacktestDom,
): OpenScoreUsdEventDetailSelector {
    return (dom.batchBacktestSp500TopMeanDetailsSelector.value || "TOP_MEAN") as
        OpenScoreUsdEventDetailSelector;
}

/** Selected calendar year for the details table; null = full window. */
export function getTopMeanOpenScoreDetailYear(dom: BatchBacktestDom): number | null {
    const value = dom.batchBacktestSp500TopMeanDetailsYear.value;
    if (!value) return null;
    const year = Number(value);
    return Number.isInteger(year) && year >= 1970 && year <= 9999 ? year : null;
}

/**
 * Rebuild the details year options from the rows the browser can actually
 * show: distinct decision years of the shipped full-window rows plus the
 * annual report windows. Selecting a year is a client-side slice of those
 * rows — no additional server data is fetched (wire-safety keeps per-year
 * rows off the wire), so "Full window" (blank) stays the default.
 */
function syncTopMeanDetailYearOptions(dom: BatchBacktestDom, summary: TopMeanResultSummary): void {
    const years = new Set<number>();
    for (const row of summary.openScoreEventDetails ?? []) {
        years.add(new Date(row.decisionTime * 1000).getUTCFullYear());
    }
    for (const annual of summary.annualReports ?? []) {
        years.add(annual.year);
        for (const trade of annual.assetSwitch?.trades ?? []) {
            years.add(new Date(trade.decisionTimeSec * 1000).getUTCFullYear());
        }
    }
    for (const trade of summary.assetSwitch?.trades ?? []) {
        years.add(new Date(trade.decisionTimeSec * 1000).getUTCFullYear());
    }
    const previous = dom.batchBacktestSp500TopMeanDetailsYear.value;
    const options = [
        `<option value=""${!previous ? " selected" : ""}>Full window</option>`,
        ...[...years].sort((a, b) => b - a).map((year) =>
            `<option value="${year}"${String(year) === previous ? " selected" : ""}>${year}</option>`,
        ),
    ];
    dom.batchBacktestSp500TopMeanDetailsYear.innerHTML = options.join("");
}

/**
 * The historical replay intentionally omits right-censored horizons, but
 * an unresolved selector pick is still useful before its holding period has
 * completed. Every asset-picking arm reports these rows; keep them UI-only
 * so incomplete returns never enter the research aggregates or either copy
 * path. Legacy persisted results predate per-arm rows — synthesize the
 * TOP_MEAN row from the latest selection snapshot for those.
 */
export function buildOngoingEventDetails(
    summary: TopMeanResultSummary,
): OngoingTopMeanEventDetail[] {
    if (Array.isArray(summary.ongoingEventDetails)) {
        return summary.ongoingEventDetails;
    }

    const latest = summary.latestSelections;
    let decisionTime: number | null = null;
    let asset: string | null = null;
    let eligibleCandidates = 0;

    if (latest) {
        const selection = latest.selections.find((candidate) => candidate.selector === "TOP_MEAN");
        if (selection?.reason !== "selected" || !selection.asset) return [];
        decisionTime = latest.decisionTime;
        asset = selection.asset;
        eligibleCandidates = Number.isFinite(selection.eligibleCandidates)
            ? Math.max(0, Math.floor(selection.eligibleCandidates))
            : 0;
    } else {
        // Backward-compatible fallback for persisted results that have the
        // current snapshot but predate latestSelections.
        const decision = summary.currentSnapshot?.decision;
        if (!decision?.asset || !Number.isFinite(decision.decisionTime)) return [];
        decisionTime = decision.decisionTime;
        asset = decision.asset;
        eligibleCandidates = Array.isArray(decision.candidates)
            ? decision.candidates.length
            : 0;
    }

    if (decisionTime === null || asset === null) return [];

    const horizonValues = summary.horizons
        .map((horizon) => {
            const source = horizon as unknown as { horizon?: unknown; bars?: unknown };
            return Number(source.horizon ?? source.bars);
        })
        .filter((horizon) => Number.isFinite(horizon) && horizon >= 1)
        .map((horizon) => Math.floor(horizon));
    const horizons = [...new Set(horizonValues.length > 0 ? horizonValues : [24])];
    const completedKeys = new Set(
        [
            ...(summary.openScoreEventDetails ?? []),
            ...(summary.annualReports ?? []).flatMap((annual) => annual.eventDetails ?? []),
        ]
            .filter((row) => row.selector === "TOP_MEAN")
            .map((row) => `${row.decisionTime}|${row.horizonBars}`),
    );

    return horizons
        .filter((horizonBars) => !completedKeys.has(`${decisionTime}|${horizonBars}`))
        .map((horizonBars) => ({
            decisionTime: decisionTime!,
            horizonBars,
            selector: "TOP_MEAN" as const,
            direction: "long" as const,
            asset,
            eligibleCandidates,
            entryTime: null,
        }));
}

export function renderTopMeanOpenScoreEventDetails(
    summary: TopMeanResultSummary,
    selector: OpenScoreUsdEventDetailSelector,
    year: number | null = null,
): string {
    const causalField = CAUSAL_ARM_FIELDS.find((field) => REPLAY_ARM_TO_FINDER_ARM[field] === selector);
    if (causalField && !summary.causalArmDefinitions) return `<div class="batch-open-score-details-empty">${escapeHtml(selector)}: Rerun required. This saved result predates the additional causal arms.</div>`;
    const availability = causalField ? `<pre class="batch-report-pre">${escapeHtml(formatCausalArmAvailabilityLines(summary).join("\n"))}</pre>` : "";
    if (summary.replayMode === "asset_switch") {
        return availability + renderAssetSwitchTradeDetails(summary, selector, year);
    }
    const annualReports = summary.annualReports ?? [];
    const ongoingRows = buildOngoingEventDetails(summary);
    // Year slice: a client-side filter on decision time (UTC). It narrows
    // the rows the browser already holds — no additional server data.
    const yearMatches = year === null
        ? (): boolean => true
        : (decisionTimeSec: number): boolean =>
            new Date(decisionTimeSec * 1000).getUTCFullYear() === year;
    // The wire payload bounds the per-row detail arrays to the most
    // recent rows of the full window and drops per-year rows entirely
    // (coordinator wire-safety; disk/archive keep all rows). The *Count
    // scalars carry the pre-cap totals so the truncation is loud here
    // instead of silent.
    const fullWindowTruncated = (summary.openScoreEventDetailCount ?? 0)
        > (summary.openScoreEventDetails?.length ?? 0);
    const truncatedAnnual = annualReports.filter(
        (annual) => Array.isArray(annual.eventDetails)
            && (annual.eventDetailCount ?? 0) > annual.eventDetails!.length,
    );
    const annualRowsNotShipped = annualReports.some(
        (annual) => !Array.isArray(annual.eventDetails) && (annual.eventDetailCount ?? 0) > 0,
    );
    const hasAnnualDetailData = annualReports.some(
        (annual) => Array.isArray(annual.eventDetails) && annual.eventDetails.length > 0,
    );
    const annualSections = annualReports
        .map((annual): TopMeanOpenScoreDetailSection => ({
            label: `Calendar Year ${annual.year}`,
            rows: (annual.eventDetails ?? []).filter((row) =>
                row.selector === selector
                && yearMatches(row.decisionTime)
                // A year selection only shows its own annual section.
                && (year === null || annual.year === year)
            ),
            ongoingRows: ongoingRows.filter((row) => {
                const rowYear = new Date(row.decisionTime * 1000).getUTCFullYear();
                return row.selector === selector
                    && rowYear === annual.year
                    && row.decisionTime >= annual.sampleFromSec
                    && row.decisionTime <= annual.sampleToSec
                    && yearMatches(row.decisionTime);
            }),
        }))
        .filter((section) => section.rows.length > 0 || section.ongoingRows.length > 0);
    const sections = hasAnnualDetailData
        ? annualSections
        : [{
            label: year !== null
                ? `Selected Window — Calendar Year ${year}`
                : "Selected Window",
            rows: (summary.openScoreEventDetails ?? []).filter(
                (row) => row.selector === selector && yearMatches(row.decisionTime),
            ),
            ongoingRows: ongoingRows.filter(
                (row) => row.selector === selector && yearMatches(row.decisionTime),
            ),
        } satisfies TopMeanOpenScoreDetailSection];
    let html = `<div class="batch-open-score-details-heading">OPEN_SCORE Event Details — ${escapeHtml(selector)}</div>`;
    html += `<div class="batch-open-score-details-note">Showing ${escapeHtml(selector)} only. Return is the selected asset's net USD return after configured slippage and commission; control is the selector-specific comparison pool (for TOP_MEAN_RAW_UNIQUE, the TOP_MEAN tied set, including the selected asset). Selections whose horizon is incomplete are shown as ONGOING for every arm; their Return column is the unrealized mark-to-market return at data end and Control/Delta are intentionally n/a. These rows are intentionally excluded from Copy OPEN_SCORE and Copy Result.</div>`;
    if (fullWindowTruncated || truncatedAnnual.length > 0 || annualRowsNotShipped) {
        const truncationParts: string[] = [];
        if (fullWindowTruncated) {
            truncationParts.push(
                `full window: most recent ${(summary.openScoreEventDetails?.length ?? 0).toLocaleString()} of ${(summary.openScoreEventDetailCount ?? 0).toLocaleString()} rows`,
            );
        }
        for (const annual of truncatedAnnual) {
            truncationParts.push(
                `${annual.year}: most recent ${(annual.eventDetails?.length ?? 0).toLocaleString()} of ${(annual.eventDetailCount ?? 0).toLocaleString()} rows`,
            );
        }
        if (annualRowsNotShipped) {
            truncationParts.push(
                "per-year detail rows are not included in the live result — see the research archive or the server result.json",
            );
        }
        if (year !== null && fullWindowTruncated) {
            truncationParts.push(
                `the ${year} slice filters the shipped most-recent full-window rows, so older events of ${year} may be missing`,
            );
        }
        html += `<div class="batch-report-warning">TRUNCATED FOR THE UI — ${escapeHtml(truncationParts.join("; "))}.</div>`;
    }
    if (sections.length === 0 || sections.every((section) => section.rows.length === 0 && section.ongoingRows.length === 0)) {
        html += `<div class="batch-open-score-details-empty">No eligible ${escapeHtml(selector)} events for this replay window.</div>`;
        return html;
    }
    for (const section of sections) {
        const rowCount = section.rows.length + section.ongoingRows.length;
        html += `<details open class="batch-open-score-details-section">`;
        html += `<summary>${escapeHtml(section.label)} | ${escapeHtml(rowCount.toLocaleString())} selector rows</summary>`;
        html += `<div class="batch-open-score-details-scroll"><table class="finder-table batch-open-score-details-table">`;
        html += `<thead><tr><th>Decision UTC</th><th>Entry UTC</th><th>Exit UTC</th><th>Horizon</th><th>Selector</th><th>Side</th><th>Asset</th><th>Return</th><th>Control</th><th>Delta</th><th>Pool</th></tr></thead><tbody>`;
        const detailRows = [
            ...section.rows.map((row) => ({ row, ongoing: false as const })),
            ...section.ongoingRows.map((row) => ({ row, ongoing: true as const })),
        ].sort((a, b) =>
            a.row.decisionTime - b.row.decisionTime
            || a.row.horizonBars - b.row.horizonBars
            || Number(a.ongoing) - Number(b.ongoing),
        );
        for (const detailRow of detailRows) {
            html += detailRow.ongoing
                ? renderOngoingTopMeanEventDetailRow(detailRow.row)
                : renderTopMeanOpenScoreEventDetailRow(detailRow.row);
        }
        html += `</tbody></table></div></details>`;
    }
    return availability + html;
}

function selectorArm(selector: OpenScoreUsdEventDetailSelector): ReplayArmField | null {
    const mapping: Partial<Record<OpenScoreUsdEventDetailSelector, ReplayArmField>> = {
        ...Object.fromEntries(CAUSAL_ARM_FIELDS.map((field) => [REPLAY_ARM_TO_FINDER_ARM[field], field])),
        TOP_RAW: "topRaw",
        TOP_MEAN: "topMean",
        TOP_MEAN_RAW_UNIQUE: "topMeanRawUnique",
        TOP_RAW_PROFIT: "topRawProfit",
        TOP_MEAN_PROFIT: "topMeanProfit",
        TOP_RAW_PROFIT_NOW: "topRawProfitNow",
        TOP_MEAN_PROFIT_NOW: "topMeanProfitNow",
        TOP_RAW_PROFIT_NOW_CONF: "topRawProfitNowConf",
        TOP_Z: "topZ",
        BOT_RAW: "botRaw",
        BOT_MEAN: "botMean",
        BOT_MEAN_RAW_UNIQUE: "botMeanRawUnique",
        BOT_RAW_PROFIT_NOW: "botRawProfitNow",
        BOT_MEAN_PROFIT_NOW: "botMeanProfitNow",
        BOT_Z: "botZ",
    };
    return mapping[selector] ?? null;
}

function renderAssetSwitchTradeDetails(
    summary: TopMeanResultSummary,
    selector: OpenScoreUsdEventDetailSelector,
    year: number | null,
): string {
    const arm = selectorArm(selector);
    const annuals = summary.annualReports ?? [];
    const selectedAnnuals = year === null ? [] : annuals.filter((annual) => annual.year === year);
    const annualSection = selectedAnnuals[0]?.assetSwitch;
    const annualTradeCount = annualSection?.tradeCount ?? annualSection?.trades?.length ?? 0;
    const annualPreviewMissing = !!annualSection
        && annualTradeCount > 0
        && (annualSection.trades?.length ?? 0) === 0;
    const usesFullWindowPreview = year !== null && (!annualSection || annualPreviewMissing);
    const section = year === null
        ? summary.assetSwitch
        : usesFullWindowPreview
            ? summary.assetSwitch
            : annualSection;
    const rows = (section?.trades ?? []).filter((trade) =>
        arm !== null
        && trade.arm === arm
        && (year === null || new Date(trade.decisionTimeSec * 1000).getUTCFullYear() === year),
    );
    const total = section?.tradeCount ?? section?.trades?.length ?? 0;
    const shipped = section?.trades?.length ?? 0;
    let html = `<div class="batch-open-score-details-heading">Asset-Switch Trade Details — ${escapeHtml(selector)}</div>`;
    html += `<div class="batch-open-score-details-note">These are filled long-only position records from an independent path-dependent replay. Each entry uses fixed $1,000 notional; net P&amp;L includes entry and exit costs. An open row is marked at the last closed candle available at that replay window's end. No horizon or random-control comparison is implied.</div>`;
    if (usesFullWindowPreview && year !== null) {
        const explanation = annualPreviewMissing
            ? `The independent ${year} replay summary has ${annualTradeCount.toLocaleString()} trades but no retained annual preview.`
            : `No independent annual replay section is available for ${year}.`;
        html += `<div class="batch-report-warning">${escapeHtml(explanation)} Showing the full-window preview filtered by UTC decision year; this is not an independent annual replay.</div>`;
    }
    if (total > shipped) {
        html += `<div class="batch-report-warning">TRUNCATED FOR THE UI — the wire contains the most recent ${shipped.toLocaleString()} of ${total.toLocaleString()} trade records across all arms; this view shows ${rows.length.toLocaleString()} rows for the selected arm.</div>`;
    }
    if (rows.length === 0) {
        const source = usesFullWindowPreview ? "full-window preview" : "this replay window";
        html += `<div class="batch-open-score-details-empty">No ${escapeHtml(selector)} trade records in ${source}${year === null ? "" : ` for ${year}`}.</div>`;
        return html;
    }
    const time = (value: number | null): string => value === null
        ? "open"
        : new Date(value * 1000).toISOString().slice(0, 19).replace("T", " ");
    const money = (value: number | null): string => value === null || !Number.isFinite(value)
        ? "n/a"
        : `${value >= 0 ? "+" : "−"}$${Math.abs(value).toFixed(2)}`;
    const sectionLabel = year === null
        ? "Full window"
        : usesFullWindowPreview
            ? `Filtered Full-Window Preview — Calendar Year ${year}`
            : `Independent Calendar Year ${year}`;
    html += `<details open class="batch-open-score-details-section"><summary>${sectionLabel} | ${rows.length.toLocaleString()} trade records</summary>`;
    html += `<div class="batch-open-score-details-scroll"><table class="finder-table batch-open-score-details-table"><thead><tr><th>Decision UTC</th><th>Entry UTC</th><th>Exit UTC</th><th>Asset</th><th>Net P&amp;L</th><th>Costs</th><th>Holding</th><th>Status</th></tr></thead><tbody>`;
    for (const trade of rows) {
        const cost = trade.entryCost + trade.exitCost;
        const holding = trade.holdingDurationSec === null
            ? "open"
            : `${(trade.holdingDurationSec / 86400).toFixed(1)} days`;
        html += `<tr><td>${escapeHtml(time(trade.decisionTimeSec))}</td><td>${escapeHtml(time(trade.entryTimeSec))}</td><td>${escapeHtml(time(trade.exitTimeSec))}</td><td><strong>${escapeHtml(trade.asset)}</strong></td><td>${escapeHtml(money(trade.netPnl))}</td><td>$${cost.toFixed(2)}</td><td>${escapeHtml(holding)}</td><td>${escapeHtml(trade.status.toUpperCase())}</td></tr>`;
    }
    html += `</tbody></table></div></details>`;
    return html;
}

function renderTopMeanOpenScoreEventDetailRow(row: OpenScoreUsdEventDetail): string {
    const formatTime = (timeSec: number): string =>
        new Date(timeSec * 1000).toISOString().slice(0, 19).replace("T", " ");
    const formatReturn = (value: number): string =>
        `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
    const sideClass = row.direction === "long" ? "is-positive" : "is-negative";
    const returnClass = row.selectedReturn >= 0 ? "is-positive" : "is-negative";
    const deltaClass = row.delta >= 0 ? "is-positive" : "is-negative";
    return `<tr>` +
        `<td>${escapeHtml(formatTime(row.decisionTime))}</td>` +
        `<td>${escapeHtml(formatTime(row.entryTime))}</td>` +
        `<td>${escapeHtml(formatTime(row.exitTime))}</td>` +
        `<td>${escapeHtml(row.horizonBars)}</td>` +
        `<td><strong>${escapeHtml(row.selector)}</strong></td>` +
        `<td class="${sideClass}">${escapeHtml(row.direction.toUpperCase())}</td>` +
        `<td><strong>${escapeHtml(row.asset)}</strong></td>` +
        `<td class="${returnClass}">${escapeHtml(formatReturn(row.selectedReturn))}</td>` +
        `<td>${escapeHtml(formatReturn(row.controlReturn))}</td>` +
        `<td class="${deltaClass}">${escapeHtml(formatReturn(row.delta))}</td>` +
        `<td>${escapeHtml(row.eligibleCandidates)}</td>` +
        `</tr>`;
}

function renderOngoingTopMeanEventDetailRow(row: OngoingTopMeanEventDetail): string {
    const formatTime = (timeSec: number): string =>
        new Date(timeSec * 1000).toISOString().slice(0, 19).replace("T", " ");
    const entryLabel = row.entryTime !== null && Number.isFinite(row.entryTime)
        ? formatTime(row.entryTime)
        : "NEXT BAR";
    // Return column shows the unrealized mark-to-market return at the
    // target dataset end when the engine computed one; n/a otherwise.
    // Control/Delta have no realized comparison and stay n/a.
    const unrealized = row.unrealizedReturn;
    const unrealizedLabel = unrealized !== null && unrealized !== undefined && Number.isFinite(unrealized)
        ? `${unrealized >= 0 ? "+" : ""}${(unrealized * 100).toFixed(2)}%`
        : "n/a";
    const unrealizedClass = unrealized !== null && unrealized !== undefined && unrealized >= 0
        ? "is-positive"
        : "is-negative";
    return `<tr class="batch-open-score-details-row-ongoing">` +
        `<td>${escapeHtml(formatTime(row.decisionTime))}</td>` +
        `<td>${escapeHtml(entryLabel)}</td>` +
        `<td><strong>${escapeHtml("ONGOING")}</strong></td>` +
        `<td>${escapeHtml(row.horizonBars)}</td>` +
        `<td><strong>${escapeHtml(row.selector)}</strong> <span class="batch-top-badge">ONGOING</span></td>` +
        `<td class="is-positive">${escapeHtml(row.direction.toUpperCase())}</td>` +
        `<td><strong>${escapeHtml(row.asset)}</strong></td>` +
        `<td class="${unrealizedClass}">${escapeHtml(unrealizedLabel)}</td>` +
        `<td>${escapeHtml("n/a")}</td>` +
        `<td>${escapeHtml("n/a")}</td>` +
        `<td>${escapeHtml(row.eligibleCandidates)}</td>` +
        `</tr>`;
}
