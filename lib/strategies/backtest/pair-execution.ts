import type { OHLCVData, SyntheticPairSample, Trade } from '../../types/strategies';
import type { PositionState } from '../../types/backtest';

type Prices = readonly [base: number, quote: number];
type Phase = 'open' | 'close';

// Pair datasets are immutable research windows. Reuse validation across Finder
// candidates, invalidating when a stream append/replacement changes the edges.
const validatedWindows = new WeakMap<readonly OHLCVData[], {
    length: number; first?: OHLCVData; last?: OHLCVData; paired: boolean;
    firstLegs?: OHLCVData['pairLegs']; lastLegs?: OHLCVData['pairLegs'];
}>();

export function validatePairExecutionData(data: readonly OHLCVData[]): boolean {
    const first = data[0], last = data[data.length - 1];
    const cached = validatedWindows.get(data);
    if (cached && cached.length === data.length && cached.first === first && cached.last === last
        && cached.firstLegs === first?.pairLegs && cached.lastLegs === last?.pairLegs) return cached.paired;
    const paired = data.some(bar => bar.pairLegs !== undefined);
    if (paired) for (const bar of data) {
        if (!bar.pairLegs?.length || bar.pairLegs.some(sample =>
            sample.length !== 8 || !sample.every(value => Number.isFinite(value) && value > 0))) {
            throw new Error('50/50 execution requires aligned positive leg prices on every candle.');
        }
    }
    validatedWindows.set(data, { length: data.length, first, last, paired, firstLegs: first?.pairLegs, lastLegs: last?.pairLegs });
    return paired;
}

export function pairMarketPrices(candle: OHLCVData, phase: Phase): Prices {
    const samples = candle.pairLegs;
    if (!samples?.length) throw new Error('Missing 50/50 execution leg prices.');
    const sample = phase === 'open' ? samples[0] : samples[samples.length - 1];
    return phase === 'open' ? [sample[0], sample[4]] : [sample[3], sample[7]];
}

/** An entry-relative price scale lets the shared risk rules use portfolio returns. */
function portfolioPrice(position: PositionState, base: number, quote: number): number {
    const pair = position.pair!;
    return position.entryPrice * (1 + 0.5 * (
        base / pair.baseEntryPrice - quote / pair.quoteEntryPrice
    ));
}

function samplePrices(sample: SyntheticPairSample, index: number): Prices {
    return [sample[index], sample[index + 4]];
}

export function positionClosePrice(position: PositionState, candle: OHLCVData): number {
    if (!position.pair) return candle.close;
    const samples = candle.pairLegs;
    if (!samples?.length) throw new Error('Missing 50/50 execution leg prices.');
    const sample = samples[samples.length - 1];
    return portfolioPrice(position, sample[3], sample[7]);
}

/** Matched leg extrema retain the existing research candle assumptions. */
export function positionExecutionCandle(position: PositionState, candle: OHLCVData): OHLCVData {
    const pair = position.pair;
    if (!pair) return candle;
    if (pair.executionSource === candle && pair.executionCandle) return pair.executionCandle;
    const samples = candle.pairLegs;
    if (!samples?.length) throw new Error('Missing 50/50 execution leg prices.');
    const open = portfolioPrice(position, samples[0][0], samples[0][4]);
    const close = positionClosePrice(position, candle);
    let high = Math.max(open, close), low = Math.min(open, close);
    for (const sample of samples) {
        for (let i = 0; i < 4; i++) {
            const price = portfolioPrice(position, sample[i], sample[i + 4]);
            high = Math.max(high, price);
            low = Math.min(low, price);
        }
    }
    const executionCandle: OHLCVData = { time: candle.time, open, high, low, close, volume: candle.volume };
    pair.executionSource = candle;
    pair.executionCandle = executionCandle;
    return executionCandle;
}

function fillPairExit(position: PositionState, prices: Prices, slippageRate: number): number {
    const direction = position.direction === 'long' ? 1 : -1;
    const filled: Prices = [prices[0] * (1 - direction * slippageRate), prices[1] * (1 + direction * slippageRate)];
    const pair = position.pair!;
    // Closing fees are charged on BOTH actual leg notionals, even when the
    // long/short PNL cancels out. Partial exits use the same remaining fraction.
    pair.exitNotionalFactor = 0.5 * (filled[0] / pair.baseEntryPrice + filled[1] / pair.quoteEntryPrice);
    pair.baseExitPrice = filled[0];
    pair.quoteExitPrice = filled[1];
    return portfolioPrice(position, filled[0], filled[1]);
}

export function pairTradeLegs(position: PositionState, entryValue: number, commissionRate: number): Trade['legs'] {
    const pair = position.pair;
    if (!pair) return undefined;
    if (pair.baseExitPrice === undefined || pair.quoteExitPrice === undefined) throw new Error('Missing 50/50 exit fills.');
    const baseSize = entryValue * 0.5 / pair.baseEntryPrice;
    const quoteSize = entryValue * 0.5 / pair.quoteEntryPrice;
    return {
        base: { side: position.direction, size: baseSize, entryPrice: pair.baseEntryPrice, exitPrice: pair.baseExitPrice,
            fees: baseSize * (pair.baseEntryPrice + pair.baseExitPrice) * commissionRate },
        quote: { side: position.direction === 'long' ? 'short' : 'long', size: quoteSize, entryPrice: pair.quoteEntryPrice, exitPrice: pair.quoteExitPrice,
            fees: quoteSize * (pair.quoteEntryPrice + pair.quoteExitPrice) * commissionRate },
    };
}

export function pairMarketExitPrice(position: PositionState, candle: OHLCVData, phase: Phase, slippageRate: number): number {
    return fillPairExit(position, pairMarketPrices(candle, phase), slippageRate);
}

/**
 * Interpolate both legs together to a portfolio stop/target within the sampled
 * range. This is an OHLC fill model, not a reconstruction of synchronized ticks.
 * Include entry prices to preserve capped TP fills across favorable gaps.
 */
export function pairTargetExitPrice(position: PositionState, candle: OHLCVData, target: number, slippageRate: number, openOnly = false): number {
    const pair = position.pair!;
    const entry: Prices = [pair.baseEntryPrice, pair.quoteEntryPrice];
    let below: { price: number; legs: Prices } | undefined;
    let above: { price: number; legs: Prices } | undefined;
    const visit = (legs: Prices) => {
        const price = portfolioPrice(position, legs[0], legs[1]);
        const tolerance = Math.max(Math.abs(price), Math.abs(target)) * 1e-10;
        if (Math.abs(price - target) <= tolerance) {
            below = above = { price: target, legs };
            return;
        }
        if (price <= target && (!below || price > below.price)) below = { price, legs };
        if (price >= target && (!above || price < above.price)) above = { price, legs };
    };
    const fill = () => {
        if (!below || !above) throw new Error('50/50 exit target lies outside the sampled leg range.');
        const fraction = above.price === below.price ? 0 : (target - below.price) / (above.price - below.price);
        return fillPairExit(position, [
            below.legs[0] + fraction * (above.legs[0] - below.legs[0]),
            below.legs[1] + fraction * (above.legs[1] - below.legs[1]),
        ], slippageRate);
    };
    visit(entry);
    let previous = pairMarketPrices(candle, 'open');
    visit(previous);
    if (openOnly || (below && above)) return fill();
    // Use the first source sample that brackets the target. Later sub-bars
    // must not influence the exit's leg fills or commissions.
    for (const sample of candle.pairLegs!) {
        below = above = undefined;
        visit(previous);
        for (let i = 0; i < 4; i++) visit(samplePrices(sample, i));
        if (below && above) return fill();
        previous = samplePrices(sample, 3);
    }
    return fill();
}
