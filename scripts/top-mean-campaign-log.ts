/** Shared, lossless parsers for the append-only TOP_MEAN campaign log. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export const CAMPAIGN_LOG_HASH_CONVENTION = "crlf-stripped" as const;

export interface CampaignPipeRecord {
    marker: string;
    positional: string[];
    fields: Record<string, string>;
}

export function parsePipeRecord(line: string): CampaignPipeRecord | null {
    const markerEnd = line.indexOf("|");
    if (markerEnd <= 0) return null;
    const marker = line.slice(0, markerEnd);
    const fieldStarts = [...line.matchAll(/\|([A-Za-z][A-Za-z0-9]*)=/g)];
    const firstField = fieldStarts[0];
    const positionalText = firstField
        ? line.slice(markerEnd + 1, firstField.index)
        : line.slice(markerEnd + 1);
    const positional = positionalText.split("|").filter((part) => part.length > 0);
    const fields: Record<string, string> = {};
    for (let index = 0; index < fieldStarts.length; index += 1) {
        const current = fieldStarts[index]!;
        const valueStart = current.index + current[0].length;
        const valueEnd = fieldStarts[index + 1]?.index ?? line.length;
        fields[current[1]!] = line.slice(valueStart, valueEnd);
    }
    return { marker, positional, fields };
}

export function parseRecords(text: string, marker: string): CampaignPipeRecord[] {
    const records: CampaignPipeRecord[] = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith(marker + "|")) continue;
        const record = parsePipeRecord(line);
        if (record) records.push(record);
    }
    return records;
}

export function parseBatchRecords(text: string, marker: string, batchLabel: string): CampaignPipeRecord[] {
    return parseRecords(text, marker).filter((record) => record.positional[0] === batchLabel);
}

export function sha256Bytes(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

/** Campaign log hashes use canonical UTF-8 text with CRLF pairs removed. */
export function canonicalizeCampaignLogText(text: string): string {
    return text.replace(/\r\n/g, "\n");
}

export function campaignLogSha256(text: string): string {
    return sha256Bytes(canonicalizeCampaignLogText(text));
}

export function readCampaignLog(logPath: string): { text: string; bytes: Uint8Array; lines: readonly string[] } {
    const bytes = existsSync(logPath) ? readFileSync(logPath) : Buffer.alloc(0);
    const text = bytes.toString("utf8");
    return { text, bytes, lines: text.split(/\r?\n/) };
}

export function firstI2LineByOutcomeBatch(logText: string): ReadonlyMap<string, number> {
    const result = new Map<string, number>();
    for (const [lineIndex, line] of logText.split(/\r?\n/).entries()) {
        if (!line.startsWith("I2|")) continue;
        const record = parsePipeRecord(line);
        const batch = record?.positional[1];
        if (batch !== undefined && !result.has(batch)) result.set(batch, lineIndex);
    }
    return result;
}
