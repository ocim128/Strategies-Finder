import type { EntryPreview, EntryPreviewRow, TradeDirection } from "./types/strategies";

function formatTradeDirection(tradeDirection: TradeDirection): string {
    if (tradeDirection === "long") return "Long only";
    if (tradeDirection === "short") return "Short only";
    if (tradeDirection === "both") return "Both (Flip)";
    if (tradeDirection === "both_flip_loss_2") return "Both (Flip After 2 Losses)";
    return "Combined (L+S)";
}

function allowsLong(tradeDirection: TradeDirection): boolean {
    return tradeDirection === "long" || tradeDirection === "both" || tradeDirection === "both_flip_loss_2" || tradeDirection === "combined";
}

function allowsShort(tradeDirection: TradeDirection): boolean {
    return tradeDirection === "short" || tradeDirection === "both" || tradeDirection === "both_flip_loss_2" || tradeDirection === "combined";
}

function replaceDecisionRows(
    rows: EntryPreviewRow[],
    decisionRows: EntryPreviewRow[]
): EntryPreviewRow[] {
    const filtered = rows.filter((row) => row.section !== "Decision");
    return [...decisionRows, ...filtered];
}

export function buildExecutionAwarePreview(
    preview: EntryPreview,
    tradeDirection: TradeDirection
): EntryPreview {
    const longReady = preview.meta?.longReady ?? false;
    const shortReady = preview.meta?.shortReady ?? false;
    const bothRawReady = longReady && shortReady;
    const nearestSide = preview.meta?.nearestSide ?? "none";
    const directionLabel = formatTradeDirection(tradeDirection);
    const longAllowed = allowsLong(tradeDirection);
    const shortAllowed = allowsShort(tradeDirection);
    const rawDirection = preview.direction === "none" ? "No" : preview.direction;
    const rawLong = preview.direction === "long";
    const rawShort = preview.direction === "short";

    let executableValue = "No";
    let headline = "No executable breakout yet";
    let detail = "No direction in the current execution scope is ready yet.";
    let tone: NonNullable<EntryPreview["summary"]>["tone"] = "waiting";

    if (longAllowed && rawLong) {
        executableValue = "Long now";
        headline = "Executable long now";
        detail = bothRawReady
            ? "Both raw gates are true, but the strategy resolves this bar to long based on its current signal ordering."
            : "Long entries are allowed by the current direction mode and the long trigger is ready.";
        tone = "positive";
    } else if (shortAllowed && rawShort) {
        executableValue = "Short now";
        headline = "Executable short now";
        detail = bothRawReady
            ? "Both raw gates are true, but the strategy resolves this bar to short based on its current signal ordering."
            : "Short entries are allowed by the current direction mode and the short trigger is ready.";
        tone = "negative";
    } else if (tradeDirection === "long" && shortReady) {
        headline = "Short raw trigger is ignored";
        detail = "The short side is ready, but Direction Mode is long only, so it is not executable.";
        tone = "neutral";
    } else if (tradeDirection === "short" && longReady) {
        headline = "Long raw trigger is ignored";
        detail = "The long side is ready, but Direction Mode is short only, so it is not executable.";
        tone = "neutral";
    } else if (nearestSide !== "none") {
        detail = `${nearestSide} is the closest side inside the current raw signal model.`;
    }

    const decisionRows: EntryPreviewRow[] = [
        { section: "Decision", label: "Direction mode", value: directionLabel },
        { section: "Decision", label: "Executable now", value: executableValue },
        { section: "Decision", label: "Raw trigger", value: rawDirection },
    ];
    if (bothRawReady) {
        decisionRows.push({ section: "Decision", label: "Conflict handling", value: `Resolved to ${rawDirection}` });
    }

    const nearestRow = preview.rows?.find((row) => row.section === "Decision" && row.label.toLowerCase() === "nearest side");
    if (nearestRow) {
        decisionRows.push(nearestRow);
    }

    return {
        ...preview,
        summary: {
            eyebrow: preview.summary?.eyebrow ?? "Execution Scope",
            headline,
            detail,
            tone,
        },
        rows: replaceDecisionRows(preview.rows ?? [], decisionRows),
    };
}
