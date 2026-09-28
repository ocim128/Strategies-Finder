/**
 * `reportLines` assembly for the OPEN_SCORE USD replay result. The emitted
 * text is opaque and copy-path-tested; line order and formatting are frozen.
 */
import type {
    AssetSelectionSummary,
    DegreeSummary,
    OpenScoreUsdCapTiltWeight,
    OpenScoreUsdReplayResult,
    ReplayComparison,
    SelectorPnlSummary,
    TopMeanPortfolioSummary,
} from "./types";

const fmtPct = (x: number | null): string => (x === null || !Number.isFinite(x) ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`);
const fmtNum = (x: number | null): string => (x === null || !Number.isFinite(x) ? "n/a" : x.toFixed(2));
const fmtUsd = (x: number | null): string => (x === null || !Number.isFinite(x)
    ? "n/a"
    : `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`);

export function buildReportLines(args: {
    pairs: number; assets: number; complete: boolean; omittedPairs: number; omittedAssets: number;
    totalEvents: number; candidateEvents: number; eligibleEvents: number; horizons: OpenScoreUsdReplayResult["horizons"];
    degree: DegreeSummary; warnings: string[]; startedAt: number; horizonsList: number[];
    interval: string | null; sampleFromSec: number | null; sampleToSec: number | null;
    slippageRate: number; commissionRate: number;
    capTilt: OpenScoreUsdCapTiltWeight;
    /** Present only while the tilt was active (effective weight ≠ off). */
    capTiltCoverage?: { long: number; known: number; weighted: number; unknown: number } | null;
    capTiltWindowCoverage: { long: number; known: number; weighted: number; unknown: number };
    capTiltCarryInCoverage: { long: number; known: number; weighted: number; unknown: number };
    capTiltUnknownAssets: Map<string, number>;
}): string[] {
    const lines: string[] = [];
    const status = args.complete ? "DATA_COMPLETE" : "DATA_INCOMPLETE";
    const comparisonLine = (label: string, comparison: ReplayComparison): string =>
        `${label.padEnd(14)} n=${comparison.events} top=${fmtPct(comparison.topMean)} rand=${fmtPct(comparison.randomMean)} ` +
        `deltaMed=${fmtPct(comparison.delta)} CI95=[${fmtPct(comparison.ciLower)},${fmtPct(comparison.ciUpper)}] ` +
        `+blocks=${comparison.positiveBlocks}/${comparison.totalBlocks}`;
    const pnlLine = (label: string, summary: SelectorPnlSummary): string => {
        const average = summary.trades > 0 && summary.totalReturn !== null
            ? summary.totalReturn / summary.trades
            : null;
        return `${label.padEnd(20)} trades=${summary.trades} avg/trade=${fmtPct(average)} ` +
            `sharpe=${fmtNum(summary.sharpe)} winRate=${summary.winRate === null ? "n/a" : (summary.winRate * 100).toFixed(1) + "%"}`;
    };
    const portfolioLine = (label: string, summary: TopMeanPortfolioSummary): string =>
        `${label}_1K_PORTFOLIO trades=${summary.trades}/${summary.eligibleSignals} ` +
        `pnl=${fmtUsd(summary.netPnl)} avg=${fmtUsd(summary.averagePnl)} ` +
        `winRate=${summary.winRate === null ? "n/a" : (summary.winRate * 100).toFixed(1) + "%"} ` +
        `realizedMaxDD=${fmtUsd(summary.maxRealizedDrawdown)} peakPos=${summary.peakConcurrentPositions} ` +
        `peakCapital=${fmtUsd(summary.peakCapital)} return/peak=${fmtPct(summary.returnOnPeakCapital)} ` +
        `skippedTie=${summary.skippedTies} skippedActive=${summary.skippedActiveAsset}`;
    const selectedAssetsLine = (label: string, byAsset: AssetSelectionSummary[]): string => {
        const breakdown = byAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        return `${label} selected assets = ${breakdown || "n/a"}${byAsset.length > 5 ? ` | other=${byAsset.length - 5} assets` : ""}`;
    };
    lines.push(`OPEN_SCORE USD | ${status} | pairs=${args.pairs} assets=${args.assets} events=${args.totalEvents} comparable=${args.candidateEvents} eligible=${args.eligibleEvents}`);
    lines.push(`config | interval=${args.interval ?? "n/a"} window=${args.sampleFromSec === null ? "start" : new Date(args.sampleFromSec * 1000).toISOString().slice(0, 10)}..${args.sampleToSec === null ? "end" : new Date(args.sampleToSec * 1000).toISOString().slice(0, 10)} horizons=[${args.horizonsList.join(",")}] slippageRate=${args.slippageRate} commissionRate=${args.commissionRate} capTilt=${args.capTilt}`);
    if (args.capTilt === "smallBase2x") {
        lines.push("cap tilt | base leg of long pairs x2 when base cap < quote cap at entry; unknown caps weight 1; same weight applied at exit (round-trip neutral)");
    } else if (args.capTilt === "largeBase2x") {
        lines.push("cap tilt | base leg of long pairs x2 when base cap > quote cap at entry; unknown caps weight 1; same weight applied at exit (round-trip neutral)");
    } else if (args.capTilt === "similarCap2x") {
        lines.push("cap tilt | both legs of long pairs x2 (+2/-2) when larger/smaller entry cap <= 3; unknown or nonpositive caps weight 1; shorts unchanged; same weights applied at exit (round-trip neutral)");
    }
    if (args.capTiltCoverage) {
        const cov = args.capTiltCoverage;
        // This legacy count covers all scanned history, not the report window.
        lines.push(`cap tilt coverage | long=${cov.long} known=${cov.known} weighted=${cov.weighted} unknown=${cov.unknown}`);
        lines.push("cap tilt coverage scope | above=all historical long entries; below=report-window entries and pre-window positions still open at window start; caps classified at original entry");
        for (const [label, coverage] of [
            ["entries in window", args.capTiltWindowCoverage],
            ["carried into window", args.capTiltCarryInCoverage],
        ] as const) {
            lines.push(`cap tilt ${label} | long=${coverage.long} known=${coverage.known} weighted=${coverage.weighted} unknown=${coverage.unknown}`);
        }
        if (args.capTiltUnknownAssets.size > 0) {
            const missing = [...args.capTiltUnknownAssets].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
            lines.push(`cap tilt unknown assets | window entries + carry-in, missing leg counts (a trade can count twice): ${missing.map(([asset, count]) => `${asset}=${count}`).join(", ")}`);
            lines.push("cap tilt coverage warning | unknown entry caps use weight 1; check marketcap files and first covered dates for the listed assets before comparing tilted runs");
        }
    }
    lines.push(`retained pair degree min/median/max = ${args.degree.min}/${fmtNum(args.degree.median)}/${args.degree.max}`);
    lines.push("controls | TOP_MEAN=raw/activePairs TOP_RAW_PROFIT=raw score counted only from pairs whose pair backtest netted >0 (look-ahead) TOP_MEAN_PROFIT=that raw / open profitable-pair count TOP_RAW_PROFIT_NOW=same filter using only pnl realized at or before each event (causal) TOP_MEAN_PROFIT_NOW=that raw / open realized-profitable-pair count TOP_RAW_PROFIT_NOW_CONF=causal PROFIT_NOW score weighted by realized net/gross P&L consistency with one-trade shrinkage TOP_Z=causal PROFIT_NOW pool ranked by per-asset standardized score surprise vs the asset's own prior events");
    lines.push("TOP_MEAN_RAW_UNIQUE rule | TOP_MEAN tied set -> unique raw-score maximum; residual raw ties skipped; control=mean return of the TOP_MEAN tied set");
    lines.push("BOT_* rule | inverted negative-control arms: same pool, eligibility, and tie-break as the TOP_* twin, but the LOWEST rank value is selected (long side; leave-one-out pool control unchanged). BOT_MEAN_RAW_UNIQUE = bottom-mean tied set -> unique raw-score minimum; residual raw ties skipped; control=mean return of that tied set");
    lines.push("pnl model | OVERLAP=long selector vs same-pool random positive, every eligible event; *_1K=$1000/trade, exact selector ties skipped, one open trade per asset; deltaMed=median of per-event (selected - pool mean) deltas so one outlier mover cannot flip a window; CI95 block-bootstraps that median; selected-assets breakdown lines still report per-asset MEAN deltas");
    for (const h of args.horizons) {
        const coverageRate = args.candidateEvents > 0 ? h.topRaw.events / args.candidateEvents : 0;
        const coverageStatus = h.topRaw.events === 0
            ? "NO_USABLE_EVENTS"
            : h.topRaw.events < args.candidateEvents
                ? "PARTIAL"
                : "FULL";
        lines.push(`--- horizon ${h.bars} bar(s) | coverage=${h.topRaw.events}/${args.candidateEvents} (${(coverageRate * 100).toFixed(1)}%) ${coverageStatus} ---`);
        lines.push(comparisonLine("TOP_RAW_PROFIT_NOW", h.topRawProfitNow));
        lines.push(comparisonLine(`RAW_PROFIT_NOW_EX_${h.topRawProfitNowDominantAsset ?? "NONE"}`, h.topRawProfitNowExDominant));
        lines.push(comparisonLine("TOP_MEAN_PROFIT_NOW", h.topMeanProfitNow));
        lines.push(comparisonLine(`MEAN_PROFIT_NOW_EX_${h.topMeanProfitNowDominantAsset ?? "NONE"}`, h.topMeanProfitNowExDominant));
        lines.push(comparisonLine("TOP_RAW_PROFIT_NOW_CONF", h.topRawProfitNowConf));
        lines.push(comparisonLine(`RAW_PROFIT_NOW_CONF_EX_${h.topRawProfitNowConfDominantAsset ?? "NONE"}`, h.topRawProfitNowConfExDominant));
        lines.push(comparisonLine("TOP_Z", h.topZ));
        lines.push(comparisonLine(`TOP_Z_EX_${h.topZDominantAsset ?? "NONE"}`, h.topZExDominant));
        lines.push(comparisonLine("TOP_RAW", h.topRaw));
        lines.push(comparisonLine("TOP_MEAN", h.topMean));
        lines.push(comparisonLine("TOP_MEAN_RAW_UNIQUE", h.topMeanRawUnique));
        lines.push(comparisonLine(`TOP_MEAN_RAW_UNIQUE_EX_${h.topMeanRawUniqueDominantAsset ?? "NONE"}`, h.topMeanRawUniqueExDominant));
        lines.push(comparisonLine("TOP_RAW_PROFIT", h.topRawProfit));
        lines.push(comparisonLine(`RAW_PROFIT_EX_${h.topRawProfitDominantAsset ?? "NONE"}`, h.topRawProfitExDominant));
        lines.push(comparisonLine("TOP_MEAN_PROFIT", h.topMeanProfit));
        lines.push(comparisonLine(`MEAN_PROFIT_EX_${h.topMeanProfitDominantAsset ?? "NONE"}`, h.topMeanProfitExDominant));
        // Inverted (negative-control) arms: lowest rank value from the same
        // pools as their TOP_* twins.
        lines.push(comparisonLine("BOT_RAW_PROFIT_NOW", h.botRawProfitNow));
        lines.push(comparisonLine(`BOT_RAW_PROFIT_NOW_EX_${h.botRawProfitNowDominantAsset ?? "NONE"}`, h.botRawProfitNowExDominant));
        lines.push(comparisonLine("BOT_MEAN_PROFIT_NOW", h.botMeanProfitNow));
        lines.push(comparisonLine(`BOT_MEAN_PROFIT_NOW_EX_${h.botMeanProfitNowDominantAsset ?? "NONE"}`, h.botMeanProfitNowExDominant));
        lines.push(comparisonLine("BOT_Z", h.botZ));
        lines.push(comparisonLine(`BOT_Z_EX_${h.botZDominantAsset ?? "NONE"}`, h.botZExDominant));
        lines.push(comparisonLine("BOT_RAW", h.botRaw));
        lines.push(comparisonLine(`BOT_RAW_EX_${h.botRawDominantAsset ?? "NONE"}`, h.botRawExDominant));
        lines.push(comparisonLine("BOT_MEAN", h.botMean));
        lines.push(comparisonLine(`BOT_MEAN_EX_${h.botMeanDominantAsset ?? "NONE"}`, h.botMeanExDominant));
        lines.push(comparisonLine("BOT_MEAN_RAW_UNIQUE", h.botMeanRawUnique));
        lines.push(comparisonLine(`BOT_MEAN_RAW_UNIQUE_EX_${h.botMeanRawUniqueDominantAsset ?? "NONE"}`, h.botMeanRawUniqueExDominant));
        lines.push(pnlLine("TOP_MEAN_PNL", h.pnl.topMean));
        lines.push(pnlLine("RANDOM_PNL", h.pnl.random));
        lines.push(portfolioLine("TOP_MEAN", h.pnl.topMeanPortfolio));
        lines.push(comparisonLine(`RAW_EX_${h.dominantAsset ?? "NONE"}`, h.topRawExDominant));
        lines.push(comparisonLine(`MEAN_EX_${h.topMeanDominantAsset ?? "NONE"}`, h.topMeanExDominant));
        lines.push(comparisonLine(`MEAN_EX_TOPCONTRIB_${h.topMeanTopContribAsset ?? "NONE"}`, h.topMeanExTopContrib));
        // Per-selector tie rate.
        const tieLine = (name: string, k: keyof typeof h.tieRates): string =>
            `${name}=${h.tieRates[k].sameSelection}/${h.tieRates[k].events} (${h.tieRates[k].rate === null ? "n/a" : (h.tieRates[k].rate! * 100).toFixed(1) + "%"})`;
        const tieTokens = [
            tieLine("RAW", "RAW"),
            tieLine("MEAN", "MEAN"),
        ];
        lines.push(`tie rates | ${tieTokens.join(" ")}`);
        const assetBreakdown = h.topRawByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`TOP_RAW selected assets = ${assetBreakdown || "n/a"}${h.topRawByAsset.length > 5 ? ` | other=${h.topRawByAsset.length - 5} assets` : ""}`);
        const topMeanBreakdown = h.topMeanByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`TOP_MEAN selected assets = ${topMeanBreakdown || "n/a"}${h.topMeanByAsset.length > 5 ? ` | other=${h.topMeanByAsset.length - 5} assets` : ""}`);
        const topMeanRawUniqueBreakdown = h.topMeanRawUniqueByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`TOP_MEAN_RAW_UNIQUE selected assets = ${topMeanRawUniqueBreakdown || "n/a"}${h.topMeanRawUniqueByAsset.length > 5 ? ` | other=${h.topMeanRawUniqueByAsset.length - 5} assets` : ""}`);
        const topRawProfitBreakdown = h.topRawProfitByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`TOP_RAW_PROFIT selected assets = ${topRawProfitBreakdown || "n/a"}${h.topRawProfitByAsset.length > 5 ? ` | other=${h.topRawProfitByAsset.length - 5} assets` : ""}`);
        const topMeanProfitBreakdown = h.topMeanProfitByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`TOP_MEAN_PROFIT selected assets = ${topMeanProfitBreakdown || "n/a"}${h.topMeanProfitByAsset.length > 5 ? ` | other=${h.topMeanProfitByAsset.length - 5} assets` : ""}`);
        const topRawProfitNowBreakdown = h.topRawProfitNowByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`TOP_RAW_PROFIT_NOW selected assets = ${topRawProfitNowBreakdown || "n/a"}${h.topRawProfitNowByAsset.length > 5 ? ` | other=${h.topRawProfitNowByAsset.length - 5} assets` : ""}`);
        const topMeanProfitNowBreakdown = h.topMeanProfitNowByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`TOP_MEAN_PROFIT_NOW selected assets = ${topMeanProfitNowBreakdown || "n/a"}${h.topMeanProfitNowByAsset.length > 5 ? ` | other=${h.topMeanProfitNowByAsset.length - 5} assets` : ""}`);
        const topRawProfitNowConfBreakdown = h.topRawProfitNowConfByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`TOP_RAW_PROFIT_NOW_CONF selected assets = ${topRawProfitNowConfBreakdown || "n/a"}${h.topRawProfitNowConfByAsset.length > 5 ? ` | other=${h.topRawProfitNowConfByAsset.length - 5} assets` : ""}`);
        const topZBreakdown = h.topZByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`TOP_Z selected assets = ${topZBreakdown || "n/a"}${h.topZByAsset.length > 5 ? ` | other=${h.topZByAsset.length - 5} assets` : ""}`);
        lines.push(selectedAssetsLine("BOT_RAW", h.botRawByAsset));
        lines.push(selectedAssetsLine("BOT_MEAN", h.botMeanByAsset));
        lines.push(selectedAssetsLine("BOT_MEAN_RAW_UNIQUE", h.botMeanRawUniqueByAsset));
        lines.push(selectedAssetsLine("BOT_RAW_PROFIT_NOW", h.botRawProfitNowByAsset));
        lines.push(selectedAssetsLine("BOT_MEAN_PROFIT_NOW", h.botMeanProfitNowByAsset));
        lines.push(selectedAssetsLine("BOT_Z", h.botZByAsset));
        lines.push(`active pair count at events min/median/max = ${h.candidateDegree.min}/${fmtNum(h.candidateDegree.median)}/${h.candidateDegree.max} topAssetShare=${h.candidateDegree.topAssetShare === null ? "n/a" : (h.candidateDegree.topAssetShare * 100).toFixed(1) + "%"}`);
        lines.push(`selected TOP_RAW retained degree min/median/max = ${h.selectedDegree.min}/${fmtNum(h.selectedDegree.median)}/${h.selectedDegree.max}`);
    }
    for (const w of args.warnings) lines.push(`WARN: ${w}`);
    lines.push(`elapsed=${((Date.now() - args.startedAt) / 1000).toFixed(1)}s`);
    return lines;
}
