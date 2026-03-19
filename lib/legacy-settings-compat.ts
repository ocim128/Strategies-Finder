type LegacyTradeFilterSource = {
    tradeFilterMode?: unknown;
    entryConfirmation?: unknown;
    tradeFilterSettingsToggle?: unknown;
    entrySettingsToggle?: unknown;
};

export function getLegacyCompatibleTradeFilterModeValue(source: LegacyTradeFilterSource): unknown {
    return source.tradeFilterMode ?? source.entryConfirmation;
}

export function getLegacyCompatibleTradeFilterToggleValue(source: LegacyTradeFilterSource): unknown {
    return source.tradeFilterSettingsToggle ?? source.entrySettingsToggle;
}
