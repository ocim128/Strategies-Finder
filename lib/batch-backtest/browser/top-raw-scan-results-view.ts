import { escapeHtml } from "../../html-escape";
import type { ScanResult } from "../top-raw-scan-contract";
import { DEFAULT_SCAN_ARM, scanArmEstimatedValue, scanArmExactValue, scanArmLabel, scanArmSampledValue } from "../top-raw-scan-arms";
import { normalizeScanFailureDiagnostics } from "../top-raw-scan-diagnostics";

/** At most 100 rows per table page; export retains the entire scalar result. */
export function renderScanResults(container: HTMLElement, result: ScanResult, page = 0): void {
    const arm = result.arm ?? DEFAULT_SCAN_ARM;
    const rows = [...result.discovery].sort((a, b) => (scanArmEstimatedValue(arm, b) ?? -Infinity) - (scanArmEstimatedValue(arm, a) ?? -Infinity) || a.asset.localeCompare(b.asset));
    const pages = Math.max(1, Math.ceil(rows.length / 100)); page = Math.max(0, Math.min(page, pages - 1));
    const table = (headers: string[], body: string) => `<div class="batch-scan-table-scroll"><table><thead><tr>${headers.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
    const candidates = [...result.finalists].sort((a, b) => (b.exactRaw ?? -Infinity) - (a.exactRaw ?? -Infinity) || a.candidateRank - b.candidateRank);
    const candidatePage = candidates.length <= 100 ? candidates : candidates.slice(page * 100, (page + 1) * 100);
    const number = (value: number | null) => value === null ? "Unavailable" : Number.isInteger(value) ? String(value) : value.toFixed(2);
    const failures = normalizeScanFailureDiagnostics(result.failureDiagnostics, result.pairCounts.failed);
    const diagnostics = failures?.total ? `<details open><summary>Failed relationships (${failures.total})</summary>
        <p>Resume retries failed relationships within this frozen snapshot. Endpoint/source problems may require syncing data and starting a new Run.</p>
        ${failures.groups.map(group => `<p>${group.count} pairs: ${escapeHtml(group.reason)}</p><pre>${escapeHtml(group.pairs.join("\n"))}</pre>`).join("")}
        ${failures.otherCount ? `<p>${failures.otherCount} additional failures; examples are bounded.</p>` : ""}</details>`
        : result.pairCounts.failed ? "<p>Failure details are unavailable in this older saved result. Resume retries failed relationships.</p>" : "";
    const armLabel = scanArmLabel(arm);
    container.innerHTML = `<p><strong>${result.globalRankingExact ? `Exact global ranking in eligible universe (${armLabel})` : `Highest ${armLabel} score among fully evaluated candidates; global ranking estimated`}</strong></p>
        <p>${escapeHtml(result.status)} · ${escapeHtml(result.reason)}${result.error ? ` · ${escapeHtml(result.error)}` : ""}</p>
        <p>Evaluation: ${escapeHtml(new Date(result.asOf * 1000).toISOString())} · cutoff: ${escapeHtml(new Date(result.cutoff * 1000).toISOString())} · ${result.eligibleAssets.length} eligible assets · ${result.exclusions.length} excluded · ${result.duplicateCount} duplicates/aliases · seed ${result.effective.seed}</p>
        <p>Discovery: ${result.pairCounts.discovery} pairs · refinement: ${result.pairCounts.refinement} new pairs · reused: ${result.pairCounts.reused} · failures: ${result.pairCounts.failed}</p>
        ${diagnostics}
        <p>Best verified positive candidates: ${escapeHtml(result.bestVerifiedCandidates.join(", ") || "None")}. Cutoff ties: ${escapeHtml(result.cutoffTies.join(", ") || "None")}; omitted: ${escapeHtml(result.omittedCutoffTies.join(", ") || "None")}.</p>
        <details><summary>Universe, exclusions and provenance</summary><pre>${escapeHtml(JSON.stringify({ fingerprint: result.fingerprint, universeHash: result.universeHash, cutoff: result.cutoff, arm, sourceRevisions: result.sourceRevisions, legEndpoints: result.legEndpoints, requested: result.requested, effective: result.effective, scoreContract: result.scoreContract, orientation: result.orientationVersion, sampling: result.samplingVersion, tieOrder: result.tieVersion, seedDerivation: result.seedDerivation, eligibleAssets: result.eligibleAssets, exclusions: result.exclusions }, null, 2))}</pre></details>
        <h4>Estimated leaders</h4><p>Page ${page + 1} of ${pages}. Discovery estimates stay frozen; incomplete coverage cannot establish a completed ranking.</p>
        <button type="button" data-scan-page="${page - 1}" ${page === 0 ? "disabled" : ""}>Previous</button> <button type="button" data-scan-page="${page + 1}" ${page + 1 >= pages ? "disabled" : ""}>Next</button>
        ${table(["Asset", `Estimated ${armLabel}`, "Sampled", "Evaluated / planned", "Flat", "Active positions", "Coverage"], rows.slice(page * 100, (page + 1) * 100).map(r => `<tr><td>${escapeHtml(r.asset)}</td><td>${number(scanArmEstimatedValue(arm, r))}</td><td>${number(scanArmSampledValue(arm, r))}</td><td>${r.evaluatedDegree} / ${r.sampledDegree}</td><td>${r.flatDegree}</td><td>${r.activePositions}</td><td>${r.coverageComplete ? "Complete sample" : "Incomplete"}</td></tr>`).join(""))}
        <h4>Fully scored candidates</h4>
        ${table(["Candidate rank", "Asset", `Exact ${armLabel} in eligible universe`, "Opponents", "Status"], candidatePage.map(r => `<tr><td>${r.candidateRank}</td><td>${escapeHtml(r.asset)}</td><td>${number(scanArmExactValue(arm, r))}</td><td>${r.evaluatedOpponents} / ${r.expectedOpponents}</td><td>${r.complete ? "Exact score in eligible universe" : "Incomplete"}</td></tr>`).join(""))}`;
}
