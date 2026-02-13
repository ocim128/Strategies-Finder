export const STREAM_CONFIG_MARKER = ':cfg:';
export const STREAM_PARITY_MARKER = ':2hcp:';

export type AlertStreamParity = 'odd' | 'even';

function buildBaseStreamId(symbol: string, interval: string, strategyKey: string): string {
    return `${symbol}:${interval}:${strategyKey}`.toLowerCase();
}

export function buildStreamId(
    symbol: string,
    interval: string,
    strategyKey: string,
    configName?: string,
    twoHourCloseParity?: AlertStreamParity
): string {
    let base = buildBaseStreamId(symbol, interval, strategyKey);
    if (twoHourCloseParity === 'odd' || twoHourCloseParity === 'even') {
        base = `${base}${STREAM_PARITY_MARKER}${twoHourCloseParity}`;
    }
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

export function parseTwoHourParityFromStreamId(streamId: string): AlertStreamParity | null {
    const markerIndex = streamId.indexOf(STREAM_PARITY_MARKER);
    if (markerIndex < 0) return null;
    const valueStart = markerIndex + STREAM_PARITY_MARKER.length;
    const configIndex = streamId.indexOf(STREAM_CONFIG_MARKER, valueStart);
    const raw = (configIndex >= 0 ? streamId.slice(valueStart, configIndex) : streamId.slice(valueStart))
        .trim()
        .toLowerCase();
    return raw === 'even' ? 'even' : raw === 'odd' ? 'odd' : null;
}

export function stripTwoHourParityFromStreamId(streamId: string): string {
    const markerIndex = streamId.indexOf(STREAM_PARITY_MARKER);
    if (markerIndex < 0) return streamId;
    const valueStart = markerIndex + STREAM_PARITY_MARKER.length;
    const configIndex = streamId.indexOf(STREAM_CONFIG_MARKER, valueStart);
    if (configIndex >= 0) {
        return `${streamId.slice(0, markerIndex)}${streamId.slice(configIndex)}`;
    }
    return streamId.slice(0, markerIndex);
}

export function replaceTwoHourParityInStreamId(
    streamId: string,
    parity: AlertStreamParity
): string {
    const markerIndex = streamId.indexOf(STREAM_PARITY_MARKER);
    if (markerIndex < 0) return streamId;

    const valueStart = markerIndex + STREAM_PARITY_MARKER.length;
    const configIndex = streamId.indexOf(STREAM_CONFIG_MARKER, valueStart);
    const suffix = configIndex >= 0 ? streamId.slice(configIndex) : '';
    return `${streamId.slice(0, markerIndex)}${STREAM_PARITY_MARKER}${parity}${suffix}`;
}
