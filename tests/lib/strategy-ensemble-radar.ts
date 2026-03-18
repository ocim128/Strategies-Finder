import type { RadarFinding, EnsembleRunContext } from "./strategy-ensemble-types";

export function buildRadarFindings(context: EnsembleRunContext): RadarFinding[] {
    const findings: RadarFinding[] = [];
    const baseline = context.baselineBucket;
    const radarMinSamples = Math.max(context.minSamples * 3, 20);

    if (!baseline) {
        return [
            {
                label: "No actionable findings",
                detail: "The ensemble analysis did not produce enough target trades for higher-confidence signals.",
                quality: "neutral",
            },
        ];
    }

    if (context.bestBucket && context.bestBucket.samples >= radarMinSamples && baseline.avgExpectancy !== 0) {
        const lift = ((context.bestBucket.avgExpectancy - baseline.avgExpectancy) / Math.abs(baseline.avgExpectancy)) * 100;
        if (Number.isFinite(lift) && lift > 10) {
            findings.push({
                label: "Strongest expectancy lift",
                detail: `"${context.bestBucket.label}" improves expectancy by ${lift.toFixed(1)}% vs baseline (${context.bestBucket.samples} samples).`,
                quality: "positive",
            });
        }
    }

    const worstContributor = context.contributionRows.find((row) => row.deltaExpectancy > 0);
    if (worstContributor && Math.abs(worstContributor.deltaExpectancy) >= 0.1) {
        findings.push({
            label: "Weakest context family",
            detail: `Removing "${worstContributor.familyLabel}" improves active-rule expectancy by ${formatSignedCurrency(worstContributor.deltaExpectancy)}.`,
            quality: "negative",
        });
    }

    const bestReplacement = context.replacementRows[0];
    if (bestReplacement && bestReplacement.deltaExpectancyVsRemoved > 0) {
        findings.push({
            label: "Replacement candidate",
            detail: `"${bestReplacement.familyLabel}" via "${bestReplacement.configName}" adds ${formatSignedCurrency(bestReplacement.deltaExpectancyVsRemoved)} expectancy after removing the weakest family.`,
            quality: "positive",
        });
    }

    const baselineRow = context.builderRows.find((row) => row.rule === "Baseline (target only)");
    const bestDrawdownRow = context.builderRows
        .filter((row) => row.rule !== "Baseline (target only)" && row.trades >= radarMinSamples)
        .sort((left, right) => Math.abs(left.maxDrawdownPercent) - Math.abs(right.maxDrawdownPercent))[0];
    if (baselineRow && bestDrawdownRow && Math.abs(bestDrawdownRow.maxDrawdownPercent) < Math.abs(baselineRow.maxDrawdownPercent) * 0.8) {
        const reduction = ((Math.abs(baselineRow.maxDrawdownPercent) - Math.abs(bestDrawdownRow.maxDrawdownPercent)) / Math.abs(baselineRow.maxDrawdownPercent)) * 100;
        findings.push({
            label: "Strongest drawdown reduction",
            detail: `"${bestDrawdownRow.rule}" reduces max drawdown by ${reduction.toFixed(1)}% vs baseline.`,
            quality: "positive",
        });
    }

    const trapBucket = context.buckets.find((bucket) => bucket.label.startsWith("family agree >=") && bucket.avgExpectancy < 0 && bucket.samples >= radarMinSamples);
    if (trapBucket) {
        findings.push({
            label: "Consensus trap",
            detail: `"${trapBucket.label}" still has negative expectancy ($${trapBucket.avgExpectancy.toFixed(2)}). High agreement is not always good.`,
            quality: "negative",
        });
    }

    const rareBucket = context.buckets.find((bucket) =>
        bucket.samples >= radarMinSamples
        && bucket.samples <= baseline.samples * 0.15
        && bucket.winRate > baseline.winRate + 15
        && bucket.avgExpectancy > 0
    );
    if (rareBucket) {
        findings.push({
            label: "Rare high-value bucket",
            detail: `"${rareBucket.label}" is low frequency (${rareBucket.samples} trades) but materially outperforms baseline.`,
            quality: "positive",
        });
    }

    const oppositionBucket = context.buckets.find((bucket) => {
        if (!bucket.label.startsWith("family oppose = ")) {
            return false;
        }
        const opposeValue = Number.parseInt(bucket.label.replace("family oppose = ", ""), 10);
        return opposeValue >= 2 && bucket.avgExpectancy > 0 && bucket.samples >= radarMinSamples;
    });
    if (oppositionBucket) {
        findings.push({
            label: "Opposition still profitable",
            detail: `"${oppositionBucket.label}" remains positive expectancy ($${oppositionBucket.avgExpectancy.toFixed(2)}). Opposition does not automatically invalidate the target.`,
            quality: "neutral",
        });
    }

    if (findings.length === 0) {
        findings.push({
            label: "No strong anomaly found",
            detail: "The current config set did not surface a strong consensus edge or trap from the available data.",
            quality: "neutral",
        });
    }

    return findings;
}

function formatSignedCurrency(value: number): string {
    if (!Number.isFinite(value)) {
        return "-";
    }
    return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
}
