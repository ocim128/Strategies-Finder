import { UNIVERSE_ALGORITHM, UNIVERSE_DEFAULTS, validateUniverseRequest, type UniverseRunRequestV1, type UniverseManifest } from '../../lib/monte-carlo/universe/model';
import { universeDigest } from '../../lib/monte-carlo/universe/store';
import type { OHLCVData } from '../../lib/types/strategies';
export function universeRequest(runId = 'universe-test'): UniverseRunRequestV1 {
    const { simulations, seed, initialCapital, ruinThresholdPercent, ...criteria } = UNIVERSE_DEFAULTS;
    return { schemaVersion: 1, runId, strategyKey: 'ema_confirmation', strategyParams: { emaPeriod: 3 },
        backtestSettings: { executionModel: 'signal_close', tradeDirection: 'combined', slippageBps: 2 },
        capitalSettings: { positionSize: 10, commission: 0.1, sizingMode: 'fixed', fixedTradeAmount: 1000 }, interval: '1d',
        sourceContext: { provider: 'ibkr-local', binanceMarketType: 'spot' }, blockRange: null,
        symbols: ['MCBASE\u2022', 'MCBASE\u2022+MCQUOTE\u2022', 'MCBASE\u2022+MCQUOTE\u2022@'],
        simulation: { simulations, seed, initialCapital, ruinThresholdPercent }, criteria: { ...criteria, minimumTradeRecords: 5 } };
}
export function universeManifest(request = universeRequest()): UniverseManifest {
    const { inventory, rawCount, duplicateCount } = validateUniverseRequest(request);
    return { schemaVersion: 1, algorithmVersion: UNIVERSE_ALGORITHM, request, inventory, rawCount, duplicateCount,
        requestDigest: universeDigest(request), state: 'accepted', asOfTimeSec: 1800000000, startedAt: Date.now(), finishedAt: null, error: null };
}
export function universeCandles(quote = false, count = 360): OHLCVData[] {
    return Array.from({ length: count }, (_, i) => {
        const close = 100 + (quote ? 2 * Math.sin(i / 6) : 12 * Math.sin(i / 3)) + i / 100;
        return { time: (1700006400 + i * 86400) as OHLCVData['time'], open: close - 0.1, high: close + 1, low: close - 1, close, volume: 1000 };
    });
}
