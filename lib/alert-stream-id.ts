export const STREAM_CONFIG_MARKER = ':cfg:';

function buildBaseStreamId(symbol: string, interval: string, strategyKey: string): string {
    return `${symbol}:${interval}:${strategyKey}`.toLowerCase();
}

export function buildStreamId(
    symbol: string,
    interval: string,
    strategyKey: string,
    configName?: string
): string {
    const base = buildBaseStreamId(symbol, interval, strategyKey);
    const normalizedConfigName = (configName ?? '').trim();
    if (!normalizedConfigName) return base;
    return `${base}${STREAM_CONFIG_MARKER}${encodeURIComponent(normalizedConfigName)}`;
}

export function parseConfigNameFromStreamId(streamId: string): string | null {
    const markerIndex = streamId.lastIndexOf(STREAM_CONFIG_MARKER);
    if (markerIndex < 0) return null;
    const encoded = streamId.slice(markerIndex + STREAM_CONFIG_MARKER.length);
    if (!encoded) return null;
    try {
        const decoded = decodeURIComponent(encoded).trim();
        return decoded || null;
    } catch {
        return encoded.trim() || null;
    }
}
