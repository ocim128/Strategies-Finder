
import { Time } from "lightweight-charts";
import { OHLCVData } from "../strategies/index";
import { state, type MockChartModel } from "../state";
import { getIntervalSeconds } from "./utils";

type MockChartConfig = {
    barsCount: number;
    volatility: number;
    startPrice: number;
    intervalSeconds: number;
};

const MIN_MOCK_BARS = 100;
const MAX_MOCK_BARS = 30000000;
const TOTAL_LIMIT = 30000; // Default limit if not specified
const MOCK_SYMBOLS = new Set(['MOCK_STOCK', 'MOCK_CRYPTO', 'MOCK_FOREX']);

export function isMockSymbol(symbol: string): boolean {
    return MOCK_SYMBOLS.has(symbol);
}

function getMockPrice(symbol: string): number {
    switch (symbol) {
        case 'AAPL': return 175;
        case 'GOOGL': return 140;
        case 'MSFT': return 380;
        case 'TSLA': return 220;
        case 'EURUSD': return 1.09;
        case 'GBPUSD': return 1.27;
        case 'USDJPY': return 148;
        case 'XAUUSD': return 2050;
        case 'XAGUSD': return 23.5;
        case 'WTIUSD': return 75;
        default: return 100;
    }
}

function randInt(rng: () => number, min: number, max: number): number {
    return Math.floor(rng() * (max - min + 1)) + min;
}

function randNormal(rng: () => number): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function makeRng(seed: number): () => number {
    let t = seed >>> 0;
    return () => {
        t += 0x6D2B79F5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

function createRandomSeed(): number {
    return Math.floor(Math.random() * 1000000000);
}

export function generateMockData(symbol: string, interval: string): OHLCVData[] {
    const rawBars = Number.isFinite(state.mockChartBars) ? Math.floor(state.mockChartBars) : TOTAL_LIMIT;
    const barsCount = Math.min(MAX_MOCK_BARS, Math.max(MIN_MOCK_BARS, rawBars));
    const config: MockChartConfig = {
        barsCount,
        volatility: 1.5,
        startPrice: getMockPrice(symbol),
        intervalSeconds: getIntervalSeconds(interval),
    };

    const model: MockChartModel = state.mockChartModel ?? 'simple';
    if (model === 'hard') {
        return generateChallengingMockData(config, createRandomSeed());
    }
    if (model === 'v3') {
        return generateAdversarialMockData(config, createRandomSeed());
    }
    if (model === 'v4') {
        return generateMarketRealismMockData(config, createRandomSeed());
    }
    if (model === 'v5') {
        return generateMarketRealismMockDataV5(config, createRandomSeed());
    }

    return generateSimpleMockData(config);
}

function generateSimpleMockData(config: MockChartConfig): OHLCVData[] {
    const data: OHLCVData[] = [];
    let price = config.startPrice;
    const now = Math.floor(Date.now() / 1000);

    // Start 'barsCount' periods ago
    let time = (now - (config.barsCount * config.intervalSeconds)) as Time;

    for (let i = 0; i < config.barsCount; i++) {
        const volatility = price * (config.volatility / 100);
        const change = (Math.random() - 0.5) * volatility;
        const open = price;
        const close = price + change;
        const high = Math.max(open, close) + Math.random() * volatility * 0.5;
        const low = Math.min(open, close) - Math.random() * volatility * 0.5;
        const volume = Math.floor(Math.random() * 1000000) + 100000;

        data.push({
            time,
            open,
            high,
            low,
            close,
            volume,
        });

        price = close;
        if (price < config.startPrice * 0.1) {
            price = config.startPrice * 0.1;
        }
        time = (Number(time) + config.intervalSeconds) as Time;
    }

    return data;
}

function generateChallengingMockData(config: MockChartConfig, seed: number): OHLCVData[] {
    type Regime = {
        length: number;
        drift: number;
        volMult: number;
        meanReversion: number;
        jumpProb: number;
        jumpSize: number;
        gapProb: number;
        gapStd: number;
        anchor: number;
    };

    const data: OHLCVData[] = [];
    const now = Math.floor(Date.now() / 1000);
    let time = (now - (config.barsCount * config.intervalSeconds)) as Time;

    const rng = makeRng(seed * 1000003 + 0x9e3779b9);
    const baseVol = Math.max(0.0001, config.volatility / 100);
    const floor = Math.max(0.01, config.startPrice * 0.05);
    const ceiling = Math.max(floor * 2, config.startPrice * 50);
    const logFloor = Math.log(floor);
    const logCeil = Math.log(ceiling);
    const clampLog = (value: number): number => {
        if (!Number.isFinite(value)) return logFloor;
        if (value < logFloor) return logFloor;
        if (value > logCeil) return logCeil;
        return value;
    };
    const clampReturn = (value: number): number => {
        // Reduce extreme single-bar moves vs earlier versions.
        const limit = 0.22;
        if (!Number.isFinite(value)) return 0;
        if (value < -limit) return -limit;
        if (value > limit) return limit;
        return value;
    };

    let logPrice = Math.log(Math.max(config.startPrice, floor));
    let vol = baseVol;
    let prevRet = 0;

    const pickRegime = (): Regime => {
        const roll = rng();
        const length = randInt(rng, 120, 1400);
        const anchor = clampLog(logPrice + (rng() - 0.5) * baseVol * 10);

        if (roll < 0.25) {
            const dir = rng() < 0.5 ? -1 : 1;
            return {
                length,
                drift: dir * baseVol * 0.12,
                volMult: 0.75,
                meanReversion: 0.02,
                jumpProb: 0.0015,
                jumpSize: baseVol * 2.2,
                gapProb: 0.002,
                gapStd: baseVol * 1.1,
                anchor
            };
        }

        if (roll < 0.55) {
            return {
                length,
                drift: 0,
                volMult: 0.65,
                meanReversion: 0.08,
                jumpProb: 0.0006,
                jumpSize: baseVol * 1.8,
                gapProb: 0.0015,
                gapStd: baseVol * 0.9,
                anchor
            };
        }

        if (roll < 0.8) {
            return {
                length,
                drift: 0,
                volMult: 1.2,
                meanReversion: 0.01,
                jumpProb: 0.0025,
                jumpSize: baseVol * 3,
                gapProb: 0.0035,
                gapStd: baseVol * 1.6,
                anchor
            };
        }

        return {
            length,
            drift: 0,
            volMult: 0.45,
            meanReversion: 0.03,
            jumpProb: 0.0003,
            jumpSize: baseVol * 1.5,
            gapProb: 0.0008,
            gapStd: baseVol * 0.8,
            anchor
        };
    };

    let regime = pickRegime();
    let regimeLeft = regime.length;

    const omega = baseVol * baseVol * 0.05;
    const alpha = 0.12;
    const beta = 0.85;

    for (let i = 0; i < config.barsCount; i++) {
        if (regimeLeft-- <= 0) {
            regime = pickRegime();
            regimeLeft = regime.length;
        }

        const minuteOfDay = ((Math.floor(Number(time) / 60) % 1440) + 1440) % 1440;
        const season =
            0.85 +
            0.3 * Math.sin((2 * Math.PI * minuteOfDay) / 1440) +
            0.15 * Math.sin((4 * Math.PI * minuteOfDay) / 1440);
        const seasonMult = Math.max(0.4, season);

        vol = Math.sqrt(omega + alpha * prevRet * prevRet + beta * vol * vol);

        const gap = rng() < regime.gapProb ? randNormal(rng) * regime.gapStd : 0;
        logPrice = clampLog(logPrice + gap);
        let open = Math.exp(logPrice);

        const eps = randNormal(rng);
        const meanRevert = regime.meanReversion * (regime.anchor - logPrice);
        let ret = regime.drift + meanRevert + (vol * regime.volMult * seasonMult) * eps;

        if (rng() < regime.jumpProb) {
            const jumpDir = rng() < 0.5 ? -1 : 1;
            ret += jumpDir * regime.jumpSize * (0.5 + rng());
        }

        ret = clampReturn(ret);
        logPrice = clampLog(logPrice + ret);
        let close = Math.exp(logPrice);

        if (close < floor) {
            close = floor;
            logPrice = Math.log(close);
        }
        if (open < floor) open = floor;

        const rangeBase = Math.max(baseVol * 0.25, Math.abs(ret) + vol * 0.5);
        const wick = Math.abs(randNormal(rng)) * rangeBase * open;
        let high = Math.max(open, close) + wick;
        let low = Math.min(open, close) - wick;

        const lowFloor = floor * 0.8;
        const highCeil = ceiling * 1.2;
        if (low < lowFloor) low = lowFloor;
        if (high > highCeil) high = highCeil;
        if (high < low) high = Math.max(open, close);

        const volFactor = Math.min(5, 0.5 + Math.abs(ret) / baseVol);
        const volume = Math.floor(100000 * (1 + volFactor) * (0.7 + rng() * 0.6));

        data.push({
            time,
            open,
            high,
            low,
            close,
            volume,
        });

        prevRet = ret;
        time = (Number(time) + config.intervalSeconds) as Time;
    }

    return data;
}

function generateAdversarialMockData(config: MockChartConfig, seed: number): OHLCVData[] {
    type Regime = {
        length: number;
        drift: number;
        meanReversion: number;
        volMult: number;
        antiPersist: number;
        trapProb: number;
        spikeProb: number;
        gapProb: number;
        gapStd: number;
    };

    const data: OHLCVData[] = [];
    const now = Math.floor(Date.now() / 1000);
    let time = (now - (config.barsCount * config.intervalSeconds)) as Time;

    const rng = makeRng(seed * 1000003 + 0x85ebca6b);
    const baseVol = Math.max(0.0001, config.volatility / 100);
    const floor = Math.max(0.01, config.startPrice * 0.05);
    const ceiling = Math.max(floor * 2, config.startPrice * 50);
    const logFloor = Math.log(floor);
    const logCeil = Math.log(ceiling);
    const clampLog = (value: number): number => {
        if (!Number.isFinite(value)) return logFloor;
        if (value < logFloor) return logFloor;
        if (value > logCeil) return logCeil;
        return value;
    };
    const clampReturn = (value: number): number => {
        const limit = Math.max(0.08, baseVol * 8);
        if (!Number.isFinite(value)) return 0;
        if (value < -limit) return -limit;
        if (value > limit) return limit;
        return value;
    };

    let logPrice = Math.log(Math.max(config.startPrice, floor));
    let anchor = logPrice;
    let vol = baseVol;
    let prevRet = 0;
    let revertBias = 0;

    const pickRegime = (): Regime => {
        const roll = rng();
        const length = randInt(rng, 30, 220);

        if (roll < 0.45) {
            return {
                length,
                drift: 0,
                meanReversion: 0.18,
                volMult: 1.4,
                antiPersist: 0.8,
                trapProb: 0.85,
                spikeProb: 0.06,
                gapProb: 0.02,
                gapStd: baseVol * 2.0
            };
        }

        if (roll < 0.75) {
            const dir = rng() < 0.5 ? -1 : 1;
            return {
                length,
                drift: dir * baseVol * 0.12,
                meanReversion: 0.03,
                volMult: 1.0,
                antiPersist: 0.25,
                trapProb: 0.4,
                spikeProb: 0.03,
                gapProb: 0.01,
                gapStd: baseVol * 1.2
            };
        }

        return {
            length,
            drift: 0,
            meanReversion: 0.1,
            volMult: 1.8,
            antiPersist: 0.6,
            trapProb: 0.95,
            spikeProb: 0.08,
            gapProb: 0.025,
            gapStd: baseVol * 2.5
        };
    };

    let regime = pickRegime();
    let regimeLeft = regime.length;

    const omega = baseVol * baseVol * 0.08;
    const alpha = 0.18;
    const beta = 0.8;

    for (let i = 0; i < config.barsCount; i++) {
        if (regimeLeft-- <= 0) {
            regime = pickRegime();
            regimeLeft = regime.length;
        }

        anchor = clampLog(anchor + (rng() - 0.5) * baseVol * 0.25);

        const minuteOfDay = ((Math.floor(Number(time) / 60) % 1440) + 1440) % 1440;
        const season =
            0.9 +
            0.25 * Math.sin((2 * Math.PI * minuteOfDay) / 1440) +
            0.1 * Math.sin((4 * Math.PI * minuteOfDay) / 1440);
        const seasonMult = Math.max(0.35, season);

        vol = Math.sqrt(omega + alpha * prevRet * prevRet + beta * vol * vol);

        const gap = rng() < regime.gapProb ? randNormal(rng) * regime.gapStd : 0;
        logPrice = clampLog(logPrice + gap);
        const open = Math.exp(logPrice);

        const dist = logPrice - anchor;
        const meanRevert = -regime.meanReversion * dist;
        let ret = regime.drift + meanRevert + (vol * regime.volMult * seasonMult) * randNormal(rng);

        if (revertBias !== 0) {
            ret += revertBias;
            revertBias *= 0.45;
            if (Math.abs(revertBias) < baseVol * 0.005) {
                revertBias = 0;
            }
        }

        if (rng() < regime.antiPersist) {
            ret -= 0.6 * prevRet;
        }

        const band = baseVol * (2.5 + rng() * 3.5);
        if (dist > band && rng() < regime.trapProb) {
            ret -= Math.abs(dist) * (0.4 + rng() * 0.5);
        } else if (dist < -band && rng() < regime.trapProb) {
            ret += Math.abs(dist) * (0.4 + rng() * 0.5);
        }

        if (rng() < regime.spikeProb) {
            const spikeDir = rng() < 0.5 ? -1 : 1;
            const spike = spikeDir * baseVol * (2 + rng() * 5);
            ret += spike;
            revertBias = -spikeDir * baseVol * (1.2 + rng() * 2);
        }

        ret = clampReturn(ret);
        logPrice = clampLog(logPrice + ret);
        let close = Math.exp(logPrice);

        if (close < floor) {
            close = floor;
            logPrice = Math.log(close);
        }

        const rangeBase = Math.max(baseVol * 0.3, Math.abs(ret) + vol * 0.6);
        const wickNoise = Math.abs(randNormal(rng)) * rangeBase * open;
        const wickBoost = rng() < 0.05 ? 1.5 + rng() * 3 : 0;
        const wick = wickNoise * (1 + wickBoost);

        let high = Math.max(open, close) + wick;
        let low = Math.min(open, close) - wick;

        const lowFloor = floor * 0.8;
        const highCeil = ceiling * 1.2;
        if (low < lowFloor) low = lowFloor;
        if (high > highCeil) high = highCeil;
        if (high < low) high = Math.max(open, close);

        const volFactor = Math.min(6, 0.6 + Math.abs(ret) / baseVol);
        const volume = Math.floor(120000 * (1 + volFactor) * (0.5 + rng() * 0.7));

        data.push({
            time,
            open,
            high,
            low,
            close,
            volume,
        });

        prevRet = ret;
        time = (Number(time) + config.intervalSeconds) as Time;
    }

    return data;
}

function generateMarketRealismMockData(config: MockChartConfig, seed: number): OHLCVData[] {
    type MarketPhase = {
        length: number;
        type: 'accumulation' | 'markup' | 'distribution' | 'markdown' | 'ranging';
        trendStrength: number;      // 0-1 trend intensity
        volatilityBase: number;     // Base volatility multiplier
        trapProbability: number;    // Likelihood of false breakouts
        huntProbability: number;    // Likelihood of stop hunting sweeps
        gapProbability: number;     // Overnight gap probability
        momentum: number;           // Short-term momentum strength (0-1)
    };

    const data: OHLCVData[] = [];
    const now = Math.floor(Date.now() / 1000);
    let time = (now - (config.barsCount * config.intervalSeconds)) as Time;

    const rng = makeRng(seed * 1000007 + 0xc0ffee42);
    const baseVol = Math.max(0.0001, config.volatility / 100);
    const floor = Math.max(0.01, config.startPrice * 0.05);
    const ceiling = Math.max(floor * 2, config.startPrice * 100);
    const logFloor = Math.log(floor);
    const logCeil = Math.log(ceiling);

    const clampLog = (value: number): number => {
        if (!Number.isFinite(value)) return logFloor;
        if (value < logFloor) return logFloor;
        if (value > logCeil) return logCeil;
        return value;
    };
    const clampReturn = (value: number): number => {
        const limit = Math.max(0.10, baseVol * 9);
        if (!Number.isFinite(value)) return 0;
        if (value < -limit) return -limit;
        if (value > limit) return limit;
        return value;
    };

    let logPrice = Math.log(Math.max(config.startPrice, floor));
    let vol = baseVol;

    // Multi-scale state tracking
    let higherTfBias = 0;              // -1 to 1, represents higher timeframe trend
    let higherTfBiasDecay = 0;
    let mediumTfAnchor = logPrice;
    let shortTermMomentum = 0;

    // Stop hunting tracking
    let recentHigh = logPrice;
    let recentLow = logPrice;
    let huntDirection = 0;             // +1 for upside hunt, -1 for downside hunt
    let huntPhase = 0;                 // 0=none, 1=hunting, 2=reverting

    // Accumulation/distribution tracking
    const priceHistory: number[] = [];
    const momentumHistory: number[] = [];
    const returnHistory: number[] = [];

    // GARCH volatility parameters
    const omega = baseVol * baseVol * 0.06;
    const alpha = 0.15;
    const beta = 0.82;

    const pickPhase = (): MarketPhase => {
        const roll = rng();
        const length = randInt(rng, 50, 400);

        // Accumulation phase - quiet, ranging with hidden buying
        if (roll < 0.20) {
            higherTfBias = 0.2 + rng() * 0.3;  // Slight bullish bias building
            higherTfBiasDecay = 0.0005;
            return {
                length,
                type: 'accumulation',
                trendStrength: 0.04,
                volatilityBase: 0.55,
                trapProbability: 0.08,
                huntProbability: 0.10,
                gapProbability: 0.005,
                momentum: 0.2
            };
        }

        // Markup phase - trending up with pullbacks
        if (roll < 0.40) {
            higherTfBias = 0.4 + rng() * 0.4;
            higherTfBiasDecay = 0.001;
            return {
                length,
                type: 'markup',
                trendStrength: 0.10 + rng() * 0.06,
                volatilityBase: 0.9,
                trapProbability: 0.06,
                huntProbability: 0.08,
                gapProbability: 0.01,
                momentum: 0.6
            };
        }

        // Distribution phase - topping, higher volatility, false breakouts
        if (roll < 0.55) {
            higherTfBias = -0.1 - rng() * 0.2;  // Bearish bias building
            higherTfBiasDecay = 0.0003;
            return {
                length,
                type: 'distribution',
                trendStrength: 0.03,
                volatilityBase: 1.1,
                trapProbability: 0.16,
                huntProbability: 0.14,
                gapProbability: 0.012,
                momentum: 0.35
            };
        }

        // Markdown phase - trending down with bounces
        if (roll < 0.75) {
            higherTfBias = -0.4 - rng() * 0.4;
            higherTfBiasDecay = 0.0012;
            return {
                length,
                type: 'markdown',
                trendStrength: 0.08 + rng() * 0.08,
                volatilityBase: 1.05,
                trapProbability: 0.07,
                huntProbability: 0.09,
                gapProbability: 0.012,
                momentum: 0.55
            };
        }

        // Ranging phase - choppy, mean reverting, high trap probability
        higherTfBias = (rng() - 0.5) * 0.2;
        higherTfBiasDecay = 0.0001;
        return {
            length,
            type: 'ranging',
            trendStrength: 0.02,
            volatilityBase: 0.8,
            trapProbability: 0.22,
            huntProbability: 0.16,
            gapProbability: 0.007,
            momentum: 0.15
        };
    };

    let phase = pickPhase();
    let phaseLeft = phase.length;
    mediumTfAnchor = logPrice;

    for (let i = 0; i < config.barsCount; i++) {
        if (phaseLeft-- <= 0) {
            phase = pickPhase();
            phaseLeft = phase.length;
            mediumTfAnchor = logPrice;
            recentHigh = logPrice;
            recentLow = logPrice;
        }

        // Update recent highs/lows for stop hunting
        if (priceHistory.length >= 20) {
            const recent = priceHistory.slice(-20);
            recentHigh = Math.max(...recent);
            recentLow = Math.min(...recent);
        }

        // Intraday volatility seasonality
        const minuteOfDay = ((Math.floor(Number(time) / 60) % 1440) + 1440) % 1440;
        const hourFactor = Math.sin((2 * Math.PI * minuteOfDay) / 1440);
        const seasonMult = 0.7 + 0.4 * Math.abs(hourFactor) + 0.2 * (hourFactor > 0.5 ? 1 : 0);

        // GARCH volatility
        const lastRet = returnHistory.length > 0 ? returnHistory[returnHistory.length - 1] : 0;
        vol = Math.sqrt(omega + alpha * lastRet * lastRet + beta * vol * vol);

        // Gap generation
        let gap = 0;
        if (rng() < phase.gapProbability) {
            gap = randNormal(rng) * baseVol * (1.2 + rng() * 2.5);
        }
        logPrice = clampLog(logPrice + gap);
        let open = Math.exp(logPrice);

        // Base return components
        let ret = 0;

        // 1. Higher timeframe bias (slow trend)
        const htfContrib = higherTfBias * baseVol * 0.03;
        higherTfBias = higherTfBias * (1 - higherTfBiasDecay);
        ret += htfContrib;

        // 2. Medium timeframe mean reversion (anchor drift)
        const mtfDist = logPrice - mediumTfAnchor;
        const mtfRevert = -mtfDist * 0.03 * (phase.type === 'ranging' ? 2 : 1);
        ret += mtfRevert;

        // 3. Short-term momentum (autocorrelation)
        if (momentumHistory.length > 0) {
            const recentMom = momentumHistory.slice(-5);
            const avgMom = recentMom.reduce((a, b) => a + b, 0) / recentMom.length;
            shortTermMomentum = avgMom * phase.momentum;
        }
        ret += shortTermMomentum * 0.4;

        // 4. Phase-specific trend
        if (phase.type === 'markup') {
            ret += phase.trendStrength * baseVol;
        } else if (phase.type === 'markdown') {
            ret -= phase.trendStrength * baseVol;
        }

        // 5. Stop hunting behavior
        if (huntPhase === 0 && rng() < phase.huntProbability) {
            const upDist = recentHigh - logPrice;
            const downDist = logPrice - recentLow;
            huntDirection = upDist > downDist ? 1 : -1;
            huntPhase = 1;
        }

        if (huntPhase === 1) {
            // Hunting - push toward stop levels
            ret += huntDirection * baseVol * (1.0 + rng() * 1.5);
            if (rng() < 0.3) {
                huntPhase = 2;  // Start reverting
            }
        } else if (huntPhase === 2) {
            // Reverting after hunt
            ret -= huntDirection * baseVol * (1.4 + rng() * 1.8);
            if (rng() < 0.5) {
                huntPhase = 0;  // Back to normal
            }
        }

        // 6. False breakout traps
        if (rng() < phase.trapProbability) {
            const trapDir = rng() < 0.5 ? 1 : -1;
            const trapSize = baseVol * (0.7 + rng() * 1.4);
            ret += trapDir * trapSize;
            // Queue a reversal for next bars
            shortTermMomentum = -trapDir * trapSize * 0.5;
        }

        // 7. Random noise
        const noise = randNormal(rng) * vol * phase.volatilityBase * seasonMult;
        ret += noise;

        // Apply and clamp return
        ret = clampReturn(ret);
        logPrice = clampLog(logPrice + ret);
        let close = Math.exp(logPrice);

        if (close < floor) {
            close = floor;
            logPrice = Math.log(close);
        }
        if (open < floor) open = floor;

        // Wicks - more pronounced during volatile phases
        const wickBase = Math.max(baseVol * 0.15, Math.abs(ret) + vol * 0.3);
        const wickMultiplier = phase.type === 'distribution' ? 1.3 :
            phase.type === 'ranging' ? 1.1 : 1.0;
        const wick = Math.abs(randNormal(rng)) * wickBase * open * wickMultiplier;

        let high = Math.max(open, close) + wick;
        let low = Math.min(open, close) - wick;

        // Extra wick extension during hunts
        if (huntPhase === 1) {
            if (huntDirection > 0) {
                high += wick * 0.4;
            } else {
                low -= wick * 0.4;
            }
        }

        const lowFloor = floor * 0.8;
        const highCeil = ceiling * 1.2;
        if (low < lowFloor) low = lowFloor;
        if (high > highCeil) high = highCeil;
        if (high < low) high = Math.max(open, close);

        // Volume - correlates with price movement and volatility
        const absRet = Math.abs(ret);
        const volFactor = Math.min(8, 0.4 + (absRet / baseVol) * 1.5 + (vol / baseVol) * 0.5);
        const huntVolBoost = huntPhase > 0 ? 1.8 : 1.0;
        const volume = Math.floor(100000 * (1 + volFactor) * huntVolBoost * (0.6 + rng() * 0.6));

        data.push({
            time,
            open,
            high,
            low,
            close,
            volume,
        });

        // Update history
        priceHistory.push(logPrice);
        momentumHistory.push(ret);
        returnHistory.push(ret);

        // Keep history bounded
        if (priceHistory.length > 100) priceHistory.shift();
        if (momentumHistory.length > 20) momentumHistory.shift();
        if (returnHistory.length > 50) returnHistory.shift();

        // Slowly drift medium anchor
        mediumTfAnchor = mediumTfAnchor * 0.995 + logPrice * 0.005;

        time = (Number(time) + config.intervalSeconds) as Time;
    }

    return data;
}

function generateMarketRealismMockDataV5(config: MockChartConfig, seed: number): OHLCVData[] {
    type Regime = {
        length: number;
        drift: number;
        volTarget: number;
        meanReversion: number;
        ar: number;
        jumpProb: number;
        jumpScale: number;
        gapProb: number;
        sweepProb: number;
        volumeBias: number;
    };

    const data: OHLCVData[] = [];
    const now = Math.floor(Date.now() / 1000);
    let time = (now - (config.barsCount * config.intervalSeconds)) as Time;

    const rng = makeRng(seed * 1000013 + 0xa7f3c2b1);
    const baseVol = Math.max(0.00005, config.volatility / 100);
    const intervalMinutes = Math.max(1, config.intervalSeconds / 60);
    const volScale = Math.min(3, Math.pow(intervalMinutes, 0.45));
    const floor = Math.max(0.01, config.startPrice * 0.05);
    const ceiling = Math.max(floor * 2, config.startPrice * 80);
    const logFloor = Math.log(floor);
    const logCeil = Math.log(ceiling);
    const baseVolume = 110000;

    const clampLog = (value: number): number => {
        if (!Number.isFinite(value)) return logFloor;
        if (value < logFloor) return logFloor;
        if (value > logCeil) return logCeil;
        return value;
    };
    const clampReturn = (value: number): number => {
        const limit = Math.min(0.35, Math.max(0.08, baseVol * 10 * volScale));
        if (!Number.isFinite(value)) return 0;
        if (value < -limit) return -limit;
        if (value > limit) return limit;
        return value;
    };

    let logPrice = Math.log(Math.max(config.startPrice, floor));
    let vol = baseVol;
    let prevRet = 0;
    let anchor = logPrice;
    let macroTrend = (rng() - 0.5) * 0.4;
    let shortMom = 0;

    const omega = baseVol * baseVol * 0.08;
    const alpha = 0.08;
    const beta = 0.78;

    const regimeBars = (minMinutes: number, maxMinutes: number): number => {
        const minBars = Math.max(20, Math.round(minMinutes / intervalMinutes));
        const maxBars = Math.max(minBars + 5, Math.round(maxMinutes / intervalMinutes));
        return randInt(rng, minBars, maxBars);
    };

    const pickRegime = (): Regime => {
        const roll = rng();
        if (roll < 0.30) {
            return {
                length: regimeBars(180, 2200),
                drift: 0,
                volTarget: 0.6,
                meanReversion: 0.08,
                ar: -0.15,
                jumpProb: 0.001,
                jumpScale: 1.2,
                gapProb: 0.003,
                sweepProb: 0.015,
                volumeBias: 0.85,
            };
        }
        if (roll < 0.60) {
            const dir = rng() < 0.5 ? -1 : 1;
            return {
                length: regimeBars(240, 3000),
                drift: dir * baseVol * (0.04 + rng() * 0.03),
                volTarget: 0.85,
                meanReversion: 0.02,
                ar: 0.18,
                jumpProb: 0.0015,
                jumpScale: 1.4,
                gapProb: 0.004,
                sweepProb: 0.025,
                volumeBias: 1.05,
            };
        }
        if (roll < 0.85) {
            return {
                length: regimeBars(120, 1400),
                drift: 0,
                volTarget: 1.05,
                meanReversion: 0.03,
                ar: 0.05,
                jumpProb: 0.003,
                jumpScale: 1.8,
                gapProb: 0.006,
                sweepProb: 0.035,
                volumeBias: 1.15,
            };
        }
        return {
            length: regimeBars(60, 900),
            drift: 0,
            volTarget: 1.35,
            meanReversion: 0.04,
            ar: -0.05,
            jumpProb: 0.004,
            jumpScale: 2.2,
            gapProb: 0.008,
            sweepProb: 0.05,
            volumeBias: 1.35,
        };
    };

    let regime = pickRegime();
    let regimeLeft = regime.length;

    for (let i = 0; i < config.barsCount; i++) {
        if (regimeLeft-- <= 0) {
            regime = pickRegime();
            regimeLeft = regime.length;
            anchor = logPrice;
        }

        const minuteOfDay = ((Math.floor(Number(time) / 60) % 1440) + 1440) % 1440;
        const intraday = 0.75 + 0.35 * Math.sin((2 * Math.PI * minuteOfDay) / 1440);
        const seasonMult = config.intervalSeconds <= 3600 ? Math.max(0.5, intraday) : 1.0;

        vol = Math.sqrt(omega + alpha * prevRet * prevRet + beta * vol * vol);
        const targetVol = baseVol * regime.volTarget;
        vol = vol * 0.85 + targetVol * 0.15;

        macroTrend = macroTrend * 0.998 + randNormal(rng) * 0.0016;
        if (macroTrend > 1) macroTrend = 1;
        if (macroTrend < -1) macroTrend = -1;

        const gap = rng() < regime.gapProb ? randNormal(rng) * baseVol * 0.6 * volScale : 0;
        logPrice = clampLog(logPrice + gap);
        const open = Math.exp(logPrice);

        shortMom = shortMom * 0.7 + prevRet * 0.3;
        const meanRevert = -regime.meanReversion * (logPrice - anchor);
        const macroDrift = macroTrend * baseVol * 0.03;
        const noise = randNormal(rng) * vol * regime.volTarget * seasonMult * volScale;

        let ret = regime.drift + meanRevert + regime.ar * shortMom + macroDrift + noise;
        if (rng() < regime.jumpProb) {
            ret += randNormal(rng) * baseVol * regime.jumpScale * volScale;
        }

        ret = clampReturn(ret);
        logPrice = clampLog(logPrice + ret);
        let close = Math.exp(logPrice);

        if (close < floor) {
            close = floor;
            logPrice = Math.log(close);
        }

        const rangeBase = Math.max(baseVol * 0.15, Math.abs(ret) + vol * 0.35);
        const wick = Math.abs(randNormal(rng)) * rangeBase * open * 0.7;
        let high = Math.max(open, close) + wick;
        let low = Math.min(open, close) - wick;

        if (rng() < regime.sweepProb) {
            const sweep = Math.abs(randNormal(rng)) * rangeBase * open * (0.8 + rng());
            if (rng() < 0.5) {
                high += sweep;
            } else {
                low -= sweep;
            }
        }

        const lowFloor = floor * 0.8;
        const highCeil = ceiling * 1.2;
        if (low < lowFloor) low = lowFloor;
        if (high > highCeil) high = highCeil;
        if (high < low) high = Math.max(open, close);

        const absRet = Math.abs(ret);
        const volFactor = Math.min(8, 0.5 + (absRet / baseVol) * 1.1 + (vol / baseVol) * 0.5);
        const jumpBoost = absRet > baseVol * 3 ? 1.3 : 1.0;
        const volume = Math.floor(baseVolume * regime.volumeBias * (1 + volFactor) * jumpBoost * (0.6 + rng() * 0.6));

        data.push({
            time,
            open,
            high,
            low,
            close,
            volume,
        });

        prevRet = ret;
        anchor = anchor * 0.995 + logPrice * 0.005;
        time = (Number(time) + config.intervalSeconds) as Time;
    }

    return data;
}
