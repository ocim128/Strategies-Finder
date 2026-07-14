/**
 * Counterfactual Timing Surface Miner — Copy/UI formatting pure helpers.
 *
 * Pure leaf module. Returns pipe-delimited string[] for the Copy button,
 * mirroring `formatPortfolioFitSummary` in `batch-portfolio-fit-summary.ts`.
 *
 * The `HISTORICAL_CONDITIONAL` evidence-scope label and the
 * `exploitEligible: false` flag appear in every Copy output.
 */
import { shortFingerprint } from "./batch-portfolio-fit-summary";
import type {
    TimingSurfaceResult,
    TimingSurfaceRow,
} from "./batch-timing-surface-types";

/**
 * Formats the Timing Surface result as pipe-delimited lines for the Copy
 * button. Section tag: `TIMING_SURFACE`. The header lines always include the
 * evidence scope and exploit-eligibility state verbatim.
 */
export function formatTimingSurfaceSummary(result: TimingSurfaceResult): string[] {
    const lines: string[] = [];
    lines.push(
        `TIMING_SURFACE | Generated ${new Date(result.generatedAt).toISOString()} | asOf ${result.asOfTimeKey ?? "unknown"} | fingerprint ${shortFingerprint(result.fingerprint)} | interval ${result.interval}`,
    );
    lines.push(
        `TIMING_SURFACE | EVIDENCE_SCOPE ${result.evidenceScope} | EXPLOIT_ELIGIBLE ${result.exploitEligible ? "true" : "false"}`,
    );
    lines.push(
        `TIMING_SURFACE | PHASES_1_TO_4_ONLY | HISTORICAL_CONDITIONAL | no independent OOS; exploit requires Phase 5 matured shadow episodes`,
    );
    const s = result.stability;
    const cm = result.costModel;
    lines.push(
        `TIMING_SURFACE | stability reruns ${s.reruns} | subset ${s.subsetSize} | seed ${s.seed} | totalPairs ${s.totalPairs} | targetAssets ${s.targetAssets}`,
    );
    lines.push(
        `TIMING_SURFACE | cost commissionPct ${cm.commissionPercent} | slippageBps ${cm.slippageBps} | executionModel ${cm.executionModel}`,
    );
    const actionable = result.rows.filter((r) => r.decision === "ENTER_NOW" || r.decision === "WAIT_1" || r.decision === "WAIT_2" || r.decision === "WAIT_3");
    const watch = result.rows.filter((r) => r.decision === "WATCH");
    const skip = result.rows.filter((r) => r.decision === "SKIP");
    const invalid = result.rows.filter((r) => r.decision === "INVALID");
    lines.push(
        `TIMING_SURFACE | rows ${result.rows.length} | actionable ${actionable.length} | watch ${watch.length} | skip ${skip.length} | invalid ${invalid.length}`,
    );
    const p = result.profile;
    const boundaryPurgeRate = p.boundaryCheckedSamples > 0
        ? `${((p.boundaryPurgedSamples / p.boundaryCheckedSamples) * 100).toFixed(1)}%`
        : "n/a";
    lines.push(
        `TIMING_SURFACE | profile targetLoadMs ${p.targetLoadMs} | subsetMs ${p.subsetReconstructionMs} | analogMs ${p.analogReconstructionMs} | engineMs ${p.engineMs} | aggregationMs ${p.aggregationMs} | targets ${p.targetsEvaluated} | reruns ${p.rerunsEvaluated} | cellsEvaluated ${p.cellsEvaluated} | cellsEmitted ${p.cellsEmitted} | boundaryPurged ${p.boundaryPurgedSamples}/${p.boundaryCheckedSamples} (${boundaryPurgeRate})`,
    );
    for (const warning of result.warnings) {
        lines.push(`TIMING_SURFACE | WARNING | ${warning}`);
    }
    lines.push("TIMING_SURFACE | --- Per-row evidence ---");
    for (const row of result.rows) {
        lines.push(formatTimingSurfaceRow(row));
        const cells = result.rowCells[`${row.asset}|${row.direction}`];
        if (cells && cells.cells.length > 0) {
            lines.push(formatTimingSurfaceRowCells(cells));
        }
    }
    return lines;
}

function formatTimingSurfaceRow(row: TimingSurfaceRow): string {
    const delayHorizon = row.chosenDelay !== null && row.chosenHorizon !== null
        ? `delay ${row.chosenDelay} | horizon ${row.chosenHorizon}b`
        : "delay -- | horizon --";
    const evidenceCell = row.evidenceDelay != null && row.evidenceHorizon != null
        ? `evidenceCell d${row.evidenceDelay}h${row.evidenceHorizon}`
        : "evidenceCell --";
    const reval = row.revalidationBarIndex !== null ? `revalidationBar ${row.revalidationBarIndex}` : "revalidationBar --";
    return [
        "TIMING_SURFACE",
        `ROW | ${row.asset} | ${row.direction} | ${row.decision}`,
        delayHorizon,
        evidenceCell,
        reval,
        `asOf ${row.asOfTimeKey ?? "--"}`,
        `sourceStability ${row.sourceStabilityAction} | sourceScore ${row.sourceTimingEdgeScore}`,
        `discoveryEp ${row.discoveryEpisodes} | selectionEp ${row.selectionEpisodes} | validationEp ${row.validationEpisodes}`,
        `discoveryEvalReruns ${row.discoveryEvaluatedReruns} | selectionEvalReruns ${row.selectionEvaluatedReruns} | validationEvalReruns ${row.validationEvaluatedReruns}`,
        `discoveryQualReruns ${row.discoveryQualifyingReruns} | selectionQualReruns ${row.selectionQualifyingReruns} | validationQualReruns ${row.validationQualifyingReruns}`,
        `selMedNetPct ${fmtPct(row.selectionMedianNetReturnPct)}`,
        `selP10NetPct ${fmtPct(row.selectionP10NetReturnPct)}`,
        `selMedLiftPct ${fmtPct(row.selectionMedianLiftPct)}`,
        `valMedNetPct ${fmtPct(row.validationMedianNetReturnPct)}`,
        `valP10NetPct ${fmtPct(row.validationP10NetReturnPct)}`,
        `valMedLiftPct ${fmtPct(row.validationMedianLiftPct)}`,
        `validationPositiveReruns ${row.validationPositiveReruns}/${row.validationQualifyingReruns}`,
        `selectionMedianWinRate ${fmtRate(row.medianWinRate)}`,
        `plateauNeighbors ${row.plateauPositiveNeighborCount}`,
        `reasons [${row.reasonCodes.join(",")}]`,
    ].join(" | ");
}

function formatTimingSurfaceRowCells(cells: TimingSurfaceResult["rowCells"][string]): string {
    const cellStrs = cells.cells.map((c) =>
        `(d${c.delay}h${c.horizon}: discQ${c.discoveryQualifyingReruns}/net${fmtPct(c.discoveryMedianNetReturnPct)}, selQ${c.selectionQualifyingReruns}/net${fmtPct(c.selectionMedianNetReturnPct)}, valQ${c.validationQualifyingReruns}/net${fmtPct(c.validationMedianNetReturnPct)})`);
    return `TIMING_SURFACE | CELLS | ${cellStrs.join(" ")}`;
}

function fmtPct(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return "n/a";
    return `${value.toFixed(3)}%`;
}

function fmtRate(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return "n/a";
    return `${(value * 100).toFixed(1)}%`;
}

export { shortFingerprint };
