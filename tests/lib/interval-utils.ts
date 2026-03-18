export function parseIntervalSeconds(interval: string): number | null {
    const trimmed = interval.trim();
    if (!trimmed) return null;

    const match = /^(\d+)(m|h|d|w|M)$/.exec(trimmed);
    if (!match) return null;

    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) return null;

    const unit = match[2];
    if (unit === 'm') return value * 60;
    if (unit === 'h') return value * 3600;
    if (unit === 'd') return value * 86400;
    if (unit === 'w') return value * 604800;
    if (unit === 'M') return value * 2592000;
    return null;
}

export function getIntervalSecondsOrDefault(interval: string, fallbackSeconds = 86400): number {
    const parsed = parseIntervalSeconds(interval);
    if (parsed === null) return fallbackSeconds;
    return parsed;
}

export function isTwoHourInterval(interval: string): boolean {
    return parseIntervalSeconds(interval) === 7200;
}
